import localforage from "localforage";
import { nanoid } from "nanoid";
import { workspaceStoreName } from "@/lib/workspace";

import { remoteMediaUrl } from "@/services/api/remote-media";
import { loadMediaBlob, mediaCacheKey, removeMediaBlob, saveMediaBlob } from "@/services/workspace-media";

export type UploadedFile = { url: string; storageKey: string; bytes: number; mimeType: string; width?: number; height?: number; durationMs?: number };

const store = localforage.createInstance({ name: "infinite-canvas", storeName: workspaceStoreName("media_files") });
const objectUrls = new Map<string, string>();

export async function uploadMediaFile(input: string | Blob, prefix = "file"): Promise<UploadedFile> {
    const response = typeof input === "string" ? await fetch(remoteMediaUrl(input)) : null;
    if (response && !response.ok) throw new Error(`媒体下载失败（${response.status}）`);
    const blob = response ? await response.blob() : input as Blob;
    const storageKey = `${prefix}:${nanoid()}`;
    await saveMediaBlob(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(mediaCacheKey(storageKey), url);
    const meta = blob.type.startsWith("video/") ? await readVideoMeta(url) : blob.type.startsWith("audio/") ? await readAudioMeta(url) : {};
    return { url, storageKey, bytes: blob.size, mimeType: blob.type || "application/octet-stream", ...meta };
}

export async function resolveMediaUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    const cached = objectUrls.get(mediaCacheKey(storageKey));
    if (cached) return cached;
    const blob = await loadMediaBlob(storageKey);
    if (!blob) return fallback;
    const url = URL.createObjectURL(blob);
    objectUrls.set(mediaCacheKey(storageKey), url);
    return url;
}

export async function getMediaBlob(storageKey: string) {
    return loadMediaBlob(storageKey);
}

export async function setMediaBlob(storageKey: string, blob: Blob) {
    await saveMediaBlob(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(mediaCacheKey(storageKey), url);
    return url;
}

export async function deleteStoredMedia(keys: Iterable<string>) {
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            const cacheKey = mediaCacheKey(key);
            const url = objectUrls.get(cacheKey);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(cacheKey);
            await removeMediaBlob(key);
        }),
    );
}

export async function cleanupUnusedMedia(usedData: unknown) {
    const usedKeys = collectMediaStorageKeys(usedData);
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        if (!usedKeys.has(key)) unused.push(key);
    });
    await Promise.all(unused.map((key) => store.removeItem(key)));
}

export function collectMediaStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectMediaStorageKeys(child, keys)) : collectMediaStorageKeys(item, keys)));
    return keys;
}

function readVideoMeta(url: string) {
    return new Promise<{ width: number; height: number; durationMs?: number }>((resolve) => {
        const video = document.createElement("video");
        const done = () => resolve({ width: video.videoWidth || 1280, height: video.videoHeight || 720, durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined });
        video.onloadedmetadata = done;
        video.onerror = done;
        video.src = url;
    });
}

function readAudioMeta(url: string) {
    return new Promise<{ durationMs?: number }>((resolve) => {
        const audio = document.createElement("audio");
        const done = () => resolve({ durationMs: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : undefined });
        audio.onloadedmetadata = done;
        audio.onerror = done;
        audio.src = url;
    });
}
