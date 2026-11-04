export type WorkspaceSession = {
    user: { id: string; username: string; displayName: string; isAdmin: boolean; createdAt: string } | null;
    workspaces: Array<{ id: string; name: string; role: string; createdAt: string }>;
    keycloak?: { enabled: boolean; localLogin?: boolean };
};

export function getWorkspaceSession() {
    return request<WorkspaceSession>("me");
}

export function authenticateWorkspace(mode: "login" | "register", username: string, password: string) {
    return request<WorkspaceSession>(mode, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
}

export function logoutWorkspace() {
    return request<{ ok: boolean; logoutUrl: string | null }>("logout", { method: "POST" });
}

export function keycloakLoginUrl(redirect = `${window.location.pathname}${window.location.search}`) {
    return `/api/auth/keycloak/login?redirect=${encodeURIComponent(redirect)}`;
}

async function request<T>(action: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`/api/auth/${action}`, init);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "账户请求失败");
    return data as T;
}
