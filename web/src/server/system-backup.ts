import { createHash, randomUUID } from "node:crypto";
import { Transform } from "node:stream";

import { execute, getPool, isoNow, queryMany, queryOne, toIso, withReadSnapshot, withTransaction, type SqlExecutor } from "./db";
import { MEDIA_REFERENCE_DOMAINS, extractMediaReferences, MediaReferenceError } from "./media-references";
import { getMediaObject, mediaObjectKey } from "./object-storage";
import { deleteWebdavPath, ensureWebdavDirectory, getWebdavStream, listWebdavDirectory, putWebdavBuffer, putWebdavStream, readServerWebdavConfig, testWebdavConnection, webdavContentLength, webdavExists, type WebdavConfig } from "./webdav-client";

export const SYSTEM_BACKUP_ROOT = "system-backups";
export const BACKUP_DOMAIN_KEYS = [...MEDIA_REFERENCE_DOMAINS];
export type BackupDomain = (typeof BACKUP_DOMAIN_KEYS)[number];
export type BackupPurpose = "manual" | "scheduled" | "pre-restore";
export type BackupRunStatus = "running" | "succeeded" | "partial" | "failed" | "cancelled";
export type SnapshotSource = "snapshots" | "safety";

export const EMPTY_DOMAIN_PAYLOADS: Record<BackupDomain, unknown> = {
    canvas: { version: 0, state: { projects: [], folders: [], deletedProjects: [] } },
    "canvas-templates": { version: 1, templates: [] },
    assets: { version: 0, state: { assets: [] } },
    "image-workbench": { logs: [] },
    "video-workbench": { logs: [] },
    "agent-sessions": { version: 1, sessions: [] },
};

const DEFAULT_SETTINGS: BackupSettings = { enabled: false, intervalMinutes: 1440, retention: 30, safetyRetention: 5 };
const MIN_INTERVAL_MINUTES = 60;
const MAX_INTERVAL_MINUTES = 10080;
const MAX_RETENTION = 100;
const MAX_SAFETY_RETENTION = 20;
const STALE_INTENT_MINUTES = 30;
const HEARTBEAT_MS = 60_000;
const SNAPSHOT_ID = /^\d{8}T\d{6}Z-[a-z0-9]{8}$/;

export type BackupSettings = { enabled: boolean; intervalMinutes: number; retention: number; safetyRetention: number };
export type ManifestFileRef = { path: string; sha256: string; bytes: number };
export type ManifestMedia = { storageKey: string; objectVersion: string; objectPath: string; mimeType: string; bytes: number; sha256: string; createdAt: string; updatedAt: string; lifecycleState: string; missing?: boolean };
export type ManifestPrompt = { id: string; title: string; prompt: string; description: string; tags: string[]; shared: boolean; createdAt: string; updatedAt: string };
export type ManifestPromptImage = { promptId: string; objectPath: string; mimeType: string; bytes: number; sha256: string };
export type WorkspaceManifest = {
    id: string; name: string; ownerUserId: string | null; createdAt: string; updatedAt: string;
    status: "complete" | "incomplete"; errors: string[];
    domains: Record<string, { present: boolean; revision: number; updatedAt: string | null; updatedBy: string | null; file: ManifestFileRef }>;
    prompts: { file: ManifestFileRef; count: number };
    media: { file: ManifestFileRef; count: number; bytes: number; externalMedia: number };
    promptImages: { file: ManifestFileRef; count: number; bytes: number };
};
export type BackupManifest = {
    app: "infinite-canvas"; version: 1; kind: "system-backup"; purpose: BackupPurpose; backupId: string;
    createdAt: string; completedAt: string; status: "complete" | "partial";
    totals: { workspaces: number; complete: number; media: number; mediaBytes: number; promptImages: number; promptImageBytes: number };
    workspaces: WorkspaceManifest[];
};
export type BackupProgress = { phase: string; workspaceId?: string; workspaceName?: string; current: number; total: number; uploadedFiles: number; uploadedBytes: number; message?: string };
export type BackupRunSummary = { backupId?: string; workspaces?: number; complete?: number; media?: number; mediaBytes?: number; warnings?: string[]; restoredWorkspaceId?: string };
export type BackupRunRecord = { id: string; kind: "backup" | "restore"; purpose: BackupPurpose; status: BackupRunStatus; backupId: string | null; workspaceId: string | null; startedAt: string; finishedAt: string | null; summary: BackupRunSummary | null; error: string | null };
export type SnapshotSummary = { id: string; source: SnapshotSource; purpose: BackupPurpose; createdAt: string; status: "complete" | "partial"; workspaces: number; complete: number; mediaBytes: number };

export class SystemBackupError extends Error {
    constructor(message: string, public status = 400) {
        super(message);
    }
}

type WorkspaceRow = { id: string; name: string; owner_user_id: string | null; created_at: Date; updated_at: Date };
type DomainRow = { domain: string; payload: string; revision: number; updated_at: Date; updated_by: string };
type MediaRow = { storage_key: string; object_version: string; remote_path: string; mime_type: string; bytes: string; lifecycle_state: string; created_at: Date; updated_at: Date; content_sha256: string };
type PromptRow = { id: string; workspace_id: string; title: string; prompt: string; description: string; tags: string; shared: boolean; created_at: Date; updated_at: Date; has_image: boolean };
type PromptImageRow = { prompt_id: string; mime_type: string; image: Buffer };
type RunRow = { id: string; kind: "backup" | "restore"; purpose: BackupPurpose; status: BackupRunStatus; backup_id: string | null; workspace_id: string | null; started_at: Date; finished_at: Date | null; summary: BackupRunSummary | null; error: string | null };
type ActiveTask = { runId: string; kind: "backup" | "restore"; startedAt: string; cancelled: boolean; progress: BackupProgress };
type SnapshotResult = { backupId: string; source: SnapshotSource; manifest: BackupManifest };

let activeTask: ActiveTask | null = null;
let taskStarting = false;
let heartbeatTimer: NodeJS.Timeout | null = null;
let schedulerTimer: NodeJS.Timeout | null = null;
let initialized = false;

export function getActiveBackupTask() {
    return activeTask;
}

export function assertBackupTaskActive() {
    if (!activeTask) throw new SystemBackupError("没有正在执行的备份任务", 409);
    if (activeTask.cancelled) throw new SystemBackupError("任务已取消", 409);
    return activeTask;
}

export function setBackupProgress(patch: Partial<BackupProgress>) {
    if (!activeTask) return;
    activeTask.progress = { ...activeTask.progress, ...patch };
}

export async function beginBackupTask(kind: ActiveTask["kind"], purpose: BackupPurpose, actorUserId: string | null, workspaceId: string | null = null) {
    if (activeTask || taskStarting) throw new SystemBackupError("已有备份或恢复任务正在执行", 409);
    taskStarting = true;
    try {
        const db = await getPool();
        const runId = randomUUID();
        const now = isoNow();
        await execute(db, `INSERT INTO backup_runs (id, kind, purpose, status, workspace_id, actor_user_id, started_at, heartbeat_at)
            VALUES ($1, $2, $3, 'running', $4, $5, $6, $6)`, runId, kind, purpose, workspaceId, actorUserId, now);
        activeTask = { runId, kind, startedAt: now, cancelled: false, progress: { phase: "preparing", current: 0, total: 0, uploadedFiles: 0, uploadedBytes: 0 } };
        heartbeatTimer = setInterval(() => {
            void execute(db, "UPDATE backup_runs SET heartbeat_at = now() WHERE id = $1 AND status = 'running'", runId).catch(() => undefined);
        }, HEARTBEAT_MS);
        heartbeatTimer.unref?.();
        return runId;
    } finally {
        taskStarting = false;
    }
}

export async function finishBackupTask(runId: string, status: Exclude<BackupRunStatus, "running">, summary?: BackupRunSummary, error?: string) {
    const db = await getPool();
    await execute(db, "UPDATE backup_runs SET status = $2, finished_at = now(), summary = $3::jsonb, error = $4, backup_id = COALESCE($5, backup_id) WHERE id = $1 AND status = 'running'", runId, status, summary ? JSON.stringify(summary) : null, error || null, summary?.backupId || null).catch(() => undefined);
    if (activeTask?.runId === runId) activeTask = null;
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}

export function cancelBackupTask() {
    if (!activeTask) return false;
    activeTask.cancelled = true;
    setBackupProgress({ message: "正在取消任务" });
    return true;
}

export async function readBackupSettings(db?: SqlExecutor): Promise<BackupSettings> {
    const row = await queryOne<{ enabled: boolean; interval_minutes: number; retention: number; safety_retention: number }>(db || await getPool(), "SELECT enabled, interval_minutes, retention, safety_retention FROM backup_settings WHERE id = 'default'");
    return row ? { enabled: row.enabled, intervalMinutes: row.interval_minutes, retention: row.retention, safetyRetention: row.safety_retention } : { ...DEFAULT_SETTINGS };
}

export async function saveBackupSettings(input: unknown) {
    const body = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const enabled = body.enabled;
    const intervalMinutes = typeof body.intervalMinutes === "number" ? body.intervalMinutes : NaN;
    const retention = typeof body.retention === "number" ? body.retention : NaN;
    const safetyRetention = typeof body.safetyRetention === "number" ? body.safetyRetention : NaN;
    if (typeof enabled !== "boolean" || !Number.isInteger(intervalMinutes) || intervalMinutes < MIN_INTERVAL_MINUTES || intervalMinutes > MAX_INTERVAL_MINUTES || !Number.isInteger(retention) || retention < 1 || retention > MAX_RETENTION || !Number.isInteger(safetyRetention) || safetyRetention < 1 || safetyRetention > MAX_SAFETY_RETENTION) {
        throw new SystemBackupError("备份设置无效");
    }
    const db = await getPool();
    await execute(db, `INSERT INTO backup_settings (id, enabled, interval_minutes, retention, safety_retention, updated_at)
        VALUES ('default', $1, $2, $3, $4, now()) ON CONFLICT (id) DO UPDATE SET enabled = excluded.enabled, interval_minutes = excluded.interval_minutes, retention = excluded.retention, safety_retention = excluded.safety_retention, updated_at = now()`,
    enabled, intervalMinutes, retention, safetyRetention);
    return readBackupSettings(db);
}

export async function getBackupStatus() {
    let configured = false;
    try { readServerWebdavConfig(); configured = true; } catch { configured = false; }
    const db = await getPool();
    const settings = await readBackupSettings(db);
    const last = await queryOne<RunRow>(db, "SELECT * FROM backup_runs ORDER BY started_at DESC LIMIT 1");
    return {
        configured,
        settings,
        active: activeTask ? { runId: activeTask.runId, kind: activeTask.kind, startedAt: activeTask.startedAt, progress: activeTask.progress } : null,
        lastRun: last ? mapRun(last) : null,
    };
}

export async function listBackupRuns(limit = 20) {
    return (await queryMany<RunRow>(await getPool(), "SELECT * FROM backup_runs ORDER BY started_at DESC LIMIT $1", Math.min(Math.max(limit, 1), 100))).map(mapRun);
}

export async function startBackupTask(actorUserId: string | null, purpose: BackupPurpose = "manual") {
    const config = requireWebdavConfig();
    const db = await getPool();
    const workspaces = await queryMany<WorkspaceRow>(db, "SELECT id, name, owner_user_id, created_at, updated_at FROM workspaces ORDER BY id");
    const runId = await beginBackupTask("backup", purpose, actorUserId);
    void performBackup(runId, config, workspaces, purpose).catch((error) => settleBackupTaskFailure(runId, error));
    return runId;
}

export async function createSafetySnapshot(config: WebdavConfig, workspaceId: string, settings: BackupSettings, preserveIds: string[] = []) {
    const db = await getPool();
    const workspace = await queryOne<WorkspaceRow>(db, "SELECT id, name, owner_user_id, created_at, updated_at FROM workspaces WHERE id = $1", workspaceId);
    if (!workspace) throw new SystemBackupError("工作区不存在", 404);
    const result = await snapshotWorkspaces(config, [workspace], "pre-restore", settings, preserveIds);
    if (result.manifest.status !== "complete") throw new SystemBackupError("恢复前安全快照不完整，已中止恢复", 409);
    return result;
}

async function performBackup(runId: string, config: WebdavConfig, workspaces: WorkspaceRow[], purpose: BackupPurpose) {
    try {
        const settings = await readBackupSettings();
        const result = await snapshotWorkspaces(config, workspaces, purpose, settings);
        const status = result.manifest.status === "complete" ? "succeeded" : "partial";
        await finishBackupTask(runId, status, {
            backupId: result.backupId,
            workspaces: result.manifest.totals.workspaces,
            complete: result.manifest.totals.complete,
            media: result.manifest.totals.media,
            mediaBytes: result.manifest.totals.mediaBytes,
        });
    } catch (error) {
        await settleBackupTaskFailure(runId, error);
    }
}

export async function settleBackupTaskFailure(runId: string, error: unknown) {
    const cancelled = activeTask?.cancelled || (error instanceof Error && error.message === "任务已取消");
    await finishBackupTask(runId, cancelled ? "cancelled" : "failed", undefined, error instanceof Error ? error.message : String(error));
}

async function snapshotWorkspaces(config: WebdavConfig, workspaces: WorkspaceRow[], purpose: BackupPurpose, settings: BackupSettings, preserveIds: string[] = []): Promise<SnapshotResult> {
    const backupId = createSnapshotId();
    const source = sourceForPurpose(purpose);
    setBackupProgress({ phase: purpose === "pre-restore" ? "pre-restore" : "backup", current: 0, total: workspaces.length, uploadedFiles: 0, uploadedBytes: 0 });
    const entries: WorkspaceManifest[] = [];
    for (let index = 0; index < workspaces.length; index += 1) {
        assertBackupTaskActive();
        const workspace = workspaces[index];
        setBackupProgress({ workspaceId: workspace.id, workspaceName: workspace.name, current: index });
        entries.push(await backupWorkspace(config, workspace, source, backupId));
    }
    assertBackupTaskActive();
    const totals = {
        workspaces: entries.length,
        complete: entries.filter((entry) => entry.status === "complete").length,
        media: entries.reduce((sum, entry) => sum + entry.media.count, 0),
        mediaBytes: entries.reduce((sum, entry) => sum + entry.media.bytes, 0),
        promptImages: entries.reduce((sum, entry) => sum + entry.promptImages.count, 0),
        promptImageBytes: entries.reduce((sum, entry) => sum + entry.promptImages.bytes, 0),
    };
    const manifest: BackupManifest = {
        app: "infinite-canvas", version: 1, kind: "system-backup", purpose, backupId,
        createdAt: isoNow(), completedAt: isoNow(), status: entries.every((entry) => entry.status === "complete") ? "complete" : "partial",
        totals, workspaces: entries,
    };
    const manifestPath = `${snapshotBase(source, backupId)}/manifest.json`;
    await putJson(config, manifestPath, manifest, "manifest.json");
    if (source === "snapshots") await pruneSnapshots(config, source, settings.retention, backupId, preserveIds);
    else await pruneSnapshots(config, source, settings.safetyRetention, backupId, preserveIds);
    setBackupProgress({ current: workspaces.length });
    return { backupId, source, manifest };
}

async function backupWorkspace(config: WebdavConfig, workspace: WorkspaceRow, source: SnapshotSource, backupId: string): Promise<WorkspaceManifest> {
    const errors: string[] = [];
    const snapshot = await withReadSnapshot(async (tx) => {
        const domains = await queryMany<DomainRow>(tx, "SELECT domain, payload, revision, updated_at, updated_by FROM workspace_data WHERE workspace_id = $1 ORDER BY domain", workspace.id);
        const media = await queryMany<MediaRow>(tx, "SELECT storage_key, object_version, remote_path, mime_type, bytes, lifecycle_state, created_at, updated_at, content_sha256 FROM media_files WHERE workspace_id = $1 ORDER BY storage_key", workspace.id);
        const prompts = await queryMany<PromptRow>(tx, "SELECT p.id, p.workspace_id, p.title, p.prompt, p.description, p.tags, p.shared, p.created_at, p.updated_at, EXISTS(SELECT 1 FROM workspace_prompt_images i WHERE i.prompt_id = p.id) AS has_image FROM workspace_prompts p WHERE p.workspace_id = $1 ORDER BY p.id", workspace.id);
        return { domains, media, prompts };
    });
    const domainRows = new Map(snapshot.domains.map((row) => [row.domain, row]));
    const referenced = new Set<string>();
    const domains: WorkspaceManifest["domains"] = {};
    for (const domain of BACKUP_DOMAIN_KEYS) {
        const row = domainRows.get(domain);
        const payloadText = row?.payload || JSON.stringify(EMPTY_DOMAIN_PAYLOADS[domain]) || "null";
        if (row) {
            try {
                const refs = extractMediaReferences(domain, JSON.parse(row.payload));
                refs.forEach((ref) => referenced.add(ref.storageKey));
            } catch (error) {
                errors.push(`${domain}: ${error instanceof MediaReferenceError ? error.message : "数据格式无效"}`);
            }
        }
        const path = `workspaces/${workspace.id}/data/${domain}.json`;
        domains[domain] = {
            present: Boolean(row),
            revision: row?.revision || 0,
            updatedAt: row ? toIso(row.updated_at) : null,
            updatedBy: row?.updated_by || null,
            file: await putJsonText(config, `${snapshotBase(source, backupId)}/${path}`, payloadText, path),
        };
    }
    for (const row of snapshot.domains) {
        if (!BACKUP_DOMAIN_KEYS.includes(row.domain as BackupDomain)) errors.push(`未知数据域: ${row.domain}`);
    }
    const mediaByKey = new Map(snapshot.media.map((row) => [row.storage_key, row]));
    for (const storageKey of referenced) {
        const row = mediaByKey.get(storageKey);
        if (!row) errors.push(`媒体引用 ${storageKey} 不存在`);
        else if (row.remote_path) errors.push(`媒体引用 ${storageKey} 只存在于旧外部快照`);
    }
    const mediaEntries: ManifestMedia[] = [];
    let externalMedia = 0;
    let mediaBytes = 0;
    const existingMedia = await listExistingObjects(config, `${SYSTEM_BACKUP_ROOT}/objects/${workspace.id}/media`).catch(() => null);
    for (const row of snapshot.media) {
        assertBackupTaskActive();
        if (row.remote_path) {
            externalMedia += 1;
            continue;
        }
        const name = mediaObjectName(row.storage_key, row.object_version);
        const objectPath = `objects/${workspace.id}/media/${name}`;
        let sha256 = row.content_sha256;
        let bytes = Number(row.bytes);
        try {
            const existingLength = existingMedia?.has(name) ? await webdavContentLength(config, `${SYSTEM_BACKUP_ROOT}/${objectPath}`).catch(() => null) : null;
            if (existingLength === bytes) {
                if (!sha256) sha256 = await hashMediaObject(workspace.id, row);
            } else {
                const object = await getMediaObject(mediaObjectKey(workspace.id, row.storage_key, row.object_version));
                const actualBytes = object.contentLength ?? bytes;
                if (actualBytes !== bytes) errors.push(`媒体 ${row.storage_key} 大小与索引不一致`);
                const hash = createHash("sha256");
                const hasher = new Transform({ transform(chunk: Buffer, _encoding, callback) { hash.update(chunk); callback(null, chunk); } });
                await putWebdavStream(config, `${SYSTEM_BACKUP_ROOT}/${objectPath}`, object.body.pipe(hasher), row.mime_type || "application/octet-stream", actualBytes);
                sha256 = hash.digest("hex");
                bytes = actualBytes;
                setBackupProgress({ uploadedFiles: (activeTask?.progress.uploadedFiles || 0) + 1, uploadedBytes: (activeTask?.progress.uploadedBytes || 0) + bytes });
            }
            if (!sha256) sha256 = await hashMediaObject(workspace.id, row);
            if (!row.object_version) {
                const current = await queryOne<{ updated_at: Date; bytes: string }>(await getPool(), "SELECT updated_at, bytes FROM media_files WHERE workspace_id = $1 AND storage_key = $2", workspace.id, row.storage_key);
                if (!current || toIso(current.updated_at) !== toIso(row.updated_at) || Number(current.bytes) !== bytes) errors.push(`媒体 ${row.storage_key} 在备份期间被修改`);
            }
        } catch (error) {
            errors.push(`媒体 ${row.storage_key}: ${error instanceof Error ? error.message : "导出失败"}`);
            mediaEntries.push({ storageKey: row.storage_key, objectVersion: row.object_version, objectPath, mimeType: row.mime_type, bytes, sha256, createdAt: toIso(row.created_at), updatedAt: toIso(row.updated_at), lifecycleState: row.lifecycle_state, missing: true });
            continue;
        }
        mediaEntries.push({ storageKey: row.storage_key, objectVersion: row.object_version, objectPath, mimeType: row.mime_type, bytes, sha256, createdAt: toIso(row.created_at), updatedAt: toIso(row.updated_at), lifecycleState: row.lifecycle_state });
        mediaBytes += bytes;
    }
    const mediaFile = await putJson(config, `${snapshotBase(source, backupId)}/workspaces/${workspace.id}/media.json`, mediaEntries, `workspaces/${workspace.id}/media.json`);
    const prompts: ManifestPrompt[] = [];
    for (const row of snapshot.prompts) {
        try {
            prompts.push({ id: row.id, title: row.title, prompt: row.prompt, description: row.description, tags: JSON.parse(row.tags) as string[], shared: row.shared, createdAt: toIso(row.created_at), updatedAt: toIso(row.updated_at) });
        } catch {
            errors.push(`提示词 ${row.id} 标签格式无效`);
        }
    }
    const promptsFile = await putJson(config, `${snapshotBase(source, backupId)}/workspaces/${workspace.id}/prompts.json`, prompts, `workspaces/${workspace.id}/prompts.json`);
    const promptImages = await backupPromptImages(config, workspace.id, snapshot.prompts, errors);
    const promptImagesFile = await putJson(config, `${snapshotBase(source, backupId)}/workspaces/${workspace.id}/prompt-images.json`, promptImages, `workspaces/${workspace.id}/prompt-images.json`);
    return {
        id: workspace.id,
        name: workspace.name,
        ownerUserId: workspace.owner_user_id,
        createdAt: toIso(workspace.created_at),
        updatedAt: toIso(workspace.updated_at),
        status: errors.length ? "incomplete" : "complete",
        errors,
        domains,
        prompts: { file: promptsFile, count: prompts.length },
        media: { file: mediaFile, count: mediaEntries.filter((entry) => !entry.missing).length, bytes: mediaBytes, externalMedia },
        promptImages: { file: promptImagesFile, count: promptImages.length, bytes: promptImages.reduce((sum, item) => sum + item.bytes, 0) },
    };
}

async function backupPromptImages(config: WebdavConfig, workspaceId: string, prompts: PromptRow[], errors: string[]) {
    const entries: ManifestPromptImage[] = [];
    let existing: Set<string> | null = null;
    for (const prompt of prompts) {
        assertBackupTaskActive();
        const image = await queryOne<PromptImageRow>(await getPool(), "SELECT prompt_id, mime_type, image FROM workspace_prompt_images WHERE prompt_id = $1", prompt.id);
        if (!image) {
            if (prompt.has_image) errors.push(`提示词 ${prompt.id} 的示例图在备份期间被删除`);
            continue;
        }
        const buffer = Buffer.from(image.image);
        const name = promptImageName(prompt.id, buffer);
        const objectPath = `objects/${workspaceId}/prompts/${name}`;
        existing ||= await listExistingObjects(config, `${SYSTEM_BACKUP_ROOT}/objects/${workspaceId}/prompts`).catch(() => null);
        const existingLength = existing?.has(name) ? await webdavContentLength(config, `${SYSTEM_BACKUP_ROOT}/${objectPath}`).catch(() => null) : null;
        if (existingLength !== buffer.length) await putWebdavBuffer(config, `${SYSTEM_BACKUP_ROOT}/${objectPath}`, buffer, image.mime_type || "application/octet-stream");
        const current = await queryOne<{ updated_at: Date }>(await getPool(), "SELECT updated_at FROM workspace_prompts WHERE id = $1 AND workspace_id = $2", prompt.id, workspaceId);
        if (!current || toIso(current.updated_at) !== toIso(prompt.updated_at)) { errors.push(`提示词 ${prompt.id} 在备份期间被修改`); continue; }
        entries.push({ promptId: prompt.id, objectPath, mimeType: image.mime_type || "application/octet-stream", bytes: buffer.length, sha256: sha256Hex(buffer) });
    }
    return entries;
}

async function listExistingObjects(config: WebdavConfig, path: string) {
    const values = await listWebdavDirectory(config, path);
    return new Set(values);
}

async function hashMediaObject(workspaceId: string, row: MediaRow) {
    const object = await getMediaObject(mediaObjectKey(workspaceId, row.storage_key, row.object_version));
    const hash = createHash("sha256");
    for await (const chunk of object.body) hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return hash.digest("hex");
}

function mediaObjectName(storageKey: string, objectVersion: string) {
    return `${sha256Hex(storageKey)}-${objectVersion || "legacy"}`;
}

function promptImageName(promptId: string, image: Buffer) {
    return `${sha256Hex(promptId)}-${sha256Hex(image)}`;
}

async function putJson(config: WebdavConfig, path: string, value: unknown, relativePath: string) {
    return putJsonText(config, path, JSON.stringify(value, null, 2) || "null", relativePath);
}

async function putJsonText(config: WebdavConfig, path: string, text: string, relativePath: string) {
    const buffer = Buffer.from(text);
    await ensureWebdavDirectory(config, parentPath(path));
    await putWebdavBuffer(config, path, buffer, "application/json");
    return { path: relativePath, sha256: sha256Hex(buffer), bytes: buffer.length } satisfies ManifestFileRef;
}

function parentPath(path: string) {
    return path.replace(/^\/+|\/+$/g, "").split("/").slice(0, -1).join("/");
}

export function snapshotBase(source: SnapshotSource, backupId: string) {
    return `${SYSTEM_BACKUP_ROOT}/${source}/${backupId}`;
}

export function snapshotFilePath(source: SnapshotSource, backupId: string, relativePath: string) {
    return `${snapshotBase(source, backupId)}/${relativePath}`;
}

export function objectFilePath(relativePath: string) {
    return `${SYSTEM_BACKUP_ROOT}/${relativePath}`;
}

export async function readBackupManifest(config: WebdavConfig, source: SnapshotSource, backupId: string): Promise<BackupManifest> {
    if (!isSnapshotId(backupId)) throw new SystemBackupError("备份标识无效");
    const buffer = await readWebdavBuffer(config, `${snapshotBase(source, backupId)}/manifest.json`);
    if (!buffer) throw new SystemBackupError("备份清单不存在", 404);
    const manifest = JSON.parse(buffer.toString("utf8")) as Partial<BackupManifest>;
    if (manifest.app !== "infinite-canvas" || manifest.version !== 1 || manifest.kind !== "system-backup" || manifest.backupId !== backupId || !["manual", "scheduled", "pre-restore"].includes(String(manifest.purpose)) || !Array.isArray(manifest.workspaces)) throw new SystemBackupError("备份清单格式无效");
    return manifest as BackupManifest;
}

export async function readWebdavBuffer(config: WebdavConfig, path: string, limit = 64 * 1024 * 1024) {
    const file = await getWebdavStream(config, path);
    if (!file) return null;
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of file.stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > limit) throw new SystemBackupError("WebDAV 文件超过读取上限", 413);
        chunks.push(buffer);
    }
    return Buffer.concat(chunks);
}

export async function listBackupSnapshots(): Promise<SnapshotSummary[]> {
    const config = readServerWebdavConfig();
    const snapshots: SnapshotSummary[] = [];
    for (const source of ["snapshots", "safety"] as const) {
        const names = await listWebdavDirectory(config, `${SYSTEM_BACKUP_ROOT}/${source}`).catch(() => []);
        for (const id of names.filter(isSnapshotId).sort().reverse()) {
            try {
                const manifest = await readBackupManifest(config, source, id);
                snapshots.push({ id, source, purpose: manifest.purpose, createdAt: manifest.createdAt, status: manifest.status, workspaces: manifest.totals.workspaces, complete: manifest.totals.complete, mediaBytes: manifest.totals.mediaBytes });
            } catch {
                // 不完整目录不展示，也不参与恢复。
            }
        }
    }
    return snapshots.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function pruneSnapshots(config: WebdavConfig, source: SnapshotSource, retention: number, currentId: string, preserveIds: string[] = []) {
    const names = await listWebdavDirectory(config, `${SYSTEM_BACKUP_ROOT}/${source}`).catch(() => []);
    const ids = names.filter(isSnapshotId).sort().reverse();
    const valid: string[] = [];
    for (const id of ids) {
        try {
            if (await webdavExists(config, `${SYSTEM_BACKUP_ROOT}/${source}/${id}/manifest.json`)) valid.push(id);
            else if (id !== currentId) await deleteWebdavPath(config, `${SYSTEM_BACKUP_ROOT}/${source}/${id}`).catch(() => undefined);
        } catch {
            // On an uncertain probe, keep the directory instead of risking a valid snapshot.
            valid.push(id);
        }
    }
    const keep = new Set(valid.slice(0, Math.max(retention, 1)));
    keep.add(currentId);
    preserveIds.forEach((id) => keep.add(id));
    for (const id of ids) {
        if (!keep.has(id)) await deleteWebdavPath(config, `${SYSTEM_BACKUP_ROOT}/${source}/${id}`).catch(() => undefined);
    }
}

export async function getWorkspaceBlockers(workspaceId: string) {
    return await queryMany<{ intentId: string; storageKey: string; objectKey: string; operation: string; expectedBytes: string | null; createdAt: string }>(await getPool(),
        "SELECT intent_id AS \"intentId\", storage_key AS \"storageKey\", object_key AS \"objectKey\", operation, expected_bytes AS \"expectedBytes\", created_at AS \"createdAt\" FROM media_write_intents WHERE workspace_id = $1 AND state = 'active' ORDER BY created_at", workspaceId);
}

export async function releaseStaleIntents(workspaceId: string, intentIds: string[]) {
    const ids = [...new Set(intentIds.filter((id) => typeof id === "string" && id))];
    if (!ids.length) throw new SystemBackupError("未选择写入租约");
    const db = await getPool();
    return withTransaction(async (tx) => {
        await execute(tx, "SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", workspaceId);
        const rows = await queryMany<{ intent_id: string; created_at: Date }>(tx, "SELECT intent_id, created_at FROM media_write_intents WHERE workspace_id = $1 AND state = 'active' AND intent_id = ANY($2::text[])", workspaceId, ids);
        if (!rows.length) return 0;
        const threshold = Date.now() - STALE_INTENT_MINUTES * 60_000;
        if (rows.some((row) => new Date(row.created_at).getTime() > threshold)) throw new SystemBackupError("只能清理超过 30 分钟的写入租约", 409);
        await execute(tx, "UPDATE media_write_intents SET state = 'failed', failure_reason = '管理员手动解除超时租约', finished_at = now() WHERE workspace_id = $1 AND intent_id = ANY($2::text[])", workspaceId, ids);
        return rows.length;
    });
}

export async function testBackupConnection() {
    await testWebdavConnection(readServerWebdavConfig());
}

export async function initializeSystemBackup() {
    if (initialized) return;
    initialized = true;
    try {
        const db = await getPool();
        await execute(db, "UPDATE backup_runs SET status = 'failed', error = COALESCE(error, '服务重启，任务已中断'), finished_at = now(), heartbeat_at = now() WHERE status = 'running'");
    } catch (error) {
        console.error("Backup stale run cleanup failed", error);
    }
    startBackupScheduler();
}

export function stopSystemBackup() {
    if (schedulerTimer) clearInterval(schedulerTimer);
    schedulerTimer = null;
    if (activeTask) activeTask.cancelled = true;
}

function startBackupScheduler() {
    if (schedulerTimer) return;
    schedulerTimer = setInterval(() => void scheduledTick(), 60_000);
    schedulerTimer.unref?.();
    void scheduledTick();
}

async function scheduledTick() {
    if (activeTask) return;
    try {
        const settings = await readBackupSettings();
        if (!settings.enabled) return;
        readServerWebdavConfig();
        const last = await queryOne<{ started_at: Date; finished_at: Date | null }>(await getPool(), "SELECT started_at, finished_at FROM backup_runs WHERE kind = 'backup' ORDER BY started_at DESC LIMIT 1");
        const lastAt = last?.finished_at || last?.started_at;
        if (lastAt && Date.now() - new Date(lastAt).getTime() < settings.intervalMinutes * 60_000) return;
        await startBackupTask(null, "scheduled");
    } catch (error) {
        console.error("Scheduled WebDAV backup skipped", error);
    }
}

function requireWebdavConfig() {
    try {
        return readServerWebdavConfig();
    } catch {
        throw new SystemBackupError("WebDAV 尚未配置", 503);
    }
}

function sourceForPurpose(purpose: BackupPurpose): SnapshotSource {
    return purpose === "pre-restore" ? "safety" : "snapshots";
}

function createSnapshotId() {
    return `${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${randomUUID().slice(0, 8)}`;
}

function isSnapshotId(value: string) {
    return SNAPSHOT_ID.test(value);
}

function sha256Hex(value: string | Buffer) {
    return createHash("sha256").update(value).digest("hex");
}

function mapRun(row: RunRow): BackupRunRecord {
    return {
        id: row.id, kind: row.kind, purpose: row.purpose, status: row.status, backupId: row.backup_id,
        workspaceId: row.workspace_id, startedAt: toIso(row.started_at), finishedAt: row.finished_at ? toIso(row.finished_at) : null,
        summary: row.summary, error: row.error,
    };
}
