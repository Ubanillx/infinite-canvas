import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ServerResponse } from "node:http";

export async function forwardAiResponse(upstream: Response, res: ServerResponse) {
    // fetch decodes compressed bodies; the upstream byte count is no longer valid.
    res.removeHeader("content-length");
    res.removeHeader("content-encoding");
    if (!upstream.body) { res.end(); return; }
    // Bun 1.3.13's fromWeb bridge leaks errors from interrupted response bodies.
    await pipeline(Readable.from(upstream.body as unknown as AsyncIterable<Uint8Array>, { objectMode: false }), res);
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
