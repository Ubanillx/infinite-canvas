import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { logger } from "../utils/logger.js";
import { errorMessage } from "../utils/value.js";

const INDEX_VERSION = 1;
const INDEX_FILE = "index.json";
const MAX_NAME_LENGTH = 120;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** 文件中心的硬边界，失败时由调用方决定返回给网页还是模型。 */
export const FILE_LIMITS = {
    fileBytes: 100 * 1024 * 1024,
    filesPerTurn: 10,
    turnBytes: 300 * 1024 * 1024,
    workspaceBytes: 2 * 1024 * 1024 * 1024,
    artifactBytes: 50 * 1024 * 1024,
    retentionMs: 30 * 24 * 60 * 60 * 1000,
    pendingMs: 24 * 60 * 60 * 1000,
};

export type StoredFile = { fileId: string; name: string; type: string; size: number; sha256: string; threadId: string; origin: "upload" | "artifact"; createdAt: number };
export type FileDescriptor = StoredFile & { path: string };
export type ArtifactFile = FileDescriptor & { kind: "image" | "text" };

/** 文件中心的可预期失败，statusCode 直接用于 HTTP 响应。 */
export class FileCenterError extends Error {
    override name = "FileCenterError";
    constructor(message: string, readonly statusCode: 400 | 404 | 409 | 413 | 507) {
        super(message);
    }
}

type FileIndex = { version: 1; files: StoredFile[] };

/** 每个工作区一个文件中心：上传文件、模型产物都落在 `.<agent>/files/<fileId>/`。 */
export class FileCenter {
    readonly root: string;
    private queue: Promise<unknown> = Promise.resolve();
    private sweptAt = 0;
    private inFlight = new Set<string>();

    constructor(readonly workspacePath: string) {
        this.root = path.join(path.resolve(workspacePath), ".infinite-canvas", "files");
    }

    /** 流式保存一个上传文件；先写字节再入索引，失败时整目录回滚。 */
    async save(stream: NodeJS.ReadableStream, meta: { name: string; type: string; threadId?: string; size?: number }): Promise<FileDescriptor> {
        await this.ensureCapacity(meta.size || 0);
        const fileId = crypto.randomUUID();
        const name = safeFileName(meta.name);
        const directory = path.join(this.root, fileId);
        const target = path.join(directory, name);
        this.inFlight.add(fileId);
        try {
            await fs.mkdir(directory, { recursive: true });
            const hash = crypto.createHash("sha256");
            let size = 0;
            const handle = await fs.open(target, "wx");
            try {
                for await (const chunk of stream) {
                    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
                    size += buffer.length;
                    if (size > FILE_LIMITS.fileBytes) throw new FileCenterError(`单个文件不能超过 ${Math.round(FILE_LIMITS.fileBytes / 1024 / 1024)} MB`, 413);
                    hash.update(buffer);
                    await handle.write(buffer);
                }
            } finally {
                await handle.close();
            }
            if (!size) throw new FileCenterError("文件内容为空", 400);
            // 声明长度可能缺失，落盘后按真实大小再核对一次工作区总量。
            await this.ensureCapacity(size);
            const file: StoredFile = { fileId, name, type: meta.type || "application/octet-stream", size, sha256: hash.digest("hex"), threadId: meta.threadId || "", origin: "upload", createdAt: Date.now() };
            await this.insert(file);
            void this.sweep().catch((error) => logger.warn("Failed to sweep file center", { error: errorMessage(error) }));
            return this.describe(file);
        } catch (error) {
            await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
            throw error;
        } finally {
            this.inFlight.delete(fileId);
        }
    }

    /** 读取索引内的单个文件；只接受 fileId，不接受任意路径。 */
    async read(fileId: string) {
        const file = (await this.loadIndex()).files.find((item) => item.fileId === fileId);
        if (!file) throw new FileCenterError("找不到该文件，可能已被清理", 404);
        const directory = path.join(this.root, file.fileId);
        const target = path.join(directory, file.name);
        // 索引是本地文件，仍然校验落点，避免手工改动索引后读取到目录外。
        if (path.dirname(path.resolve(target)) !== path.resolve(directory)) throw new FileCenterError(`文件记录无效：${file.name}`, 400);
        try {
            const data = await fs.readFile(target);
            return { file, data };
        } catch (error) {
            if (isMissing(error)) throw new FileCenterError("文件内容已丢失，请重新上传", 404);
            throw error;
        }
    }

    /** 按线程列出仍可用的文件。 */
    async list(threadId: string) {
        return (await this.loadIndex()).files.filter((item) => !threadId || item.threadId === threadId);
    }

    /** 把本轮文件绑定到实际线程，并返回可直接写进提示词的描述。 */
    async bind(fileIds: string[], threadId: string): Promise<FileDescriptor[]> {
        const wanted = [...new Set(fileIds.filter(Boolean))];
        if (!wanted.length) return [];
        if (wanted.length > FILE_LIMITS.filesPerTurn) throw new FileCenterError(`单次最多 ${FILE_LIMITS.filesPerTurn} 个文件附件`, 413);
        const index = await this.loadIndex();
        const selected = wanted.map((fileId) => index.files.find((item) => item.fileId === fileId));
        const missing = wanted.filter((_, position) => !selected[position]);
        if (missing.length) throw new FileCenterError("部分文件附件已失效，请重新上传后再发送", 409);
        const files = selected as StoredFile[];
        const total = files.reduce((sum, item) => sum + item.size, 0);
        if (total > FILE_LIMITS.turnBytes) throw new FileCenterError(`单次文件附件不能超过 ${Math.round(FILE_LIMITS.turnBytes / 1024 / 1024)} MB`, 413);
        if (threadId && files.some((item) => item.threadId && item.threadId !== threadId)) throw new FileCenterError("文件附件不能绑定到另一会话", 409);
        const changed = files.filter((item) => item.threadId !== threadId);
        if (changed.length) await this.mutate(async (current) => current.map((item) => (wanted.includes(item.fileId) && threadId ? { ...item, threadId } : item)));
        return files.map((file) => this.describe({ ...file, threadId: threadId || file.threadId }));
    }

    /** 把模型产出的工作区文件复制进文件中心，供浏览器回传画布。 */
    async registerArtifact(sourcePath: string, threadId: string, mode: "auto" | "image" | "text" = "auto"): Promise<ArtifactFile> {
        const root = await fs.realpath(this.workspacePath).catch(() => path.resolve(this.workspacePath));
        const resolved = await fs.realpath(sourcePath).catch(() => "");
        if (!resolved) throw new FileCenterError(`找不到文件：${sourcePath}`, 404);
        if (!isInside(root, resolved)) throw new FileCenterError("只允许导入当前工作区内的文件", 400);
        const stats = await fs.stat(resolved);
        if (!stats.isFile()) throw new FileCenterError("只能导入普通文件", 400);
        if (!stats.size) throw new FileCenterError("文件内容为空", 400);
        if (stats.size > FILE_LIMITS.artifactBytes) throw new FileCenterError(`导入文件不能超过 ${Math.round(FILE_LIMITS.artifactBytes / 1024 / 1024)} MB`, 413);
        const name = safeFileName(path.basename(resolved));
        const type = mimeOf(name);
        const kind = artifactKind(type, name);
        if (!kind) throw new FileCenterError("只支持导入图片或文本类文件", 400);
        if (mode !== "auto" && mode !== kind) throw new FileCenterError(`该文件不是${mode === "image" ? "图片" : "文本"}类文件`, 400);
        const fileId = crypto.randomUUID();
        const directory = path.join(this.root, fileId);
        this.inFlight.add(fileId);
        try {
            await fs.mkdir(directory, { recursive: true });
            const target = path.join(directory, name);
            await fs.copyFile(resolved, target);
            const file: StoredFile = { fileId, name, type, size: stats.size, sha256: await sha256File(target), threadId, origin: "artifact", createdAt: Date.now() };
            await this.insert(file);
            return { ...this.describe(file), kind };
        } catch (error) {
            await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
            throw error;
        } finally {
            this.inFlight.delete(fileId);
        }
    }

    /** 删除一个会话的全部文件，用于删除线程。 */
    async removeThread(threadId: string) {
        if (!threadId) return;
        let removed = 0;
        await this.mutate(async (files) => files.filter((file) => {
            if (file.threadId !== threadId) return true;
            removed += 1;
            void fs.rm(path.join(this.root, file.fileId), { recursive: true, force: true }).catch(() => undefined);
            return false;
        }));
        if (removed) logger.info("Removed thread files", { threadId, removed });
    }

    /** 删除单个尚未发送的文件。 */
    async removeFile(fileId: string) {
        let found = false;
        await this.mutate(async (files) => files.filter((file) => {
            if (file.fileId !== fileId) return true;
            found = true;
            return false;
        }));
        if (!found) return;
        await fs.rm(path.join(this.root, fileId), { recursive: true, force: true }).catch(() => undefined);
    }

    /** 清理过期文件和索引外的孤儿目录，每小时最多执行一次。 */
    async sweep(force = false) {
        const now = Date.now();
        if (!force && now - this.sweptAt < SWEEP_INTERVAL_MS) return;
        this.sweptAt = now;
        const index = await this.loadIndex();
        const expired = index.files.filter((file) => now - file.createdAt > (file.threadId ? FILE_LIMITS.retentionMs : FILE_LIMITS.pendingMs));
        if (expired.length) {
            const ids = new Set(expired.map((file) => file.fileId));
            await this.mutate(async (files) => files.filter((file) => !ids.has(file.fileId)));
            await Promise.all(expired.map((file) => fs.rm(path.join(this.root, file.fileId), { recursive: true, force: true }).catch(() => undefined)));
            logger.info("Swept expired files", { count: expired.length });
        }
        const known = new Set((await this.loadIndex()).files.map((file) => file.fileId));
        const entries = await fs.readdir(this.root, { withFileTypes: true }).catch(() => []);
        await Promise.all(entries.filter((entry) => entry.isDirectory() && !known.has(entry.name) && !this.inFlight.has(entry.name)).map((entry) => fs.rm(path.join(this.root, entry.name), { recursive: true, force: true }).catch(() => undefined)));
    }

    /** 返回文件在工作区内的绝对路径。 */
    private describe(file: StoredFile): FileDescriptor {
        return { ...file, path: path.join(this.root, file.fileId, file.name) };
    }

    /** 校验工作区剩余空间。 */
    private async ensureCapacity(incoming: number) {
        const used = (await this.loadIndex()).files.reduce((sum, file) => sum + file.size, 0);
        if (used + incoming > FILE_LIMITS.workspaceBytes) throw new FileCenterError(`工作区文件总量不能超过 ${Math.round(FILE_LIMITS.workspaceBytes / 1024 / 1024 / 1024)} GB，请先清理旧文件`, 507);
    }

    private insert(file: StoredFile) {
        return this.mutate(async (files) => [...files, file]);
    }

    private mutate(task: (files: StoredFile[]) => Promise<StoredFile[]>) {
        const run = this.queue.then(async () => {
            const index = await this.loadIndex();
            const files = await task(index.files);
            if (files !== index.files) await this.writeIndex({ version: INDEX_VERSION, files });
            return files;
        });
        this.queue = run.then(() => undefined, () => undefined);
        return run;
    }

    private async loadIndex(): Promise<FileIndex> {
        try {
            const raw = JSON.parse(await fs.readFile(path.join(this.root, INDEX_FILE), "utf8")) as Partial<FileIndex>;
            if (raw?.version !== INDEX_VERSION) throw new Error(`Unsupported file center index version: ${String(raw?.version ?? "missing")}. Refusing to overwrite existing data.`);
            return { version: INDEX_VERSION, files: Array.isArray(raw.files) ? raw.files.filter(isStoredFile) : [] };
        } catch (error) {
            if (isMissing(error)) return { version: INDEX_VERSION, files: [] };
            throw error;
        }
    }

    private async writeIndex(index: FileIndex) {
        await fs.mkdir(this.root, { recursive: true });
        const temporary = path.join(this.root, `${INDEX_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`);
        try {
            await fs.writeFile(temporary, JSON.stringify(index));
            await fs.rename(temporary, path.join(this.root, INDEX_FILE));
        } finally {
            await fs.rm(temporary, { force: true }).catch(() => undefined);
        }
    }
}

const centers = new Map<string, FileCenter>();

/** 按工作区复用文件中心实例，并在首次建立时清理一次过期文件。 */
export function fileCenterFor(workspacePath: string) {
    const key = process.platform === "win32" ? path.resolve(workspacePath).toLowerCase() : path.resolve(workspacePath);
    const existing = centers.get(key);
    if (existing) return existing;
    const center = new FileCenter(workspacePath);
    centers.set(key, center);
    void center.sweep(true).catch((error) => logger.warn("Failed to sweep file center on startup", { error: errorMessage(error) }));
    return center;
}

/** 把附件文件名清理成安全的单段文件名，保留中文与扩展名。 */
export function safeFileName(value: string) {
    const base = path.basename(String(value || "").replace(/\\/g, "/")).replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").replace(/^\.+/, "_").trim();
    const name = base || "file";
    if (name.length <= MAX_NAME_LENGTH) return name;
    const extension = path.extname(name).slice(0, 20);
    return `${name.slice(0, MAX_NAME_LENGTH - extension.length)}${extension}`;
}

/** 判断真实路径是否位于工作区内。 */
function isInside(root: string, target: string) {
    const normalize = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
    const relative = path.relative(normalize(root), normalize(target));
    return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

const mimeTypes: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", avif: "image/avif", svg: "image/svg+xml",
    md: "text/markdown", markdown: "text/markdown", txt: "text/plain", csv: "text/csv", tsv: "text/tab-separated-values", json: "application/json",
    jsonl: "application/x-ndjson", yaml: "application/yaml", yml: "application/yaml", xml: "application/xml", html: "text/html", htm: "text/html",
    css: "text/css", js: "text/javascript", mjs: "text/javascript", ts: "text/typescript", tsx: "text/typescript", jsx: "text/javascript",
    py: "text/x-python", sh: "text/x-shellscript", sql: "text/plain", log: "text/plain", ini: "text/plain", toml: "text/plain",
};

/** 根据扩展名推断产物 MIME，未知类型按二进制处理。 */
export function mimeOf(name: string) {
    return mimeTypes[path.extname(name).slice(1).toLowerCase()] || "application/octet-stream";
}

/** 判断产物能否作为图片或文本节点回到画布。 */
export function artifactKind(type: string, name: string): "image" | "text" | null {
    if (type.startsWith("image/")) return "image";
    if (type.startsWith("text/") || /^(?:application\/(?:json|xml|yaml|x-ndjson)|application\/[\w.+-]+\+json)$/.test(type)) return "text";
    const extension = path.extname(name).slice(1).toLowerCase();
    if (["md", "markdown", "txt", "csv", "tsv", "json", "jsonl", "yaml", "yml", "xml", "html", "css", "js", "ts", "tsx", "jsx", "py", "sh", "sql", "log", "ini", "toml"].includes(extension)) return "text";
    return null;
}

function isStoredFile(value: unknown): value is StoredFile {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const file = value as Record<string, unknown>;
    return typeof file.fileId === "string" && Boolean(file.fileId) && typeof file.name === "string" && Boolean(safeNameOnly(file.name))
        && typeof file.type === "string" && typeof file.size === "number" && Number.isFinite(file.size)
        && typeof file.threadId === "string" && (file.origin === "upload" || file.origin === "artifact")
        && typeof file.createdAt === "number";
}

/** 索引里的文件名必须是单段文件名，不能带任何路径分隔。 */
function safeNameOnly(name: string) {
    return path.basename(name) === name && !name.includes("\\") && !name.includes("/") && name !== "." && name !== "..";
}

async function sha256File(file: string) {
    return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

function isMissing(error: unknown) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
