import type { RegistrationPolicy } from "@/lib/registration";

export type WorkspaceIdentity = {
    provider: string;
    email: string | null;
    displayName: string | null;
    createdAt: string;
    lastLoginAt: string | null;
};

export type WorkspaceSession = {
    user: { id: string; username: string; displayName: string; isAdmin: boolean; createdAt: string; email?: string | null; emailVerifiedAt?: string | null; hasPassword?: boolean } | null;
    workspaces: Array<{ id: string; name: string; role: string; createdAt: string }>;
    identities?: WorkspaceIdentity[];
    keycloak?: { enabled: boolean; localLogin?: boolean };
};

export function getWorkspaceSession() {
    return request<WorkspaceSession>("me");
}

export function authenticateWorkspace(mode: "login" | "register", username: string, password: string, verification?: { email: string; code: string; challengeToken: string }) {
    return request<WorkspaceSession>(mode, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password, ...verification }) });
}

export function getRegistrationPolicy() { return request<RegistrationPolicy>("registration"); }

export function sendRegistrationEmailCode(email: string) {
    return request<{ challengeToken: string; resendAfter: number; expiresIn: number }>("register/code", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
}

export class WorkspaceAuthError extends Error {
    constructor(message: string, public retryAfter?: number) { super(message); }
}

export function logoutWorkspace() {
    return request<{ ok: boolean; logoutUrl: string | null }>("logout", { method: "POST" });
}

export function keycloakLoginUrl(redirect = `${window.location.pathname}${window.location.search}`) {
    return `/api/auth/keycloak/login?redirect=${encodeURIComponent(redirect)}`;
}

export function keycloakBindUrl(redirect = `${window.location.pathname}${window.location.search}`) {
    return `/api/auth/keycloak/login?mode=bind&redirect=${encodeURIComponent(redirect)}`;
}

export function unbindKeycloakIdentity() {
    return request<{ ok: boolean }>("identities/keycloak/unbind", { method: "POST" });
}

async function request<T>(action: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`/api/auth/${action}`, init);
    const data = await response.json();
    if (!response.ok) throw new WorkspaceAuthError(data.error || "账户请求失败", data.retryAfter);
    return data as T;
}
