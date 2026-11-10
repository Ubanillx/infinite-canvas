import { afterEach, beforeEach, expect, test } from "bun:test";

import { saveWorkspaceData, waitForWorkspaceDataSave } from "../src/services/workspace-data";

let originalFetch: typeof fetch;
let originalWindow: PropertyDescriptor | undefined;
let activeWorkspaceId = "";
let sequence = 0;
let requests: Array<{ method: string; workspaceId: string | null; body?: unknown }>;
let onRequest: (method: string, workspaceId: string | null) => Promise<Response> | Response;

function workspace() {
    activeWorkspaceId = `workspace-commit-${++sequence}`;
    return activeWorkspaceId;
}

function response(revision: number) {
    return Response.json({ revision, updatedAt: "2026-01-01T00:00:00Z" });
}

beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    requests = [];
    Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
            localStorage: { getItem: (key: string) => key === "infinite-canvas:active-workspace" ? JSON.stringify({ id: activeWorkspaceId, name: "Test", role: "editor" }) : null },
            dispatchEvent: () => true,
        },
    });
    onRequest = (method) => method === "GET" ? response(0) : response(1);
    globalThis.fetch = async (_url, init) => {
        const method = init?.method || "GET";
        const workspaceId = new Headers(init?.headers).get("x-infinite-canvas-workspace");
        requests.push({ method, workspaceId, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return onRequest(method, workspaceId);
    };
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
});

test("a commit receipt waits for the server PUT response", async () => {
    const id = workspace();
    let finish!: (value: Response) => void;
    onRequest = (method) => method === "GET" ? Response.json({ payload: null, revision: 0 }) : new Promise((resolve) => { finish = resolve; });
    const pending = saveWorkspaceData("canvas", { state: { projects: [] } });
    let settled = false;
    void pending.finally(() => { settled = true; });
    for (let i = 0; i < 5 && !finish; i++) await Promise.resolve();
    expect(requests.map((item) => item.method)).toEqual(["GET", "PUT"]);
    expect(settled).toBe(false);
    finish(response(1));
    expect(await pending).toMatchObject({ workspaceId: id, domain: "canvas", revision: 1, updatedAt: "2026-01-01T00:00:00Z" });
});

test("403 and 409 never return a successful receipt", async () => {
    workspace();
    onRequest = (method) => method === "GET" ? Response.json({ payload: null, revision: 0 }) : Response.json({ error: "只读" }, { status: 403 });
    await expect(saveWorkspaceData("assets", { state: { assets: [] } }, { retryable: false })).rejects.toThrow("只读");

    workspace();
    onRequest = (method) => method === "GET" ? Response.json({ payload: null, revision: 2 }) : Response.json({ error: "冲突", payload: {}, revision: 3 }, { status: 409 });
    await expect(saveWorkspaceData("canvas-templates", { templates: [] })).rejects.toThrow("冲突");
});

test("a queued write retains its initial workspace and successful receipt after switching", async () => {
    const id = workspace();
    let finish!: (value: Response) => void;
    onRequest = (method) => method === "GET" ? Response.json({ payload: null, revision: 0 }) : new Promise((resolve) => { finish = resolve; });
    const pending = saveWorkspaceData("video-workbench", { logs: [] });
    for (let i = 0; i < 5 && !finish; i++) await Promise.resolve();
    expect(requests.map((item) => item.workspaceId)).toEqual([id, id]);
    const waiting = waitForWorkspaceDataSave("video-workbench", id);
    activeWorkspaceId = workspace();
    finish(response(1));
    expect(await pending).toMatchObject({ workspaceId: id, revision: 1 });
    expect(await waiting).toMatchObject({ workspaceId: id, revision: 1 });
    expect(requests.map((item) => item.workspaceId)).toEqual([id, id]);
});
