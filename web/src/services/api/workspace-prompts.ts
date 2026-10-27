import { getActiveWorkspace, workspaceHeaders } from "@/lib/workspace";

export type WorkspacePrompt = {
    id: string;
    workspaceId: string;
    workspaceName: string;
    title: string;
    prompt: string;
    description: string;
    tags: string[];
    shared: boolean;
    coverUrl: string;
    createdAt: string;
    updatedAt: string;
};

export type WorkspacePromptInput = Pick<WorkspacePrompt, "title" | "prompt" | "description" | "tags" | "shared"> & { coverDataUrl?: string | null };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    if (!getActiveWorkspace()) throw new Error("请先选择工作区");
    const response = await fetch(`/api/prompts${path}`, {
        ...init,
        cache: "no-store",
        headers: { ...workspaceHeaders(), ...(init?.body ? { "Content-Type": "application/json" } : {}) },
    });
    const result = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(result.error || `提示词请求失败（${response.status}）`);
    return result;
}

export async function listWorkspacePrompts() {
    return (await request<{ items: WorkspacePrompt[] }>("")).items;
}

export async function saveWorkspacePrompt(input: WorkspacePromptInput, id?: string) {
    const result = await request<{ item: WorkspacePrompt }>(id ? `/${encodeURIComponent(id)}` : "", {
        method: id ? "PUT" : "POST",
        body: JSON.stringify(input),
    });
    return result.item;
}

export async function deleteWorkspacePrompt(id: string) {
    await request<{ ok: boolean }>(`/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export type PromptLibraryPackage = { format: "infinite-canvas-prompts"; version: 1; prompts: Array<{ title: string; prompt: string; description?: string; tags?: string[]; coverDataUrl?: string }> };

export async function exportWorkspacePrompts() {
    return request<PromptLibraryPackage>("/export");
}

export async function importWorkspacePrompts(value: unknown) {
    return request<{ imported: number }>("/import", { method: "POST", body: JSON.stringify(value) });
}
