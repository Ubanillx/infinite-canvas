import { randomUUID } from "node:crypto";
import { type APIRequestContext, type Page } from "@playwright/test";
import { test, expect } from "./auth";

import type { CanvasProject } from "../src/stores/canvas/use-canvas-store";
import { CanvasNodeType } from "../src/types/canvas";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
const imageKey = "image:template_fixture";
const coverKey = "image:cover_fixture";
const chatKey = "image:chat_fixture";

test.afterEach(async ({ page }) => {
    // Stop viewport timers, then let the existing autosave debounce finish before disposal.
    await navigate(page, "/canvas");
    await page.waitForTimeout(750);
    await expect(page.getByRole("heading", { name: /^(我的画布|My Canvases)$/ })).toBeVisible();
});

function project(id: string, media = false): CanvasProject {
    const now = new Date().toISOString();
    return {
        id, title: id, folderId: null, createdAt: now, updatedAt: now,
        nodes: [{ id: `${id}-node`, type: media ? CanvasNodeType.Image : CanvasNodeType.Text, title: id, position: { x: 100, y: 100 }, width: 240, height: 180, metadata: { content: media ? imageKey : id, ...(media ? { storageKey: imageKey } : {}) } }],
        connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 },
    };
}

async function seed(request: APIRequestContext, page: Page) {
    const response = await request.post("/api/workspaces", { data: { name: `restore-${randomUUID()}` } });
    expect(response.ok()).toBeTruthy();
    const { workspace } = await response.json();
    const headers = { "x-infinite-canvas-workspace": workspace.id };
    for (const key of [imageKey, coverKey, chatKey]) {
        expect((await request.put(`/api/media/blob/${encodeURIComponent(key)}`, { headers: { ...headers, "content-type": "image/png" }, data: png })).ok()).toBeTruthy();
    }
    const source = project("source");
    source.chatSessions = [{ id: "source-chat", title: "Private source chat", messages: [], createdAt: source.createdAt, updatedAt: source.updatedAt }];
    source.activeChatId = "source-chat";
    const delayed = project("delayed", true);
    delayed.chatSessions = [{ id: "delayed-chat", title: "Delayed chat", messages: [{ id: "message", role: "user", text: "Private", references: [{ id: "reference", type: CanvasNodeType.Image, title: "Chat image", storageKey: chatKey }] }], createdAt: delayed.createdAt, updatedAt: delayed.updatedAt }];
    const projects = [source, delayed, project("latest")];
    const { nodes, connections, viewport, backgroundMode, showImageInfo } = project("template", true);
    const template = { id: "template", title: "Restore template", description: "Independent template", createdAt: source.createdAt, updatedAt: source.updatedAt, cover: { storageKey: coverKey }, content: { nodes, connections, viewport, backgroundMode, showImageInfo } };
    for (const [domain, payload] of [["canvas", { state: { projects, folders: [], deletedProjects: [] }, version: 0 }], ["canvas-templates", { version: 1, templates: [template] }]] as const) {
        expect((await request.put(`/api/data/${domain}`, { headers, data: { revision: 0, payload } })).ok()).toBeTruthy();
    }
    await page.addInitScript((active) => {
        localStorage.setItem("infinite-canvas:active-workspace", JSON.stringify(active));
        localStorage.setItem("infinite-canvas:known-workspaces", JSON.stringify([active]));
        localStorage.setItem("canvas-side-panel-open", "0");
    }, workspace);
    const read = async (id: string): Promise<CanvasProject> => {
        const response = await request.get("/api/data/canvas", { headers });
        expect(response.ok()).toBeTruthy();
        return (await response.json()).payload.state.projects.find((item: CanvasProject) => item.id === id);
    };
    await page.goto("/canvas/source");
    await expect(page.locator('[data-node-id="source-node"]').first()).toBeVisible();
    return { read, headers, template };
}

async function openInsert(page: Page) {
    await canvasMenu(page, "插入当前画布");
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "使用此模板", exact: true }).click();
    return dialog;
}

async function canvasMenu(page: Page, name: string) {
    const templateAction = ["整张画布另存为新模板", "选区保存为模板", "更新已有模板", "插入当前画布"].includes(name);
    await page.getByRole("button", { name: templateAction ? "模板操作" : "打开画布菜单", exact: true }).click();
    await page.getByRole("menuitem", { name: new RegExp(`^${name}`) }).click();
}

test("template actions and canvas menu stay reachable with both panel states and languages", async ({ page, request }) => {
    await seed(request, page);
    for (const english of [false, true]) {
        if (english) await page.getByRole("button", { name: "切换到 English", exact: true }).click();
        for (const expanded of [false, true]) {
            if (expanded) await page.getByRole("button", { name: english ? "Expand panel" : "展开面板", exact: true }).click();
            await page.getByRole("button", { name: english ? "Open canvas menu" : "打开画布菜单", exact: true }).click();
            await expect(page.getByRole("menuitem", { name: english ? "New canvas" : "新建画布", exact: true })).toBeVisible();
            await page.getByRole("button", { name: english ? "Open canvas menu" : "打开画布菜单", exact: true }).click();
            await expect(page.getByRole("menuitem", { name: english ? "New canvas" : "新建画布", exact: true })).not.toBeVisible();
            await page.getByRole("button", { name: english ? "Template actions" : "模板操作", exact: true }).click();
            await expect(page.getByRole("menuitem", { name: english ? "Save canvas as new template" : "整张画布另存为新模板", exact: true })).toBeVisible();
            await page.getByRole("button", { name: english ? "Template actions" : "模板操作", exact: true }).click();
            await expect(page.getByRole("menuitem", { name: english ? "Save canvas as new template" : "整张画布另存为新模板", exact: true })).not.toBeVisible();
            if (expanded) {
                await page.getByRole("button", { name: english ? "Assets" : "资产", exact: true }).click();
                await page.getByRole("button", { name: english ? "Canvas" : "画布", exact: true }).click();
                await page.screenshot({ path: test.info().outputPath(english ? "toolbar-expanded-en.png" : "toolbar-expanded-zh.png") });
            }
        }
        await page.getByRole("button", { name: english ? "Collapse panel" : "收起面板", exact: true }).click();
    }
});

test("template save failure preserves drafts and retries one durable media snapshot", async ({ page, request }) => {
    const { headers, read } = await seed(request, page);
    await navigate(page, "/canvas/delayed");
    await expect(page.locator('[data-node-id="delayed-node"]').first()).toBeVisible();
    const before = await read("delayed");
    const readTemplates = async () => (await (await request.get("/api/data/canvas-templates", { headers })).json()).payload.templates;
    let fail = true;
    let writes = 0;
    let generations = 0;
    page.on("request", (request) => { if (/\/api\/ai\//.test(request.url()) && request.method() === "POST") generations += 1; });
    await page.route("**/api/data/canvas-templates", async (route) => {
        if (route.request().method() === "PUT") {
            writes += 1;
            if (fail) return route.fulfill({ status: 503, json: { error: "Template save temporarily unavailable" } });
        }
        await route.continue();
    });
    await canvasMenu(page, "整张画布另存为新模板");
    const dialog = page.getByRole("dialog", { name: "保存为模板", exact: true });
    const name = dialog.getByRole("textbox", { name: /模板名称/ });
    const description = dialog.getByRole("textbox", { name: /描述/ });
    const save = dialog.getByRole("button", { name: "保存模板", exact: true });
    await name.fill(" ");
    await save.click();
    await expect(dialog).toContainText("请输入模板名称");
    expect(writes).toBe(0);
    await name.fill("Retry snapshot");
    await description.fill("Draft survives a failed server write");
    await save.click();
    await expect(dialog.getByRole("alert")).toContainText("Template save temporarily unavailable");
    await expect(name).toHaveValue("Retry snapshot");
    await expect(description).toHaveValue("Draft survives a failed server write");
    expect((await readTemplates()).filter((item: { title: string }) => item.title === "Retry snapshot")).toHaveLength(0);
    fail = false;
    await save.click();
    await expect(dialog).not.toBeVisible();
    const saved = (await readTemplates()).filter((item: { title: string }) => item.title === "Retry snapshot");
    expect(saved).toHaveLength(1);
    expect(writes).toBe(2);
    expect(saved[0].content.nodes[0].metadata.storageKey).not.toBe(imageKey);
    expect(saved[0].content.chatSessions).toBeUndefined();
    const media = await request.get(`/api/media/blob/${encodeURIComponent(saved[0].content.nodes[0].metadata.storageKey)}`, { headers });
    expect(await media.body()).toEqual(png);
    const source = await read("delayed");
    // Hydration resolves content to a browser URL; graph geometry and durable media stay unchanged.
    expect(source.nodes).toMatchObject(before.nodes.map(({ metadata, ...node }) => ({ ...node, metadata: { storageKey: metadata!.storageKey } })));
    expect(await (await request.get(`/api/media/blob/${encodeURIComponent(imageKey)}`, { headers })).body()).toEqual(png);
    expect(generations).toBe(0);
    await navigate(page, "/templates");
    await page.reload();
    await expect(page.getByRole("heading", { name: "Retry snapshot", exact: true })).toBeVisible();
});

test("template save reports corrupt image media and retries after repair", async ({ page, request }) => {
    const { headers } = await seed(request, page);
    expect((await request.put(`/api/media/blob/${encodeURIComponent(imageKey)}`, { headers: { ...headers, "content-type": "image/png" }, data: Buffer.from("corrupt image") })).ok()).toBeTruthy();
    await navigate(page, "/canvas/delayed");
    await expect(page.locator('[data-node-id="delayed-node"]').first()).toBeVisible();
    await canvasMenu(page, "整张画布另存为新模板");
    const dialog = page.getByRole("dialog", { name: "保存为模板", exact: true });
    await dialog.getByRole("textbox", { name: /模板名称/ }).fill("Repaired snapshot");
    await dialog.getByRole("button", { name: "保存模板", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("图片素材无法读取");
    const readTemplates = async () => (await (await request.get("/api/data/canvas-templates", { headers })).json()).payload.templates;
    expect((await readTemplates()).some((item: { title: string }) => item.title === "Repaired snapshot")).toBe(false);
    expect((await request.put(`/api/media/blob/${encodeURIComponent(imageKey)}`, { headers: { ...headers, "content-type": "image/png" }, data: png })).ok()).toBeTruthy();
    await dialog.getByRole("button", { name: "保存模板", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect((await readTemplates()).filter((item: { title: string }) => item.title === "Repaired snapshot")).toHaveLength(1);
});

test("template preview renders static media and configuration without executing nodes", async ({ page, request }) => {
    const { headers, template } = await seed(request, page);
    const sample = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 480; canvas.height = 360;
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#e8e3d8"; ctx.fillRect(0, 0, 480, 360);
        ctx.fillStyle = "#d1c8b6"; ctx.beginPath(); ctx.ellipse(250, 300, 115, 18, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#ab604b"; ctx.beginPath(); ctx.roundRect(180, 90, 130, 210, 22); ctx.fill();
        ctx.fillStyle = "#444a3b"; ctx.fillRect(208, 60, 74, 38);
        ctx.fillStyle = "#f1ece3"; ctx.fillRect(191, 155, 108, 90);
        ctx.fillStyle = "#46483b"; ctx.font = "16px sans-serif"; ctx.fillText("STUDIO", 211, 185); ctx.font = "10px sans-serif"; ctx.fillText("SUMMER OBJECTS", 202, 208);
        ctx.font = "13px sans-serif"; ctx.fillText("A simple everyday ritual.", 26, 32);
        return canvas.toDataURL("image/png").split(",")[1];
    });
    expect((await request.put(`/api/media/blob/${encodeURIComponent(imageKey)}`, { headers: { ...headers, "content-type": "image/png" }, data: Buffer.from(sample, "base64") })).ok()).toBeTruthy();
    await page.evaluate(async () => { const path = "/src/stores/use-theme-store.ts"; const { useThemeStore } = await import(path); useThemeStore.getState().setTheme("light"); });
    const node = (id: string, type: CanvasNodeType | string, x: number, y: number, width: number, height: number, metadata = {}) => ({ id, title: id, type, position: { x, y }, width, height, metadata: { ...metadata, groupId: "Preview group" } });
    template.content.nodes = [
        { ...node("Preview group", CanvasNodeType.Group, 0, 0, 1000, 650), metadata: {} },
        node("Product photo", CanvasNodeType.Image, 40, 60, 280, 200, { content: imageKey, storageKey: imageKey }),
        node("Product brief", CanvasNodeType.Text, 390, 60, 260, 180, { content: "Create a summer poster with a clear product headline." }),
        node("Poster configuration", CanvasNodeType.Config, 390, 320, 470, 240, { generationMode: "image", composerContent: "Generate a poster using the product photo", model: "default::gpt-image-2", size: "1:1", count: 3 }),
        node("Preview video", CanvasNodeType.Video, 40, 340, 280, 140, { content: "video:preview-not-requested" }),
        node("Preview audio", CanvasNodeType.Audio, 40, 510, 280, 110, { content: "audio:preview-not-requested" }),
        node("Preview plugin", "test:preview-plugin", 710, 60, 240, 180, { content: "<script>window.previewPluginExecuted=true</script>" }),
    ];
    template.content.connections = [{ id: "photo-config", fromNodeId: "Product photo", toNodeId: "Poster configuration" }, { id: "brief-config", fromNodeId: "Product brief", toNodeId: "Poster configuration" }];
    expect((await request.put("/api/data/canvas-templates", { headers, data: { revision: 1, payload: { version: 1, templates: [template] } } })).ok()).toBeTruthy();
    const prohibited: string[] = [];
    page.on("request", (request) => { if (/preview-not-requested|\/api\/ai\//.test(request.url())) prohibited.push(request.url()); });
    await navigate(page, "/templates");
    await page.getByRole("button", { name: "预览模板「Restore template」", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Restore template", exact: true });
    const image = dialog.getByRole("img", { name: "Product photo", exact: true });
    await expect(image).toHaveJSProperty("naturalWidth", 480);
    expect(await image.getAttribute("src")).toContain(`workspaceId=${headers["x-infinite-canvas-workspace"]}`);
    await expect(dialog.getByRole("button", { name: "Poster configuration", exact: true })).toContainText("gpt-image-2");
    await expect(dialog.getByRole("button", { name: "Product brief", exact: true })).toContainText("summer poster");
    expect(await dialog.locator("iframe, video, audio").count()).toBe(0);
    expect(await page.evaluate(() => Boolean((window as unknown as { previewPluginExecuted?: boolean }).previewPluginExecuted))).toBe(false);
    await dialog.getByRole("button", { name: "Product brief", exact: true }).click();
    await expect(dialog.getByRole("region", { name: "节点详情" })).toContainText("summer poster");
    const scene = dialog.locator("svg[data-template-preview-scene]");
    const before = await scene.boundingBox();
    await dialog.getByRole("button", { name: "缩小预览", exact: true }).click();
    const after = await scene.boundingBox();
    expect(after!.width).toBeLessThan(before!.width);
    await dialog.getByRole("button", { name: "重置预览缩放", exact: true }).click();
    await page.screenshot({ path: test.info().outputPath("template-preview-light.png") });
    await page.evaluate(async () => { const path = "/src/stores/use-theme-store.ts"; const { useThemeStore } = await import(path); useThemeStore.getState().setTheme("dark"); });
    await page.screenshot({ path: test.info().outputPath("template-preview-dark.png") });
    expect(prohibited).toEqual([]);
});

test("template preview large static graph preserves node elements during navigation", async ({ page, request }) => {
    const { headers, template } = await seed(request, page);
    template.content.nodes = Array.from({ length: 360 }, (_, index) => ({
        ...project(`Preview node ${index}`).nodes[0],
        position: { x: (index % 20) * 290, y: Math.floor(index / 20) * 230 },
        metadata: { content: `Preview text ${index}` },
    }));
    template.content.connections = template.content.nodes.slice(1).map((node, index) => ({ id: `preview-edge-${index}`, fromNodeId: template.content.nodes[index].id, toNodeId: node.id }));
    expect((await request.put("/api/data/canvas-templates", { headers, data: { revision: 1, payload: { version: 1, templates: [template] } } })).ok()).toBeTruthy();
    await navigate(page, "/templates");
    const open = page.getByRole("button", { name: "预览模板「Restore template」", exact: true });
    await expect(open).toBeVisible();
    const started = await page.evaluate(() => performance.now());
    await open.click();
    const dialog = page.getByRole("dialog", { name: "Restore template", exact: true });
    const nodes = dialog.getByRole("button", { name: /^Preview node / });
    await expect(nodes).toHaveCount(360);
    const rendered = await page.evaluate(() => performance.now());
    await nodes.first().evaluate((element) => {
        const state = window as unknown as { previewNode: Element; previewMutations: number; previewObserver: MutationObserver };
        state.previewNode = element;
        state.previewMutations = 0;
        state.previewObserver = new MutationObserver((records) => { state.previewMutations += records.length; });
        state.previewObserver.observe(element.closest("svg")!, { childList: true, characterData: true, subtree: true });
    });
    const zoomStarted = await page.evaluate(() => performance.now());
    await dialog.getByRole("button", { name: "放大预览", exact: true }).click();
    await dialog.getByRole("button", { name: "缩小预览", exact: true }).click();
    const zoomFinished = await page.evaluate(() => performance.now());
    expect(await nodes.first().evaluate((element) => element === (window as unknown as { previewNode: Element }).previewNode)).toBe(true);
    expect(await page.evaluate(() => (window as unknown as { previewMutations: number }).previewMutations)).toBe(0);
    await nodes.first().focus();
    await nodes.first().press("Enter");
    await expect(dialog.getByRole("region", { name: "节点详情" })).toContainText("Preview text 0");
    await page.screenshot({ path: test.info().outputPath("large-preview.png") });
    await test.info().attach("preview-performance.json", { body: JSON.stringify({ nodes: 360, edges: 359, openMs: rendered - started, zoomPairMs: zoomFinished - zoomStarted }), contentType: "application/json" });
});

test("V2 inserts independent modules twice and supports one-step undo and redo", async ({ page, request }) => {
    const { read, headers } = await seed(request, page);
    const before = await read("source");
    for (let index = 0; index < 2; index += 1) {
        const dialog = await openInsert(page);
        await dialog.getByRole("button", { name: "插入当前画布", exact: true }).click();
        await expect(dialog).not.toBeVisible();
        await expect.poll(async () => (await read("source")).nodes.length).toBe(index + 2);
    }
    const inserted = await read("source");
    expect(new Set(inserted.nodes.map((node) => node.id)).size).toBe(3);
    expect(inserted.nodes[0]).toEqual(before.nodes[0]);
    expect(inserted.viewport).toEqual(before.viewport);
    expect(inserted.chatSessions).toEqual(before.chatSessions);
    const keys = inserted.nodes.slice(1).map((node) => node.metadata!.storageKey!);
    expect(new Set([imageKey, ...keys]).size).toBe(3);
    await canvasMenu(page, "撤销");
    await expect.poll(async () => (await read("source")).nodes.length).toBe(2);
    await canvasMenu(page, "重做");
    await expect.poll(async () => (await read("source")).nodes.length).toBe(3);
    for (const key of keys) expect((await request.get(`/api/media/blob/${encodeURIComponent(key)}`, { headers })).ok()).toBeTruthy();
    const templates = (await (await request.get("/api/data/canvas-templates", { headers })).json()).payload.templates;
    expect(templates[0].content.nodes[0].metadata.storageKey).toBe(imageKey);
});

test("V2 server copies require workspace access and own independent media bytes", async ({ page, request }) => {
    const { headers } = await seed(request, page);
    expect((await request.post(`/api/media/blob/${encodeURIComponent(imageKey)}/copy`)).status()).toBe(403);
    const other = (await (await request.post("/api/workspaces", { data: { name: `copy-${randomUUID()}` } })).json()).workspace;
    expect((await request.post(`/api/media/blob/${encodeURIComponent(imageKey)}/copy`, { headers: { "x-infinite-canvas-workspace": other.id } })).status()).toBe(404);
    const response = await request.post(`/api/media/blob/${encodeURIComponent(imageKey)}/copy`, { headers });
    expect(response.ok()).toBeTruthy();
    const { storageKey } = await response.json();
    expect(storageKey).not.toBe(imageKey);
    expect((await request.put(`/api/media/blob/${encodeURIComponent(imageKey)}`, { headers: { ...headers, "content-type": "image/png" }, data: Buffer.from("changed source") })).ok()).toBeTruthy();
    const copied = await request.get(`/api/media/blob/${encodeURIComponent(storageKey)}`, { headers });
    expect(await copied.body()).toEqual(png);
});

test("V2 saving selected groups and explicit content updates never modify source canvases", async ({ page, request }) => {
    const { read, headers } = await seed(request, page);
    await page.evaluate(async () => {
        const path = "/src/stores/canvas/use-canvas-store.ts";
        const { useCanvasStore } = await import(path);
        const group = { id: "group", type: "group", title: "Module group", position: { x: 80, y: 80 }, width: 400, height: 400, metadata: {} };
        const child = { id: "child", type: "text", title: "Module text", position: { x: 120, y: 120 }, width: 200, height: 160, metadata: { groupId: "group", content: "Selected content" } };
        const source = useCanvasStore.getState().projects.find((project: CanvasProject) => project.id === "source");
        useCanvasStore.getState().updateProject("source", { nodes: [...source.nodes, group, child] });
    });
    await page.waitForTimeout(750);
    await page.reload();
    await page.locator('[data-node-id="group"]').first().click({ position: { x: 300, y: 300 } });
    await canvasMenu(page, "选区保存为模板");
    const dialog = page.getByRole("dialog", { name: "保存为模板", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("2 个节点");
    await dialog.getByRole("button", { name: /使用时填写/ }).click();
    await dialog.getByRole("checkbox", { name: "Module text", exact: true }).check();
    await dialog.getByRole("textbox", { name: "输入名称", exact: true }).fill("Required brief");
    await dialog.getByRole("textbox", { name: /模板名称/ }).fill("Selection snapshot");
    await dialog.getByRole("button", { name: "保存模板", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const readTemplates = async () => (await (await request.get("/api/data/canvas-templates", { headers })).json()).payload.templates;
    const saved = (await readTemplates()).find((item: { title: string }) => item.title === "Selection snapshot");
    expect(saved.content.nodes.map((node: { type: string }) => node.type)).toEqual(["group", "text"]);
    expect(saved.content.nodes[1].metadata.groupId).toBe(saved.content.nodes[0].id);
    expect(saved.content.nodes[1].metadata.templateInput.name).toBe("Required brief");
    expect(saved.content.nodes[1].metadata.content).toBeUndefined();
    const before = await read("source");
    await canvasMenu(page, "更新已有模板");
    const update = page.getByRole("dialog", { name: "更新已有模板", exact: true });
    await update.getByRole("combobox", { name: "要更新的模板" }).click();
    await page.locator(".ant-select-dropdown:visible").getByText("Restore template", { exact: true }).click();
    await expect(update.getByRole("button", { name: "更新模板", exact: true })).toBeDisabled();
    expect((await readTemplates()).find((item: { id: string }) => item.id === "template").content.nodes).toHaveLength(1);
    await update.getByRole("checkbox", { name: "我已核对范围，确认替换所选模板" }).check();
    await page.screenshot({ path: test.info().outputPath("update-confirmation.png") });
    let failUpdate = true;
    await page.route("**/api/data/canvas-templates", async (route) => {
        if (failUpdate && route.request().method() === "PUT") return route.fulfill({ status: 503, json: { error: "Template update temporarily unavailable" } });
        await route.continue();
    });
    await update.getByRole("button", { name: "更新模板", exact: true }).click();
    await expect(update.getByRole("alert")).toContainText("Template update temporarily unavailable");
    expect((await readTemplates()).find((item: { id: string }) => item.id === "template").content.nodes).toHaveLength(1);
    failUpdate = false;
    await update.getByRole("button", { name: "更新模板", exact: true }).click();
    await expect(update).not.toBeVisible();
    const updated = (await readTemplates()).find((item: { id: string }) => item.id === "template");
    expect(updated.content.nodes).toHaveLength(3);
    expect(updated.cover.storageKey).not.toBe(coverKey);
    expect((await read("source")).nodes).toEqual(before.nodes);
});

test("V2 image inputs persist independently and read-only preview never executes generation", async ({ page, request }) => {
    const { headers, template, read } = await seed(request, page);
    template.content.nodes[0].metadata = { templateInput: { name: "Product photo", description: "Upload reference", required: true } };
    expect((await request.put("/api/data/canvas-templates", { headers, data: { revision: 1, payload: { version: 1, templates: [template] } } })).ok()).toBeTruthy();
    let generationCalls = 0;
    page.on("request", (request) => { if (/\/api\/ai\//.test(request.url()) && request.method() === "POST") generationCalls += 1; });
    const dialog = await openInsert(page);
    await dialog.getByRole("button", { name: "预览模板「Restore template」" }).click();
    const preview = page.getByRole("dialog", { name: "Restore template", exact: true });
    await preview.getByRole("button", { name: "放大预览" }).click();
    await preview.getByRole("button", { name: "template", exact: true }).click();
    await expect(preview.getByRole("region", { name: "节点详情" })).toContainText("Product photo");
    await page.screenshot({ path: test.info().outputPath("read-only-preview.png") });
    await preview.getByRole("button", { name: /^关\s*闭$/ }).click();
    await dialog.getByLabel("Product photo", { exact: true }).setInputFiles({ name: "product.png", mimeType: "image/png", buffer: png });
    await page.screenshot({ path: test.info().outputPath("image-input.png") });
    await dialog.getByRole("button", { name: "插入当前画布", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect.poll(async () => (await read("source")).nodes.length).toBe(2);
    const saved = await read("source");
    const image = saved.nodes[1];
    expect(image.title).toBe("Product photo");
    expect(image.metadata?.storageKey).not.toBe(imageKey);
    const media = await request.get(`/api/media/blob/${encodeURIComponent(image.metadata!.storageKey!)}`, { headers });
    expect(await media.body()).toEqual(png);
    expect(generationCalls).toBe(0);
});

test("V2 missing plugins block use and failed media copies preserve the canvas for retry", async ({ page, request }) => {
    const { headers, template, read } = await seed(request, page);
    const plugin = { ...template, id: "plugin-template", title: "Plugin template", content: { ...template.content, nodes: [{ ...template.content.nodes[0], type: "uninstalled:node" }] } };
    expect((await request.put("/api/data/canvas-templates", { headers, data: { revision: 1, payload: { version: 1, templates: [plugin, template] } } })).ok()).toBeTruthy();
    await canvasMenu(page, "插入当前画布");
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("article").filter({ hasText: "Plugin template" }).getByRole("button", { name: "使用此模板", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("uninstalled:node");
    await expect(dialog.getByRole("button", { name: "插入当前画布", exact: true })).toBeDisabled();
    await dialog.getByRole("article").filter({ hasText: "Restore template" }).getByRole("button", { name: "使用此模板", exact: true }).click();
    let fail = true;
    await page.route("**/api/media/blob/*/copy", async (route) => { if (fail) return route.fulfill({ status: 503, json: { error: "copy failed" } }); await route.continue(); });
    await dialog.getByRole("button", { name: "插入当前画布", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("无法读取画布素材");
    expect((await read("source")).nodes).toHaveLength(1);
    fail = false;
    await dialog.getByRole("button", { name: "插入当前画布", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect.poll(async () => (await read("source")).nodes.length).toBe(2);
});

test("V2 pending inputs and missing models are explicit and do not run generation", async ({ page, request }) => {
    const { headers, template, read } = await seed(request, page);
    const inputNode = { ...project("input").nodes[0], metadata: { templateInput: { name: "Product brief", description: "Describe your product", required: true } } };
    template.content.nodes = [inputNode, { ...project("config").nodes[0], type: CanvasNodeType.Config, metadata: { model: "missing::model", generationMode: "text" } }];
    expect((await request.put("/api/data/canvas-templates", { headers, data: { revision: 1, payload: { version: 1, templates: [template] } } })).ok()).toBeTruthy();
    let generationCalls = 0;
    page.on("request", (request) => { if (/\/api\/ai\//.test(request.url()) && request.method() === "POST") generationCalls += 1; });
    const dialog = await openInsert(page);
    const insert = dialog.getByRole("button", { name: "插入当前画布", exact: true });
    await expect(insert).toBeDisabled();
    await dialog.getByRole("combobox", { name: "替换模型 missing::model", exact: true }).selectOption("default::gpt-5.5");
    await insert.click();
    await expect(dialog.getByRole("alert")).toContainText("Product brief");
    expect((await read("source")).nodes).toHaveLength(1);
    await dialog.getByRole("textbox", { name: "Product brief", exact: true }).fill("Independent brief");
    await insert.click();
    await expect(dialog).not.toBeVisible();
    await expect.poll(async () => (await read("source")).nodes.length).toBe(3);
    const saved = await read("source");
    expect(saved.nodes[1].metadata?.content).toBe("Independent brief");
    expect(saved.nodes[1].title).toBe("Product brief");
    expect(saved.nodes[2].metadata?.model).toBe("default::gpt-5.5");
    expect(generationCalls).toBe(0);
});

test("V2 obsolete insertion does not modify the old or current canvas", async ({ page, request }) => {
    const { read } = await seed(request, page);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let requested = false;
    await page.route("**/api/media/blob/*/copy", async (route) => { requested = true; await gate; await route.continue(); });
    try {
        const dialog = await openInsert(page);
        await dialog.getByRole("button", { name: "插入当前画布", exact: true }).click();
        await expect.poll(() => requested).toBe(true);
        await navigate(page, "/canvas/latest");
        await expect(page.locator('[data-node-id="latest-node"]').first()).toBeVisible();
        const copied = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/copy"));
        release();
        await copied;
        await page.waitForTimeout(750);
        expect((await read("source")).nodes.map((node) => node.id)).toEqual(["source-node"]);
        expect((await read("latest")).nodes.map((node) => node.id)).toEqual(["latest-node"]);
        expect(errors).toEqual([]);
    } finally { release(); }
});

async function createFromTemplate(page: Page) {
    await page.getByRole("button", { name: "打开画布菜单", exact: true }).click();
    await page.getByRole("menuitem", { name: "新建画布", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建画布", exact: true });
    await dialog.getByRole("button", { name: "从模板创建", exact: true }).click();
    await dialog.getByRole("button", { name: "使用此模板", exact: true }).click();
    await dialog.getByRole("button", { name: "新建画布", exact: true }).click();
    await expect(page).not.toHaveURL(/\/canvas\/source$/);
    return new URL(page.url()).pathname.split("/").at(-1)!;
}

async function navigate(page: Page, path: string) {
    await page.evaluate((path) => {
        // Keep this document alive, but use the mounted router's browser-history listener.
        // Importing router.tsx again after Vite HMR can create a second, unmounted router.
        history.pushState({ ...history.state, idx: (history.state?.idx ?? 0) + 1 }, "", path);
        dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
    }, path);
    await expect(page).toHaveURL(new RegExp(`${path}$`));
}

test("template creation cannot autosave source content while new media is delayed", async ({ page, request }) => {
    const { read } = await seed(request, page);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/media/blob/**", async (route) => {
        const key = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!);
        if (route.request().method() === "GET" && ![imageKey, coverKey, chatKey].includes(key)) await pending;
        await route.continue();
    });
    try {
        const id = await createFromTemplate(page);
        // Exceed both existing autosave debounce windows while hydration is blocked.
        await page.waitForTimeout(750);
        const saved = await read(id);
        expect(saved.nodes.map((node) => node.title)).toEqual(["template"]);
        expect(saved.chatSessions).toEqual([]);
        expect(saved.activeChatId).toBeNull();
        expect(saved.nodes[0].metadata?.storageKey).not.toBe(imageKey);
        release();
        await expect(page.locator(`[data-node-id="${saved.nodes[0].id}"]`).first()).toBeVisible();
        await page.waitForTimeout(750);
        expect((await read(id)).nodes.map((node) => node.id)).toEqual(saved.nodes.map((node) => node.id));
        expect((await read("source")).nodes[0].id).toBe("source-node");
    } finally { release(); }
});

test("failed template hydration preserves saved content and can be retried without stale autosaves", async ({ page, request }) => {
    const { read } = await seed(request, page);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let fail = true;
    await page.route("**/api/media/blob/**", async (route) => {
        const key = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!);
        if (fail && route.request().method() === "GET" && ![imageKey, coverKey, chatKey].includes(key)) return route.fulfill({ status: 503, json: { error: "media unavailable" } });
        await route.continue();
    });
    const id = await createFromTemplate(page);
    await expect(page.getByRole("alert").filter({ hasText: "媒体读取失败" })).toBeVisible();
    await page.waitForTimeout(750);
    const saved = await read(id);
    expect(saved.nodes.map((node) => node.title)).toEqual(["template"]);
    expect(saved.chatSessions).toEqual([]);
    expect(errors).toEqual([]);
    fail = false;
    await page.getByRole("button", { name: /^重\s*试$/ }).click();
    await expect(page.locator(`[data-node-id="${saved.nodes[0].id}"]`).first()).toBeVisible();
    await page.waitForTimeout(750);
    expect((await read(id)).nodes[0].id).toBe(saved.nodes[0].id);
});

for (const destination of ["/canvas/latest", "/canvas"]) {
    test(`obsolete restoration does not apply or read chat media after navigating to ${destination}`, async ({ page, request }) => {
        const { read } = await seed(request, page);
        const chatReads: string[] = [];
        page.on("request", (request) => { if (request.url().endsWith(encodeURIComponent(chatKey))) chatReads.push(request.url()); });
        let release!: () => void;
        const pending = new Promise<void>((resolve) => { release = resolve; });
        await page.route(`**/api/media/blob/${encodeURIComponent(imageKey)}`, async (route) => { await pending; await route.continue(); });
        try {
            const waiting = page.waitForRequest((request) => request.url().endsWith(encodeURIComponent(imageKey)));
            await navigate(page, "/canvas/delayed");
            await waiting;
            await navigate(page, destination);
            if (destination.endsWith("latest")) await expect(page.locator('[data-node-id="latest-node"]').first()).toBeVisible();
            else await expect(page.getByRole("button", { name: "新建画布", exact: true })).toBeVisible();
            release();
            await page.waitForTimeout(750);
            expect((await read("latest")).nodes[0].id).toBe("latest-node");
            expect((await read("latest")).chatSessions).toEqual([]);
            expect((await read("delayed")).nodes[0].id).toBe("delayed-node");
            expect(chatReads).toEqual([]);
            if (destination.endsWith("latest")) await expect(page.locator('[data-node-id="latest-node"]').first()).toBeVisible();
        } finally { release(); }
    });
}

test("a rejected obsolete chat restoration does not affect the current canvas", async ({ page, request }) => {
    const { read } = await seed(request, page);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    await page.route(`**/api/media/blob/${encodeURIComponent(chatKey)}`, async (route) => {
        await pending;
        await route.fulfill({ status: 503, json: { error: "obsolete chat media unavailable" } });
    });
    try {
        const waiting = page.waitForRequest((request) => request.url().endsWith(encodeURIComponent(chatKey)));
        await navigate(page, "/canvas/delayed");
        await waiting;
        await navigate(page, "/canvas/latest");
        await expect(page.locator('[data-node-id="latest-node"]').first()).toBeVisible();
        release();
        await page.waitForTimeout(750);
        expect(errors).toEqual([]);
        await expect(page.getByRole("alert")).toHaveCount(0);
        expect((await read("latest")).nodes[0].id).toBe("latest-node");
        expect((await read("latest")).chatSessions).toEqual([]);
    } finally { release(); }
});
