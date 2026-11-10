import { afterEach, beforeEach, expect, test } from "bun:test";

import { runPromptTool } from "../src/lib/agent/agent-prompt-tools";

const workspace = { id: "workspace-a", name: "A", role: "editor", createdAt: "2026-01-01T00:00:00Z" };
const ownPrompt = { id: "own", workspaceId: workspace.id, workspaceName: "A", title: "Original", prompt: "Text", description: "Keep", tags: ["saved"], shared: true, coverUrl: "", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", revision: "2026-01-01 00:00:00.123456+00" };
const foreignPrompt = { ...ownPrompt, id: "foreign", workspaceId: "workspace-b", workspaceName: "B" };

let originalFetch: typeof fetch;
let originalWindow: PropertyDescriptor | undefined;
let activeWorkspace = workspace;
let requests: Array<{ method: string; path: string; workspaceId: string | null; body?: unknown }>;

beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    activeWorkspace = workspace;
    requests = [];
    Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: { localStorage: { getItem: (key: string) => key === "infinite-canvas:active-workspace" ? JSON.stringify(activeWorkspace) : null } },
    });
    globalThis.fetch = async (url, init) => {
        const method = init?.method || "GET";
        const headers = new Headers(init?.headers);
        requests.push({ method, path: String(url), workspaceId: headers.get("x-infinite-canvas-workspace"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        const result = method === "GET" ? { items: [ownPrompt, foreignPrompt] } : method === "DELETE" ? { ok: true } : { item: ownPrompt };
        return Response.json(result);
    };
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
});

test("list and get expose only prompts owned by the selected workspace", async () => {
    const listed = await runPromptTool("prompts_list", { workspaceId: workspace.id }) as { total: number; items: Array<{ id: string }> };
    expect(listed.total).toBe(1);
    expect(listed.items.map((item) => item.id)).toEqual(["own"]);
    await expect(runPromptTool("prompts_get", { workspaceId: workspace.id, id: "foreign" })).rejects.toThrow("不存在或无权访问");
    await expect(runPromptTool("prompts_delete", { workspaceId: workspace.id, id: "foreign" })).rejects.toThrow("不存在或无权访问");
    expect(requests.every((request) => request.method === "GET")).toBe(true);
});

test("partial update preserves existing fields and waits for server commit", async () => {
    const result = await runPromptTool("prompts_update", { workspaceId: workspace.id, id: "own", title: "Renamed" }) as { status: string; workspaceId: string };
    expect(result).toMatchObject({ status: "committed", workspaceId: workspace.id });
    expect(requests.at(-1)).toMatchObject({
        method: "PUT", path: "/api/prompts/own", workspaceId: workspace.id,
        body: { title: "Renamed", prompt: "Text", description: "Keep", tags: ["saved"], shared: true, expectedRevision: ownPrompt.revision },
    });
});

test("create defaults to private and null explicitly removes an existing cover", async () => {
    const created = await runPromptTool("prompts_create", { workspaceId: workspace.id, title: "New", prompt: "Text" }) as { status: string };
    expect(created.status).toBe("committed");
    expect(requests.at(-1)?.body).toMatchObject({ title: "New", prompt: "Text", tags: [], shared: false });
    await runPromptTool("prompts_update", { workspaceId: workspace.id, id: "own", coverDataUrl: null });
    expect(requests.at(-1)?.body).toMatchObject({ title: "Original", prompt: "Text", shared: true, coverDataUrl: null, expectedRevision: ownPrompt.revision });
});

test("delete submits the exact revision and propagates a stale-write conflict", async () => {
    globalThis.fetch = async (url, init) => {
        if (init?.method === "DELETE") {
            expect(String(url)).toBe(`/api/prompts/own?expectedRevision=${encodeURIComponent(ownPrompt.revision)}`);
            return Response.json({ error: "提示词已被修改，请重新读取后再试" }, { status: 409 });
        }
        return Response.json({ items: [ownPrompt] });
    };
    await expect(runPromptTool("prompts_delete", { workspaceId: workspace.id, id: "own" })).rejects.toThrow("提示词已被修改");
});

test("missing server revision cannot silently fall back to an unconditional write", async () => {
    globalThis.fetch = async () => Response.json({ items: [{ ...ownPrompt, revision: undefined }] });
    await expect(runPromptTool("prompts_update", { workspaceId: workspace.id, id: "own", title: "Unsafe" })).rejects.toThrow("版本不可用");
    await expect(runPromptTool("prompts_delete", { workspaceId: workspace.id, id: "own" })).rejects.toThrow("版本不可用");
});

test("rejects a different workspace and a switch during the ownership lookup", async () => {
    await expect(runPromptTool("prompts_create", { workspaceId: "workspace-b", title: "New", prompt: "Text" })).rejects.toThrow();
    expect(requests).toHaveLength(0);
    globalThis.fetch = async () => {
        activeWorkspace = { ...workspace, id: "workspace-b" };
        return Response.json({ items: [ownPrompt] });
    };
    await expect(runPromptTool("prompts_update", { workspaceId: workspace.id, id: "own", title: "Nope" })).rejects.toThrow();
});

test("propagates a rejected server write instead of reporting a commit", async () => {
    globalThis.fetch = async () => Response.json({ error: "当前工作区为只读权限" }, { status: 403 });
    await expect(runPromptTool("prompts_create", { workspaceId: workspace.id, title: "New", prompt: "Text" })).rejects.toThrow("当前工作区为只读权限");
});

test("viewer cannot write even when the client sends a matching workspace ID", async () => {
    activeWorkspace = { ...workspace, role: "viewer" };
    await expect(runPromptTool("prompts_create", { workspaceId: workspace.id, title: "New", prompt: "Text" })).rejects.toThrow("只读");
    expect(requests).toHaveLength(0);
});
