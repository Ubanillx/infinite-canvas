/** 发送 JSON 请求并统一返回 { status, ok, data, text }，方便调试脚本判断响应。 */
export async function requestJson(url, { method = "GET", headers, body, timeout = 5000 } = {}) {
    const response = await fetch(url, {
        method,
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
    });
    const text = await response.text();
    let data = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        data = text;
    }
    return { status: response.status, ok: response.ok, data, text };
}

/** 在指定工作区下创建隔离的工作区记录，用于验证接口与测试数据。 */
export async function createWorkspace(baseUrl, name = `tooling-${Date.now().toString(36)}`) {
    const response = await requestJson(`${baseUrl}/api/workspaces`, { method: "POST", body: { name } });
    if (!response.ok) throw new Error(`Create workspace failed: ${response.status} ${response.text}`);
    return response.data.workspace;
}

/** 探活：轮询指定接口直到返回非错误状态，超时后抛出最后一次失败原因。 */
export async function waitForServer(baseUrl, { timeoutMs = 60000, intervalMs = 500, healthPath = "/api/workspaces" } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = "no response";
    while (Date.now() < deadline) {
        try {
            const response = await requestJson(`${baseUrl}${healthPath}`, { timeout: 2000 });
            if (response.status < 400) return true;
            last = `${response.status} ${response.text}`;
        } catch (error) {
            last = error.message;
        }
        await new Promise((done) => setTimeout(done, intervalMs));
    }
    throw new Error(`Server did not become ready at ${baseUrl}: ${last}`);
}
