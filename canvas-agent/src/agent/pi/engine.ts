import crypto from "node:crypto";

import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";

import type { CanvasSession } from "../../canvas/session.js";
import { AGENT_PROMPT } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { errorMessage } from "../../utils/value.js";
import type { AgentAttachment, AgentEmit } from "../types.js";
import { readPiChannels, resolvePiModel, streamFor } from "./model.js";
import { createReadSkillTool, loadPiSkills, resolveExplicitSkill, skillsFingerprint, skillsPromptBlock, type PiSkillSummary } from "./skills.js";
import { PiThreadStore, type PiDisplayMessage, type PiStoredTurn } from "./store.js";
import { buildPiTools } from "./tools.js";

export type PiRunOptions = {
    threadId?: string;
    cwd: string;
    session: CanvasSession;
    model?: string;
    effort?: string;
    messageText?: string;
    skill?: { name?: unknown; path?: unknown };
    onStart?: () => void;
    onThread?: (threadId: string) => void;
    onTurn?: (turnId: string) => void;
    onFinish?: () => void;
};

type PiRuntime = { agent: Agent; threadId: string; skillsFingerprint: string };

const runtimes = new Map<string, PiRuntime>();
let piQueue: Promise<unknown> = Promise.resolve();

/** 串行执行一次 pi turn，事件形状与 Codex 引擎保持一致。 */
export async function runPiTurn(prompt: string, emit: AgentEmit, attachments: AgentAttachment[], options: PiRunOptions) {
    if (!prompt.trim()) return;
    piQueue = piQueue.catch(() => undefined).then(() => runPiTurnNow(prompt, emit, attachments, options));
    await piQueue;
}

/** 中断指定工作区正在运行的 pi turn。 */
export function interruptPiTurn(cwd?: string) {
    const prefix = cwd ? `${normalizeCwd(cwd)}\0` : "";
    const active = [...runtimes.entries()].find(([key, runtime]) => key.startsWith(prefix) && runtime.agent.state.isStreaming);
    if (!active) return false;
    active[1].agent.abort();
    return true;
}

/** 删除会话时释放运行时，避免下次续聊复用已归档的上下文。 */
export function releasePiRuntime(cwd: string, threadId: string) {
    runtimes.delete(runtimeKey(cwd, threadId));
}

async function runPiTurnNow(prompt: string, emit: AgentEmit, attachments: AgentAttachment[], options: PiRunOptions) {
    const turnId = crypto.randomUUID();
    const display: PiDisplayMessage[] = [{ itemId: "synthetic:user", turnId, role: "user", text: options.messageText || prompt }];
    const turn: PiStoredTurn = { turnId, userText: options.messageText || prompt, startedAt: Date.now(), status: "running", messages: display };
    const store = new PiThreadStore(options.cwd);
    let runtime: PiRuntime | undefined;
    try {
        options.onStart?.();
        runtime = await ensureRuntime(emit, options, store);
        options.onThread?.(runtime.threadId);
        options.onTurn?.(turnId);
        // 和 Codex 引擎一致：生命周期事件统一包在 agent_event 里，前端只订阅这一个通道。
        emit("agent_event", { agent: "pi", type: "turn.started", thread_id: runtime.threadId, turn_id: turnId });

        const owner = runtime;
        const seq = { assistant: 0 };
        const skills = await loadPiSkills(options.cwd).then((result) => result.skills);
        // 用户点名的 Skill 无条件加载，等价于 Codex 的 {type:"skill"} 输入。
        const explicit = options.skill ? await resolveExplicitSkill(options.cwd, options.skill) : "";
        const unsubscribe = owner.agent.subscribe((event) => handleAgentEvent(event, { emit, threadId: owner.threadId, turnId, display, seq }));
        try {
            owner.agent.state.tools = [...buildPiTools(options.session), createReadSkillTool(skills)];
            await owner.agent.prompt(promptMessage(explicit ? `${explicit}\n\n---\n\n${prompt}` : prompt, attachments));
            await owner.agent.waitForIdle();
        } finally {
            unsubscribe();
        }
        turn.status = "completed";
        emit("agent_event", { agent: "pi", type: "turn.completed", thread_id: owner.threadId, turn_id: turnId, status: "completed", usage: null });
    } catch (error) {
        const message = errorMessage(error);
        turn.status = interrupted(error) ? "interrupted" : "failed";
        if (turn.status === "failed") {
            logger.error("Pi turn failed", error);
            display.push({ itemId: "synthetic:error", turnId, role: "error", title: "任务失败", text: message });
            emit("agent_event", { agent: "pi", type: "error", message, thread_id: runtime?.threadId, turn_id: turnId });
        }
        emit("agent_event", { agent: "pi", type: "turn.completed", thread_id: runtime?.threadId, turn_id: turnId, status: turn.status, ...(turn.status === "failed" ? { error: { message } } : {}), usage: null });
    } finally {
        turn.finishedAt = Date.now();
        if (runtime) await store.saveTurn(runtime.threadId, turn, runtime.agent.state.messages).catch((error) => logger.warn("Failed to save pi turn", { error: errorMessage(error) }));
        options.onFinish?.();
    }
}

/**
 * 将 pi 事件翻译成网页已经消费的 agent_event 形状。
 *
 * 一轮里可能出现多条 assistant 消息（工具调用前后各一条），因此 assistant/reasoning 的 itemId
 * 必须带上自增序号，否则后一条会覆盖前一条已经在界面上渲染的内容。
 */
function handleAgentEvent(event: AgentEvent, context: { emit: AgentEmit; threadId: string; turnId: string; display: PiDisplayMessage[]; seq: { assistant: number } }) {
    const { emit, threadId, turnId, display, seq } = context;
    const scope = { thread_id: threadId, turn_id: turnId };
    const send = (type: string, item: Record<string, unknown>) => emit("agent_event", { agent: "pi", type, item, ...scope });

    if (event.type === "message_start" && event.message.role === "assistant") {
        seq.assistant += 1;
        send("item.started", { id: assistantItemId(turnId, seq.assistant), type: "agent_message" });
        return;
    }
    if (event.type === "message_update") {
        const update = event.assistantMessageEvent;
        const index = Math.max(1, seq.assistant);
        if (update.type === "text_delta" && update.delta) send("item.updated", { id: assistantItemId(turnId, index), type: "agent_message", delta: update.delta });
        if (update.type === "thinking_delta" && update.delta) send("item.updated", { id: reasoningItemId(turnId, index), type: "reasoning", delta: update.delta });
        return;
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
        const message = event.message as AssistantMessage;
        const index = Math.max(1, seq.assistant);
        const text = textOf(message);
        if (text.trim()) {
            send("item.completed", { id: assistantItemId(turnId, index), type: "agent_message", text });
            display.push({ itemId: assistantItemId(turnId, index), turnId, role: "assistant", title: "Pi", text });
        }
        const thinking = thinkingOf(message);
        if (thinking.trim()) send("item.completed", { id: reasoningItemId(turnId, index), type: "reasoning", summary: [{ text: thinking }] });
        emit("agent_event", { agent: "pi", type: "usage.updated", usage: usageOf(message), ...scope });
        return;
    }
    if (event.type === "tool_execution_start") {
        send("item.started", { id: event.toolCallId, type: "mcp_tool_call", tool: event.toolName, arguments: event.args, status: "inProgress" });
        return;
    }
    if (event.type === "tool_execution_end") {
        const result = toolResultText(event.result);
        send("item.completed", { id: event.toolCallId, type: "mcp_tool_call", tool: event.toolName, status: event.isError ? "failed" : "completed", result, ...(event.isError ? { error: { message: result } } : {}) });
        display.push({ itemId: event.toolCallId, turnId, role: "tool", title: event.toolName, text: event.isError ? result : "已完成", detail: { kind: "tool", status: event.isError ? "failed" : "completed", ...(event.isError ? { output: result } : {}) } });
    }
}

/** 获取或创建指定线程的 pi 运行时；已有历史时把 transcript 追加到种子化 system message 之后。 */
async function ensureRuntime(emit: AgentEmit, options: PiRunOptions, store: PiThreadStore): Promise<PiRuntime> {
    const threadId = options.threadId || crypto.randomUUID();
    const key = runtimeKey(options.cwd, threadId);
    const channels = await readPiChannels();
    const resolved = resolvePiModel(channels, options.model || "");
    const skills = await loadPiSkills(options.cwd).then((result) => result.skills);
    const fingerprint = skillsFingerprint(skills);
    let existing = runtimes.get(key);
    // Skill 启停或增删后系统提示词已过期，重建运行时（历史 transcript 会在下面从磁盘恢复）。
    if (existing && existing.skillsFingerprint !== fingerprint) {
        runtimes.delete(key);
        emit("agent_log", { text: "Skill 列表已变化，已重建 Pi 会话上下文" });
        existing = undefined;
    }
    if (existing) {
        existing.agent.state.model = resolved.model as Model<any>;
        existing.agent.streamFunction = (model, context, streamOptions) => streamFor(model, context, { ...streamOptions, apiKey: resolved.apiKey });
        existing.agent.state.thinkingLevel = thinkingLevel(options.effort);
        return existing;
    }
    const stored = options.threadId ? await store.read(threadId) : await store.create(threadId);
    const agent = new Agent({
        initialState: { systemPrompt: `${AGENT_PROMPT}${skillsPromptBlock(skills)}`, model: resolved.model, tools: [], thinkingLevel: thinkingLevel(options.effort) },
        streamFn: (model, context, streamOptions) => streamFor(model, context, { ...streamOptions, apiKey: resolved.apiKey }),
        toolExecution: "sequential",
        identity: { attribution: null },
    });
    // 追加而不是赋值，保留构造函数种子化在队首的 system message。
    if (stored?.transcript.length) agent.state.messages.push(...stored.transcript.filter((message: AgentMessage) => message.role !== "system"));
    logger.debug("Pi runtime ready", { threadId, cwd: options.cwd, restored: Boolean(stored?.transcript.length), skills: skills.length });
    const runtime: PiRuntime = { agent, threadId, skillsFingerprint: fingerprint };
    runtimes.set(key, runtime);
    return runtime;
}

function promptMessage(prompt: string, attachments: AgentAttachment[]): AgentMessage {
    const images = imagesOf(attachments);
    return { role: "user", content: images.length ? [{ type: "text", text: prompt }, ...images] : prompt, timestamp: Date.now() } as AgentMessage;
}

function thinkingLevel(effort?: string) {
    return effort === "low" || effort === "high" ? effort : "medium";
}

function assistantItemId(turnId: string, index: number) {
    return `${turnId}:assistant:${index}`;
}

function reasoningItemId(turnId: string, index: number) {
    return `${turnId}:reasoning:${index}`;
}

function textOf(message: AssistantMessage) {
    return message.content.filter((item) => item.type === "text").map((item) => item.text).join("");
}

function thinkingOf(message: AssistantMessage) {
    return message.content.filter((item) => item.type === "thinking").map((item) => item.thinking).join("\n");
}

function usageOf(message: AssistantMessage) {
    return {
        input_tokens: message.usage?.input || 0,
        cached_input_tokens: message.usage?.cacheRead || 0,
        output_tokens: message.usage?.output || 0,
        reasoning_output_tokens: message.usage?.reasoning || 0,
    };
}

function toolResultText(result: unknown) {
    const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
    return Array.isArray(content) ? content.map((item) => item.text || "").join("\n") : errorMessage(result);
}

function imagesOf(attachments: AgentAttachment[]) {
    return attachments.flatMap((item) => {
        const match = item.dataUrl?.match(/^data:([^;]+);base64,(.+)$/);
        return match ? [{ type: "image" as const, data: match[2], mimeType: match[1] }] : [];
    });
}

function interrupted(error: unknown) {
    const text = errorMessage(error).toLowerCase();
    return text.includes("abort") || text.includes("cancel");
}

function runtimeKey(cwd: string, threadId: string) {
    return `${normalizeCwd(cwd)}\0${threadId}`;
}

function normalizeCwd(cwd: string) {
    return process.platform === "win32" ? cwd.toLowerCase() : cwd;
}
