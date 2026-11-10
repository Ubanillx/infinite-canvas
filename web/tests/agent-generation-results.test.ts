import { afterEach, beforeEach, expect, test } from "bun:test";

import { runGenerationResultTool } from "../src/lib/agent/agent-generation-results";

let originalWindow: PropertyDescriptor | undefined;
let originalFetch: typeof fetch;
let records: Record<string, unknown[]>;
let requests: Array<{ url: string; workspaceId: string | null }>;
const workspace = { id: "result-workspace", role: "viewer", name: "Results" };

beforeEach(() => {
    originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    originalFetch = globalThis.fetch;
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: { getItem: () => JSON.stringify(workspace) } } });
    requests = [];
    records = {
        image: [{ id: "image-log", title: "Image", createdAt: 10, status: "success", prompt: "Saved prompt", config: { apiKey: "must-not-leak" }, images: [{ id: "output", storageKey: "image:persisted", dataUrl: "data:image/png;base64,private", mimeType: "image/png", bytes: 42 }] }],
        video: [{ id: "video-log", title: "Video", createdAt: 20, status: "pending", task: { id: "private-upstream", apiKey: "must-not-leak" }, video: { storageKey: "video:saved", url: "https://temporary.invalid/private" } }],
    };
    globalThis.fetch = async (url, init) => {
        requests.push({ url: String(url), workspaceId: new Headers(init?.headers).get("x-infinite-canvas-workspace") });
        if (String(url).startsWith("/api/generation-tasks/")) return Response.json({ error: "not found" }, { status: 404 });
        if (String(url).startsWith("/api/generation-tasks")) return Response.json({ items: [] });
        const source = String(url).includes("image-workbench") ? "image" : "video";
        return Response.json({ revision: 10, payload: { logs: records[source] } });
    };
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
});

test("saved result exposes stable references and omits config, temporary URLs and task credentials", async () => {
    const image = await runGenerationResultTool("generation_get_result", { workspaceId: workspace.id, source: "image", id: "image-log" });
    expect(image).toMatchObject({ workspaceId: workspace.id, persistedHistoryOnly: true, result: { prompt: "Saved prompt", storedOutputCount: 1, outputs: [{ storageKey: "image:persisted", available: true }] } });
    const video = await runGenerationResultTool("generation_get_result", { workspaceId: workspace.id, source: "video", id: "video-log" });
    expect(video).toMatchObject({ result: { status: "pending", outputs: [{ storageKey: "video:saved" }] } });
    expect(JSON.stringify([image, video])).not.toMatch(/must-not-leak|temporary.invalid|private-upstream|base64/);
    expect(requests.every((item) => item.workspaceId === workspace.id)).toBe(true);
});

test("summary reads both saved domains, sorts and pages without original media data", async () => {
    const listed = await runGenerationResultTool("generation_list_results", { workspaceId: workspace.id, pageSize: 1 });
    expect(listed).toMatchObject({ total: 2, items: [{ id: "video-log", source: "video" }], persistedHistoryOnly: false });
    expect(requests).toHaveLength(4);
    expect(JSON.stringify(listed)).not.toMatch(/storageKey|apiKey|dataUrl/);
});

test("durable result reads the exact task even when hidden from the history list", async () => {
    globalThis.fetch = async (url, init) => {
        expect(String(url)).toBe("/api/generation-tasks/hidden-task");
        expect(new Headers(init?.headers).get("x-infinite-canvas-workspace")).toBe(workspace.id);
        return Response.json({ task: { id: "hidden-task", kind: "image", prompt: "Saved durable result", model: "mock", status: "succeeded", createdAt: "2026-01-01T00:00:00Z", outputs: [{ id: "out", storageKey: "image:stable", mimeType: "image/png", bytes: 42 }] } });
    };
    expect(await runGenerationResultTool("generation_get_result", { workspaceId: workspace.id, source: "image", id: "hidden-task" })).toMatchObject({ persistedHistoryOnly: false, result: { id: "hidden-task", durableTask: true, outputs: [{ storageKey: "image:stable", available: true }] } });
});

test("unpersisted output cannot become an actionable storage reference", async () => {
    records.image = [{ id: "unpersisted", status: "success", images: [{ storageKey: "https://foreign.invalid/asset", dataUrl: "blob:local" }] }];
    const value = await runGenerationResultTool("generation_get_result", { workspaceId: workspace.id, source: "image", id: "unpersisted" });
    expect(value).toMatchObject({ result: { storedOutputCount: 0, outputs: [{ available: false }] } });
    expect(JSON.stringify(value)).not.toMatch(/foreign.invalid|blob:local/);
});

test("wrong workspace and unreadable server history fail without fabricated results", async () => {
    await expect(runGenerationResultTool("generation_get_result", { workspaceId: "other", source: "image", id: "image-log" })).rejects.toThrow("不一致");
    expect(requests).toHaveLength(0);
    globalThis.fetch = async () => Response.json({ error: "forbidden" }, { status: 403 });
    await expect(runGenerationResultTool("generation_list_results", { workspaceId: workspace.id })).rejects.toThrow("forbidden");
});

test("canvas results use persisted target filters and retain stable references after node removal", async () => {
    globalThis.fetch = async (url) => {
        const query = new URL(String(url), "http://test").searchParams;
        expect(query.get("source")).toBe("canvas");
        expect(query.get("projectId")).toBe("project");
        expect(query.get("nodeId")).toBe("deleted-node");
        expect(query.get("requestId")).toBe("original-request");
        return Response.json({ items: [{ id: "persisted-task", requestId: "original-request", kind: "image", prompt: "Canvas image", model: "mock", status: "partial", createdAt: "2026-01-01T00:00:00Z", canvasTarget: { projectId: "project", nodeId: "deleted-node", unsafe: "private" }, outputs: [{ storageKey: "image:stable" }] }] });
    };
    const value = await runGenerationResultTool("generation_list_results", { workspaceId: workspace.id, source: "image", origin: "canvas", projectId: "project", nodeId: "deleted-node", requestId: "original-request" });
    expect(value).toMatchObject({ total: 1, items: [{ id: "persisted-task", requestId: "original-request", canvasTarget: { projectId: "project", nodeId: "deleted-node" }, storedOutputCount: 1, durableTask: true }] });
    expect(JSON.stringify(value)).not.toMatch(/unsafe|private|storageKey/);
});

test("unfiltered result lookup includes canvas and workbench task sources", async () => {
    await runGenerationResultTool("generation_list_results", { workspaceId: workspace.id });
    const queries = requests.filter((request) => request.url.startsWith("/api/generation-tasks?"));
    expect(queries).toHaveLength(2);
    expect(queries.every((request) => new URL(request.url, "http://test").searchParams.get("source") === "all")).toBe(true);
});
