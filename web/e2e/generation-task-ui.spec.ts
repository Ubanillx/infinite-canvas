import { test, expect } from "./auth";
import { createGenerationWorker } from "../src/server/generation-tasks";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
const imageUrl = `data:image/png;base64,${png.toString("base64")}`;
const modelImage = "ui-mock::image-model";
const modelVideo = "ui-mock::video-model";

test.beforeAll(() => {
    if (!/^\/infinite_canvas_e2e_[a-z0-9_]+$/.test(new URL(process.env.DATABASE_URL || "postgres://invalid/unsafe").pathname)
        || !process.env.S3_BUCKET?.startsWith("infinite-canvas-e2e-")
        || process.env.INFINITE_CANVAS_GENERATION_WORKER !== "off") {
        throw new Error("Generation UI tests require isolated database/bucket and disabled app worker");
    }
});

test("image and video workbenches resume persisted results after reload without resubmission", async ({ page, request }) => {
    const { workspaces } = await (await request.get("/api/auth/me")).json();
    const workspace = workspaces[0];
    const headers = { "x-infinite-canvas-workspace": workspace.id };
    const config = {
        app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(),
        config: {
            channels: [{ id: "ui-mock", name: "Isolated fixture", baseUrl: "https://fixture.invalid/v1", apiFormat: "openai", apiKey: "FIXTURE-SECRET", models: [{ name: "image-model", capability: "image" }, { name: "video-model", capability: "video" }] }],
            model: modelImage, imageModel: modelImage, videoModel: modelVideo, models: [modelImage, modelVideo], size: "1024x1024", quality: "auto", count: "1", videoSeconds: "6", vquality: "720", proxyEnabled: false,
        },
        webdav: {}, promptSources: { sources: [], schedule: { intervalMinutes: 0, lastFetchedAt: "" } },
    };
    expect((await request.put("/api/config", { data: config })).status()).toBe(200);
    await page.addInitScript((selected) => localStorage.setItem("infinite-canvas:active-workspace", JSON.stringify(selected)), workspace);
    let imageSubmits = 0;
    let videoSubmits = 0;
    let videoPolls = 0;
    let failNextArchive = false;
    const worker = createGenerationWorker({
        resolveChannel: async (model) => ({ id: "ui-mock", baseUrl: "https://fixture.invalid/v1", apiKey: "FIXTURE-SECRET", apiFormat: "openai", model: model.split("::").at(-1)! }),
        provider: {
            submitImage: async () => { imageSubmits++; return [{ kind: "inline", dataUrl: imageUrl }]; },
            submitVideo: async () => { videoSubmits++; return { id: "ui-upstream-video", provider: "openai", model: "video-model", channelId: "ui-mock" }; },
            pollVideo: async () => { videoPolls++; return { status: "completed", output: { kind: "provider", path: "videos/ui-upstream-video/content" } }; },
            downloadOutput: async (_channel, descriptor) => {
                if (failNextArchive) { failNextArchive = false; throw new Error("Simulated archive interruption"); }
                return descriptor.kind === "inline" ? { bytes: png, mimeType: "image/png" } : { bytes: Buffer.from("simulated video bytes"), mimeType: "video/mp4" };
            },
        },
    });
    const posts: string[] = [];
    page.on("request", (sent) => { if (sent.method() === "POST" && new URL(sent.url()).pathname === "/api/generation-tasks") posts.push(sent.url()); });
    try {
        await page.goto("/image");
        await page.locator("#image-prompt").fill("UI image result survives reload");
        const imageCreated = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/generation-tasks" && response.request().method() === "POST");
        await page.getByRole("button", { name: "开始生成", exact: true }).click();
        expect((await imageCreated).status()).toBe(202);
        await expect.poll(async () => (await (await request.get("/api/generation-tasks?kind=image", { headers })).json()).items.length).toBe(1);
        await page.reload();
        await expect(page.getByRole("button", { name: /UI image res/ }).first()).toBeVisible();
        expect(posts).toHaveLength(1);
        await worker.tick();
        await expect.poll(async () => (await (await request.get("/api/generation-tasks?kind=image", { headers })).json()).items[0].status).toBe("succeeded");
        await page.reload();
        await expect(page.getByRole("button", { name: /UI image res/ }).first()).toBeVisible();
        const imageTask = (await (await request.get("/api/generation-tasks?kind=image", { headers })).json()).items[0];
        const imageMedia = await request.get(`/api/media/blob/${encodeURIComponent(imageTask.outputs[0].storageKey)}`, { headers });
        expect(await imageMedia.body()).toEqual(png);

        await page.goto("/video");
        await page.locator("#video-prompt").fill("UI video result survives reload");
        const videoCreated = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/generation-tasks" && response.request().method() === "POST");
        await page.getByRole("button", { name: "开始生成", exact: true }).click();
        expect((await videoCreated).status()).toBe(202);
        await expect.poll(async () => (await (await request.get("/api/generation-tasks?kind=video", { headers })).json()).items.length).toBe(1);
        await page.reload();
        await expect(page.getByRole("button", { name: /UI video res/ }).first()).toBeVisible();
        expect(posts).toHaveLength(2);
        await worker.tick();
        await expect.poll(async () => (await (await request.get("/api/generation-tasks?kind=video", { headers })).json()).items[0].status).toBe("succeeded");
        await page.reload();
        await expect(page.getByRole("button", { name: /UI video res/ }).first()).toBeVisible();
        const mcp = await page.evaluate(async (workspaceId) => {
            const { runSiteTool } = await import("/src/lib/agent/agent-site-tools.ts");
            return await runSiteTool("workbench_image_generate", { workspaceId, requestId: "mcp-image-recovery", prompt: "MCP persisted result", run: true }, (() => undefined) as Parameters<typeof runSiteTool>[2]) as any;
        }, workspace.id);
        expect(mcp).toMatchObject({ status: "accepted", workspaceId: workspace.id });
        failNextArchive = true;
        await worker.tick();
        await expect.poll(async () => (await (await request.get(`/api/generation-tasks/${mcp.taskId}`, { headers })).json()).task.errorCode).toBe("archive_failed");
        const resumed = await page.evaluate(async ({ workspaceId, taskId }) => {
            const { runSiteTool } = await import("/src/lib/agent/agent-site-tools.ts");
            return await runSiteTool("generation_resume_task", { workspaceId, taskId }, (() => undefined) as Parameters<typeof runSiteTool>[2]) as any;
        }, { workspaceId: workspace.id, taskId: mcp.taskId });
        expect(resumed.task.status).toBe("archiving");
        await worker.tick();
        await expect.poll(async () => (await (await request.get(`/api/generation-tasks/${mcp.taskId}`, { headers })).json()).task.status).toBe("succeeded");
        const mcpRead = await page.evaluate(async ({ workspaceId, taskId }) => {
            const { runSiteTool } = await import("/src/lib/agent/agent-site-tools.ts");
            const navigate = (() => undefined) as Parameters<typeof runSiteTool>[2];
            const status = await runSiteTool("generation_get_status", { workspaceId, taskId }, navigate) as any;
            const result = await runSiteTool("generation_get_result", { workspaceId, source: "image", id: taskId }, navigate) as any;
            return { status, result };
        }, { workspaceId: workspace.id, taskId: mcp.taskId });
        expect(mcpRead.status.tasks.some((task: { id: string; status: string }) => task.id === mcp.taskId && task.status === "succeeded")).toBe(true);
        expect(mcpRead.result.result.outputs[0].storageKey).toMatch(/^image:/);
        expect(JSON.stringify(mcpRead)).not.toMatch(/FIXTURE-SECRET|data:image\/png;base64/);
        expect((await request.delete(`/api/generation-tasks/${mcp.taskId}`, { headers })).status()).toBe(200);
        const hiddenResult = await page.evaluate(async ({ workspaceId, taskId }) => {
            const { runSiteTool } = await import("/src/lib/agent/agent-site-tools.ts");
            return await runSiteTool("generation_get_result", { workspaceId, source: "image", id: taskId }, (() => undefined) as Parameters<typeof runSiteTool>[2]) as any;
        }, { workspaceId: workspace.id, taskId: mcp.taskId });
        expect(hiddenResult.result.outputs[0].storageKey).toBe(mcpRead.result.result.outputs[0].storageKey);
        expect(imageSubmits).toBe(2);
        expect(videoSubmits).toBe(1);
        expect(videoPolls).toBe(1);
        expect(posts).toHaveLength(3);
    } finally { await worker.stop(); }
});
