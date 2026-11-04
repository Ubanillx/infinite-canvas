import localforage from "localforage";

import i18n from "@/i18n";
import { getActiveWorkspace, workspaceHeaders, workspaceStoreName } from "@/lib/workspace";

function url(key: string) { return `/api/media/blob/${encodeURIComponent(key)}`; }

function localCache(key: string) {
    return localforage.createInstance({ name: "infinite-canvas", storeName: workspaceStoreName(key.startsWith("image:") ? "image_files" : "media_files") });
}

export function mediaCacheKey(key: string) { return `${getActiveWorkspace()?.id || "unselected"}:${key}`; }

export async function saveMediaBlob(key: string, blob: Blob) {
    const response = await fetch(url(key), { method: "PUT", headers: { ...workspaceHeaders(), "content-type": blob.type || "application/octet-stream" }, body: blob });
    if (response.status === 413) throw new Error(i18n.t("common.mediaTooLarge"));
    if (!response.ok) throw new Error(i18n.t("common.mediaSaveFailedStatus", { status: response.status }));
}

export async function loadMediaBlob(key: string): Promise<Blob | null> {
    const response = await fetch(url(key), { headers: workspaceHeaders() });
    if (response.ok) return response.blob();
    if (response.status !== 404) throw new Error(`媒体读取失败（${response.status}）`);
    const existing = await localCache(key).getItem<Blob>(key);
    if (!existing) return null;
    await saveMediaBlob(key, existing);
    await localCache(key).removeItem(key).catch(() => undefined);
    return existing;
}

export async function removeMediaBlob(key: string) {
    // A blob can still be referenced by another canvas, asset, or history entry.
    await localCache(key).removeItem(key).catch(() => undefined);
}

export async function migrateWorkspaceMedia() {
    const workspace = getActiveWorkspace();
    if (!workspace) return;
    const marker = `infinite-canvas:server-media-migrated:${workspace.id}`;
    if (window.localStorage.getItem(marker)) return;
    for (const name of ["image_files", "media_files"]) {
        const cache = localforage.createInstance({ name: "infinite-canvas", storeName: workspaceStoreName(name) });
        const keys = await cache.keys();
        for (const key of keys) {
            const response = await fetch(url(key), { method: "HEAD", headers: workspaceHeaders() });
            if (response.status !== 404 && !response.ok) throw new Error(`媒体迁移检查失败（${response.status}）`);
            if (!response.ok) {
                const blob = await cache.getItem<Blob>(key);
                if (blob) await saveMediaBlob(key, blob);
            }
            await cache.removeItem(key);
        }
    }
    window.localStorage.setItem(marker, "1");
}
