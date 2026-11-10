import { test, expect } from "./auth";
import { execute, getPool } from "../src/server/db";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
const imageUrl = `data:image/png;base64,${png.toString("base64")}`;

test.beforeAll(() => {
    if (!/^\/infinite_canvas_e2e_[a-z0-9_]+$/.test(new URL(process.env.DATABASE_URL || "postgres://invalid/unsafe").pathname)
        || !process.env.S3_BUCKET?.startsWith("infinite-canvas-e2e-")
        || process.env.INFINITE_CANVAS_GENERATION_WORKER !== "off") throw new Error("Workbench regression requires isolated E2E storage and disabled worker");
});

test("script model stays in browser and durable history restores references", async ({ page, request }) => {
    const { workspaces } = await (await request.get("/api/auth/me")).json();
    const workspace = workspaces[0];
    const headers = { "x-infinite-canvas-workspace": workspace.id };
    const config = {
        app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(),
        config: {
            channels: [{ id: "regression", name: "Fixture", baseUrl: "https://fixture.invalid/v1", apiFormat: "openai", apiKey: "FIXTURE-SECRET", models: [
                { name: "script-image", capability: "image", script: `return [${JSON.stringify(imageUrl)}];` },
                { name: "script-video", capability: "video", script: "return new Blob([new Uint8Array([0, 0, 0, 0])], { type: 'video/mp4' });" },
                { name: "durable-image", capability: "image" }, { name: "durable-video", capability: "video" },
            ] }],
            model: "regression::script-image", imageModel: "regression::script-image", videoModel: "regression::script-video", models: ["regression::script-image", "regression::script-video", "regression::durable-image", "regression::durable-video"],
            size: "1024x1024", quality: "auto", count: "1", videoSeconds: "6", vquality: "720", proxyEnabled: false,
        }, webdav: {}, promptSources: { sources: [], schedule: { intervalMinutes: 0, lastFetchedAt: "" } },
    };
    expect((await request.put("/api/config", { data: config })).status()).toBe(200);
    await page.addInitScript((selected) => localStorage.setItem("infinite-canvas:active-workspace", JSON.stringify(selected)), workspace);
    const posts: unknown[] = [];
    page.on("request", (sent) => { if (sent.method() === "POST" && new URL(sent.url()).pathname === "/api/generation-tasks") posts.push(sent.postDataJSON()); });
    await page.goto("/image");
    await page.locator("#image-prompt").fill("Scripted image");
    await page.getByRole("button", { name: "开始生成", exact: true }).click();
    await expect(page.getByRole("button", { name: "下载原图" })).toBeVisible();
    expect(posts).toHaveLength(0);
    const scriptAudit = await page.evaluate(async (workspaceId) => {
        const { runSiteTool } = await import("/src/lib/agent/agent-site-tools.ts");
        const navigate = (() => undefined) as Parameters<typeof runSiteTool>[2];
        const input = { workspaceId, requestId: "script-regression-id", prompt: "MCP script image", model: "regression::script-image" };
        const accepted = await runSiteTool("workbench_image_generate", input, navigate) as any;
        const repeated = await runSiteTool("workbench_image_generate", input, navigate) as any;
        const status = await runSiteTool("generation_get_status", { workspaceId, taskId: accepted.taskId }, navigate) as any;
        const config = await runSiteTool("workbench_image_get_config", {}, navigate) as any;
        let conflict = "";
        try { await runSiteTool("workbench_image_generate", { ...input, prompt: "Changed prompt" }, navigate); }
        catch (error) { conflict = String(error); }
        let executionConflict = "";
        try { await runSiteTool("workbench_image_generate", { ...input, model: "regression::durable-image" }, navigate); }
        catch (error) { executionConflict = String(error); }
        let kindConflict = "";
        try { await runSiteTool("workbench_video_generate", { ...input, model: "regression::script-video" }, navigate); }
        catch (error) { kindConflict = String(error); }
        return { accepted, repeated, status, config, conflict, executionConflict, kindConflict };
    }, workspace.id);
    expect(scriptAudit.accepted).toMatchObject({ status: "accepted", execution: "browser", durable: false });
    expect(scriptAudit.repeated.taskId).toBe(scriptAudit.accepted.taskId);
    expect(scriptAudit.status.tasks[0]).toMatchObject({ id: scriptAudit.accepted.taskId, execution: "browser" });
    expect(scriptAudit.conflict).toContain("参数已变化");
    expect(scriptAudit.executionConflict).toContain("另一生成类型或执行方式");
    expect(scriptAudit.kindConflict).toContain("另一生成类型或执行方式");
    expect(scriptAudit.config.current).toMatchObject({ execution: "browser", durable: false });
    expect(scriptAudit.config.models.find((model: { value: string }) => model.value === "regression::durable-image")).toMatchObject({ execution: "server", durable: true });
    expect(posts).toHaveLength(0);

    const imageKey = `image:regression-${Date.now()}`;
    expect((await request.put(`/api/media/blob/${encodeURIComponent(imageKey)}`, { headers: { ...headers, "content-type": "image/png" }, data: png })).status()).toBe(200);
    const imageTask = await request.post("/api/generation-tasks", { headers, data: { requestId: `image-ref-${Date.now()}`, kind: "image", prompt: "Reference image history", model: "regression::durable-image", settings: { quality: "auto", size: "1024x1024", count: 1 }, references: [{ kind: "image", storageKey: imageKey, name: "reference.png", mimeType: "image/png" }] } });
    expect(imageTask.status()).toBe(202);
    await execute(await getPool(), "UPDATE generation_tasks SET status = 'failed' WHERE id = $1 AND workspace_id = $2", (await imageTask.json()).task.id, workspace.id);
    await page.reload();
    await expect(page.getByRole("button", { name: /Reference im/ }).first()).toBeVisible();
    await page.getByRole("button", { name: /Reference im/ }).first().click();
    await expect(page.getByRole("img", { name: "reference.png" })).toBeVisible();
    await expect(page.getByRole("button", { name: "开始生成", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "开始生成", exact: true }).click();
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toMatchObject({ references: [{ kind: "image", storageKey: imageKey }] });

    const videoKey = `video:regression-${Date.now()}`;
    const audioKey = `audio:regression-${Date.now()}`;
    expect((await request.put(`/api/media/blob/${encodeURIComponent(videoKey)}`, { headers: { ...headers, "content-type": "video/mp4" }, data: Buffer.from("video fixture") })).status()).toBe(200);
    expect((await request.put(`/api/media/blob/${encodeURIComponent(audioKey)}`, { headers: { ...headers, "content-type": "audio/mpeg" }, data: Buffer.from("audio fixture") })).status()).toBe(200);
    const videoTask = await request.post("/api/generation-tasks", { headers, data: { requestId: `video-ref-${Date.now()}`, kind: "video", prompt: "Reference media history", model: "regression::durable-video", settings: { size: "16:9", resolution: "720", seconds: "6", mode: "reference" }, references: [{ kind: "image", storageKey: imageKey, name: "reference.png", mimeType: "image/png" }, { kind: "video", storageKey: videoKey, name: "reference.mp4", mimeType: "video/mp4", width: 720, height: 1280, durationMs: 4000 }, { kind: "audio", storageKey: audioKey, name: "reference.mp3", mimeType: "audio/mpeg", durationMs: 3000 }] } });
    expect(videoTask.status()).toBe(202);
    await execute(await getPool(), "UPDATE generation_tasks SET status = 'failed' WHERE id = $1 AND workspace_id = $2", (await videoTask.json()).task.id, workspace.id);
    await page.goto("/video");
    await expect.poll(async () => page.evaluate(async () => {
        const { useConfigStore } = await import("/src/stores/use-config-store.ts");
        return useConfigStore.getState().config.channels.some((channel) => channel.models.some((model) => model.name === "script-video" && Boolean(model.script)));
    })).toBe(true);
    const videoAudit = await page.evaluate(async (workspaceId) => {
        const { runSiteTool } = await import("/src/lib/agent/agent-site-tools.ts");
        const navigate = (() => undefined) as Parameters<typeof runSiteTool>[2];
        const input = { workspaceId, requestId: "script-video-regression-id", prompt: "MCP script video", model: "regression::script-video" };
        const accepted = await runSiteTool("workbench_video_generate", input, navigate) as any;
        const repeated = await runSiteTool("workbench_video_generate", input, navigate) as any;
        let conflict = "";
        try { await runSiteTool("workbench_video_generate", { ...input, prompt: "Changed video" }, navigate); }
        catch (error) { conflict = String(error); }
        return { accepted, repeated, conflict };
    }, workspace.id);
    expect(videoAudit.accepted).toMatchObject({ status: "accepted", execution: "browser", durable: false });
    expect(videoAudit.repeated.taskId).toBe(videoAudit.accepted.taskId);
    expect(videoAudit.conflict).toContain("参数已变化");
    await expect(page.locator("video")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "开始生成", exact: true })).toBeEnabled();
    expect(posts).toHaveLength(1);
    await expect(page.getByRole("button", { name: /Reference me/ }).first()).toBeVisible();
    await page.getByRole("button", { name: /Reference me/ }).first().click();
    await expect(page.getByRole("img", { name: "reference.png" })).toBeVisible();
    await expect(page.locator("audio")).toHaveCount(1);
    await expect(page.locator("video")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "开始生成", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "开始生成", exact: true }).click();
    await expect.poll(() => posts.length).toBe(2);
    expect(posts[1]).toMatchObject({ references: [{ kind: "image", storageKey: imageKey }, { kind: "video", storageKey: videoKey }, { kind: "audio", storageKey: audioKey }] });
});
