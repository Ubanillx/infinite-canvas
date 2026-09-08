import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ServerResponse } from "node:http";

export async function forwardAiResponse(upstream: Response, res: ServerResponse) {
    // fetch decodes compressed bodies; the upstream byte count is no longer valid.
    res.removeHeader("content-length");
    res.removeHeader("content-encoding");
    if (!upstream.body) { res.end(); return; }
    await pipeline(Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]), res);
}

export function failAiResponse(res: ServerResponse) {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) { res.destroy(); return; }
    res.removeHeader("content-length");
    res.removeHeader("content-encoding");
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "AI provider connection failed or was interrupted" }));
}
