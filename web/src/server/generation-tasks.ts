import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { databaseUrl, execute, getPool, queryMany, queryOne, toIso, withTransaction, type SqlExecutor } from "./db";
import { completeMediaIntent, createMediaIntent, failMediaIntent } from "./media-intents";
import { getMediaObject, mediaObjectKey, putMediaBuffer } from "./object-storage";
import { GENERATION_IMAGE_LIMIT, GENERATION_MEDIA_LIMIT_BYTES, readGenerationBytes } from "./generation-media";
import { submitImage, submitVideo, pollVideo, downloadOutput, type ResolvedGenerationChannel, type OutputDescriptor, type UpstreamVideoTask, type GenerationRequest } from "./generation-provider";
import { submitText, submitAudio } from "./generation-text-audio-provider";
import type { CreateGenerationTask, GenerationTask, GenerationTaskCanvasTarget, GenerationTaskFilter, GenerationTaskKind, GenerationTaskOutput, GenerationTaskStatus } from "../types/generation-task";

// Reuse the existing video polling cadence/window and existing media-upload size boundary.
export const GENERATION_POLL_MS = 2500;
const SEEDANCE_POLL_MS = 5000;
const VIDEO_POLL_ATTEMPTS = 120;
const MEDIA_LIMIT_BYTES = GENERATION_MEDIA_LIMIT_BYTES;
type Context = { id: string; userId: string; role: "owner" | "editor" | "viewer" };
type ProviderSnapshot = Omit<ResolvedGenerationChannel, "apiKey" | "script">;
type ReferenceSnapshot = CreateGenerationTask["references"][number] & { objectVersion: string; mimeType: string };
type Snapshot = Omit<CreateGenerationTask, "requestId" | "references"> & { references: ReferenceSnapshot[] };
type ImageSubmission = { status: "queued" | "submitting" | "completed" | "uncertain"; outputs?: OutputDescriptor[]; content?: string };
export type GenerationTaskRow = {
    id: string; workspace_id: string; actor_user_id: string; request_id: string; request_hash: string; kind: GenerationTaskKind;
    request_snapshot: Snapshot; provider_snapshot: ProviderSnapshot; status: GenerationTaskStatus; upstream: UpstreamVideoTask | null;
    raw_result: OutputDescriptor[] | null; outputs: GenerationTaskOutput[]; error_code: string | null; poll_count: number;
    submissions: ImageSubmission[];
    next_poll_at: Date | null; worker_id: string | null; revision: number; hidden: boolean; created_at: Date; updated_at: Date;
};
export type GenerationTaskOptions = {
    resolveChannel: (model: string, kind: GenerationTaskKind, snapshot?: ProviderSnapshot) => Promise<ResolvedGenerationChannel>;
    provider?: { submitImage: typeof submitImage; submitVideo: typeof submitVideo; pollVideo: typeof pollVideo; downloadOutput: typeof downloadOutput; submitText?: typeof submitText; submitAudio?: typeof submitAudio };
};
export class GenerationTaskError extends Error {
    constructor(message: string, public status = 400) { super(message); }
}
const messages: Record<string, string> = {
    submission_uncertain: "供应商提交结果不确定，请核对原请求；不会自动重复生成",
    archive_failed: "结果已收到，媒体归档未完成；可恢复归档，不会重新生成",
    poll_error: "供应商状态查询中断；可恢复查询原任务",
    poll_exhausted: "已达到原有轮询窗口；可恢复查询原任务，不会重新生成",
    provider_failed: "供应商报告生成失败",
    permission_revoked: "提交前工作区写权限已撤销",
    configuration_changed: "原渠道配置不可用或已变化，请恢复原配置后核对任务",
};
const activeStatuses = ["queued", "submitting", "running", "archiving"];
export function publicGenerationTask(row: GenerationTaskRow): GenerationTask {
    const snapshot = row.request_snapshot;
    const expected = row.kind === "image" || row.kind === "text" ? Number(snapshot.settings.count || 1) : 1;
    const textOutputs = row.kind === "text" ? row.submissions.map((slot, slotIndex) => ({ id: `${row.id}-${slotIndex}`, slotIndex, content: slot.content || "", status: slot.status === "completed" ? "succeeded" as const : slot.status === "uncertain" || !activeStatuses.includes(row.status) ? "needs_attention" as const : "running" as const })) : [];
    const successes = row.kind === "text" ? textOutputs.filter((output) => output.status === "succeeded").length : row.outputs.length;
    return { id: row.id, workspaceId: row.workspace_id, requestId: row.request_id, kind: row.kind, prompt: snapshot.prompt, model: snapshot.model, settings: snapshot.settings,
        references: snapshot.references.map(({ kind, storageKey, name, mimeType, width, height, durationMs }) => ({ kind, storageKey, ...(name ? { name } : {}), mimeType, ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}), ...(durationMs !== undefined ? { durationMs } : {}) })),
        ...(snapshot.canvasTarget ? { canvasTarget: normalizeCanvasTarget(snapshot.canvasTarget) } : {}),
        status: row.status, phase: row.status, outputs: row.outputs, textOutputs, successCount: successes,
        failCount: ["failed", "partial", "needs_attention"].includes(row.status) ? Math.max(0, expected - successes) : 0,
        ...(row.error_code ? { errorCode: row.error_code, error: messages[row.error_code] || "任务需要核对，可读取已保存结果" } : {}),
        revision: row.revision, createdAt: toIso(row.created_at), updatedAt: toIso(row.updated_at) };
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export function normalizeCanvasTarget(value: unknown): GenerationTaskCanvasTarget {
    if (!object(value) || typeof value.projectId !== "string" || !value.projectId.trim() || typeof value.nodeId !== "string" || !value.nodeId.trim()) throw new GenerationTaskError("画布生成目标无效");
    return { projectId: value.projectId.trim(), nodeId: value.nodeId.trim() };
}
export function assertCanvasGenerationBinding(payload: unknown, target: GenerationTaskCanvasTarget, requestId: string) {
    const state = object(payload) && object(payload.state) ? payload.state : null;
    const project = state && Array.isArray(state.projects) ? state.projects.find((entry) => object(entry) && entry.id === target.projectId) : null;
    const node = object(project) && Array.isArray(project.nodes) ? project.nodes.find((entry) => object(entry) && entry.id === target.nodeId) : null;
    if (!object(node) || !object(node.metadata) || !object(node.metadata.generationTask) || node.metadata.generationTask.requestId !== requestId) throw new GenerationTaskError("画布目标或请求绑定已变化，请保存节点后核对原请求", 409);
}
export function normalizeGenerationRequest(value: unknown): CreateGenerationTask {
    if (!object(value) || !["image", "video", "text", "audio"].includes(String(value.kind))) throw new GenerationTaskError("生成类型无效");
    for (const key of ["requestId", "prompt", "model"]) if (typeof value[key] !== "string" || !value[key].trim()) throw new GenerationTaskError(`请提供 ${key}`);
    if (!object(value.settings) || !Array.isArray(value.references)) throw new GenerationTaskError("生成参数或参考媒体无效");
    const canvasTarget = value.canvasTarget !== undefined ? normalizeCanvasTarget(value.canvasTarget) : undefined;
    const allowed = value.kind === "image" ? ["quality", "size", "count", "background", "systemPrompt"] : value.kind === "text" ? ["count", "systemPrompt", "reasoningEffort"] : value.kind === "audio" ? ["voice", "format", "speed", "instructions"] : ["size", "resolution", "seconds", "generateAudio", "watermark", "mode", "systemPrompt"];
    const settings: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value.settings)) {
        if (!allowed.includes(key) || !["string", "number", "boolean"].includes(typeof field) || typeof field === "number" && !Number.isFinite(field)) throw new GenerationTaskError("生成参数包含不支持的字段");
        settings[key] = field;
    }
    if (value.kind === "image" || value.kind === "text") {
        // Preserve the canvas's existing 15-image batches and the workbench's 10-image limit.
        const limit = canvasTarget ? 15 : GENERATION_IMAGE_LIMIT;
        const count = Math.max(1, Math.floor(Number(settings.count)) || 1);
        if (count > limit) throw new GenerationTaskError(`${value.kind === "text" ? "文本" : "图片"}生成数量不能超过 ${limit}`);
        settings.count = count;
    }
    const references = value.references.map((entry) => {
        if (!object(entry) || !["image", "video", "audio"].includes(String(entry.kind)) || typeof entry.storageKey !== "string" || !/^(image|video|audio|video-reference|audio-reference):[A-Za-z0-9_-]+$/.test(entry.storageKey)) throw new GenerationTaskError("请提供已保存的工作区参考媒体");
        if (value.kind === "image" && entry.kind !== "image") throw new GenerationTaskError("图片生成仅支持图片参考");
        if (value.kind === "text" && entry.kind !== "image") throw new GenerationTaskError("文本生成仅支持图片参考");
        if (value.kind === "audio") throw new GenerationTaskError("音频生成不支持参考媒体");
        const metadata: Record<string, number> = {};
        for (const field of ["width", "height", "durationMs"] as const) {
            if (entry[field] === undefined) continue;
            if (typeof entry[field] !== "number" || !Number.isFinite(entry[field]) || entry[field] < 0) throw new GenerationTaskError("参考媒体元信息无效");
            metadata[field] = entry[field];
        }
        return { kind: entry.kind as "image" | "video" | "audio", storageKey: entry.storageKey, ...(typeof entry.name === "string" ? { name: entry.name } : {}), ...metadata };
    });
    return { requestId: (value.requestId as string).trim(), kind: value.kind as GenerationTaskKind, prompt: (value.prompt as string).trim(), model: (value.model as string).trim(), settings, references, ...(canvasTarget ? { canvasTarget } : {}) };
}
function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
    return JSON.stringify(value);
}
export function generationRequestHash(input: CreateGenerationTask) { return createHash("sha256").update(canonical(input)).digest("hex"); }

async function writeScope<T>(context: Context, write: (tx: SqlExecutor) => Promise<T>) {
    if (context.role === "viewer") throw new GenerationTaskError("当前工作区为只读权限", 403);
    await getPool();
    return withTransaction(async (tx) => {
        await execute(tx, "SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", context.id);
        const member = await queryOne<{ role: string }>(tx, "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 FOR SHARE", context.id, context.userId);
        if (!member || member.role === "viewer") throw new GenerationTaskError("当前工作区无写入权限", 403);
        const restoring = await queryOne(tx, "SELECT 1 FROM backup_runs WHERE workspace_id = $1 AND kind = 'restore' AND status = 'running'", context.id);
        if (restoring) throw new GenerationTaskError("工作区恢复期间不能修改生成任务", 409);
        return write(tx);
    });
}
export async function createGenerationTask(context: Context, body: unknown, options: GenerationTaskOptions) {
    const input = normalizeGenerationRequest(body);
    const hash = generationRequestHash(input);
    // Resolve only server-owned credentials; never accept endpoint/key fields from the request.
    return writeScope(context, async (tx) => {
        const existing = await queryOne<GenerationTaskRow>(tx, "SELECT * FROM generation_tasks WHERE workspace_id = $1 AND request_id = $2", context.id, input.requestId);
        if (existing) {
            if (existing.request_hash !== hash) throw new GenerationTaskError("同一请求 ID 的生成参数不同，未重复提交", 409);
            return publicGenerationTask(existing);
        }
        if (input.canvasTarget) {
            const canvas = await queryOne<{ payload: string }>(tx, "SELECT payload FROM workspace_data WHERE workspace_id = $1 AND domain = 'canvas'", context.id);
            let payload: unknown;
            try { payload = canvas ? JSON.parse(canvas.payload) : null; } catch { throw new GenerationTaskError("画布数据无效", 409); }
            assertCanvasGenerationBinding(payload, input.canvasTarget, input.requestId);
        }
        const channel = await options.resolveChannel(input.model, input.kind);
        if (channel.script) throw new GenerationTaskError("脚本模型使用浏览器执行，不支持服务端持久生成");
        if (input.kind === "audio" && channel.apiFormat === "gemini") throw new GenerationTaskError("Gemini 音频生成暂不支持，请使用现有脚本模型");
        const snapshot: ProviderSnapshot = { id: channel.id, baseUrl: channel.baseUrl, apiFormat: channel.apiFormat, model: channel.model };
        const references: ReferenceSnapshot[] = [];
        for (const reference of input.references) {
            const media = await queryOne<{ object_version: string; mime_type: string; remote_path: string }>(tx, "SELECT object_version, mime_type, remote_path FROM media_files WHERE workspace_id = $1 AND storage_key = $2", context.id, reference.storageKey);
            if (!media || media.remote_path || !media.mime_type.startsWith(`${reference.kind}/`)) throw new GenerationTaskError("参考媒体不存在、类型不符或尚未保存到服务器");
            references.push({ ...reference, objectVersion: media.object_version, mimeType: media.mime_type });
        }
        const submissions = input.kind === "image" || input.kind === "text" ? Array.from({ length: Number(input.settings.count) }, () => ({ status: "queued" })) : [];
        const row = await queryOne<GenerationTaskRow>(tx, `INSERT INTO generation_tasks (id, workspace_id, actor_user_id, request_id, request_hash, kind, request_snapshot, provider_snapshot, status, submissions)
            VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, 'queued', $9::jsonb) RETURNING *`, randomUUID(), context.id, context.userId, input.requestId, hash, input.kind, JSON.stringify({ kind: input.kind, prompt: input.prompt, model: input.model, settings: input.settings, references, ...(input.canvasTarget ? { canvasTarget: input.canvasTarget } : {}) }), JSON.stringify(snapshot), JSON.stringify(submissions));
        await replaceTaskReferences(tx, row!);
        return publicGenerationTask(row!);
    });
}
export async function listGenerationTasks(workspaceId: string, kind?: string, filter: GenerationTaskFilter = {}) {
    if (kind !== undefined && !["image", "video", "text", "audio"].includes(kind)) throw new GenerationTaskError("生成类型无效");
    if (filter.source !== undefined && !["all", "canvas", "workbench"].includes(filter.source)) throw new GenerationTaskError("生成来源无效");
    for (const field of [filter.projectId, filter.nodeId, filter.requestId]) if (field !== undefined && (typeof field !== "string" || !field.trim())) throw new GenerationTaskError("生成任务筛选参数无效");
    const rows = await queryMany<GenerationTaskRow>(await getPool(), `SELECT * FROM generation_tasks WHERE workspace_id = $1 AND (NOT hidden OR $6::text IS NOT NULL)
        AND ($2::text IS NULL OR kind = $2)
        AND ($3::text = 'all' OR ($3::text = 'canvas' AND request_snapshot ? 'canvasTarget') OR ($3::text = 'workbench' AND NOT (request_snapshot ? 'canvasTarget')))
        AND ($4::text IS NULL OR request_snapshot->'canvasTarget'->>'projectId' = $4)
        AND ($5::text IS NULL OR request_snapshot->'canvasTarget'->>'nodeId' = $5)
        AND ($6::text IS NULL OR request_id = $6) ORDER BY created_at DESC, id`, workspaceId, kind || null, filter.source || "all", filter.projectId || null, filter.nodeId || null, filter.requestId || null);
    return rows.map(publicGenerationTask);
}
export async function readGenerationTask(workspaceId: string, id: string) {
    const row = await queryOne<GenerationTaskRow>(await getPool(), "SELECT * FROM generation_tasks WHERE workspace_id = $1 AND id = $2", workspaceId, id);
    if (!row) throw new GenerationTaskError("生成任务不存在或无权访问", 404);
    return publicGenerationTask(row);
}
export async function resumeGenerationTask(context: Context, id: string) {
    return writeScope(context, async (tx) => {
        const row = await queryOne<GenerationTaskRow>(tx, "SELECT * FROM generation_tasks WHERE workspace_id = $1 AND id = $2 FOR UPDATE", context.id, id);
        if (!row) throw new GenerationTaskError("生成任务不存在", 404);
        if (row.status !== "needs_attention" || !["archive_failed", "poll_error", "poll_exhausted", "configuration_changed"].includes(row.error_code || "")) throw new GenerationTaskError("该任务不能安全自动恢复；提交结果不确定时须先核对供应商", 409);
        const status = row.raw_result ? "archiving" : row.upstream ? "running" : row.error_code === "configuration_changed" && row.submissions.every((slot) => slot.status !== "submitting") ? "queued" : "needs_attention";
        if (status === "needs_attention") throw new GenerationTaskError("任务没有可核对的供应商 ID 或已接收结果", 409);
        const updated = await queryOne<GenerationTaskRow>(tx, "UPDATE generation_tasks SET status = $3, error_code = NULL, poll_count = 0, next_poll_at = NULL, revision = revision + 1, updated_at = now() WHERE workspace_id = $1 AND id = $2 RETURNING *", context.id, id, status);
        return publicGenerationTask(updated!);
    });
}
export async function hideGenerationTask(context: Context, id: string) {
    return writeScope(context, async (tx) => {
        const row = await queryOne<GenerationTaskRow>(tx, "SELECT * FROM generation_tasks WHERE workspace_id = $1 AND id = $2 FOR UPDATE", context.id, id);
        if (!row) throw new GenerationTaskError("生成任务不存在", 404);
        if (activeStatuses.includes(row.status)) throw new GenerationTaskError("任务仍在执行，不能删除；关闭网页不会取消生成", 409);
        await execute(tx, "UPDATE generation_tasks SET hidden = TRUE, revision = revision + 1, updated_at = now() WHERE id = $1", id);
    });
}
async function replaceTaskReferences(tx: SqlExecutor, row: GenerationTaskRow) {
    await execute(tx, "DELETE FROM media_references WHERE workspace_id = $1 AND source_domain = 'generation-tasks' AND owner_id = $2", row.workspace_id, row.id);
    const refs = [...row.request_snapshot.references.map((reference, i) => ({ storageKey: reference.storageKey, path: `/references/${i}/storageKey` })), ...row.outputs.map((output, i) => ({ storageKey: output.storageKey, path: `/outputs/${i}/storageKey` }))];
    for (const ref of refs) await execute(tx, `INSERT INTO media_references (workspace_id, storage_key, owner_kind, owner_id, source_domain, source_revision, json_path)
        VALUES ($1, $2, 'generation-task', $3, 'generation-tasks', $4, $5)`, row.workspace_id, ref.storageKey, row.id, row.revision, ref.path);
    if (refs.length) await execute(tx, "UPDATE media_files SET lifecycle_state = 'ready', last_referenced_at = now() WHERE workspace_id = $1 AND storage_key = ANY($2::text[])", row.workspace_id, refs.map((ref) => ref.storageKey));
}

/** A database session lock elects one scheduler; no time-based lease can resubmit an uncertain charge. */
export function createGenerationWorker(options: GenerationTaskOptions) {
    const workerId = randomUUID();
    const provider = { submitImage, submitVideo, pollVideo, downloadOutput, submitText, submitAudio, ...options.provider };
    const active = new Map<string, Promise<void>>();
    let leader: Client | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let ticking = false;
    let controller = new AbortController();
    const owned = () => !stopped && !!leader && !controller.signal.aborted;

    async function change(id: string, patch: Record<string, unknown>) {
        if (!owned()) throw new Error("生成执行器已失去所有权");
        const names = Object.keys(patch);
        const values = Object.values(patch).map((value) => value && typeof value === "object" ? JSON.stringify(value) : value);
        const row = await queryOne<GenerationTaskRow>(await getPool(), `UPDATE generation_tasks SET ${names.map((name, i) => `${name} = $${i + 3}`).join(", ")}, revision = revision + 1, updated_at = now() WHERE id = $1 AND worker_id = $2 RETURNING *`, id, workerId, ...values);
        if (!row) throw new Error("生成任务已由其他执行器接管");
        return row;
    }
    async function archive(row: GenerationTaskRow, channel: ResolvedGenerationChannel) {
        const outputs = [...row.outputs];
        const sources = row.raw_result || [];
        for (let index = 0; index < sources.length; index++) {
            const id = (sources[index] as OutputDescriptor & { resultId?: string }).resultId || `${row.id}-${index}`;
            if (outputs.some((output) => output.id === id)) continue;
            const media = await provider.downloadOutput(channel, sources[index], controller.signal);
            if (!media.bytes.length || media.bytes.length > MEDIA_LIMIT_BYTES || !media.mimeType.startsWith(`${row.kind}/`)) throw new Error("生成媒体类型或大小无效");
            const storageKey = `${row.kind}:${id}`;
            // DB fencing cannot stop an old S3 PUT; every attempt writes its own immutable object.
            const objectVersion = randomUUID();
            const objectKey = mediaObjectKey(row.workspace_id, storageKey, objectVersion);
            const intentId = await withTransaction(async (tx) => {
                await execute(tx, "SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", row.workspace_id);
                const current = await queryOne<{ worker_id: string }>(tx, "SELECT worker_id FROM generation_tasks WHERE id = $1 FOR UPDATE", row.id);
                if (!owned() || current?.worker_id !== workerId) throw new Error("生成执行器已失去所有权");
                // A new elected worker can resolve this task's interrupted upload; keys are deterministic.
                await execute(tx, "UPDATE media_write_intents SET state = 'failed', failure_reason = '持久化生成任务恢复归档', finished_at = now() WHERE workspace_id = $1 AND storage_key = $2 AND state = 'active'", row.workspace_id, storageKey);
                return createMediaIntent(tx, row.workspace_id, row.actor_user_id, storageKey, { operation: "upload", expectedBytes: media.bytes.length, objectKey });
            });
            if (!intentId) throw new Error("生成媒体写入仍被占用");
            try {
                await putMediaBuffer(objectKey, media.bytes, media.mimeType);
                const output: GenerationTaskOutput = { id, storageKey, mimeType: media.mimeType, bytes: media.bytes.length };
                if (row.kind === "image" || row.kind === "text") {
                    const slot = id.slice(`${row.id}-`.length).split("-")[0];
                    if (id.startsWith(`${row.id}-`) && /^\d+$/.test(slot)) output.slotIndex = Number(slot);
                }
                outputs.push(output);
                row = await withTransaction(async (tx) => {
                    await execute(tx, "SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", row.workspace_id);
                    const current = await queryOne<GenerationTaskRow>(tx, "SELECT * FROM generation_tasks WHERE id = $1 FOR UPDATE", row.id);
                    if (!owned() || current?.worker_id !== workerId) throw new Error("生成执行器已失去所有权");
                    await execute(tx, `INSERT INTO media_files (workspace_id, storage_key, remote_path, mime_type, bytes, object_version, content_sha256, lifecycle_state, created_at, updated_at)
                        VALUES ($1,$2,'',$3,$4,$5,$6,'ready',now(),now()) ON CONFLICT(workspace_id, storage_key) DO UPDATE SET object_version=excluded.object_version, mime_type=excluded.mime_type, bytes=excluded.bytes, content_sha256=excluded.content_sha256, updated_at=now()`, row.workspace_id, storageKey, media.mimeType, media.bytes.length, objectVersion, createHash("sha256").update(media.bytes).digest("hex"));
                    await completeMediaIntent(tx, intentId);
                    const updated = await queryOne<GenerationTaskRow>(tx, "UPDATE generation_tasks SET outputs = $3::jsonb, revision = revision + 1, updated_at = now() WHERE id = $1 AND worker_id = $2 RETURNING *", row.id, workerId, JSON.stringify(outputs));
                    await replaceTaskReferences(tx, updated!);
                    return updated!;
                });
            } catch (error) {
                await failMediaIntent(row.workspace_id, intentId).catch(() => undefined);
                throw error;
            }
        }
        const expected = row.kind === "image" ? Number(row.request_snapshot.settings.count || 1) : 1;
        const uncertain = row.submissions.some((slot) => slot.status === "uncertain");
        await change(row.id, { status: uncertain ? "needs_attention" : outputs.length >= expected ? "succeeded" : outputs.length ? "partial" : "failed", error_code: uncertain ? "submission_uncertain" : outputs.length ? null : "provider_failed" });
    }
    async function processTask(id: string, revision: number) {
        const client = leader;
        if (!client || !owned()) return;
        // Claim through the lock-owning connection: an old disconnected scheduler cannot steal a new leader's row.
        let row: GenerationTaskRow | null = (await client.query<GenerationTaskRow>(`UPDATE generation_tasks t SET worker_id = $2 WHERE id = $1 AND revision = $3 AND status IN ('queued','running','archiving')
            AND NOT EXISTS (SELECT 1 FROM backup_runs b WHERE b.workspace_id = t.workspace_id AND b.kind = 'restore' AND b.status = 'running') RETURNING *`, [id, workerId, revision])).rows[0] || null;
        if (!row || !owned()) return;
        try {
            const channel = await options.resolveChannel(row.request_snapshot.model, row.kind, row.provider_snapshot);
            if (row.status === "queued") {
                const permission = await queryOne<{ role: string }>(await getPool(), "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", row.workspace_id, row.actor_user_id);
                if (!permission || permission.role === "viewer") { await change(id, { status: "failed", error_code: "permission_revoked" }); return; }
                const references: GenerationRequest["references"] = [];
                for (const reference of row.request_snapshot.references) {
                    const media = await getMediaObject(mediaObjectKey(row.workspace_id, reference.storageKey, reference.objectVersion));
                    const bytes = await readGenerationBytes(media.body, MEDIA_LIMIT_BYTES, media.contentLength);
                    references.push({ kind: reference.kind, name: reference.name, mimeType: reference.mimeType, bytes });
                }
                const request: GenerationRequest = { kind: row.kind, prompt: row.request_snapshot.prompt, settings: row.request_snapshot.settings, references };
                // Persist intent before the only potentially billable request.
                if (row.kind === "image") {
                    row = await change(id, { status: "submitting", error_code: null });
                    const slots = row.submissions;
                    await Promise.allSettled(slots.map(async (slot, index) => {
                        if (slot.status !== "queued") return;
                        let content = slot.content || "";
                        const setSlot = async (value: ImageSubmission) => {
                            if (!owned()) throw new Error("生成执行器已失去所有权");
                            const save = (tx: SqlExecutor) => queryOne(tx, "UPDATE generation_tasks SET submissions = jsonb_set(submissions, $3::text[], $4::jsonb), revision = revision + 1, updated_at = now() WHERE id = $1 AND worker_id = $2 RETURNING id", id, workerId, [String(index)], JSON.stringify(value));
                            const written = value.status === "submitting" ? await writeScope({ id: row!.workspace_id, userId: row!.actor_user_id, role: "editor" }, save) : await save(await getPool());
                            if (!written || !owned()) throw new Error("生成执行器已失去所有权");
                        };
                        await setSlot({ status: "submitting" });
                        try {
                            if (row!.kind === "text") {
                                const answer = await provider.submitText(channel, { ...request, settings: { ...request.settings, count: 1 } }, async (delta) => {
                                    content = delta;
                                    await setSlot({ status: "submitting", content });
                                }, controller.signal);
                                if (!answer) throw new Error("文本供应商未返回内容");
                                await setSlot({ status: "completed", content: answer });
                            } else {
                                const outputs = await provider.submitImage(channel, { ...request, settings: { ...request.settings, count: 1 } }, controller.signal);
                                await setSlot({ status: "completed", outputs });
                            }
                        } catch {
                            if (owned()) await setSlot({ status: "uncertain", ...(row!.kind === "text" ? { content } : {}) });
                        }
                    }));
                    if (!owned()) return;
                    row = (await queryOne<GenerationTaskRow>(await getPool(), "SELECT * FROM generation_tasks WHERE id = $1 AND worker_id = $2", id, workerId))!;
                    if (row.kind === "text") {
                        const uncertain = row.submissions.some((slot) => slot.status === "uncertain");
                        const completed = row.submissions.filter((slot) => slot.status === "completed").length;
                        await change(id, { status: uncertain ? "needs_attention" : completed === slots.length ? "succeeded" : completed ? "partial" : "failed", error_code: uncertain ? "submission_uncertain" : completed ? null : "provider_failed" });
                        return;
                    }
                    const sources = row.submissions.flatMap((slot, slotIndex) => (slot.outputs || []).map((output, outputIndex) => ({ ...output, resultId: `${id}-${slotIndex}-${outputIndex}` })));
                    row = await change(id, sources.length ? { status: "archiving", raw_result: sources } : { status: "needs_attention", error_code: "submission_uncertain" });
                } else {
                    row = await writeScope({ id: row.workspace_id, userId: row.actor_user_id, role: "editor" }, async (tx) => {
                        const written = await queryOne<GenerationTaskRow>(tx, "UPDATE generation_tasks SET status = 'submitting', error_code = NULL, revision = revision + 1, updated_at = now() WHERE id = $1 AND worker_id = $2 RETURNING *", id, workerId);
                        if (!written || !owned()) throw new Error("生成执行器已失去所有权");
                        return written;
                    });
                    if (row.kind === "audio") {
                        const output = await provider.submitAudio(channel, request, controller.signal);
                        row = await change(id, { status: "archiving", raw_result: [output] });
                    } else {
                        const upstream = await provider.submitVideo(channel, request, controller.signal);
                        row = await change(id, { status: "running", upstream, next_poll_at: new Date().toISOString() });
                    }
                }
            }
            if (row.status === "running") {
                if (row.poll_count >= VIDEO_POLL_ATTEMPTS) { await change(id, { status: "needs_attention", error_code: "poll_exhausted" }); return; }
                // Persist count before querying so a restart does not silently reset the polling window.
                row = await change(id, { poll_count: row.poll_count + 1 });
                const result = await provider.pollVideo(channel, row.upstream!, controller.signal);
                if (result.status === "failed") { await change(id, { status: "failed", error_code: "provider_failed" }); return; }
                if (result.status === "pending") {
                    await change(id, { next_poll_at: new Date(Date.now() + (row.upstream?.provider === "seedance" ? SEEDANCE_POLL_MS : GENERATION_POLL_MS)).toISOString() });
                    return;
                }
                row = await change(id, { status: "archiving", raw_result: [result.output], error_code: null });
            }
            if (row.status === "archiving") await archive(row, channel);
        } catch {
            if (!owned()) return;
            const current = await queryOne<GenerationTaskRow>(await getPool(), "SELECT * FROM generation_tasks WHERE id = $1", id);
            if (!current || current.worker_id !== workerId) return;
            const code = current.status === "submitting" ? "submission_uncertain" : current.status === "archiving" ? "archive_failed" : current.status === "running" ? "poll_error" : "configuration_changed";
            await change(id, { status: "needs_attention", error_code: code });
        }
    }
    async function elect() {
        if (leader || stopped || active.size) return;
        const client = new Client({ connectionString: databaseUrl() });
        client.on("error", () => { if (leader === client) { leader = null; controller.abort(); void client.end().catch(() => undefined); } });
        client.on("end", () => { if (leader === client) { leader = null; controller.abort(); } });
        try {
            await client.connect();
            const result = await client.query("SELECT pg_try_advisory_lock(hashtext('infinite-canvas:generation-worker:' || current_schema())::bigint) AS locked");
            if (!result.rows[0]?.locked || stopped) { await client.end(); return; }
            leader = client;
            controller = new AbortController();
            await client.query(`UPDATE generation_tasks SET status = CASE WHEN status <> 'submitting' THEN status WHEN kind IN ('image','text') THEN 'queued' ELSE 'needs_attention' END,
                error_code = CASE WHEN status <> 'submitting' THEN error_code WHEN kind IN ('image','text') THEN NULL ELSE 'submission_uncertain' END,
                submissions = CASE WHEN status = 'submitting' AND kind IN ('image','text') THEN COALESCE((SELECT jsonb_agg(CASE WHEN item->>'status' = 'submitting' THEN item || jsonb_build_object('status','uncertain') ELSE item END) FROM jsonb_array_elements(submissions) item), '[]'::jsonb) ELSE submissions END,
                worker_id = $1, revision = revision + 1, updated_at = now() WHERE status IN ('queued','submitting','running','archiving')
                AND NOT EXISTS (SELECT 1 FROM backup_runs b WHERE b.workspace_id = generation_tasks.workspace_id AND b.kind = 'restore' AND b.status = 'running')`, [workerId]);
        } catch (error) {
            if (leader === client) { leader = null; controller.abort(); }
            await client.end().catch(() => undefined);
            throw error;
        }
    }
    async function tick() {
        if (stopped || ticking) return;
        ticking = true;
        try {
            await getPool();
            await elect();
            if (!owned()) return;
            await leader!.query("SELECT 1");
            const rows = await queryMany<{ id: string; revision: number }>(await getPool(), `SELECT t.id, t.revision FROM generation_tasks t WHERE t.status IN ('queued','running','archiving')
                AND (t.next_poll_at IS NULL OR t.next_poll_at <= now() OR t.status <> 'running')
                AND NOT EXISTS (SELECT 1 FROM backup_runs b WHERE b.workspace_id = t.workspace_id AND b.kind = 'restore' AND b.status = 'running') ORDER BY t.created_at`);
            for (const row of rows) if (!active.has(row.id)) {
                const pending = processTask(row.id, row.revision).catch(() => undefined).finally(() => active.delete(row.id));
                active.set(row.id, pending);
            }
        } finally { ticking = false; }
    }
    async function scheduled() {
        try { await tick(); } catch { /* Durable rows remain queued; no provider request is retried here. */ }
        if (!stopped) { timer = setTimeout(() => void scheduled(), GENERATION_POLL_MS); timer.unref?.(); }
    }
    return {
        start: () => { stopped = false; void scheduled(); },
        tick,
        stop: async () => {
            stopped = true;
            if (timer) clearTimeout(timer);
            controller.abort();
            await Promise.allSettled([...active.values()]);
            const client = leader;
            leader = null;
            if (client) await client.end().catch(() => undefined);
        },
    };
}
