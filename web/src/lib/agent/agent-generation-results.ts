import { requireAgentWorkspace } from "@/lib/agent/agent-tool-context";
import { readAgentGenerationLogs } from "@/services/api/agent-generation-results";
import { getGenerationTask, listGenerationTasks } from "@/services/api/generation-tasks";
import type { GenerationTask, GenerationTaskKind } from "@/types/generation-task";

export const GENERATION_RESULT_TOOL_NAMES = ["generation_list_results", "generation_get_result"] as const;
type ResultToolName = (typeof GENERATION_RESULT_TOOL_NAMES)[number];
type Source = GenerationTaskKind;
type LegacySource = "image" | "video";
type RecordValue = Record<string, unknown>;

export function isGenerationResultTool(name: string): name is ResultToolName {
    return (GENERATION_RESULT_TOOL_NAMES as readonly string[]).includes(name);
}

function record(value: unknown): RecordValue {
    return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

function string(value: unknown) { return typeof value === "string" ? value : ""; }
function number(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }

function outputs(log: RecordValue, source: LegacySource) {
    const values = source === "image" ? Array.isArray(log.images) ? log.images : [] : log.video ? [log.video] : [];
    return values.map((value) => {
        const item = record(value);
        const storageKey = string(item.storageKey);
        const persisted = new RegExp(`^${source}:[A-Za-z0-9_-]+$`).test(storageKey);
        return {
            id: string(item.id), kind: source, available: persisted,
            ...(persisted ? { storageKey } : {}), mimeType: string(item.mimeType), bytes: number(item.bytes),
            width: number(item.width), height: number(item.height), durationMs: number(item.durationMs),
        };
    });
}

function result(value: unknown, source: LegacySource, detail = false) {
    const log = record(value);
    if (!string(log.id)) throw new Error("生成历史记录缺少 ID");
    const media = outputs(log, source);
    return {
        id: string(log.id), source, title: string(log.title), createdAt: number(log.createdAt),
        status: ["pending", "success", "failed"].includes(string(log.status)) ? string(log.status) : "unknown",
        model: string(log.model), outputCount: media.length, storedOutputCount: media.filter((item) => item.available).length,
        ...(detail ? { prompt: string(log.prompt), outputs: media } : {}),
    };
}

function taskResult(task: GenerationTask, detail = false) {
    const textOutputs = (task.textOutputs || []).map(({ id, slotIndex, content, status }) => ({ id, slotIndex, content, status }));
    const count = task.kind === "text" ? textOutputs.length : task.outputs.length;
    return { id: task.id, requestId: task.requestId, source: task.kind, ...(task.canvasTarget ? { canvasTarget: { projectId: task.canvasTarget.projectId, nodeId: task.canvasTarget.nodeId } } : {}), title: task.prompt, createdAt: Date.parse(task.createdAt), status: task.status, model: task.model,
        outputCount: count, storedOutputCount: count,
        ...(detail ? { prompt: task.prompt, outputs: task.outputs.map((output) => ({ ...output, kind: task.kind, available: true })), ...(task.kind === "text" ? { textOutputs } : {}), errorCode: task.errorCode } : {}), durableTask: true };
}

export async function runGenerationResultTool(name: ResultToolName, input: RecordValue) {
    const workspaceId = requireAgentWorkspace(input).id;
    const scope = input.source ?? "all";
    if (scope !== "image" && scope !== "video" && scope !== "text" && scope !== "audio" && (scope !== "all" || name === "generation_get_result")) throw new Error("请指定 image、video、text 或 audio 结果来源");
    const sources: Source[] = scope === "all" ? ["image", "video", "text", "audio"] : [scope];
    if (name === "generation_get_result") {
        if (typeof input.id !== "string" || !input.id.trim()) throw new Error("请提供生成历史 ID");
        const source = sources[0];
        let task: GenerationTask | undefined;
        try { task = await getGenerationTask(workspaceId, input.id); }
        catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
        if (task && task.kind !== source) throw new Error("生成任务与结果来源不符");
        if (task) return { workspaceId, result: taskResult(task, true), persistedHistoryOnly: false };
        if (source === "text" || source === "audio") throw new Error("当前工作区生成结果不存在");
        const values = await readAgentGenerationLogs(workspaceId, source);
        const found = values.find((item) => record(item).id === input.id);
        if (!found) throw new Error("当前工作区生成结果不存在");
        return { workspaceId, result: result(found, source, true), persistedHistoryOnly: true };
    }
    const origin = input.origin === "canvas" || input.origin === "workbench" ? input.origin : "all";
    const filter = { source: origin, projectId: string(input.projectId), nodeId: string(input.nodeId), requestId: string(input.requestId) } as const;
    const includeLegacy = origin !== "canvas" && !filter.projectId && !filter.nodeId && !filter.requestId;
    const values = await Promise.all(sources.map(async (source) => [...(await listGenerationTasks(workspaceId, source, filter)).map((task) => taskResult(task)), ...(includeLegacy && (source === "image" || source === "video") ? (await readAgentGenerationLogs(workspaceId, source)).map((value) => result(value, source)) : [])]));
    const keyword = string(input.keyword).trim().toLowerCase();
    const items = values.flat().filter((item) => !keyword || `${item.title} ${item.model}`.toLowerCase().includes(keyword)).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const pageSize = Math.max(1, Math.min(100, Math.floor(Number(input.pageSize)) || 20));
    const page = Math.max(1, Math.floor(Number(input.page)) || 1);
    return { workspaceId, total: items.length, page, pageSize, items: items.slice((page - 1) * pageSize, page * pageSize), persistedHistoryOnly: false };
}
