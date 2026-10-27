import { expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forwardCanvasAgent } from "../src/server/canvas-agent-gateway";

async function listen(server: Server) {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

test("gateway reads the current port/token, strips browser credentials, and streams SSE", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canvas-agent-gateway-"));
    const file = join(dir, "config.json");
    const seen: Array<{ token: unknown; cookie: unknown; authorization: unknown; url: string }> = [];
    const upstream = createServer((req, res) => {
        seen.push({ token: req.headers["x-canvas-agent-token"], cookie: req.headers.cookie, authorization: req.headers.authorization, url: req.url! });
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("event: hello\ndata: {}\n\n");
        res.end("event: ready\ndata: {}\n\n");
    });
    const target = await listen(upstream);
    const gateway = createServer((req, res) => { void forwardCanvasAgent(req, res, file); });
    const base = await listen(gateway);
    try {
        for (const token of ["first", "rotated"]) {
            await writeFile(file, JSON.stringify({ url: target, token }));
            const response = await fetch(`${base}/api/canvas-agent/events?token=browser&workspaceId=abc`, { headers: { cookie: "private=session", authorization: "Bearer private", "x-canvas-agent-token": "forged" } });
            expect(await response.text()).toContain("event: ready");
            expect(seen.at(-1)).toEqual({ token, cookie: undefined, authorization: undefined, url: "/events?workspaceId=abc" });
        }
        await writeFile(file, "{}");
        expect((await fetch(`${base}/api/canvas-agent/health`)).status).toBe(503);
    } finally {
        gateway.closeAllConnections();
        upstream.closeAllConnections();
        await Promise.all([new Promise((resolve) => gateway.close(resolve)), new Promise((resolve) => upstream.close(resolve))]);
        await rm(dir, { recursive: true });
    }
});
