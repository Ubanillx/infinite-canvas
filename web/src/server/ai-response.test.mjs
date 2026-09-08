import assert from "node:assert/strict";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { forwardAiResponse, failAiResponse } from "./ai-response.ts";

async function listen(server) {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    return `http://127.0.0.1:${address.port}`;
}

test("compressed upstream response has the correct decoded body and no stale length", async () => {
    const payload = JSON.stringify({ image: "a".repeat(100000) });
    const compressed = gzipSync(payload);
    const upstream = createServer((_req, res) => {
        res.writeHead(200, { "content-encoding": "gzip", "content-length": compressed.length });
        res.end(compressed);
    });
    const upstreamUrl = await listen(upstream);
    const proxy = createServer(async (_req, res) => {
        try {
            const response = await fetch(upstreamUrl);
            res.setHeader("content-length", response.headers.get("content-length"));
            await forwardAiResponse(response, res);
        } catch { failAiResponse(res); }
    });
    try {
        const response = await fetch(await listen(proxy));
        assert.equal(response.headers.get("content-length"), null);
        assert.equal(await response.text(), payload);
    } finally { proxy.closeAllConnections(); proxy.close(); upstream.closeAllConnections(); upstream.close(); }
});

test("mid-body failure closes only that request; a later request still succeeds", async () => {
    let count = 0;
    const proxy = createServer(async (_req, res) => {
        try {
            if (count++ > 0) { res.end("healthy"); return; }
            const body = new ReadableStream({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode("partial"));
                    setTimeout(() => controller.error(new Error("upstream disconnected")), 30);
                },
            });
            await forwardAiResponse(new Response(body), res);
        } catch { failAiResponse(res); }
    });
    try {
        const url = await listen(proxy);
        await assert.rejects(async () => { const res = await fetch(url); await res.text(); });
        assert.equal(await (await fetch(url)).text(), "healthy");
    } finally { proxy.closeAllConnections(); proxy.close(); }
});

test("failure before headers returns readable JSON 502", async () => {
    const proxy = createServer((_req, res) => {
        res.setHeader("content-length", "9000");
        failAiResponse(res);
    });
    try {
        const response = await fetch(await listen(proxy));
        assert.equal(response.status, 502);
        assert.match((await response.json()).error, /connection failed/);
    } finally { proxy.closeAllConnections(); proxy.close(); }
});
