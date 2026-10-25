import { workspaceHeaders } from "@/lib/workspace";
import { remoteMediaUrl } from "@/services/api/remote-media";
import i18n from "@/i18n";

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
