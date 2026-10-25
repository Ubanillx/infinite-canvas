import { randomUUID } from "node:crypto";
import { type APIRequestContext, type Page } from "@playwright/test";
import { test, expect } from "./auth";

import type { CanvasProject } from "../src/stores/canvas/use-canvas-store";
import { CanvasNodeType } from "../src/types/canvas";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const imageKey = "image:template_fixture";
const coverKey = "image:cover_fixture";
const chatKey = "image:chat_fixture";

test.afterEach(async ({ page }) => {
    // Stop viewport timers, then let the existing autosave debounce finish before disposal.
    await navigate(page, "/canvas");
    await page.waitForTimeout(750);
    await page.waitForLoadState("networkidle");
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
    await page.getByRole("button", { name: "打开画布菜单", exact: true }).click();
    await page.getByRole("menuitem", { name: "插入当前画布", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "使用此模板", exact: true }).click();
    return dialog;
}

async function canvasMenu(page: Page, name: string) {
    await page.getByRole("button", { name: "打开画布菜单", exact: true }).click();
    await page.getByRole("menuitem", { name: new RegExp(`^${name}`) }).click();
}

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
    await expect(dialog).toContainText("将保存 2 个节点");
    await dialog.getByText("定义待填写输入", { exact: true }).click();
    await dialog.getByRole("checkbox", { name: "Module text", exact: true }).check();
    await dialog.getByRole("textbox", { name: "输入名称", exact: true }).fill("Required brief");
    await dialog.getByRole("textbox", { name: /模板名称/ }).fill("Selection snapshot");
    await dialog.getByRole("button", { name: /^保\s*存$/ }).click();
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
    await update.getByRole("combobox", { name: "要更新的模板" }).selectOption("template");
    await update.getByRole("button", { name: /^保\s*存$/ }).click();
    await expect(update.getByRole("alert")).toContainText("确认替换");
    expect((await readTemplates()).find((item: { id: string }) => item.id === "template").content.nodes).toHaveLength(1);
    await update.getByRole("checkbox", { name: "我已核对范围，确认替换所选模板" }).check();
    await page.screenshot({ path: test.info().outputPath("update-confirmation.png") });
    let failUpdate = true;
    await page.route("**/api/data/canvas-templates", async (route) => {
        if (failUpdate && route.request().method() === "PUT") return route.fulfill({ status: 503, json: { error: "Template update temporarily unavailable" } });
        await route.continue();
    });
    await update.getByRole("button", { name: /^保\s*存$/ }).click();
    await expect(update.getByRole("alert")).toContainText("Template update temporarily unavailable");
    expect((await readTemplates()).find((item: { id: string }) => item.id === "template").content.nodes).toHaveLength(1);
    failUpdate = false;
    await update.getByRole("button", { name: /^保\s*存$/ }).click();
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
        release();
        await page.waitForLoadState("networkidle");
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
    await expect(page.getByRole("alert")).toContainText("媒体读取失败");
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
