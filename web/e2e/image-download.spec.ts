import { test, expect } from "./auth";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
const downloadUrl = "https://downloads.example/generated?signature=a%2Bb&expires=123";

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
