import { assertAgentWorkspace, requireAgentWorkspace } from "@/lib/agent/agent-tool-context";
import { defineTemplateInputs, positionTemplateContent, prepareTemplateContent, templateSelection } from "@/lib/canvas/canvas-template";
import { getNodeDefinition, isBuiltinNodeType } from "@/lib/canvas/node-registry";
import { workspaceStorageKey } from "@/lib/workspace";
import { copyCanvasTemplateContent, templateMediaError } from "@/services/canvas-templates";
import { flushCanvasSave, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useCanvasTemplateStore } from "@/stores/canvas/use-canvas-template-store";
import { modelCapabilityOf, selectableModelsByCapability, useConfigStore } from "@/stores/use-config-store";
import { CanvasNodeType } from "@/types/canvas";
import type { CanvasTemplate, CanvasTemplateContent } from "@/types/canvas-template";

export const TEMPLATE_TOOL_NAMES = ["templates_list", "templates_get", "templates_create", "templates_update", "templates_delete", "templates_instantiate", "templates_insert"] as const;
export type TemplateToolName = (typeof TEMPLATE_TOOL_NAMES)[number];
export type TemplateCanvasContext = {
    projectId: string;
    getContent: () => CanvasTemplateContent;
    insert: (content: CanvasTemplateContent, center?: { x: number; y: number }) => Promise<{ workspaceId: string; domain: "canvas"; revision: number; updatedAt: string | null; insertedNodeIds: string[] }>;
};

type Input = Record<string, unknown>;
type TemplateInputValue = Parameters<typeof prepareTemplateContent>[2][string];
type TemplateInputSlot = NonNullable<CanvasTemplateContent["nodes"][number]["metadata"]>["templateInput"];

export function isTemplateTool(name: string): name is TemplateToolName {
    return (TEMPLATE_TOOL_NAMES as readonly string[]).includes(name);
}

function required(input: Input, key: string) {
    const value = input[key];
    if (typeof value !== "string" || !value.trim()) throw new Error(`请提供 ${key}`);
    return value.trim();
}

function optionalText(input: Input, key: string) {
    const value = input[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw new Error(`${key} 必须是文本`);
    return value.trim();
}

function optionalRecord(input: Input, key: string): Input {
    const value = input[key];
    if (value === undefined) return {};
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${key} 必须是对象`);
    return value as Input;
}

function canvas() {
    if (useCanvasStore.persist.getOptions().name !== workspaceStorageKey("infinite-canvas:canvas_store")) throw new Error("画布数据仍属于切换前的工作区，请刷新页面");
    const state = useCanvasStore.getState();
    if (!state.hydrated) throw new Error("画布还在加载中");
    return state;
}

async function templates(workspaceId: string) {
    await useCanvasTemplateStore.getState().load();
    assertAgentWorkspace(workspaceId);
    const state = useCanvasTemplateStore.getState();
    if (!state.loaded || state.workspaceId !== workspaceId) throw new Error("模板数据仍属于切换前的工作区，请刷新页面");
    return state.templates;
}

function project(id: string): CanvasProject {
    const item = canvas().projects.find((candidate) => candidate.id === id);
    if (!item) throw new Error("画布不存在");
    return item;
}

function template(items: CanvasTemplate[], id: string) {
    const item = items.find((candidate) => candidate.id === id);
    if (!item) throw new Error("模板不存在");
    return item;
}

function sourceContent(projectId: string, live?: TemplateCanvasContext): CanvasTemplateContent {
    const item = project(projectId);
    if (openProjectId() === projectId && live?.projectId !== projectId) throw new Error("当前画布编辑器未就绪，请稍后重试");
    return live?.projectId === projectId && openProjectId() === projectId ? live.getContent() : {
        nodes: item.nodes, connections: item.connections, backgroundMode: item.backgroundMode,
        showImageInfo: item.showImageInfo, viewport: item.viewport,
    };
}

function openProjectId() {
    const match = window.location.pathname.match(/^\/canvas\/([^/]+)\/?$/);
    if (!match) return null;
    try { return decodeURIComponent(match[1]); } catch { return null; }
}

function sourceForTemplate(input: Input, projectId: string, live?: TemplateCanvasContext) {
    const source = sourceContent(projectId, live);
    const selection = input.selectionNodeIds;
    if (selection !== undefined) {
        if (!Array.isArray(selection) || !selection.length || selection.some((id) => typeof id !== "string" || !source.nodes.some((node) => node.id === id))) throw new Error("selectionNodeIds 必须包含画布中的节点 ID");
        if (input.includeDependencies !== undefined && typeof input.includeDependencies !== "boolean") throw new Error("includeDependencies 必须为布尔值");
    }
    const selected = selection ? templateSelection(source, selection as string[], input.includeDependencies !== false).content : source;
    const rawSlots = optionalRecord(input, "inputSlots");
    const slots: Record<string, TemplateInputSlot | null> = {};
    for (const [id, value] of Object.entries(rawSlots)) {
        const node = selected.nodes.find((candidate) => candidate.id === id);
        if (!node) throw new Error(`输入槽节点不存在：${id}`);
        if (node.type !== CanvasNodeType.Text && node.type !== CanvasNodeType.Image) throw new Error(`输入槽仅支持文本或图片节点：${id}`);
        if (value === null) { slots[id] = null; continue; }
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`输入槽无效：${id}`);
        const slot = value as Input;
        if (typeof slot.name !== "string" || !slot.name.trim() || typeof slot.description !== "string" || typeof slot.required !== "boolean") throw new Error(`输入槽无效：${id}`);
        slots[id] = { name: slot.name.trim(), description: slot.description, required: slot.required };
    }
    return Object.keys(slots).length ? defineTemplateInputs(selected, slots, source) : selected;
}

function useOptions(input: Input, source: CanvasTemplateContent) {
    const config = useConfigStore.getState().config;
    const capability = (node: CanvasTemplateContent["nodes"][number]) => node.metadata?.generationMode || (node.type === CanvasNodeType.Config ? "image" : node.type === CanvasNodeType.Image ? "image" : node.type === CanvasNodeType.Video ? "video" : node.type === CanvasNodeType.Audio ? "audio" : node.type === CanvasNodeType.Text ? "text" : undefined);
    const missingPlugins = source.nodes.filter((node) => !isBuiltinNodeType(node.type) && !getNodeDefinition(node.type));
    if (missingPlugins.length) throw new Error(`模板缺少节点插件：${[...new Set(missingPlugins.map((node) => node.type))].join(", ")}`);
    const rawInputs = optionalRecord(input, "inputs");
    const values: Record<string, TemplateInputValue> = {};
    for (const [id, value] of Object.entries(rawInputs)) {
        const node = source.nodes.find((candidate) => candidate.id === id);
        if (!node?.metadata?.templateInput) throw new Error(`模板输入节点不存在：${id}`);
        if (typeof value === "string") {
            if (node.type === "image") throw new Error(`图片输入必须提供 storageKey：${id}`);
            values[id] = value;
        } else {
            if (node.type !== "image" || !value || typeof value !== "object" || Array.isArray(value)) throw new Error(`模板输入无效：${id}`);
            const image = value as Input;
            if (typeof image.storageKey !== "string" || !image.storageKey.startsWith("image:") || typeof image.naturalWidth !== "number" || !Number.isFinite(image.naturalWidth) || image.naturalWidth <= 0 || typeof image.naturalHeight !== "number" || !Number.isFinite(image.naturalHeight) || image.naturalHeight <= 0 || typeof image.bytes !== "number" || !Number.isFinite(image.bytes) || image.bytes <= 0 || typeof image.mimeType !== "string" || !image.mimeType.startsWith("image/")) throw new Error(`图片输入无效：${id}`);
            values[id] = { storageKey: image.storageKey, content: image.storageKey, naturalWidth: image.naturalWidth as number, naturalHeight: image.naturalHeight as number, bytes: image.bytes as number, mimeType: image.mimeType };
        }
    }
    const replacements = optionalRecord(input, "replacements");
    for (const [id, value] of Object.entries(replacements)) if (!source.nodes.some((node) => node.id === id && node.metadata?.model) || typeof value !== "string" || !value.trim()) throw new Error(`模型替换无效：${id}`);
    for (const node of source.nodes) {
        const original = node.metadata?.model;
        if (!original) continue;
        const kind = capability(node);
        const replacement = replacements[node.id] as string | undefined;
        if (replacement && !selectableModelsByCapability(config, kind).includes(replacement)) throw new Error(`模板模型替换无效：${node.title}`);
        if ((!modelCapabilityOf(config, original) || kind && modelCapabilityOf(config, original) !== kind) && !replacement) throw new Error(`模板模型不可用，请为「${node.title}」指定替换模型`);
    }
    if (input.keepExamples !== undefined && typeof input.keepExamples !== "boolean") throw new Error("keepExamples 必须为布尔值");
    return prepareTemplateContent(source, input.keepExamples !== false, values, replacements as Record<string, string>);
}

function centerOf(input: Input) {
    if (input.center === undefined) return undefined;
    const center = optionalRecord(input, "center");
    if (typeof center.x !== "number" || !Number.isFinite(center.x) || typeof center.y !== "number" || !Number.isFinite(center.y)) throw new Error("center 必须包含有限的 x、y 坐标");
    return { x: center.x, y: center.y };
}

export async function runTemplateTool(name: TemplateToolName, input: Input, live?: TemplateCanvasContext): Promise<unknown> {
    const { id: workspaceId } = requireAgentWorkspace(input, !["templates_list", "templates_get"].includes(name));
    const items = await templates(workspaceId);
    if (name === "templates_list") {
        const keyword = optionalText(input, "keyword")?.toLowerCase() || "";
        const matches = items.filter((item) => !keyword || `${item.title} ${item.description}`.toLowerCase().includes(keyword));
        const pageSize = Math.max(1, Math.min(100, Math.floor(Number(input.pageSize)) || 20));
        const page = Math.min(Math.max(1, Math.ceil(matches.length / pageSize)), Math.max(1, Math.floor(Number(input.page)) || 1));
        return { workspaceId, total: matches.length, page, pageSize, items: matches.slice((page - 1) * pageSize, page * pageSize).map((item) => ({ id: item.id, title: item.title, description: item.description, cover: item.cover, createdAt: item.createdAt, updatedAt: item.updatedAt, nodeCount: item.content.nodes.length, connectionCount: item.content.connections.length })) };
    }
    if (name === "templates_get") return { workspaceId, template: template(items, required(input, "templateId")) };
    if (name === "templates_create") {
        const projectId = required(input, "projectId");
        const title = required(input, "title");
        const content = sourceForTemplate(input, projectId, live);
        assertAgentWorkspace(workspaceId);
        const { id, commit } = await useCanvasTemplateStore.getState().save(content, title, optionalText(input, "description") || "");
        return { status: "committed", ...commit, templateId: id };
    }
    if (name === "templates_update") {
        const id = required(input, "templateId");
        template(items, id);
        const title = optionalText(input, "title");
        if (title !== undefined && !title) throw new Error("请提供 title");
        const description = optionalText(input, "description");
        const sourceProjectId = optionalText(input, "sourceProjectId");
        if (!sourceProjectId && (input.selectionNodeIds !== undefined || input.inputSlots !== undefined || input.includeDependencies !== undefined)) throw new Error("更新模板内容时必须提供 sourceProjectId");
        const content = sourceProjectId ? sourceForTemplate(input, sourceProjectId, live) : null;
        if (!content && input.title === undefined && input.description === undefined) throw new Error("请提供模板修改内容");
        assertAgentWorkspace(workspaceId);
        const commit = content ? await useCanvasTemplateStore.getState().replace(id, content, title, description) : await useCanvasTemplateStore.getState().update(id, title, description);
        return { status: "committed", ...commit, templateId: id };
    }
    if (name === "templates_delete") {
        const id = required(input, "templateId");
        template(items, id);
        assertAgentWorkspace(workspaceId);
        const commit = await useCanvasTemplateStore.getState().remove(id);
        return { status: "committed", ...commit, templateId: id };
    }

    const source = template(items, required(input, "templateId"));
    const prepared = useOptions(input, source.content);
    let folderId: string | null = null;
    let projectTitle = "";
    let projectId = "";
    let center: { x: number; y: number } | undefined;
    if (name === "templates_instantiate") {
        folderId = input.folderId === undefined || input.folderId === null ? null : required(input, "folderId");
        if (folderId && !canvas().folders.some((folder) => folder.id === folderId)) throw new Error("文件夹不存在");
        projectTitle = optionalText(input, "title") ?? source.title;
        if (!projectTitle) throw new Error("请提供 title");
    } else if (name === "templates_insert") {
        projectId = required(input, "projectId");
        project(projectId);
        if (openProjectId() === projectId && live?.projectId !== projectId) throw new Error("当前画布编辑器未就绪，请稍后重试");
        center = centerOf(input);
        if (!prepared.nodes.length) throw new Error("模板没有可插入的节点");
    }
    const copiedKeys = new Set<string>();
    try {
        const content = await copyCanvasTemplateContent(prepared, workspaceId, copiedKeys);
        assertAgentWorkspace(workspaceId);
        if (name === "templates_instantiate") {
            const { id, commit } = await canvas().createProjectFromTemplateWithCommit(content, projectTitle, optionalText(input, "description") ?? source.description, folderId);
            return { status: "committed", ...commit, projectId: id };
        }
        if (name === "templates_insert") {
            const target = project(projectId);
            if (live?.projectId === projectId) {
                const commit = await live.insert(content, center);
                return { status: "committed", ...commit, projectId };
            }
            if (openProjectId() === projectId) throw new Error("当前画布编辑器未就绪，请稍后重试");
            const inserted = center ? positionTemplateContent(content, center) : content;
            assertAgentWorkspace(workspaceId);
            canvas().updateProject(projectId, { nodes: [...target.nodes, ...inserted.nodes], connections: [...target.connections, ...inserted.connections] });
            const commit = await flushCanvasSave(workspaceId);
            return { status: "committed", ...commit, projectId, insertedNodeIds: inserted.nodes.map((node) => node.id) };
        }
        throw new Error(`未知模板工具：${name}`);
    } catch (error) { throw templateMediaError(error, copiedKeys); }
}
