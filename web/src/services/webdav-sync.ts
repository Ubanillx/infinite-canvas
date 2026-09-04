import i18n from "@/i18n";
import { workspaceHeaders } from "@/lib/workspace";
import type { WebdavSyncConfig } from "@/stores/use-config-store";

export const WEBDAV_MANIFEST_FILE_NAME = "manifest.json";
const WEBDAV_REQUEST_TIMEOUT_MS = 120000;
const directoryChecks = new Map<string, Promise<void>>();
const directoryPartChecks = new Map<string, Promise<void>>();
const webdavText = (key: string, options?: Record<string, unknown>) => i18n.t(`config.webdav.errors.${key}`, options);

export async function testWebdavConnection(config: WebdavSyncConfig) {
    const rootConfig = webdavRootConfig(config);
    await ensureWebdavDirectory(rootConfig);
    const response = await webdavFetch(rootConfig, "", { method: "PROPFIND", headers: { Depth: "0" } });
    if (response.ok || response.status === 207) return;
    await throwWebdavError(response, webdavText("testFailed"));
}

export async function downloadWebdavFile(config: WebdavSyncConfig, path: string) {
    await ensureWebdavDirectory(config);
    const response = await webdavFetch(config, path, { method: "GET" });
    if (response.status === 404) return null;
    if (!response.ok) await throwWebdavError(response, webdavText("downloadFailed"));
    const file = await withTimeout(response.blob(), webdavText("downloadTimeout"));
    return file.size ? file : null;
}

export async function uploadWebdavFile(config: WebdavSyncConfig, path: string, file: Blob, contentType = "application/octet-stream") {
    if (!file.size) throw new Error(webdavText("emptyUpload"));
    await ensureWebdavDirectory(config);
    await ensureWebdavSubdirectory(config, path);
    const response = await webdavFetch(config, path, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: file,
    });
    if (!response.ok) await throwWebdavError(response, webdavText("uploadFailed"));
}

export async function deleteWebdavPath(config: WebdavSyncConfig, path: string) {
    await ensureWebdavDirectory(config);
    const response = await webdavFetch(config, path, { method: "DELETE" });
    if (response.ok || response.status === 404) return;
    await throwWebdavError(response, webdavText("uploadFailed"));
}

export async function listWebdavDirectory(config: WebdavSyncConfig, path: string) {
    await ensureWebdavDirectory(config);
    const response = await webdavFetch(config, path, { method: "PROPFIND", headers: { Depth: "1" } });
    if (response.status === 404) return [];
    if (!response.ok && response.status !== 207) await throwWebdavError(response, webdavText("downloadFailed"));
    const text = await response.text();
    const names = [...text.matchAll(/<[^>]*:?displayname[^>]*>([^<]+)<\/[^>]*:?displayname>/gi)].map((match) => decodeXml(match[1]).trim()).filter(Boolean);
    return [...new Set(names)];
}

async function ensureWebdavDirectory(config: WebdavSyncConfig) {
    assertWebdavConfig(config);
    await ensureWebdavDirectoryPath(config, config.directory);
}

async function ensureWebdavSubdirectory(config: WebdavSyncConfig, path: string) {
    const directory = normalizePath(path).split("/").slice(0, -1).join("/");
    if (!directory) return;
    await ensureWebdavDirectoryPath(config, [config.directory, directory].filter(Boolean).join("/"));
}

async function ensureWebdavDirectoryPath(config: WebdavSyncConfig, directory: string) {
    const parts = normalizePath(directory).split("/").filter(Boolean);
    const cacheKey = `${config.url}:${parts.join("/")}`;
    const pending = directoryChecks.get(cacheKey);
    if (pending) return pending;

    const check = ensureWebdavDirectoryParts(config, parts);
    directoryChecks.set(cacheKey, check);
    try {
        await check;
    } catch (error) {
        directoryChecks.delete(cacheKey);
        throw error;
    }
}

async function ensureWebdavDirectoryParts(config: WebdavSyncConfig, parts: string[]) {
    let path = "";
    for (const part of parts) {
        path = path ? `${path}/${part}` : part;
        await ensureWebdavDirectoryPart(config, path);
    }
}

async function ensureWebdavDirectoryPart(config: WebdavSyncConfig, path: string) {
    const cacheKey = `${config.url}:${normalizePath(path)}`;
    const pending = directoryPartChecks.get(cacheKey);
    if (pending) return pending;

    const check = ensureWebdavDirectoryPartOnce(config, path);
    directoryPartChecks.set(cacheKey, check);
    try {
        await check;
    } finally {
        directoryPartChecks.delete(cacheKey);
    }
}

async function ensureWebdavDirectoryPartOnce(config: WebdavSyncConfig, path: string) {
    const normalizedPath = normalizePath(path);
    const separator = normalizedPath.lastIndexOf("/");
    const parentPath = separator >= 0 ? normalizedPath.slice(0, separator) : "";
    const directoryName = separator >= 0 ? normalizedPath.slice(separator + 1) : normalizedPath;
    const rootConfig = { ...config, directory: "" };

    // Probing the directory that is about to be created with PROPFIND produces
    // an expected 404 on every first upload. List the parent instead so the
    // browser and the WebDAV server do not see a failed request for normal
    // directory creation.
    const children = await listWebdavDirectory(rootConfig, parentPath);
    if (children.includes(directoryName)) return;

    const response = await webdavFetch(rootConfig, normalizedPath, { method: "MKCOL" });
    if (response.ok || ([403, 405, 409, 423].includes(response.status) && (await webdavDirectoryExists(config, path)))) return;
    await throwWebdavError(response, webdavText("directoryFailed"));
}

async function webdavDirectoryExists(config: WebdavSyncConfig, path: string) {
    const response = await webdavFetch({ ...config, directory: "" }, path, { method: "PROPFIND", headers: { Depth: "0" } });
    return response.ok || response.status === 207;
}

async function webdavFetch(config: WebdavSyncConfig, path: string, init: RequestInit) {
    const headers = new Headers(init.headers);
    headers.delete("Authorization");
    if (["MKCOL", "PUT", "DELETE"].includes((init.method || "GET").toUpperCase())) {
        headers.set("X-Infinite-Canvas-Sync-Mode", "manual");
    }
    Object.entries(workspaceHeaders()).forEach(([name, value]) => headers.set(name, value));
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), WEBDAV_REQUEST_TIMEOUT_MS);
    try {
        const url = buildWebdavRequestUrl(config, path);
        return await fetch(url, { ...init, headers, signal: controller.signal });
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw new Error(webdavText("requestTimeout"));
        if (error instanceof TypeError) throw new Error(webdavText("connectionFailed"));
        throw error;
    } finally {
        window.clearTimeout(timer);
    }
}

function decodeXml(value: string) {
    return value.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" })[entity] || entity);
}

function buildWebdavUrl(config: WebdavSyncConfig, path: string) {
    const baseUrl = config.url.trim().replace(/\/+$/, "");
    const remotePath = [normalizePath(config.directory), normalizePath(path)].filter(Boolean).join("/");
    if (!remotePath) return baseUrl;
    return `${baseUrl}/${remotePath.split("/").map(encodeURIComponent).join("/")}`;
}

function buildWebdavRequestUrl(config: WebdavSyncConfig, path: string) {
    const directUrl = buildWebdavUrl(config, path);
    if (config.url.trim() !== "/api/webdav") throw new Error(webdavText("connectionFailed"));
    return directUrl;
}

function normalizePath(path: string) {
    return path.trim().replace(/^\/+|\/+$/g, "");
}

function assertWebdavConfig(config: WebdavSyncConfig) {
    if (!config.url.trim()) throw new Error(webdavText("urlRequired"));
}

function webdavRootConfig(config: WebdavSyncConfig) {
    return config.url.trim() === "/api/webdav" ? { ...config, directory: "" } : config;
}

async function throwWebdavError(response: Response, fallback: string): Promise<never> {
    const detail = await response.text().catch(() => "");
    if (response.status === 401) {
        if (detail.includes("Workspace authentication required")) throw new Error(webdavText("workspaceAuthenticationFailed"));
        throw new Error(webdavText("authenticationFailed"));
    }
    if (response.status === 403) {
        if (detail.includes("Workspace path is not allowed")) throw new Error(webdavText("workspacePathNotAllowed"));
        throw new Error(webdavText("authenticationFailed"));
    }
    if (response.status === 404) throw new Error(webdavText("pathMissing"));
    throw new Error(webdavText("responseFailed", { fallback, status: response.status, detail: detail ? ` ${detail.slice(0, 120)}` : "" }));
}

function withTimeout<T>(promise: Promise<T>, message: string) {
    return new Promise<T>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error(message)), WEBDAV_REQUEST_TIMEOUT_MS);
        promise.then(resolve, reject).finally(() => window.clearTimeout(timer));
    });
}
