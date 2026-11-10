import { afterEach, expect, test } from "bun:test";
import { requestGenerationProvider } from "../src/server/generation-provider";
import { GENERATION_IMAGE_LIMIT, GENERATION_JSON_LIMIT_BYTES, GENERATION_MEDIA_LIMIT_BYTES, readGenerationBytes } from "../src/server/generation-media";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

for (const [mime, length] of [["video/mp4", GENERATION_MEDIA_LIMIT_BYTES + 1], ["application/json", GENERATION_JSON_LIMIT_BYTES + 1]] as const) {
    test(`provider rejects declared oversized ${mime} before consuming its body`, async () => {
        let cancelled = false;
        globalThis.fetch = async () => new Response(new ReadableStream({
            start(controller) { controller.enqueue(new Uint8Array([1])); },
            cancel() { cancelled = true; },
        }), { headers: { "content-type": mime, "content-length": String(length) } });
        await expect(requestGenerationProvider(new URL("https://fixture.invalid/result"), { method: "GET", headers: {} })).rejects.toThrow("大小");
        expect(cancelled).toBe(true);
    });
}

test("JSON encoding budget covers the existing full image batch without lowering each image boundary", () => {
    expect(GENERATION_JSON_LIMIT_BYTES).toBeGreaterThan(Math.ceil(GENERATION_MEDIA_LIMIT_BYTES / 3) * 4 * GENERATION_IMAGE_LIMIT);
});

test("chunked response stops reading on the first chunk that exceeds the existing boundary", async () => {
    let reads = 0;
    let cancelled = false;
    async function* chunks() {
        try { while (true) { reads++; yield new Uint8Array([1, 2, 3]); } }
        finally { cancelled = true; }
    }
    await expect(readGenerationBytes(chunks(), 5)).rejects.toThrow("大小");
    expect(reads).toBe(2);
    expect(cancelled).toBe(true);
});

test("exact boundary is accepted and inaccurate short Content-Length does not bypass counting", async () => {
    async function* chunks() { yield new Uint8Array([1, 2]); yield new Uint8Array([3, 4, 5]); }
    expect(await readGenerationBytes(chunks(), 5)).toEqual(Buffer.from([1, 2, 3, 4, 5]));
    await expect(readGenerationBytes(chunks(), 4, 1)).rejects.toThrow("大小");
});
