import type { RegistrationConfig } from "@/lib/registration";

export function getRegistrationConfig() { return request<RegistrationConfig>("", "GET"); }
export function saveRegistrationConfig(config: RegistrationConfig) { return request<RegistrationConfig>("", "PUT", config); }
export function testRegistrationSmtp() { return request<{ ok: boolean }>("/smtp-test", "POST"); }

async function request<T>(path: string, method: string, body?: RegistrationConfig): Promise<T> {
    const response = await fetch(`/api/admin/registration${path}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "注册配置请求失败");
    return data;
}
