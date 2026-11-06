import type { WorkspaceRole } from "@/lib/workspace";

export type AdminUser = {
    id: string;
    username: string;
    displayName: string;
    email: string | null;
    isAdmin: boolean;
    envAdmin: boolean;
    workspaceCount: number;
    createdAt: string;
};

export type AdminWorkspace = {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    owner: { username: string; displayName: string } | null;
    role: WorkspaceRole;
    memberCount: number;
    canvasCount: number;
    folderCount: number;
    recentCanvasTitle: string | null;
    dataBytes: number;
    mediaBytes: number;
};

export type AdminOverview = {
    users: AdminUser[];
    workspaces: AdminWorkspace[];
    totals: { users: number; admins: number; workspaces: number; canvases: number; dataBytes: number; mediaBytes: number };
};

export function getAdminOverview() {
    return request<AdminOverview>("/api/admin/overview", { method: "GET" });
}

export function getAdminWorkspaceAccess(id: string) {
    return request<{ workspace: { id: string; name: string; role: WorkspaceRole; createdAt: string } }>(`/api/admin/workspaces/${encodeURIComponent(id)}`, { method: "GET" });
}

export function setUserAdmin(id: string, isAdmin: boolean) {
    return request<{ user: Pick<AdminUser, "id" | "username" | "displayName" | "isAdmin" | "createdAt"> }>(`/api/admin/users/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ isAdmin }),
    });
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(path, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
    const data = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) throw new Error(data.error || "管理请求失败");
    return data;
}
