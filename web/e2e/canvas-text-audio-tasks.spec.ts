import { randomUUID } from "node:crypto";
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect, registerTestAccount } from "./auth";
import { createGenerationWorker, type GenerationTaskOptions } from "../src/server/generation-tasks";
import type { GenerationTask } from "../src/types/generation-task";
import type { CanvasNodeData } from "../src/types/canvas";

// A valid quarter-second, mono PCM WAV lets the browser verify real duration.
const wav = Buffer.alloc(44 + 4000);
wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write("data", 36); wav.writeUInt32LE(4000, 40);
const audioOutput = { kind: "inline" as const, dataUrl: `data:audio/wav;base64,${wav.toString("base64")}` };
const textModel = "p5-fixture::text-model";
const audioModel = "p5-fixture::audio-model";
type Workspace = { id: string; name: string; role: string; createdAt: string };
test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser, baseURL }) => {
    if (!/^\/infinite_canvas_e2e_[a-z0-9_]+$/.test(new URL(process.env.DATABASE_URL || "postgres://invalid/unsafe").pathname)
        || !process.env.S3_BUCKET?.startsWith("infinite-canvas-e2e-") || process.env.INFINITE_CANVAS_GENERATION_WORKER !== "off") throw new Error("P5 tests require isolated E2E storage and disabled app worker");
    const setup = await browser.newContext({ baseURL });
    try {
        await registerTestAccount(setup.request);
        expect((await setup.request.put("/api/config", { data: {
            app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(),
            config: { channels: [{ id: "p5-fixture", name: "P5 fixture", baseUrl: "https://fixture.invalid/v1", apiFormat: "openai", apiKey: "P5-SECRET", models: [
                { name: "text-model", capability: "text" }, { name: "audio-model", capability: "audio" },
                { name: "script-text", capability: "text", script: 'return "Script text preserved";' },
                { name: "script-audio", capability: "audio", script: `return ${JSON.stringify(audioOutput.dataUrl)};` },
            ] }], model: textModel, textModel, audioModel, models: [textModel, audioModel, "p5-fixture::script-text", "p5-fixture::script-audio"],
            reasoningEffort: "auto", audioFormat: "wav", audioVoice: "alloy", audioSpeed: "1", audioInstructions: "", size: "1024x1024", quality: "auto", count: "1", proxyEnabled: false },
            webdav: {}, promptSources: { sources: [], schedule: { intervalMinutes: 0, lastFetchedAt: "" } },
        } })).status()).toBe(200);
    } finally { await setup.close(); }
});

function dependencies(provider: Partial<NonNullable<GenerationTaskOptions["provider"]>> = {}): GenerationTaskOptions {
    const unexpected = async () => { throw new Error("Unexpected provider call"); };
    return { resolveChannel: async (model) => ({ id: "p5-fixture", baseUrl: "https://fixture.invalid/v1", apiKey: "P5-SECRET", apiFormat: "openai", model: model.split("::").at(-1)! }),
        provider: { submitImage: unexpected, submitVideo: unexpected, pollVideo: unexpected, submitText: unexpected, submitAudio: unexpected,
            downloadOutput: async () => ({ bytes: wav, mimeType: "audio/wav" }), ...provider } };
}
function node(id: string, kind: "text" | "audio" = "text", count = 1): CanvasNodeData {
    return { id, type: kind, title: id, position: { x: 100, y: 100 }, width: 280, height: 180,
        metadata: { model: kind === "text" ? textModel : audioModel, generationMode: kind, textCount: count, composerContent: `Generate ${id}`, audioFormat: "wav", audioVoice: "alloy", audioSpeed: "1" } };
}
async function workspace(request: APIRequestContext): Promise<Workspace> { return (await (await request.get("/api/auth/me")).json()).workspaces[0]; }
async function seed(request: APIRequestContext, selected: Workspace, nodes: CanvasNodeData[]) {
    const headers = { "x-infinite-canvas-workspace": selected.id };
    const now = new Date().toISOString();
    expect((await request.put("/api/data/canvas", { headers, data: { revision: 0, payload: { version: 0, state: { folders: [], deletedProjects: [], projects: [{ id: "p5-canvas", title: "P5", folderId: null, createdAt: now, updatedAt: now, nodes, connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } }] } } } })).ok()).toBe(true);
    return { headers, tasks: async (): Promise<GenerationTask[]> => (await (await request.get("/api/generation-tasks?source=canvas&projectId=p5-canvas", { headers })).json()).items,
        task: async (id: string): Promise<GenerationTask> => (await (await request.get(`/api/generation-tasks/${id}`, { headers })).json()).task };
}
async function select(page: Page, selected: Workspace) {
    await page.context().addInitScript((value) => { if (!sessionStorage.getItem("infinite-canvas:active-workspace")) sessionStorage.setItem("infinite-canvas:active-workspace", JSON.stringify(value)); localStorage.setItem("infinite-canvas:active-workspace", JSON.stringify(value)); localStorage.setItem("canvas-side-panel-open", "0"); }, selected);
}
async function open(page: Page) {
    await page.goto("/canvas/p5-canvas");
    await expect.poll(() => page.evaluate(async () => (await import("/src/stores/use-agent-store.ts")).useAgentStore.getState().canvasContext?.snapshot.projectId)).toBe("p5-canvas");
}
async function snapshot(page: Page): Promise<CanvasNodeData[]> {
    return page.evaluate(async () => (await import("/src/stores/use-agent-store.ts")).useAgentStore.getState().canvasContext?.snapshot.nodes || []);
}
async function generate(page: Page, nodeId: string, kind: "text" | "audio" = "text", requestId = randomUUID()) {
    await page.evaluate(async (op) => (await import("/src/stores/use-agent-store.ts")).useAgentStore.getState().canvasContext!.applyOps([op]), { type: "run_generation" as const, nodeId, mode: kind, prompt: `Generate ${nodeId}`, requestId });
}
function posts(page: Page) {
    const calls: unknown[] = [];
    page.context().on("request", (sent) => { if (sent.method() === "POST" && new URL(sent.url()).pathname === "/api/generation-tasks") calls.push(sent.postDataJSON()); });
    return calls;
}
function gate() { let release!: () => void; const pending = new Promise<void>((resolve) => { release = resolve; }); return { pending, release }; }
async function audioBytes(request: APIRequestContext, headers: Record<string, string>, task: GenerationTask) {
    expect(task.outputs).toHaveLength(1);
    expect(task.outputs[0]).toMatchObject({ mimeType: "audio/wav", bytes: wav.length });
    expect(task.outputs[0].storageKey).toMatch(/^audio:/);
    const result = await request.get(`/api/media/blob/${encodeURIComponent(task.outputs[0].storageKey)}`, { headers });
    expect(result.status()).toBe(200); expect(await result.body()).toEqual(wav);
    expect(JSON.stringify(task)).not.toMatch(/P5-SECRET|data:audio|fixture\.invalid/);
}

test("text candidates expose persisted progress and reload reads the same final text without a second POST", async ({ page, request }) => {
    const selected = await workspace(request); const scene = await seed(request, selected, [node("stream", "text", 2)]);
    await select(page, selected); const calls = posts(page); const finish = gate(); let submits = 0;
    const worker = createGenerationWorker(dependencies({ submitText: async (_channel, _request, onDelta) => { const slot = submits++; await onDelta(`Partial ${slot}`); await finish.pending; await onDelta(`Final ${slot}`); return `Final ${slot}`; } }));
    try {
        await open(page); await generate(page, "stream"); await expect.poll(async () => (await scene.tasks()).length).toBe(1);
        const task = (await scene.tasks())[0]; await worker.tick();
        await expect.poll(async () => (await scene.task(task.id)).textOutputs?.filter((item) => item.content.startsWith("Partial")).length).toBe(2);
        await expect.poll(async () => (await snapshot(page)).find((item) => item.id === "stream")?.metadata?.texts?.filter((item) => item.content.startsWith("Partial")).length).toBe(2);
        const before = (await snapshot(page)).find((item) => item.id === "stream")!; const slotIds = before.metadata!.generationTask!.slotIds;
        await page.evaluate(async ({ nodeId, primary }) => (await import("/src/stores/use-agent-store.ts")).useAgentStore.getState().canvasContext!.applyOps([{ type: "update_node", id: nodeId, metadata: { primaryTextId: primary } }]), { nodeId: "stream", primary: slotIds[1] });
        await page.reload(); await open(page);
        await expect.poll(async () => (await snapshot(page)).find((item) => item.id === "stream")?.metadata?.texts?.filter((item) => item.content.startsWith("Partial")).length).toBe(2);
        finish.release(); await expect.poll(async () => (await scene.task(task.id)).status).toBe("succeeded");
        await expect.poll(async () => (await snapshot(page)).find((item) => item.id === "stream")?.metadata?.texts?.filter((item) => item.status === "success").length).toBe(2);
        const result = (await snapshot(page)).find((item) => item.id === "stream")!;
        expect(result.metadata!.texts!.map((item) => item.id)).toEqual(slotIds); expect(result.metadata!.primaryTextId).toBe(slotIds[1]); expect(result.metadata!.content).toBe("Final 1");
        await page.reload(); await open(page); await expect.poll(async () => (await snapshot(page)).find((item) => item.id === "stream")?.metadata?.content).toBe("Final 1");
        expect(calls).toHaveLength(1); expect(submits).toBe(2);
        expect((await scene.task(task.id)).textOutputs).toMatchObject([{ slotIndex: 0, status: "succeeded", content: "Final 0" }, { slotIndex: 1, status: "succeeded", content: "Final 1" }]);
    } finally { finish.release(); await worker.stop(); }
});

test("interrupted text stream retains partial checkpoints and never replays the paid submission", async ({ page, request }) => {
    const selected = await workspace(request); const scene = await seed(request, selected, [node("interrupted")]); await select(page, selected);
    const calls = posts(page); let submits = 0;
    const deps = dependencies({ submitText: async (_channel, _request, onDelta, signal) => {
        submits++; await onDelta("Retained partial checkpoint");
        return new Promise<string>((_resolve, reject) => { const abort = () => reject(new Error("Worker disconnected")); if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true }); });
    } });
    const first = createGenerationWorker(deps); let second: ReturnType<typeof createGenerationWorker> | undefined;
    try {
        await open(page); await generate(page, "interrupted"); await expect.poll(async () => (await scene.tasks()).length).toBe(1);
        const task = (await scene.tasks())[0]; await first.tick(); await expect.poll(async () => (await scene.task(task.id)).textOutputs?.[0]?.content).toBe("Retained partial checkpoint");
        await first.stop(); second = createGenerationWorker(deps); await second.tick();
        await expect.poll(async () => (await scene.task(task.id)).status).toBe("needs_attention");
        await page.reload(); await open(page); await expect.poll(async () => (await snapshot(page)).find((item) => item.id === "interrupted")?.metadata?.texts?.[0]?.content).toBe("Retained partial checkpoint");
        await generate(page, "interrupted"); expect((await scene.tasks()).map((item) => item.id)).toEqual([task.id]);
        expect(calls).toHaveLength(1); expect(submits).toBe(1); expect((await scene.task(task.id)).textOutputs?.[0]).toMatchObject({ content: "Retained partial checkpoint", status: "needs_attention" });
    } finally { await first.stop(); await second?.stop(); }
});

test("lost audio creation receipt recovers the original task and stable playable bytes after reload", async ({ page, request }) => {
    const selected = await workspace(request); const scene = await seed(request, selected, [node("speech", "audio")]); await select(page, selected);
    const calls = posts(page); let submits = 0; const worker = createGenerationWorker(dependencies({ submitAudio: async () => { submits++; return audioOutput; } }));
    await page.route("**/api/generation-tasks", async (route) => { if (route.request().method() !== "POST") return route.continue(); const response = await route.fetch(); expect(response.status()).toBe(202); await route.abort("failed"); });
    try {
        await open(page); await generate(page, "speech", "audio"); await expect.poll(async () => (await scene.tasks()).length).toBe(1); const task = (await scene.tasks())[0];
        await page.reload(); await open(page); await worker.tick(); await expect.poll(async () => (await scene.task(task.id)).status).toBe("succeeded"); const result = await scene.task(task.id);
        await expect.poll(async () => (await snapshot(page)).find((item) => item.id === "speech")?.metadata?.storageKey).toBe(result.outputs[0].storageKey);
        await expect.poll(async () => (await snapshot(page)).find((item) => item.id === "speech")?.metadata?.durationMs).toBeGreaterThan(0);
        expect((await snapshot(page)).find((item) => item.id === "speech")!.metadata!.durationMs).toBeCloseTo(250, -1);
        await audioBytes(request, scene.headers, result); await page.reload(); await open(page);
        await expect.poll(async () => (await snapshot(page)).find((item) => item.id === "speech")?.metadata?.generationTask?.taskId).toBe(task.id);
        expect(calls).toHaveLength(1); expect(submits).toBe(1);
    } finally { await worker.stop(); }
});

test("audio archival can resume the saved response without another speech generation", async ({ page, request }) => {
    const selected = await workspace(request); const scene = await seed(request, selected, [node("archive", "audio")]); await select(page, selected);
    let submits = 0; let downloads = 0;
    const worker = createGenerationWorker(dependencies({ submitAudio: async () => { submits++; return audioOutput; }, downloadOutput: async () => { if (++downloads === 1) throw new Error("Interrupted audio archival"); return { bytes: wav, mimeType: "audio/wav" }; } }));
    try {
        await open(page); await generate(page, "archive", "audio"); await expect.poll(async () => (await scene.tasks()).length).toBe(1); const task = (await scene.tasks())[0];
        await worker.tick(); await expect.poll(async () => (await scene.task(task.id)).errorCode).toBe("archive_failed");
        const resumed = await request.post(`/api/generation-tasks/${task.id}/resume`, { headers: scene.headers }); expect(resumed.status()).toBe(200);
        await worker.tick(); await expect.poll(async () => (await scene.task(task.id)).status).toBe("succeeded");
        await audioBytes(request, scene.headers, await scene.task(task.id)); await page.reload(); await open(page);
        await expect.poll(async () => (await snapshot(page)).find((item) => item.id === "archive")?.metadata?.storageKey).toBe((await scene.task(task.id)).outputs[0].storageKey);
        expect(submits).toBe(1); expect(downloads).toBe(2);
    } finally { await worker.stop(); }
});

test("deleted and replaced text targets reject late completion while original result stays readable", async ({ page, request }) => {
    const selected = await workspace(request); const scene = await seed(request, selected, [node("deleted"), node("replaced")]); await select(page, selected);
    const worker = createGenerationWorker(dependencies({ submitText: async () => "Original durable answer" }));
    try {
        await open(page); await generate(page, "deleted"); await expect.poll(async () => (await scene.tasks()).length).toBe(1);
        await generate(page, "replaced"); await expect.poll(async () => (await scene.tasks()).length).toBe(2);
        await page.evaluate(async () => (await import("/src/stores/use-agent-store.ts")).useAgentStore.getState().canvasContext!.applyOps([
            { type: "delete_node", id: "deleted" }, { type: "update_node", id: "replaced", metadata: { generationTask: undefined, content: "User replacement", status: "success" } },
        ]));
        await worker.tick(); await expect.poll(async () => (await scene.tasks()).every((item) => item.status === "succeeded")).toBe(true);
        await page.reload(); await open(page); expect((await snapshot(page)).some((item) => item.id === "deleted")).toBe(false);
        expect((await snapshot(page)).find((item) => item.id === "replaced")!.metadata!.content).toBe("User replacement");
        const task = (await scene.tasks())[0]; expect((await scene.task(task.id)).textOutputs?.[0].content).toBe("Original durable answer");
        const read = await page.evaluate(async ({ workspaceId, taskId }) => (await import("/src/lib/agent/agent-site-tools.ts")).runSiteTool("generation_get_result", { workspaceId, source: "text", id: taskId }, (() => undefined) as never), { workspaceId: selected.id, taskId: task.id });
        expect(JSON.stringify(read)).toContain("Original durable answer");
    } finally { await worker.stop(); }
});

test("audio results cannot cross a workspace switch even when canvas and node IDs match", async ({ page, request }) => {
    const selected = await workspace(request); const original = await seed(request, selected, [node("same", "audio")]);
    const response = await request.post("/api/workspaces", { data: { name: `P5 other ${randomUUID()}` } }); expect(response.ok()).toBe(true);
    const other = (await response.json()).workspace as Workspace; const elsewhere = await seed(request, other, [node("same", "audio")]); await select(page, selected);
    const worker = createGenerationWorker(dependencies({ submitAudio: async () => audioOutput }));
    try {
        await open(page); await generate(page, "same", "audio"); await expect.poll(async () => (await original.tasks()).length).toBe(1); const task = (await original.tasks())[0];
        await page.evaluate(async (value) => (await import("/src/lib/workspace.ts")).setActiveWorkspace(value as never), other); await open(page); await worker.tick();
        await expect.poll(async () => (await original.task(task.id)).status).toBe("succeeded"); expect((await snapshot(page))[0].metadata?.storageKey).toBeUndefined(); expect(await elsewhere.tasks()).toEqual([]);
        await audioBytes(request, original.headers, await original.task(task.id));
        await page.evaluate(async (value) => (await import("/src/lib/workspace.ts")).setActiveWorkspace(value as never), selected); await open(page);
        await expect.poll(async () => (await snapshot(page))[0].metadata?.storageKey).toBe((await original.task(task.id)).outputs[0].storageKey);
    } finally { await worker.stop(); }
});

test("text and audio script models retain browser generation and persisted results without durable POST", async ({ page, request }) => {
    const selected = await workspace(request); const text = node("script-text"); text.metadata!.model = "p5-fixture::script-text";
    const audio = node("script-audio", "audio"); audio.metadata!.model = "p5-fixture::script-audio"; const scene = await seed(request, selected, [text, audio]); await select(page, selected); const calls = posts(page);
    await open(page); await generate(page, text.id); await expect.poll(async () => (await snapshot(page)).find((item) => item.id === text.id)?.metadata?.content).toBe("Script text preserved");
    await generate(page, audio.id, "audio"); await expect.poll(async () => (await snapshot(page)).find((item) => item.id === audio.id)?.metadata?.storageKey).toMatch(/^audio:/);
    const key = (await snapshot(page)).find((item) => item.id === audio.id)!.metadata!.storageKey!;
    const blob = await request.get(`/api/media/blob/${encodeURIComponent(key)}`, { headers: { "x-infinite-canvas-workspace": selected.id } }); expect(await blob.body()).toEqual(wav);
    await expect.poll(async () => (await scene.nodes()).find((item) => item.id === audio.id)?.metadata?.storageKey).toBe(key);
    await page.reload(); await open(page); await expect.poll(async () => (await snapshot(page)).find((item) => item.id === text.id)?.metadata?.content).toBe("Script text preserved");
    expect((await snapshot(page)).find((item) => item.id === audio.id)!.metadata!.storageKey).toBe(key); expect(calls).toEqual([]);
});
