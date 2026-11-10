import { test, expect } from "./auth";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");

test.beforeAll(() => {
    if (!/^\/infinite_canvas_e2e_[a-z0-9_]+$/.test(new URL(process.env.DATABASE_URL || "postgres://invalid/unsafe").pathname)) {
        throw new Error("Platform resource tools require an isolated E2E database");
    }
});

test("platform tools commit canvas, folders, assets and prompts across reload", async ({ page, request }) => {
    const { workspaces } = await (await request.get("/api/auth/me")).json();
    const workspace = workspaces[0];
    const headers = { "x-infinite-canvas-workspace": workspace.id };
    await page.addInitScript((selected) => localStorage.setItem("infinite-canvas:active-workspace", JSON.stringify(selected)), workspace);
    await page.goto("/canvas");
    await expect(page.getByRole("heading", { name: "我的画布" })).toBeVisible();
    await expect(page.getByRole("button", { name: "新建画布", exact: true }).first()).toBeEnabled();

    const created = await page.evaluate(async () => {
        const path = "/src/lib/agent/agent-site-tools.ts";
        const { runSiteTool } = await import(path);
        const formattersPath = "/src/components/agent/agent-event-formatters.ts";
        const { isCanvasWriteTool } = await import(formattersPath);
        const classified = {
            writes: ["canvas_create_project", "canvas_update_folder", "canvas_delete_folder", "prompts_create", "prompts_update", "prompts_delete", "assets_add", "assets_create", "assets_update", "assets_delete"].every(isCanvasWriteTool),
            reads: ["platform_get_context", "canvas_get_project", "canvas_list_folders", "prompts_get", "assets_get"].every((name) => !isCanvasWriteTool(name)),
        };
        const navigate = (() => undefined) as Parameters<typeof runSiteTool>[2];
        const context = await runSiteTool("platform_get_context", {}, navigate) as { workspace: { id: string } };
        const workspaceId = context.workspace.id;
        const call = async (name: Parameters<typeof runSiteTool>[0], input: Record<string, unknown>) =>
            await runSiteTool(name, { workspaceId, ...input }, navigate) as Record<string, any>;
        const parent = await call("canvas_create_folder", { title: "Parent" });
        const child = await call("canvas_create_folder", { title: "Child", parentId: parent.id });
        const project = await call("canvas_create_project", { title: "Initial", folderId: child.id });
        const renamed = await call("canvas_update_project", { projectId: project.id, title: "Renamed", description: "Saved by Agent" });
        const asset = await call("assets_create", { kind: "text", title: "Note", content: "First" });
        const updatedAsset = await call("assets_update", { assetId: asset.id, title: "Updated Note", content: "Second" });
        const prompt = await call("prompts_create", { title: "Prompt", prompt: "Original prompt", tags: ["e2e"] });
        const updatedPrompt = await call("prompts_update", { id: prompt.item.id, prompt: "Updated prompt" });
        return { workspaceId, parent, child, project, renamed, asset, updatedAsset, prompt, updatedPrompt, classified };
    });

    expect(created.workspaceId).toBe(workspace.id);
    expect(created.classified).toEqual({ writes: true, reads: true });
    for (const result of [created.parent, created.child, created.project, created.renamed, created.asset, created.updatedAsset, created.prompt, created.updatedPrompt]) {
        expect(result.status).toBe("committed");
    }
    expect(created.renamed.revision).toBeGreaterThan(created.project.revision);
    expect(created.updatedAsset.revision).toBeGreaterThan(created.asset.revision);
    expect(created.updatedPrompt.item.revision).not.toBe(created.prompt.item.revision);

    const canvas = await (await request.get("/api/data/canvas", { headers })).json();
    const assets = await (await request.get("/api/data/assets", { headers })).json();
    const prompts = await (await request.get("/api/prompts", { headers })).json();
    expect(canvas.revision).toBe(created.renamed.revision);
    expect(canvas.payload.state.projects.find((item: { id: string }) => item.id === created.project.id)).toMatchObject({ title: "Renamed", description: "Saved by Agent", folderId: created.child.id });
    expect(assets.revision).toBe(created.updatedAsset.revision);
    expect(assets.payload.state.assets.find((item: { id: string }) => item.id === created.asset.id)).toMatchObject({ title: "Updated Note", data: { content: "Second" } });
    expect(prompts.items.find((item: { id: string }) => item.id === created.prompt.item.id)).toMatchObject({ prompt: "Updated prompt" });

    await page.reload();
    await expect(page.getByRole("heading", { name: "我的画布" })).toBeVisible();
    await expect(page.getByRole("button", { name: "新建画布", exact: true }).first()).toBeEnabled();
    const restored = await page.evaluate(async ({ workspaceId, projectId, assetId, promptId }) => {
        const path = "/src/lib/agent/agent-site-tools.ts";
        const { runSiteTool } = await import(path);
        const navigate = (() => undefined) as Parameters<typeof runSiteTool>[2];
        const project = await runSiteTool("canvas_get_project", { workspaceId, projectId }, navigate) as any;
        const asset = await runSiteTool("assets_get", { workspaceId, assetId }, navigate) as any;
        const prompt = await runSiteTool("prompts_get", { workspaceId, id: promptId }, navigate) as any;
        return { project: project.project.title, asset: asset.asset.data.content, prompt: prompt.item.prompt };
    }, { workspaceId: workspace.id, projectId: created.project.id, assetId: created.asset.id, promptId: created.prompt.item.id });
    expect(restored).toEqual({ project: "Renamed", asset: "Second", prompt: "Updated prompt" });

    const deleted = await page.evaluate(async ({ workspaceId, parentId, assetId, promptId }) => {
        const path = "/src/lib/agent/agent-site-tools.ts";
        const { runSiteTool } = await import(path);
        const navigate = (() => undefined) as Parameters<typeof runSiteTool>[2];
        const asset = await runSiteTool("assets_delete", { workspaceId, assetId }, navigate) as any;
        const prompt = await runSiteTool("prompts_delete", { workspaceId, id: promptId }, navigate) as any;
        const folder = await runSiteTool("canvas_delete_folder", { workspaceId, folderId: parentId }, navigate) as any;
        return { asset, prompt, folder };
    }, { workspaceId: workspace.id, parentId: created.parent.id, assetId: created.asset.id, promptId: created.prompt.item.id });
    expect(deleted.asset.status).toBe("committed");
    expect(deleted.prompt.status).toBe("committed");
    expect(deleted.folder).toMatchObject({ status: "committed", deletedFolderIds: [created.parent.id, created.child.id], deletedProjectIds: [created.project.id] });
    const finalCanvas = await (await request.get("/api/data/canvas", { headers })).json();
    const finalAssets = await (await request.get("/api/data/assets", { headers })).json();
    expect(finalCanvas.revision).toBe(deleted.folder.revision);
    expect(finalCanvas.payload.state.projects.some((item: { id: string }) => item.id === created.project.id)).toBe(false);
    expect(finalAssets.revision).toBe(deleted.asset.revision);
    expect(finalAssets.payload.state.assets.some((item: { id: string }) => item.id === created.asset.id)).toBe(false);
    expect((await (await request.get("/api/prompts", { headers })).json()).items.some((item: { id: string }) => item.id === created.prompt.item.id)).toBe(false);
});

test("image asset media persists through add, reload, update and delete", async ({ page, request }) => {
    const { workspaces } = await (await request.get("/api/auth/me")).json();
    const workspace = workspaces[0];
    const headers = { "x-infinite-canvas-workspace": workspace.id };
    const imageUrl = `data:image/png;base64,${png.toString("base64")}`;
    await page.addInitScript((selected) => localStorage.setItem("infinite-canvas:active-workspace", JSON.stringify(selected)), workspace);
    await page.goto("/assets");
    await expect(page.getByRole("heading", { name: "我的素材" })).toBeVisible();
    const created = await page.evaluate(async (dataUrl) => {
        const path = "/src/lib/agent/agent-site-tools.ts";
        const { runSiteTool } = await import(path);
        const navigate = (() => undefined) as Parameters<typeof runSiteTool>[2];
        const context = await runSiteTool("platform_get_context", {}, navigate) as { workspace: { id: string } };
        const workspaceId = context.workspace.id;
        const receipt = await runSiteTool("assets_add", { workspaceId, kind: "image", title: "Pixel", imageUrl: dataUrl }, navigate) as any;
        const detail = await runSiteTool("assets_get", { workspaceId, assetId: receipt.id }, navigate) as any;
        return { workspaceId, receipt, storageKey: detail.asset.data.storageKey };
    }, imageUrl);
    expect(created.receipt).toMatchObject({ status: "committed", workspaceId: workspace.id });
    expect(created.storageKey).toMatch(/^image:/);
    const storedMedia = await request.get(`/api/media/blob/${encodeURIComponent(created.storageKey)}`, { headers });
    expect(storedMedia.ok()).toBe(true);
    expect(await storedMedia.body()).toEqual(png);
    const assets = await (await request.get("/api/data/assets", { headers })).json();
    expect(assets.revision).toBe(created.receipt.revision);
    expect(assets.payload.state.assets.find((item: { id: string }) => item.id === created.receipt.id).data.storageKey).toBe(created.storageKey);

    await page.reload();
    await expect(page.getByRole("heading", { name: "我的素材" })).toBeVisible();
    const restored = await page.evaluate(async ({ workspaceId, assetId }) => {
        const path = "/src/lib/agent/agent-site-tools.ts";
        const { runSiteTool } = await import(path);
        const navigate = (() => undefined) as Parameters<typeof runSiteTool>[2];
        const detail = await runSiteTool("assets_get", { workspaceId, assetId }, navigate) as any;
        const response = await fetch(`/api/media/blob/${encodeURIComponent(detail.asset.data.storageKey)}`, { headers: { "x-infinite-canvas-workspace": workspaceId } });
        return { key: detail.asset.data.storageKey, bytes: Array.from(new Uint8Array(await response.arrayBuffer())), status: response.status };
    }, { workspaceId: workspace.id, assetId: created.receipt.id });
    expect(restored).toEqual({ key: created.storageKey, bytes: [...png], status: 200 });

    const updated = await page.evaluate(async ({ workspaceId, assetId, dataUrl }) => {
        const path = "/src/lib/agent/agent-site-tools.ts";
        const { runSiteTool } = await import(path);
        const navigate = (() => undefined) as Parameters<typeof runSiteTool>[2];
        return await runSiteTool("assets_update", { workspaceId, assetId, title: "Pixel updated", imageUrl: dataUrl }, navigate) as any;
    }, { workspaceId: workspace.id, assetId: created.receipt.id, dataUrl: imageUrl });
    expect(updated).toMatchObject({ status: "committed", id: created.receipt.id });
    expect(updated.revision).toBeGreaterThan(created.receipt.revision);
    const updatedAssets = await (await request.get("/api/data/assets", { headers })).json();
    expect(updatedAssets.payload.state.assets.find((item: { id: string }) => item.id === created.receipt.id).title).toBe("Pixel updated");
    expect(updatedAssets.revision).toBe(updated.revision);
    const deleted = await page.evaluate(async ({ workspaceId, assetId }) => {
        const path = "/src/lib/agent/agent-site-tools.ts";
        const { runSiteTool } = await import(path);
        return await runSiteTool("assets_delete", { workspaceId, assetId }, (() => undefined) as Parameters<typeof runSiteTool>[2]) as any;
    }, { workspaceId: workspace.id, assetId: created.receipt.id });
    expect(deleted.status).toBe("committed");
    expect((await (await request.get("/api/data/assets", { headers })).json()).payload.state.assets.some((item: { id: string }) => item.id === created.receipt.id)).toBe(false);
});

test("tabs keep independent workspace targets and canvas request headers", async ({ page, context, request }) => {
    const { workspaces } = await (await request.get("/api/auth/me")).json();
    const first = workspaces[0];
    const secondResponse = await request.post("/api/workspaces", { data: { name: "Second workspace" } });
    expect(secondResponse.ok()).toBe(true);
    const { workspace: second } = await secondResponse.json();
    await page.addInitScript((selected) => {
        if (sessionStorage.getItem("platform-test-seeded")) return;
        sessionStorage.setItem("platform-test-seeded", "1");
        localStorage.setItem("infinite-canvas:active-workspace", JSON.stringify(selected));
    }, first);
    await page.goto("/canvas");
    await expect(page.getByRole("heading", { name: "我的画布" })).toBeVisible();
    await expect(page.getByRole("button", { name: "新建画布", exact: true }).first()).toBeEnabled();
    const other = await context.newPage();
    try {
        await other.goto("/canvas");
        await expect(other.getByRole("heading", { name: "我的画布" })).toBeVisible();
        await expect(other.getByRole("button", { name: "新建画布", exact: true }).first()).toBeEnabled();
        await other.evaluate(async (workspace) => {
            const path = "/src/lib/workspace.ts";
            const { setActiveWorkspace } = await import(path);
            setActiveWorkspace(workspace);
        }, second);
        await other.reload();
        await expect(other.getByRole("heading", { name: "我的画布" })).toBeVisible();
        await expect(other.getByRole("button", { name: "新建画布", exact: true }).first()).toBeEnabled();
        await page.reload();
        await expect(page.getByRole("heading", { name: "我的画布" })).toBeVisible();
        await expect(page.getByRole("button", { name: "新建画布", exact: true }).first()).toBeEnabled();

        const seen = { first: [] as string[], second: [] as string[] };
        page.on("request", (sent) => { if (sent.method() === "PUT" && sent.url().includes("/api/data/canvas")) seen.first.push(sent.headers()["x-infinite-canvas-workspace"]); });
        other.on("request", (sent) => { if (sent.method() === "PUT" && sent.url().includes("/api/data/canvas")) seen.second.push(sent.headers()["x-infinite-canvas-workspace"]); });
        const addFolder = async (target: typeof page, title: string) => target.evaluate(async (name) => {
            const path = "/src/lib/agent/agent-site-tools.ts";
            const { runSiteTool } = await import(path);
            const navigate = (() => undefined) as Parameters<typeof runSiteTool>[2];
            const context = await runSiteTool("platform_get_context", {}, navigate) as { workspace: { id: string } };
            const result = await runSiteTool("canvas_create_folder", { workspaceId: context.workspace.id, title: name }, navigate) as any;
            return { workspaceId: context.workspace.id, result };
        }, title);
        const a = await addFolder(page, "Only A");
        const b = await addFolder(other, "Only B");
        expect(a).toMatchObject({ workspaceId: first.id, result: { status: "committed", workspaceId: first.id } });
        expect(b).toMatchObject({ workspaceId: second.id, result: { status: "committed", workspaceId: second.id } });
        expect(seen.first).toContain(first.id);
        expect(seen.second).toContain(second.id);
        expect(seen.first).not.toContain(second.id);
        expect(seen.second).not.toContain(first.id);
        const firstData = await (await request.get("/api/data/canvas", { headers: { "x-infinite-canvas-workspace": first.id } })).json();
        const secondData = await (await request.get("/api/data/canvas", { headers: { "x-infinite-canvas-workspace": second.id } })).json();
        expect(firstData.payload.state.folders.map((item: { id: string }) => item.id)).toContain(a.result.id);
        expect(firstData.payload.state.folders.map((item: { id: string }) => item.id)).not.toContain(b.result.id);
        expect(secondData.payload.state.folders.map((item: { id: string }) => item.id)).toContain(b.result.id);
        expect(secondData.payload.state.folders.map((item: { id: string }) => item.id)).not.toContain(a.result.id);
    } finally {
        await other.close();
    }
});
