import type { WorkspaceAccess } from "@/lib/workspace";
import { workspaceHeaders } from "@/lib/workspace";

export async function createWorkspace(name: string) {
    const data = await request<{ workspace: WorkspaceAccess; accessKey: string }>("/api/workspaces", { method: "POST", body: JSON.stringify({ name }) });
    return { ...data.workspace, accessKey: data.accessKey };
}

export async function listWorkspaces() {
    const data = await request<{ workspaces: WorkspaceAccess[] }>("/api/workspaces", { method: "GET" });
    return data.workspaces;
}

export async function unlockWorkspace(id: string, accessKey: string) {
    const data = await request<{ workspace: WorkspaceAccess }>("/api/workspaces/unlock", { method: "POST", body: JSON.stringify({ id, accessKey }) });
    return { ...data.workspace, accessKey };
}

export async function verifyWorkspace() {
    const data = await request<{ workspace: WorkspaceAccess }>("/api/workspaces/current", { method: "GET", headers: workspaceHeaders() });
    return data.workspace;
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(path, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
    const data = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) throw new Error(data.error || "请求失败");
    return data;
}
