import { readFileSync } from "node:fs";
import http, { type IncomingMessage, type RequestOptions } from "node:http";
import https from "node:https";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Readable } from "node:stream";

export type WebdavConfig = { target: URL; directory: string; authorization: string };
export type WebdavStream = { stream: IncomingMessage; contentLength?: number };

const METADATA_TIMEOUT_MS = 60_000;
const MEDIA_IDLE_TIMEOUT_MS = 10 * 60_000;
const serverConfigPath = resolve(process.env.INFINITE_CANVAS_DATA_DIR || resolve(process.env.HOME || homedir(), ".infinite-canvas/data"), "config.json");
const directoryCache = new Set<string>();

export function readServerWebdavConfig(): WebdavConfig {
    const config = JSON.parse(readFileSync(serverConfigPath, "utf8")) as { webdav?: Record<string, unknown> };
    const webdav = config.webdav;
    const username = typeof webdav?.username === "string" ? webdav.username : "";
    const password = typeof webdav?.password === "string" ? webdav.password : "";
    const directory = typeof webdav?.directory === "string" ? webdav.directory : "";
    const target = new URL(typeof webdav?.url === "string" ? webdav.url : "");
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || !username || !password) throw new Error("WebDAV 配置无效");
    target.search = "";
    target.hash = "";
    return { target, directory, authorization: `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}` };
}

export function webdavPathSegments(value: string) {
    return normalizeWebdavPath(value)
        .split("/")
        .filter(Boolean)
        .map((segment) => {
            const decoded = decodeURIComponent(segment);
            if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\") || decoded.includes("\0")) throw new Error("WebDAV 路径无效");
            return decoded;
        });
}

export async function testWebdavConnection(config: WebdavConfig) {
    await ensureWebdavDirectory(config, "");
    const response = await webdavRequest(config, "", { method: "PROPFIND", headers: { Depth: "0" } });
    if (isOk(response) || statusCode(response) === 207) {
        response.resume();
        return;
    }
    await throwWebdavError(response, "WebDAV 连接失败");
}

export async function ensureWebdavDirectory(config: WebdavConfig, path: string) {
    const fullPath = [config.directory, path].filter(Boolean).join("/");
    const cacheKey = `${config.target.href}:${fullPath}`;
    if (directoryCache.has(cacheKey)) return;
    // webdavRequest already prefixes config.directory, so create paths through
    // a rootless config; otherwise configured subdirectories are duplicated.
    const rootConfig = { ...config, directory: "" };
    let current = "";
    for (const segment of [...webdavPathSegments(config.directory), ...webdavPathSegments(path)]) {
        current = current ? `${current}/${segment}` : segment;
        const response = await webdavRequest(rootConfig, current, { method: "MKCOL" });
        if (isOk(response)) continue;
        if ([403, 405, 409, 423].includes(statusCode(response)) && await webdavExists(rootConfig, current)) continue;
        await throwWebdavError(response, `无法创建 WebDAV 目录 ${current}`);
    }
    directoryCache.add(cacheKey);
}

/** Returns the remote object length when the server exposes DAV:getcontentlength. */
export async function webdavContentLength(config: WebdavConfig, path: string) {
    const response = await webdavRequest(config, path, { method: "PROPFIND", headers: { Depth: "0" }, timeoutMs: METADATA_TIMEOUT_MS });
    if (statusCode(response) === 404) return null;
    if (!isOk(response) && statusCode(response) !== 207) await throwWebdavError(response, `无法读取 WebDAV 文件 ${path}`);
    const text = await readResponseText(response);
    const match = /<[^>]*getcontentlength[^>]*>(\d+)<\/[^>]*getcontentlength>/i.exec(text);
    if (match) return Number(match[1]);
    const head = await webdavRequest(config, path, { method: "HEAD", timeoutMs: METADATA_TIMEOUT_MS }).catch(() => null);
    if (!head) return null;
    head.resume();
    if (!isOk(head)) return null;
    const length = Number(head.headers["content-length"]);
    return Number.isFinite(length) ? length : null;
}

export function clearWebdavDirectoryCache() {
    directoryCache.clear();
}

export async function webdavExists(config: WebdavConfig, path: string) {
    const response = await webdavRequest(config, path, { method: "PROPFIND", headers: { Depth: "0" }, timeoutMs: METADATA_TIMEOUT_MS });
    return isOk(response) || statusCode(response) === 207;
}

export async function listWebdavDirectory(config: WebdavConfig, path: string) {
    const response = await webdavRequest(config, path, { method: "PROPFIND", headers: { Depth: "1" }, timeoutMs: METADATA_TIMEOUT_MS });
    if (statusCode(response) === 404) return [];
    if (!isOk(response) && statusCode(response) !== 207) await throwWebdavError(response, `无法读取 WebDAV 目录 ${path}`);
    const text = await readResponseText(response);
    const current = webdavPathSegments(path).at(-1) || "";
    return [...new Set([...text.matchAll(/<[^>]*:?href[^>]*>([^<]+)<\/[^>]*:?href>/gi)]
        .map((match) => hrefName(decodeXml(match[1])))
        .filter((name) => name && name !== current))];
}

export async function putWebdavStream(config: WebdavConfig, path: string, body: Readable, contentType: string, contentLength: number) {
    await ensureWebdavDirectory(config, parentPath(path));
    const response = await webdavRequest(config, path, {
        method: "PUT",
        headers: { "Content-Type": contentType, "Content-Length": String(contentLength) },
        body,
        timeoutMs: MEDIA_IDLE_TIMEOUT_MS,
    });
    if (!isOk(response)) await throwWebdavError(response, `无法上传 WebDAV 文件 ${path}`);
}

export async function putWebdavBuffer(config: WebdavConfig, path: string, body: Buffer, contentType = "application/octet-stream") {
    await putWebdavStream(config, path, Readable.from(body), contentType, body.length);
}

export async function getWebdavStream(config: WebdavConfig, path: string) {
    const response = await webdavRequest(config, path, { method: "GET", timeoutMs: MEDIA_IDLE_TIMEOUT_MS });
    if (statusCode(response) === 404) return null;
    if (!isOk(response)) await throwWebdavError(response, `无法下载 WebDAV 文件 ${path}`);
    const contentLength = Number(response.headers["content-length"]);
    return { stream: response, contentLength: Number.isFinite(contentLength) ? contentLength : undefined } satisfies WebdavStream;
}

export async function deleteWebdavPath(config: WebdavConfig, path: string) {
    const response = await webdavRequest(config, path, { method: "DELETE", timeoutMs: METADATA_TIMEOUT_MS });
    if (isOk(response) || statusCode(response) === 404) return;
    if (![409, 423].includes(statusCode(response))) await throwWebdavError(response, `无法删除 WebDAV 路径 ${path}`);
    for (const name of await listWebdavDirectory(config, path)) await deleteWebdavPath(config, `${path}/${name}`);
    const retry = await webdavRequest(config, path, { method: "DELETE", timeoutMs: METADATA_TIMEOUT_MS });
    if (!isOk(retry) && statusCode(retry) !== 404) await throwWebdavError(retry, `无法删除 WebDAV 路径 ${path}`);
}

function parentPath(path: string) {
    return normalizeWebdavPath(path).split("/").slice(0, -1).join("/");
}

function webdavRequest(config: WebdavConfig, path: string, options: RequestOptions & { method: string; body?: Readable; timeoutMs?: number }) {
    const url = buildWebdavUrl(config, path);
    const requestOptions = { method: options.method, headers: { ...options.headers, Authorization: config.authorization } };
    return new Promise<IncomingMessage>((resolve, reject) => {
        const request = url.protocol === "https:" ? https.request(url, requestOptions, resolve) : http.request(url, requestOptions, resolve);
        request.setTimeout(options.timeoutMs || METADATA_TIMEOUT_MS, () => request.destroy(new Error("WebDAV 请求超时")));
        request.on("error", (error) => reject(error instanceof Error ? error : new Error(String(error))));
        if (options.body) {
            options.body.on("error", (error) => request.destroy(error));
            options.body.pipe(request);
        } else {
            request.end();
        }
    });
}

function buildWebdavUrl(config: WebdavConfig, path: string) {
    const configured = webdavPathSegments(config.directory);
    const requested = webdavPathSegments(path);
    const target = new URL(config.target);
    const targetPath = target.pathname.replace(/\/+$/, "");
    const encoded = [...configured, ...requested].map(encodeURIComponent).join("/");
    target.pathname = `${targetPath}/${encoded}` || "/";
    return target;
}

function statusCode(response: IncomingMessage) {
    return response.statusCode || 0;
}

function isOk(response: IncomingMessage) {
    return statusCode(response) >= 200 && statusCode(response) < 300;
}

async function throwWebdavError(response: IncomingMessage, fallback: string): Promise<never> {
    const detail = await readResponseText(response).catch(() => "");
    if (statusCode(response) === 401 || statusCode(response) === 403) throw new Error("WebDAV 认证失败或无权限");
    if (statusCode(response) === 404) throw new Error("WebDAV 路径不存在");
    throw new Error(`${fallback}（HTTP ${statusCode(response) || "unknown"}${detail ? `: ${detail.slice(0, 120)}` : ""}）`);
}

async function readResponseText(response: IncomingMessage) {
    const chunks: Buffer[] = [];
    for await (const chunk of response) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
}

function hrefName(href: string) {
    const value = href.trim().replace(/[?#].*$/, "");
    let pathname = value;
    if (/^https?:\/\//i.test(value)) pathname = new URL(value).pathname;
    const segments = pathname.split("/").filter(Boolean);
    try { return decodeURIComponent(segments.at(-1) || ""); } catch { return segments.at(-1) || ""; }
}

function normalizeWebdavPath(value: string) {
    return value.trim().replace(/^\/+|\/+$/g, "");
}

function decodeXml(value: string) {
    return value.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" })[entity] || entity);
}

