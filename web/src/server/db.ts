import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { Pool, type PoolClient } from "pg";

export type SqlExecutor = { query: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]> };

export type DbUser = { id: string; username: string; displayName: string; createdAt: string };
export type SessionUser = DbUser & { sessionTokenHash: string };

let executorPromise: Promise<SqlExecutor> | undefined;
let poolInstance: Pool | undefined;

export function databaseUrl() {
    return process.env.DATABASE_URL || "postgres://infinite:infinite_canvas_dev@127.0.0.1:5433/infinite_canvas";
}

/** pg 的 Pool/Client.query 返回 QueryResult；统一包成只返回行的执行器。 */
function toExecutor(source: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }): SqlExecutor {
    return { query: async (sql, params) => (await source.query(sql, params ?? [])).rows as Record<string, unknown>[] };
}

function rawPool() {
    if (!poolInstance) poolInstance = new Pool({ connectionString: databaseUrl(), max: 10 });
    return poolInstance;
}

export async function getPool(): Promise<SqlExecutor> {
    if (!executorPromise) {
        executorPromise = (async () => {
            const pool = rawPool();
            // 只建一次表；并发首连时复用同一个 promise，避免重复 DDL。
            await ensureSchema(pool);
            return toExecutor(pool);
        })();
    }
    return executorPromise;
}

async function ensureSchema(pool: Pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            display_name TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL,
            last_seen_at TIMESTAMPTZ NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workspaces (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workspace_members (
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
            created_at TIMESTAMPTZ NOT NULL,
            PRIMARY KEY (workspace_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS workspace_invites (
            token_hash TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
            created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL,
            used_at TIMESTAMPTZ
        );
        CREATE TABLE IF NOT EXISTS workspace_data (
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            domain TEXT NOT NULL,
            payload TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT 1,
            updated_at TIMESTAMPTZ NOT NULL,
            updated_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
            PRIMARY KEY (workspace_id, domain)
        );
        CREATE TABLE IF NOT EXISTS workspace_prompts (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            prompt TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            tags TEXT NOT NULL DEFAULT '[]',
            shared BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workspace_prompt_images (
            prompt_id TEXT PRIMARY KEY REFERENCES workspace_prompts(id) ON DELETE CASCADE,
            mime_type TEXT NOT NULL,
            image BYTEA NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_workspace_prompts_scope ON workspace_prompts(workspace_id, updated_at);
        CREATE INDEX IF NOT EXISTS idx_workspace_prompts_shared ON workspace_prompts(shared, updated_at);
        CREATE TABLE IF NOT EXISTS media_files (
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            storage_key TEXT NOT NULL,
            remote_path TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            bytes BIGINT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL,
            PRIMARY KEY (workspace_id, storage_key)
        );
        ALTER TABLE media_files ADD COLUMN IF NOT EXISTS lifecycle_state TEXT NOT NULL DEFAULT 'staged' CHECK (lifecycle_state IN ('staged', 'ready'));
        ALTER TABLE media_files ADD COLUMN IF NOT EXISTS last_referenced_at TIMESTAMPTZ;
        CREATE TABLE IF NOT EXISTS media_write_intents (
            intent_id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            storage_key TEXT NOT NULL,
            operation TEXT NOT NULL CHECK (operation IN ('upload', 'copy')),
            source_key TEXT,
            expected_bytes BIGINT,
            created_by TEXT NOT NULL REFERENCES users(id),
            state TEXT NOT NULL CHECK (state IN ('active', 'completed', 'failed')),
            failure_reason TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            finished_at TIMESTAMPTZ
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_media_active_write ON media_write_intents(workspace_id, storage_key) WHERE state = 'active';
        CREATE TABLE IF NOT EXISTS media_references (
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            storage_key TEXT NOT NULL,
            owner_kind TEXT NOT NULL,
            owner_id TEXT NOT NULL,
            source_domain TEXT NOT NULL,
            source_revision INTEGER NOT NULL,
            json_path TEXT NOT NULL,
            scan_id TEXT,
            observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (workspace_id, source_domain, owner_kind, owner_id, json_path)
        );
        CREATE INDEX IF NOT EXISTS idx_media_references_key ON media_references(workspace_id, storage_key);
        CREATE TABLE IF NOT EXISTS media_reference_scans (
            scan_id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            parser_version INTEGER NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('succeeded', 'blocked')),
            report JSONB NOT NULL,
            started_at TIMESTAMPTZ NOT NULL,
            finished_at TIMESTAMPTZ NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users(lower(username));
        CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
        CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(user_id);
        CREATE INDEX IF NOT EXISTS idx_workspace_invites_workspace ON workspace_invites(workspace_id);
    `);
}

/** 事务回调只在同一连接内执行，避免用连接池时语句散落到不同连接。 */
export async function withTransaction<T>(callback: (client: SqlExecutor) => Promise<T>) {
    const client: PoolClient = await rawPool().connect();
    const executor = toExecutor(client);
    try {
        await client.query("BEGIN");
        const result = await callback(executor);
        await client.query("COMMIT");
        return result;
    } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
    } finally {
        client.release();
    }
}

export async function queryOne<T>(db: SqlExecutor, sql: string, ...params: unknown[]) {
    const rows = await db.query(sql, params);
    return (rows[0] as T) ?? null;
}

export async function queryMany<T>(db: SqlExecutor, sql: string, ...params: unknown[]) {
    return (await db.query(sql, params)) as T[];
}

export async function execute(db: SqlExecutor, sql: string, ...params: unknown[]) {
    await db.query(sql, params);
}

export function newId() {
    return randomUUID();
}

export function newSessionToken() {
    return randomBytes(32).toString("base64url");
}

export async function hashToken(value: string) {
    const { createHash } = await import("node:crypto");
    return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function findSessionUser(db: SqlExecutor, token: string) {
    const tokenHash = await hashToken(token);
    const row = await queryOne<{ id: string; username: string; display_name: string; created_at: Date; token_hash: string }>(
        db,
        `SELECT u.id, u.username, u.display_name, u.created_at, s.token_hash
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > now() LIMIT 1`,
        tokenHash,
    );
    if (!row) return null;
    await execute(db, "UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1", tokenHash);
    return { id: row.id, username: row.username, displayName: row.display_name, createdAt: toIso(row.created_at), sessionTokenHash: row.token_hash } satisfies SessionUser;
}

export function hashPassword(password: string) {
    const salt = randomBytes(16).toString("base64url");
    const derived = scryptSync(password, salt, 64).toString("base64url");
    return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, encoded: string) {
    const [, salt, expected] = encoded.split("$");
    if (!salt || !expected) return false;
    const actual = scryptSync(password, salt, 64);
    const target = Buffer.from(expected, "base64url");
    return actual.length === target.length && timingSafeEqual(actual, target);
}

export function isoNow() {
    return new Date().toISOString();
}

export function toIso(value: Date | string) {
    return value instanceof Date ? value.toISOString() : value;
}

export function parseJson<T>(value: string, fallback: T) {
    try {
        return JSON.parse(value) as T;
    } catch {
        return fallback;
    }
}
