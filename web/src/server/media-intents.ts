import { randomUUID } from "node:crypto";
import { execute, queryOne, withTransaction, type SqlExecutor } from "./db";

export type MediaIntentInput = { operation: "upload" | "copy"; sourceKey?: string; expectedBytes: number | null };

// The caller holds the workspace lock and has rechecked the actor's write membership.
export async function createMediaIntent(tx: SqlExecutor, workspaceId: string, userId: string, key: string, input: MediaIntentInput) {
    const busy = await queryOne(tx, `SELECT 1 FROM media_write_intents WHERE workspace_id = $1 AND state = 'active'
        AND (storage_key = $2 OR source_key = $2 OR (storage_key = $3 AND operation = 'upload'))`, workspaceId, key, input.sourceKey ?? null);
    if (busy) return null;
    const intentId = randomUUID();
    const row = await queryOne(tx, `INSERT INTO media_write_intents (intent_id, workspace_id, storage_key, operation, source_key, expected_bytes, created_by, state)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'active') ON CONFLICT (workspace_id, storage_key) WHERE state = 'active' DO NOTHING RETURNING intent_id`,
    intentId, workspaceId, key, input.operation, input.sourceKey ?? null, input.expectedBytes, userId);
    return row ? intentId : null;
}

export async function completeMediaIntent(tx: SqlExecutor, intentId: string) {
    const row = await queryOne(tx, "UPDATE media_write_intents SET state = 'completed', finished_at = now() WHERE intent_id = $1 AND state = 'active' RETURNING intent_id", intentId);
    if (!row) throw new Error("媒体写入租约已失效，索引未提交");
}

export async function failMediaIntent(workspaceId: string, intentId: string) {
    // Server-owned cleanup of this attempt does not need a now-revoked browser membership.
    // No expiry is inferred: a crash leaves an active lease and blocks collection.
    await withTransaction(async (tx) => {
        await execute(tx, "SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", workspaceId);
        await execute(tx, "UPDATE media_write_intents SET state = 'failed', failure_reason = '对象写入或索引提交未完成', finished_at = now() WHERE workspace_id = $1 AND intent_id = $2 AND state = 'active'", workspaceId, intentId);
    });
}
