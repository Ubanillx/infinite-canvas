import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { Pool, type PoolClient } from "pg";

import { localLoginAllowed } from "./keycloak";

export type SqlExecutor = { query: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]> };

export type DbUser = { id: string; username: string; displayName: string; isAdmin: boolean; createdAt: string; email?: string | null; emailVerifiedAt?: string | null; hasPassword?: boolean };
export type SessionUser = DbUser & { sessionTokenHash: string; hasPassword: boolean };
export type SsoIdentity = { provider: string; subject: string; username: string; displayName: string; email?: string; emailVerified?: boolean; emailVerifiedMissing?: boolean };
export type UserIdentity = { provider: string; email: string | null; displayName: string | null; createdAt: string; lastLoginAt: string | null };

export class SsoBindingError extends Error {
    constructor(public code: "user_missing" | "identity_taken" | "already_bound" | "email_missing" | "email_verified_missing" | "email_unverified" | "local_email_missing" | "email_mismatch", message: string) {
        super(message);
    }
}

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
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        // 多进程首连同一数据库时串行初始化，避免 IF NOT EXISTS 的系统目录竞争。
        await client.query("SELECT pg_advisory_xact_lock(hashtext('infinite-canvas:schema:' || current_schema())::bigint)");
        await client.query(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            display_name TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL
        );
        ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users(lower(email)) WHERE email IS NOT NULL;
        CREATE TABLE IF NOT EXISTS registration_settings (
            id TEXT PRIMARY KEY,
            value JSONB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS registration_email_codes (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL,
            code_hash TEXT NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            sent_at TIMESTAMPTZ NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            used_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS idx_registration_email_sent ON registration_email_codes(email, sent_at);
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL,
            last_seen_at TIMESTAMPTZ NOT NULL
        );
        ALTER TABLE sessions ADD COLUMN IF NOT EXISTS id_token TEXT;
        CREATE TABLE IF NOT EXISTS user_identities (
            provider TEXT NOT NULL,
            subject TEXT NOT NULL,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL,
            PRIMARY KEY (provider, subject)
        );
        CREATE TABLE IF NOT EXISTS user_preferences (
            user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            preferences JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL
        );
        ALTER TABLE user_identities ADD COLUMN IF NOT EXISTS email TEXT;
        ALTER TABLE user_identities ADD COLUMN IF NOT EXISTS display_name TEXT;
        ALTER TABLE user_identities ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
        CREATE TABLE IF NOT EXISTS workspaces (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL
        );
        ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS data_restored_at TIMESTAMPTZ;
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
        ALTER TABLE media_files ADD COLUMN IF NOT EXISTS object_version TEXT NOT NULL DEFAULT '';
        ALTER TABLE media_files ADD COLUMN IF NOT EXISTS content_sha256 TEXT NOT NULL DEFAULT '';
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
        ALTER TABLE media_write_intents ADD COLUMN IF NOT EXISTS object_key TEXT NOT NULL DEFAULT '';
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
        CREATE TABLE IF NOT EXISTS backup_settings (
            id TEXT PRIMARY KEY,
            enabled BOOLEAN NOT NULL DEFAULT FALSE,
            interval_minutes INTEGER NOT NULL DEFAULT 1440,
            retention INTEGER NOT NULL DEFAULT 30,
            safety_retention INTEGER NOT NULL DEFAULT 5,
            updated_at TIMESTAMPTZ NOT NULL
        );
        CREATE TABLE IF NOT EXISTS backup_runs (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL CHECK (kind IN ('backup', 'restore')),
            purpose TEXT NOT NULL CHECK (purpose IN ('manual', 'scheduled', 'pre-restore')),
            status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed', 'cancelled')),
            backup_id TEXT,
            workspace_id TEXT,
            actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
            started_at TIMESTAMPTZ NOT NULL,
            finished_at TIMESTAMPTZ,
            heartbeat_at TIMESTAMPTZ NOT NULL,
            summary JSONB,
            error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_backup_runs_started ON backup_runs(started_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users(lower(username));
        CREATE INDEX IF NOT EXISTS idx_user_identities_user ON user_identities(user_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_user_identities_user_provider ON user_identities(user_id, provider);
        CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
        CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(user_id);
        CREATE INDEX IF NOT EXISTS idx_workspace_invites_workspace ON workspace_invites(workspace_id);
    `);
        await ensureAdminBootstrap(client);
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
    } finally { client.release(); }
}

/** 环境变量列出的用户名始终保留管理员身份，便于统一登录或应急恢复。 */
export function configuredAdminUsernames() {
    return (process.env.INFINITE_CANVAS_ADMIN_USERNAMES || "")
        .split(",")
        .map((username) => username.trim().toLowerCase())
        .filter(Boolean);
}

export function isConfiguredAdmin(username: string) {
    return configuredAdminUsernames().includes(username.trim().toLowerCase());
}

async function ensureAdminBootstrap(pool: Pool | PoolClient) {
    const usernames = configuredAdminUsernames();
    if (usernames.length) await pool.query("UPDATE users SET is_admin = TRUE WHERE lower(username) = ANY($1::text[])", [usernames]);
    // 没有管理员时提升最早可登录的用户；仅统一登录时跳过无法再登录的旧本地账号。
    const firstEligibleUser = localLoginAllowed()
        ? "SELECT id FROM users ORDER BY created_at, id LIMIT 1"
        : "SELECT u.id FROM users u JOIN user_identities i ON i.user_id = u.id ORDER BY u.created_at, u.id LIMIT 1";
    await pool.query(`UPDATE users SET is_admin = TRUE WHERE id = (${firstEligibleUser}) AND NOT EXISTS (SELECT 1 FROM users WHERE is_admin)`);
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

/** 同一事务内读取多个查询时使用固定快照，避免备份清单跨语句看到不同版本。 */
export async function withReadSnapshot<T>(callback: (client: SqlExecutor) => Promise<T>) {
    return withTransaction(async (tx) => {
        await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        return callback(tx);
    });
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

export async function findSessionUser(db: SqlExecutor, token: string, ssoOnly = false) {
    const tokenHash = await hashToken(token);
    const row = await queryOne<{ id: string; username: string; display_name: string; is_admin: boolean; created_at: Date; token_hash: string; email: string | null; email_verified_at: Date | null; password_hash: string }>(
        db,
        `SELECT u.id, u.username, u.display_name, u.is_admin, u.created_at, u.email, u.email_verified_at, u.password_hash, s.token_hash
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > now() AND ($2 = FALSE OR s.id_token IS NOT NULL) LIMIT 1`,
        tokenHash,
        ssoOnly,
    );
    if (!row) return null;
    await execute(db, "UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1", tokenHash);
    return { id: row.id, username: row.username, displayName: row.display_name, isAdmin: row.is_admin, createdAt: toIso(row.created_at), email: row.email, emailVerifiedAt: row.email_verified_at ? toIso(row.email_verified_at) : null, hasPassword: Boolean(row.password_hash), sessionTokenHash: row.token_hash } satisfies SessionUser;
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

function ssoUsername(value: string) {
    const cleaned = value
        .normalize("NFKC")
        .replace(/[^\p{L}\p{N}._-]+/gu, "_")
        .replace(/^[._-]+|[._-]+$/g, "")
        .slice(0, 64)
        .replace(/[._-]+$/g, "");
    return cleaned.length >= 3 ? cleaned : `sso_${randomUUID().slice(0, 8)}`;
}

async function availableUsername(tx: SqlExecutor, base: string) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const suffix = attempt ? `-${attempt + 1}` : "";
        const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
        if (!(await queryOne(tx, "SELECT 1 FROM users WHERE lower(username) = lower($1)", candidate))) return candidate;
    }
    return `sso_${randomUUID().slice(0, 8)}`;
}

function normalizedEmail(value?: string | null) {
    return (value || "").trim().toLowerCase();
}

export async function findOrCreateSsoUser(identity: SsoIdentity) {
    return withTransaction(async (tx) => {
        const now = isoNow();
        await execute(tx, "SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", `${identity.provider}:${identity.subject}`);
        await execute(tx, "SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", "infinite-canvas:first-user");
        const existing = await queryOne<{ id: string; username: string; display_name: string; is_admin: boolean; created_at: Date; password_hash: string }>(
            tx,
            `SELECT u.id, u.username, u.display_name, u.is_admin, u.created_at, u.password_hash
             FROM user_identities i JOIN users u ON u.id = i.user_id
             WHERE i.provider = $1 AND i.subject = $2`,
            identity.provider,
            identity.subject,
        );
        if (existing) {
            await execute(tx, "UPDATE user_identities SET email = COALESCE($3, email), display_name = COALESCE($4, display_name), last_login_at = $5 WHERE provider = $1 AND subject = $2", identity.provider, identity.subject, identity.email?.trim() || null, identity.displayName.trim() || null, now);
            return { id: existing.id, username: existing.username, displayName: existing.display_name, isAdmin: existing.is_admin, createdAt: toIso(existing.created_at), hasPassword: Boolean(existing.password_hash) } satisfies DbUser;
        }

        if (!identity.email || !identity.emailVerified) throw new Error("New SSO accounts require a verified email");

        const displayName = (identity.displayName.trim() || identity.username).slice(0, 80);
        const username = await availableUsername(tx, ssoUsername(identity.username));
        const workspaceName = `${displayName.slice(0, 76)}的工作区`;
        const userId = newId();
        const workspaceId = newId();
        const firstUser = !(await queryOne(tx, "SELECT 1 FROM users LIMIT 1"));
        const firstSsoUser = !(await queryOne(tx, "SELECT 1 FROM user_identities LIMIT 1"));
        const isAdmin = isConfiguredAdmin(username) || (localLoginAllowed() ? firstUser : firstSsoUser);
        // 统一登录用户没有本地密码，空哈希会让 verifyPassword 始终失败。
        await execute(tx, "INSERT INTO users (id, username, display_name, password_hash, is_admin, created_at, email, email_verified_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $6)", userId, username, displayName, "", isAdmin, now, identity.email);
        await execute(tx, "INSERT INTO workspaces (id, name, owner_user_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)", workspaceId, workspaceName, userId, now, now);
        await execute(tx, "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'owner', $3)", workspaceId, userId, now);
        await execute(tx, "INSERT INTO user_identities (provider, subject, user_id, created_at, email, display_name, last_login_at) VALUES ($1, $2, $3, $4, $5, $6, $4)", identity.provider, identity.subject, userId, now, identity.email, displayName);
        return { id: userId, username, displayName, isAdmin, createdAt: now, hasPassword: false } satisfies DbUser;
    });
}

export async function readUserPreferences(db: SqlExecutor, userId: string) {
    const row = await queryOne<{ preferences: unknown }>(db, "SELECT preferences FROM user_preferences WHERE user_id = $1", userId);
    const preferences = row?.preferences;
    return preferences && typeof preferences === "object" && !Array.isArray(preferences) ? (preferences as Record<string, unknown>) : {};
}

export async function saveUserPreferences(db: SqlExecutor, userId: string, preferences: Record<string, unknown>) {
    await execute(db, "INSERT INTO user_preferences (user_id, preferences, updated_at) VALUES ($1, $2::jsonb, $3) ON CONFLICT (user_id) DO UPDATE SET preferences = EXCLUDED.preferences, updated_at = EXCLUDED.updated_at", userId, JSON.stringify(preferences), isoNow());
}

export async function listUserIdentities(db: SqlExecutor, userId: string) {
    const rows = await queryMany<{ provider: string; email: string | null; display_name: string | null; created_at: Date; last_login_at: Date | null }>(
        db,
        "SELECT provider, email, display_name, created_at, last_login_at FROM user_identities WHERE user_id = $1 ORDER BY created_at",
        userId,
    );
    return rows.map((row) => ({ provider: row.provider, email: row.email, displayName: row.display_name, createdAt: toIso(row.created_at), lastLoginAt: row.last_login_at ? toIso(row.last_login_at) : null })) satisfies UserIdentity[];
}

export async function bindSsoIdentity(userId: string, identity: SsoIdentity) {
    return withTransaction(async (tx) => {
        const now = isoNow();
        await execute(tx, "SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", `${identity.provider}:${identity.subject}`);
        await execute(tx, "SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", `user-identity:${userId}:${identity.provider}`);
        const owner = await queryOne<{ user_id: string }>(tx, "SELECT user_id FROM user_identities WHERE provider = $1 AND subject = $2", identity.provider, identity.subject);
        if (owner && owner.user_id !== userId) throw new SsoBindingError("identity_taken", "This SSO identity is already bound to another user");
        const current = await queryOne<{ subject: string }>(tx, "SELECT subject FROM user_identities WHERE user_id = $1 AND provider = $2", userId, identity.provider);
        if (current && current.subject !== identity.subject) throw new SsoBindingError("already_bound", "This user already has a different SSO identity");
        if (!identity.email) throw new SsoBindingError("email_missing", "The SSO profile has no email");
        if (identity.emailVerifiedMissing) throw new SsoBindingError("email_verified_missing", "The SSO provider did not return an email verification claim");
        if (!identity.emailVerified) throw new SsoBindingError("email_unverified", "The SSO email is not verified");
        const user = await queryOne<{ email: string | null; email_verified_at: Date | null }>(tx, "SELECT email, email_verified_at FROM users WHERE id = $1", userId);
        if (!user) throw new SsoBindingError("user_missing", "The local user no longer exists");
        if (!user.email || !user.email_verified_at) throw new SsoBindingError("local_email_missing", "The local account has no verified email");
        if (normalizedEmail(user.email) !== normalizedEmail(identity.email)) throw new SsoBindingError("email_mismatch", "The SSO email does not match the local verified email");
        const displayName = identity.displayName.trim().slice(0, 80) || null;
        if (owner) {
            await execute(tx, "UPDATE user_identities SET email = $3, display_name = $4, last_login_at = $5 WHERE provider = $1 AND subject = $2", identity.provider, identity.subject, identity.email, displayName, now);
        } else {
            await execute(tx, "INSERT INTO user_identities (provider, subject, user_id, created_at, email, display_name, last_login_at) VALUES ($1, $2, $3, $4, $5, $6, $4)", identity.provider, identity.subject, userId, now, identity.email, displayName);
        }
    });
}

export async function unbindSsoIdentity(db: SqlExecutor, userId: string, provider = "keycloak") {
    await execute(db, "DELETE FROM user_identities WHERE user_id = $1 AND provider = $2", userId, provider);
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
