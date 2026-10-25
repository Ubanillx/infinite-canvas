export async function getWorkspaceSession() {
    return request("me");
}

export async function authenticateWorkspace(mode: "login" | "register", username: string, password: string) {
    return request(mode, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
}

async function request(action: string, init?: RequestInit): Promise<{ user: { id: string; username: string } | null }> {
    const response = await fetch(`/api/auth/${action}`, init);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "账户请求失败");
    return data;
}
