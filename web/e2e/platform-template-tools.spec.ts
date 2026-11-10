import { test, expect } from "./auth";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");

test.beforeAll(() => {
    if (!/^\/infinite_canvas_e2e_[a-z0-9_]+$/.test(new URL(process.env.DATABASE_URL || "postgres://invalid/unsafe").pathname)) {
        throw new Error("Platform template tools require an isolated E2E database");
    }
});

test.afterEach(async ({ page }) => {
    if (page.isClosed()) return;
    await page.evaluate(async () => {
        const { getActiveWorkspace } = await import("/src/lib/workspace.ts");
        const { useCanvasStore, flushCanvasSave } = await import("/src/stores/canvas/use-canvas-store.ts");
        const workspaceId = getActiveWorkspace()?.id;
        if (workspaceId && useCanvasStore.getState().hydrated) await flushCanvasSave(workspaceId);
    });
});

test("template selection, update, instantiate, offline insert and delete commit", async ({ page, request }) => {
    const { workspaces } = await (await request.get("/api/auth/me")).json();
    const workspace = workspaces[0];
    const headers = { "x-infinite-canvas-workspace": workspace.id };
    await page.addInitScript((selected) => localStorage.setItem("infinite-canvas:active-workspace", JSON.stringify(selected)), workspace);
    await page.goto("/canvas");
    await expect(page.getByRole("heading", { name: "我的画布" })).toBeVisible();

    const result = await page.evaluate(async (workspaceId) => {
        const { runSiteTool } = await import("/src/lib/agent/agent-site-tools.ts");
        const { useCanvasStore, flushCanvasSave } = await import("/src/stores/canvas/use-canvas-store.ts");
        const navigate = (() => undefined) as Parameters<typeof runSiteTool>[2];
        const call = async (name: Parameters<typeof runSiteTool>[0], input: Record<string, unknown>) =>
            await runSiteTool(name, { workspaceId, ...input }, navigate) as Record<string, any>;
        const source = await call("canvas_create_project", { title: "Template source" });
        const target = await call("canvas_create_project", { title: "Insert target" });
        const node = (id: string, x: number) => ({ id, type: "text", title: id, position: { x, y: 20 }, width: 200, height: 160, metadata: { content: id } });
        useCanvasStore.setState((state) => ({ projects: state.projects.map((item) => item.id === source.id ? {
            ...item, nodes: [node("selected", 10), node("excluded", 310)], connections: [],
        } : item) }));
        await flushCanvasSave(workspaceId);
        const created = await call("templates_create", { projectId: source.id, title: "Selected template", selectionNodeIds: ["selected"] });
        const detail = await call("templates_get", { templateId: created.templateId });
        const updated = await call("templates_update", { templateId: created.templateId, title: "Renamed template", description: "Updated by agent" });
        const instance = await call("templates_instantiate", { templateId: created.templateId, title: "Template instance" });
        const inserted = await call("templates_insert", { templateId: created.templateId, projectId: target.id, center: { x: 1000, y: 500 } });
        const listed = await call("templates_list", {});
        return { source, target, created, detail, updated, instance, inserted, listed };
    }, workspace.id);

    for (const receipt of [result.created, result.updated, result.instance, result.inserted]) {
        expect(receipt).toMatchObject({ status: "committed", workspaceId: workspace.id });
        expect(receipt.revision).toBeDefined();
    }
    expect(result.created.templateId).toBeTruthy();
    expect(result.detail.template.content.nodes.map((node: { title: string }) => node.title)).toEqual(["selected"]);
    expect(result.listed.items.some((item: { id: string }) => item.id === result.created.templateId)).toBe(true);

    const templates = await (await request.get("/api/data/canvas-templates", { headers })).json();
    expect(templates.revision).toBe(result.updated.revision);
    expect(templates.payload.templates.find((item: { id: string }) => item.id === result.created.templateId)).toMatchObject({ title: "Renamed template", description: "Updated by agent" });
    const canvas = await (await request.get("/api/data/canvas", { headers })).json();
    expect(canvas.revision).toBe(result.inserted.revision);
    const source = canvas.payload.state.projects.find((item: { id: string }) => item.id === result.source.id);
    const instance = canvas.payload.state.projects.find((item: { id: string }) => item.id === result.instance.projectId);
    const target = canvas.payload.state.projects.find((item: { id: string }) => item.id === result.target.id);
    expect(source.nodes.map((node: { id: string }) => node.id)).toEqual(["selected", "excluded"]);
    expect(instance.nodes).toHaveLength(1);
    expect(instance.nodes[0].id).not.toBe("selected");
    expect(target.nodes).toHaveLength(1);
    expect(target.nodes[0].id).not.toBe(instance.nodes[0].id);

    const denied = await page.evaluate(async ({ workspace, templateId }) => {
        const { setActiveWorkspace } = await import("/src/lib/workspace.ts");
        const { runSiteTool } = await import("/src/lib/agent/agent-site-tools.ts");
        setActiveWorkspace({ ...workspace, role: "viewer" });
        try {
            await runSiteTool("templates_delete", { workspaceId: workspace.id, templateId }, (() => undefined) as Parameters<typeof runSiteTool>[2]);
            return "unexpected success";
        } catch (error) {
            return String(error);
        } finally {
            setActiveWorkspace(workspace);
        }
    }, { workspace, templateId: result.created.templateId });
    expect(denied).not.toBe("unexpected success");
    const afterDenied = await (await request.get("/api/data/canvas-templates", { headers })).json();
    expect(afterDenied.revision).toBe(result.updated.revision);

    await page.reload();
    await expect(page.getByRole("heading", { name: "我的画布" })).toBeVisible();
    const removed = await page.evaluate(async ({ workspaceId, templateId }) => {
        const { runSiteTool } = await import("/src/lib/agent/agent-site-tools.ts");
        return await runSiteTool("templates_delete", { workspaceId, templateId }, (() => undefined) as Parameters<typeof runSiteTool>[2]);
    }, { workspaceId: workspace.id, templateId: result.created.templateId }) as Record<string, any>;
    expect(removed).toMatchObject({ status: "committed", workspaceId: workspace.id });
    const after = await (await request.get("/api/data/canvas-templates", { headers })).json();
    expect(after.revision).toBe(removed.revision);
    expect(after.payload.templates.some((item: { id: string }) => item.id === result.created.templateId)).toBe(false);
});

test("inserting into the open editor survives reload", async ({ page, request }) => {
    const { workspaces } = await (await request.get("/api/auth/me")).json();
    const workspace = workspaces[0];
    await page.addInitScript((selected) => localStorage.setItem("infinite-canvas:active-workspace", JSON.stringify(selected)), workspace);
    await page.goto("/canvas");
    await expect(page.getByRole("heading", { name: "我的画布" })).toBeVisible();
    const setup = await page.evaluate(async (workspaceId) => {
        const { runSiteTool } = await import("/src/lib/agent/agent-site-tools.ts");
        const { useCanvasStore, flushCanvasSave } = await import("/src/stores/canvas/use-canvas-store.ts");
        const navigate = (() => undefined) as Parameters<typeof runSiteTool>[2];
        const source = await runSiteTool("canvas_create_project", { workspaceId, title: "Live source" }, navigate) as any;
        const target = await runSiteTool("canvas_create_project", { workspaceId, title: "Live target" }, navigate) as any;
        useCanvasStore.setState((state) => ({ projects: state.projects.map((item) => item.id === source.id ? {
            ...item, nodes: [{ id: "live-source-node", type: "text", title: "Live inserted node", position: { x: 40, y: 50 }, width: 200, height: 160, metadata: { content: "persist me" } }],
        } : item) }));
        await flushCanvasSave(workspaceId);
        const template = await runSiteTool("templates_create", { workspaceId, projectId: source.id, title: "Live template" }, navigate) as any;
        return { targetId: target.id, templateId: template.templateId };
    }, workspace.id);
    await page.goto(`/canvas/${encodeURIComponent(setup.targetId)}`);
    await expect.poll(async () => page.evaluate(async () => {
        const { useAgentStore } = await import("/src/stores/use-agent-store.ts");
        return Boolean(useAgentStore.getState().canvasContext?.templateCanvas);
    })).toBe(true);
    const receipt = await page.evaluate(async ({ workspaceId, templateId, projectId }) => {
        const { runSiteTool } = await import("/src/lib/agent/agent-site-tools.ts");
        const { useAgentStore } = await import("/src/stores/use-agent-store.ts");
        const templateCanvas = useAgentStore.getState().canvasContext?.templateCanvas;
        if (!templateCanvas) throw new Error("Live editor bridge unavailable");
        return await runSiteTool("templates_insert", { workspaceId, templateId, projectId }, (() => undefined) as Parameters<typeof runSiteTool>[2], { templateCanvas });
    }, { workspaceId: workspace.id, templateId: setup.templateId, projectId: setup.targetId }) as Record<string, any>;
    expect(receipt).toMatchObject({ status: "committed", workspaceId: workspace.id });
    await page.reload();
    await expect.poll(async () => page.evaluate(async (projectId) => {
        const { useCanvasStore } = await import("/src/stores/canvas/use-canvas-store.ts");
        return useCanvasStore.getState().projects.find((item) => item.id === projectId)?.nodes.some((node) => node.title === "Live inserted node");
    }, setup.targetId)).toBe(true);
});

test("template package copies image bytes and rejects malformed or foreign targets without commit", async ({ page, request }) => {
    const { workspaces } = await (await request.get("/api/auth/me")).json();
    const workspace = workspaces[0];
    const headers = { "x-infinite-canvas-workspace": workspace.id };
    await page.addInitScript((selected) => localStorage.setItem("infinite-canvas:active-workspace", JSON.stringify(selected)), workspace);
    await page.goto("/canvas");
    await expect(page.getByRole("heading", { name: "我的画布" })).toBeVisible();
    const result = await page.evaluate(async ({ workspaceId, imageUrl }) => {
        const { runSiteTool } = await import("/src/lib/agent/agent-site-tools.ts");
        const { useCanvasStore, flushCanvasSave } = await import("/src/stores/canvas/use-canvas-store.ts");
        const navigate = (() => undefined) as Parameters<typeof runSiteTool>[2];
        const call = async (name: Parameters<typeof runSiteTool>[0], input: Record<string, unknown>) =>
            await runSiteTool(name, { workspaceId, ...input }, navigate) as Record<string, any>;
        const importedMedia = await call("media_import", { kind: "image", dataUrl: imageUrl });
        const { saveWorkspaceData } = await import("/src/services/workspace-data.ts");
        await saveWorkspaceData("image-workbench", { logs: [{ id: "saved-image", createdAt: 1234, title: "Image history", prompt: "A pixel", status: "success", model: "fixture", config: { apiKey: "SECRET-DO-NOT-RETURN" }, url: "https://private.invalid/result", images: [{ id: "image-output", storageKey: importedMedia.storageKey, mimeType: "image/png", bytes: 68, width: 1, height: 1, dataUrl: imageUrl }] }] });
        await saveWorkspaceData("video-workbench", { logs: [{ id: "saved-video", createdAt: 1235, title: "Video history", prompt: "Pending video", status: "pending", model: "fixture", config: { apiKey: "VIDEO-SECRET" }, task: { id: "private-task" } }] });
        const listedResults = await call("generation_list_results", { source: "all" });
        const imageResult = await call("generation_get_result", { source: "image", id: "saved-image" });
        const videoResult = await call("generation_get_result", { source: "video", id: "saved-video" });
        const asset = await call("assets_create", { kind: "image", title: "Imported pixel", storageKey: imageResult.result.outputs[0].storageKey });
        const assetDetail = await call("assets_get", { assetId: asset.id });
        const source = await call("canvas_create_project", { title: "Image source" });
        useCanvasStore.setState((state) => ({ projects: state.projects.map((item) => item.id === source.id ? {
            ...item, nodes: [
                { id: "image-node", type: "image", title: "Shared image", position: { x: 10, y: 20 }, width: 200, height: 160, metadata: { storageKey: importedMedia.storageKey, content: importedMedia.storageKey, status: "success", mimeType: "image/png", bytes: 68 } },
                { id: "config-node", type: "config", title: "Reference", position: { x: 310, y: 20 }, width: 200, height: 160, metadata: { references: [importedMedia.storageKey] } },
            ], connections: [{ id: "link", fromNodeId: "image-node", toNodeId: "config-node" }],
        } : item) }));
        await flushCanvasSave(workspaceId);
        const created = await call("templates_create", { projectId: source.id, title: "Image template" });
        const sourceDetail = await call("templates_get", { templateId: created.templateId });
        const exported = await call("templates_export", { templateId: created.templateId });
        const packageText = JSON.stringify(exported.package);
        const before = await call("templates_list", {});
        const broken = structuredClone(exported.package);
        broken.template.content.nodes[0].metadata.storageKey = "image:foreign";
        let invalidError = "";
        try { await call("templates_import", { package: broken }); } catch (error) { invalidError = String(error); }
        let foreignError = "";
        try { await runSiteTool("templates_import", { workspaceId: "other-workspace", package: exported.package }, navigate); } catch (error) { foreignError = String(error); }
        const afterFailure = await call("templates_list", {});
        const imported = await call("templates_import", { package: exported.package });
        const importedDetail = await call("templates_get", { templateId: imported.templateId });
        const instance = await call("templates_instantiate", { templateId: imported.templateId, title: "Imported image canvas" });
        const originalMedia = await call("media_get", { storageKey: importedMedia.storageKey });
        const copiedMedia = await call("media_get", { storageKey: importedDetail.template.content.nodes[0].metadata.storageKey });
        return { importedMedia, listedResults, imageResult, videoResult, asset, assetDetail, created, sourceDetail, exported, packageText, before, afterFailure, invalidError, foreignError, imported, importedDetail, instance, originalMedia, copiedMedia };
    }, { workspaceId: workspace.id, imageUrl: `data:image/png;base64,${png.toString("base64")}` });

    expect(result.importedMedia).toMatchObject({ status: "stored", workspaceId: workspace.id });
    expect(result.listedResults.total).toBe(2);
    expect(result.imageResult.result.outputs[0]).toMatchObject({ available: true, storageKey: result.importedMedia.storageKey, bytes: png.length });
    expect(result.videoResult.result).toMatchObject({ status: "pending", storedOutputCount: 0 });
    for (const response of [result.listedResults, result.imageResult, result.videoResult]) {
        expect(JSON.stringify(response)).not.toMatch(/SECRET|private\.invalid|private-task|data:image\/png;base64/);
    }
    expect(result.asset).toMatchObject({ status: "committed", workspaceId: workspace.id });
    const assetKey = result.assetDetail.asset.data.storageKey;
    expect(assetKey).toMatch(/^image:/);
    expect(assetKey).not.toBe(result.importedMedia.storageKey);
    expect(result.created).toMatchObject({ status: "committed", workspaceId: workspace.id });
    expect(result.invalidError).toBeTruthy();
    expect(result.foreignError).toBeTruthy();
    expect(result.afterFailure.total).toBe(result.before.total);
    expect(result.exported.package).toMatchObject({ format: "infinite-canvas-template", version: 1 });
    expect(result.exported.package.media).toHaveLength(2); // one cover, one shared image referenced twice
    expect(result.packageText).not.toContain(result.importedMedia.storageKey);
    expect(result.packageText).not.toContain(result.sourceDetail.template.content.nodes[0].metadata.storageKey);
    expect(result.packageText).not.toContain(workspace.id);
    expect(result.imported).toMatchObject({ status: "committed", workspaceId: workspace.id });
    expect(result.imported.templateId).not.toBe(result.created.templateId);
    expect(result.instance).toMatchObject({ status: "committed", workspaceId: workspace.id });
    const oldKey = result.sourceDetail.template.content.nodes[0].metadata.storageKey;
    const newKey = result.importedDetail.template.content.nodes[0].metadata.storageKey;
    expect(newKey).not.toBe(oldKey);
    expect(newKey).not.toBe(result.importedMedia.storageKey);
    expect(result.importedDetail.template.content.nodes[1].metadata.references).toEqual([newKey]);
    expect(result.originalMedia.bytes).toBe(png.length);
    expect(result.copiedMedia.bytes).toBe(png.length);
    for (const key of [result.importedMedia.storageKey, assetKey, oldKey, newKey]) {
        const media = await request.get(`/api/media/blob/${encodeURIComponent(key)}`, { headers });
        expect(media.ok()).toBe(true);
        expect(await media.body()).toEqual(png);
    }
    const persisted = await (await request.get("/api/data/canvas-templates", { headers })).json();
    expect(persisted.revision).toBe(result.imported.revision);
    expect(persisted.payload.templates.some((item: { id: string }) => item.id === result.imported.templateId)).toBe(true);
    const canvas = await (await request.get("/api/data/canvas", { headers })).json();
    const instantiated = canvas.payload.state.projects.find((item: { id: string }) => item.id === result.instance.projectId);
    expect(instantiated.nodes).toHaveLength(2);
    const instantiatedKey = instantiated.nodes[0].metadata.storageKey;
    expect(instantiatedKey).not.toBe(newKey);
    expect(instantiated.nodes[1].metadata.references).toEqual([instantiatedKey]);
    const instanceMedia = await request.get(`/api/media/blob/${encodeURIComponent(instantiatedKey)}`, { headers });
    expect(instanceMedia.ok()).toBe(true);
    expect(await instanceMedia.body()).toEqual(png);
});

test("required template text and image inputs remap references without changing source", async ({ page, request }) => {
    const { workspaces } = await (await request.get("/api/auth/me")).json();
    const workspace = workspaces[0];
    const headers = { "x-infinite-canvas-workspace": workspace.id };
    await page.addInitScript((selected) => localStorage.setItem("infinite-canvas:active-workspace", JSON.stringify(selected)), workspace);
    await page.goto("/canvas");
    await expect(page.getByRole("heading", { name: "我的画布" })).toBeVisible();

    const result = await page.evaluate(async ({ workspaceId, imageUrl }) => {
        const { runSiteTool } = await import("/src/lib/agent/agent-site-tools.ts");
        const { useCanvasStore, flushCanvasSave } = await import("/src/stores/canvas/use-canvas-store.ts");
        const navigate = (() => undefined) as Parameters<typeof runSiteTool>[2];
        const call = async (name: Parameters<typeof runSiteTool>[0], input: Record<string, unknown>) =>
            await runSiteTool(name, { workspaceId, ...input }, navigate) as Record<string, any>;
        const image = await call("media_import", { kind: "image", dataUrl: imageUrl });
        const source = await call("canvas_create_project", { title: "Input source" });
        useCanvasStore.setState((state) => ({ projects: state.projects.map((item) => item.id === source.id ? {
            ...item, nodes: [
                { id: "source-text", type: "text", title: "Source text", position: { x: 10, y: 10 }, width: 200, height: 160, metadata: { content: "Original text" } },
                { id: "source-image", type: "image", title: "Source image", position: { x: 220, y: 10 }, width: 200, height: 160, metadata: { storageKey: image.storageKey, content: image.storageKey, status: "success", mimeType: "image/png", bytes: image.bytes } },
                { id: "source-config", type: "config", title: "Source config", position: { x: 430, y: 10 }, width: 200, height: 160, metadata: { references: [image.storageKey] } },
            ], connections: [{ id: "source-link", fromNodeId: "source-image", toNodeId: "source-config" }],
        } : item) }));
        await flushCanvasSave(workspaceId);
        const template = await call("templates_create", {
            projectId: source.id, title: "Required inputs",
            inputSlots: {
                "source-text": { name: "Copy", description: "Text input", required: true },
                "source-image": { name: "Photo", description: "Image input", required: true },
            },
        });
        const detail = await call("templates_get", { templateId: template.templateId });
        const slots = detail.template.content.nodes.filter((node: any) => node.metadata?.templateInput);
        const textId = slots.find((node: any) => node.type === "text")?.id;
        const imageId = slots.find((node: any) => node.type === "image")?.id;
        let missingError = "";
        try { await call("templates_instantiate", { templateId: template.templateId }); } catch (error) { missingError = String(error); }
        const completed = await call("templates_instantiate", {
            templateId: template.templateId, title: "Filled inputs",
            inputs: {
                [textId]: "Filled text",
                [imageId]: { storageKey: image.storageKey, naturalWidth: image.width, naturalHeight: image.height, bytes: image.bytes, mimeType: image.mimeType },
            },
        });
        return { image, source, template, detail, textId, imageId, missingError, completed };
    }, { workspaceId: workspace.id, imageUrl: `data:image/png;base64,${png.toString("base64")}` });

    expect(result.textId).toBeTruthy();
    expect(result.imageId).toBeTruthy();
    expect(result.missingError).toBeTruthy();
    expect(result.completed).toMatchObject({ status: "committed", workspaceId: workspace.id });
    const canvas = await (await request.get("/api/data/canvas", { headers })).json();
    expect(canvas.revision).toBe(result.completed.revision);
    const original = canvas.payload.state.projects.find((item: { id: string }) => item.id === result.source.id);
    const instance = canvas.payload.state.projects.find((item: { id: string }) => item.id === result.completed.projectId);
    expect(original.nodes.find((node: { id: string }) => node.id === "source-text").metadata.content).toBe("Original text");
    expect(original.nodes.find((node: { id: string }) => node.id === "source-image").metadata.storageKey).toBe(result.image.storageKey);
    const textNode = instance.nodes.find((node: { type: string }) => node.type === "text");
    const imageNode = instance.nodes.find((node: { type: string }) => node.type === "image");
    const configNode = instance.nodes.find((node: { type: string }) => node.type === "config");
    expect(textNode.metadata.content).toBe("Filled text");
    expect(imageNode.metadata.storageKey).toMatch(/^image:/);
    expect(imageNode.metadata.storageKey).not.toBe(result.image.storageKey);
    expect(configNode.metadata.references).toEqual([imageNode.metadata.storageKey]);
    expect(JSON.stringify(instance.nodes)).not.toContain("template-input:");
    const copied = await request.get(`/api/media/blob/${encodeURIComponent(imageNode.metadata.storageKey)}`, { headers });
    expect(copied.ok()).toBe(true);
    expect(await copied.body()).toEqual(png);
});
