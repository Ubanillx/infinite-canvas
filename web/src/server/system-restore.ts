import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { execute, getPool, queryMany, queryOne, toIso, withReadSnapshot, withTransaction, type SqlExecutor } from "./db";
import type { BackupGenerationTask, BackupTaskMedia } from "./generation-task-backup";
import { normalizeCanvasTarget } from "./generation-tasks";
import { extractMediaReferences, replaceDomainMediaReferences } from "./media-references";
import { deleteMediaObject, mediaObjectKey, putMediaStream } from "./object-storage";
import { assertBackupTaskActive, BACKUP_DOMAIN_KEYS, beginBackupTask, createSafetySnapshot, finishBackupTask, objectFilePath, readBackupManifest, readBackupSettings, readWebdavBuffer, setBackupProgress, settleBackupTaskFailure, snapshotFilePath, SystemBackupError, type ManifestFileRef, type ManifestMedia, type ManifestPrompt, type ManifestPromptImage, type SnapshotSource, type WorkspaceManifest } from "./system-backup";
import { getWebdavStream, readServerWebdavConfig, webdavPathSegments } from "./webdav-client";

const MEDIA_LIMIT_BYTES = 100 * 1024 * 1024;
const MAX_RESTORE_CONCURRENCY = 2;

type WorkspaceRow = { id: string; name: string; owner_user_id: string | null; created_at: Date; updated_at: Date };
type LoadedDomain = { payload: string; refs: ReturnType<typeof extractMediaReferences>; revision: number };
type Baseline = { domains: string; media: string; prompts: string; tasks: string };
type StagedMedia = BackupTaskMedia & { newObjectVersion: string; objectKey: string };
type StagedPromptImage = ManifestPromptImage & { tempPath: string };

export function createMediaCompletionReporter(report: (completed: number) => void) {
    let completed = 0;
    return () => {
        completed += 1;
        report(completed);
    };
}

export async function startRestoreTask(actorUserId: string, snapshotId: string, workspaceId: string, source: SnapshotSource) {
    if (!actorUserId) throw new SystemBackupError("需要管理员身份", 401);
    if (source !== "snapshots" && source !== "safety") throw new SystemBackupError("备份来源无效");
    const config = (() => {
        try { return readServerWebdavConfig(); }
        catch { throw new SystemBackupError("WebDAV 尚未配置", 503); }
    })();
    const runId = await beginBackupTask("restore", "manual", actorUserId, workspaceId);
    void performRestore(runId, { ...config, signal: assertBackupTaskActive().controller.signal }, snapshotId, workspaceId, source, actorUserId).catch((error) => settleBackupTaskFailure(runId, error));
    return runId;
}

async function performRestore(runId: string, config: ReturnType<typeof readServerWebdavConfig>, snapshotId: string, workspaceId: string, source: SnapshotSource, actorUserId: string) {
    let tempDir = "";
    let committed = false;
    let stagedMedia: StagedMedia[] = [];
    const stagedKeys: string[] = [];
    try {
        const settings = await readBackupSettings();
        const manifest = await readBackupManifest(config, source, snapshotId);
        const entry = manifest.workspaces.find((workspace) => workspace.id === workspaceId);
        if (!entry) throw new SystemBackupError("备份中不包含该工作区", 404);
        if (entry.status !== "complete") throw new SystemBackupError("该工作区的备份不完整，不能恢复", 409);
        const workspace = await queryOne<WorkspaceRow>(await getPool(), "SELECT id, name, owner_user_id, created_at, updated_at FROM workspaces WHERE id = $1", workspaceId);
        if (!workspace) throw new SystemBackupError("目标工作区不存在", 404);
        const baseline = await captureBaseline(workspaceId);
        setBackupProgress({ phase: "pre-restore", workspaceId, workspaceName: workspace.name });
        await createSafetySnapshot(config, workspaceId, settings, source === "safety" ? [snapshotId] : []);
        setBackupProgress({ phase: "preparing", current: 0, total: 0, uploadedFiles: 0, uploadedBytes: 0, message: "" });
        const domains = await loadDomains(config, source, snapshotId, entry);
        const prompts = await loadPrompts(config, source, snapshotId, entry);
        const promptImages = await loadPromptImages(config, source, snapshotId, entry);
        const media = await loadMedia(config, source, snapshotId, entry);
        const tasks = await loadTasks(config, source, snapshotId, entry);
        validateRestoreData(workspaceId, domains, prompts, promptImages, media, tasks);
        await assertPromptIdsAvailable(workspaceId, prompts);

        tempDir = await mkdtemp(join(tmpdir(), "infinite-canvas-restore-"));
        const stagedPromptImages = await stagePromptImages(config, tempDir, promptImages);
        setBackupProgress({ phase: "download-media", total: media.length, current: 0 });
        stagedMedia = await stageMedia(config, workspaceId, media, stagedKeys);
        assertBackupTaskActive();
        setBackupProgress({ phase: "restore-data", total: 1, current: 0 });
        await commitRestore(workspaceId, domains, prompts, stagedPromptImages, stagedMedia, tasks, baseline, actorUserId);
        committed = true;
        setBackupProgress({ current: 1 });
        await finishBackupTask(runId, "succeeded", { backupId: snapshotId, restoredWorkspaceId: workspaceId, media: stagedMedia.length, warnings: entry.errors });
    } catch (error) {
        if (!committed && stagedKeys.length) {
            try {
                const referenced = stagedMedia.length ? await queryMany<{ object_version: string }>(await getPool(), "SELECT object_version FROM media_files WHERE workspace_id = $1 AND object_version = ANY($2::text[])", workspaceId, stagedMedia.map((item) => item.newObjectVersion)) : [];
                const taskReferences = stagedMedia.length ? await queryOne(await getPool(), `SELECT 1 FROM generation_tasks t
                    WHERE t.workspace_id = $1 AND EXISTS (SELECT 1 FROM jsonb_array_elements(t.request_snapshot->'references') r
                        WHERE r->>'objectVersion' = ANY($2::text[])) LIMIT 1`, workspaceId, stagedMedia.map((item) => item.newObjectVersion)) : null;
                committed = referenced.length > 0 || Boolean(taskReferences);
            } catch {
                // The commit result is uncertain; keep staged objects instead of risking live media corruption.
                committed = true;
            }
        }
        if (!committed) await Promise.all(stagedKeys.map((key) => deleteMediaObject(key).catch(() => undefined)));
        await settleBackupTaskFailure(runId, error);
    } finally {
        if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
}

async function loadDomains(config: ReturnType<typeof readServerWebdavConfig>, source: SnapshotSource, snapshotId: string, entry: WorkspaceManifest) {
    const domains = new Map<string, LoadedDomain>();
    for (const domain of BACKUP_DOMAIN_KEYS) {
        const domainEntry = entry.domains[domain];
        if (!domainEntry) throw new SystemBackupError(`备份缺少数据域 ${domain}`);
        const expectedPath = `workspaces/${entry.id}/data/${domain}.json`;
        const file = await readCheckedFile(config, snapshotFilePath(source, snapshotId, expectedPath), domainEntry.file, expectedPath);
        let refs: ReturnType<typeof extractMediaReferences>;
        try {
            refs = extractMediaReferences(domain, JSON.parse(file));
        } catch (error) {
            throw new SystemBackupError(`备份数据域 ${domain} 无法解析: ${error instanceof Error ? error.message : "格式无效"}`);
        }
        domains.set(domain, { payload: file, refs, revision: domainEntry.revision });
    }
    return domains;
}

async function loadMedia(config: ReturnType<typeof readServerWebdavConfig>, source: SnapshotSource, snapshotId: string, entry: WorkspaceManifest) {
    const expectedPath = `workspaces/${entry.id}/media.json`;
    const file = await readCheckedFile(config, snapshotFilePath(source, snapshotId, expectedPath), entry.media.file, expectedPath);
    const value = JSON.parse(file) as unknown;
    if (!Array.isArray(value)) throw new SystemBackupError("媒体清单格式无效");
    return value as BackupTaskMedia[];
}

async function loadTasks(config: ReturnType<typeof readServerWebdavConfig>, source: SnapshotSource, snapshotId: string, entry: WorkspaceManifest) {
    if (!entry.generationTasks) throw new SystemBackupError("备份缺少生成任务清单");
    const expectedPath = `workspaces/${entry.id}/generation-tasks.json`;
    const file = await readCheckedFile(config, snapshotFilePath(source, snapshotId, expectedPath), entry.generationTasks.file, expectedPath);
    const value = JSON.parse(file) as unknown;
    if (!Array.isArray(value) || value.length !== entry.generationTasks.count) throw new SystemBackupError("生成任务清单格式无效");
    return value as BackupGenerationTask[];
}

async function loadPrompts(config: ReturnType<typeof readServerWebdavConfig>, source: SnapshotSource, snapshotId: string, entry: WorkspaceManifest) {
    const expectedPath = `workspaces/${entry.id}/prompts.json`;
    const file = await readCheckedFile(config, snapshotFilePath(source, snapshotId, expectedPath), entry.prompts.file, expectedPath);
    const value = JSON.parse(file) as unknown;
    if (!Array.isArray(value)) throw new SystemBackupError("提示词清单格式无效");
    return value as ManifestPrompt[];
}

async function loadPromptImages(config: ReturnType<typeof readServerWebdavConfig>, source: SnapshotSource, snapshotId: string, entry: WorkspaceManifest) {
    const expectedPath = `workspaces/${entry.id}/prompt-images.json`;
    const file = await readCheckedFile(config, snapshotFilePath(source, snapshotId, expectedPath), entry.promptImages.file, expectedPath);
    const value = JSON.parse(file) as unknown;
    if (!Array.isArray(value)) throw new SystemBackupError("提示词示例图清单格式无效");
    return value as ManifestPromptImage[];
}

async function readCheckedFile(config: ReturnType<typeof readServerWebdavConfig>, path: string, ref: ManifestFileRef, expectedPath: string) {
    if (ref.path !== expectedPath) throw new SystemBackupError("备份文件路径不符合预期");
    const buffer = await readWebdavBuffer(config, path);
    if (!buffer || buffer.length !== ref.bytes || sha256Hex(buffer) !== ref.sha256) throw new SystemBackupError(`备份文件校验失败: ${expectedPath}`);
    return buffer.toString("utf8");
}

function validateRestoreData(workspaceId: string, domains: Map<string, LoadedDomain>, prompts: ManifestPrompt[], promptImages: ManifestPromptImage[], media: BackupTaskMedia[], tasks: BackupGenerationTask[]) {
    const mediaKeys = new Set<string>();
    const mediaVersions = new Set<string>();
    for (const item of media) {
        if (!/^[a-z][a-z0-9-]*:[A-Za-z0-9_-]+$/.test(item.storageKey) || mediaVersions.has(`${item.storageKey}\0${item.objectVersion}`) || (!item.historical && mediaKeys.has(item.storageKey))) throw new SystemBackupError("媒体标识无效或重复");
        if (item.missing) throw new SystemBackupError(`媒体 ${item.storageKey} 在备份中缺失`);
        if (!Number.isSafeInteger(item.bytes) || item.bytes < 0 || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new SystemBackupError(`媒体 ${item.storageKey} 元数据无效`);
        assertObjectPath(item.objectPath, workspaceId, "media");
        mediaVersions.add(`${item.storageKey}\0${item.objectVersion}`);
        if (!item.historical) mediaKeys.add(item.storageKey);
    }
    const taskIds = new Set<string>();
    const requestIds = new Set<string>();
    for (const task of tasks) {
        if (typeof task.id !== "string" || !task.id || taskIds.has(task.id) || typeof task.request_id !== "string" || requestIds.has(task.request_id)
            || !["image", "video", "text", "audio"].includes(task.kind) || !["queued", "running", "succeeded", "partial", "failed", "needs_attention"].includes(task.status)
            || !task.request_snapshot || !Array.isArray(task.request_snapshot.references) || !Array.isArray(task.outputs) || !Array.isArray(task.submissions)
            || !task.provider_snapshot || typeof task.provider_snapshot.baseUrl !== "string" || "apiKey" in task.provider_snapshot || "script" in task.provider_snapshot
            || "raw_result" in task || "worker_id" in task) throw new SystemBackupError("生成任务清单格式无效");
        if (task.request_snapshot.canvasTarget !== undefined) {
            try {
                const target = normalizeCanvasTarget(task.request_snapshot.canvasTarget);
                if (Object.keys(task.request_snapshot.canvasTarget).some((key) => key !== "projectId" && key !== "nodeId")) throw new Error("unexpected target field");
                task.request_snapshot.canvasTarget = target;
            } catch { throw new SystemBackupError("生成任务画布目标格式无效"); }
        }
        const url = new URL(task.provider_snapshot.baseUrl);
        if (url.username || url.password || url.search || url.hash) throw new SystemBackupError("生成任务渠道地址含凭据");
        for (const ref of task.request_snapshot.references) if (!mediaVersions.has(`${ref.storageKey}\0${ref.objectVersion}`)) throw new SystemBackupError(`生成任务 ${task.id} 的参考媒体版本缺失`);
        for (const output of task.outputs) if (!mediaKeys.has(output.storageKey)) throw new SystemBackupError(`生成任务 ${task.id} 的结果媒体缺失`);
        if (task.submissions.some((slot) => "outputs" in slot)) throw new SystemBackupError("生成任务清单包含未归档的供应商结果");
        if (task.submissions.some((slot) => !["queued", "completed", "uncertain", "failed"].includes(slot.status)
            || Object.keys(slot).some((key) => key !== "status" && key !== "attempts" && (key !== "content" || task.kind !== "text"))
            || slot.content !== undefined && typeof slot.content !== "string"
            || slot.attempts !== undefined && (!Number.isSafeInteger(slot.attempts) || slot.attempts < 1))) throw new SystemBackupError("生成任务候选进度格式无效");
        taskIds.add(task.id); requestIds.add(task.request_id);
    }
    for (const [domain, item] of domains) {
        for (const ref of item.refs) if (!mediaKeys.has(ref.storageKey)) throw new SystemBackupError(`${domain} 引用的媒体 ${ref.storageKey} 不在备份中`);
    }
    const promptIds = new Set<string>();
    for (const item of prompts) {
        if (typeof item.id !== "string" || !item.id || promptIds.has(item.id) || typeof item.title !== "string" || typeof item.prompt !== "string" || !Array.isArray(item.tags) || item.tags.some((tag) => typeof tag !== "string")) throw new SystemBackupError("提示词清单格式无效");
        promptIds.add(item.id);
    }
    for (const item of promptImages) {
        if (!promptIds.has(item.promptId) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new SystemBackupError("提示词示例图清单格式无效");
        assertObjectPath(item.objectPath, workspaceId, "prompts");
    }
}

function assertObjectPath(path: string, workspaceId: string, kind: "media" | "prompts") {
    const segments = webdavPathSegments(path);
    if (segments.length !== 4 || segments[0] !== "objects" || segments[1] !== workspaceId || segments[2] !== kind) throw new SystemBackupError("备份对象路径不符合预期");
}

async function assertPromptIdsAvailable(workspaceId: string, prompts: ManifestPrompt[]) {
    if (!prompts.length) return;
    const conflicts = await queryMany<{ id: string }>(await getPool(), "SELECT id FROM workspace_prompts WHERE id = ANY($1::text[]) AND workspace_id <> $2", prompts.map((prompt) => prompt.id), workspaceId);
    if (conflicts.length) throw new SystemBackupError("提示词标识与其他工作区冲突，已中止恢复");
}

async function stageMedia(config: ReturnType<typeof readServerWebdavConfig>, workspaceId: string, media: ManifestMedia[], stagedKeys: string[]) {
    const staged: StagedMedia[] = [];
    const reportCompletion = createMediaCompletionReporter((completed) => {
        setBackupProgress({ current: completed, total: media.length, uploadedFiles: completed, uploadedBytes: staged.reduce((sum, entry) => sum + entry.bytes, 0) });
    });
    await runWithConcurrency(media, MAX_RESTORE_CONCURRENCY, async (item) => {
        assertBackupTaskActive();
        const file = await getWebdavStream(config, objectFilePath(item.objectPath));
        if (!file) throw new SystemBackupError(`备份媒体不存在: ${item.storageKey}`);
        if (file.contentLength !== undefined && file.contentLength !== item.bytes) { file.stream.destroy(); throw new SystemBackupError(`备份媒体大小不一致: ${item.storageKey}`); }
        const newObjectVersion = randomUUID();
        const objectKey = mediaObjectKey(workspaceId, item.storageKey, newObjectVersion);
        stagedKeys.push(objectKey);
        const hash = createHash("sha256");
        const hasher = new Transform({ transform(chunk: Buffer, _encoding, callback) { hash.update(chunk); callback(null, chunk); } });
        try {
            await Promise.all([
                pipeline(file.stream, hasher, { signal: config.signal }),
                putMediaStream(objectKey, hasher, item.mimeType, item.bytes, config.signal),
            ]);
        } finally {
            if (!file.stream.readableEnded) file.stream.destroy();
            hasher.destroy();
        }
        if (hash.digest("hex") !== item.sha256) throw new SystemBackupError(`备份媒体内容校验失败: ${item.storageKey}`);
        staged.push({ ...item, newObjectVersion, objectKey });
        reportCompletion();
    });
    return staged;
}

async function stagePromptImages(config: ReturnType<typeof readServerWebdavConfig>, tempDir: string, images: ManifestPromptImage[]) {
    const staged: StagedPromptImage[] = [];
    for (let index = 0; index < images.length; index += 1) {
        assertBackupTaskActive();
        const item = images[index];
        const buffer = await readWebdavBuffer(config, objectFilePath(item.objectPath), MEDIA_LIMIT_BYTES);
        if (!buffer || buffer.length !== item.bytes || sha256Hex(buffer) !== item.sha256) throw new SystemBackupError(`提示词示例图校验失败: ${item.promptId}`);
        const tempPath = join(tempDir, `prompt-${index}.bin`);
        await writeFile(tempPath, buffer, { mode: 0o600 });
        staged.push({ ...item, tempPath });
    }
    return staged;
}

async function commitRestore(workspaceId: string, domains: Map<string, LoadedDomain>, prompts: ManifestPrompt[], promptImages: StagedPromptImage[], media: StagedMedia[], tasks: BackupGenerationTask[], baseline: Baseline, actorUserId: string) {
    await withTransaction(async (tx) => {
        const workspace = await queryOne<{ id: string }>(tx, "SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", workspaceId);
        assertBackupTaskActive();
        if (!workspace) throw new SystemBackupError("目标工作区不存在", 404);
        const current = await captureBaselineWith(tx, workspaceId);
        if (current.domains !== baseline.domains || current.media !== baseline.media || current.prompts !== baseline.prompts || current.tasks !== baseline.tasks) throw new SystemBackupError("恢复期间工作区数据已变化，请重试", 409);
        const active = await queryMany<{ intent_id: string }>(tx, "SELECT intent_id FROM media_write_intents WHERE workspace_id = $1 AND state = 'active'", workspaceId);
        if (active.length) throw new SystemBackupError("工作区存在未完成的媒体写入租约，已中止恢复", 409);
        const conflicts = prompts.length ? await queryMany<{ id: string }>(tx, "SELECT id FROM workspace_prompts WHERE id = ANY($1::text[]) AND workspace_id <> $2", prompts.map((prompt) => prompt.id), workspaceId) : [];
        if (conflicts.length) throw new SystemBackupError("提示词标识与其他工作区冲突，已中止恢复");
        const taskConflicts = tasks.length ? await queryMany<{ id: string }>(tx, "SELECT id FROM generation_tasks WHERE id = ANY($1::text[]) AND workspace_id <> $2", tasks.map((task) => task.id), workspaceId) : [];
        if (taskConflicts.length) throw new SystemBackupError("生成任务标识与其他工作区冲突，已中止恢复");
        const currentTasks = await queryMany<{ id: string; request_id: string; revision: number; request_snapshot: { references: Array<{ storageKey: string }> }; outputs: Array<{ storageKey: string }> }>(tx, "SELECT id, request_id, revision, request_snapshot, outputs FROM generation_tasks WHERE workspace_id = $1", workspaceId);
        const revisionsById = new Map(currentTasks.map((row) => [row.id, row.revision]));
        const currentRequestIds = new Set(currentTasks.map((row) => row.request_id));
        const protectedMedia = new Set(currentTasks.flatMap((row) => [...row.request_snapshot.references.map((ref) => ref.storageKey), ...row.outputs.map((output) => output.storageKey)]));
        const actors = await queryMany<{ user_id: string; role: string }>(tx, "SELECT user_id, role FROM workspace_members WHERE workspace_id = $1", workspaceId);
        const actorRoles = new Map(actors.map((actor) => [actor.user_id, actor.role]));
        const fallbackActor = actors.find((actor) => actor.role === "owner" || actor.role === "editor")?.user_id || actorUserId;
        const protectedRows = protectedMedia.size ? await queryMany<{ storage_key: string; object_version: string; content_sha256: string; remote_path: string }>(tx,
            "SELECT storage_key, object_version, content_sha256, remote_path FROM media_files WHERE workspace_id = $1 AND storage_key = ANY($2::text[])", workspaceId, [...protectedMedia]) : [];
        const protectedByKey = new Map(protectedRows.map((row) => [row.storage_key, row]));
        for (const item of media.filter((entry) => !entry.historical && protectedMedia.has(entry.storageKey))) {
            const currentMedia = protectedByKey.get(item.storageKey);
            if (!currentMedia || currentMedia.remote_path || ((!item.objectVersion || currentMedia.object_version !== item.objectVersion) && (!currentMedia.content_sha256 || currentMedia.content_sha256 !== item.sha256))) {
                throw new SystemBackupError(`媒体 ${item.storageKey} 已被新生成任务引用且内容与备份不同，已中止恢复`, 409);
            }
        }

        const revisions = new Map<string, number>();
        for (const domain of BACKUP_DOMAIN_KEYS) {
            const item = domains.get(domain);
            if (!item) throw new SystemBackupError(`缺少数据域 ${domain}`);
            const row = await queryOne<{ revision: number }>(tx, `INSERT INTO workspace_data (workspace_id, domain, payload, revision, updated_at, updated_by)
                VALUES ($1, $2, $3, 1, now(), $4) ON CONFLICT (workspace_id, domain) DO UPDATE
                SET payload = excluded.payload, revision = workspace_data.revision + 1, updated_at = now(), updated_by = excluded.updated_by
                RETURNING revision`, workspaceId, domain, item.payload, actorUserId);
            if (!row) throw new SystemBackupError("工作区数据写入失败");
            revisions.set(domain, row.revision);
        }

        const mediaKeys = [...new Set([...media.filter((item) => !item.historical).map((item) => item.storageKey), ...protectedMedia])];
        await execute(tx, "DELETE FROM media_files WHERE workspace_id = $1 AND remote_path = '' AND NOT (storage_key = ANY($2::text[]))", workspaceId, mediaKeys);
        for (const item of media.filter((item) => !item.historical)) {
            if (protectedMedia.has(item.storageKey)) continue;
            await execute(tx, `INSERT INTO media_files (workspace_id, storage_key, remote_path, mime_type, bytes, object_version, content_sha256, lifecycle_state, last_referenced_at, created_at, updated_at)
                VALUES ($1, $2, '', $3, $4, $5, $6, $7, NULL, $8::timestamptz, $9::timestamptz)
                ON CONFLICT (workspace_id, storage_key) DO UPDATE SET remote_path = '', mime_type = excluded.mime_type, bytes = excluded.bytes,
                object_version = excluded.object_version, content_sha256 = excluded.content_sha256, lifecycle_state = excluded.lifecycle_state,
                last_referenced_at = NULL, created_at = excluded.created_at, updated_at = excluded.updated_at`,
            workspaceId, item.storageKey, item.mimeType, item.bytes, item.newObjectVersion, item.sha256, item.lifecycleState || "ready", item.createdAt, item.updatedAt);
        }

        await execute(tx, "DELETE FROM workspace_prompts WHERE workspace_id = $1", workspaceId);
        for (const item of prompts) {
            await execute(tx, `INSERT INTO workspace_prompts (id, workspace_id, title, prompt, description, tags, shared, created_at, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz)`,
            item.id, workspaceId, item.title, item.prompt, item.description, JSON.stringify(item.tags), item.shared, item.createdAt, item.updatedAt);
        }
        for (const item of promptImages) {
            const image = await readFile(item.tempPath);
            await execute(tx, "INSERT INTO workspace_prompt_images (prompt_id, mime_type, image) VALUES ($1, $2, $3) ON CONFLICT (prompt_id) DO UPDATE SET mime_type = excluded.mime_type, image = excluded.image", item.promptId, item.mimeType, image);
        }

        // Keep post-snapshot request IDs and their provider state. An older backup cannot undo a billed request.
        await execute(tx, `UPDATE generation_tasks SET worker_id = NULL, revision = revision + 1, updated_at = now(),
            status = CASE WHEN status IN ('queued','submitting') THEN 'needs_attention' ELSE status END,
            error_code = CASE WHEN status IN ('queued','submitting') THEN 'submission_uncertain' ELSE error_code END
            WHERE workspace_id = $1`, workspaceId);
        const stagedVersions = new Map(media.map((item) => [`${item.storageKey}\0${item.objectVersion}`, item.newObjectVersion]));
        for (const item of tasks) {
            if (revisionsById.has(item.id) || currentRequestIds.has(item.request_id)) continue;
            const references = item.request_snapshot.references.map((ref) => ({ ...ref, objectVersion: stagedVersions.get(`${ref.storageKey}\0${ref.objectVersion}`) }));
            const actor = actorRoles.has(item.actorUserId) ? item.actorUserId : fallbackActor;
            const revision = item.revision + 1;
            // A backup may precede a provider POST that finished after the snapshot. Never replay an unverified submission.
            const status = item.status === "queued" ? "needs_attention" : item.status;
            const errorCode = item.status === "queued" ? "submission_uncertain" : item.error_code;
            await execute(tx, `INSERT INTO generation_tasks (id, workspace_id, actor_user_id, request_id, request_hash, kind, request_snapshot, provider_snapshot,
                status, upstream, raw_result, submissions, outputs, error_code, poll_count, next_poll_at, worker_id, revision, hidden, created_at, updated_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10::jsonb,NULL,$11::jsonb,$12::jsonb,$13,$14,$15::timestamptz,NULL,$16,$17,$18::timestamptz,now())`,
            item.id, workspaceId, actor, item.request_id, item.request_hash, item.kind, JSON.stringify({ ...item.request_snapshot, references }),
            JSON.stringify(item.provider_snapshot), status, item.upstream ? JSON.stringify(item.upstream) : null,
            JSON.stringify(item.submissions), JSON.stringify(item.outputs), errorCode, item.poll_count, item.nextPollAt, revision, item.hidden, item.createdAt);
        }

        await execute(tx, "DELETE FROM media_references WHERE workspace_id = $1 AND source_domain <> 'generation-tasks'", workspaceId);
        const insertedTaskIds = tasks.filter((task) => !revisionsById.has(task.id) && !currentRequestIds.has(task.request_id)).map((task) => task.id);
        await execute(tx, "DELETE FROM media_references WHERE workspace_id = $1 AND source_domain = 'generation-tasks' AND owner_id = ANY($2::text[])", workspaceId, insertedTaskIds);
        await execute(tx, `DELETE FROM media_references r WHERE r.workspace_id = $1 AND r.source_domain = 'generation-tasks'
            AND NOT EXISTS (SELECT 1 FROM generation_tasks t WHERE t.workspace_id = r.workspace_id AND t.id = r.owner_id)`, workspaceId);
        await execute(tx, `UPDATE media_references r SET source_revision = t.revision FROM generation_tasks t
            WHERE r.workspace_id = $1 AND r.source_domain = 'generation-tasks' AND r.owner_id = t.id AND t.workspace_id = $1`, workspaceId);
        for (const domain of BACKUP_DOMAIN_KEYS) {
            const item = domains.get(domain);
            if (!item) continue;
            await replaceDomainMediaReferences(tx, workspaceId, domain, item.refs, revisions.get(domain) || 1, null);
        }
        for (const task of tasks) {
            if (revisionsById.has(task.id) || currentRequestIds.has(task.request_id)) continue;
            const refs = [...task.request_snapshot.references.map((ref, index) => ({ key: ref.storageKey, path: `/references/${index}/storageKey` })),
                ...task.outputs.map((output, index) => ({ key: output.storageKey, path: `/outputs/${index}/storageKey` }))];
            for (const ref of refs) await execute(tx, `INSERT INTO media_references (workspace_id, storage_key, owner_kind, owner_id, source_domain, source_revision, json_path)
                VALUES ($1,$2,'generation-task',$3,'generation-tasks',$4,$5)`, workspaceId, ref.key, task.id, task.revision + 1, ref.path);
        }
        await execute(tx, "UPDATE workspaces SET updated_at = now(), data_restored_at = now() WHERE id = $1", workspaceId);
        assertBackupTaskActive();
    });
}

async function captureBaseline(workspaceId: string): Promise<Baseline> {
    return withReadSnapshot((tx) => captureBaselineWith(tx, workspaceId));
}

async function captureBaselineWith(db: SqlExecutor, workspaceId: string): Promise<Baseline> {
    const domains = await queryMany<{ domain: string; revision: number; updated_at: Date; updated_by: string }>(db, "SELECT domain, revision, updated_at, updated_by FROM workspace_data WHERE workspace_id = $1 ORDER BY domain", workspaceId);
    const media = await queryMany<{ storage_key: string; object_version: string; remote_path: string; bytes: string; updated_at: Date }>(db, "SELECT storage_key, object_version, remote_path, bytes, updated_at FROM media_files WHERE workspace_id = $1 ORDER BY storage_key", workspaceId);
    const prompts = await queryMany<{ id: string; updated_at: Date }>(db, "SELECT id, updated_at FROM workspace_prompts WHERE workspace_id = $1 ORDER BY id", workspaceId);
    const tasks = await queryMany<{ id: string; revision: number; updated_at: Date }>(db, "SELECT id, revision, updated_at FROM generation_tasks WHERE workspace_id = $1 ORDER BY id", workspaceId);
    return {
        domains: JSON.stringify(domains.map((row) => [row.domain, row.revision, toIso(row.updated_at), row.updated_by])),
        media: JSON.stringify(media.map((row) => [row.storage_key, row.object_version, row.remote_path, row.bytes, toIso(row.updated_at)])),
        prompts: JSON.stringify(prompts.map((row) => [row.id, toIso(row.updated_at)])),
        tasks: JSON.stringify(tasks.map((row) => [row.id, row.revision, toIso(row.updated_at)])),
    };
}

function sha256Hex(value: string | Buffer) {
    return createHash("sha256").update(value).digest("hex");
}

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>) {
    let next = 0;
    let failure: unknown = null;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (!failure && next < items.length) {
            const index = next++;
            try {
                await worker(items[index], index);
            } catch (error) {
                failure = error;
            }
        }
    }));
    if (failure) throw failure;
}
