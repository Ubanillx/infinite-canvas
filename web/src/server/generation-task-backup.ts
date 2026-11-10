import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { downloadOutput, type OutputDescriptor } from "./generation-provider";
import type { GenerationTaskRow } from "./generation-tasks";
import type { ManifestMedia } from "./system-backup";
import { putWebdavBuffer, type WebdavConfig } from "./webdav-client";

export type BackupGenerationTask = Omit<GenerationTaskRow, "workspace_id" | "actor_user_id" | "raw_result" | "worker_id" | "next_poll_at" | "created_at" | "updated_at"> & {
    actorUserId: string; createdAt: string; updatedAt: string; nextPollAt: string | null;
};
export type BackupTaskMedia = ManifestMedia & { historical?: boolean };

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const date = (value: Date) => new Date(value).toISOString();

async function providerKey(provider: GenerationTaskRow["provider_snapshot"]) {
    const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const path = resolve(process.env.INFINITE_CANVAS_DATA_DIR || resolve(process.env.HOME || webDir, ".infinite-canvas/data"), "config.json");
    const stored = JSON.parse(await readFile(path, "utf8")) as { config?: { channels?: Array<{ id: string; baseUrl: string; apiFormat: string; apiKey: string; models?: Array<{ name: string }> }> } };
    const channel = stored.config?.channels?.find((entry) => entry.id === provider.id && entry.apiFormat === provider.apiFormat && entry.models?.some((model) => model.name === provider.model));
    if (!channel?.apiKey || !channel.baseUrl) throw new Error("原供应商渠道不可用，无法归档已返回的结果");
    const url = new URL(channel.baseUrl);
    if (url.username || url.password || url.search || url.hash) throw new Error("供应商渠道地址含凭据");
    let normalized = url.toString().replace(/\/+$/, "");
    const lower = normalized.toLowerCase();
    if (provider.apiFormat === "gemini" && !/\/v1(?:beta)?$/.test(lower)) normalized += "/v1beta";
    else if (provider.apiFormat === "ark" && !/\/(?:api|api\/plan)\/v3$/.test(lower)) normalized += "/api/v3";
    else if (provider.apiFormat !== "gemini" && provider.apiFormat !== "ark" && !lower.endsWith("/v1")) normalized += "/v1";
    if (normalized !== provider.baseUrl) throw new Error("原供应商地址已变化，无法归档已返回的结果");
    return channel.apiKey;
}

export async function backupGenerationTasks(config: WebdavConfig, workspaceId: string, rows: GenerationTaskRow[], errors: string[]) {
    const tasks: BackupGenerationTask[] = [];
    const media: BackupTaskMedia[] = [];
    for (const row of rows) {
        const provider = row.provider_snapshot;
        try {
            const url = new URL(provider.baseUrl);
            if (url.username || url.password || url.search || url.hash || !["http:", "https:"].includes(url.protocol)) throw new Error("渠道地址含凭据或查询参数");
            if (!provider.id || !provider.model || !["openai", "gemini", "ark", "custom"].includes(provider.apiFormat)) throw new Error("渠道元数据无效");
            const submissions = row.submissions.map((slot) => ({ status: slot.status }));
            const outputs = [...row.outputs];
            const known = row.raw_result?.length ? row.raw_result : row.submissions.flatMap((slot, i) => (slot.outputs || []).map((output, j) => ({ ...output, resultId: `${row.id}-${i}-${j}` })));
            for (let i = 0; i < known.length; i++) {
                const descriptor = known[i] as OutputDescriptor & { resultId?: string };
                const id = descriptor.resultId || `${row.id}-${i}`;
                if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("结果标识无效");
                if (outputs.some((output) => output.id === id)) continue;
                const downloaded = await downloadOutput({ ...provider, apiKey: descriptor.kind === "provider" ? await providerKey(provider) : "" }, descriptor);
                if (!downloaded.bytes.length || !downloaded.mimeType.startsWith(`${row.kind}/`)) throw new Error("供应商媒体类型或大小无效");
                const storageKey = `${row.kind}:${id}`;
                const objectVersion = `backup-${sha256(downloaded.bytes)}`;
                const objectPath = `objects/${workspaceId}/media/${sha256(storageKey)}-${objectVersion}`;
                await putWebdavBuffer(config, `system-backups/${objectPath}`, downloaded.bytes, downloaded.mimeType);
                media.push({ storageKey, objectVersion, objectPath, mimeType: downloaded.mimeType, bytes: downloaded.bytes.length,
                    sha256: sha256(downloaded.bytes), createdAt: date(row.created_at), updatedAt: date(row.updated_at), lifecycleState: "ready" });
                const slot = id.slice(row.id.length + 1).split("-")[0];
                const slotIndex = row.kind === "image" && id.startsWith(`${row.id}-`) && /^\d+$/.test(slot) ? Number(slot) : undefined;
                outputs.push({ id, storageKey, mimeType: downloaded.mimeType, bytes: downloaded.bytes.length, ...(slotIndex !== undefined ? { slotIndex } : {}) });
            }
            const uncertain = submissions.some((slot) => slot.status === "submitting" || slot.status === "uncertain") || row.kind === "video" && row.status === "submitting";
            const pending = submissions.some((slot) => slot.status === "queued");
            const expected = row.kind === "image" ? Number(row.request_snapshot.settings.count || 1) : 1;
            let status = row.status;
            let errorCode = row.error_code;
            if (row.kind === "image" && (["queued", "submitting", "archiving"].includes(status) || status === "needs_attention" && !!row.raw_result)) {
                status = uncertain ? "needs_attention" : pending ? "queued" : outputs.length >= expected ? "succeeded" : outputs.length ? "partial" : "failed";
                errorCode = uncertain ? "submission_uncertain" : null;
            } else if (row.kind === "video" && status === "submitting") {
                status = "needs_attention"; errorCode = "submission_uncertain";
            } else if (status === "archiving" && outputs.length) {
                status = "succeeded"; errorCode = null;
            }
            const upstream = row.upstream && typeof row.upstream.id === "string" && /^(?:[A-Za-z0-9_-]+|(?:models\/[A-Za-z0-9_.-]+\/)?operations\/[A-Za-z0-9_/-]+)$/.test(row.upstream.id) && !row.upstream.id.includes("..")
                ? { id: row.upstream.id, provider: row.upstream.provider, model: row.upstream.model, channelId: row.upstream.channelId } : null;
            if (row.status === "running" && !upstream) throw new Error("视频任务缺少可安全核对的供应商 ID");
            tasks.push({ id: row.id, actorUserId: row.actor_user_id, request_id: row.request_id, request_hash: row.request_hash, kind: row.kind,
                request_snapshot: row.request_snapshot, provider_snapshot: { id: provider.id, baseUrl: url.href, apiFormat: provider.apiFormat, model: provider.model },
                status, upstream, outputs, error_code: errorCode, poll_count: row.poll_count, submissions,
                revision: row.revision, hidden: row.hidden, createdAt: date(row.created_at), updatedAt: date(row.updated_at), nextPollAt: row.next_poll_at ? date(row.next_poll_at) : null });
        } catch (error) {
            errors.push(`生成任务 ${row.id}: ${error instanceof Error ? error.message : "结果备份失败"}`);
        }
    }
    return { tasks, media };
}
