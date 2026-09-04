import localforage from "localforage";

import i18n from "@/i18n";
import { getActiveWorkspace, workspaceHeaders, workspaceStoreName } from "@/lib/workspace";
import { randomId } from "@/lib/utils";
import { getMediaBlob, resolveMediaUrl, setMediaBlob } from "@/services/file-storage";
import { getImageBlob, resolveImageUrl, setImageBlob } from "@/services/image-storage";
import { deleteWebdavPath, downloadWebdavFile, listWebdavDirectory, uploadWebdavFile, WEBDAV_MANIFEST_FILE_NAME } from "@/services/webdav-sync";
import type { Asset } from "@/stores/use-asset-store";
import { useAssetStore } from "@/stores/use-asset-store";
import type { WebdavSyncConfig } from "@/stores/use-config-store";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

type StoredLog = Record<string, unknown> & { id?: string };
export type AppSyncDomainKey = "canvas" | "assets" | "image-workbench" | "video-workbench";
type DomainKey = AppSyncDomainKey;
type CanvasDomainData = { projects: CanvasProject[] };
type AssetDomainData = { assets: Asset[] };
type LogDomainData = { logs: StoredLog[] };
type AppSyncFile = { storageKey: string; path: string; mimeType: string; bytes: number };
type DomainManifest<T> = { app: "infinite-canvas"; version: 2; workspaceId: string; snapshotId: string; domain: DomainKey; exportedAt: string; data: T; files: AppSyncFile[] };
type SnapshotComplete = { app: "infinite-canvas"; version: 2; workspaceId: string; snapshotId: string; createdAt: string; domains: DomainKey[] };
type SyncDomainOptions<T> = { key: DomainKey; label: string; localData: () => Promise<T>; emptyData: T; mergeData: (local: T, remote: T) => T; applyData?: (data: T) => Promise<void> };
type SyncDomainResult<T> = { data: T; files: number; manifestBytes: number; uploadedFiles: number; uploadedBytes: number };

export type AppSyncResult = { syncedAt: string; projects: number; assets: number; imageLogs: number; videoLogs: number; files: number; manifestBytes: number; uploadedFiles: number; uploadedBytes: number };
export type AppSyncProgressEvent = { domain?: AppSyncDomainKey; label?: string; stage: string; current?: number; total?: number; status?: "active" | "success" | "exception" };
export type AppSyncProgress = (event: AppSyncProgressEvent) => void;
export type WebdavSnapshot = { id: string; createdAt: string };

const FILE_CONCURRENCY = 3;
const SNAPSHOT_LIMIT = 30;
const storageKeyPattern = /^(image|video|audio|file|video-reference|audio-reference):/;

export async function syncAppDataToWebdav(config: WebdavSyncConfig, onProgress?: AppSyncProgress): Promise<AppSyncResult> {
    const workspace = requireWorkspace();
    const snapshotId = createSnapshotId();
    const scopedConfig = workspaceWebdavConfig(config, workspace.id);
    emitProgress(onProgress, { stage: "等待本地数据加载" });
    await Promise.all([waitForHydration(useCanvasStore), waitForHydration(useAssetStore)]);
    const [canvasOptions, assetsOptions, imageLogOptions, videoLogOptions] = domainOptions();
    const [canvas, assets, imageLogs, videoLogs] = await Promise.all([
        uploadDomain(scopedConfig, workspace.id, snapshotId, canvasOptions, onProgress),
        uploadDomain(scopedConfig, workspace.id, snapshotId, assetsOptions, onProgress),
        uploadDomain(scopedConfig, workspace.id, snapshotId, imageLogOptions, onProgress),
        uploadDomain(scopedConfig, workspace.id, snapshotId, videoLogOptions, onProgress),
    ]);
    const complete: SnapshotComplete = { app: "infinite-canvas", version: 2, workspaceId: workspace.id, snapshotId, createdAt: new Date().toISOString(), domains: ["canvas", "assets", "image-workbench", "video-workbench"] };
    emitProgress(onProgress, { stage: "完成快照", status: "active" });
    await uploadWebdavFile(scopedConfig, `snapshots/${snapshotId}/complete.json`, new Blob([JSON.stringify(complete, null, 2)], { type: "application/json" }), "application/json");
    await pruneSnapshots(scopedConfig, onProgress);
    emitProgress(onProgress, { stage: "快照已上传", status: "success" });
    return makeResult(canvas, assets, imageLogs, videoLogs);
}

export async function listWorkspaceSnapshots(config: WebdavSyncConfig): Promise<WebdavSnapshot[]> {
    const workspace = requireWorkspace();
    const scopedConfig = workspaceWebdavConfig(config, workspace.id);
    const names = await listWebdavDirectory(scopedConfig, "snapshots");
    const ids = names.filter(isSnapshotId).sort().reverse();
    const snapshots = await Promise.all(ids.map(async (id) => {
        const file = await downloadWebdavFile(scopedConfig, `snapshots/${id}/complete.json`);
        if (!file) return null;
        const complete = JSON.parse(await file.text()) as Partial<SnapshotComplete>;
        return complete.app === "infinite-canvas" && complete.version === 2 && complete.workspaceId === workspace.id && complete.snapshotId === id && complete.createdAt ? { id, createdAt: complete.createdAt } : null;
    }));
    return snapshots.filter((item): item is WebdavSnapshot => Boolean(item)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function importWorkspaceSnapshot(config: WebdavSyncConfig, snapshotId: string, onProgress?: AppSyncProgress): Promise<AppSyncResult> {
    const workspace = requireWorkspace();
    if (!isSnapshotId(snapshotId)) throw new Error("快照标识无效");
    const scopedConfig = workspaceWebdavConfig(config, workspace.id);
    emitProgress(onProgress, { stage: "等待本地数据加载" });
    await Promise.all([waitForHydration(useCanvasStore), waitForHydration(useAssetStore)]);
    const [canvasOptions, assetsOptions, imageLogOptions, videoLogOptions] = domainOptions();
    const [canvas, assets, imageLogs, videoLogs] = await Promise.all([
        importDomain(scopedConfig, workspace.id, snapshotId, canvasOptions, onProgress),
        importDomain(scopedConfig, workspace.id, snapshotId, assetsOptions, onProgress),
        importDomain(scopedConfig, workspace.id, snapshotId, imageLogOptions, onProgress),
        importDomain(scopedConfig, workspace.id, snapshotId, videoLogOptions, onProgress),
    ]);
    emitProgress(onProgress, { stage: "导入完成", status: "success" });
    return makeResult(canvas, assets, imageLogs, videoLogs);
}

function domainOptions(): [SyncDomainOptions<CanvasDomainData>, SyncDomainOptions<AssetDomainData>, SyncDomainOptions<LogDomainData>, SyncDomainOptions<LogDomainData>] {
    const imageLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: workspaceStoreName("image_generation_logs") });
    const videoLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: workspaceStoreName("video_generation_logs") });
    return [
        { key: "canvas", label: "画布", emptyData: { projects: [] }, localData: async () => ({ projects: useCanvasStore.getState().projects }), mergeData: (local, remote) => ({ projects: mergeImportedById(local.projects, remote.projects) }), applyData: async (data) => useCanvasStore.getState().replaceProjects(data.projects) },
        { key: "assets", label: "我的素材", emptyData: { assets: [] }, localData: async () => ({ assets: useAssetStore.getState().assets }), mergeData: (local, remote) => ({ assets: mergeImportedById(local.assets, remote.assets) }), applyData: async (data) => useAssetStore.getState().replaceAssets(await Promise.all(data.assets.map(hydrateAsset))) },
        { key: "image-workbench", label: "生图工作台", emptyData: { logs: [] }, localData: async () => ({ logs: await readStoredLogs(imageLogStore) }), mergeData: (local, remote) => ({ logs: mergeImportedById(local.logs, remote.logs) }), applyData: async (data) => replaceStoredLogs(imageLogStore, data.logs) },
        { key: "video-workbench", label: "视频创作台", emptyData: { logs: [] }, localData: async () => ({ logs: await readStoredLogs(videoLogStore) }), mergeData: (local, remote) => ({ logs: mergeImportedById(local.logs, remote.logs) }), applyData: async (data) => replaceStoredLogs(videoLogStore, data.logs) },
    ];
}

async function uploadDomain<T>(config: WebdavSyncConfig, workspaceId: string, snapshotId: string, options: SyncDomainOptions<T>, onProgress?: AppSyncProgress): Promise<SyncDomainResult<T>> {
    try {
        emitProgress(onProgress, { domain: options.key, label: options.label, stage: "读取本地数据", status: "active" });
        const data = await options.localData();
        const uploaded = await uploadLocalFiles(config, options.key, data, onProgress);
        const manifest: DomainManifest<T> = { app: "infinite-canvas", version: 2, workspaceId, snapshotId, domain: options.key, exportedAt: new Date().toISOString(), data, files: uploaded.files };
        const manifestFile = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
        emitProgress(onProgress, { domain: options.key, label: options.label, stage: `上传快照清单 ${formatBytes(manifestFile.size)}`, status: "active" });
        await uploadWebdavFile(config, `snapshots/${snapshotId}/${options.key}/${WEBDAV_MANIFEST_FILE_NAME}`, manifestFile, "application/json");
        emitProgress(onProgress, { domain: options.key, label: options.label, stage: "完成", current: 1, total: 1, status: "success" });
        return { data, files: uploaded.files.length, manifestBytes: manifestFile.size, uploadedFiles: uploaded.uploadedFiles, uploadedBytes: uploaded.uploadedBytes };
    } catch (error) {
        emitProgress(onProgress, { domain: options.key, label: options.label, stage: errorText(error), status: "exception" });
        throw error;
    }
}

async function importDomain<T>(config: WebdavSyncConfig, workspaceId: string, snapshotId: string, options: SyncDomainOptions<T>, onProgress?: AppSyncProgress): Promise<SyncDomainResult<T>> {
    try {
        emitProgress(onProgress, { domain: options.key, label: options.label, stage: "读取远端快照", status: "active" });
        const remote = await readDomainManifest(config, workspaceId, snapshotId, options.key, options.emptyData);
        emitProgress(onProgress, { domain: options.key, label: options.label, stage: "读取本地数据", status: "active" });
        const local = await options.localData();
        const data = options.mergeData(local, remote.data);
        await downloadMissingFiles(config, options.key, data, remote.files, onProgress);
        emitProgress(onProgress, { domain: options.key, label: options.label, stage: "写入导入数据", status: "active" });
        await options.applyData?.(data);
        emitProgress(onProgress, { domain: options.key, label: options.label, stage: "完成", current: 1, total: 1, status: "success" });
        return { data, files: remote.files.length, manifestBytes: 0, uploadedFiles: 0, uploadedBytes: 0 };
    } catch (error) {
        emitProgress(onProgress, { domain: options.key, label: options.label, stage: errorText(error), status: "exception" });
        throw error;
    }
}

async function readDomainManifest<T>(config: WebdavSyncConfig, workspaceId: string, snapshotId: string, domain: DomainKey, emptyData: T) {
    const file = await downloadWebdavFile(config, `snapshots/${snapshotId}/${domain}/${WEBDAV_MANIFEST_FILE_NAME}`);
    if (!file) throw new Error(`快照缺少${domainLabel(domain)}数据`);
    const manifest = JSON.parse(await file.text()) as Partial<DomainManifest<T>>;
    if (manifest.app !== "infinite-canvas" || manifest.version !== 2 || manifest.workspaceId !== workspaceId || manifest.snapshotId !== snapshotId || manifest.domain !== domain) throw new Error(i18n.t("config.webdav.errors.invalidManifest", { domain }));
    return { data: manifest.data || emptyData, files: Array.isArray(manifest.files) ? manifest.files : [] };
}

async function uploadLocalFiles<T>(config: WebdavSyncConfig, domain: DomainKey, data: T, onProgress?: AppSyncProgress) {
    const keys = collectStorageKeys(data);
    const files: AppSyncFile[] = [];
    let uploadedFiles = 0;
    let uploadedBytes = 0;
    await runWithConcurrency(keys, FILE_CONCURRENCY, async (storageKey, index) => {
        const blob = storageKey.startsWith("image:") ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
        if (!blob) return;
        const item = { storageKey, path: `files/${safeFileName(storageKey)}.${fileExtension(blob.type, storageKey)}`, mimeType: blob.type || "application/octet-stream", bytes: blob.size };
        await uploadWebdavFile(config, item.path, blob, item.mimeType);
        files.push(item);
        uploadedFiles += 1;
        uploadedBytes += blob.size;
        emitProgress(onProgress, { domain, label: domainLabel(domain), stage: `上传媒体 ${formatBytes(blob.size)}`, current: index + 1, total: keys.length, status: "active" });
    });
    if (files.length) {
        await fetch("/api/media", { method: "POST", headers: { "content-type": "application/json", ...workspaceHeaders() }, body: JSON.stringify({ files: files.map((file) => ({ storageKey: file.storageKey, remotePath: `${workspaceDirectory(config)}/${file.path}`, mimeType: file.mimeType, bytes: file.bytes })) }) }).catch(() => undefined);
    }
    return { files, uploadedFiles, uploadedBytes };
}

function workspaceDirectory(config: WebdavSyncConfig) {
    return config.directory.replace(/^\/+|\/+$/g, "");
}

async function downloadMissingFiles<T>(config: WebdavSyncConfig, domain: DomainKey, data: T, remoteFiles: AppSyncFile[], onProgress?: AppSyncProgress) {
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
        emitProgress(onProgress, { domain, label: domainLabel(domain), stage: "下载导入媒体", current: index + 1, total: tasks.length, status: "active" });
    });
}

async function pruneSnapshots(config: WebdavSyncConfig, onProgress?: AppSyncProgress) {
    const snapshots = (await listWebdavDirectory(config, "snapshots")).filter(isSnapshotId).sort().reverse();
    await Promise.all(snapshots.slice(SNAPSHOT_LIMIT).map((id) => deleteWebdavPath(config, `snapshots/${id}`)));
    if (snapshots.length > SNAPSHOT_LIMIT) emitProgress(onProgress, { stage: `已清理 ${snapshots.length - SNAPSHOT_LIMIT} 个旧快照` });
}

function requireWorkspace() { const workspace = getActiveWorkspace(); if (!workspace) throw new Error("请先选择工作区"); return workspace; }
function workspaceWebdavConfig(config: WebdavSyncConfig, workspaceId: string) { return { ...config, directory: ["workspaces", workspaceId].join("/") }; }
function createSnapshotId() { return `${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${randomId().slice(0, 8)}`; }
function isSnapshotId(value: string) { return /^\d{8}T\d{6}Z-[A-Za-z0-9_-]{8}$/.test(value); }
function makeResult(canvas: SyncDomainResult<CanvasDomainData>, assets: SyncDomainResult<AssetDomainData>, imageLogs: SyncDomainResult<LogDomainData>, videoLogs: SyncDomainResult<LogDomainData>): AppSyncResult { return { syncedAt: new Date().toISOString(), projects: canvas.data.projects.length, assets: assets.data.assets.length, imageLogs: imageLogs.data.logs.length, videoLogs: videoLogs.data.logs.length, files: canvas.files + assets.files + imageLogs.files + videoLogs.files, manifestBytes: canvas.manifestBytes + assets.manifestBytes + imageLogs.manifestBytes + videoLogs.manifestBytes, uploadedFiles: canvas.uploadedFiles + assets.uploadedFiles + imageLogs.uploadedFiles + videoLogs.uploadedFiles, uploadedBytes: canvas.uploadedBytes + assets.uploadedBytes + imageLogs.uploadedBytes + videoLogs.uploadedBytes }; }

async function hydrateAsset(asset: Asset): Promise<Asset> {
    if (asset.kind === "image" && asset.data.storageKey) { const dataUrl = await resolveImageUrl(asset.data.storageKey, asset.data.dataUrl); return { ...asset, coverUrl: asset.coverUrl.startsWith("blob:") ? dataUrl : asset.coverUrl, data: { ...asset.data, dataUrl } }; }
    if (asset.kind === "video" && asset.data.storageKey) { const url = await resolveMediaUrl(asset.data.storageKey, asset.data.url); return { ...asset, coverUrl: asset.coverUrl.startsWith("blob:") ? url : asset.coverUrl, data: { ...asset.data, url } }; }
    return asset;
}

type LogStore = ReturnType<typeof localforage.createInstance>;
async function readStoredLogs(store: LogStore) { const logs: StoredLog[] = []; await store.iterate<StoredLog, void>((value) => { if (value && typeof value === "object") logs.push(value); }); return logs; }
async function replaceStoredLogs(store: LogStore, logs: StoredLog[]) { await store.clear(); await runWithConcurrency(logs, FILE_CONCURRENCY, async (log) => { if (log.id) await store.setItem(log.id, log); }); }
function mergeImportedById<T extends { id?: string }>(local: T[], remote: T[]) { const items = new Map(remote.filter((item) => item.id).map((item) => [item.id!, item])); local.forEach((item) => { if (item.id) items.set(item.id, item); }); return [...items.values()]; }
function collectStorageKeys(value: unknown, keys = new Set<string>()): string[] { if (typeof value === "string") { if (storageKeyPattern.test(value)) keys.add(value); return [...keys]; } if (!value || typeof value !== "object") return [...keys]; if ("storageKey" in value && typeof value.storageKey === "string" && storageKeyPattern.test(value.storageKey)) keys.add(value.storageKey); Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectStorageKeys(child, keys)) : collectStorageKeys(item, keys))); return [...keys]; }
function domainLabel(domain: DomainKey) { return domain === "canvas" ? "画布" : domain === "assets" ? "我的素材" : domain === "image-workbench" ? "生图工作台" : "视频创作台"; }
function safeFileName(value: string) { return value.replace(/[\\/:*?"<>|]/g, "_"); }
function fileExtension(mimeType: string, storageKey: string) { if (mimeType.includes("png")) return "png"; if (mimeType.includes("jpeg")) return "jpg"; if (mimeType.includes("webp")) return "webp"; if (mimeType.includes("gif")) return "gif"; if (mimeType.includes("mp4")) return "mp4"; if (mimeType.includes("webm")) return "webm"; if (mimeType.includes("wav")) return "wav"; if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3"; return storageKey.startsWith("image:") ? "png" : "bin"; }
function emitProgress(onProgress: AppSyncProgress | undefined, event: AppSyncProgressEvent) { onProgress?.(event); }
function errorText(error: unknown) { return error instanceof Error ? error.message : i18n.t("config.webdav.errors.syncFailed"); }
function formatBytes(bytes: number) { return bytes < 1024 ? `${bytes}B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${(bytes / 1024 / 1024).toFixed(1)}MB`; }
function waitForHydration<T extends { hydrated: boolean }>(store: { getState: () => T; subscribe: (listener: (state: T) => void) => () => void }) { if (store.getState().hydrated) return Promise.resolve(); return new Promise<void>((resolve) => { const unsubscribe = store.subscribe((state) => { if (state.hydrated) { unsubscribe(); resolve(); } }); }); }
async function runWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>) { const results = new Array<R>(items.length); let next = 0; await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const index = next++; results[index] = await worker(items[index], index); } })); return results; }
