import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { logger } from "../../utils/logger.js";

/** 网页聊天记录里的一条消息；itemId/threadId/turnId 与实时事件使用同一套标识。 */
export type PiDisplayMessage = { itemId: string; turnId: string; role: "user" | "assistant" | "tool" | "error"; title?: string; text: string; detail?: unknown };
export type PiStoredTurn = { turnId: string; userText: string; startedAt: number; finishedAt?: number; status: "running" | "completed" | "failed" | "interrupted"; error?: string; messages: PiDisplayMessage[] };
type PiThreadFile = { version: 1; id: string; createdAt: number; updatedAt: number; turns: PiStoredTurn[]; transcript: AgentMessage[] };
export type PiThreadSummary = { id: string; preview: string; name: string | null; cwd: string; status: string; createdAt: number; updatedAt: number };
export type PiThreadDetail = { thread: PiThreadSummary; messages: ReturnType<typeof threadMessages>; settledTurnIds: string[] };

const STORAGE_VERSION = 1;
const DIRECTORY = ".infinite-canvas";
const THREADS = "pi-threads";
const MAX_PREVIEW_LENGTH = 120;

/** 按工作区保存 pi 会话：显示消息直接落盘，保证刷新后与实时事件使用相同 itemId。 */
export class PiThreadStore {
    private queue: Promise<unknown> = Promise.resolve();

    constructor(private cwd: string) {}

    root() {
        return path.join(this.cwd, DIRECTORY, THREADS);
    }

    private file(threadId: string) {
        return path.join(this.root(), `${threadId}.json`);
    }

    /** 列出当前工作区的全部 pi 会话，按更新时间倒序。 */
    async list(): Promise<PiThreadSummary[]> {
        const entries = await fs.readdir(this.root()).catch(() => [] as string[]);
        const threads = await Promise.all(entries.filter((entry) => entry.endsWith(".json")).map((entry) => this.read(entry.slice(0, -5))));
        return threads
            .filter((thread): thread is PiThreadFile => Boolean(thread))
            .map((thread) => ({
                id: thread.id,
                preview: previewOf(thread),
                name: null,
                cwd: this.cwd,
                status: thread.turns.at(-1)?.status === "running" ? "interrupted" : "idle",
                createdAt: thread.createdAt,
                updatedAt: thread.updatedAt,
            }))
            .sort((left, right) => right.updatedAt - left.updatedAt);
    }

    /** 读取单个会话；不存在或格式未知时返回 null，调用方据此拒绝恢复。 */
    async read(threadId: string): Promise<PiThreadFile | null> {
        if (!safeThreadId(threadId)) return null;
        try {
            const value = JSON.parse(await fs.readFile(this.file(threadId), "utf8")) as Partial<PiThreadFile>;
            if (value.version !== STORAGE_VERSION || !Array.isArray(value.turns) || !Array.isArray(value.transcript)) {
                logger.warn("Pi thread file has unknown format", { threadId, version: value.version });
                return null;
            }
            return {
                version: STORAGE_VERSION,
                id: String(value.id || threadId),
                createdAt: Number(value.createdAt) || Date.now(),
                updatedAt: Number(value.updatedAt) || Date.now(),
                turns: value.turns,
                transcript: value.transcript,
            };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") logger.warn("Failed to read pi thread", { threadId, error: String(error) });
            return null;
        }
    }

    /** 创建空会话文件。 */
    create(threadId: string = crypto.randomUUID()) {
        return this.mutate(async () => {
            const now = Date.now();
            const thread: PiThreadFile = { version: STORAGE_VERSION, id: threadId, createdAt: now, updatedAt: now, turns: [], transcript: [] };
            await this.write(thread);
            return thread;
        });
    }

    /** 追加一轮对话的最终状态，并把权威 transcript 一并写回。 */
    saveTurn(threadId: string, turn: PiStoredTurn, transcript: AgentMessage[]) {
        return this.mutate(async () => {
            const now = Date.now();
            const thread = await this.read(threadId) || { version: STORAGE_VERSION, id: threadId, createdAt: now, updatedAt: now, turns: [], transcript: [] } as PiThreadFile;
            const turns = [...thread.turns.filter((item) => item.turnId !== turn.turnId), turn];
            await this.write({ ...thread, turns, transcript, updatedAt: now });
        });
    }

    /** 删除会话文件。 */
    remove(threadId: string) {
        return this.mutate(async () => {
            if (!safeThreadId(threadId)) return;
            await fs.rm(this.file(threadId), { force: true });
        });
    }

    private write(thread: PiThreadFile) {
        return (async () => {
            await fs.mkdir(this.root(), { recursive: true });
            const target = this.file(thread.id);
            const temporary = `${target}.${process.pid}.tmp`;
            await fs.writeFile(temporary, JSON.stringify(thread), { mode: 0o600 });
            await fs.rename(temporary, target);
        })();
    }

    private mutate<T>(task: () => Promise<T>) {
        const result = this.queue.then(task, task);
        this.queue = result.then(() => undefined, () => undefined);
        return result;
    }
}

/** 拼接面板要求的历史消息结构，自动补上稳定 id。 */
export function threadMessages(threadId: string, turns: PiStoredTurn[]) {
    return turns
        .filter((turn) => turn.status !== "running")
        .flatMap((turn) => turn.messages.map((message) => ({
            id: `${threadId}:${turn.turnId}:${message.itemId}`,
            itemId: message.itemId,
            threadId,
            turnId: turn.turnId,
            role: message.role,
            ...(message.title ? { title: message.title } : {}),
            text: message.text,
            ...(message.detail === undefined ? {} : { detail: message.detail }),
        })));
}

/** 返回已经结束、可由持久化历史作为权威内容的 turn。 */
export function settledTurnIds(turns: PiStoredTurn[]) {
    return turns.filter((turn) => turn.status !== "running").map((turn) => turn.turnId);
}

/** 读取单个会话并转换成网页历史接口的返回结构。 */
export async function readPiThread(cwd: string, threadId: string): Promise<PiThreadDetail | null> {
    const store = new PiThreadStore(cwd);
    const file = await store.read(threadId);
    if (!file) return null;
    return {
        thread: { id: file.id, preview: previewOf(file), name: null, cwd, status: file.turns.at(-1)?.status === "running" ? "interrupted" : "idle", createdAt: file.createdAt, updatedAt: file.updatedAt },
        messages: threadMessages(file.id, file.turns),
        settledTurnIds: settledTurnIds(file.turns),
    };
}

function previewOf(thread: PiThreadFile) {
    const text = [...thread.turns].reverse().flatMap((turn) => [...turn.messages].reverse()).find((message) => message.role === "user" || message.role === "assistant")?.text.trim() || "";
    return text.length > MAX_PREVIEW_LENGTH ? `${text.slice(0, MAX_PREVIEW_LENGTH)}…` : text;
}

function safeThreadId(value: string) {
    return /^[0-9a-f-]{36}$/i.test(value);
}
