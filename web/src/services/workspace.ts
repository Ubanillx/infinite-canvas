import type { WorkspaceAccess } from "@/lib/workspace";

export async function createWorkspace(name: string) {
    const data = await request<{ workspace: WorkspaceAccess }>("/api/workspaces", { method: "POST", body: JSON.stringify({ name }) });
    return data.workspace;
}

export async function listWorkspaces() {
    const data = await request<{ workspaces: WorkspaceAccess[] }>("/api/workspaces", { method: "GET" });
    return data.workspaces;
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(path, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
    const data = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) throw new Error(data.error || "请求失败");
    return data;
}
