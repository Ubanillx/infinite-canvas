import { getActiveWorkspace, workspaceHeaders } from "@/lib/workspace";
import { remoteMediaUrl } from "@/services/api/remote-media";
import i18n from "@/i18n";

export function canvasTemplateImageUrl(storageKey?: string, content = "") {
    const key = storageKey || (/^(image|file):/.test(content) ? content : "");
    if (!key) {
        if (/^(blob:|data:image\/)/i.test(content)) return content;
        if (/^(https?:)?\/\//i.test(content)) return remoteMediaUrl(new URL(content, window.location.origin).href);
        return content.startsWith("/") ? content : "";
    }
    const workspaceId = getActiveWorkspace()?.id;
    return workspaceId ? `/api/media/blob/${encodeURIComponent(key)}?workspaceId=${encodeURIComponent(workspaceId)}` : "";
}

export async function readCanvasTemplateMedia(url: string) {
    const response = await fetch(remoteMediaUrl(url), { headers: workspaceHeaders() });
    if (!response.ok) throw new Error(i18n.t("canvas.templates.mediaReadFailed"));
    return response.blob();
}

export async function copyCanvasTemplateMedia(storageKey: string): Promise<string> {
    const response = await fetch(`/api/media/blob/${encodeURIComponent(storageKey)}/copy`, { method: "POST", headers: workspaceHeaders() });
    if (!response.ok) throw new Error(i18n.t("canvas.templates.mediaReadFailed"));
    return (await response.json()).storageKey;
}
