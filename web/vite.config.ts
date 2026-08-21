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

const serverConfigPath = resolve(process.env.INFINITE_CANVAS_DATA_DIR || resolve(webDir, "../data"), "config.json");
const maxServerConfigBytes = 1024 * 1024;
const aiProxyPath = "/api/ai";
const maxAiRequestBytes = 64 * 1024 * 1024;
const protectedApiPaths = ["/api/config", aiProxyPath, "/api/webdav", "/api/image-proxy", canvasAgentProxyPath];
const allowedNetworks = (process.env.INFINITE_CANVAS_ALLOWED_NETWORKS || "127.0.0.1,::1,192.168.0.0/22")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

function serverApiAccessControl(): Plugin {
    const middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const pathname = new URL(req.url || "/", "http://localhost").pathname;
        if (!protectedApiPaths.some((path) => pathname === path || pathname.startsWith(`${path}/`))) return next();
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

function serverWebdavProxy(): Plugin {
    const middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const requestUrl = new URL(req.url || "/", "http://localhost");
        if (requestUrl.pathname !== "/api/webdav" && !requestUrl.pathname.startsWith("/api/webdav/")) return next();

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
        const headers = { ...req.headers, authorization };
        delete headers.host;
        delete headers.connection;
        if (isPropfind) delete headers["accept-encoding"];
        const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
        const upstream = transport(target, { method: req.method, headers }, (upstreamResponse) => {
            res.statusCode = upstreamResponse.statusCode || 502;
            for (const [name, value] of Object.entries(upstreamResponse.headers)) {
                if (value === undefined || name === "www-authenticate" || name === "connection" || (isPropfind && name === "content-length")) continue;
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
    return /^\/(?:models|images|responses|chat\/completions|audio|videos)(?:\/|$)/.test(path);
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

async function writeServerConfig(config: unknown) {
    const directory = dirname(serverConfigPath);
    const temporaryPath = `${serverConfigPath}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
        await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await rename(temporaryPath, serverConfigPath);
        await chmod(serverConfigPath, 0o600);
    } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
    }
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
    if (webdav) Object.assign(webdav, { url: "/api/webdav", username: "", password: "", directory: "" });
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
            nextConfig.channels = nextConfig.channels.map((channel) => {
                const nextChannel = asRecord(channel);
                if (!nextChannel) return channel;
                const id = nextChannel.id;
                const previousChannel = previousChannels
                    .map(asRecord)
                    .find((item) => item?.id === id);
                nextChannel.apiKey = keepSecret(nextChannel.apiKey, previousChannel?.apiKey);
                return nextChannel;
            });
        }
    }
    if (nextWebdav) {
        nextWebdav.url = typeof previousWebdav?.url === "string" ? previousWebdav.url : nextWebdav.url;
        nextWebdav.username = typeof previousWebdav?.username === "string" ? previousWebdav.username : nextWebdav.username;
        nextWebdav.directory = typeof previousWebdav?.directory === "string" ? previousWebdav.directory : nextWebdav.directory;
        nextWebdav.password = keepSecret(nextWebdav.password, previousWebdav?.password);
    }
    return result;
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
    plugins: [react(), localPluginsManifest(), serverApiAccessControl(), serverWebdavProxy(), serverConfigStorage(), aiProviderProxy(), imageProxy()],
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
