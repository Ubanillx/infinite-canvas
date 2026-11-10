import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { cloneCanvasTemplateContent } from "@/lib/canvas/canvas-template";
import { getActiveWorkspace } from "@/lib/workspace";
import { copyCanvasTemplateMedia, readCanvasTemplateMedia } from "@/services/api/canvas-template-media";
import { saveMediaBlob } from "@/services/workspace-media";
import { CanvasNodeType } from "@/types/canvas";
import type { CanvasTemplateContent } from "@/types/canvas-template";

const storageKeyPattern = /^(image|video|audio|file|video-reference|audio-reference):/;
const contentMediaKeyPattern = /^(image|video|audio|file|video-reference|audio-reference):[A-Za-z0-9_-]+$/;

export function requireTemplateWorkspace(workspaceId: string | undefined): asserts workspaceId is string {
    if (!workspaceId || getActiveWorkspace()?.id !== workspaceId) throw new Error(i18n.t("canvas.templates.workspaceChanged"));
}

export function templateMediaError(error: unknown, keys: Set<string>): Error {
    if (!keys.size) return error instanceof Error ? error : new Error(String(error));
    const existing = error as Error & { createdMediaKeys?: string[] };
    if (existing.createdMediaKeys) return existing;
    const reason = error instanceof Error ? error.message : String(error);
    const failure = new Error(`${reason}；本次已复制媒体（未确认业务提交，请核对）：${[...keys].join(", ")}`) as Error & { createdMediaKeys: string[] };
    failure.createdMediaKeys = [...keys];
    return failure;
}

export async function copyCanvasTemplateContent(source: CanvasTemplateContent, workspaceId: string, copiedKeys = new Set<string>()): Promise<CanvasTemplateContent> {
    const content = cloneCanvasTemplateContent(source);
    const copies = new Map<string, Promise<string>>();
    const copy = (key: string | undefined, url: string, prefix?: string) => {
        const sourceKey = key || (storageKeyPattern.test(url) ? url : "");
        const identity = sourceKey || url;
        if (!copies.has(identity)) copies.set(identity, (async () => {
            if (!identity) throw new Error(i18n.t("canvas.templates.mediaMissing"));
            requireTemplateWorkspace(workspaceId);
            if (sourceKey) {
                const storageKey = await copyCanvasTemplateMedia(sourceKey);
                copiedKeys.add(storageKey);
                requireTemplateWorkspace(workspaceId);
                return storageKey;
            }
            const blob = await readCanvasTemplateMedia(url);
            if (!blob?.size) throw new Error(i18n.t("canvas.templates.mediaMissing"));
            requireTemplateWorkspace(workspaceId);
            const kind = prefix || (blob.type.startsWith("video/") ? "video" : blob.type.startsWith("audio/") ? "audio" : "image");
            const storageKey = `${kind}:${nanoid()}`;
            await saveMediaBlob(storageKey, blob);
            copiedKeys.add(storageKey);
            requireTemplateWorkspace(workspaceId);
            return storageKey;
        })());
        return copies.get(identity)!;
    };

    const results = await Promise.allSettled(content.nodes.map(async (node) => {
        const metadata = node.metadata;
        if (!metadata) return;
        const mediaNode = node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio;
        const pluginImage = node.type.includes(":") && metadata.content?.startsWith("data:image/");
        if ((mediaNode || metadata.storageKey || pluginImage) && (metadata.storageKey || metadata.content)) {
            metadata.storageKey = await copy(metadata.storageKey, metadata.content || "", mediaNode ? node.type : undefined);
            metadata.content = metadata.storageKey;
            metadata.status = "success";
        } else if (node.type === CanvasNodeType.Text && metadata.content && contentMediaKeyPattern.test(metadata.content)) {
            metadata.content = await copy(undefined, metadata.content, storageKeyPattern.exec(metadata.content)?.[1]);
        }
        await Promise.all((metadata.images || []).map(async (image) => {
            image.storageKey = await copy(image.storageKey, image.content, "image");
            image.content = image.storageKey;
        }));
        await Promise.all((metadata.texts || []).map(async (text) => {
            if (contentMediaKeyPattern.test(text.content)) text.content = await copy(undefined, text.content, storageKeyPattern.exec(text.content)?.[1]);
        }));
        if (metadata.references) metadata.references = await Promise.all(metadata.references.map((reference) => reference.startsWith("template-input:") ? reference : copy(undefined, reference, storageKeyPattern.exec(reference)?.[1])));
    }));
    await Promise.allSettled([...copies.values()]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw templateMediaError(failure.reason, copiedKeys);
    try { requireTemplateWorkspace(workspaceId); }
    catch (error) { throw templateMediaError(error, copiedKeys); }
    return content;
}
