import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { dirname, resolve } from "node:path";
import { Transform } from "node:stream";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import ipaddr from "ipaddr.js";
import { forwardAiResponse, failAiResponse } from "./src/server/ai-response";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { parseChangelog } from "./src/lib/release";
import { execute, findSessionUser, getPool, hashPassword, hashToken, isoNow, newId, newSessionToken, queryMany, queryOne, toIso, verifyPassword, withTransaction, type DbUser, type SessionUser, type SqlExecutor } from "./src/server/db";
import { copyMediaObject, getMediaObject, headMediaObject, isMissingObject, mediaObjectKey, putMediaStream } from "./src/server/object-storage";
import { extractMediaReferences, MEDIA_REFERENCE_DOMAINS, MediaReferenceError, replaceDomainMediaReferences, runMediaGcDryRun } from "./src/server/media-references";
import { completeMediaIntent, createMediaIntent, failMediaIntent, type MediaIntentInput } from "./src/server/media-intents";
import { readAgentAttachments, saveAgentAttachments, updateAgentAttachments } from "./src/server/agent-attachments";
import { AgentAttachmentError } from "./src/lib/agent/agent-attachment-contract";

const webDir = dirname(fileURLToPath(import.meta.url));
const localVersion = readFileSync(resolve(webDir, "../VERSION"), "utf8").trim() || "dev";
const localChangelog = readFileSync(resolve(webDir, "../CHANGELOG.md"), "utf8");
const canvasAgentProxyPath = "/api/canvas-agent";
const canvasAgentProxy = {
    target: "http://127.0.0.1:17371",
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api\/canvas-agent/, ""),
    headers: canvasAgentProxyHeaders(),
};
function canvasAgentProxyHeaders() {
    try {
        const configPath = process.env.CANVAS_AGENT_CONFIG || resolve(process.env.HOME || webDir, ".infinite-canvas/canvas-agent.json");
        const config = JSON.parse(readFileSync(configPath, "utf8")) as { token?: unknown };
        return typeof config.token === "string" && config.token ? { "x-canvas-agent-token": config.token } : {};
    } catch {
        return {};
    }
}

function normalizeIp(value: string) {
    return value.trim().replace(/^::ffff:/, "");
}

const serverConfigPath = resolve(process.env.INFINITE_CANVAS_DATA_DIR || resolve(process.env.HOME || webDir, ".infinite-canvas/data"), "config.json");
const maxServerConfigBytes = 1024 * 1024;
const aiProxyPath = "/api/ai";
const maxAiRequestBytes = 64 * 1024 * 1024;
const maxMediaBytes = 100 * 1024 * 1024;
const protectedApiPaths = ["/api/auth", "/api/config", "/api/workspaces", "/api/data", "/api/prompts", "/api/media", "/api/prompt-source", "/api/remote-media", aiProxyPath, "/api/webdav", "/api/image-proxy", canvasAgentProxyPath];
const allowedNetworks = (process.env.INFINITE_CANVAS_ALLOWED_NETWORKS || "127.0.0.1,::1,192.168.0.0/22,172.16.0.0/12")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

const authCookieName = "infinite_canvas_session";
const authCookieMaxAgeSeconds = 60 * 60 * 24 * 30;
type AuthenticatedRequest = IncomingMessage & { infiniteCanvasUser?: SessionUser };

function sessionContext(): Plugin {
    const middleware = async (req: IncomingMessage, _res: ServerResponse, next: () => void) => {
        const token = parseCookie(req.headers.cookie || "")[authCookieName];
        if (token) {
            try {
                const db = await getPool();
                (req as AuthenticatedRequest).infiniteCanvasUser = (await findSessionUser(db, token)) || undefined;
            } catch (error) {
                console.error("Session lookup failed", error);
            }
        }
        next();
    };
    return { name: "session-context", configureServer: (server) => { server.middlewares.use(middleware); }, configurePreviewServer: (server) => { server.middlewares.use(middleware); } };
}

function parseCookie(value: string) {
    return Object.fromEntries(value.split(";").map((item) => item.trim().split("=")).filter(([key, val]) => key && val).map(([key, ...rest]) => [key, decodeURIComponent(rest.join("="))]));
}

function setSessionCookie(res: ServerResponse, token: string, maxAge = authCookieMaxAgeSeconds) {
    res.setHeader("Set-Cookie", `${authCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);
}

function publicUser(user: DbUser) {
    return { id: user.id, username: user.username, displayName: user.displayName, createdAt: user.createdAt };
}

function authAccess(): Plugin {
    const middleware = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const requestUrl = new URL(req.url || "/", "http://localhost");
        if (!requestUrl.pathname.startsWith("/api/auth")) return next();
        res.setHeader("Cache-Control", "no-store");
        try {
            const db = await getPool();
            const current = (req as AuthenticatedRequest).infiniteCanvasUser;
            if (requestUrl.pathname === "/api/auth/register" && req.method === "POST") {
                const body = await readJsonBody(req);
                const username = typeof body.username === "string" ? body.username.trim() : "";
                const password = typeof body.password === "string" ? body.password : "";
                const displayName = typeof body.displayName === "string" ? body.displayName.trim() : username;
                const workspaceName = typeof body.workspaceName === "string" ? body.workspaceName.trim() : `${displayName || username}的工作区`;
                if (!/^[\p{L}\p{N}._-]{3,64}$/u.test(username) || password.length < 8 || password.length > 256 || !displayName || displayName.length > 80 || !workspaceName || workspaceName.length > 80) return sendJson(res, 400, { error: "用户名、密码或工作区名称无效" });
                if (await queryOne(db, "SELECT id FROM users WHERE lower(username) = lower($1)", username)) return sendJson(res, 409, { error: "用户名已存在" });
                const now = isoNow();
                const userId = newId();
                const workspaceId = newId();
                await withTransaction(async (tx) => {
                    await execute(tx, "INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES ($1, $2, $3, $4, $5)", userId, username, displayName, hashPassword(password), now);
                    await execute(tx, "INSERT INTO workspaces (id, name, owner_user_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)", workspaceId, workspaceName, userId, now, now);
                    await execute(tx, "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'owner', $3)", workspaceId, userId, now);
                });
                const user = { id: userId, username, displayName, createdAt: now } satisfies DbUser;
                const token = newSessionToken();
                await execute(db, "INSERT INTO sessions (token_hash, user_id, expires_at, created_at, last_seen_at) VALUES ($1, $2, $3, $4, $5)", await hashToken(token), userId, new Date(Date.now() + authCookieMaxAgeSeconds * 1000).toISOString(), now, now);
                setSessionCookie(res, token);
                return sendJson(res, 201, { user: publicUser(user), workspaces: [{ id: workspaceId, name: workspaceName, role: "owner", createdAt: now }] });
            }
            if (requestUrl.pathname === "/api/auth/login" && req.method === "POST") {
                const body = await readJsonBody(req);
                const username = typeof body.username === "string" ? body.username.trim() : "";
                const password = typeof body.password === "string" ? body.password : "";
                const row = await queryOne<{ id: string; username: string; display_name: string; password_hash: string; created_at: Date }>(db, "SELECT id, username, display_name, password_hash, created_at FROM users WHERE lower(username) = lower($1)", username);
                if (!row || !verifyPassword(password, row.password_hash)) return sendJson(res, 401, { error: "用户名或密码不正确" });
                const now = isoNow();
                const token = newSessionToken();
                await execute(db, "INSERT INTO sessions (token_hash, user_id, expires_at, created_at, last_seen_at) VALUES ($1, $2, $3, $4, $5)", await hashToken(token), row.id, new Date(Date.now() + authCookieMaxAgeSeconds * 1000).toISOString(), now, now);
                setSessionCookie(res, token);
                return sendJson(res, 200, { user: { id: row.id, username: row.username, displayName: row.display_name, createdAt: toIso(row.created_at) }, workspaces: await listUserWorkspaces(db, row.id) });
            }
            if (requestUrl.pathname === "/api/auth/logout" && req.method === "POST") {
                const token = parseCookie(req.headers.cookie || "")[authCookieName];
                if (token) await execute(db, "DELETE FROM sessions WHERE token_hash = $1", await hashToken(token));
                setSessionCookie(res, "", 0);
                return sendJson(res, 200, { ok: true });
            }
            if (requestUrl.pathname === "/api/auth/me" && req.method === "GET") {
                if (!current) return sendJson(res, 200, { user: null, workspaces: [] });
                return sendJson(res, 200, { user: publicUser(current), workspaces: await listUserWorkspaces(db, current.id) });
            }
            return sendJson(res, 405, { error: "Method not allowed" });
        } catch (error) {
            if (error instanceof RequestBodyError) return sendJson(res, error.status, { error: error.message });
            console.error("Authentication request failed", error);
            return sendJson(res, 500, { error: "认证服务暂时不可用" });
        }
    };
    return { name: "auth-access", configureServer: (server) => { server.middlewares.use(middleware); }, configurePreviewServer: (server) => { server.middlewares.use(middleware); } };
}

async function readJsonBody(req: IncomingMessage) {
    const text = await readRequestBody(req);
    try {
        const value = JSON.parse(text);
        return value && typeof value === "object" ? value as Record<string, unknown> : {};
    } catch {
        throw new RequestBodyError(400, "请求数据不是有效 JSON");
    }
}

async function listUserWorkspaces(db: SqlExecutor, userId: string) {
    const rows = await queryMany<{ id: string; name: string; role: string; created_at: Date }>(db, "SELECT w.id, w.name, m.role, w.created_at FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = $1 ORDER BY w.created_at", userId);
    return rows.map((row) => ({ id: row.id, name: row.name, role: row.role, createdAt: toIso(row.created_at) }));
}

function serverApiAccessControl(): Plugin {
    const middleware = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const pathname = new URL(req.url || "/", "http://localhost").pathname;
        if (!protectedApiPaths.some((path) => pathname === path || pathname.startsWith(`${path}/`))) return next();
        if (pathname === `${canvasAgentProxyPath}/health`) return next();
        const remoteAddress = normalizeIp(req.socket.remoteAddress || "");
        if (allowedNetworks.some((network) => ipMatchesNetwork(remoteAddress, network))) return next();
        return sendJson(res, 403, { error: "Server API access is not allowed from this address" });
    };
    return {
        name: "server-api-access-control",
        configureServer(server) {
            server.middlewares.use(middleware);
        },
        configurePreviewServer(server) {
            server.middlewares.use(middleware);
        },
    };
}

type WorkspaceContext = { id: string; name: string; role: "owner" | "editor" | "viewer"; userId: string; createdAt: string };

function workspaceIdFromRequest(req: IncomingMessage, requestUrl = new URL(req.url || "/", "http://localhost")) {
    const header = req.headers["x-infinite-canvas-workspace"];
    return typeof header === "string" && header ? header : requestUrl.searchParams.get("workspaceId") || "";
}

async function workspaceContext(req: IncomingMessage, requestUrl = new URL(req.url || "/", "http://localhost")): Promise<WorkspaceContext | null> {
    const id = workspaceIdFromRequest(req, requestUrl);
    const user = (req as AuthenticatedRequest).infiniteCanvasUser;
    if (!id || !user) return null;
    const db = await getPool();
    const row = await queryOne<{ id: string; name: string; role: WorkspaceContext["role"]; created_at: Date }>(db, "SELECT w.id, w.name, m.role, w.created_at FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id WHERE w.id = $1 AND m.user_id = $2", id, user.id);
    return row ? { id: row.id, name: row.name, role: row.role, userId: user.id, createdAt: toIso(row.created_at) } : null;
}

function canWriteWorkspace(context: WorkspaceContext) {
    return context.role === "owner" || context.role === "editor";
}

async function withWorkspaceWrite<T>(context: WorkspaceContext, write: (tx: SqlExecutor) => Promise<T>) {
    return withTransaction(async (tx) => {
        await execute(tx, "SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", context.id);
        const membership = await queryOne<{ role: WorkspaceContext["role"] }>(tx, "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 FOR SHARE", context.id, context.userId);
        if (!membership || membership.role === "viewer") throw new RequestBodyError(403, "当前工作区无写入权限");
        return write(tx);
    });
}

async function withMediaIntent(context: WorkspaceContext, key: string, input: MediaIntentInput, writeObject: () => Promise<unknown>, commitIndex: (tx: SqlExecutor) => Promise<void>) {
    const id = await withWorkspaceWrite(context, (tx) => createMediaIntent(tx, context.id, context.userId, key, input));
    if (!id) throw new RequestBodyError(409, "该媒体有未完成的写入租约，请核对后再重试");
    try {
        await writeObject();
        await withWorkspaceWrite(context, async (tx) => {
            await commitIndex(tx);
            await completeMediaIntent(tx, id);
        });
    } catch (error) {
        await failMediaIntent(context.id, id).catch(() => undefined);
        throw error;
    }
}

const workspaceDataDomains = new Set<string>(MEDIA_REFERENCE_DOMAINS);
const maxWorkspaceDataBytes = 8 * 1024 * 1024;

function workspaceDataAccess(): Plugin {
    const middleware = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const requestUrl = new URL(req.url || "/", "http://localhost");
        const dataMatch = /^\/api\/data\/([^/]+)$/.exec(requestUrl.pathname);
        const isMedia = requestUrl.pathname === "/api/media";
        if (!dataMatch && !isMedia) return next();
        res.setHeader("Cache-Control", "no-store");
        try {
            const context = await workspaceContext(req, requestUrl);
            if (!context) return sendJson(res, 403, { error: "工作区不存在或无权访问" });
            const db = await getPool();
            const actorId = context.userId;
            if (requestUrl.pathname === "/api/data/summary") {
                if (req.method !== "GET") return sendJson(res, 405, { error: "Method not allowed" });
                const domains = await queryMany<{ domain: string; bytes: number; revision: number; updated_at: Date }>(db, "SELECT domain, octet_length(payload) AS bytes, revision, updated_at FROM workspace_data WHERE workspace_id = $1 ORDER BY domain", context.id);
                const media = await queryOne<{ files: string; bytes: string; updatedat: Date | null }>(db, "SELECT COUNT(*) AS files, COALESCE(SUM(bytes), 0) AS bytes, MAX(updated_at) AS updatedAt FROM media_files WHERE workspace_id = $1 AND remote_path = ''", context.id);
                return sendJson(res, 200, {
                    workspaceId: context.id,
                    domains: domains.map((row) => ({ domain: row.domain, bytes: Number(row.bytes), revision: row.revision, updatedAt: toIso(row.updated_at) })),
                    media: media ? { files: Number(media.files), bytes: Number(media.bytes), updatedAt: media.updatedat ? toIso(media.updatedat) : null } : { files: 0, bytes: 0, updatedAt: null },
                });
            }
            if (dataMatch) {
                const domain = decodeURIComponent(dataMatch[1]);
                if (!workspaceDataDomains.has(domain)) return sendJson(res, 404, { error: "未知数据域" });
                if (req.method === "GET") {
                    const row = await queryOne<{ payload: string; revision: number; updated_at: Date; updated_by: string }>(db, "SELECT payload, revision, updated_at, updated_by FROM workspace_data WHERE workspace_id = $1 AND domain = $2", context.id, domain);
                    return sendJson(res, 200, row ? { domain, payload: JSON.parse(row.payload), revision: row.revision, updatedAt: toIso(row.updated_at), updatedBy: row.updated_by } : { domain, payload: null, revision: 0, updatedAt: null, updatedBy: null });
                }
                if (req.method !== "PUT") return sendJson(res, 405, { error: "Method not allowed" });
                if (!canWriteWorkspace(context)) return sendJson(res, 403, { error: "当前工作区为只读权限" });
                const raw = await readRequestBuffer(req, maxWorkspaceDataBytes, "工作区数据过大");
                let body: { revision?: unknown; payload?: unknown };
                try { body = JSON.parse(raw.toString("utf8")) as { revision?: unknown; payload?: unknown }; } catch { return sendJson(res, 400, { error: "请求数据不是有效 JSON" }); }
                const revision = body.revision;
                if (!Number.isInteger(revision) || Number(revision) < 0 || !("payload" in body)) return sendJson(res, 400, { error: "数据版本无效" });
                const payload = JSON.stringify(body.payload);
                if (Buffer.byteLength(payload) > maxWorkspaceDataBytes) return sendJson(res, 413, { error: "工作区数据过大" });
                const references = extractMediaReferences(domain, body.payload);
                const now = isoNow();
                // 用写语句自身的 WHERE 条件做版本比较，避免 READ COMMITTED 下两个并发 PUT 都读到旧版本后互相覆盖。
                const written = await withWorkspaceWrite(context, async (tx) => {
                    const result = await queryOne<{ revision: number }>(
                    tx,
                    `INSERT INTO workspace_data (workspace_id, domain, payload, revision, updated_at, updated_by)
                     SELECT $1, $2, $3, 1, $4, $5 WHERE $6 = 0 OR EXISTS (SELECT 1 FROM workspace_data WHERE workspace_id = $1 AND domain = $2)
                     ON CONFLICT (workspace_id, domain) DO UPDATE
                     SET payload = excluded.payload,
                         revision = workspace_data.revision + 1,
                         updated_at = excluded.updated_at,
                         updated_by = excluded.updated_by
                     WHERE workspace_data.revision = $6
                     RETURNING revision`,
                    context.id, domain, payload, now, actorId, revision,
                    );
                    if (result) {
                        await replaceDomainMediaReferences(tx, context.id, domain, references, result.revision);
                        await execute(tx, "UPDATE workspaces SET updated_at = $1 WHERE id = $2", now, context.id);
                    }
                    return result;
                });
                if (!written) {
                    const current = await queryOne<{ payload: string; revision: number; updated_at: Date; updated_by: string }>(db, "SELECT payload, revision, updated_at, updated_by FROM workspace_data WHERE workspace_id = $1 AND domain = $2", context.id, domain);
                    return sendJson(res, 409, { error: "数据已被其他成员更新，请先刷新后处理冲突", domain, payload: current ? JSON.parse(current.payload) : null, revision: current?.revision || 0, updatedAt: current ? toIso(current.updated_at) : null, updatedBy: current?.updated_by || null });
                }
                return sendJson(res, 200, { domain, payload: body.payload, revision: written.revision, updatedAt: now, updatedBy: actorId });
            }
            if (req.method === "GET") {
                const files = await queryMany<{ storage_key: string; remote_path: string; mime_type: string; bytes: string; created_at: Date; updated_at: Date }>(db, "SELECT storage_key, remote_path, mime_type, bytes, created_at, updated_at FROM media_files WHERE workspace_id = $1 ORDER BY updated_at DESC", context.id);
                return sendJson(res, 200, { files: files.map((file) => ({ storageKey: file.storage_key, remotePath: file.remote_path, mimeType: file.mime_type, bytes: Number(file.bytes), createdAt: toIso(file.created_at), updatedAt: toIso(file.updated_at) })) });
            }
            if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
            if (!canWriteWorkspace(context)) return sendJson(res, 403, { error: "当前工作区为只读权限" });
            const body = await readJsonBody(req);
            const files = Array.isArray(body.files) ? body.files : [];
            if (files.length > 1000) return sendJson(res, 400, { error: "媒体索引条目过多" });
            const now = isoNow();
            await withWorkspaceWrite(context, async (tx) => {
                for (const item of files) {
                    const file = asRecord(item);
                    const storageKey = typeof file?.storageKey === "string" ? file.storageKey : "";
                    const remotePath = typeof file?.remotePath === "string" ? file.remotePath : "";
                    const mimeType = typeof file?.mimeType === "string" ? file.mimeType : "application/octet-stream";
                    const bytes = typeof file?.bytes === "number" ? file.bytes : -1;
                    if (!storageKey || !remotePath || bytes < 0 || !Number.isSafeInteger(bytes)) continue;
                    await execute(tx, "INSERT INTO media_files (workspace_id, storage_key, remote_path, mime_type, bytes, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT(workspace_id, storage_key) DO UPDATE SET remote_path = CASE WHEN media_files.remote_path = '' THEN '' ELSE excluded.remote_path END, mime_type = excluded.mime_type, bytes = excluded.bytes, updated_at = excluded.updated_at", context.id, storageKey, remotePath, mimeType, bytes, now, now);
                }
            });
            return sendJson(res, 200, { saved: true });
        } catch (error) {
            if (error instanceof MediaReferenceError) return sendJson(res, 422, { error: error.message });
            if (error instanceof RequestBodyError) return sendJson(res, error.status, { error: error.message });
            console.error("Workspace data request failed", error);
            return sendJson(res, 500, { error: "工作区数据服务暂时不可用" });
        }
    };
    return { name: "workspace-data", configureServer: (server) => { server.middlewares.use(middleware); }, configurePreviewServer: (server) => { server.middlewares.use(middleware); } };
}

type WorkspacePromptRow = { id: string; workspace_id: string; workspace_name: string; title: string; prompt: string; description: string; tags: string; shared: boolean; created_at: Date; updated_at: Date; has_image: string };
type PromptImageRow = { mime_type: string; image: Uint8Array };
const promptRowSql = "SELECT p.*, w.name AS workspace_name, CASE WHEN i.prompt_id IS NULL THEN 0 ELSE 1 END AS has_image FROM workspace_prompts p JOIN workspaces w ON w.id = p.workspace_id LEFT JOIN workspace_prompt_images i ON i.prompt_id = p.id";

function promptImageData(value: unknown) {
    if (value === undefined || value === null || value === "") return null;
    const match = typeof value === "string" ? /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value) : null;
    if (!match) throw new RequestBodyError(400, "示例图格式无效");
    const image = Buffer.from(match[2], "base64");
    if (!image.length || image.length > maxMediaBytes) throw new RequestBodyError(413, "示例图过大或无效");
    return { mimeType: match[1], image };
}

function promptFields(value: unknown) {
    const body = asRecord(value);
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
    const description = typeof body?.description === "string" ? body.description.trim() : "";
    const tags = body?.tags === undefined ? [] : Array.isArray(body.tags) && body.tags.every((tag) => typeof tag === "string") ? body.tags.map((tag: string) => tag.trim()).filter(Boolean) : null;
    if (!title || !prompt || !tags) throw new RequestBodyError(400, "请填写标题和提示词，并检查标签格式");
    return { title, prompt, description, tags, image: promptImageData(body?.coverDataUrl), removeImage: body?.coverDataUrl === null };
}

async function readPromptsBody(req: IncomingMessage) {
    const raw = await readRequestBuffer(req, maxMediaBytes, "提示词文件过大");
    try { return JSON.parse(raw.toString("utf8")) as unknown; }
    catch { throw new RequestBodyError(400, "请求数据不是有效 JSON"); }
}

async function savePromptImage(db: SqlExecutor, id: string, image: ReturnType<typeof promptImageData>) {
    if (image) await execute(db, "INSERT INTO workspace_prompt_images (prompt_id, mime_type, image) VALUES ($1, $2, $3) ON CONFLICT(prompt_id) DO UPDATE SET mime_type = excluded.mime_type, image = excluded.image", id, image.mimeType, image.image);
}

function publicPrompt(row: WorkspacePromptRow) {
    return {
        id: row.id, workspaceId: row.workspace_id, workspaceName: row.workspace_name,
        title: row.title, prompt: row.prompt, description: row.description,
        tags: JSON.parse(row.tags) as string[], shared: row.shared,
        coverUrl: Number(row.has_image) ? `/api/prompts/image/${encodeURIComponent(row.id)}?workspaceId=${encodeURIComponent(row.workspace_id)}` : "",
        createdAt: toIso(row.created_at), updatedAt: toIso(row.updated_at),
    };
}

function workspacePromptsAccess(): Plugin {
    const middleware = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const pathname = new URL(req.url || "/", "http://localhost").pathname;
        const imageMatch = /^\/api\/prompts\/image\/([^/]+)$/.exec(pathname);
        const match = /^\/api\/prompts(?:\/([^/]+))?$/.exec(pathname);
        if (!match && !imageMatch) return next();
        res.setHeader("Cache-Control", "no-store");
        try {
            const db = await getPool();
            const user = (req as AuthenticatedRequest).infiniteCanvasUser;
            if (!user) return sendJson(res, 401, { error: "请先登录" });
            if (imageMatch && req.method === "GET") {
                const row = await queryOne<{ workspace_id: string; owner_user_id: string | null; shared: boolean; mime_type: string; image: Buffer }>(db, "SELECT p.workspace_id, w.owner_user_id, p.shared, i.mime_type, i.image FROM workspace_prompts p JOIN workspaces w ON w.id = p.workspace_id JOIN workspace_prompt_images i ON i.prompt_id = p.id WHERE p.id = $1", imageMatch[1]);
                if (!row) return sendJson(res, 404, { error: "示例图不存在" });
                if (!row.shared) {
                    if (workspaceIdFromRequest(req) !== row.workspace_id) return sendJson(res, 403, { error: "无权查看示例图" });
                    if (!(await queryOne(db, "SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", row.workspace_id, user.id))) return sendJson(res, 403, { error: "无权查看示例图" });
                }
                res.setHeader("Content-Type", row.mime_type);
                res.setHeader("X-Content-Type-Options", "nosniff");
                return res.end(Buffer.from(row.image));
            }
            if (imageMatch) return sendJson(res, 405, { error: "Method not allowed" });
            if (!match) return next();
            const workspace = await workspaceContext(req);
            if (!workspace) return sendJson(res, 403, { error: "请先选择工作区" });
            const role = workspace.role;
            if (pathname === "/api/prompts/export" && req.method === "GET") {
                const rows = await queryMany<WorkspacePromptRow>(db, `${promptRowSql} WHERE p.workspace_id = $1 ORDER BY p.created_at`, workspace.id);
                const prompts = await Promise.all(rows.map(async (row) => {
                    const image = Number(row.has_image) ? await queryOne<PromptImageRow>(db, "SELECT mime_type, image FROM workspace_prompt_images WHERE prompt_id = $1", row.id) : null;
                    return { title: row.title, prompt: row.prompt, description: row.description, tags: JSON.parse(row.tags), ...(image ? { coverDataUrl: `data:${image.mime_type};base64,${Buffer.from(image.image).toString("base64")}` } : {}) };
                }));
                return sendJson(res, 200, { format: "infinite-canvas-prompts", version: 1, prompts });
            }
            if (pathname === "/api/prompts/import" && req.method === "POST") {
                if (role === "viewer") return sendJson(res, 403, { error: "当前工作区为只读权限" });
                const body = await readPromptsBody(req);
                const source = Array.isArray(body) ? body : asRecord(body);
                const items = Array.isArray(source) ? source : source?.format === "infinite-canvas-prompts" && source.version === 1 && Array.isArray(source.prompts) ? source.prompts : null;
                if (!items) return sendJson(res, 400, { error: "不支持的提示词文件格式" });
                const prompts = items.map(promptFields);
                await withTransaction(async (tx) => {
                    for (const item of prompts) {
                        const id = newId();
                        const now = isoNow();
                        await execute(tx, "INSERT INTO workspace_prompts (id, workspace_id, title, prompt, description, tags, shared, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, FALSE, $7, $8)", id, workspace.id, item.title, item.prompt, item.description, JSON.stringify(item.tags), now, now);
                        await savePromptImage(tx, id, item.image);
                    }
                });
                return sendJson(res, 200, { imported: prompts.length });
            }
            if (!match[1] && req.method === "GET") {
                const rows = await queryMany<WorkspacePromptRow>(db, `${promptRowSql} WHERE p.workspace_id = $1 OR p.shared = TRUE ORDER BY p.updated_at DESC`, workspace.id);
                return sendJson(res, 200, { items: rows.map(publicPrompt) });
            }
            if (!match[1] && req.method === "POST") {
                if (role === "viewer") return sendJson(res, 403, { error: "当前工作区为只读权限" });
                const body = asRecord(await readPromptsBody(req));
                const { title, prompt, description, tags, image } = promptFields(body);
                if (typeof body?.shared !== "boolean") return sendJson(res, 400, { error: "共享状态无效" });
                const id = newId();
                const now = isoNow();
                await withTransaction(async (tx) => {
                    await execute(tx, "INSERT INTO workspace_prompts (id, workspace_id, title, prompt, description, tags, shared, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)", id, workspace.id, title, prompt, description, JSON.stringify(tags), body.shared, now, now);
                    await savePromptImage(tx, id, image);
                });
                const row = await queryOne<WorkspacePromptRow>(db, `${promptRowSql} WHERE p.id = $1`, id);
                return sendJson(res, 201, { item: publicPrompt(row!) });
            }
            if (!match[1]) return sendJson(res, 405, { error: "Method not allowed" });
            const id = match[1];
            const existing = await queryOne<WorkspacePromptRow>(db, `${promptRowSql} WHERE p.id = $1 AND p.workspace_id = $2`, id, workspace.id);
            if (!existing) return sendJson(res, 404, { error: "提示词不存在或无权修改" });
            if (role === "viewer") return sendJson(res, 403, { error: "当前工作区为只读权限" });
            if (req.method === "DELETE") {
                await execute(db, "DELETE FROM workspace_prompts WHERE id = $1 AND workspace_id = $2", id, workspace.id);
                return sendJson(res, 200, { ok: true });
            }
            if (req.method !== "PUT") return sendJson(res, 405, { error: "Method not allowed" });
            const body = asRecord(await readPromptsBody(req));
            const { title, prompt, description, tags, image, removeImage } = promptFields(body);
            if (typeof body?.shared !== "boolean") return sendJson(res, 400, { error: "共享状态无效" });
            await withTransaction(async (tx) => {
                await execute(tx, "UPDATE workspace_prompts SET title = $1, prompt = $2, description = $3, tags = $4, shared = $5, updated_at = $6 WHERE id = $7 AND workspace_id = $8", title, prompt, description, JSON.stringify(tags), body.shared, isoNow(), id, workspace.id);
                if (removeImage) await execute(tx, "DELETE FROM workspace_prompt_images WHERE prompt_id = $1", id);
                await savePromptImage(tx, id, image);
            });
            const updated = await queryOne<WorkspacePromptRow>(db, `${promptRowSql} WHERE p.id = $1`, id);
            return sendJson(res, 200, { item: publicPrompt(updated!) });
        } catch (error) {
            if (error instanceof RequestBodyError) return sendJson(res, error.status, { error: error.message });
            console.error("Workspace prompts request failed", error);
            return sendJson(res, 500, { error: "提示词服务暂时不可用" });
        }
    };
    return { name: "workspace-prompts", configureServer: (server) => { server.middlewares.use(middleware); }, configurePreviewServer: (server) => { server.middlewares.use(middleware); } };
}

function workspaceMediaStorage(): Plugin {
    const middleware = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const requestUrl = new URL(req.url || "/", "http://localhost");
        if (requestUrl.pathname === "/api/media/agent-attachments") {
            res.setHeader("Cache-Control", "no-store");
            try {
                const context = await workspaceContext(req, requestUrl);
                if (!context) return sendJson(res, 403, { error: "工作区不存在或无权访问" });
                if (req.method === "GET") return sendJson(res, 200, await readAgentAttachments(await getPool(), context.id));
                if (!["POST", "PATCH", "DELETE"].includes(req.method || "")) return sendJson(res, 405, { error: "Method not allowed" });
                if (!canWriteWorkspace(context)) return sendJson(res, 403, { error: "当前工作区为只读权限" });
                const body = await readJsonBody(req);
                const manifest = await withWorkspaceWrite(context, async (tx) => {
                    const value = updateAgentAttachments(await readAgentAttachments(tx, context.id), req.method!, body);
                    await saveAgentAttachments(tx, context.id, context.userId, value);
                    return value;
                });
                return sendJson(res, 200, manifest);
            } catch (error) {
                if (error instanceof RequestBodyError) return sendJson(res, error.status, { error: error.message });
                if (error instanceof AgentAttachmentError || error instanceof SyntaxError) return sendJson(res, 422, { error: "Agent 附件清单无效或归属冲突，未覆盖原数据" });
                console.error("Agent attachment persistence failed", error);
                return sendJson(res, 503, { error: "Agent 附件清单保存失败，原数据未变更" });
            }
        }
        if (requestUrl.pathname === "/api/media/gc/dry-run") {
            res.setHeader("Cache-Control", "no-store");
            try {
                const context = await workspaceContext(req, requestUrl);
                if (!context || context.role !== "owner") return sendJson(res, 403, { error: "仅工作区所有者可以执行媒体扫描" });
                if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
                return sendJson(res, 200, await runMediaGcDryRun(context.id));
            } catch (error) {
                console.error("Media dry-run failed", error);
                return sendJson(res, 503, { error: "媒体扫描失败，未删除任何对象" });
            }
        }
        const match = /^\/api\/media\/blob\/([^/]+)(\/copy)?$/.exec(requestUrl.pathname);
        if (!match) return next();
        let key: string;
        try { key = decodeURIComponent(match[1]); } catch { return sendJson(res, 400, { error: "媒体标识无效" }); }
        if (!/^[a-z][a-z0-9-]*:[A-Za-z0-9_-]+$/.test(key)) return sendJson(res, 400, { error: "媒体标识无效" });
        try {
            const context = await workspaceContext(req, requestUrl);
            if (!context) return sendJson(res, 403, { error: "工作区不存在或无权访问" });
            const db = await getPool();
            const objectKey = mediaObjectKey(context.id, key);
            res.setHeader("Cache-Control", "no-store");
            res.setHeader("X-Content-Type-Options", "nosniff");
            if (match[2]) {
                if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
                if (!canWriteWorkspace(context)) return sendJson(res, 403, { error: "当前工作区为只读权限" });
                const source = await queryOne<{ mime_type: string; bytes: number }>(db, "SELECT mime_type, bytes FROM media_files WHERE workspace_id = $1 AND storage_key = $2", context.id, key);
                if (!source) return sendJson(res, 404, { error: "媒体不存在" });
                const storageKey = `${key.split(":")[0]}:${randomUUID()}`;
                const now = isoNow();
                try { await withMediaIntent(context, storageKey, { operation: "copy", sourceKey: key, expectedBytes: Number(source.bytes) },
                    () => copyMediaObject(objectKey, mediaObjectKey(context.id, storageKey)),
                    (tx) => execute(tx, "INSERT INTO media_files (workspace_id, storage_key, remote_path, mime_type, bytes, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)", context.id, storageKey, "", source.mime_type, source.bytes, now, now)); }
                catch (error) { if (isMissingObject(error)) return sendJson(res, 404, { error: "媒体不存在" }); throw error; }
                return sendJson(res, 200, { storageKey });
            }
            if (req.method === "GET" || req.method === "HEAD") {
                const file = await queryOne<{ mime_type: string }>(db, "SELECT mime_type FROM media_files WHERE workspace_id = $1 AND storage_key = $2", context.id, key);
                if (!file) return sendJson(res, 404, { error: "媒体不存在" });
                try {
                    // HEAD 只取对象元数据，GET 才拉取对象体，避免重复下载。
                    if (req.method === "HEAD") {
                        const details = await headMediaObject(objectKey);
                        if (details.contentLength !== undefined) res.setHeader("Content-Length", details.contentLength);
                        res.setHeader("Content-Type", file.mime_type);
                        return res.end();
                    }
                    const object = await getMediaObject(objectKey);
                    if (object.contentLength !== undefined) res.setHeader("Content-Length", object.contentLength);
                    res.setHeader("Content-Type", file.mime_type);
                    object.body.on("error", (error) => res.destroy(error));
                    object.body.pipe(res);
                    return;
                } catch (error) {
                    if (isMissingObject(error)) return sendJson(res, 404, { error: "媒体不存在" });
                    throw error;
                }
            }
            if (req.method !== "PUT") return sendJson(res, 405, { error: "Method not allowed" });
            if (!canWriteWorkspace(context)) return sendJson(res, 403, { error: "当前工作区为只读权限" });
            const declaredLength = Number(req.headers["content-length"] || 0);
            if (declaredLength > maxMediaBytes) return sendJson(res, 413, { error: "媒体超过 100 MB，未保存到服务器" });
            let receivedBytes = 0;
            const limit = new Transform({
                transform(chunk: Buffer, _encoding, callback) {
                    receivedBytes += chunk.length;
                    // 声明长度缺失时仍以实际字节数兜底，超限即中断上传。
                    if (receivedBytes > maxMediaBytes) return callback(new RequestBodyError(413, "媒体超过 100 MB，未保存到服务器"));
                    callback(null, chunk);
                },
            });
            // 请求流直接上传到对象存储，不再落本地临时文件；显式传 ContentLength 以免 chunked 编码导致签名失败。
            const now = isoNow();
            const mimeType = typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : "application/octet-stream";
            await withMediaIntent(context, key, { operation: "upload", expectedBytes: declaredLength || null },
            () => putMediaStream(objectKey, req.pipe(limit), mimeType, declaredLength || undefined), async (tx) => {
                await execute(tx, "INSERT INTO media_files (workspace_id, storage_key, remote_path, mime_type, bytes, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT(workspace_id, storage_key) DO UPDATE SET remote_path = excluded.remote_path, mime_type = excluded.mime_type, bytes = excluded.bytes, updated_at = excluded.updated_at", context.id, key, "", mimeType, receivedBytes, now, now);
                await execute(tx, "UPDATE media_files SET lifecycle_state = 'ready', last_referenced_at = now() WHERE workspace_id = $1 AND storage_key = $2 AND EXISTS (SELECT 1 FROM media_references WHERE workspace_id = $1 AND storage_key = $2)", context.id, key);
            });
            return sendJson(res, 200, { saved: true });
        } catch (error) {
            if (error instanceof RequestBodyError) return sendJson(res, error.status, { error: error.message });
            console.error("Workspace media request failed", error);
            return sendJson(res, 500, { error: "媒体存储失败" });
        }
    };
    return { name: "workspace-media-storage", configureServer: (server) => { server.middlewares.use(middleware); }, configurePreviewServer: (server) => { server.middlewares.use(middleware); } };
}

function workspaceAccess(): Plugin {
    const middleware = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const requestUrl = new URL(req.url || "/", "http://localhost");
        if (!requestUrl.pathname.startsWith("/api/workspaces")) return next();
        res.setHeader("Cache-Control", "no-store");
        try {
            const db = await getPool();
            const user = (req as AuthenticatedRequest).infiniteCanvasUser;
            if (!user) return sendJson(res, 401, { error: "请先登录" });
            if (requestUrl.pathname === "/api/workspaces/summaries" && req.method === "GET") {
                const rows = await queryMany<{ workspace_id: string; payload: string | null }>(db, "SELECT w.id AS workspace_id, d.payload FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id LEFT JOIN workspace_data d ON d.workspace_id = w.id AND d.domain = 'canvas' WHERE m.user_id = $1", user.id);
                const summaries = Object.fromEntries(rows.map((row) => [row.workspace_id, summarizeWorkspaceCanvas(row.payload)]));
                return sendJson(res, 200, { summaries });
            }
            if (requestUrl.pathname === "/api/workspaces" && req.method === "GET") {
                return sendJson(res, 200, { workspaces: await listUserWorkspaces(db, user.id) });
            }
            if (requestUrl.pathname === "/api/workspaces" && req.method === "POST") {
                const body = await readJsonBody(req);
                const name = typeof body.name === "string" ? body.name.trim() : "";
                if (!name || name.length > 80) return sendJson(res, 400, { error: "工作区名称无效" });
                const now = isoNow();
                const id = newId();
                await withTransaction(async (tx) => {
                    await execute(tx, "INSERT INTO workspaces (id, name, owner_user_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)", id, name, user.id, now, now);
                    await execute(tx, "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'owner', $3)", id, user.id, now);
                });
                return sendJson(res, 201, { workspace: { id, name, role: "owner", createdAt: now } });
            }
            return sendJson(res, 405, { error: "Method not allowed" });
        } catch (error) {
            if (error instanceof RequestBodyError) return sendJson(res, error.status, { error: error.message });
            console.error("Workspace request failed", error);
            return sendJson(res, 500, { error: "工作区服务暂时不可用" });
        }
    };
    return { name: "workspace-access", configureServer: (server) => { server.middlewares.use(middleware); }, configurePreviewServer: (server) => { server.middlewares.use(middleware); } };
}

function summarizeWorkspaceCanvas(payload: string | null) {
    if (!payload) return { canvasCount: 0, folderCount: 0, recentCanvasTitle: null };
    try {
        const state = (JSON.parse(payload) as { state?: { projects?: unknown; folders?: unknown } }).state;
        const projects = state?.projects;
        const folders = state?.folders;
        if (!Array.isArray(projects) || (folders !== undefined && !Array.isArray(folders))) return null;
        const latest = projects.reduce<(typeof projects)[number] | null>((recent, project) =>
            typeof project.updatedAt === "string" && (!recent || project.updatedAt > String(recent.updatedAt)) ? project : recent, null);
        return { canvasCount: projects.length, folderCount: Array.isArray(folders) ? folders.length : 0, recentCanvasTitle: typeof latest?.title === "string" ? latest.title : null };
    } catch {
        return null;
    }
}

function serverWebdavProxy(): Plugin {
    const middleware = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const requestUrl = new URL(req.url || "/", "http://localhost");
        if (requestUrl.pathname !== "/api/webdav" && !requestUrl.pathname.startsWith("/api/webdav/")) return next();

        const workspace = await workspaceContext(req, requestUrl);
        if (!workspace) return sendJson(res, 401, { error: "Workspace selection required" });
        const isPropfind = req.method === "PROPFIND";
        const isWrite = Boolean(req.method && ["MKCOL", "PUT", "DELETE"].includes(req.method));
        if (isWrite && !canWriteWorkspace(workspace)) return sendJson(res, 403, { error: "当前工作区为只读权限" });

        let target: URL;
        let authorization: string;
        try {
            const webdav = readServerWebdavConfig();
            target = buildServerWebdavUrl(requestUrl, webdav);
            authorization = webdav.authorization;
        } catch (error) {
            console.error("Server WebDAV configuration failed", error);
            return sendJson(res, 503, { error: "WebDAV is not configured" });
        }

        if (isWrite && req.headers["x-infinite-canvas-sync-mode"] !== "manual") {
            return sendJson(res, 409, { error: "Automatic WebDAV writes are disabled; refresh the page and use manual sync" });
        }
        const headers: Record<string, string | string[] | undefined> = { ...req.headers, authorization };
        for (const name of Object.keys(headers)) if (name.startsWith("x-infinite-canvas-")) delete headers[name];
        delete headers["x-canvas-agent-token"];
        delete headers.host;
        delete headers.connection;
        if (isPropfind) delete headers["accept-encoding"];
        const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
        const relativePath = requestUrl.pathname === "/api/webdav" ? "" : requestUrl.pathname.slice("/api/webdav/".length);
        const relativeSegments = safeWebdavSegments(relativePath);
        const isWorkspaceRoot = relativeSegments.length === 1 && relativeSegments[0] === "workspaces";
        const isCurrentWorkspacePath = relativeSegments.length >= 2 && relativeSegments[0] === "workspaces" && relativeSegments[1] === workspace.id;
        // Directory initialization probes/creates the shared root before the
        // current workspace directory. Allow only those narrow root requests;
        // never allow listing or traversing other workspace paths.
        const canAccessWorkspaceRoot = isWorkspaceRoot && (req.method === "MKCOL" || (req.method === "PROPFIND" && req.headers.depth === "0"));
        if (relativeSegments.length && !isCurrentWorkspacePath && !canAccessWorkspaceRoot) return sendJson(res, 403, { error: "Workspace path is not allowed" });
        const upstream = transport(target, { method: req.method, headers }, (upstreamResponse) => {
            res.statusCode = upstreamResponse.statusCode || 502;
            for (const [name, value] of Object.entries(upstreamResponse.headers)) {
                if (value === undefined || name === "www-authenticate" || name === "connection" || (isPropfind && (name === "content-length" || name === "transfer-encoding"))) continue;
                res.setHeader(name, value);
            }
            if (!isPropfind) return upstreamResponse.pipe(res);
            const chunks: Buffer[] = [];
            upstreamResponse.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
            upstreamResponse.on("end", () => {
                const publicHref = requestUrl.pathname || "/api/webdav";
                const body = Buffer.concat(chunks)
                    .toString("utf8")
                    .replace(/<([A-Za-z][\w.-]*):href>[^<]*<\/\1:href>/gi, (_match, namespace: string) => `<${namespace}:href>${publicHref}</${namespace}:href>`);
                res.setHeader("Content-Length", Buffer.byteLength(body));
                res.end(body);
            });
        });
        upstream.on("error", (error) => {
            console.error("Server WebDAV proxy failed", error);
            if (!res.headersSent) return sendJson(res, 502, { error: "WebDAV request failed" });
            res.destroy(error);
        });
        req.on("aborted", () => upstream.destroy());
        req.pipe(upstream);
    };
    return {
        name: "server-webdav-proxy",
        configureServer(server) {
            server.middlewares.use(middleware);
        },
        configurePreviewServer(server) {
            server.middlewares.use(middleware);
        },
    };
}

function ipMatchesNetwork(address: string, network: string) {
    if (!network.includes("/")) return address === normalizeIp(network);
    const [base, prefixText] = network.split("/");
    const prefix = Number(prefixText);
    if (isIP(address) !== 4 || isIP(base) !== 4 || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (ipv4Number(address) & mask) === (ipv4Number(base) & mask);
}

function ipv4Number(value: string) {
    return value.split(".").reduce((result, part) => ((result << 8) | Number(part)) >>> 0, 0);
}

function serverConfigStorage(): Plugin {
    const middleware = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const requestUrl = new URL(req.url || "/", "http://localhost");
        if (requestUrl.pathname !== "/api/config") return next();

        res.setHeader("Cache-Control", "no-store");
        if (req.method === "GET") {
            try {
                const config = JSON.parse(await readFile(serverConfigPath, "utf8"));
                if (!isServerConfig(config)) return sendJson(res, 500, { error: "Stored configuration is invalid" });
                return sendJson(res, 200, redactServerSecrets(config));
            } catch (error) {
                if (isFileSystemError(error, "ENOENT")) {
                    res.statusCode = 204;
                    return res.end();
                }
                console.error("Server configuration read failed", error);
                return sendJson(res, 500, { error: "Configuration read failed" });
            }
        }

        if (req.method === "PUT") {
            try {
                const config = JSON.parse(await readRequestBody(req));
                if (!isServerConfig(config)) return sendJson(res, 400, { error: "Invalid configuration" });
                const stored = await readStoredServerConfig();
                await writeServerConfig(mergeServerSecrets(config, stored));
                return sendJson(res, 200, { saved: true });
            } catch (error) {
                if (error instanceof RequestBodyError) return sendJson(res, error.status, { error: error.message });
                if (error instanceof SyntaxError) return sendJson(res, 400, { error: "Invalid JSON" });
                console.error("Server configuration write failed", error);
                return sendJson(res, 500, { error: "Configuration write failed" });
            }
        }

        res.setHeader("Allow", "GET, PUT");
        return sendJson(res, 405, { error: "Method not allowed" });
    };

    return {
        name: "server-config-storage",
        configureServer(server) {
            server.middlewares.use(middleware);
        },
        configurePreviewServer(server) {
            server.middlewares.use(middleware);
        },
    };
}

function aiProviderProxy(): Plugin {
    const middleware = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const requestUrl = new URL(req.url || "/", "http://localhost");
        if (requestUrl.pathname !== aiProxyPath && !requestUrl.pathname.startsWith(`${aiProxyPath}/`)) return next();
        if (!req.method || !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return sendJson(res, 405, { error: "Method not allowed" });

        const parts = requestUrl.pathname.slice(`${aiProxyPath}/`.length).split("/");
        let channelId: string;
        let providerPath: string;
        try {
            channelId = decodeURIComponent(parts.shift() || "");
            providerPath = decodeURIComponent(`/${parts.join("/")}`) || "/";
        } catch {
            return sendJson(res, 400, { error: "Invalid AI request" });
        }
        if (!channelId || providerPath.includes("..") || providerPath.includes("\\") || !providerPath.startsWith("/")) return sendJson(res, 400, { error: "Invalid AI request" });

        const requestId = randomUUID();
        const started = Date.now();
        const controller = new AbortController();
        const onClose = () => { if (!res.writableEnded) controller.abort(); };
        res.once("close", onClose);
        res.setHeader("X-Request-ID", requestId);
        try {
            const stored = await readStoredServerConfig();
            const channel = findStoredChannel(stored, channelId);
            if (!channel) return sendJson(res, 404, { error: "AI channel not found" });
            const apiKey = typeof channel.apiKey === "string" ? channel.apiKey : "";
            const baseUrl = typeof channel.baseUrl === "string" ? channel.baseUrl : "";
            if (!apiKey || !baseUrl) return sendJson(res, 503, { error: "AI channel is not configured" });
            const providerBase = new URL(`${providerBaseUrl(baseUrl, channel.apiFormat)}/`);
            const target = new URL(providerPath.replace(/^\/+/, ""), providerBase);
            if (target.origin !== providerBase.origin || !target.pathname.startsWith(providerBase.pathname)) return sendJson(res, 403, { error: "AI endpoint is not allowed" });
            const normalizedProviderPath = `/${target.pathname.slice(providerBase.pathname.length)}`;
            if (!isAllowedAiProviderPath(channel.apiFormat, normalizedProviderPath)) return sendJson(res, 403, { error: "AI endpoint is not allowed" });
            target.search = requestUrl.search;
            const body = req.method === "GET" || req.method === "DELETE" ? undefined : await readRequestBuffer(req, maxAiRequestBytes, "AI request is too large");
            const headers = new Headers();
            const contentType = req.headers["content-type"];
            if (typeof contentType === "string") headers.set("content-type", contentType);
            if (channel.apiFormat === "gemini") headers.set("x-goog-api-key", apiKey);
            else headers.set("authorization", `Bearer ${apiKey}`);
            const upstream = await fetch(target, { method: req.method, headers, body, redirect: "error", signal: controller.signal });
            res.statusCode = upstream.status;
            copyProxyHeaders(upstream.headers, res);
            if (!upstream.body) return res.end();
            await forwardAiResponse(upstream, res);
            return;
        } catch (error) {
            if (error instanceof RequestBodyError) return sendJson(res, error.status, { error: error.message });
            const failure = error as { name?: string; code?: string; cause?: { code?: string } };
            console.error("AI provider proxy failed", { requestId, elapsedMs: Date.now() - started, name: failure?.name, code: failure?.cause?.code || failure?.code, headersSent: res.headersSent });
            return failAiResponse(res);
        } finally {
            res.off("close", onClose);
        }
    };
    return {
        name: "ai-provider-proxy",
        configureServer(server) {
            server.middlewares.use(middleware);
        },
        configurePreviewServer(server) {
            server.middlewares.use(middleware);
        },
    };
}

function promptSourceProxy(): Plugin {
    const middleware = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const match = /^\/api\/prompt-source\/([^/]+)$/.exec(new URL(req.url || "/", "http://localhost").pathname);
        if (!match) return next();
        if (req.method !== "GET") return sendJson(res, 405, { error: "Method not allowed" });
        try {
            const stored = asRecord(await readStoredServerConfig());
            const sources = asRecord(stored?.promptSources)?.sources;
            const source = Array.isArray(sources) ? sources.map(asRecord).find((item) => item?.id === decodeURIComponent(match[1])) : null;
            if (typeof source?.url !== "string") return sendJson(res, 404, { error: "提示词来源不存在" });
            const target = new URL(source.url);
            const address = await publicHttpsAddress(target);
            res.setHeader("Cache-Control", "no-store");
            const upstream = httpsRequest(target, {
                headers: { Accept: "application/json" },
                autoSelectFamily: false,
                lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
            }, (response) => {
                if ((response.statusCode || 0) >= 300 && (response.statusCode || 0) < 400) {
                    response.resume();
                    return sendJson(res, 502, { error: "提示词来源不允许重定向" });
                }
                res.statusCode = response.statusCode || 502;
                res.setHeader("Content-Type", "application/json; charset=utf-8");
                response.on("error", (error) => res.destroy(error));
                response.pipe(res);
            });
            upstream.on("error", (error) => {
                console.error("Prompt source request failed", error);
                if (!res.headersSent) return sendJson(res, 502, { error: "提示词来源请求失败" });
                res.destroy(error);
            });
            res.on("close", () => upstream.destroy());
            upstream.end();
        } catch (error) {
            console.error("Prompt source proxy failed", error);
            return sendJson(res, 502, { error: error instanceof Error ? error.message : "提示词来源请求失败" });
        }
    };
    return { name: "prompt-source-proxy", configureServer: (server) => { server.middlewares.use(middleware); }, configurePreviewServer: (server) => { server.middlewares.use(middleware); } };
}

async function publicHttpsAddress(target: URL) {
    if (target.protocol !== "https:" || target.username || target.password || (target.port && target.port !== "443")) throw new Error("仅支持公网 HTTPS 地址");
    const addresses = await lookup(target.hostname, { all: true });
    if (!addresses.length || addresses.some(({ address }) => ipaddr.process(address).range() !== "unicast")) throw new Error("目标地址不是公网地址");
    return addresses[0];
}

function remoteMediaProxy(): Plugin {
    const middleware = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const requestUrl = new URL(req.url || "/", "http://localhost");
        if (requestUrl.pathname !== "/api/remote-media") return next();
        if (req.method !== "GET") return sendJson(res, 405, { error: "Method not allowed" });
        try {
            const target = new URL(requestUrl.searchParams.get("url") || "");
            const address = await publicHttpsAddress(target);
            res.setHeader("Cache-Control", "no-store");
            res.setHeader("X-Content-Type-Options", "nosniff");
            const upstream = httpsRequest(target, {
                autoSelectFamily: false,
                lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
            }, (response) => {
                if ((response.statusCode || 0) >= 300 && (response.statusCode || 0) < 400) {
                    response.resume();
                    return sendJson(res, 502, { error: "远程媒体不允许重定向" });
                }
                res.statusCode = response.statusCode || 502;
                for (const name of ["content-type", "content-length"]) {
                    const value = response.headers[name];
                    if (value) res.setHeader(name, value);
                }
                response.on("error", (error) => res.destroy(error));
                response.pipe(res);
            });
            upstream.on("error", (error) => {
                console.error("Remote media request failed", error);
                if (!res.headersSent) return sendJson(res, 502, { error: "远程媒体请求失败" });
                res.destroy(error);
            });
            res.on("close", () => upstream.destroy());
            upstream.end();
        } catch (error) {
            return sendJson(res, 403, { error: error instanceof Error ? error.message : "远程媒体地址无效" });
        }
    };
    return { name: "remote-media-proxy", configureServer: (server) => { server.middlewares.use(middleware); }, configurePreviewServer: (server) => { server.middlewares.use(middleware); } };
}

function findStoredChannel(stored: unknown, channelId: string) {
    const config = asRecord(asRecord(stored)?.config);
    const channels = Array.isArray(config?.channels) ? config.channels : [];
    return channels.map(asRecord).find((channel) => channel?.id === channelId) || null;
}

function providerBaseUrl(baseUrl: string, apiFormat: unknown) {
    const url = new URL(baseUrl.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || isBlockedProviderHost(url.hostname)) throw new Error("AI provider URL is not allowed");
    url.search = "";
    url.hash = "";
    const normalized = url.toString().replace(/\/+$/, "");
    const lower = normalized.toLowerCase();
    if (apiFormat === "gemini") return lower.endsWith("/v1") || lower.endsWith("/v1beta") ? normalized : `${normalized}/v1beta`;
    if (apiFormat === "ark") return lower.endsWith("/api/v3") || lower.endsWith("/api/plan/v3") ? normalized : `${normalized}/api/v3`;
    return lower.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

function isBlockedProviderHost(hostname: string) {
    const normalized = normalizeIp(hostname.toLowerCase());
    if (normalized === "localhost" || normalized === "::1") return true;
    if (isIP(normalized) !== 4) return false;
    const first = Number(normalized.split(".")[0]);
    return first === 0 || first === 127 || first >= 224 || ipMatchesNetwork(normalized, "169.254.0.0/16");
}

function isAllowedAiProviderPath(apiFormat: unknown, path: string) {
    if (apiFormat === "gemini") return /^\/(?:models|operations)(?:\/|$)/.test(path) || /^\/files\/[^/]+:download$/.test(path);
    if (apiFormat === "custom") return /^\/(?:models|video\/generations)(?:\/|$)/.test(path);
    return /^\/(?:models|images|responses|chat\/completions|audio|videos|contents\/generations\/tasks)(?:\/|$)/.test(path);
}

async function readRequestBuffer(req: IncomingMessage, limit: number, tooLargeMessage: string) {
    const declaredLength = Number(req.headers["content-length"] || 0);
    if (declaredLength > limit) throw new RequestBodyError(413, tooLargeMessage);
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += buffer.length;
        if (length > limit) throw new RequestBodyError(413, tooLargeMessage);
        chunks.push(buffer);
    }
    return Buffer.concat(chunks);
}

function copyProxyHeaders(source: Headers, target: ServerResponse) {
    for (const name of ["content-type", "cache-control", "etag", "last-modified", "retry-after"]) {
        const value = source.get(name);
        if (value) target.setHeader(name, value);
    }
}

async function readRequestBody(req: IncomingMessage) {
    return (await readRequestBuffer(req, maxServerConfigBytes, "Configuration is too large")).toString("utf8");
}

let serverConfigWriteQueue = Promise.resolve();

async function writeServerConfig(config: unknown) {
    const write = serverConfigWriteQueue.catch(() => undefined).then(async () => {
        const directory = dirname(serverConfigPath);
        const temporaryPath = `${serverConfigPath}.${process.pid}.${randomUUID()}.tmp`;
        await mkdir(directory, { recursive: true, mode: 0o700 });
        try {
            await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
                encoding: "utf8",
                mode: 0o600,
                flag: "wx",
            });
            await rename(temporaryPath, serverConfigPath);
            await chmod(serverConfigPath, 0o600);
        } catch (error) {
            await unlink(temporaryPath).catch(() => undefined);
            throw error;
        }
    });
    serverConfigWriteQueue = write.then(() => undefined, () => undefined);
    return write;
}

function isServerConfig(value: unknown) {
    if (!value || typeof value !== "object") return false;
    const config = value as Record<string, unknown>;
    const promptSources = config.promptSources as Record<string, unknown> | undefined;
    return config.app === "infinite-canvas" && config.version === 1 && Boolean(config.config && config.webdav && promptSources && Array.isArray(promptSources.sources) && promptSources.schedule);
}

async function readStoredServerConfig() {
    try {
        const value = JSON.parse(await readFile(serverConfigPath, "utf8"));
        return isServerConfig(value) ? value : null;
    } catch (error) {
        if (isFileSystemError(error, "ENOENT")) return null;
        throw error;
    }
}

function redactServerSecrets(value: unknown) {
    const result = cloneJson(value) as Record<string, unknown>;
    const config = asRecord(result.config);
    const webdav = asRecord(result.webdav);
    if (config) {
        config.apiKey = "";
        if (Array.isArray(config.channels)) {
            config.channels = config.channels.map((channel) => {
                const safeChannel = asRecord(channel);
                if (safeChannel) {
                    safeChannel.hasApiKey = Boolean(safeChannel.apiKey);
                    safeChannel.apiKey = "";
                }
                return safeChannel || channel;
            });
        }
    }
    if (webdav) Object.assign(webdav, { url: webdav.url === "/api/webdav" ? "" : webdav.url, hasPassword: Boolean(webdav.password), password: "", autoSyncEnabled: false });
    return result;
}

function mergeServerSecrets(incoming: unknown, stored: unknown) {
    const result = cloneJson(incoming) as Record<string, unknown>;
    const nextConfig = asRecord(result.config);
    const previousConfig = asRecord(asRecord(stored)?.config);
    const nextWebdav = asRecord(result.webdav);
    const previousWebdav = asRecord(asRecord(stored)?.webdav);
    if (nextConfig) {
        nextConfig.apiKey = keepSecret(nextConfig.apiKey, previousConfig?.apiKey);
        const previousChannels = Array.isArray(previousConfig?.channels) ? previousConfig.channels : [];
        if (Array.isArray(nextConfig.channels)) {
            const incomingChannels = nextConfig.channels.map((channel) => {
                const nextChannel = asRecord(channel);
                if (!nextChannel) return channel;
                const id = nextChannel.id;
                const previousChannel = previousChannels
                    .map(asRecord)
                    .find((item) => item?.id === id);
                nextChannel.apiKey = keepSecret(nextChannel.apiKey, previousChannel?.apiKey);
                if (previousChannel?.managedModels === true && Array.isArray(previousChannel.models)) {
                    nextChannel.models = cloneJson(previousChannel.models);
                    nextChannel.managedModels = true;
                }
                return nextChannel;
            });
            nextConfig.channels = incomingChannels;
            nextConfig.models = incomingChannels.flatMap((channel) => {
                const record = asRecord(channel);
                const models = Array.isArray(record?.models) ? record.models : [];
                return models
                    .map((model) => (typeof model === "string" ? model : asRecord(model)?.name))
                    .filter((model): model is string => typeof model === "string" && Boolean(model))
                    .map((model) => `${String(record?.id || "default")}::${model}`);
            });
        }
        for (const key of ["model", "imageModel", "videoModel", "textModel", "audioModel"]) {
            if (!nextConfig[key] && typeof previousConfig?.[key] === "string") {
                nextConfig[key] = previousConfig[key];
            }
        }
        for (const [key, capability] of [
            ["model", "image"],
            ["imageModel", "image"],
            ["videoModel", "video"],
            ["textModel", "text"],
            ["audioModel", "audio"],
        ] as const) {
            const selected = typeof nextConfig[key] === "string" ? nextConfig[key] : "";
            if (selected) continue;
            nextConfig[key] = firstModelOption(nextConfig.channels, capability, "");
        }
    }
    if (nextWebdav) {
        // Connection fields are edited in Settings; requests still use the
        // authenticated server proxy and background uploads stay disabled.
        nextWebdav.autoSyncEnabled = false;
        if (nextWebdav.url === "/api/webdav") nextWebdav.url = typeof previousWebdav?.url === "string" && previousWebdav.url !== "/api/webdav" ? previousWebdav.url : "";
        nextWebdav.password = keepSecret(nextWebdav.password, previousWebdav?.password);
        delete nextWebdav.hasPassword;
    }
    return result;
}

function firstModelOption(channels: unknown, capability: string, preferredChannelId: string) {
    if (!Array.isArray(channels)) return "";
    const options = channels.flatMap((channel) => {
        const record = asRecord(channel);
        const id = typeof record?.id === "string" ? record.id : "";
        const models = Array.isArray(record?.models) ? record.models : [];
        return models.flatMap((model) => {
            const item = asRecord(model);
            return item?.capability === capability && typeof item.name === "string" && item.name ? [{ channelId: id, value: `${id || "default"}::${item.name}` }] : [];
        });
    });
    return options.find((option) => option.channelId === preferredChannelId)?.value || options[0]?.value || "";
}

function keepSecret(next: unknown, previous: unknown) {
    return typeof next === "string" && next.length > 0 ? next : typeof previous === "string" ? previous : next;
}

function asRecord(value: unknown) {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function normalizeWebdavPath(value: string) {
    return value.trim().replace(/^\/+|\/+$/g, "");
}

function readServerWebdavConfig() {
    const config = JSON.parse(readFileSync(serverConfigPath, "utf8"));
    if (!isServerConfig(config)) throw new Error("Invalid server configuration");
    const webdav = asRecord(asRecord(config)?.webdav);
    const username = typeof webdav?.username === "string" ? webdav.username : "";
    const password = typeof webdav?.password === "string" ? webdav.password : "";
    const directory = typeof webdav?.directory === "string" ? webdav.directory : "";
    const target = new URL(typeof webdav?.url === "string" ? webdav.url : "");
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || !username || !password) throw new Error("Invalid WebDAV configuration");
    target.search = "";
    target.hash = "";
    return { target, directory, authorization: `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}` };
}

function buildServerWebdavUrl(requestUrl: URL, config: ReturnType<typeof readServerWebdavConfig>) {
    const relativePath = requestUrl.pathname === "/api/webdav" ? "" : requestUrl.pathname.slice("/api/webdav/".length);
    const configuredSegments = safeWebdavSegments(config.directory);
    const requestSegments = safeWebdavSegments(relativePath);
    const target = new URL(config.target);
    const targetPath = target.pathname.replace(/\/+$/, "");
    const encodedPath = [...configuredSegments, ...requestSegments].map(encodeURIComponent).join("/");
    target.pathname = `${targetPath}/${encodedPath}` || "/";
    target.search = requestUrl.search;
    return target;
}

function safeWebdavSegments(value: string) {
    return normalizeWebdavPath(value)
        .split("/")
        .filter(Boolean)
        .map((segment) => {
            const decoded = decodeURIComponent(segment);
            if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\") || decoded.includes("\0")) throw new Error("Invalid WebDAV path");
            return decoded;
        });
}

function cloneJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(data));
}

function isFileSystemError(error: unknown, code: string) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

class RequestBodyError extends Error {
    constructor(public status: number, message: string) {
        super(message);
    }
}

const imageProxyPath = "/api/image-proxy";
const allowedImageHosts = [".r2.cloudflarestorage.com"];

function imageProxy(): Plugin {
    const middleware = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const requestUrl = new URL(req.url || "/", "http://localhost");
        if (requestUrl.pathname !== imageProxyPath) return next();

        if (req.method !== "GET") {
            res.statusCode = 405;
            res.setHeader("Allow", "GET");
            return res.end("Method not allowed");
        }

        const source = requestUrl.searchParams.get("url");
        if (!source) {
            res.statusCode = 400;
            return res.end("Missing image URL");
        }

        let target: URL;
        try {
            target = new URL(source);
        } catch {
            res.statusCode = 400;
            return res.end("Invalid image URL");
        }

        const hostname = target.hostname.toLowerCase();
        if (target.protocol !== "https:" || !allowedImageHosts.some((suffix) => hostname.endsWith(suffix))) {
            res.statusCode = 403;
            return res.end("Image host is not allowed");
        }

        try {
            const upstream = await fetch(target, { redirect: "error" });
            res.statusCode = upstream.status;
            for (const header of ["content-type", "content-length", "cache-control", "etag", "last-modified"]) {
                const value = upstream.headers.get(header);
                if (value) res.setHeader(header, value);
            }
            res.end(Buffer.from(await upstream.arrayBuffer()));
        } catch (error) {
            console.error("R2 image proxy failed", error);
            res.statusCode = 502;
            res.end("Image download failed");
        }
    };

    return {
        name: "r2-image-proxy",
        configureServer(server) {
            server.middlewares.use(middleware);
        },
        configurePreviewServer(server) {
            server.middlewares.use(middleware);
        },
    };
}

// Expose /plugins/index.json with local plugin files from public/plugins.
// The frontend can discover and list them when enabled; development reads the directory live, while builds emit a static registry.
function localPluginsManifest(): Plugin {
    const pluginsDir = resolve(webDir, "public/plugins");
    const listLocalPlugins = () => {
        try {
            return readdirSync(pluginsDir)
                .filter((file) => file.endsWith(".js"))
                .sort()
                .map((file) => `/plugins/${file}`);
        } catch {
            return [];
        }
    };
    return {
        name: "local-plugins-manifest",
        configureServer(server) {
            server.middlewares.use("/plugins/index.json", (_req, res) => {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(listLocalPlugins()));
            });
        },
        generateBundle() {
            this.emitFile({ type: "asset", fileName: "plugins/index.json", source: JSON.stringify(listLocalPlugins()) });
        },
    };
}

export default defineConfig({
    base: process.env.VITE_BASE || "/",
    plugins: [react(), localPluginsManifest(), sessionContext(), authAccess(), serverApiAccessControl(), workspaceAccess(), workspaceMediaStorage(), workspaceDataAccess(), workspacePromptsAccess(), serverWebdavProxy(), serverConfigStorage(), aiProviderProxy(), promptSourceProxy(), remoteMediaProxy(), imageProxy()],
    server: { proxy: { [canvasAgentProxyPath]: canvasAgentProxy } },
    preview: { allowedHosts: (process.env.INFINITE_CANVAS_ALLOWED_HOSTS || "ubuntu-server").split(",").map((host) => host.trim()).filter(Boolean), proxy: { [canvasAgentProxyPath]: canvasAgentProxy } },
    resolve: {
        alias: {
            "@": resolve(webDir, "src"),
        },
    },
    define: {
        __APP_VERSION__: JSON.stringify(localVersion),
        __APP_RELEASES__: JSON.stringify(parseChangelog(localChangelog)),
    },
});
