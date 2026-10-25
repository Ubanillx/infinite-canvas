import { randomUUID } from "node:crypto";
import { execute, getPool, isoNow, queryMany, type SqlExecutor, withTransaction } from "./db";
import { headMediaObject, isMissingObject, listWorkspaceMediaObjects, mediaObjectKey } from "./object-storage";
import { parseAgentAttachmentManifest } from "../lib/agent/agent-attachment-contract";

export const MEDIA_REFERENCE_DOMAINS = ["canvas", "canvas-templates", "assets", "image-workbench", "video-workbench", "agent-sessions"] as const;
export type MediaReferenceDomain = (typeof MEDIA_REFERENCE_DOMAINS)[number];
export const MEDIA_REFERENCE_PARSER_VERSION = 2;
const storageKeyPattern = /^[a-z][a-z0-9-]*:[A-Za-z0-9_-]+$/;
const mediaFields = new Set(["storageKey", "content", "references", "dataUrl", "url", "coverUrl"]);
const mediaPrefixes = /^(image|video|audio|file|video-reference|audio-reference):/;

export class MediaReferenceError extends Error {}
export type MediaReference = { storageKey: string; ownerKind: string; ownerId: string; path: string };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
function requireShape(valid: unknown, path: string): asserts valid {
    if (!valid) throw new MediaReferenceError(`媒体引用数据格式未知或损坏: ${path}`);
}

// Explicit storageKey fields work for plugins too; unknown media-bearing fields block scans.
function walk(value: unknown, path: string, field: string, ownerKind: string, ownerId: string, refs: MediaReference[]) {
    if (field === "storageKey") requireShape(value == null || typeof value === "string", path);
    if (typeof value === "string") {
        if (field === "storageKey" && value) requireShape(storageKeyPattern.test(value), path);
        if (!storageKeyPattern.test(value) || (!mediaPrefixes.test(value) && field !== "storageKey")) return;
        requireShape(mediaFields.has(field), path);
        refs.push({ storageKey: value, ownerKind, ownerId, path });
    } else if (Array.isArray(value)) {
        value.forEach((item, index) => walk(item, `${path}/${index}`, field, ownerKind, ownerId, refs));
    } else if (record(value)) {
        for (const [key, child] of Object.entries(value)) {
            const pointer = key.replace(/~/g, "~0").replace(/\//g, "~1");
            walk(child, `${path}/${pointer}`, key, ownerKind, ownerId, refs);
        }
    }
}

export function extractMediaReferences(domain: string, payload: unknown): MediaReference[] {
    requireShape(MEDIA_REFERENCE_DOMAINS.includes(domain as MediaReferenceDomain), domain);
    requireShape(record(payload), domain);
    const refs: MediaReference[] = [];
    let entries: unknown;
    let path: string;
    let kind: string;
    switch (domain) {
        case "canvas":
            requireShape(payload.version === undefined || payload.version === 0, domain);
            requireShape(record(payload.state), `${domain}/state`);
            entries = payload.state.projects; path = "/state/projects"; kind = "canvas"; break;
        case "canvas-templates":
            requireShape(payload.version === 1, domain);
            entries = payload.templates; path = "/templates"; kind = "template"; break;
        case "assets":
            requireShape(payload.version === undefined || payload.version === 0, domain);
            requireShape(record(payload.state), `${domain}/state`);
            entries = payload.state.assets; path = "/state/assets"; kind = "asset"; break;
        case "image-workbench": case "video-workbench":
            requireShape(payload.version === undefined, domain);
            entries = payload.logs; path = "/logs"; kind = domain === "image-workbench" ? "image-log" : "video-log"; break;
        default: {
            try {
                const manifest = parseAgentAttachmentManifest(payload);
                return manifest.sessions.flatMap((session, i) => session.messages.flatMap((message, j) => message.attachments.map((attachment, k) => ({
                    storageKey: attachment.storageKey, ownerKind: "agent-session", ownerId: session.id,
                    path: `/sessions/${i}/messages/${j}/attachments/${k}/storageKey`,
                }))));
            } catch { throw new MediaReferenceError("Agent 附件清单格式未知或损坏"); }
        }
    }
    requireShape(Array.isArray(entries), `${domain}${path}`);
    const ids = new Set<string>();
    entries.forEach((entry, index) => {
        const entryPath = `${path}/${index}`;
        requireShape(record(entry) && typeof entry.id === "string" && entry.id && !ids.has(entry.id), `${domain}${entryPath}`);
        ids.add(entry.id);
        if (domain === "canvas" || domain === "canvas-templates") {
            const graph = domain === "canvas" ? entry : entry.content;
            requireShape(record(graph) && Array.isArray(graph.nodes) && Array.isArray(graph.connections), `${domain}${entryPath}/nodes`);
            requireShape(graph.nodes.every((node: unknown) => record(node) && typeof node.id === "string" && (!node.metadata || record(node.metadata))), `${domain}${entryPath}/nodes`);
            if (domain === "canvas-templates") requireShape(record(entry.cover) && typeof entry.cover.storageKey === "string" && storageKeyPattern.test(entry.cover.storageKey), `${domain}${entryPath}/cover`);
        }
        walk(entry, entryPath, "", kind, entry.id, refs);
    });
    // Protect media in future root fields instead of silently interpreting the domain as empty.
    const all: MediaReference[] = [];
    walk(payload, "", "", kind, domain, all);
    const known = new Set(refs.map((ref) => ref.path));
    requireShape(all.every((ref) => known.has(ref.path)), domain);
    return refs.map((ref) => domain === "canvas-templates" && ref.path.endsWith("/cover/storageKey") ? { ...ref, ownerKind: "template-cover" } : ref);
}

export async function replaceDomainMediaReferences(db: SqlExecutor, workspaceId: string, domain: string, refs: MediaReference[], revision: number, scanId: string | null = null) {
    await execute(db, "DELETE FROM media_references WHERE workspace_id = $1 AND source_domain = $2", workspaceId, domain);
    if (!refs.length) return;
    await execute(db, `INSERT INTO media_references (workspace_id, storage_key, owner_kind, owner_id, source_domain, source_revision, json_path, scan_id)
        SELECT $1, r."storageKey", r."ownerKind", r."ownerId", $2, $3, r.path, $4
        FROM jsonb_to_recordset($5::jsonb) AS r("storageKey" text, "ownerKind" text, "ownerId" text, path text)`,
    workspaceId, domain, revision, scanId, JSON.stringify(refs));
    await execute(db, "UPDATE media_files SET lifecycle_state = 'ready', last_referenced_at = now() WHERE workspace_id = $1 AND storage_key = ANY($2::text[])", workspaceId, [...new Set(refs.map((ref) => ref.storageKey))]);
}

type DomainRow = { domain: string; payload: string; revision: number };
type MediaRow = { storage_key: string; remote_path: string; bytes: string; lifecycle_state: string; updated_at: Date };
type IntentRow = { intent_id: string; storage_key: string; operation: string; state: string; expected_bytes: string | null; created_at: Date; finished_at: Date | null };
const revisionMap = (rows: DomainRow[]) => Object.fromEntries(rows.map((row) => [row.domain, row.revision]));
const mediaStamp = (rows: MediaRow[]) => JSON.stringify(rows);

export async function runMediaGcDryRun(workspaceId: string, inspectObject = headMediaObject, listObjects = listWorkspaceMediaObjects) {
    await getPool();
    const scanId = randomUUID();
    const startedAt = isoNow();
    const snapshot = await withTransaction(async (tx) => {
        await execute(tx, "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        return { domains: await readDomains(tx, workspaceId), media: await readMedia(tx, workspaceId), intents: await readIntents(tx, workspaceId) };
    });
    const domainRevisions = revisionMap(snapshot.domains);
    const diagnostics: Array<{ domain?: string; storageKey?: string; reason: string }> = [];
    const parsed: Array<{ domain: string; revision: number; refs: MediaReference[] }> = [];
    for (const row of snapshot.domains) {
        try { parsed.push({ domain: row.domain, revision: row.revision, refs: extractMediaReferences(row.domain, JSON.parse(row.payload)) }); }
        catch (error) { diagnostics.push({ domain: row.domain, reason: error instanceof MediaReferenceError ? error.message : "媒体数据域 JSON 无效" }); }
    }
    const refs = parsed.flatMap((entry) => entry.refs);
    const referenced = new Set(refs.map((ref) => ref.storageKey));
    const indexed = new Set(snapshot.media.map((file) => file.storage_key));
    const active = snapshot.intents.filter((intent) => intent.state === "active");
    if (active.length) diagnostics.push({ reason: "存在未完成的媒体写入租约，不推断超时或删除资格" });
    let objects: Awaited<ReturnType<typeof listObjects>> = [];
    try { objects = await listObjects(workspaceId); }
    catch { diagnostics.push({ reason: "工作区对象列表读取失败或分页不完整" }); }
    for (const key of referenced) if (!indexed.has(key)) diagnostics.push({ storageKey: key, reason: "权威数据引用的媒体没有服务器索引" });
    if (!diagnostics.length) {
        for (const file of snapshot.media) {
            if (file.remote_path) continue;
            try {
                const object = await inspectObject(mediaObjectKey(workspaceId, file.storage_key));
                if (object.contentLength !== Number(file.bytes)) diagnostics.push({ storageKey: file.storage_key, reason: "对象大小与服务器索引不一致" });
                const listed = objects.find((entry) => entry.objectKey === mediaObjectKey(workspaceId, file.storage_key));
                if (!listed || listed.bytes !== object.contentLength || (object.eTag && listed.eTag !== object.eTag)) diagnostics.push({ storageKey: file.storage_key, reason: "对象列表与 HEAD 结果不一致" });
            } catch (error) {
                diagnostics.push({ storageKey: file.storage_key, reason: isMissingObject(error) ? "服务器索引对应的对象不存在" : "对象存储检查失败" });
            }
        }
    }
    try {
        if (JSON.stringify(await listObjects(workspaceId)) !== JSON.stringify(objects)) diagnostics.push({ reason: "扫描期间工作区对象列表已变化，请重新扫描" });
    } catch { diagnostics.push({ reason: "工作区对象列表复核失败" }); }
    const knownObjects = new Set(snapshot.media.filter((file) => !file.remote_path).map((file) => mediaObjectKey(workspaceId, file.storage_key)));
    const unindexedObjects = objects.filter((object) => !knownObjects.has(object.objectKey)).map((object) => {
        const intent = [...snapshot.intents].reverse().find((entry) => mediaObjectKey(workspaceId, entry.storage_key) === object.objectKey);
        return { ...object, storageKey: intent?.storage_key ?? null, intentId: intent?.intent_id ?? null, intentState: intent?.state ?? null, eligibleForDeletion: false };
    });
    return withTransaction(async (tx) => {
        // All authoritative domain/media-index writers take this same lock, only at DB commit time.
        await execute(tx, "SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", workspaceId);
        if (JSON.stringify(revisionMap(await readDomains(tx, workspaceId))) !== JSON.stringify(domainRevisions) || mediaStamp(await readMedia(tx, workspaceId)) !== mediaStamp(snapshot.media) || JSON.stringify(await readIntents(tx, workspaceId)) !== JSON.stringify(snapshot.intents)) diagnostics.push({ reason: "扫描期间数据、媒体索引或写入租约已改变，请重新扫描" });
        const succeeded = diagnostics.length === 0;
        const candidates = succeeded ? snapshot.media.filter((file) => !file.remote_path && !referenced.has(file.storage_key)).map((file) => ({ storageKey: file.storage_key, bytes: Number(file.bytes), lifecycleState: file.lifecycle_state, eligibleForDeletion: false })) : [];
        const report = {
            scanId, workspaceId, mode: "dry-run", status: succeeded ? "succeeded" : "blocked", deletionEnabled: false,
            scope: "workspace-prefix-reconciliation", parserVersion: MEDIA_REFERENCE_PARSER_VERSION, domainRevisions,
            reconciliation: { complete: succeeded, prefix: `media/${workspaceId}/`, objectCount: objects.length, unindexedObjects, writeIntents: snapshot.intents },
            referenceCount: refs.length, referencedObjectCount: referenced.size, candidates, diagnostics, startedAt, finishedAt: isoNow(),
        };
        if (succeeded) {
            await execute(tx, "DELETE FROM media_references WHERE workspace_id = $1", workspaceId);
            for (const entry of parsed) await replaceDomainMediaReferences(tx, workspaceId, entry.domain, entry.refs, entry.revision, scanId);
        }
        await execute(tx, `INSERT INTO media_reference_scans (scan_id, workspace_id, parser_version, status, report, started_at, finished_at)
            VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`, scanId, workspaceId, MEDIA_REFERENCE_PARSER_VERSION, report.status, JSON.stringify(report), startedAt, report.finishedAt);
        return report;
    });
}

function readDomains(db: SqlExecutor, workspaceId: string) {
    return queryMany<DomainRow>(db, "SELECT domain, payload, revision FROM workspace_data WHERE workspace_id = $1 ORDER BY domain", workspaceId);
}
function readMedia(db: SqlExecutor, workspaceId: string) {
    return queryMany<MediaRow>(db, "SELECT storage_key, remote_path, bytes, lifecycle_state, updated_at FROM media_files WHERE workspace_id = $1 ORDER BY storage_key", workspaceId);
}
function readIntents(db: SqlExecutor, workspaceId: string) {
    return queryMany<IntentRow>(db, "SELECT intent_id, storage_key, operation, state, expected_bytes, created_at, finished_at FROM media_write_intents WHERE workspace_id = $1 ORDER BY created_at, intent_id", workspaceId);
}
