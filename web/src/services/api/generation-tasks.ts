import localforage from "localforage";
import { getActiveWorkspace } from "@/lib/workspace";
import type { CreateGenerationTask, GenerationTask, GenerationTaskCanvasTarget, GenerationTaskFilter, GenerationTaskKind } from "@/types/generation-task";

const pendingSubmissions = localforage.createInstance({ name: "infinite-canvas", storeName: "generation_task_intents" });
const pendingKey = (workspaceId: string, kind: GenerationTaskKind) => `${workspaceId}:${kind}`;

async function clearPendingRequest(key: string, requestId: string): Promise<void> {
    try {
        if ((await pendingSubmissions.getItem<CreateGenerationTask>(key))?.requestId === requestId) await pendingSubmissions.removeItem(key);
    } catch { /* Reconciliation can retry if local storage is unavailable. */ }
}

async function taskRequest<T>(workspaceId: string, path: string, init?: RequestInit): Promise<T> {
    if (getActiveWorkspace()?.id !== workspaceId) throw new Error("工作区已切换，请重新读取任务");
    const response = await fetch(`/api/generation-tasks${path}`, {
        ...init,
        cache: "no-store",
        headers: { "x-infinite-canvas-workspace": workspaceId, ...(init?.body ? { "content-type": "application/json" } : {}) },
    });
    const result = await response.json().catch(() => ({})) as T & { error?: string };
    if (!response.ok) {
        const error = new Error(result.error || `生成任务请求失败（${response.status}）`) as Error & { status: number };
        error.status = response.status;
        throw error;
    }
    return result;
}

export async function submitGenerationTask(workspaceId: string, input: CreateGenerationTask): Promise<GenerationTask> {
    const task = (await taskRequest<{ task: GenerationTask }>(workspaceId, "", { method: "POST", body: JSON.stringify(input) })).task;
    if (!task?.id || task.workspaceId !== workspaceId || task.requestId !== input.requestId) throw new Error("生成任务回执无效，请按请求 ID 核对后再试");
    if (task.canvasTarget?.projectId !== input.canvasTarget?.projectId || task.canvasTarget?.nodeId !== input.canvasTarget?.nodeId) throw new Error("生成任务目标回执不一致，请核对原请求");
    return task;
}

export async function submitWorkbenchGenerationTask(workspaceId: string, input: CreateGenerationTask): Promise<GenerationTask> {
    const key = pendingKey(workspaceId, input.kind);
    const pending = await pendingSubmissions.getItem<CreateGenerationTask>(key);
    if (pending && JSON.stringify({ ...pending, requestId: "" }) !== JSON.stringify({ ...input, requestId: "" })) {
        throw new Error("上次提交未确认，请先核对原任务；参数已变化，未再次提交");
    }
    const request = pending || input;
    if (!pending) await pendingSubmissions.setItem(key, request);
    try {
        const task = await submitGenerationTask(workspaceId, request);
        await clearPendingRequest(key, request.requestId);
        return task;
    } catch (error) {
        const status = (error as { status?: number }).status;
        if (!pending && status === 400) await clearPendingRequest(key, request.requestId);
        throw error;
    }
}

export async function listGenerationTasks(workspaceId: string, kind: GenerationTaskKind, filter: GenerationTaskFilter = { source: "workbench" }): Promise<GenerationTask[]> {
    const query = new URLSearchParams({ kind, source: filter.source || "workbench" });
    for (const field of ["projectId", "nodeId", "requestId"] as const) if (filter[field]) query.set(field, filter[field]);
    const items = (await taskRequest<{ items: GenerationTask[] }>(workspaceId, `?${query}`)).items;
    const key = pendingKey(workspaceId, kind);
    const pending = await pendingSubmissions.getItem<CreateGenerationTask>(key).catch(() => null);
    if (pending && items.some((task) => task.requestId === pending.requestId)) await clearPendingRequest(key, pending.requestId);
    return items;
}

export async function listCanvasGenerationTasks(workspaceId: string, projectId: string): Promise<GenerationTask[]> {
    return (await taskRequest<{ items: GenerationTask[] }>(workspaceId, `?${new URLSearchParams({ source: "canvas", projectId })}`)).items;
}

export async function getGenerationTaskByRequestId(workspaceId: string, requestId: string, canvasTarget?: GenerationTaskCanvasTarget): Promise<GenerationTask | null> {
    const query = new URLSearchParams({ requestId, ...(canvasTarget ? { source: "canvas", ...canvasTarget } : {}) });
    const items = (await taskRequest<{ items: GenerationTask[] }>(workspaceId, `?${query}`)).items;
    const task = items.find((entry) => entry.workspaceId === workspaceId && entry.requestId === requestId) || null;
    if (task && canvasTarget && (task.canvasTarget?.projectId !== canvasTarget.projectId || task.canvasTarget?.nodeId !== canvasTarget.nodeId)) throw new Error("生成任务目标不一致，请核对原请求");
    return task;
}

export async function getGenerationTask(workspaceId: string, id: string): Promise<GenerationTask> {
    return (await taskRequest<{ task: GenerationTask }>(workspaceId, `/${encodeURIComponent(id)}`)).task;
}

export async function resumeGenerationTask(workspaceId: string, id: string): Promise<GenerationTask> {
    return (await taskRequest<{ task: GenerationTask }>(workspaceId, `/${encodeURIComponent(id)}/resume`, { method: "POST" })).task;
}

export async function hideGenerationTask(workspaceId: string, id: string): Promise<void> {
    await taskRequest(workspaceId, `/${encodeURIComponent(id)}`, { method: "DELETE" });
}
