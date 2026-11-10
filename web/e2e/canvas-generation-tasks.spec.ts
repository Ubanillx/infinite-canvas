import { randomUUID } from "node:crypto";
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect, registerTestAccount } from "./auth";
import { execute, getPool } from "../src/server/db";
import { createGenerationWorker, type GenerationTaskOptions } from "../src/server/generation-tasks";
import type { GenerationTask } from "../src/types/generation-task";
import type { CanvasNodeData } from "../src/types/canvas";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
const imageOutput = { kind: "inline" as const, dataUrl: `data:image/png;base64,${png.toString("base64")}` };
let videoBytes: Buffer;
const imageModel = "canvas-fixture::image-model";
const videoModel = "canvas-fixture::video-model";
const scriptModel = "canvas-fixture::script-image";
type Workspace = { id: string; name: string; role: string; createdAt: string };

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser, baseURL }) => {
    if (!/^\/infinite_canvas_e2e_[a-z0-9_]+$/.test(new URL(process.env.DATABASE_URL || "postgres://invalid/unsafe").pathname)
        || !process.env.S3_BUCKET?.startsWith("infinite-canvas-e2e-")
        || process.env.INFINITE_CANVAS_GENERATION_WORKER !== "off") throw new Error("Canvas generation requires isolated E2E storage and disabled app worker");
    // Configure once as the first administrator; per-test accounts remain independent.
    const setup = await browser.newContext({ baseURL });
    try {
        await registerTestAccount(setup.request);
        expect((await setup.request.put("/api/config", { data: {
            app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(),
            config: {
                channels: [{ id: "canvas-fixture", name: "Canvas fixture", baseUrl: "https://fixture.invalid/v1", apiFormat: "openai", apiKey: "FIXTURE-SECRET", models: [{ name: "image-model", capability: "image" }, { name: "video-model", capability: "video" }, { name: "script-image", capability: "image", script: `return [${JSON.stringify(imageOutput.dataUrl)}];` }] }],
                model: imageModel, imageModel, videoModel, models: [imageModel, videoModel, scriptModel], size: "1024x1024", quality: "auto", count: "1", videoSeconds: "6", vquality: "720", proxyEnabled: false,
            }, webdav: {}, promptSources: { sources: [], schedule: { intervalMinutes: 0, lastFetchedAt: "" } },
        } })).status()).toBe(200);
        const recorder = await setup.newPage();
        await recorder.goto("/");
        const recorded = await recorder.evaluate(async () => {
            const canvas = document.createElement("canvas");
            canvas.width = 16; canvas.height = 8;
            canvas.getContext("2d")!.fillRect(0, 0, 16, 8);
            const stream = canvas.captureStream();
            const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
            return new Promise<number[]>((resolve, reject) => {
                const chunks: Blob[] = [];
                const media = new MediaRecorder(stream, { mimeType: "video/webm" });
                media.ondataavailable = (event) => chunks.push(event.data);
                media.onerror = () => reject(new Error("Video fixture recording failed"));
                media.onstop = async () => { stream.getTracks().forEach((item) => item.stop()); resolve(Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()))); };
                media.start();
                track.requestFrame();
                // Fixture recording duration only; this does not set a production request/poll boundary.
                setTimeout(() => media.stop(), 100);
            });
        });
        videoBytes = Buffer.from(recorded);
    } finally { await setup.close(); }
});

function dependencies(provider: Partial<NonNullable<GenerationTaskOptions["provider"]>> = {}): GenerationTaskOptions {
    const unexpected = async () => { throw new Error("Unexpected provider call"); };
    return {
        resolveChannel: async (model) => ({ id: "canvas-fixture", baseUrl: "https://fixture.invalid/v1", apiKey: "FIXTURE-SECRET", apiFormat: "openai", model: model.split("::").at(-1)! }),
        provider: {
            submitImage: unexpected, submitVideo: unexpected, pollVideo: unexpected,
            downloadOutput: async (_channel, output) => output.kind === "inline" ? { bytes: png, mimeType: "image/png" } : { bytes: videoBytes, mimeType: "video/webm" },
            ...provider,
        },
    };
}

function node(id: string, kind: "image" | "video" = "image", count = 1): CanvasNodeData {
    return { id, type: kind, title: id, position: { x: 100, y: 100 }, width: 240, height: 180, metadata: { model: kind === "image" ? imageModel : videoModel, count: String(count), generationMode: kind, composerContent: `Generate ${id}` } };
}

async function seed(request: APIRequestContext, workspace: Workspace, nodes: CanvasNodeData[], projectId = "durable-canvas") {
    const now = new Date().toISOString();
    const headers = { "x-infinite-canvas-workspace": workspace.id };
    expect((await request.put("/api/data/canvas", { headers, data: { revision: 0, payload: { version: 0, state: { folders: [], deletedProjects: [], projects: [{ id: projectId, title: projectId, folderId: null, createdAt: now, updatedAt: now, nodes, connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } }] } } } })).ok()).toBe(true);
    return {
        headers, projectId,
        tasks: async (): Promise<GenerationTask[]> => (await (await request.get(`/api/generation-tasks?source=canvas&projectId=${encodeURIComponent(projectId)}`, { headers })).json()).items,
        task: async (id: string): Promise<GenerationTask> => (await (await request.get(`/api/generation-tasks/${id}`, { headers })).json()).task,
        nodes: async (): Promise<CanvasNodeData[]> => (await (await request.get("/api/data/canvas", { headers })).json()).payload.state.projects.find((item: { id: string }) => item.id === projectId).nodes,
    };
}

async function currentWorkspace(request: APIRequestContext): Promise<Workspace> {
    return (await (await request.get("/api/auth/me")).json()).workspaces[0];
}

async function selectWorkspace(page: Page, workspace: Workspace) {
    await page.context().addInitScript((selected) => {
        if (!sessionStorage.getItem("infinite-canvas:active-workspace")) sessionStorage.setItem("infinite-canvas:active-workspace", JSON.stringify(selected));
        localStorage.setItem("infinite-canvas:active-workspace", JSON.stringify(selected));
        localStorage.setItem("infinite-canvas:known-workspaces", JSON.stringify([selected]));
        localStorage.setItem("canvas-side-panel-open", "0");
    }, workspace);
}

async function open(page: Page, projectId = "durable-canvas") {
    await page.goto(`/canvas/${projectId}`);
    await expect.poll(() => page.evaluate(async () => {
        const { useAgentStore } = await import("/src/stores/use-agent-store.ts");
        return useAgentStore.getState().canvasContext?.snapshot.projectId;
    })).toBe(projectId);
}

async function generate(page: Page, nodeId: string, kind: "image" | "video" = "image", requestId?: string) {
    await page.evaluate(async ({ nodeId, kind, requestId }) => {
        const { useAgentStore } = await import("/src/stores/use-agent-store.ts");
        useAgentStore.getState().canvasContext!.applyOps([{ type: "run_generation", nodeId, mode: kind, prompt: `Generate ${nodeId}`, requestId }]);
    }, { nodeId, kind, requestId });
}

async function snapshot(page: Page) {
    return page.evaluate(async () => {
        const { useAgentStore } = await import("/src/stores/use-agent-store.ts");
        return useAgentStore.getState().canvasContext?.snapshot.nodes || [];
    });
}

function countPosts(page: Page) {
    const posts: unknown[] = [];
    page.context().on("request", (request) => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/generation-tasks") posts.push(request.postDataJSON()); });
    return posts;
}

async function stableMedia(request: APIRequestContext, headers: Record<string, string>, task: GenerationTask, bytes = png) {
    expect(task.outputs.length).toBeGreaterThan(0);
    for (const output of task.outputs) {
        expect(output.storageKey).toMatch(task.kind === "image" ? /^image:/ : /^video:/);
        const media = await request.get(`/api/media/blob/${encodeURIComponent(output.storageKey)}`, { headers });
        expect(media.status()).toBe(200);
        expect(await media.body()).toEqual(bytes);
    }
    expect(JSON.stringify(task)).not.toMatch(/FIXTURE-SECRET|data:image\/png;base64|fixture\.invalid|videos\/canvas-upstream/);
}

test("image batch preserves slot IDs and partial results after the canvas is closed", async ({ page, request }) => {
    const workspace = await currentWorkspace(request);
    const scene = await seed(request, workspace, [node("batch", "image", 2)]);
    await selectWorkspace(page, workspace);
    const posts = countPosts(page);
    let submits = 0;
    const worker = createGenerationWorker(dependencies({ submitImage: async () => { if (++submits === 2) throw new Error("Second response lost"); return [imageOutput]; } }));
    try {
        await open(page);
        await generate(page, "batch");
        await expect.poll(async () => (await scene.tasks()).length).toBe(1);
        const created = (await scene.tasks())[0];
        const before = (await scene.nodes()).find((item) => item.id === "batch")!;
        const slotIds = before.metadata!.images!.map((image) => image.id);
        expect(slotIds).toHaveLength(2);
        expect(before.metadata!.generationTask).toMatchObject({ requestId: created.requestId, slotIds });
        await page.close();
        await worker.tick();
        await expect.poll(async () => (await scene.task(created.id)).status).toBe("needs_attention");
        const result = await scene.task(created.id);
        expect(result.outputs).toHaveLength(1);
        await stableMedia(request, scene.headers, result);
        const reopened = await page.context().newPage();
        await open(reopened);
        await expect.poll(async () => (await snapshot(reopened)).find((item) => item.id === "batch")?.metadata?.images?.filter((image) => image.storageKey).length).toBe(1);
        const restored = (await snapshot(reopened)).find((item) => item.id === "batch")!;
        expect(restored.metadata!.images!.map((image) => image.id)).toEqual(slotIds);
        expect(restored.metadata!.images!.find((image) => image.storageKey)?.storageKey).toBe(result.outputs[0].storageKey);
        expect(restored.metadata!.images![result.outputs[0].slotIndex!].storageKey).toBe(result.outputs[0].storageKey);
        const agentResult = await reopened.evaluate(async ({ workspaceId, taskId }) => {
            const { runSiteTool } = await import("/src/lib/agent/agent-site-tools.ts");
            return await runSiteTool("generation_get_result", { workspaceId, source: "image", id: taskId }, (() => undefined) as Parameters<typeof runSiteTool>[2]) as any;
        }, { workspaceId: workspace.id, taskId: result.id });
        expect(agentResult.result.outputs[0].storageKey).toBe(result.outputs[0].storageKey);
        expect(JSON.stringify(agentResult)).not.toMatch(/FIXTURE-SECRET|data:image\/png;base64|fixture\.invalid/);
        const primary = restored.metadata!.primaryImageId;
        expect(restored.metadata).toMatchObject({ naturalWidth: 1, naturalHeight: 1 });
        expect(restored.width).toBe(restored.height);
        await reopened.reload();
        await expect.poll(async () => (await snapshot(reopened)).find((item) => item.id === "batch")?.metadata?.storageKey).toBe(result.outputs[0].storageKey);
        expect((await snapshot(reopened)).find((item) => item.id === "batch")!.metadata!.primaryImageId).toBe(primary);
        expect(posts).toHaveLength(1);
        expect(submits).toBe(2);
        await reopened.goto("/image");
        const status = await reopened.evaluate(async ({ workspaceId, requestId, projectId }) => {
            const { runSiteTool } = await import("/src/lib/agent/agent-site-tools.ts");
            return runSiteTool("generation_get_status", { workspaceId, requestId, projectId, scope: "canvas" }, (() => undefined));
        }, { workspaceId: workspace.id, requestId: created.requestId, projectId: scene.projectId });
        expect(status).toMatchObject({ total: 1, tasks: [{ id: created.id, source: "canvas", status: "needs_attention", canvasTarget: created.canvasTarget }] });
        await reopened.close();
    } finally { await worker.stop(); }
});

test("video worker restart polls the persisted upstream task without another submission", async ({ page, request }) => {
    const workspace = await currentWorkspace(request);
    const scene = await seed(request, workspace, [node("video", "video")]);
    await selectWorkspace(page, workspace);
    const posts = countPosts(page);
    let submits = 0;
    let complete = false;
    const polled: string[] = [];
    const deps = dependencies({
        submitVideo: async () => { submits++; return { id: "canvas-upstream", provider: "openai", model: "video-model", channelId: "canvas-fixture" }; },
        pollVideo: async (_channel, upstream) => { polled.push(upstream.id); return complete ? { status: "completed", output: { kind: "provider", path: "videos/canvas-upstream/content" } } : { status: "pending" }; },
    });
    const first = createGenerationWorker(deps);
    let restarted: ReturnType<typeof createGenerationWorker> | undefined;
    try {
        await open(page);
        await generate(page, "video", "video");
        await expect.poll(async () => (await scene.tasks()).length).toBe(1);
        const task = (await scene.tasks())[0];
        await page.close();
        await first.tick();
        await expect.poll(() => polled.length).toBe(1);
        await first.stop();
        complete = true;
        // Advance the existing persisted polling schedule instead of waiting a fixed interval.
        await execute(await getPool(), "UPDATE generation_tasks SET next_poll_at = now() WHERE id = $1 AND workspace_id = $2", task.id, workspace.id);
        restarted = createGenerationWorker(deps);
        await restarted.tick();
        await expect.poll(async () => (await scene.task(task.id)).status).toBe("succeeded");
        const result = await scene.task(task.id);
        await stableMedia(request, scene.headers, result, videoBytes);
        const reopened = await page.context().newPage();
        await open(reopened);
        await expect.poll(async () => (await snapshot(reopened)).find((item) => item.id === "video")?.metadata?.storageKey).toBe(result.outputs[0].storageKey);
        const restoredVideo = (await snapshot(reopened)).find((item) => item.id === "video")!;
        expect(restoredVideo.width / restoredVideo.height).toBe(2);
        await reopened.reload();
        await expect.poll(async () => (await snapshot(reopened)).find((item) => item.id === "video")?.metadata?.generationTask?.taskId).toBe(task.id);
        expect(submits).toBe(1);
        expect(polled).toEqual(["canvas-upstream", "canvas-upstream"]);
        expect(posts).toHaveLength(1);
        await reopened.close();
    } finally { await first.stop(); await restarted?.stop(); }
});

test("a lost creation receipt recovers by request ID using GET after reload", async ({ page, request }) => {
    const workspace = await currentWorkspace(request);
    const scene = await seed(request, workspace, [node("lost-receipt")]);
    await selectWorkspace(page, workspace);
    const posts = countPosts(page);
    let submits = 0;
    const worker = createGenerationWorker(dependencies({ submitImage: async () => { submits++; return [imageOutput]; } }));
    await page.route("**/api/generation-tasks", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        const response = await route.fetch();
        expect(response.status()).toBe(202);
        await route.abort("failed");
    });
    try {
        await open(page);
        await generate(page, "lost-receipt");
        await expect.poll(async () => (await scene.tasks()).length).toBe(1);
        const task = (await scene.tasks())[0];
        expect((await scene.nodes())[0].metadata!.generationTask!.requestId).toBe(task.requestId);
        await page.reload();
        await worker.tick();
        await expect.poll(async () => (await scene.task(task.id)).status).toBe("succeeded");
        const result = await scene.task(task.id);
        await expect.poll(async () => (await snapshot(page))[0]?.metadata?.storageKey).toBe(result.outputs[0].storageKey);
        expect((await snapshot(page))[0].metadata!.generationTask!.taskId).toBe(task.id);
        await stableMedia(request, scene.headers, result);
        expect(posts).toHaveLength(1);
        expect(submits).toBe(1);
    } finally { await worker.stop(); }
});

test("deleted, undone and replaced generation targets reject late results while task media stays readable", async ({ page, request }) => {
    const workspace = await currentWorkspace(request);
    const scene = await seed(request, workspace, [node("undone"), node("deleted"), node("replaced")]);
    await selectWorkspace(page, workspace);
    let submits = 0;
    const worker = createGenerationWorker(dependencies({ submitImage: async () => { submits++; return [imageOutput]; } }));
    try {
        await open(page);
        await generate(page, "undone");
        await expect.poll(async () => (await scene.tasks()).length).toBe(1);
        await expect.poll(() => page.evaluate(async () => {
            const { useAgentStore } = await import("/src/stores/use-agent-store.ts");
            return useAgentStore.getState().canvasContext!.canUndo;
        })).toBe(true);
        await page.evaluate(async () => {
            const { useAgentStore } = await import("/src/stores/use-agent-store.ts");
            useAgentStore.getState().canvasContext!.undoOps();
        });
        await generate(page, "deleted");
        await expect.poll(async () => (await scene.tasks()).length).toBe(2);
        await generate(page, "replaced");
        await expect.poll(async () => (await scene.tasks()).length).toBe(3);
        await page.evaluate(async () => {
            const { useAgentStore } = await import("/src/stores/use-agent-store.ts");
            const canvas = useAgentStore.getState().canvasContext!;
            const old = canvas.snapshot.nodes.find((node) => node.id === "replaced")!.metadata!.generationTask!;
            canvas.applyOps([
                { type: "delete_node", id: "deleted" },
                { type: "update_node", id: "replaced", metadata: { generationTask: { ...old, requestId: "new-user-intent", taskId: undefined }, content: "User replacement", status: "success" } },
            ]);
        });
        await expect.poll(async () => (await scene.nodes()).some((item) => item.id === "deleted")).toBe(false);
        await expect.poll(async () => (await scene.nodes()).find((item) => item.id === "replaced")?.metadata?.content).toBe("User replacement");
        expect((await scene.nodes()).find((item) => item.id === "replaced")?.metadata?.generationTask).toBeUndefined();
        const tasks = await scene.tasks();
        await worker.tick();
        await expect.poll(async () => (await scene.tasks()).every((task) => task.status === "succeeded")).toBe(true);
        for (const task of tasks) await stableMedia(request, scene.headers, await scene.task(task.id));
        await page.reload();
        await open(page);
        const final = await snapshot(page);
        expect(final.some((item) => item.id === "deleted")).toBe(false);
        expect(final.find((item) => item.id === "undone")?.metadata?.storageKey).toBeUndefined();
        expect(final.find((item) => item.id === "undone")?.metadata?.generationTask).toBeUndefined();
        expect(final.find((item) => item.id === "replaced")?.metadata).toMatchObject({ content: "User replacement" });
        expect(final.find((item) => item.id === "replaced")?.metadata?.generationTask).toBeUndefined();
        expect(final.find((item) => item.id === "replaced")?.metadata?.storageKey).toBeUndefined();
        expect(submits).toBe(3);
    } finally { await worker.stop(); }
});

test("workspace switching cannot apply a completed task to matching project and node IDs elsewhere", async ({ page, request }) => {
    const workspace = await currentWorkspace(request);
    const original = await seed(request, workspace, [node("same-node")]);
    const response = await request.post("/api/workspaces", { data: { name: `Other canvas ${randomUUID()}` } });
    expect(response.ok()).toBe(true);
    const otherWorkspace: Workspace = (await response.json()).workspace;
    const other = await seed(request, otherWorkspace, [node("same-node")]);
    await selectWorkspace(page, workspace);
    const posts = countPosts(page);
    let submits = 0;
    const worker = createGenerationWorker(dependencies({ submitImage: async () => { submits++; return [imageOutput]; } }));
    try {
        await open(page);
        await generate(page, "same-node");
        await expect.poll(async () => (await original.tasks()).length).toBe(1);
        const task = (await original.tasks())[0];
        await page.evaluate(async (selected) => {
            const { setActiveWorkspace } = await import("/src/lib/workspace.ts");
            setActiveWorkspace(selected as Parameters<typeof setActiveWorkspace>[0]);
        }, otherWorkspace);
        await open(page);
        await worker.tick();
        await expect.poll(async () => (await original.task(task.id)).status).toBe("succeeded");
        expect((await snapshot(page))[0].metadata?.storageKey).toBeUndefined();
        expect((await other.nodes())[0].metadata?.generationTask).toBeUndefined();
        expect(await other.tasks()).toEqual([]);
        await stableMedia(request, original.headers, await original.task(task.id));
        await page.evaluate(async (selected) => {
            const { setActiveWorkspace } = await import("/src/lib/workspace.ts");
            setActiveWorkspace(selected as Parameters<typeof setActiveWorkspace>[0]);
        }, workspace);
        await open(page);
        await expect.poll(async () => (await snapshot(page))[0]?.metadata?.storageKey).toBe((await original.task(task.id)).outputs[0].storageKey);
        expect(posts).toHaveLength(1);
        expect(submits).toBe(1);
    } finally { await worker.stop(); }
});

test("canvas acceptance validates saved markers and the original receipt survives target deletion and hiding", async ({ request }) => {
    const workspace = await currentWorkspace(request);
    const requestId = randomUUID();
    const target = node("bound");
    target.metadata!.generationTask = { workspaceId: workspace.id, projectId: "durable-canvas", nodeId: target.id, kind: "image", requestId, slotIds: ["slot"] };
    const scene = await seed(request, workspace, [target]);
    const input = { requestId, kind: "image", model: imageModel, prompt: "Bound request", settings: { count: 1 }, references: [], canvasTarget: { projectId: scene.projectId, nodeId: target.id } };
    const rejected = await request.post("/api/generation-tasks", { headers: scene.headers, data: { ...input, requestId: "different-marker" } });
    expect(rejected.status()).toBe(409);
    const created = await request.post("/api/generation-tasks", { headers: scene.headers, data: input });
    expect(created.status()).toBe(202);
    const task: GenerationTask = (await created.json()).task;
    const canvas = await (await request.get("/api/data/canvas", { headers: scene.headers })).json();
    canvas.payload.state.projects[0].nodes = [];
    expect((await request.put("/api/data/canvas", { headers: scene.headers, data: { revision: canvas.revision, payload: canvas.payload } })).ok()).toBe(true);
    const repeat = await request.post("/api/generation-tasks", { headers: scene.headers, data: input });
    expect(repeat.status()).toBe(202);
    expect((await repeat.json()).task.id).toBe(task.id);
    expect((await request.post("/api/generation-tasks", { headers: scene.headers, data: { ...input, prompt: "Changed prompt" } })).status()).toBe(409);
    const workbench = await (await request.get("/api/generation-tasks?source=workbench", { headers: scene.headers })).json();
    expect(workbench.items).toEqual([]);
    await execute(await getPool(), "UPDATE generation_tasks SET status = 'failed', revision = revision + 1 WHERE id = $1 AND workspace_id = $2", task.id, workspace.id);
    expect((await request.delete(`/api/generation-tasks/${task.id}`, { headers: scene.headers })).ok()).toBe(true);
    expect(await scene.tasks()).toEqual([]);
    const hidden = await request.get(`/api/generation-tasks?source=canvas&requestId=${requestId}`, { headers: scene.headers });
    expect((await hidden.json()).items.map((item: GenerationTask) => item.id)).toEqual([task.id]);
    expect((await scene.task(task.id)).canvasTarget).toEqual(input.canvasTarget);
});

test("repeated canvas request IDs recover the same task and report conflicting dispatches without another POST", async ({ page, request }) => {
    const workspace = await currentWorkspace(request);
    const scene = await seed(request, workspace, [node("original"), node("other")]);
    await selectWorkspace(page, workspace);
    const posts = countPosts(page);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await open(page);
    const requestId = randomUUID();
    await generate(page, "original", "image", requestId);
    await expect.poll(async () => (await scene.tasks()).length).toBe(1);
    const task = (await scene.tasks())[0];
    await generate(page, "original", "image", requestId);
    await generate(page, "other", "image", requestId);
    await expect.poll(async () => (await snapshot(page)).find((item) => item.id === "other")?.metadata?.generationDispatchError?.message).toContain("目标");
    await page.evaluate(async (requestId) => {
        const { useAgentStore } = await import("/src/stores/use-agent-store.ts");
        useAgentStore.getState().canvasContext!.applyOps([{ type: "run_generation", nodeId: "original", mode: "image", prompt: "Different prompt", requestId }]);
    }, requestId);
    await expect.poll(async () => (await snapshot(page)).find((item) => item.id === "original")?.metadata?.generationDispatchError?.message).toContain("参数");
    const status = await page.evaluate(async ({ workspaceId, requestId }) => {
        const { runSiteTool } = await import("/src/lib/agent/agent-site-tools.ts");
        const { useAgentStore } = await import("/src/stores/use-agent-store.ts");
        return runSiteTool("generation_get_status", { workspaceId, requestId, scope: "canvas" }, (() => undefined), { canvasSnapshot: useAgentStore.getState().canvasContext!.snapshot });
    }, { workspaceId: workspace.id, requestId });
    expect(status).toMatchObject({ total: 1, tasks: [{ id: task.id, source: "canvas" }], dispatchErrors: [{ requestId }, { requestId }] });
    expect(posts).toHaveLength(1);
    expect(pageErrors).toEqual([]);
});

test("canvas custom script generation keeps browser execution and saved media after reload", async ({ page, request }) => {
    const workspace = await currentWorkspace(request);
    const scripted = node("scripted");
    scripted.metadata!.model = scriptModel;
    const scene = await seed(request, workspace, [scripted]);
    await selectWorkspace(page, workspace);
    const posts = countPosts(page);
    await open(page);
    await generate(page, scripted.id);
    await expect.poll(async () => (await snapshot(page))[0]?.metadata?.storageKey).toMatch(/^image:/);
    const result = (await snapshot(page))[0];
    expect(result.metadata?.generationTask).toBeUndefined();
    expect(result.metadata).toMatchObject({ status: "success", naturalWidth: 1, naturalHeight: 1 });
    await expect.poll(async () => (await scene.nodes())[0]?.metadata?.storageKey).toBe(result.metadata!.storageKey);
    await page.reload();
    await expect.poll(async () => (await snapshot(page))[0]?.metadata?.storageKey).toBe(result.metadata!.storageKey);
    expect(await scene.tasks()).toEqual([]);
    expect(posts).toHaveLength(0);
    const stored = await request.get(`/api/media/blob/${encodeURIComponent(result.metadata!.storageKey!)}`, { headers: scene.headers });
    expect(await stored.body()).toEqual(png);
});
