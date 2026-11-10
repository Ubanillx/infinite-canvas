import { nanoid } from "nanoid";

import { assertAgentWorkspace, requireAgentWorkspace } from "@/lib/agent/agent-tool-context";
import { cloneCanvasTemplateContent } from "@/lib/canvas/canvas-template";
import { readAgentMedia } from "@/services/api/agent-media";
import { uploadImage } from "@/services/image-storage";
import { uploadMediaFile } from "@/services/file-storage";
import { useCanvasTemplateStore } from "@/stores/canvas/use-canvas-template-store";
import type { CanvasTemplate, CanvasTemplateContent } from "@/types/canvas-template";

export const MEDIA_TOOL_NAMES = ["media_get", "media_import", "templates_export", "templates_import"] as const;
export type MediaToolName = (typeof MEDIA_TOOL_NAMES)[number];
export function isMediaTool(name: string): name is MediaToolName {
    return (MEDIA_TOOL_NAMES as readonly string[]).includes(name);
}

type Input = Record<string, unknown>;
type Kind = "image" | "video" | "audio" | "file";
type PackageMedia = { ref: string; kind: Kind; mimeType: string; bytes: number; dataUrl: string };
type TemplatePackage = {
    format: "infinite-canvas-template";
    version: 1;
    template: { title: string; description: string; cover: string; content: CanvasTemplateContent };
    media: PackageMedia[];
};

const storageKeyPattern = /^(image|video|audio|file|video-reference|audio-reference):[A-Za-z0-9_-]+$/;
const mediaRefPattern = /^@media\/\d+$/;
const nodeFields = ["id", "type", "title", "position", "width", "height", "metadata"];
const metadataFields = ["templateInput", "content", "composerContent", "prompt", "status", "fontSize", "generationMode", "generationType", "model", "reasoningEffort", "size", "quality", "background", "count", "textCount", "texts", "primaryTextId", "seconds", "vquality", "generateAudio", "watermark", "videoMode", "audioVoice", "audioFormat", "audioSpeed", "audioInstructions", "references", "naturalWidth", "naturalHeight", "freeResize", "images", "primaryImageId", "storageKey", "mimeType", "bytes", "durationMs", "groupId"];

function record(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function fields(value: unknown, allowed: string[], label: string): asserts value is Record<string, unknown> {
    if (!record(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label} 格式不受支持`);
}

function text(value: unknown, label: string) {
    if (typeof value !== "string" || !value.trim()) throw new Error(`请提供 ${label}`);
    return value.trim();
}

function kindOf(key: string): Kind {
    if (!storageKeyPattern.test(key)) throw new Error("媒体引用格式无效");
    const prefix = key.split(":", 1)[0];
    return prefix === "video-reference" ? "video" : prefix === "audio-reference" ? "audio" : prefix as Kind;
}

function dataBlob(value: unknown, kind: Kind, label: string) {
    if (typeof value !== "string") throw new Error(`${label} 必须是 base64 data URL`);
    const match = /^data:([a-z][a-z0-9.+-]*\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
    if (!match || match[2].length % 4 !== 0 || (kind !== "file" && !match[1].startsWith(`${kind}/`))) throw new Error(`${label} 格式或媒体类型无效`);
    const bytes = Uint8Array.from(atob(match[2]), (char) => char.charCodeAt(0));
    if (btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")) !== match[2]) throw new Error(`${label} base64 内容无效`);
    return new Blob([bytes], { type: match[1].toLowerCase() });
}

function dataUrl(blob: Blob) {
    return blob.arrayBuffer().then((buffer) => {
        const bytes = new Uint8Array(buffer);
        let encoded = "";
        for (let i = 0; i < bytes.length; i += 32766) encoded += btoa(Array.from(bytes.subarray(i, i + 32766), (byte) => String.fromCharCode(byte)).join(""));
        return `data:${blob.type || "application/octet-stream"};base64,${encoded}`;
    });
}

function optionalString(value: unknown, label: string) {
    if (value !== undefined && typeof value !== "string") throw new Error(`${label} 必须是文本`);
}

function optionalNumber(value: unknown, label: string) {
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`${label} 必须是有限数字`);
}

function optionalBoolean(value: unknown, label: string) {
    if (value !== undefined && typeof value !== "boolean") throw new Error(`${label} 必须是布尔值`);
}

function resultStatus(value: unknown) {
    if (value !== undefined && value !== "idle" && value !== "success") throw new Error("模板包不能包含运行或错误任务");
}

function validateMetadata(metadata: Record<string, unknown>) {
    const strings = ["content", "composerContent", "prompt", "generationMode", "generationType", "model", "reasoningEffort", "size", "quality", "background", "primaryTextId", "seconds", "vquality", "generateAudio", "watermark", "videoMode", "audioVoice", "audioFormat", "audioSpeed", "audioInstructions", "primaryImageId", "storageKey", "mimeType", "groupId"];
    strings.forEach((key) => optionalString(metadata[key], key));
    ["fontSize", "count", "textCount", "naturalWidth", "naturalHeight", "bytes", "durationMs"].forEach((key) => optionalNumber(metadata[key], key));
    optionalBoolean(metadata.freeResize, "freeResize");
    resultStatus(metadata.status);
    if (metadata.generationMode !== undefined && !["text", "image", "video", "audio"].includes(metadata.generationMode as string)) throw new Error("生成模式无效");
    if (metadata.generationType !== undefined && !["generation", "edit"].includes(metadata.generationType as string)) throw new Error("图片生成类型无效");
    if (metadata.reasoningEffort !== undefined && !["auto", "low", "medium", "high", "xhigh"].includes(metadata.reasoningEffort as string)) throw new Error("思考程度无效");
    if (metadata.templateInput !== undefined) {
        fields(metadata.templateInput, ["name", "description", "required"], "模板输入");
        if (typeof metadata.templateInput.name !== "string" || !metadata.templateInput.name.trim() || typeof metadata.templateInput.description !== "string" || typeof metadata.templateInput.required !== "boolean") throw new Error("模板输入无效");
    }
    if (metadata.references !== undefined && (!Array.isArray(metadata.references) || metadata.references.some((value) => typeof value !== "string"))) throw new Error("节点媒体引用无效");
    if (metadata.images !== undefined) {
        if (!Array.isArray(metadata.images)) throw new Error("图片结果格式无效");
        const ids = new Set<string>();
        for (const image of metadata.images) {
            fields(image, ["id", "status", "content", "storageKey", "naturalWidth", "naturalHeight", "bytes", "mimeType", "errorDetails"], "图片结果");
            if (typeof image.id !== "string" || !image.id || ids.has(image.id)) throw new Error("图片结果标识无效");
            if (image.errorDetails !== undefined) throw new Error("模板包不能包含图片错误详情");
            delete image.errorDetails;
            ids.add(image.id);
            resultStatus(image.status);
            optionalString(image.content, "图片内容");
            optionalString(image.storageKey, "图片 storageKey");
            optionalString(image.mimeType, "图片 mimeType");
            ["naturalWidth", "naturalHeight", "bytes"].forEach((key) => optionalNumber(image[key], key));
        }
        if (metadata.primaryImageId && !ids.has(metadata.primaryImageId)) throw new Error("主图片引用无效");
    }
    if (metadata.texts !== undefined) {
        if (!Array.isArray(metadata.texts)) throw new Error("文本结果格式无效");
        const ids = new Set<string>();
        for (const item of metadata.texts) {
            fields(item, ["id", "status", "content"], "文本结果");
            if (typeof item.id !== "string" || !item.id || ids.has(item.id) || typeof item.content !== "string") throw new Error("文本结果无效");
            ids.add(item.id);
            resultStatus(item.status);
        }
        if (metadata.primaryTextId && !ids.has(metadata.primaryTextId)) throw new Error("主文本引用无效");
    }
}

async function readMedia(workspaceId: string, storageKey: string) {
    kindOf(storageKey);
    return readAgentMedia(workspaceId, storageKey);
}

async function upload(workspaceId: string, kind: Kind, blob: Blob) {
    assertAgentWorkspace(workspaceId);
    const stored = kind === "image" ? await uploadImage(blob) : await uploadMediaFile(blob, kind);
    if (!stored.storageKey) throw new Error("媒体未保存到工作区");
    return { storageKey: stored.storageKey, mimeType: stored.mimeType, bytes: stored.bytes, ...("width" in stored ? { width: stored.width, height: stored.height } : {}) };
}

function validateGraph(content: unknown) {
    content = structuredClone(content);
    fields(content, ["nodes", "connections", "backgroundMode", "showImageInfo", "viewport"], "模板内容");
    if (!Array.isArray(content.nodes) || !Array.isArray(content.connections)) throw new Error("模板图数据无效");
    const nodeIds = new Set<string>();
    for (const node of content.nodes) {
        fields(node, nodeFields, "模板节点");
        if (typeof node.id !== "string" || !node.id || nodeIds.has(node.id) || typeof node.type !== "string" || !(["text", "image", "video", "audio", "config", "group"].includes(node.type) || /^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(node.type)) || typeof node.title !== "string") throw new Error("模板节点类型或标识无效");
        nodeIds.add(node.id);
        fields(node.position, ["x", "y"], "节点位置");
        if (![node.position.x, node.position.y, node.width, node.height].every((value) => typeof value === "number" && Number.isFinite(value))) throw new Error("节点尺寸无效");
        if (node.metadata === undefined) continue;
        fields(node.metadata, metadataFields, "节点元数据");
        validateMetadata(node.metadata);
        if (node.metadata.templateInput && node.type !== "text" && node.type !== "image") throw new Error("只有文本和图片节点可作为模板输入");
    }
    for (const node of content.nodes) {
        const metadata = node.metadata;
        if (metadata?.groupId && (!nodeIds.has(metadata.groupId) || content.nodes.find((item: Record<string, unknown>) => item.id === metadata.groupId)?.type !== "group" || metadata.groupId === node.id)) throw new Error("节点分组引用无效");
        if (metadata?.groupId) {
            const seen = new Set([node.id]);
            let group = metadata.groupId;
            while (group) {
                if (seen.has(group)) throw new Error("节点分组存在循环引用");
                seen.add(group);
                group = content.nodes.find((item: Record<string, unknown>) => item.id === group)?.metadata?.groupId;
            }
        }
        for (const text of [metadata?.prompt, metadata?.composerContent]) if (typeof text === "string") for (const match of text.matchAll(/@\[node:([^\]]+)\]/g)) if (!nodeIds.has(match[1])) throw new Error("节点提示词引用无效");
        for (const ref of metadata?.references || []) if (ref.startsWith("template-input:") && !content.nodes.some((item: Record<string, any>) => item.id === ref.slice(15) && item.metadata?.templateInput)) throw new Error("模板输入引用无效");
        if (node.type.includes(":") && metadata?.content && !metadata.storageKey) throw new Error("插件内嵌内容不能打包，请先保存为媒体引用");
    }
    const edgeIds = new Set<string>();
    for (const edge of content.connections) {
        fields(edge, ["id", "fromNodeId", "toNodeId"], "模板连线");
        if (![edge.id, edge.fromNodeId, edge.toNodeId].every((value) => typeof value === "string" && value) || edgeIds.has(edge.id) || !nodeIds.has(edge.fromNodeId) || !nodeIds.has(edge.toNodeId)) throw new Error("模板连线无效");
        edgeIds.add(edge.id);
    }
    fields(content.viewport, ["x", "y", "k"], "模板视口");
    if (![content.viewport.x, content.viewport.y, content.viewport.k].every((value) => typeof value === "number" && Number.isFinite(value))) throw new Error("模板视口无效");
    if (!["dots", "lines", "blank"].includes(String(content.backgroundMode)) || typeof content.showImageInfo !== "boolean") throw new Error("模板外观无效");
    return content as CanvasTemplateContent;
}

function mapMedia(content: CanvasTemplateContent, map: (value: string) => string, expected: "source" | "package") {
    const reference = (value: string) => {
        const valid = expected === "source" ? storageKeyPattern.test(value) : mediaRefPattern.test(value);
        if (!valid) throw new Error("模板媒体必须是已持久化的当前工作区引用");
        return map(value);
    };
    const exactContent = (value: string) => {
        if (expected === "source" && mediaRefPattern.test(value) || expected === "package" && storageKeyPattern.test(value)) throw new Error("模板包混入了其他工作区媒体引用");
        return (expected === "source" ? storageKeyPattern : mediaRefPattern).test(value) ? reference(value) : value;
    };
    content.nodes.forEach((node) => {
        const metadata = node.metadata;
        if (!metadata) return;
        const mediaNode = ["image", "video", "audio"].includes(node.type);
        const sourceKey = metadata.storageKey;
        if (metadata.storageKey) metadata.storageKey = reference(metadata.storageKey);
        if ((mediaNode || sourceKey) && metadata.content) {
            if (expected === "source" && sourceKey && metadata.content.startsWith("blob:")) metadata.content = reference(sourceKey);
            else metadata.content = reference(metadata.content);
            if (sourceKey && metadata.content !== metadata.storageKey) throw new Error("节点媒体内容与 storageKey 不一致");
        } else if (metadata.content) metadata.content = exactContent(metadata.content);
        if (metadata.images) metadata.images.forEach((image) => {
            const imageKey = image.storageKey;
            if (image.storageKey) image.storageKey = reference(image.storageKey);
            if (image.content) {
                if (expected === "source" && imageKey && image.content.startsWith("blob:")) image.content = reference(imageKey);
                else image.content = reference(image.content);
                if (imageKey && image.content !== image.storageKey) throw new Error("图片内容与 storageKey 不一致");
            }
        });
        if (metadata.references) metadata.references = metadata.references.map((value) => value.startsWith("template-input:") ? value : reference(value));
        if (metadata.texts) metadata.texts.forEach((item) => { item.content = exactContent(item.content); });
    });
    return content;
}

function parsePackage(value: unknown): TemplatePackage {
    fields(value, ["format", "version", "template", "media"], "模板包");
    if (value.format !== "infinite-canvas-template" || value.version !== 1) throw new Error("模板包版本不支持");
    fields(value.template, ["title", "description", "cover", "content"], "模板信息");
    const title = text(value.template.title, "title");
    if (typeof value.template.description !== "string" || typeof value.template.cover !== "string" || !mediaRefPattern.test(value.template.cover)) throw new Error("模板信息无效");
    const content = validateGraph(value.template.content);
    if (!Array.isArray(value.media)) throw new Error("模板媒体清单无效");
    const refs = new Set<string>();
    const media = value.media.map((item: unknown) => {
        fields(item, ["ref", "kind", "mimeType", "bytes", "dataUrl"], "媒体条目");
        if (typeof item.ref !== "string" || !mediaRefPattern.test(item.ref) || refs.has(item.ref) || !["image", "video", "audio", "file"].includes(String(item.kind)) || typeof item.mimeType !== "string" || !Number.isSafeInteger(item.bytes) || item.bytes < 0) throw new Error("媒体清单无效");
        refs.add(item.ref);
        const blob = dataBlob(item.dataUrl, item.kind as Kind, "媒体 dataUrl");
        if (blob.type !== item.mimeType || blob.size !== item.bytes) throw new Error("媒体元信息与内容不符");
        return item as PackageMedia;
    });
    const used = new Set([value.template.cover]);
    mapMedia(content, (ref) => { used.add(ref); return ref; }, "package");
    if (used.size !== refs.size || [...used].some((ref) => !refs.has(ref))) throw new Error("模板包媒体清单与引用不匹配");
    const mediaKind = new Map(media.map((item) => [item.ref, item.kind]));
    if (mediaKind.get(value.template.cover) !== "image") throw new Error("模板封面必须是图片");
    for (const node of content.nodes) {
        const metadata = node.metadata;
        if (!metadata) continue;
        const expected = ["image", "video", "audio"].includes(node.type) ? node.type : null;
        for (const ref of [metadata.storageKey, ...(expected ? [metadata.content] : [])]) {
            if (ref && expected && mediaKind.get(ref) !== expected) throw new Error("节点媒体类型与节点不匹配");
        }
        for (const image of metadata.images || []) for (const ref of [image.storageKey, image.content]) {
            if (ref && mediaKind.get(ref) !== "image") throw new Error("图片结果必须引用图片媒体");
        }
    }
    return { format: "infinite-canvas-template", version: 1, template: { title, description: value.template.description, cover: value.template.cover, content }, media };
}

export async function runMediaTool(name: MediaToolName, input: Input): Promise<unknown> {
    const workspaceId = requireAgentWorkspace(input, name === "media_import" || name === "templates_import").id;
    if (name === "media_get") {
        const storageKey = text(input.storageKey, "storageKey");
        const blob = await readMedia(workspaceId, storageKey);
        return { workspaceId, storageKey, mimeType: blob.type || "application/octet-stream", bytes: blob.size };
    }
    if (name === "media_import") {
        const kind = input.kind;
        if (kind !== "image" && kind !== "video" && kind !== "audio" && kind !== "file") throw new Error("媒体类型无效");
        const stored = await upload(workspaceId, kind, dataBlob(input.dataUrl, kind, "dataUrl"));
        try { assertAgentWorkspace(workspaceId); }
        catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)}；已上传但尚未引用的媒体：${stored.storageKey}`); }
        return { status: "stored", workspaceId, ...stored, note: "媒体已存储；尚未加入画布、素材或模板" };
    }
    if (name === "templates_export") {
        const templateId = text(input.templateId, "templateId");
        await useCanvasTemplateStore.getState().load();
        assertAgentWorkspace(workspaceId);
        const state = useCanvasTemplateStore.getState();
        if (state.workspaceId !== workspaceId) throw new Error("模板数据仍属于切换前的工作区");
        const template = state.templates.find((item) => item.id === templateId);
        if (!template) throw new Error("模板不存在");
        const content = validateGraph(template.content);
        const keys: string[] = [];
        const ref = (key: string) => {
            if (!keys.includes(key)) keys.push(key);
            return `@media/${keys.indexOf(key)}`;
        };
        const cover = ref(template.cover.storageKey);
        mapMedia(content, ref, "source");
        const media: PackageMedia[] = [];
        for (let index = 0; index < keys.length; index++) {
            const key = keys[index];
            const blob = await readMedia(workspaceId, key);
            media.push({ ref: `@media/${index}`, kind: kindOf(key), mimeType: blob.type || "application/octet-stream", bytes: blob.size, dataUrl: await dataUrl(blob) });
        }
        assertAgentWorkspace(workspaceId);
        return { workspaceId, package: parsePackage({ format: "infinite-canvas-template", version: 1, template: { title: template.title, description: template.description, cover, content }, media }) };
    }
    if (name === "templates_import") {
        const source = parsePackage(input.package);
        const keys = new Map<string, string>();
        const uploaded: string[] = [];
        try {
            for (const item of source.media) {
                const stored = await upload(workspaceId, item.kind, dataBlob(item.dataUrl, item.kind, "媒体 dataUrl"));
                uploaded.push(stored.storageKey);
                assertAgentWorkspace(workspaceId);
                keys.set(item.ref, stored.storageKey);
            }
            const content = mapMedia(source.template.content, (ref) => keys.get(ref)!, "package");
            const now = new Date().toISOString();
            const template: CanvasTemplate = { id: nanoid(), title: source.template.title, description: source.template.description, cover: { storageKey: keys.get(source.template.cover)! }, content: cloneCanvasTemplateContent(content), createdAt: now, updatedAt: now };
            assertAgentWorkspace(workspaceId);
            const receipt = await useCanvasTemplateStore.getState().addImportedTemplate(template);
            return { status: "committed", ...receipt, id: template.id, templateId: template.id };
        } catch (error) {
            throw new Error(`${error instanceof Error ? error.message : String(error)}；已上传但尚未引用的媒体：${uploaded.length ? uploaded.join(", ") : "无"}`);
        }
    }
}
