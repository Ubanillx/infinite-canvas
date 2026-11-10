import http, { createServer, type RequestListener } from "node:http";
import { Readable } from "node:stream";
import { expect, test } from "bun:test";

import { getWebdavStream, listWebdavDirectory, putWebdavBuffer, putWebdavStream, type WebdavConfig } from "../src/server/webdav-client";

async function withDav(handler: RequestListener, run: (config: WebdavConfig & { signal: AbortSignal }, controller: AbortController) => Promise<void>) {
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fake WebDAV did not bind");
    const controller = new AbortController();
    try {
        await run({ target: new URL(`http://127.0.0.1:${address.port}/`), directory: "", authorization: "Basic fixture", signal: controller.signal }, controller);
    } finally {
        controller.abort();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}

async function within<T>(promise: Promise<T>) {
    let timer: ReturnType<typeof setTimeout>;
    try {
        return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("request remained stuck")), 500); })]);
    } finally { clearTimeout(timer!); }
}

test("cancelling a WebDAV request waiting for response headers rejects immediately", async () => {
    let received!: () => void;
    const waiting = new Promise<void>((resolve) => { received = resolve; });
    await withDav((req) => { req.resume(); received(); }, async (config, controller) => {
        const pending = listWebdavDirectory(config, "snapshots").then(() => "succeeded", () => "cancelled");
        await waiting;
        controller.abort();
        expect(await within(pending)).toBe("cancelled");
    });
});

test("cancelling a WebDAV download interrupts a stalled response body", async () => {
    await withDav((req, res) => { req.resume(); res.writeHead(200, { "content-length": 100 }); res.write("partial"); }, async (config, controller) => {
        const file = await getWebdavStream(config, "object");
        const pending = (async () => { try { for await (const _ of file!.stream) {} return "succeeded"; } catch { return "cancelled"; } })();
        controller.abort();
        expect(await within(pending)).toBe("cancelled");
    });
});

test("cancelling a WebDAV upload destroys the source stream as well as the request", async () => {
    let received!: () => void;
    const waiting = new Promise<void>((resolve) => { received = resolve; });
    const source = new Readable({ read() { received(); } });
    await withDav((req, res) => {
        req.resume();
        if (req.method === "MKCOL") res.writeHead(201).end();
        else received();
    }, async (config, controller) => {
        const pending = putWebdavStream(config, "dir/object", source, "application/octet-stream", 100).then(() => "succeeded", () => "cancelled");
        source.push("partial");
        await waiting;
        controller.abort();
        expect(await within(pending)).toBe("cancelled");
        expect(source.destroyed).toBe(true);
    });
});

test("successful WebDAV writes consume response bodies and release limited connections", async () => {
    const previous = http.globalAgent.maxSockets;
    http.globalAgent.maxSockets = 1;
    try {
        await withDav((req, res) => { req.resume(); res.writeHead(201); res.end(Buffer.alloc(128 * 1024)); }, async (config) => {
            await within((async () => {
                await putWebdavBuffer(config, "dir/first", Buffer.from("first"));
                await putWebdavBuffer(config, "dir/second", Buffer.from("second"));
            })());
        });
    } finally { http.globalAgent.maxSockets = previous; }
});

test("WebDAV upload waits for the response body to finish instead of reporting success at headers", async () => {
    let respond!: () => void;
    let received!: () => void;
    const waiting = new Promise<void>((resolve) => { received = resolve; });
    await withDav((req, res) => {
        req.resume();
        if (req.method === "MKCOL") { res.writeHead(201).end(); return; }
        res.writeHead(201, { "content-length": 100 }); res.write("partial");
        respond = () => res.end(Buffer.alloc(93));
        received();
    }, async (config) => {
        let completed = false;
        const pending = putWebdavBuffer(config, "dir/object", Buffer.from("fixture")).then(() => { completed = true; });
        await waiting;
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(completed).toBe(false);
        respond();
        await within(pending);
        expect(completed).toBe(true);
    });
});

test("a failed upload source rejects the request instead of leaving a pipe waiting forever", async () => {
    const source = new Readable({ read() { this.destroy(new Error("source failed")); } });
    await withDav((req, res) => { req.resume(); if (req.method === "MKCOL") res.writeHead(201).end(); }, async (config) => {
        await expect(within(putWebdavStream(config, "dir/object", source, "application/octet-stream", 100))).rejects.toThrow("source failed");
    });
});

