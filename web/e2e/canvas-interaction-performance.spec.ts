import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "./auth";
import type { CanvasAgentSnapshot } from "../src/lib/canvas/canvas-agent-ops";

test.skip(({ isMobile }) => isMobile, "Desktop mouse gesture regressions");

async function snapshot(page: Page): Promise<CanvasAgentSnapshot> {
    return page.evaluate(async () => {
        const path = "/src/stores/use-agent-store.ts";
        const { useAgentStore } = await import(path);
        return useAgentStore.getState().canvasContext.snapshot;
    });
}

async function seed(page: Page, request: APIRequestContext, firstNodeType = "text") {
    const response = await request.post("/api/workspaces", { data: { name: "Canvas interaction performance" } });
    expect(response.ok()).toBeTruthy();
    const { workspace } = await response.json();
    const headers = { "x-infinite-canvas-workspace": workspace.id };
    const now = new Date().toISOString();
    const project = {
        id: "performance", title: "Performance fixture", folderId: null, createdAt: now, updatedAt: now,
        nodes: Array.from({ length: 500 }, (_, index) => ({
            id: `node-${index}`, type: index === 0 ? firstNodeType : "text", title: `Node ${index}`, width: 240, height: 180,
            position: index < 2 ? { x: 100 + index * 420, y: 160 } : { x: 3000 + index % 20 * 280, y: Math.floor(index / 20) * 220 },
            metadata: { content: `Text ${index}` },
        })),
        connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 },
    };
    expect((await request.put("/api/data/canvas", { headers, data: { revision: 0, payload: { state: { projects: [project], folders: [], deletedProjects: [] }, version: 0 } } })).ok()).toBeTruthy();
    await page.addInitScript((active) => {
        localStorage.setItem("infinite-canvas:active-workspace", JSON.stringify(active));
        localStorage.setItem("infinite-canvas:known-workspaces", JSON.stringify([active]));
        localStorage.setItem("canvas-side-panel-open", "0");
    }, workspace);
    await page.goto("/canvas/performance");
    await expect(page.locator('[data-node-id="node-0"]')).toBeVisible();
    const surface = page.locator(".relative.h-full.w-full.select-none.overflow-hidden");
    const bounds = (await surface.boundingBox())!;
    return { surface, bounds, read: async () => (await (await request.get("/api/data/canvas", { headers })).json()).payload.state.projects[0] };
}

test("wheel bursts accumulate around the cursor and panning publishes no empty Agent snapshot", async ({ page, request }) => {
    const { surface, bounds } = await seed(page, request);
    await expect(surface.locator("[data-node-id]")).toHaveCount(2);
    await page.getByRole("button", { name: "打开小地图", exact: true }).click();
    const minimap = page.locator(".bottom-24 .cursor-crosshair");
    await minimap.evaluate((element) => {
        const markers = [...element.children].slice(0, -1);
        const observer = new MutationObserver((records) => { (window as any).markerMutations += records.length; });
        (window as any).markerMutations = 0;
        (window as any).minimapMarkers = markers;
        markers.forEach((marker) => observer.observe(marker, { attributes: true, childList: true, subtree: true }));
    });
    await page.evaluate(async () => {
        const path = "/src/stores/use-agent-store.ts";
        const { useAgentStore } = await import(path);
        (window as any).emptySnapshots = 0;
        useAgentStore.subscribe((state: any) => { if (!state.canvasContext) (window as any).emptySnapshots++; });
    });
    await surface.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        for (let i = 0; i < 30; i++) element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: rect.left + 800, clientY: rect.top + 400, deltaY: -1 }));
    });
    const scale = Math.pow(1.1, 0.3);
    await expect.poll(async () => (await snapshot(page)).viewport.k).toBeCloseTo(scale, 8);
    const zoomed = (await snapshot(page)).viewport;
    expect(zoomed.x).toBeCloseTo(800 * (1 - scale), 8);
    expect(zoomed.y).toBeCloseTo(400 * (1 - scale), 8);
    await page.mouse.move(bounds.x + 800, bounds.y + 400);
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(bounds.x + 865, bounds.y + 435, { steps: 12 });
    await page.mouse.up({ button: "middle" });
    await expect.poll(async () => (await snapshot(page)).viewport.x).toBeCloseTo(zoomed.x + 65, 8);
    expect((await snapshot(page)).viewport.y).toBeCloseTo(zoomed.y + 35, 8);
    expect(await page.evaluate(() => (window as any).emptySnapshots)).toBe(0);
    expect(await minimap.evaluate((element) => ({
        count: (window as any).minimapMarkers.length,
        reused: (window as any).minimapMarkers.every((marker: Element, index: number) => marker === element.children[index]),
        mutations: (window as any).markerMutations,
    }))).toEqual({ count: 500, reused: true, mutations: 0 });
    await page.screenshot({ path: test.info().outputPath("zoom-pan.png") });
});

test("thumbnail notifications only reach subscribers for the changed storage key", async ({ page, request }) => {
    await seed(page, request);
    const result = await page.evaluate(async () => {
        const storagePath = "/src/services/image-storage.ts";
        const workspacePath = "/src/lib/workspace.ts";
        const foragePath = performance.getEntriesByType("resource").map((entry) => entry.name).find((url) => /\/localforage\.js(?:\?|$)/.test(url))!;
        const [{ ensureImagePreview, subscribeImagePreviews }, { workspaceStoreName }, { default: localforage }] = await Promise.all([import(storagePath), import(workspacePath), import(foragePath)]);
        const previews = localforage.createInstance({ name: "infinite-canvas", storeName: workspaceStoreName("image_previews") });
        const first = "image:performance-first";
        const other = "image:performance-other";
        const blob = new Blob(["preview"], { type: "image/webp" });
        await previews.setItem(first, { version: 1, blob });
        await previews.setItem(other, { version: 1, blob });
        const calls = { first: 0, other: 0, all: 0 };
        const unsubscribeFirst = subscribeImagePreviews(() => calls.first++, first);
        const unsubscribeOther = subscribeImagePreviews(() => calls.other++, other);
        const unsubscribeAll = subscribeImagePreviews(() => calls.all++);
        try {
            await ensureImagePreview(first);
            const afterFirst = { ...calls };
            await ensureImagePreview(first);
            const afterCached = { ...calls };
            unsubscribeFirst();
            const unsubscribeReplacement = subscribeImagePreviews(() => calls.first++, first);
            unsubscribeFirst();
            const { deleteStoredImages } = await import(storagePath);
            try {
                await deleteStoredImages([first]);
            } finally {
                unsubscribeReplacement();
            }
            await ensureImagePreview(other);
            return { afterFirst, afterCached, afterOther: { ...calls } };
        } finally {
            unsubscribeFirst();
            unsubscribeOther();
            unsubscribeAll();
            await previews.removeItem(first);
            await previews.removeItem(other);
        }
    });
    expect(result).toEqual({ afterFirst: { first: 1, other: 0, all: 1 }, afterCached: { first: 1, other: 0, all: 1 }, afterOther: { first: 2, other: 1, all: 3 } });
});

test("mention suggestion navigation reuses caret layout and keeps keyboard selection", async ({ page, request }) => {
    await seed(page, request);
    const node = page.locator('[data-node-id="node-0"]');
    await node.dblclick({ position: { x: 80, y: 70 } });
    const editor = node.locator("textarea").first();
    await expect(editor).toBeVisible();
    await editor.fill("@");
    const menu = page.locator('[data-canvas-resource-mention-menu="true"]');
    await expect(menu).toBeVisible();
    await page.evaluate(() => {
        const append = document.body.appendChild;
        (window as any).caretMirrorAppends = 0;
        document.body.appendChild = function <T extends Node>(node: T): T {
            if (node instanceof HTMLDivElement && node.style.visibility === "hidden" && node.style.left === "-9999px") (window as any).caretMirrorAppends++;
            return append.call(this, node) as T;
        };
        (window as any).restoreCaretAppend = () => { document.body.appendChild = append; };
    });
    try {
        await editor.press("ArrowDown");
        await editor.press("ArrowUp");
        await editor.press("ArrowDown");
        expect(await page.evaluate(() => (window as any).caretMirrorAppends)).toBe(0);
        await editor.press("Enter");
        await expect(menu).toHaveCount(0);
        await expect(editor).not.toHaveValue("@");
    } finally {
        await page.evaluate(() => (window as any).restoreCaretAppend());
    }
});

test("drag and resize preserve the last position, save and undo as complete gestures", async ({ page, request }) => {
    const { read } = await seed(page, request);
    await page.getByRole("button", { name: "移动", exact: true }).click();
    const node = page.locator('[data-node-id="node-0"]');
    const rect = (await node.boundingBox())!;
    await page.mouse.move(rect.x + 80, rect.y + 50);
    await page.mouse.down();
    await page.mouse.move(rect.x + 170, rect.y + 100, { steps: 20 });
    await page.mouse.up();
    await expect.poll(async () => (await snapshot(page)).nodes[0].position).toEqual({ x: 190, y: 210 });
    await expect.poll(async () => (await read()).nodes[0].position).toEqual({ x: 190, y: 210 });
    await page.keyboard.press("Control+z");
    await expect.poll(async () => (await snapshot(page)).nodes[0].position).toEqual({ x: 100, y: 160 });
    const handle = node.locator(".cursor-nwse-resize").last();
    const corner = (await handle.boundingBox())!;
    await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
    await page.mouse.down();
    await page.mouse.move(corner.x + corner.width / 2 + 90, corner.y + corner.height / 2 + 60, { steps: 20 });
    await page.mouse.up();
    await expect.poll(async () => (await snapshot(page)).nodes[0].width).toBe(330);
    expect((await snapshot(page)).nodes[0].height).toBe(240);
    await expect.poll(async () => (await read()).nodes[0].width).toBe(330);
    await page.keyboard.press("Control+z");
    await expect.poll(async () => (await snapshot(page)).nodes[0].width).toBe(240);
    expect((await snapshot(page)).nodes[0].height).toBe(180);
});

test("marquee flushes the final event, and connections survive indexed hit testing", async ({ page, request }) => {
    const { bounds } = await seed(page, request);
    await page.getByRole("button", { name: "移动", exact: true }).click();
    await page.mouse.move(bounds.x + 75, bounds.y + 140);
    await page.mouse.down();
    await page.evaluate(({ x, y }) => {
        window.dispatchEvent(new PointerEvent("pointermove", { clientX: x + 300, clientY: y + 350, buttons: 1 }));
        window.dispatchEvent(new PointerEvent("pointerup", { clientX: x + 780, clientY: y + 365 }));
    }, bounds);
    await page.mouse.up();
    await expect.poll(async () => (await snapshot(page)).selectedNodeIds).toEqual(["node-0", "node-1"]);
    await page.mouse.click(bounds.x + 850, bounds.y + 440);
    const source = page.locator('[data-node-id="node-0"]');
    await source.hover();
    const handle = source.locator(".cursor-crosshair").last();
    const origin = (await handle.boundingBox())!;
    const target = (await page.locator('[data-node-id="node-1"]').boundingBox())!;
    await page.mouse.move(origin.x + origin.width / 2, origin.y + origin.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + 30, target.y + target.height / 2, { steps: 20 });
    await page.mouse.up();
    await expect.poll(async () => (await snapshot(page)).connections.map(({ fromNodeId, toNodeId }) => [fromNodeId, toNodeId])).toEqual([["node-0", "node-1"]]);
    await page.screenshot({ path: test.info().outputPath("connections.png") });
});

test("zoom slider, minimap and side-panel resize commit their final input", async ({ page, request }) => {
    const { surface } = await seed(page, request);
    const slider = page.getByRole("slider", { name: "放大/缩小画布", exact: true });
    await slider.press("ArrowRight");
    await expect.poll(async () => (await snapshot(page)).viewport.k).toBe(1.01);
    await page.getByRole("button", { name: "打开小地图", exact: true }).click();
    const minimap = page.locator(".bottom-24 .cursor-crosshair");
    const rect = (await minimap.boundingBox())!;
    const marker = await minimap.evaluate((element) => {
        const style = (element.firstElementChild as HTMLElement).style;
        const transform = new DOMMatrix(style.transform);
        return { x: transform.m41, y: transform.m42, scale: Number.parseFloat(style.width) / 240 };
    });
    const bounds = (await surface.boundingBox())!;
    await page.mouse.move(rect.x + 40, rect.y + 40);
    await page.mouse.down();
    await minimap.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        element.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: rect.left + 60, clientY: rect.top + 60, buttons: 1 }));
        element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: rect.left + 100, clientY: rect.top + 80 }));
    });
    await page.mouse.up();
    const expectedX = bounds.width / 2 - (100 + (100 - marker.x) / marker.scale) * 1.01;
    const expectedY = bounds.height / 2 - (160 + (80 - marker.y) / marker.scale) * 1.01;
    await expect.poll(async () => (await snapshot(page)).viewport.x).toBeCloseTo(expectedX, 2);
    expect((await snapshot(page)).viewport.y).toBeCloseTo(expectedY, 2);
    await page.mouse.move(rect.x + 40, rect.y + 40);
    await page.mouse.down();
    await minimap.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        element.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: rect.left + 70, clientY: rect.top + 70, buttons: 1 }));
        window.dispatchEvent(new Event("blur"));
        element.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: rect.left + 160, clientY: rect.top + 100, buttons: 1 }));
    });
    await page.mouse.up();
    await expect.poll(async () => (await snapshot(page)).viewport.x).toBeCloseTo(bounds.width / 2 - (100 + (70 - marker.x) / marker.scale) * 1.01, 2);
    expect((await snapshot(page)).viewport.y).toBeCloseTo(bounds.height / 2 - (160 + (70 - marker.y) / marker.scale) * 1.01, 2);
    await page.getByRole("button", { name: "展开面板", exact: true }).click();
    const resize = page.getByRole("button", { name: "调整左侧面板宽度", exact: true });
    await expect(resize.locator("../..")).toHaveCSS("width", "281px");
    const grip = (await resize.boundingBox())!;
    const start = { x: grip.x + 2, y: grip.y + grip.height / 2 };
    expect(await resize.evaluate((element, point) => document.elementFromPoint(point.x, point.y) === element, start)).toBe(true);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.evaluate(({ x, y }) => {
        window.dispatchEvent(new PointerEvent("pointermove", { clientX: x + 35, clientY: y, buttons: 1 }));
        window.dispatchEvent(new PointerEvent("pointerup", { clientX: x + 60, clientY: y }));
    }, start);
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("canvas-side-panel-width"))).toBe("340");
    await expect(resize.locator("..")).toHaveCSS("width", "340px");
    await page.locator("[data-node-item]").first().getByRole("button").first().click();
    await expect(page.locator('[data-node-id="node-0"]')).toBeVisible();
});

test("window blur flushes pending drag, resize and pan updates without leaving a gesture active", async ({ page, request }) => {
    const { bounds, read } = await seed(page, request);
    await page.getByRole("button", { name: "移动", exact: true }).click();
    const node = page.locator('[data-node-id="node-0"]');
    await page.mouse.move(bounds.x + 180, bounds.y + 210);
    await page.mouse.down();
    await page.evaluate(({ x, y }) => {
        window.dispatchEvent(new MouseEvent("mousemove", { clientX: x + 270, clientY: y + 260, buttons: 1 }));
        window.dispatchEvent(new Event("blur"));
    }, bounds);
    await page.mouse.up();
    await expect.poll(async () => (await snapshot(page)).nodes[0].position).toEqual({ x: 190, y: 210 });
    await expect.poll(async () => (await read()).nodes[0].position).toEqual({ x: 190, y: 210 });
    const corner = (await node.locator(".cursor-nwse-resize").last().boundingBox())!;
    const start = { x: corner.x + corner.width / 2, y: corner.y + corner.height / 2 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.evaluate(({ x, y }) => {
        window.dispatchEvent(new MouseEvent("mousemove", { clientX: x + 80, clientY: y + 45, buttons: 1 }));
        window.dispatchEvent(new Event("blur"));
    }, start);
    await page.mouse.up();
    await expect.poll(async () => (await snapshot(page)).nodes[0].width).toBe(320);
    expect((await snapshot(page)).nodes[0].height).toBe(225);
    await page.mouse.move(bounds.x + 800, bounds.y + 400);
    await page.mouse.down({ button: "middle" });
    await page.evaluate(({ x, y }) => {
        window.dispatchEvent(new PointerEvent("pointermove", { clientX: x + 840, clientY: y + 420, buttons: 4 }));
        window.dispatchEvent(new Event("blur"));
        window.dispatchEvent(new PointerEvent("pointermove", { clientX: x + 900, clientY: y + 450, buttons: 4 }));
    }, bounds);
    await page.mouse.up({ button: "middle" });
    await expect.poll(async () => (await snapshot(page)).viewport).toEqual({ x: 40, y: 20, k: 1 });
    expect((await snapshot(page)).nodes[0].position).toEqual({ x: 190, y: 210 });
});

test("memoized plugin UI follows registration, removal and the current zoom scale", async ({ page, request }) => {
    await seed(page, request, "performance:plugin");
    const register = async (title: string) => page.evaluate(async (title) => {
        const path = "/src/lib/canvas/node-registry.ts";
        const { registerNodeDefinitions } = await import(path);
        registerNodeDefinitions([{
            type: "performance:plugin", title, icon: null, defaultSize: { width: 240, height: 180 }, hidePanel: true,
            Content: () => "Plugin ready",
            toolbar: (ctx: { scale: number }) => [{ id: "scale", title: `${title} ${ctx.scale.toFixed(2)}`, label: `${title} ${ctx.scale.toFixed(2)}`, icon: null, onClick: () => {} }],
        }], "performance");
    }, title);
    await register("Plugin v1");
    await page.getByRole("button", { name: "展开面板", exact: true }).click();
    const row = page.locator("[data-node-item]").first();
    await expect(row).toContainText("Plugin v1");
    await page.locator('[data-node-id="node-0"]').click();
    await expect(page.getByRole("button", { name: "Plugin v1 1.00", exact: true })).toBeVisible();
    await page.getByRole("slider", { name: "放大/缩小画布", exact: true }).press("ArrowRight");
    await expect(page.getByRole("button", { name: "Plugin v1 1.01", exact: true })).toBeVisible();
    await register("Plugin v2");
    await expect(row).toContainText("Plugin v2");
    await expect(page.getByRole("button", { name: "Plugin v2 1.01", exact: true })).toBeVisible();
    await page.evaluate(async () => {
        const path = "/src/lib/canvas/node-registry.ts";
        const { unregisterPluginNodes } = await import(path);
        unregisterPluginNodes("performance");
    });
    await expect(row).not.toContainText("Plugin v2");
    await expect(page.getByRole("button", { name: "Plugin v2 1.01", exact: true })).toHaveCount(0);
});
