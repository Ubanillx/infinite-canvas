import { createHash } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { test, expect } from "./auth";

// 显式提供环境变量才调用付费接口；凭据不进入 trace 或测试产物。
test.use({ trace: "off", video: "off" });
test("live image provider generates once, saves to assets, and reloads from server media", async ({ page, request }, info) => {
    test.skip(!process.env.IMAGE_LIVE_API_KEY || !process.env.IMAGE_LIVE_BASE_URL || !process.env.IMAGE_LIVE_MODEL, "Requires explicit live-provider credentials and model");
    const dataDir = resolve(process.env.INFINITE_CANVAS_DATA_DIR || "");
    const localPath = relative(resolve(import.meta.dirname, "../../.local"), dataDir);
    expect(localPath && !localPath.startsWith("..") && !isAbsolute(localPath), "Live credentials require an isolated .local data directory").toBeTruthy();
    expect(new URL(process.env.DATABASE_URL!).pathname).toMatch(/^\/infinite_canvas_e2e_/);
    const baseUrl = process.env.IMAGE_LIVE_BASE_URL!;
    const model = process.env.IMAGE_LIVE_MODEL!;
    const resultFile = resolve(dataDir, "provider-result.private.json");
    const replay = await readFile(resultFile, "utf8").then(JSON.parse).catch(() => null);
    const channelId = "live-image-test";
    const prompt = "A small red ceramic teapot on a pale blue tabletop, soft studio lighting, clean product photograph, square composition, no text.";
    const config = {
        app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(),
        config: {
            channels: [{ id: channelId, name: "SHUAI live test", baseUrl, apiFormat: "openai", apiKey: process.env.IMAGE_LIVE_API_KEY, models: [{ name: model, capability: "image" }] }],
            model: `${channelId}::${model}`, imageModel: `${channelId}::${model}`, models: [`${channelId}::${model}`], size: "1024x1024", quality: "auto", count: "1", proxyEnabled: false,
        },
        webdav: {}, promptSources: { sources: [], schedule: { intervalMinutes: 0, lastFetchedAt: "" } },
    };
    const statuses: Array<{ path: string; status: number }> = [];
    let generations = 0;
    let returnedUrl = false;
    let returnedBase64 = false;
    page.on("request", (request) => { if (request.url().includes(`/api/ai/${channelId}/images/generations`)) generations++; });
    page.on("response", (response) => {
        const path = new URL(response.url()).pathname;
        if (path.startsWith(`/api/ai/${channelId}/`) || path === "/api/remote-media" || (path.startsWith("/api/media/blob/") && response.request().method() === "PUT")) {
            statuses.push({ path: path.startsWith("/api/media/") ? "/api/media/blob/[key]" : path, status: response.status() });
            console.log(JSON.stringify(statuses.at(-1)));
        }
    });
    try {
        expect((await request.put("/api/config", { data: config })).status()).toBe(200);
        if (replay) await page.route(`**/api/ai/${channelId}/images/generations`, (route) => route.fulfill({ json: replay }));
        const { workspaces } = await (await request.get("/api/auth/me")).json();
        const workspace = workspaces[0];
        const headers = { "x-infinite-canvas-workspace": workspace.id };
        await page.addInitScript((workspace) => localStorage.setItem("infinite-canvas:active-workspace", JSON.stringify(workspace)), workspace);
        await page.goto("/image");
        await page.locator("#image-prompt").fill(prompt);
        const generationResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/ai/${channelId}/images/generations`, { timeout: info.timeout });
        const historySaved = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/data/image-workbench" && response.request().method() === "PUT", { timeout: info.timeout });
        await page.getByRole("button", { name: "开始生成", exact: true }).click();
        const response = await generationResponse;
        expect(response.status()).toBe(200);
        const payload = await response.json();
        await writeFile(resultFile, JSON.stringify(payload), { mode: 0o600 });
        const items = Array.isArray(payload.data) ? payload.data : [payload.data ?? payload];
        returnedUrl = items.some((item: any) => typeof item === "string" ? /^https?:/.test(item) : Boolean(item?.url));
        returnedBase64 = items.some((item: any) => Boolean(item?.b64_json));
        const downloadUrl = items.map((item: any) => typeof item === "string" ? item : item?.url).find((value: unknown) => typeof value === "string" && /^https?:/.test(value));
        console.log(JSON.stringify({ stage: "provider-result", replayed: Boolean(replay), returnedUrl, returnedBase64, downloadHost: downloadUrl ? new URL(downloadUrl).hostname : null }));
        expect((await historySaved).status()).toBe(200);
        const history = await (await request.get("/api/data/image-workbench", { headers })).json();
        const log = history.payload.logs[0];
        if (log.status !== "success" && downloadUrl) {
            const proxied = await request.get(`/api/remote-media?url=${encodeURIComponent(downloadUrl)}`);
            console.log(JSON.stringify({ stage: "download-diagnostic", status: proxied.status(), error: (await proxied.json().catch(() => ({}))).error?.replace(/https?:\/\/\S+/g, "[download-url]") }));
            try {
                const direct = await fetch(downloadUrl);
                console.log(JSON.stringify({ stage: "direct-download", status: direct.status, type: direct.headers.get("content-type"), bytes: (await direct.arrayBuffer()).byteLength }));
            } catch (error) { console.log(JSON.stringify({ stage: "direct-download", code: (error as any).cause?.code || (error as any).code })); }
        }
        expect(log.status).toBe("success");
        expect(log.images).toHaveLength(1);
        const image = log.images[0];
        expect(image.storageKey).toMatch(/^image:/);
        expect(image.mimeType).toMatch(/^image\//);
        const stored = await request.get(`/api/media/blob/${encodeURIComponent(image.storageKey)}`, { headers });
        expect(stored.status()).toBe(200);
        const bytes = await stored.body();
        expect(bytes.length).toBe(image.bytes);
        const output = info.outputPath("generated-image.png");
        await writeFile(output, bytes);
        const savedToAssets = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/data/assets" && response.request().method() === "PUT");
        await page.getByRole("button", { name: "加入我的素材", exact: true }).click();
        expect((await savedToAssets).status()).toBe(200);
        const assets = await (await request.get("/api/data/assets", { headers })).json();
        expect(assets.payload.state.assets.some((asset: any) => asset.data?.storageKey === image.storageKey)).toBe(true);
        await page.reload();
        await page.getByRole("button").filter({ hasText: prompt.slice(0, 12) }).click();
        const preview = page.getByRole("img", { name: "生成结果 1", exact: true });
        await expect(preview).toBeVisible();
        expect(await preview.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
        const restored = await request.get(`/api/media/blob/${encodeURIComponent(image.storageKey)}`, { headers });
        const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
        expect(hash(await restored.body())).toBe(hash(bytes));
        expect(generations).toBe(1);
        const report = { baseUrl, model, generationRequests: generations, providerGenerations: replay ? 0 : generations, replayedGenerationResponse: Boolean(replay), returnedUrl, returnedBase64, width: image.width, height: image.height, bytes: image.bytes, mimeType: image.mimeType, sha256: hash(bytes), assetsSaved: true, reloadVerified: true, statuses };
        await writeFile(info.outputPath("live-result.json"), JSON.stringify(report, null, 2));
        await page.screenshot({ path: info.outputPath("saved-result.png"), fullPage: true });
        await unlink(resultFile);
        console.log(JSON.stringify({ ...report, image: output }));
    } finally {
        await page.close();
        await unlink(resolve(dataDir, "config.json")).catch((error) => { if (error.code !== "ENOENT") throw error; });
    }
});
