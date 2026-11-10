import type { GenerationTaskReference } from "@/types/generation-task";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

export function taskReferencesToWorkbench(workspaceId: string, references: GenerationTaskReference[]) {
    const images: ReferenceImage[] = [];
    const videos: ReferenceVideo[] = [];
    const audios: ReferenceAudio[] = [];
    references.forEach((item, index) => {
        const url = `/api/media/blob/${encodeURIComponent(item.storageKey)}?workspaceId=${encodeURIComponent(workspaceId)}`;
        const base = { id: `${index}-${item.storageKey}`, name: item.name || item.storageKey, type: item.mimeType || "", storageKey: item.storageKey };
        if (item.kind === "image") images.push({ ...base, dataUrl: url });
        if (item.kind === "video") videos.push({ ...base, url, width: item.width, height: item.height, durationMs: item.durationMs });
        if (item.kind === "audio") audios.push({ ...base, url, durationMs: item.durationMs });
    });
    return { images, videos, audios };
}
