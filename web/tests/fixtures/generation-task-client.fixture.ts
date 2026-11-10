import { afterEach, beforeEach, expect, mock, test } from "bun:test";

const pending = new Map<string, unknown>();
mock.module("localforage", () => ({
    default: { createInstance: () => ({
        getItem: async (key: string) => pending.get(key) ?? null,
        setItem: async (key: string, value: unknown) => { pending.set(key, value); return value; },
        removeItem: async (key: string) => { pending.delete(key); },
    }) },
}));

const { getGenerationTaskByRequestId, listCanvasGenerationTasks, listGenerationTasks, submitGenerationTask, submitWorkbenchGenerationTask } = await import("../../src/services/api/generation-tasks");
const input = { requestId: "first-request", kind: "image" as const, prompt: "first prompt", model: "image-model", settings: { count: 1 }, references: [] };
const task = { id: "task-1", requestId: input.requestId, workspaceId: "workspace-a", kind: "image", prompt: input.prompt, model: input.model, settings: input.settings, status: "queued", outputs: [], successCount: 0, failCount: 0, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", revision: 1 };
const workspace = { id: "workspace-a", name: "A", role: "editor", createdAt: "2026-01-01T00:00:00Z" };
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalFetch = globalThis.fetch;
let requests: Array<{ method: string; body?: typeof input; workspaceId: string | null }>;

beforeEach(() => {
    pending.clear();
    requests = [];
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: { getItem: () => JSON.stringify(workspace) } } });
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
});

test("a lost submission response reuses the original request and workspace", async () => {
    let attempt = 0;
    globalThis.fetch = async (_url, init) => {
        requests.push({ method: init?.method || "GET", body: JSON.parse(String(init?.body)), workspaceId: new Headers(init?.headers).get("x-infinite-canvas-workspace") });
        if (++attempt === 1) throw new TypeError("network disconnected");
        return Response.json({ task });
    };
    await expect(submitWorkbenchGenerationTask(workspace.id, input)).rejects.toThrow("network disconnected");
    expect(await submitWorkbenchGenerationTask(workspace.id, { ...input, requestId: "second-request" })).toEqual(task);
    expect(requests.map((request) => request.body?.requestId)).toEqual(["first-request", "first-request"]);
    expect(requests.every((request) => request.workspaceId === workspace.id)).toBe(true);
    expect(pending.size).toBe(0);
});

test("listing a committed task resolves an uncertain browser submission", async () => {
    globalThis.fetch = async (_url, init) => {
        requests.push({ method: init?.method || "GET", workspaceId: new Headers(init?.headers).get("x-infinite-canvas-workspace") });
        return init?.method === "POST" ? Promise.reject(new TypeError("lost response")) : Response.json({ items: [task] });
    };
    await expect(submitWorkbenchGenerationTask(workspace.id, input)).rejects.toThrow("lost response");
    expect(pending.size).toBe(1);
    expect(await listGenerationTasks(workspace.id, "image")).toEqual([task]);
    expect(pending.size).toBe(0);
});

test("a definitive validation failure does not lock the next submission", async () => {
    globalThis.fetch = async (_url, init) => {
        requests.push({ method: init?.method || "GET", body: JSON.parse(String(init?.body)), workspaceId: new Headers(init?.headers).get("x-infinite-canvas-workspace") });
        return requests.length === 1 ? Response.json({ error: "invalid input" }, { status: 400 }) : Response.json({ task: { ...task, requestId: "second-request" } });
    };
    await expect(submitWorkbenchGenerationTask(workspace.id, input)).rejects.toThrow("invalid input");
    expect(await submitWorkbenchGenerationTask(workspace.id, { ...input, requestId: "second-request" })).toMatchObject({ requestId: "second-request" });
});

for (const status of [403, 409, 400]) test(`a lost receipt followed by ${status} retains the original intent`, async () => {
    let attempt = 0;
    globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as typeof input;
        requests.push({ method: init?.method || "GET", body, workspaceId: new Headers(init?.headers).get("x-infinite-canvas-workspace") });
        if (++attempt === 1) throw new TypeError("receipt lost after commit");
        if (attempt === 2) return Response.json({ error: "temporary workspace state" }, { status });
        return Response.json({ task });
    };
    await expect(submitWorkbenchGenerationTask(workspace.id, input)).rejects.toThrow("receipt lost");
    await expect(submitWorkbenchGenerationTask(workspace.id, { ...input, requestId: "second-request" })).rejects.toThrow("temporary workspace state");
    expect(pending.size).toBe(1);
    expect(await submitWorkbenchGenerationTask(workspace.id, { ...input, requestId: "third-request" })).toEqual(task);
    expect(requests.map((request) => request.body?.requestId)).toEqual([input.requestId, input.requestId, input.requestId]);
    expect(pending.size).toBe(0);
});

test("a fresh authorization failure preserves the intent until reconciliation", async () => {
    globalThis.fetch = async (_url, init) => init?.method === "POST"
        ? Response.json({ error: "denied" }, { status: 403 })
        : Response.json({ items: [task] });
    await expect(submitWorkbenchGenerationTask(workspace.id, input)).rejects.toThrow("denied");
    expect(pending.size).toBe(1);
    await listGenerationTasks(workspace.id, input.kind);
    expect(pending.size).toBe(0);
});

test("an older receipt cannot clear a newer pending request", async () => {
    globalThis.fetch = async () => {
        pending.set(`${workspace.id}:${input.kind}`, { ...input, requestId: "newer-request" });
        return Response.json({ task });
    };
    await submitWorkbenchGenerationTask(workspace.id, input);
    expect(pending.get(`${workspace.id}:${input.kind}`)).toMatchObject({ requestId: "newer-request" });
});

test("changed workbench input cannot silently resubmit the uncertain prompt", async () => {
    globalThis.fetch = async (_url, init) => {
        requests.push({ method: init?.method || "GET", body: JSON.parse(String(init?.body)), workspaceId: new Headers(init?.headers).get("x-infinite-canvas-workspace") });
        throw new TypeError("lost response");
    };
    await expect(submitWorkbenchGenerationTask(workspace.id, input)).rejects.toThrow("lost response");
    await expect(submitWorkbenchGenerationTask(workspace.id, { ...input, requestId: "second-request", prompt: "changed" })).rejects.toThrow("上次提交未确认");
    expect(requests.length).toBe(1);
    await expect(submitGenerationTask(workspace.id, { ...input, requestId: "explicit-mcp-request" })).rejects.toThrow("lost response");
    expect(requests[1]?.body?.requestId).toBe("explicit-mcp-request");
});

test("an invalid task receipt remains pending for reconciliation", async () => {
    globalThis.fetch = async () => Response.json({ task: { ...task, requestId: "wrong-request" } });
    await expect(submitWorkbenchGenerationTask(workspace.id, input)).rejects.toThrow("回执无效");
    expect(pending.size).toBe(1);
});

test("workbench and canvas lists use explicit separate sources", async () => {
    const urls: string[] = [];
    globalThis.fetch = async (url) => { urls.push(String(url)); return Response.json({ items: [] }); };
    await listGenerationTasks(workspace.id, "image");
    await listGenerationTasks(workspace.id, "video", { source: "all" });
    await listCanvasGenerationTasks(workspace.id, "project / 1");
    expect(new URL(urls[0], "http://localhost").searchParams.get("source")).toBe("workbench");
    expect(new URL(urls[1], "http://localhost").searchParams.get("source")).toBe("all");
    expect(new URL(urls[2], "http://localhost").searchParams.get("projectId")).toBe("project / 1");
});

test("canvas receipt loss is reconciled with a read scoped to the same target", async () => {
    const canvasTarget = { projectId: "project", nodeId: "node" };
    globalThis.fetch = async (url, init) => {
        expect(init?.method || "GET").toBe("GET");
        const query = new URL(String(url), "http://localhost").searchParams;
        expect(query.get("requestId")).toBe(input.requestId);
        expect(query.get("projectId")).toBe(canvasTarget.projectId);
        expect(query.get("nodeId")).toBe(canvasTarget.nodeId);
        return Response.json({ items: [{ ...task, canvasTarget }] });
    };
    expect(await getGenerationTaskByRequestId(workspace.id, input.requestId, canvasTarget)).toMatchObject({ canvasTarget });
    expect(pending.size).toBe(0);
});

test("a receipt for a different canvas node cannot attach to the requested node", async () => {
    globalThis.fetch = async () => Response.json({ task: { ...task, canvasTarget: { projectId: "project", nodeId: "other-node" } } });
    await expect(submitGenerationTask(workspace.id, { ...input, canvasTarget: { projectId: "project", nodeId: "node" } })).rejects.toThrow("目标回执不一致");
});

test("text and audio receipts must match the original kind before acceptance", async () => {
    for (const kind of ["text", "audio"] as const) {
        globalThis.fetch = async () => Response.json({ task: { ...task, kind: "image" } });
        await expect(submitGenerationTask(workspace.id, { ...input, kind })).rejects.toThrow("回执无效");
        globalThis.fetch = async () => Response.json({ task: { ...task, kind } });
        expect(await submitGenerationTask(workspace.id, { ...input, kind })).toMatchObject({ kind });
    }
});
