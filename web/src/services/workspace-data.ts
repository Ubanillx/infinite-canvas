import { getActiveWorkspace } from "@/lib/workspace";

export type WorkspaceDomain = "canvas" | "canvas-templates" | "assets" | "image-workbench" | "video-workbench" | "agent-sessions";
type StoredDomain<T> = { payload: T | null; revision: number; updatedAt: string | null; updatedBy: string | null };
type ConflictDetail = { domain: WorkspaceDomain; payload: unknown; revision: number };

const revisions = new Map<string, number>();
const writes = new Map<string, Promise<void>>();
const failedWrites = new Map<string, { domain: WorkspaceDomain; payload: unknown }>();
const errors = new Map<string, { message: string; mode: "read" | "write" | "conflict" }>();
const listeners = new Set<() => void>();
let errorSnapshot: { key: string; message: string; mode: "read" | "write" | "conflict" } | null = null;

export function getWorkspaceDataError() {
    return errorSnapshot?.key.startsWith(`${getActiveWorkspace()?.id}:`) ? errorSnapshot : null;
}
export function subscribeWorkspaceDataError(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function retryWorkspaceData() {
    if (!errorSnapshot) return;
    const failed = failedWrites.get(errorSnapshot.key);
    if (!failed) return window.location.reload();
    if (errorSnapshot.key !== `${getActiveWorkspace()?.id}:${failed.domain}`) return window.location.reload();
    void saveWorkspaceData(failed.domain, failed.payload).catch(() => undefined);
}
function setWorkspaceError(key: string, message: string, mode: "read" | "write" | "conflict") {
    errors.set(key, { message, mode });
    errorSnapshot = { key, message, mode };
    listeners.forEach((listener) => listener());
}
function clearWorkspaceError(key: string) {
    errors.delete(key);
    failedWrites.delete(key);
    const latest = [...errors].at(-1);
    errorSnapshot = latest ? { key: latest[0], ...latest[1] } : null;
    listeners.forEach((listener) => listener());
}

export async function loadWorkspaceData<T>(domain: WorkspaceDomain, options: { reportError?: boolean } = {}): Promise<T | null> {
    const workspaceId = getActiveWorkspace()?.id;
    return workspaceId ? loadWorkspaceDataFor<T>(domain, workspaceId, options.reportError) : null;
}

async function loadWorkspaceDataFor<T>(domain: WorkspaceDomain, workspaceId: string, reportError = true): Promise<T | null> {
    const key = `${workspaceId}:${domain}`;
    try {
        const response = await fetch(`/api/data/${encodeURIComponent(domain)}`, { headers: { "x-infinite-canvas-workspace": workspaceId } });
        if (!response.ok) throw new Error((await response.json().catch(() => ({})) as { error?: string }).error || "无法读取工作区数据");
        const data = await response.json() as StoredDomain<T>;
        revisions.set(key, data.revision);
        if (!failedWrites.has(key) && errors.get(key)?.mode !== "conflict") clearWorkspaceError(key);
        return data.payload;
    } catch (error) {
        if (reportError) setWorkspaceError(key, error instanceof Error ? error.message : "无法读取工作区数据", "read");
        throw error;
    }
}

export function saveWorkspaceData(domain: WorkspaceDomain, payload: unknown, options: { retryable?: boolean } = {}) {
    const workspaceId = getActiveWorkspace()?.id;
    if (!workspaceId) return Promise.reject(new Error("未选择工作区，数据未保存"));
    const key = `${workspaceId}:${domain}`;
    const previous = writes.get(key) || Promise.resolve();
    const write = previous.catch(() => undefined).then(async () => {
        if (errors.get(key)?.mode === "conflict") {
            const conflict = new Error("工作区数据发生冲突，请刷新后处理") as Error & { code?: string };
            conflict.code = "conflict";
            throw conflict;
        }
        if (!revisions.has(key)) await loadWorkspaceDataFor(domain, workspaceId);
        const response = await fetch(`/api/data/${encodeURIComponent(domain)}`, {
            method: "PUT",
            headers: { "content-type": "application/json", "x-infinite-canvas-workspace": workspaceId },
            body: JSON.stringify({ revision: revisions.get(key) || 0, payload }),
        });
        const data = await response.json().catch(() => ({})) as StoredDomain<unknown> & { error?: string };
        if (response.status === 409) {
            revisions.set(key, data.revision);
            window.dispatchEvent(new CustomEvent<ConflictDetail>("infinite-canvas:workspace-conflict", { detail: { domain, payload: data.payload, revision: data.revision } }));
            const conflict = new Error(data.error || "工作区数据发生冲突") as Error & { code?: string };
            conflict.code = "conflict";
            throw conflict;
        }
        if (!response.ok) throw new Error(data.error || "工作区数据保存失败");
        revisions.set(key, data.revision);
        clearWorkspaceError(key);
    }).catch((error) => {
        const conflict = (error as { code?: string })?.code === "conflict";
        if (conflict) failedWrites.delete(key);
        else if (options.retryable !== false) failedWrites.set(key, { domain, payload });
        // Explicit commands keep their draft and retry UI in the caller; conflicts still need global handling.
        if (conflict || options.retryable !== false) setWorkspaceError(key, error instanceof Error ? error.message : "工作区数据保存失败", conflict ? "conflict" : "write");
        throw error;
    });
    writes.set(key, write.then(() => undefined, () => undefined));
    return write;
}

export function resetWorkspaceDataRevision(domain: WorkspaceDomain) {
    revisions.delete(`${getActiveWorkspace()?.id || "unselected"}:${domain}`);
}
