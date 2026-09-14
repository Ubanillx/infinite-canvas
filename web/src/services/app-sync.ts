import i18n from "@/i18n";
import { getActiveWorkspace, workspaceHeaders } from "@/lib/workspace";
import { randomId } from "@/lib/utils";
import { getMediaBlob, resolveMediaUrl, setMediaBlob } from "@/services/file-storage";
import { getImageBlob, resolveImageUrl, setImageBlob } from "@/services/image-storage";
import { deleteWebdavPath, downloadWebdavFile, listWebdavDirectory, uploadWebdavFile, WEBDAV_MANIFEST_FILE_NAME, type WebdavWriteMode } from "@/services/webdav-sync";
import type { Asset } from "@/stores/use-asset-store";
import { useAssetStore } from "@/stores/use-asset-store";
import type { WebdavSyncConfig } from "@/stores/use-config-store";

export type AppSyncDomainKey = "assets";
type AssetDomainData = { assets: Asset[] };
type AppSyncFile = { storageKey: string; path: string; mimeType: string; bytes: number };
type DomainManifest = { app: "infinite-canvas"; version: 2; workspaceId: string; snapshotId: string; domain: "assets"; exportedAt: string; data: AssetDomainData; files: AppSyncFile[] };
type SnapshotComplete = { app: "infinite-canvas"; version: 2; workspaceId: string; snapshotId: string; createdAt: string; domains: string[] };

export type AssetSyncResult = { syncedAt: string; assets: number; files: number; manifestBytes: number; uploadedFiles: number; uploadedBytes: number };
export type AppSyncProgressEvent = { domain?: AppSyncDomainKey; label?: string; stage: string; current?: number; total?: number; status?: "active" | "success" | "exception" };
export type AppSyncProgress = (event: AppSyncProgressEvent) => void;
export type WebdavSnapshot = { id: string; createdAt: string };

const FILE_CONCURRENCY = 3;
const SNAPSHOT_LIMIT = 30;
const storageKeyPattern = /^(image|video|audio|file|video-reference|audio-reference):/;

export async function syncWorkspaceAssetsToWebdav(config: WebdavSyncConfig, onProgress?: AppSyncProgress, writeMode: WebdavWriteMode = "manual"): Promise<AssetSyncResult> {
    const workspace = requireWorkspace();
    const snapshotId = createSnapshotId();
    const scopedConfig = workspaceWebdavConfig(config, workspace.id);
    emitProgress(onProgress, { stage: "等待本地数据加载" });
    await waitForHydration(useAssetStore);
    const data = { assets: useAssetStore.getState().assets };
    const uploaded = await uploadAssets(scopedConfig, workspace.id, snapshotId, data, onProgress, writeMode);
    const complete: SnapshotComplete = { app: "infinite-canvas", version: 2, workspaceId: workspace.id, snapshotId, createdAt: new Date().toISOString(), domains: ["assets"] };
    emitProgress(onProgress, { stage: "完成快照", status: "active" });
    await uploadWebdavFile(scopedConfig, `snapshots/${snapshotId}/complete.json`, new Blob([JSON.stringify(complete, null, 2)], { type: "application/json" }), "application/json", writeMode);
    await pruneSnapshots(scopedConfig, onProgress, writeMode);
    emitProgress(onProgress, { stage: "资产快照已上传", status: "success" });
    return { syncedAt: new Date().toISOString(), assets: data.assets.length, files: uploaded.files.length, manifestBytes: uploaded.manifestBytes, uploadedFiles: uploaded.uploadedFiles, uploadedBytes: uploaded.uploadedBytes };
}

export async function listWorkspaceAssetSnapshots(config: WebdavSyncConfig): Promise<WebdavSnapshot[]> {
    const workspace = requireWorkspace();
    const scopedConfig = workspaceWebdavConfig(config, workspace.id);
    const ids = (await listWebdavDirectory(scopedConfig, "snapshots")).filter(isSnapshotId).sort().reverse();
    const snapshots = await Promise.all(ids.map(async (id) => {
        const complete = await readSnapshotComplete(scopedConfig, workspace.id, id);
        return complete ? { id, createdAt: complete.createdAt } : null;
    }));
    return snapshots.filter((item): item is WebdavSnapshot => Boolean(item)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function importWorkspaceAssetsSnapshot(config: WebdavSyncConfig, snapshotId: string, onProgress?: AppSyncProgress): Promise<AssetSyncResult> {
    const workspace = requireWorkspace();
    if (!isSnapshotId(snapshotId)) throw new Error("快照标识无效");
    const scopedConfig = workspaceWebdavConfig(config, workspace.id);
    const complete = await readSnapshotComplete(scopedConfig, workspace.id, snapshotId);
    if (!complete) throw new Error("当前工作区的资产快照不存在");
    emitProgress(onProgress, { stage: "等待本地数据加载" });
    await waitForHydration(useAssetStore);
    try {
        emitProgress(onProgress, { domain: "assets", label: "我的资产", stage: "读取远端快照", status: "active" });
        const remote = await readAssetManifest(scopedConfig, workspace.id, snapshotId);
        const local = { assets: useAssetStore.getState().assets };
        const data = { assets: mergeImportedById(local.assets, remote.data.assets) };
        await downloadMissingFiles(scopedConfig, data, remote.files, onProgress);
        emitProgress(onProgress, { domain: "assets", label: "我的资产", stage: "写入导入数据", status: "active" });
        useAssetStore.getState().replaceAssets(await Promise.all(data.assets.map(hydrateAsset)));
        emitProgress(onProgress, { domain: "assets", label: "我的资产", stage: "完成", current: 1, total: 1, status: "success" });
        emitProgress(onProgress, { stage: "资产导入完成", status: "success" });
        return { syncedAt: new Date().toISOString(), assets: data.assets.length, files: remote.files.length, manifestBytes: 0, uploadedFiles: 0, uploadedBytes: 0 };
    } catch (error) {
        emitProgress(onProgress, { domain: "assets", label: "我的资产", stage: errorText(error), status: "exception" });
        throw error;
    }
}

async function uploadAssets(config: WebdavSyncConfig, workspaceId: string, snapshotId: string, data: AssetDomainData, onProgress: AppSyncProgress | undefined, writeMode: WebdavWriteMode) {
    try {
        emitProgress(onProgress, { domain: "assets", label: "我的资产", stage: "读取本地数据", status: "active" });
        const uploaded = await uploadLocalFiles(config, data, onProgress, writeMode);
        const manifest: DomainManifest = { app: "infinite-canvas", version: 2, workspaceId, snapshotId, domain: "assets", exportedAt: new Date().toISOString(), data, files: uploaded.files };
        const manifestFile = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
        emitProgress(onProgress, { domain: "assets", label: "我的资产", stage: `上传快照清单 ${formatBytes(manifestFile.size)}`, status: "active" });
        await uploadWebdavFile(config, `snapshots/${snapshotId}/assets/${WEBDAV_MANIFEST_FILE_NAME}`, manifestFile, "application/json", writeMode);
        emitProgress(onProgress, { domain: "assets", label: "我的资产", stage: "完成", current: 1, total: 1, status: "success" });
        return { ...uploaded, manifestBytes: manifestFile.size };
    } catch (error) {
        emitProgress(onProgress, { domain: "assets", label: "我的资产", stage: errorText(error), status: "exception" });
        throw error;
    }
}

async function readSnapshotComplete(config: WebdavSyncConfig, workspaceId: string, snapshotId: string) {
    const file = await downloadWebdavFile(config, `snapshots/${snapshotId}/complete.json`);
    if (!file) return null;
    const complete = JSON.parse(await file.text()) as Partial<SnapshotComplete>;
    return complete.app === "infinite-canvas" && complete.version === 2 && complete.workspaceId === workspaceId && complete.snapshotId === snapshotId && Boolean(complete.createdAt) && complete.domains?.includes("assets") ? complete as SnapshotComplete : null;
}

async function readAssetManifest(config: WebdavSyncConfig, workspaceId: string, snapshotId: string) {
    const file = await downloadWebdavFile(config, `snapshots/${snapshotId}/assets/${WEBDAV_MANIFEST_FILE_NAME}`);
    if (!file) throw new Error("快照缺少资产数据");
    const manifest = JSON.parse(await file.text()) as Partial<DomainManifest>;
    if (manifest.app !== "infinite-canvas" || manifest.version !== 2 || manifest.workspaceId !== workspaceId || manifest.snapshotId !== snapshotId || manifest.domain !== "assets") throw new Error(i18n.t("config.webdav.errors.invalidManifest", { domain: "assets" }));
    return { data: manifest.data || { assets: [] }, files: Array.isArray(manifest.files) ? manifest.files : [] };
}

async function uploadLocalFiles(config: WebdavSyncConfig, data: AssetDomainData, onProgress: AppSyncProgress | undefined, writeMode: WebdavWriteMode) {
    const keys = collectStorageKeys(data);
    const files: AppSyncFile[] = [];
    let uploadedFiles = 0;
    let uploadedBytes = 0;
    await runWithConcurrency(keys, FILE_CONCURRENCY, async (storageKey, index) => {
        const blob = storageKey.startsWith("image:") ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
        if (!blob) return;
        const item = { storageKey, path: `files/${safeFileName(storageKey)}.${fileExtension(blob.type, storageKey)}`, mimeType: blob.type || "application/octet-stream", bytes: blob.size };
        await uploadWebdavFile(config, item.path, blob, item.mimeType, writeMode);
        files.push(item);
        uploadedFiles += 1;
        uploadedBytes += blob.size;
        emitProgress(onProgress, { domain: "assets", label: "我的资产", stage: `上传媒体 ${formatBytes(blob.size)}`, current: index + 1, total: keys.length, status: "active" });
    });
    if (files.length) {
        await fetch("/api/media", { method: "POST", headers: { "content-type": "application/json", ...workspaceHeaders() }, body: JSON.stringify({ files: files.map((file) => ({ storageKey: file.storageKey, remotePath: `${workspaceDirectory(config)}/${file.path}`, mimeType: file.mimeType, bytes: file.bytes })) }) }).catch(() => undefined);
    }
    return { files, uploadedFiles, uploadedBytes };
}

async function downloadMissingFiles(config: WebdavSyncConfig, data: AssetDomainData, remoteFiles: AppSyncFile[], onProgress?: AppSyncProgress) {
    const files = new Map(remoteFiles.map((item) => [item.storageKey, item]));
    const tasks: AppSyncFile[] = [];
    const keys = collectStorageKeys(data);
    for (const key of keys) {
        const local = key.startsWith("image:") ? await getImageBlob(key) : await getMediaBlob(key);
        const remote = files.get(key);
        if (!local && remote) tasks.push(remote);
    }
    await runWithConcurrency(tasks, FILE_CONCURRENCY, async (file, index) => {
        const blob = await downloadWebdavFile(config, file.path);
        if (!blob) return;
        const typed = blob.type ? blob : blob.slice(0, blob.size, file.mimeType);
        await (file.storageKey.startsWith("image:") ? setImageBlob(file.storageKey, typed) : setMediaBlob(file.storageKey, typed));
        emitProgress(onProgress, { domain: "assets", label: "我的资产", stage: "下载导入媒体", current: index + 1, total: tasks.length, status: "active" });
    });
}

async function pruneSnapshots(config: WebdavSyncConfig, onProgress: AppSyncProgress | undefined, writeMode: WebdavWriteMode) {
    const snapshots = (await listWebdavDirectory(config, "snapshots")).filter(isSnapshotId).sort().reverse();
    await Promise.all(snapshots.slice(SNAPSHOT_LIMIT).map((id) => deleteWebdavPath(config, `snapshots/${id}`, writeMode)));
    if (snapshots.length > SNAPSHOT_LIMIT) emitProgress(onProgress, { stage: `已清理 ${snapshots.length - SNAPSHOT_LIMIT} 个旧快照` });
}

async function hydrateAsset(asset: Asset): Promise<Asset> {
    if (asset.kind === "image" && asset.data.storageKey) { const dataUrl = await resolveImageUrl(asset.data.storageKey, asset.data.dataUrl); return { ...asset, coverUrl: asset.coverUrl.startsWith("blob:") ? dataUrl : asset.coverUrl, data: { ...asset.data, dataUrl } }; }
    if (asset.kind === "video" && asset.data.storageKey) { const url = await resolveMediaUrl(asset.data.storageKey, asset.data.url); return { ...asset, coverUrl: asset.coverUrl.startsWith("blob:") ? url : asset.coverUrl, data: { ...asset.data, url } }; }
    return asset;
}

function requireWorkspace() { const workspace = getActiveWorkspace(); if (!workspace) throw new Error("请先选择工作区"); return workspace; }
function workspaceWebdavConfig(config: WebdavSyncConfig, workspaceId: string) { return { ...config, directory: ["workspaces", workspaceId].join("/") }; }
function workspaceDirectory(config: WebdavSyncConfig) { return config.directory.replace(/^\/+|\/+$/g, ""); }
function createSnapshotId() { return `${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${randomId().slice(0, 8)}`; }
function isSnapshotId(value: string) { return /^\d{8}T\d{6}Z-[A-Za-z0-9_-]{8}$/.test(value); }
function mergeImportedById<T extends { id?: string }>(local: T[], remote: T[]) { const items = new Map(remote.filter((item) => item.id).map((item) => [item.id!, item])); local.forEach((item) => { if (item.id) items.set(item.id, item); }); return [...items.values()]; }
function collectStorageKeys(value: unknown, keys = new Set<string>()): string[] { if (typeof value === "string") { if (storageKeyPattern.test(value)) keys.add(value); return [...keys]; } if (!value || typeof value !== "object") return [...keys]; if ("storageKey" in value && typeof value.storageKey === "string" && storageKeyPattern.test(value.storageKey)) keys.add(value.storageKey); Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectStorageKeys(child, keys)) : collectStorageKeys(item, keys))); return [...keys]; }
function safeFileName(value: string) { return value.replace(/[\\/:*?"<>|]/g, "_"); }
function fileExtension(mimeType: string, storageKey: string) { if (mimeType.includes("png")) return "png"; if (mimeType.includes("jpeg")) return "jpg"; if (mimeType.includes("webp")) return "webp"; if (mimeType.includes("gif")) return "gif"; if (mimeType.includes("mp4")) return "mp4"; if (mimeType.includes("webm")) return "webm"; if (mimeType.includes("wav")) return "wav"; if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3"; return storageKey.startsWith("image:") ? "png" : "bin"; }
function emitProgress(onProgress: AppSyncProgress | undefined, event: AppSyncProgressEvent) { onProgress?.(event); }
function errorText(error: unknown) { return error instanceof Error ? error.message : i18n.t("config.webdav.errors.syncFailed"); }
function formatBytes(bytes: number) { return bytes < 1024 ? `${bytes}B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${(bytes / 1024 / 1024).toFixed(1)}MB`; }
function waitForHydration<T extends { hydrated: boolean }>(store: { getState: () => T; subscribe: (listener: (state: T) => void) => () => void }) { if (store.getState().hydrated) return Promise.resolve(); return new Promise<void>((resolve) => { const unsubscribe = store.subscribe((state) => { if (state.hydrated) { unsubscribe(); resolve(); } }); }); }
async function runWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>) { const results = new Array<R>(items.length); let next = 0; await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const index = next++; results[index] = await worker(items[index], index); } })); return results; }
