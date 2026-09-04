import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

type SqliteStatement = {
    all: (...params: unknown[]) => unknown[];
    get: (...params: unknown[]) => unknown;
    run: (...params: unknown[]) => { changes?: number; lastInsertRowid?: number | bigint };
};

type SqliteDatabase = {
    run: (sql: string) => unknown;
    query: (sql: string) => SqliteStatement;
    transaction: <T extends (...args: any[]) => any>(callback: T) => T;
};

export type SqliteUser = { id: string; username: string; displayName: string; createdAt: string };
export type SqliteWorkspace = { id: string; name: string; ownerUserId: string | null; createdAt: string; updatedAt: string };
export type SqliteMembership = { workspaceId: string; userId: string; role: "owner" | "editor" | "viewer"; createdAt: string };
export type SqliteWorkspaceData = { workspaceId: string; domain: string; payload: unknown; revision: number; updatedAt: string; updatedBy: string };
export type SessionUser = SqliteUser & { sessionTokenHash: string };

let databasePromise: Promise<SqliteDatabase> | undefined;

export function dataDirectory() {
    return resolve(process.env.INFINITE_CANVAS_DATA_DIR || resolve(process.env.HOME || process.cwd(), ".infinite-canvas/data"));
}

export async function getDatabase() {
    if (!databasePromise) databasePromise = openDatabase();
    return databasePromise;
}

async function openDatabase(): Promise<SqliteDatabase> {
    const file = resolve(dataDirectory(), "infinite-canvas.sqlite");
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const db = process.versions.bun
        ? await openBunDatabase(file)
        : await openNodeDatabase(file);
    chmodSync(file, 0o600);
    db.run("PRAGMA journal_mode = WAL;");
    db.run("PRAGMA foreign_keys = ON;");
    db.run("PRAGMA busy_timeout = 5000;");
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL UNIQUE COLLATE NOCASE,
            display_name TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires_at TEXT NOT NULL,
            created_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workspaces (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
            legacy_key_hash TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workspace_members (
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
            created_at TEXT NOT NULL,
            PRIMARY KEY (workspace_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS workspace_invites (
            token_hash TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
            created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires_at TEXT NOT NULL,
            created_at TEXT NOT NULL,
            used_at TEXT
        );
        CREATE TABLE IF NOT EXISTS workspace_data (
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            domain TEXT NOT NULL,
            payload TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT 1,
            updated_at TEXT NOT NULL,
            updated_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
            PRIMARY KEY (workspace_id, domain)
        );
        CREATE TABLE IF NOT EXISTS media_files (
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            storage_key TEXT NOT NULL,
            remote_path TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            bytes INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (workspace_id, storage_key)
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
        CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(user_id);
        CREATE INDEX IF NOT EXISTS idx_workspace_invites_workspace ON workspace_invites(workspace_id);
    `);
    migrateLegacyWorkspaces(db);
    return db;
}

async function openBunDatabase(file: string): Promise<SqliteDatabase> {
    const { Database } = await import("bun:sqlite");
    return new Database(file) as unknown as SqliteDatabase;
}

type NodeSqliteDatabase = {
    exec: (sql: string) => unknown;
    prepare: (sql: string) => {
        all: (...params: unknown[]) => unknown[];
        get: (...params: unknown[]) => unknown;
        run: (...params: unknown[]) => { changes?: number | bigint; lastInsertRowid?: number | bigint };
    };
};

async function openNodeDatabase(file: string): Promise<SqliteDatabase> {
    const { DatabaseSync } = await import("node:sqlite") as unknown as {
        DatabaseSync: new (file: string) => NodeSqliteDatabase;
    };
    const nativeDb = new DatabaseSync(file);
    return {
        run: (sql) => nativeDb.exec(sql),
        query: (sql) => {
            const statement = nativeDb.prepare(sql);
            return {
                all: (...params) => statement.all(...params),
                get: (...params) => statement.get(...params),
                run: (...params) => {
                    const result = statement.run(...params);
                    return {
                        ...result,
                        changes: result.changes === undefined ? undefined : Number(result.changes),
                    };
                },
            };
        },
        transaction: <T extends (...args: any[]) => any>(callback: T) => {
            return ((...args: Parameters<T>) => {
                nativeDb.exec("BEGIN");
                try {
                    const result = callback(...args);
                    nativeDb.exec("COMMIT");
                    return result;
                } catch (error) {
                    try {
                        nativeDb.exec("ROLLBACK");
                    } catch {
                        // Preserve the original transaction error.
                    }
                    throw error;
                }
            }) as T;
        },
    };
}

function migrateLegacyWorkspaces(db: SqliteDatabase) {
    const count = db.query("SELECT COUNT(*) AS count FROM workspaces").get() as { count?: number } | null;
    if (Number(count?.count || 0) > 0) return;
    const file = resolve(dataDirectory(), "workspaces.json");
    let records: unknown;
    try {
        records = JSON.parse(readFileSync(file, "utf8"));
    } catch {
        return;
    }
    if (!Array.isArray(records)) return;
    const insert = db.query("INSERT OR IGNORE INTO workspaces (id, name, owner_user_id, legacy_key_hash, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?)");
    for (const item of records) {
        if (!item || typeof item !== "object") continue;
        const value = item as Record<string, unknown>;
        if (typeof value.id !== "string" || typeof value.name !== "string" || typeof value.keyHash !== "string" || typeof value.createdAt !== "string") continue;
        insert.run(value.id, value.name, value.keyHash, value.createdAt, value.createdAt);
    }
}

export function queryOne<T>(db: SqliteDatabase, sql: string, ...params: unknown[]) {
    return db.query(sql).get(...params) as T | null;
}

export function queryMany<T>(db: SqliteDatabase, sql: string, ...params: unknown[]) {
    return db.query(sql).all(...params) as T[];
}

export function execute(db: SqliteDatabase, sql: string, ...params: unknown[]) {
    return db.query(sql).run(...params);
}

export function transaction<T>(db: SqliteDatabase, callback: () => T) {
    return db.transaction(callback)();
}

export function newId() {
    return randomUUID();
}

export function newSessionToken() {
    return randomBytes(32).toString("base64url");
}

export function hashToken(value: string) {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

export function findSessionUser(db: SqliteDatabase, token: string) {
    const row = queryOne<{ id: string; username: string; display_name: string; created_at: string; token_hash: string }>(
        db,
        `SELECT u.id, u.username, u.display_name, u.created_at, s.token_hash
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`,
        hashToken(token),
        isoNow(),
    );
    if (!row) return null;
    execute(db, "UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?", isoNow(), row.token_hash);
    return { id: row.id, username: row.username, displayName: row.display_name, createdAt: row.created_at, sessionTokenHash: row.token_hash } satisfies SessionUser;
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

export function parseJson<T>(value: string, fallback: T) {
    try {
        return JSON.parse(value) as T;
    } catch {
        return fallback;
    }
}
