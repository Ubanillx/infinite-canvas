import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { parseChangelog } from "./src/lib/release";
import { execute, findSessionUser, getDatabase, hashPassword, hashToken, isoNow, newId, newSessionToken, queryMany, queryOne, transaction, verifyPassword, type SessionUser, type SqliteUser } from "./src/server/sqlite";

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
const protectedApiPaths = ["/api/auth", "/api/config", "/api/workspaces", "/api/data", "/api/media", aiProxyPath, "/api/webdav", "/api/image-proxy", canvasAgentProxyPath];
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
                const db = await getDatabase();
                (req as AuthenticatedRequest).infiniteCanvasUser = findSessionUser(db, token) || undefined;
            } catch (error) {
                console.error("SQLite session lookup failed", error);
            }
        }
        next();
    };
    return { name: "sqlite-session-context", configureServer: (server) => { server.middlewares.use(middleware); }, configurePreviewServer: (server) => { server.middlewares.use(middleware); } };
}

function parseCookie(value: string) {
    return Object.fromEntries(value.split(";").map((item) => item.trim().split("=")).filter(([key, val]) => key && val).map(([key, ...rest]) => [key, decodeURIComponent(rest.join("="))]));
}

function setSessionCookie(res: ServerResponse, token: string, maxAge = authCookieMaxAgeSeconds) {
    res.setHeader("Set-Cookie", `${authCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);
}

function publicUser(user: SqliteUser) {
    return { id: user.id, username: user.username, displayName: user.displayName, createdAt: user.createdAt };
}

function authAccess(): Plugin {
    const middleware = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const requestUrl = new URL(req.url || "/", "http://localhost");
        if (!requestUrl.pathname.startsWith("/api/auth")) return next();
        res.setHeader("Cache-Control", "no-store");
        try {
            const db = await getDatabase();
            const current = (req as AuthenticatedRequest).infiniteCanvasUser;
            if (requestUrl.pathname === "/api/auth/register" && req.method === "POST") {
                const body = await readJsonBody(req);
                const username = typeof body.username === "string" ? body.username.trim() : "";
                const password = typeof body.password === "string" ? body.password : "";
                const displayName = typeof body.displayName === "string" ? body.displayName.trim() : username;
                const workspaceName = typeof body.workspaceName === "string" ? body.workspaceName.trim() : `${displayName || username}的工作区`;
                if (!/^[\p{L}\p{N}._-]{3,64}$/u.test(username) || password.length < 8 || password.length > 256 || !displayName || displayName.length > 80 || !workspaceName || workspaceName.length > 80) return sendJson(res, 400, { error: "用户名、密码或工作区名称无效" });
                if (queryOne(db, "SELECT id FROM users WHERE username = ?", username)) return sendJson(res, 409, { error: "用户名已存在" });
                const now = isoNow();
                const userId = newId();
                const workspaceId = newId();
                transaction(db, () => {
                    execute(db, "INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)", userId, username, displayName, hashPassword(password), now);
                    execute(db, "INSERT INTO workspaces (id, name, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", workspaceId, workspaceName, userId, now, now);
                    execute(db, "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)", workspaceId, userId, now);
                });
                const user = { id: userId, username, displayName, createdAt: now } satisfies SqliteUser;
                const token = newSessionToken();
                execute(db, "INSERT INTO sessions (token_hash, user_id, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)", hashToken(token), userId, new Date(Date.now() + authCookieMaxAgeSeconds * 1000).toISOString(), now, now);
                setSessionCookie(res, token);
                return sendJson(res, 201, { user: publicUser(user), workspaces: [{ id: workspaceId, name: workspaceName, role: "owner", createdAt: now }] });
            }
            if (requestUrl.pathname === "/api/auth/login" && req.method === "POST") {
                const body = await readJsonBody(req);
                const username = typeof body.username === "string" ? body.username.trim() : "";
                const password = typeof body.password === "string" ? body.password : "";
                const row = queryOne<{ id: string; username: string; display_name: string; password_hash: string; created_at: string }>(db, "SELECT id, username, display_name, password_hash, created_at FROM users WHERE username = ?", username);
                if (!row || !verifyPassword(password, row.password_hash)) return sendJson(res, 401, { error: "用户名或密码不正确" });
                const now = isoNow();
                const token = newSessionToken();
                execute(db, "INSERT INTO sessions (token_hash, user_id, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)", hashToken(token), row.id, new Date(Date.now() + authCookieMaxAgeSeconds * 1000).toISOString(), now, now);
                setSessionCookie(res, token);
                return sendJson(res, 200, { user: { id: row.id, username: row.username, displayName: row.display_name, createdAt: row.created_at }, workspaces: listUserWorkspaces(db, row.id) });
            }
            if (requestUrl.pathname === "/api/auth/logout" && req.method === "POST") {
                const token = parseCookie(req.headers.cookie || "")[authCookieName];
                if (token) execute(db, "DELETE FROM sessions WHERE token_hash = ?", hashToken(token));
                setSessionCookie(res, "", 0);
                return sendJson(res, 200, { ok: true });
            }
            if (requestUrl.pathname === "/api/auth/me" && req.method === "GET") {
                if (!current) return sendJson(res, 401, { error: "尚未登录" });
                return sendJson(res, 200, { user: publicUser(current), workspaces: listUserWorkspaces(db, current.id) });
            }
            return sendJson(res, 405, { error: "Method not allowed" });
        } catch (error) {
            if (error instanceof RequestBodyError) return sendJson(res, error.status, { error: error.message });
            console.error("Authentication request failed", error);
            return sendJson(res, 500, { error: "认证服务暂时不可用" });
        }
    };
    return { name: "sqlite-auth", configureServer: (server) => { server.middlewares.use(middleware); }, configurePreviewServer: (server) => { server.middlewares.use(middleware); } };
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

function listUserWorkspaces(db: Awaited<ReturnType<typeof getDatabase>>, userId: string) {
    return queryMany<{ id: string; name: string; role: string; createdAt: string }>(db, "SELECT w.id, w.name, m.role, w.created_at AS createdAt FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? ORDER BY w.created_at", userId);
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

type WorkspaceContext = { id: string; name: string; role: "owner" | "editor" | "viewer"; createdAt: string };

function workspaceIdFromRequest(req: IncomingMessage, requestUrl = new URL(req.url || "/", "http://localhost")) {
    const header = req.headers["x-infinite-canvas-workspace"];
    return typeof header === "string" && header ? header : requestUrl.searchParams.get("workspaceId") || "";
}

async function workspaceContext(req: IncomingMessage, requestUrl = new URL(req.url || "/", "http://localhost")): Promise<WorkspaceContext | null> {
    const id = workspaceIdFromRequest(req, requestUrl);
    const tokenHeader = req.headers["x-infinite-canvas-workspace-token"];
    const token = typeof tokenHeader === "string" && tokenHeader ? tokenHeader : requestUrl.searchParams.get("workspaceToken") || "";
    if (!id || !token) return null;
    const db = await getDatabase();
    const row = queryOne<{ id: string; name: string; created_at: string }>(db, "SELECT id, name, created_at FROM workspaces WHERE id = ? AND legacy_key_hash = ?", id, hashToken(token));
    return row ? { id: row.id, name: row.name, role: "owner", createdAt: row.created_at } : null;
}

function canWriteWorkspace(context: WorkspaceContext) {
    return context.role === "owner" || context.role === "editor";
}

function workspaceActorId(db: Awaited<ReturnType<typeof getDatabase>>) {
    const existing = queryOne<{ id: string }>(db, "SELECT id FROM users ORDER BY created_at LIMIT 1");
    if (existing) return existing.id;
    const id = newId();
    const now = isoNow();
    execute(db, "INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)", id, `workspace-system-${id.slice(0, 8)}`, "工作区系统用户", hashPassword(newSessionToken()), now);
    return id;
}

const workspaceDataDomains = new Set(["canvas", "assets", "image-workbench", "video-workbench", "agent-sessions"]);
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
            const db = await getDatabase();
            const actorId = workspaceActorId(db);
            if (dataMatch) {
                const domain = decodeURIComponent(dataMatch[1]);
                if (!workspaceDataDomains.has(domain)) return sendJson(res, 404, { error: "未知数据域" });
                if (req.method === "GET") {
                    const row = queryOne<{ payload: string; revision: number; updated_at: string; updated_by: string }>(db, "SELECT payload, revision, updated_at, updated_by FROM workspace_data WHERE workspace_id = ? AND domain = ?", context.id, domain);
                    return sendJson(res, 200, row ? { domain, payload: JSON.parse(row.payload), revision: row.revision, updatedAt: row.updated_at, updatedBy: row.updated_by } : { domain, payload: null, revision: 0, updatedAt: null, updatedBy: null });
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
                const now = isoNow();
                let nextRevision = 0;
                const conflictRow = transaction(db, () => {
                    const current = queryOne<{ payload: string; revision: number; updated_at: string; updated_by: string }>(db, "SELECT payload, revision, updated_at, updated_by FROM workspace_data WHERE workspace_id = ? AND domain = ?", context.id, domain);
                    const currentRevision = current?.revision || 0;
                    if (currentRevision !== revision) return current || { payload: "null", revision: 0, updated_at: "", updated_by: "" };
                    nextRevision = currentRevision + 1;
                    if (current) execute(db, "UPDATE workspace_data SET payload = ?, revision = ?, updated_at = ?, updated_by = ? WHERE workspace_id = ? AND domain = ?", payload, nextRevision, now, actorId, context.id, domain);
                    else execute(db, "INSERT INTO workspace_data (workspace_id, domain, payload, revision, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)", context.id, domain, payload, nextRevision, now, actorId);
                    execute(db, "UPDATE workspaces SET updated_at = ? WHERE id = ?", now, context.id);
                    return null;
                });
                if (conflictRow) return sendJson(res, 409, { error: "数据已被其他成员更新，请先刷新后处理冲突", domain, payload: JSON.parse(conflictRow.payload), revision: conflictRow.revision, updatedAt: conflictRow.updated_at, updatedBy: conflictRow.updated_by });
                return sendJson(res, 200, { domain, payload: body.payload, revision: nextRevision, updatedAt: now, updatedBy: actorId });
            }
            if (req.method === "GET") {
                const files = queryMany<{ storage_key: string; remote_path: string; mime_type: string; bytes: number; created_at: string; updated_at: string }>(db, "SELECT storage_key, remote_path, mime_type, bytes, created_at, updated_at FROM media_files WHERE workspace_id = ? ORDER BY updated_at DESC", context.id);
                return sendJson(res, 200, { files: files.map((file) => ({ storageKey: file.storage_key, remotePath: file.remote_path, mimeType: file.mime_type, bytes: file.bytes, createdAt: file.created_at, updatedAt: file.updated_at })) });
            }
            if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
            if (!canWriteWorkspace(context)) return sendJson(res, 403, { error: "当前工作区为只读权限" });
            const body = await readJsonBody(req);
            const files = Array.isArray(body.files) ? body.files : [];
            if (files.length > 1000) return sendJson(res, 400, { error: "媒体索引条目过多" });
            const now = isoNow();
            transaction(db, () => {
                for (const item of files) {
                    const file = asRecord(item);
                    const storageKey = typeof file?.storageKey === "string" ? file.storageKey : "";
                    const remotePath = typeof file?.remotePath === "string" ? file.remotePath : "";
                    const mimeType = typeof file?.mimeType === "string" ? file.mimeType : "application/octet-stream";
                    const bytes = typeof file?.bytes === "number" ? file.bytes : -1;
                    if (!storageKey || !remotePath || bytes < 0 || !Number.isSafeInteger(bytes)) continue;
                    execute(db, "INSERT INTO media_files (workspace_id, storage_key, remote_path, mime_type, bytes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, storage_key) DO UPDATE SET remote_path = excluded.remote_path, mime_type = excluded.mime_type, bytes = excluded.bytes, updated_at = excluded.updated_at", context.id, storageKey, remotePath, mimeType, bytes, now, now);
                }
            });
            return sendJson(res, 200, { saved: true });
        } catch (error) {
            if (error instanceof RequestBodyError) return sendJson(res, error.status, { error: error.message });
            console.error("Workspace data request failed", error);
            return sendJson(res, 500, { error: "工作区数据服务暂时不可用" });
        }
    };
    return { name: "sqlite-workspace-data", configureServer: (server) => { server.middlewares.use(middleware); }, configurePreviewServer: (server) => { server.middlewares.use(middleware); } };
}

function workspaceAccess(): Plugin {
    const middleware = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const requestUrl = new URL(req.url || "/", "http://localhost");
        if (!requestUrl.pathname.startsWith("/api/workspaces")) return next();
        res.setHeader("Cache-Control", "no-store");
        try {
            const db = await getDatabase();
            if (requestUrl.pathname === "/api/workspaces" && req.method === "GET") {
                const rows = queryMany<{ id: string; name: string; created_at: string }>(db, "SELECT id, name, created_at FROM workspaces ORDER BY updated_at DESC, created_at DESC");
                return sendJson(res, 200, { workspaces: rows.map((row) => ({ id: row.id, name: row.name, role: "owner", createdAt: row.created_at })) });
            }
            if (requestUrl.pathname === "/api/workspaces" && req.method === "POST") {
                const body = await readJsonBody(req);
                const name = typeof body.name === "string" ? body.name.trim() : "";
                if (!name || name.length > 80) return sendJson(res, 400, { error: "工作区名称无效" });
                const now = isoNow();
                const id = newId();
                const accessKey = newSessionToken();
                transaction(db, () => {
                    execute(db, "INSERT INTO workspaces (id, name, owner_user_id, legacy_key_hash, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?)", id, name, hashToken(accessKey), now, now);
                });
                return sendJson(res, 201, { workspace: { id, name, role: "owner", createdAt: now }, accessKey });
            }
            if (requestUrl.pathname === "/api/workspaces/unlock" && req.method === "POST") {
                const body = await readJsonBody(req);
                const id = typeof body.id === "string" ? body.id.trim() : "";
                const accessKey = typeof body.accessKey === "string" ? body.accessKey.trim() : "";
                const workspace = queryOne<{ id: string; name: string; created_at: string; legacy_key_hash: string | null }>(db, "SELECT id, name, created_at, legacy_key_hash FROM workspaces WHERE id = ?", id);
                if (!workspace || !workspace.legacy_key_hash || !accessKey || workspace.legacy_key_hash !== hashToken(accessKey)) return sendJson(res, 401, { error: "工作区不存在或访问密钥不正确" });
                return sendJson(res, 200, { workspace: { id: workspace.id, name: workspace.name, role: "owner", createdAt: workspace.created_at } });
            }
            if (requestUrl.pathname === "/api/workspaces/current" && req.method === "GET") {
                const context = await workspaceContext(req, requestUrl);
                return context ? sendJson(res, 200, { workspace: context }) : sendJson(res, 404, { error: "工作区不存在或访问密钥不正确" });
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

function serverWebdavProxy(): Plugin {
    const middleware = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const requestUrl = new URL(req.url || "/", "http://localhost");
        if (requestUrl.pathname !== "/api/webdav" && !requestUrl.pathname.startsWith("/api/webdav/")) return next();

        const workspace = await workspaceContext(req, requestUrl);
        if (!workspace) return sendJson(res, 401, { error: "Workspace authentication required" });

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

        const isPropfind = req.method === "PROPFIND";
        const isWrite = Boolean(req.method && ["MKCOL", "PUT", "DELETE"].includes(req.method));
        if (isWrite && req.headers["x-infinite-canvas-sync-mode"] !== "manual") {
            return sendJson(res, 409, { error: "Automatic WebDAV writes are disabled; refresh the page and use manual sync" });
        }
        const headers: Record<string, string | string[] | undefined> = { ...req.headers, authorization };
        delete headers["x-infinite-canvas-workspace"];
        delete headers["x-infinite-canvas-workspace-token"];
        delete headers["x-canvas-agent-token"];
        delete headers["x-infinite-canvas-sync-mode"];
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
            const upstream = await fetch(target, { method: req.method, headers, body, redirect: "error" });
            res.statusCode = upstream.status;
            copyProxyHeaders(upstream.headers, res);
            if (!upstream.body) return res.end();
            const reader = upstream.body.getReader();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(Buffer.from(value));
            }
            return res.end();
        } catch (error) {
            if (error instanceof RequestBodyError) return sendJson(res, error.status, { error: error.message });
            console.error("AI provider proxy failed", error);
            return sendJson(res, 502, { error: "AI provider request failed" });
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
    if (apiFormat === "gemini") return /^\/(?:models|operations)(?:\/|$)/.test(path);
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
    for (const name of ["content-type", "content-length", "cache-control", "etag", "last-modified", "retry-after"]) {
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
    if (webdav) Object.assign(webdav, { url: "/api/webdav", username: "", password: "", directory: "", autoSyncEnabled: false });
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
            const incomingIds = new Set(incomingChannels.map((channel) => asRecord(channel)?.id).filter(Boolean));
            const mergedChannels = [
                ...incomingChannels,
                ...previousChannels.filter((channel) => {
                    const id = asRecord(channel)?.id;
                    return typeof id === "string" && !incomingIds.has(id);
                }),
            ];
            nextConfig.channels = mergedChannels;
            nextConfig.models = mergedChannels.flatMap((channel) => {
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
        const availableModels = new Set(Array.isArray(nextConfig.models) ? nextConfig.models.filter((model): model is string => typeof model === "string" && Boolean(model)) : []);
        for (const [key, capability] of [
            ["model", "image"],
            ["imageModel", "image"],
            ["videoModel", "video"],
            ["textModel", "text"],
            ["audioModel", "audio"],
        ] as const) {
            const selected = typeof nextConfig[key] === "string" ? nextConfig[key] : "";
            if (availableModels.has(selected)) continue;
            const channelId = selected.includes("::") ? selected.slice(0, selected.indexOf("::")) : "";
            nextConfig[key] = firstModelOption(nextConfig.channels, capability, channelId);
        }
    }
    if (nextWebdav) {
        // WebDAV is server-managed and synchronization is manual. Enforce this
        // server-side so an old client cannot re-enable background uploads.
        nextWebdav.autoSyncEnabled = false;
        nextWebdav.url = typeof previousWebdav?.url === "string" ? previousWebdav.url : nextWebdav.url;
        nextWebdav.username = typeof previousWebdav?.username === "string" ? previousWebdav.username : nextWebdav.username;
        nextWebdav.directory = typeof previousWebdav?.directory === "string" ? previousWebdav.directory : nextWebdav.directory;
        nextWebdav.password = keepSecret(nextWebdav.password, previousWebdav?.password);
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
    plugins: [react(), localPluginsManifest(), sessionContext(), authAccess(), serverApiAccessControl(), workspaceAccess(), workspaceDataAccess(), serverWebdavProxy(), serverConfigStorage(), aiProviderProxy(), imageProxy()],
    server: { proxy: { [canvasAgentProxyPath]: canvasAgentProxy } },
    preview: { allowedHosts: ["ubuntu-server"], proxy: { [canvasAgentProxyPath]: canvasAgentProxy } },
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
