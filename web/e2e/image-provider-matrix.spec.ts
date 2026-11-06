import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { test, expect } from "./auth";

// 真实接口测试只在显式配置时运行；禁用包含凭据或临时链接的录制。
test.use({ trace: "off", video: "off" });
test("live model matrix covers workbench and canvas generation, editing, assets and reload", async ({ page, request }, info) => {
    test.skip(!process.env.IMAGE_LIVE_API_KEY || !process.env.IMAGE_LIVE_BASE_URL || !process.env.IMAGE_LIVE_MODELS || !process.env.IMAGE_LIVE_REFERENCE, "Requires explicit live-model matrix settings");
    const dataDir = resolve(process.env.INFINITE_CANVAS_DATA_DIR!);
    const localPath = relative(resolve(import.meta.dirname, "../../.local"), dataDir);
    expect(localPath && !localPath.startsWith("..") && !isAbsolute(localPath)).toBeTruthy();
    expect(new URL(process.env.DATABASE_URL!).pathname).toMatch(/^\/infinite_canvas_e2e_/);
    page.setDefaultTimeout(30000);
    const models = process.env.IMAGE_LIVE_MODELS!.split(",").map((value) => value.trim()).filter(Boolean);
    const baseUrl = process.env.IMAGE_LIVE_BASE_URL!;
    const channel = "live-matrix";
    const results: any[] = [];
    const errors: string[] = [];
    const privateFiles: string[] = [];
    let generationRequests = 0;
    const textPrompt = "A small red ceramic teapot on a pale blue tabletop, soft studio lighting, clean product photograph, square composition, no text.";
    const editPrompt = "Change only the ceramic teapot body and lid to bright yellow. Preserve its shape, composition, pale blue background and lighting. No text.";
    const cleanError = (value: unknown) => String(value instanceof Error ? value.message : value).replaceAll(process.env.IMAGE_LIVE_API_KEY!, "[redacted]").replace(/https?:\/\/\S+/g, "[url]");
    const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    await mkdir(info.outputPath("images"), { recursive: true });
    await page.addInitScript(() => localStorage.setItem("canvas-side-panel-open", "0"));
    page.on("request", (request) => { if (/\/api\/ai\/live-matrix\/images\/(generations|edits)$/.test(new URL(request.url()).pathname)) generationRequests++; });
    page.on("response", (response) => {
        const path = new URL(response.url()).pathname;
        if (path.startsWith(`/api/ai/${channel}/`) || path === "/api/remote-media") console.log(JSON.stringify({ path, status: response.status() }));
    });

    async function configure(model: string) {
        expect((await request.put("/api/config", { data: {
            app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(),
            config: { channels: [{ id: channel, name: "SHUAI matrix", baseUrl, apiFormat: "openai", apiKey: process.env.IMAGE_LIVE_API_KEY, models: models.map((name) => ({ name, capability: "image" })) }], model: `${channel}::${model}`, imageModel: `${channel}::${model}`, models: models.map((name) => `${channel}::${name}`), size: "1024x1024", quality: "auto", count: "1", canvasImageCount: "1", proxyEnabled: false },
            webdav: {}, promptSources: { sources: [], schedule: { intervalMinutes: 0, lastFetchedAt: "" } },
        } })).status()).toBe(200);
    }

    async function generate(model: string, stage: string, edit: boolean, action: () => Promise<void>) {
        const path = `/api/ai/${channel}/images/${edit ? "edits" : "generations"}`;
        const replay = process.env.IMAGE_LIVE_REPLAY_DIR ? await readFile(resolve(process.env.IMAGE_LIVE_REPLAY_DIR, `${model}-${stage}.private.json`), "utf8").then(JSON.parse).catch(() => null) : null;
        if (replay) await page.route(`**${path}`, (route) => route.fulfill({ json: replay }));
        const pending = page.waitForResponse((response) => new URL(response.url()).pathname === path, { timeout: 600000 });
        void pending.catch(() => undefined);
        const started = Date.now();
        console.log(JSON.stringify({ model, stage, event: "starting", replayedResponse: Boolean(replay) }));
        await action();
        const response = await pending;
        const payload = await response.json();
        if (replay) await page.unroute(`**${path}`);
        const result: any = { model, stage, status: response.status(), durationMs: Date.now() - started, replayedResponse: Boolean(replay) };
        results.push(result);
        if (response.status() !== 200) { result.error = cleanError(payload.error?.message || payload.error || payload); throw new Error(result.error); }
        const file = resolve(dataDir, `${model}-${stage}.private.json`);
        await writeFile(file, JSON.stringify(payload), { mode: 0o600 });
        privateFiles.push(file);
        const items = Array.isArray(payload.data) ? payload.data : [payload.data ?? payload];
        result.returnedUrl = items.some((item: any) => typeof item === "string" ? /^https?:/.test(item) : Boolean(item?.url));
        if (edit) {
            result.multipart = response.request().headers()["content-type"]?.startsWith("multipart/form-data");
            expect(result.multipart).toBe(true);
        }
        return result;
    }

    async function verifyMedia(result: any, image: any, headers: Record<string, string>, suffix: string) {
        expect(image.storageKey).toMatch(/^image:/);
        const response = await request.get(`/api/media/blob/${encodeURIComponent(image.storageKey)}`, { headers });
        expect(response.status()).toBe(200);
        const bytes = await response.body();
        expect(bytes.length).toBe(image.bytes);
        expect(response.headers()["content-type"]).toMatch(/^image\//);
        const file = info.outputPath("images", `${result.model}-${suffix}.png`);
        await writeFile(file, bytes);
        Object.assign(result, { width: image.width || image.naturalWidth, height: image.height || image.naturalHeight, bytes: bytes.length, mimeType: response.headers()["content-type"], sha256: hash(bytes), file });
        return { bytes, file };
    }

    async function verifyAsset(key: string, headers: Record<string, string>, nodeId?: string) {
        const saved = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/data/assets" && response.request().method() === "PUT");
        void saved.catch(() => undefined);
        const scope = nodeId ? page.locator(`[data-node-toolbar="${nodeId}"]`) : page;
        await scope.getByRole("button", { name: "加入我的素材", exact: true }).click();
        expect((await saved).status()).toBe(200);
        const assets = await (await request.get("/api/data/assets", { headers })).json();
        expect(assets.payload.state.assets.some((item: any) => item.data?.storageKey === key)).toBe(true);
    }

    async function workbench(model: string, headers: Record<string, string>, reference?: string) {
        await page.goto("/image");
        if (reference) {
            await page.locator('input[type="file"][accept="image/*"]').first().setInputFiles(reference);
            await expect(page.getByRole("region", { name: "参考图", exact: true }).getByRole("img")).toHaveCount(1);
        }
        const prompt = reference ? editPrompt : textPrompt;
        await page.locator("#image-prompt").fill(prompt);
        const saved = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/data/image-workbench" && response.request().method() === "PUT", { timeout: 600000 });
        void saved.catch(() => undefined);
        const result = await generate(model, reference ? "workbench-edit" : "workbench-generation", Boolean(reference), () => page.getByRole("button", { name: "开始生成", exact: true }).click());
        expect((await saved).status()).toBe(200);
        const history = await (await request.get("/api/data/image-workbench", { headers })).json();
        const log = history.payload.logs[0];
        expect(log.status).toBe("success");
        expect(log.references).toHaveLength(reference ? 1 : 0);
        const image = log.images[0];
        const media = await verifyMedia(result, image, headers, result.stage);
        await verifyAsset(image.storageKey, headers);
        await page.reload();
        await page.getByRole("button").filter({ hasText: prompt.slice(0, 12) }).click();
        await expect(page.getByRole("img", { name: "生成结果 1", exact: true })).toBeVisible();
        const restored = await request.get(`/api/media/blob/${encodeURIComponent(image.storageKey)}`, { headers });
        expect(hash(await restored.body())).toBe(result.sha256);
        Object.assign(result, { assetsSaved: true, reloadVerified: true, success: true });
        console.log(JSON.stringify(result));
        return { ...image, file: media.file };
    }

    async function canvas(model: string, headers: Record<string, string>, reference?: any) {
        await page.goto("/image");
        const stage = reference ? "canvas-edit" : "canvas-generation";
        const id = `${model}-${stage}`;
        const now = new Date().toISOString();
        const config = { id: "config", type: "config", title: stage, position: { x: 360, y: 180 }, width: 440, height: 240, metadata: { prompt: reference ? editPrompt : textPrompt, generationMode: "image", model: `${channel}::${model}`, count: 1, size: "1024x1024", quality: "auto" } };
        const nodes: any[] = [config];
        if (reference) nodes.unshift({ id: "reference", type: "image", title: "Reference teapot", position: { x: 0, y: 180 }, width: 280, height: 280, metadata: { status: "success", content: reference.storageKey, storageKey: reference.storageKey, naturalWidth: reference.width, naturalHeight: reference.height, bytes: reference.bytes, mimeType: reference.mimeType } });
        const project = { id, title: id, folderId: null, createdAt: now, updatedAt: now, nodes, connections: reference ? [{ id: "reference-config", fromNodeId: "reference", toNodeId: "config" }] : [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: { x: 70, y: 60, k: 0.7 } };
        const stored = await (await request.get("/api/data/canvas", { headers })).json();
        const payload = stored.payload || { version: 0, state: { projects: [], folders: [], deletedProjects: [] } };
        payload.state.projects.push(project);
        expect((await request.put("/api/data/canvas", { headers, data: { revision: stored.revision, payload } })).status()).toBe(200);
        await page.goto(`/canvas/${id}`);
        const panel = page.locator('[data-node-id="config"]');
        await expect(panel).toBeVisible();
        const mediaSaved = page.waitForResponse((response) => new URL(response.url()).pathname.startsWith("/api/media/blob/") && response.request().method() === "PUT", { timeout: 600000 });
        void mediaSaved.catch(() => undefined);
        const result = await generate(model, stage, Boolean(reference), () => panel.getByRole("button", { name: "开始生成", exact: true }).click());
        expect((await mediaSaved).status()).toBe(200);
        const read = async () => (await (await request.get("/api/data/canvas", { headers })).json()).payload.state.projects.find((item: any) => item.id === id);
        let generated: any;
        await expect.poll(async () => {
            const graph = await read();
            generated = graph.nodes.find((item: any) => item.type === "image" && item.id !== "reference");
            return generated?.metadata?.status;
        }).toBe("success");
        const media = await verifyMedia(result, generated.metadata, headers, stage);
        if (reference) expect(hash(media.bytes)).not.toBe(reference.sha256 || hash(await readFile(reference.file)));
        const output = page.locator(`[data-node-id="${generated.id}"]`);
        await output.click();
        await output.hover();
        await page.screenshot({ path: info.outputPath(`${model}-${stage}-before-save.png`), fullPage: true });
        await verifyAsset(generated.metadata.storageKey, headers, generated.id);
        await page.reload();
        const restored = page.locator(`[data-node-id="${generated.id}"]`);
        await expect(restored).toBeVisible();
        await expect.poll(() => restored.locator("img").first().evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
        const blob = await request.get(`/api/media/blob/${encodeURIComponent(generated.metadata.storageKey)}`, { headers });
        expect(hash(await blob.body())).toBe(result.sha256);
        expect((await read()).connections.some((item: any) => item.fromNodeId === "config" && item.toNodeId === generated.id)).toBe(true);
        await expect(page.locator(".app-loading-overlay")).not.toBeVisible();
        Object.assign(result, { projectSaved: true, assetsSaved: true, reloadVerified: true, success: true });
        await page.screenshot({ path: info.outputPath(`${model}-${stage}.png`), fullPage: true });
        console.log(JSON.stringify(result));
    }

    try {
        for (const model of models) {
            try {
                await configure(model);
                const response = await request.post("/api/workspaces", { data: { name: `SHUAI ${model}` } });
                expect(response.status()).toBe(201);
                const { workspace } = await response.json();
                const headers = { "x-infinite-canvas-workspace": workspace.id };
                await page.goto("/image");
                await page.evaluate((active) => {
                    localStorage.setItem("infinite-canvas:active-workspace", JSON.stringify(active));
                    localStorage.setItem("infinite-canvas:known-workspaces", JSON.stringify([active]));
                }, workspace);
                let source: any;
                if (process.env.IMAGE_LIVE_CANVAS_ONLY === "1") {
                    await page.goto("/image");
                    const bytes = await readFile(process.env.IMAGE_LIVE_REFERENCE!);
                    const uploaded = page.waitForResponse((response) => new URL(response.url()).pathname.startsWith("/api/media/blob/") && response.request().method() === "PUT");
                    void uploaded.catch(() => undefined);
                    await page.locator('input[type="file"][accept="image/*"]').first().setInputFiles(process.env.IMAGE_LIVE_REFERENCE!);
                    const upload = await uploaded;
                    expect(upload.status()).toBe(200);
                    const storageKey = decodeURIComponent(new URL(upload.url()).pathname.split("/").at(-1)!);
                    const dimensions = await page.evaluate(async (key) => {
                        const path = "/src/services/image-storage.ts";
                        const { resolveImageUrl } = await import(path);
                        const image = new Image();
                        image.src = await resolveImageUrl(key);
                        await image.decode();
                        return { width: image.naturalWidth, height: image.naturalHeight };
                    }, storageKey);
                    source = { storageKey, ...dimensions, bytes: bytes.length, mimeType: "image/png", file: process.env.IMAGE_LIVE_REFERENCE };
                } else source = await workbench(model, headers, model === "gpt-image-2" ? process.env.IMAGE_LIVE_REFERENCE : undefined);
                if (model === "gpt-image-2") await canvas(model, headers);
                await canvas(model, headers, source);
            } catch (error) {
                const message = `${model}: ${cleanError(error)}`;
                errors.push(message);
                console.log(JSON.stringify({ model, error: message }));
                await page.screenshot({ path: info.outputPath(`${model}-failure.png`), fullPage: true }).catch(() => undefined);
            }
            await writeFile(info.outputPath("matrix-result.json"), JSON.stringify({ baseUrl, models, generationRequests, results, errors }, null, 2));
        }
        expect(errors).toEqual([]);
    } finally {
        await page.close();
        for (const file of [...privateFiles, resolve(dataDir, "config.json")]) await unlink(file).catch((error) => { if (error.code !== "ENOENT") throw error; });
    }
});
