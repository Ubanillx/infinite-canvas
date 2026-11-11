import { test, expect } from "./auth";
import type { APIRequestContext, Locator, Page } from "@playwright/test";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
const downloadUrl = "https://downloads.example/generated?signature=a%2Bb&expires=123";
const candidateSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="10"><rect width="16" height="10" fill="red"/></svg>');

test.beforeEach(async ({ page }) => {
    // Download tests must not connect to the developer's live Agent or start provider requests.
    await page.route("**/api/canvas-agent/**", (route) => route.fulfill({ status: 503, json: { error: "Agent disabled for download tests" } }));
    await page.route("**/api/generation-tasks", (route) => {
        expect(route.request().method()).toBe("GET");
        return route.continue();
    });
});

test.afterEach(async ({ page }) => {
    if (!page.url().endsWith("/canvas/download-buttons")) return;
    // Unmount viewport timers and wait for the canvas write queue before closing the browser.
    await page.getByRole("button", { name: "返回画布库", exact: true }).click();
    await expect(page.getByRole("heading", { name: "我的画布", exact: true })).toBeVisible();
    await page.evaluate(async () => {
        const canvasPath = "/src/stores/canvas/use-canvas-store.ts";
        const workspacePath = "/src/lib/workspace.ts";
        const { flushCanvasSave } = await import(canvasPath);
        const { getActiveWorkspace } = await import(workspacePath);
        await flushCanvasSave(getActiveWorkspace()!.id);
    });
});

async function seedDownloadButtons(page: Page, request: APIRequestContext, source: "remote" | "stored") {
    const { workspaces } = await (await request.get("/api/auth/me")).json();
    const workspace = workspaces[0];
    const headers = { "x-infinite-canvas-workspace": workspace.id };
    await page.addInitScript((workspace) => {
        sessionStorage.setItem("infinite-canvas:active-workspace", JSON.stringify(workspace));
        localStorage.setItem("infinite-canvas:active-workspace", JSON.stringify(workspace));
        localStorage.setItem("canvas-side-panel-open", "0");
    }, workspace);
    const fixtures = [
        { id: "primary", bytes: png, mimeType: "image/png", width: 1, height: 1 },
        { id: "candidate", bytes: candidateSvg, mimeType: "image/svg+xml", width: 16, height: 10 },
    ];
    for (const fixture of fixtures) {
        if (source === "stored") expect((await request.put(`/api/media/blob/image%3Adownload-${fixture.id}`, { headers: { ...headers, "content-type": fixture.mimeType }, data: fixture.bytes })).ok()).toBe(true);
    }
    let remoteReads = 0;
    await page.route("https://downloads.example/**", (route) => {
        const fixture = route.request().url().includes("candidate") ? fixtures[1] : fixtures[0];
        return route.fulfill({ body: fixture.bytes, contentType: fixture.mimeType });
    });
    await page.route("**/api/remote-media?*", (route) => {
        remoteReads++;
        // Stored results must download without accessing the expired provider link.
        if (source === "stored") return route.fulfill({ status: 403, body: "expired" });
        const target = new URL(route.request().url()).searchParams.get("url");
        expect(target).toMatch(/^https:\/\/downloads\.example\/(primary|candidate)\?signature=a%2Bb$/);
        const fixture = target!.includes("candidate") ? fixtures[1] : fixtures[0];
        return route.fulfill({ body: fixture.bytes, contentType: fixture.mimeType });
    });
    const [primary, candidate] = fixtures.map((fixture) => ({
        id: fixture.id, status: "success", content: `https://downloads.example/${fixture.id}?signature=a%2Bb`,
        ...(source === "stored" ? { storageKey: `image:download-${fixture.id}` } : {}),
        naturalWidth: fixture.width, naturalHeight: fixture.height, bytes: fixture.bytes.length, mimeType: fixture.mimeType,
    }));
    const now = new Date().toISOString();
    const image = { id: primary.id, dataUrl: primary.content, storageKey: primary.storageKey, width: 1, height: 1, bytes: png.length, mimeType: primary.mimeType, durationMs: 1 };
    const metadata = { ...primary, images: [primary, candidate], primaryImageId: primary.id };
    const nodeX = (page.viewportSize()!.width - 130) / 2;
    const payloads = {
        canvas: { version: 0, state: { folders: [], deletedProjects: [], projects: [{ id: "download-buttons", title: "下载按钮验收", folderId: null, createdAt: now, updatedAt: now, nodes: [{ id: "download-node", type: "image", title: "下载测试图片组", position: { x: nodeX, y: 150 }, width: 130, height: 90, metadata }], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } }] } },
        "image-workbench": { logs: [{ id: "download-log", title: "下载按钮历史结果", prompt: "下载按钮历史结果", createdAt: Date.now(), time: now, model: "", config: { model: "", size: "1024x1024", quality: "auto", count: "1" }, references: [], durationMs: 1, successCount: 1, failCount: 0, imageCount: 1, status: "success", images: [image] }] },
        assets: { version: 0, state: { assets: [{ id: "download-asset", kind: "image", title: "【下载】 素材测试", coverUrl: primary.content, tags: [], createdAt: now, updatedAt: now, data: image }] } },
    };
    for (const [domain, payload] of Object.entries(payloads)) expect((await request.put(`/api/data/${domain}`, { headers, data: { revision: 0, payload } })).ok()).toBe(true);
    return { remoteReads: () => remoteReads };
}

async function expectButtonDownload(page: Page, button: Locator, filename: string, bytes: Buffer) {
    const url = page.url();
    const pages = page.context().pages().length;
    await expect(button).toBeVisible();
    const pending = page.waitForEvent("download");
    await button.click();
    const download = await pending;
    expect(download.suggestedFilename()).toBe(filename);
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(bytes);
    expect(page.url()).toBe(url);
    expect(page.context().pages()).toHaveLength(pages);
}

for (const source of ["remote", "stored"] as const) {
    test.describe(`image download buttons (${source})`, () => {
        test("canvas main-image toolbar saves the original image", async ({ page, request }) => {
            const fixture = await seedDownloadButtons(page, request, source);
            await page.goto("/canvas/download-buttons");
            const node = page.locator('[data-node-id="download-node"]').first();
            await node.click({ position: { x: 65, y: 70 } });
            await expectButtonDownload(page, page.locator('[data-node-toolbar="download-node"]').getByRole("button", { name: "下载图片", exact: true }), "canvas-image-download-node.png", png);
            expect(fixture.remoteReads()).toBe(source === "remote" ? 1 : 0);
        });

        test("expanded canvas candidate saves its own bytes rather than the primary image", async ({ page, request }) => {
            const fixture = await seedDownloadButtons(page, request, source);
            await page.goto("/canvas/download-buttons");
            const node = page.locator('[data-node-id="download-node"]').first();
            await node.click({ position: { x: 65, y: 70 } });
            await node.getByRole("button", { name: "图片组已收起", exact: true }).click();
            await expect(node.getByRole("button", { name: "图片组已展开", exact: true })).toBeVisible();
            await node.hover();
            // The candidate card also contains Set primary; this keeps the locator independent of button order.
            const candidate = node.locator("div").filter({ has: page.getByRole("button", { name: "设为主图", exact: true }) }).filter({ has: page.getByRole("button", { name: "创建副本", exact: true }) }).last();
            await expectButtonDownload(page, candidate.getByRole("button", { name: "下载", exact: true }), "canvas-image-download-node-candidate.svg", candidateSvg);
            expect(fixture.remoteReads()).toBe(source === "remote" ? 1 : 0);
        });

        test("image workbench Download original saves a selected history result", async ({ page, request }) => {
            const fixture = await seedDownloadButtons(page, request, source);
            await page.goto("/image");
            await page.getByRole("button", { name: /下载按钮历史结果/ }).first().click();
            await expectButtonDownload(page, page.getByRole("button", { name: "下载原图", exact: true }), "image-1.png", png);
            expect(fixture.remoteReads()).toBe(source === "remote" ? 1 : 0);
        });

        test("asset card and preview drawer both download the image with its Chinese title", async ({ page, request }) => {
            const fixture = await seedDownloadButtons(page, request, source);
            await page.goto("/assets");
            await expect(page.getByRole("heading", { name: "【下载】 素材测试", exact: true })).toBeVisible();
            await expectButtonDownload(page, page.getByRole("button", { name: "下载", exact: true }), "【下载】 素材测试.png", png);
            await page.getByRole("button", { name: "查看", exact: true }).click();
            await expectButtonDownload(page, page.getByRole("button", { name: "下载图片", exact: true }), "【下载】 素材测试.png", png);
            expect(fixture.remoteReads()).toBe(source === "remote" ? 2 : 0);
        });
    });
}

test("image downloads save bytes for URL, data URL, blob URL and binary results without opening a tab", async ({ page, context }) => {
    await page.route("**/api/remote-media?*", (route) => {
        expect(new URL(route.request().url()).searchParams.get("url")).toBe(downloadUrl);
        return route.fulfill({ body: png, contentType: "application/octet-stream" });
    });
    await page.goto("/image");
    const url = page.url();
    const pages = context.pages().length;
    for (const source of ["remote", "data", "blob", "binary"]) {
        const pending = page.waitForEvent("download");
        await page.evaluate(async ({ source, downloadUrl, bytes }) => {
            const path = "/src/services/media-download.ts";
            const { downloadMedia } = await import(path);
            const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
            const objectUrl = URL.createObjectURL(blob);
            try {
                const url = source === "remote" ? downloadUrl : source === "data" ? `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}` : source === "binary" ? blob : objectUrl;
                await downloadMedia({ url, kind: "image" }, "【下载】 测试.jpg");
            } finally {
                URL.revokeObjectURL(objectUrl);
            }
        }, { source, downloadUrl, bytes: [...png] });
        const download = await pending;
        expect(download.suggestedFilename()).toBe("【下载】 测试.png");
        const stream = await download.createReadStream();
        const chunks: Buffer[] = [];
        for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
        expect(Buffer.concat(chunks)).toEqual(png);
        expect(page.url()).toBe(url);
        expect(context.pages()).toHaveLength(pages);
    }
});

test("image download uses workspace bytes before an expired URL and rejects failed or non-image responses", async ({ page }) => {
    let remoteReads = 0;
    let downloads = 0;
    page.on("download", () => downloads++);
    await page.route("**/api/media/blob/image%3Adownload-fixture", (route) => route.fulfill({ body: png, contentType: "image/png" }));
    await page.route("**/api/remote-media?*", (route) => {
        remoteReads++;
        if (new URL(route.request().url()).searchParams.get("url")?.endsWith("/spoofed")) return route.fulfill({ body: "<html>not an image</html>", contentType: "image/png" });
        return new URL(route.request().url()).searchParams.get("url")?.endsWith("/invalid")
            ? route.fulfill({ body: "<html>not an image</html>", contentType: "application/octet-stream" })
            : route.fulfill({ status: 403, json: { error: "expired" } });
    });
    await page.goto("/image");
    const pending = page.waitForEvent("download");
    await page.evaluate(async () => {
        const path = "/src/services/media-download.ts";
        const { downloadMedia } = await import(path);
        await downloadMedia({ url: "https://downloads.example/expired", storageKey: "image:download-fixture", kind: "image" }, "saved.png");
    });
    await pending;
    expect(remoteReads).toBe(0);
    const rejected = await page.evaluate(async () => {
        const path = "/src/services/media-download.ts";
        const { downloadMedia } = await import(path);
        let rejected = 0;
        for (const url of ["https://downloads.example/expired", "https://downloads.example/invalid", "https://downloads.example/spoofed", new Blob()]) {
            try { await downloadMedia({ url, kind: "image" }, "failed.png"); }
            catch { rejected++; }
        }
        return rejected;
    });
    expect(rejected).toBe(4);
    expect(downloads).toBe(1);
});

test("temporary image downloads persist as server media and survive link expiry and reload", async ({ page, request }) => {
    const { workspaces } = await (await request.get("/api/auth/me")).json();
    await page.addInitScript((workspace) => localStorage.setItem("infinite-canvas:active-workspace", JSON.stringify(workspace)), workspaces[0]);
    let downloads = 0;
    await page.route("**/api/ai/download-test/images/generations", (route) => route.fulfill({ json: { data: [{ url: downloadUrl }] } }));
    await page.route("**/api/remote-media?*", (route) => {
        downloads++;
        expect(new URL(route.request().url()).searchParams.get("url")).toBe(downloadUrl);
        return route.fulfill({ body: png, headers: { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=result.png" } });
    });
    await page.goto("/image");
    const stored = await page.evaluate(async () => {
        const configPath = "/src/stores/use-config-store.ts";
        const apiPath = "/src/services/api/image.ts";
        const storagePath = "/src/services/image-storage.ts";
        const { defaultConfig } = await import(configPath);
        const { requestGeneration } = await import(apiPath);
        const { uploadImage } = await import(storagePath);
        const config = { ...defaultConfig, model: "download-test::gpt-image-2", channels: [{ id: "download-test", apiFormat: "openai", baseUrl: "https://provider.example", hasApiKey: true, models: [{ name: "gpt-image-2", capability: "image" }] }] };
        const [image] = await requestGeneration(config, "a simple blue square");
        const saved = await uploadImage(image.dataUrl);
        sessionStorage.setItem("download-test-storage-key", saved.storageKey);
        return { key: saved.storageKey, width: saved.width, height: saved.height, mimeType: saved.mimeType, localUrl: saved.url.startsWith("blob:") };
    });
    expect(stored).toMatchObject({ width: 1, height: 1, mimeType: "image/png", localUrl: true });
    expect(stored.key).toMatch(/^image:/);
    expect(downloads).toBe(1);
    await page.unroute("**/api/remote-media?*");
    await page.route("**/api/remote-media?*", (route) => { downloads++; return route.fulfill({ status: 403, json: { error: "expired" } }); });
    await page.reload();
    const recovered = await page.evaluate(async () => {
        const storagePath = "/src/services/image-storage.ts";
        const { getImageBlob, resolveImageUrl, imageToDataUrl, uploadImage } = await import(storagePath);
        const key = sessionStorage.getItem("download-test-storage-key")!;
        const blob = await getImageBlob(key);
        const url = await resolveImageUrl(key);
        const image = new Image();
        image.src = url;
        await image.decode();
        let expiredError = "";
        try { await uploadImage("https://downloads.example/expired"); }
        catch (error) { expiredError = (error as Error).message; }
        return { bytes: Array.from(new Uint8Array(await blob.arrayBuffer())), mimeType: blob.type, reference: await imageToDataUrl({ storageKey: key }), width: image.naturalWidth, expiredError };
    });
    expect(recovered.bytes).toEqual([...png]);
    expect(recovered.mimeType).toBe("image/png");
    expect(recovered.reference).toBe(`data:image/png;base64,${png.toString("base64")}`);
    expect(recovered.width).toBe(1);
    expect(recovered.expiredError).toContain("403");
    expect(downloads).toBe(2);
});

test("HTML and JSON download responses cannot be saved as generated images", async ({ page, request }) => {
    const { workspaces } = await (await request.get("/api/auth/me")).json();
    await page.addInitScript((workspace) => localStorage.setItem("infinite-canvas:active-workspace", JSON.stringify(workspace)), workspaces[0]);
    let saves = 0;
    page.on("request", (request) => { if (request.method() === "PUT" && request.url().includes("/api/media/blob/")) saves++; });
    await page.route("**/api/remote-media?*", (route) => route.fulfill({ body: '<html><body>expired</body></html>', contentType: "application/octet-stream" }));
    await page.goto("/image");
    const rejected = await page.evaluate(async () => {
        const path = "/src/services/image-storage.ts";
        const { uploadImage } = await import(path);
        const errors: string[] = [];
        for (const input of ["https://downloads.example/error", new Blob(['{"error":"failed"}'], { type: "application/json" })]) {
            try { await uploadImage(input); }
            catch (error) { errors.push((error as Error).message); }
        }
        return errors.length;
    });
    expect(rejected).toBe(2);
    expect(saves).toBe(0);
});
