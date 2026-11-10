import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import type { CanvasGenerationTaskBinding, CanvasNodeData, CanvasNodeImage, CanvasNodeText } from "@/types/canvas";
import { isGenerationTaskActive, type GenerationTask } from "@/types/generation-task";

export function canvasTaskMediaUrl(workspaceId: string, key: string) {
    return `/api/media/blob/${encodeURIComponent(key)}?workspaceId=${encodeURIComponent(workspaceId)}`;
}

export function assertCanvasTaskRequest(binding: CanvasGenerationTaskBinding, nodeId: string, kind: string, fingerprint: string) {
    if ((binding.originNodeId || binding.nodeId) !== nodeId || binding.kind !== kind || (binding.requestFingerprint && binding.requestFingerprint !== fingerprint)) throw new Error("同一请求 ID 的生成目标、模式或参数已变化，请使用新的请求 ID");
}

/** Read the archived object itself; failed decoding must never manufacture an aspect ratio. */
export function readCanvasTaskOutputMeta(url: string, kind: "image" | "video" | "audio", signal: AbortSignal): Promise<{ width?: number; height?: number; durationMs?: number }> {
    return new Promise((resolve, reject) => {
        const media = kind === "image" ? new Image() : document.createElement(kind);
        const cleanup = () => {
            media.onload = null;
            media.onerror = null;
            if (kind !== "image") { const video = media as HTMLMediaElement; video.onloadedmetadata = null; video.removeAttribute("src"); video.load(); }
            signal.removeEventListener("abort", abort);
        };
        const abort = () => { cleanup(); reject(new DOMException("媒体读取已停止", "AbortError")); };
        const failed = () => { cleanup(); reject(new Error("归档媒体尺寸读取失败，请恢复连接后核对原任务")); };
        const loaded = () => {
            const width = kind === "image" ? (media as HTMLImageElement).naturalWidth : kind === "video" ? (media as HTMLVideoElement).videoWidth : undefined;
            const height = kind === "image" ? (media as HTMLImageElement).naturalHeight : kind === "video" ? (media as HTMLVideoElement).videoHeight : undefined;
            const duration = kind !== "image" ? (media as HTMLMediaElement).duration : undefined;
            if (kind === "audio") {
                cleanup();
                return Number.isFinite(duration) && duration! >= 0 ? resolve({ durationMs: Math.round(duration! * 1000) }) : reject(new Error("归档音频时长暂不可读取"));
            }
            if (!(width > 0 && height > 0)) return failed();
            cleanup();
            resolve({ width, height, ...(duration && Number.isFinite(duration) ? { durationMs: Math.round(duration * 1000) } : {}) });
        };
        if (signal.aborted) return abort();
        signal.addEventListener("abort", abort, { once: true });
        media.onerror = failed;
        if (kind === "image") media.onload = loaded;
        else { (media as HTMLVideoElement).preload = "metadata"; (media as HTMLVideoElement).onloadedmetadata = loaded; }
        media.src = url;
    });
}

export async function hydrateCanvasTaskOutputDimensions(task: GenerationTask, signal: AbortSignal, read = readCanvasTaskOutputMeta): Promise<GenerationTask> {
    if (task.kind === "text") return task;
    const outputs = await Promise.all(task.outputs.map(async (output) => {
        if (task.kind === "audio" ? output.durationMs !== undefined : output.width && output.height) return output;
        try {
            const metadata = await read(canvasTaskMediaUrl(task.workspaceId, output.storageKey), task.kind, signal);
            if (signal.aborted) throw new DOMException("媒体读取已停止", "AbortError");
            return { ...output, ...metadata };
        } catch (error) {
            if (signal.aborted) throw error;
            return output; // The archived result remains readable when metadata cannot currently decode.
        }
    }));
    return { ...task, outputs };
}

export function matchesCanvasTask(node: CanvasNodeData, binding: CanvasGenerationTaskBinding, task?: GenerationTask) {
    const current = node.metadata?.generationTask;
    return node.id === binding.nodeId && current?.requestId === binding.requestId && current.workspaceId === binding.workspaceId && current.projectId === binding.projectId && current.nodeId === binding.nodeId && current.kind === binding.kind
        && (!task || (task.workspaceId === binding.workspaceId && task.requestId === binding.requestId && task.kind === binding.kind && task.canvasTarget?.projectId === binding.projectId && task.canvasTarget.nodeId === binding.nodeId && (!binding.taskId || task.id === binding.taskId) && (!current.taskId || task.id === current.taskId)));
}

/** Project immutable archived keys only; the browser never reuploads provider results. */
export function projectCanvasTask(node: CanvasNodeData, binding: CanvasGenerationTaskBinding, task: GenerationTask): CanvasNodeData {
    if (!matchesCanvasTask(node, binding, task)) return node;
    const active = isGenerationTaskActive(task);
    const metadata = { ...node.metadata, generationTask: { ...binding, taskId: task.id, status: task.status } };
    if (binding.kind === "text") {
        const outputs = new Map((task.textOutputs || []).map((output) => [output.slotIndex, output]));
        const originals = metadata.texts || binding.slotIds.map((id) => ({ id, status: "loading" as const, content: "" }));
        const texts: CanvasNodeText[] = originals.map((text) => {
            const index = binding.slotIds.indexOf(text.id);
            if (index < 0) return text;
            const output = outputs.get(index);
            const status = output?.status === "succeeded" ? "success" : active ? "loading" : "error";
            return { ...text, content: output?.content ?? text.content, status, errorDetails: status === "error" ? task.error || "文本生成未完成，请核对原任务；未重新生成" : undefined };
        });
        const primary = texts.find((text) => text.id === metadata.primaryTextId) || texts.find((text) => text.status === "success") || texts[0];
        return { ...node, metadata: { ...metadata, texts, primaryTextId: primary?.id, content: primary?.content || "", status: active ? "loading" : texts.some((text) => text.status === "success") ? "success" : "error", errorDetails: active || task.status === "succeeded" ? undefined : task.error || "文本生成未完成，请核对原任务；未重新生成" } };
    }
    const url = (key: string) => canvasTaskMediaUrl(binding.workspaceId, key);
    if (binding.kind === "audio") {
        const output = task.outputs[0];
        const errorDetails = active || task.status === "succeeded" ? undefined : task.error || "音频生成未完成，请核对原任务；未重新生成";
        return { ...node, metadata: { ...metadata, ...(output ? { content: url(output.storageKey), storageKey: output.storageKey, bytes: output.bytes, mimeType: output.mimeType, durationMs: output.durationMs } : {}), status: active ? "loading" : output ? "success" : "error", errorDetails } };
    }
    const metadataUnavailable = task.outputs.some((output) => !output.width || !output.height);
    const errorDetails = task.error || (metadataUnavailable ? "媒体已归档，尺寸暂不可读取；重新打开画布可重读原结果" : undefined) || (task.status === "needs_attention" ? "任务需要核对，请读取原任务状态；未重新生成" : "生成失败");
    if (binding.kind === "video") {
        const output = task.outputs[0];
        if (!output) return { ...node, metadata: { ...metadata, status: active ? "loading" : metadata.content ? "success" : "error", errorDetails: active ? undefined : errorDetails } };
        const size = output.width && output.height ? fitNodeSize(output.width, output.height, 420, 420) : { width: node.width, height: node.height };
        return { ...node, ...size, position: { x: node.position.x + (node.width - size.width) / 2, y: node.position.y + (node.height - size.height) / 2 }, metadata: { ...metadata, content: url(output.storageKey), storageKey: output.storageKey, bytes: output.bytes, mimeType: output.mimeType, durationMs: output.durationMs, status: active ? "loading" : "success", errorDetails: !metadataUnavailable && (active || task.status === "succeeded") ? undefined : errorDetails } };
    }
    const outputs = new Map(task.outputs.map((output, index) => [output.slotIndex ?? index, output]));
    const original = metadata.images || binding.slotIds.map((id) => ({ id, status: "loading" as const, content: "", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "" }));
    const images: CanvasNodeImage[] = original.map((image) => {
        const index = binding.slotIds.indexOf(image.id);
        if (index < 0) return image;
        const output = outputs.get(index);
        if (!output) return { ...image, status: active ? "loading" : "error", errorDetails: active ? undefined : errorDetails };
        return { id: image.id, status: "success", content: url(output.storageKey), storageKey: output.storageKey, naturalWidth: output.width || 0, naturalHeight: output.height || 0, bytes: output.bytes, mimeType: output.mimeType };
    });
    const primary = images.find((image) => image.id === metadata.primaryImageId && image.content) || images.find((image) => image.content);
    const status = active ? "loading" as const : images.some((image) => image.content) ? "success" as const : "error" as const;
    const next = { ...node, metadata: { ...metadata, images, status, errorDetails: !metadataUnavailable && (active || task.status === "succeeded") ? undefined : errorDetails } };
    if (!primary || (binding.preservePrimary && metadata.primaryImageId && primary.id !== metadata.primaryImageId)) return next;
    const edge = Math.max(node.width, node.height);
    const size = metadata.freeResize || !primary.naturalWidth || !primary.naturalHeight ? { width: node.width, height: node.height } : fitNodeSize(primary.naturalWidth, primary.naturalHeight, edge, edge);
    return { ...next, ...size, position: { x: node.position.x + (node.width - size.width) / 2, y: node.position.y + (node.height - size.height) / 2 }, metadata: { ...next.metadata, content: primary.content, storageKey: primary.storageKey, naturalWidth: primary.naturalWidth, naturalHeight: primary.naturalHeight, bytes: primary.bytes, mimeType: primary.mimeType, primaryImageId: primary.id } };
}
