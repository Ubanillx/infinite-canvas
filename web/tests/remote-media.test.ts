import { afterEach, expect, spyOn, test } from "bun:test";
import * as dns from "node:dns/promises";
import * as https from "node:https";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { openRemoteMedia } from "../src/server/remote-media";

afterEach(() => {
    dns.lookup.mockRestore?.();
    https.request.mockRestore?.();
});

function mockDownloads(replies: Array<{ status?: number; location?: string; type?: string; body?: string }>) {
    const requests: Array<{ url: URL; options: https.RequestOptions }> = [];
    spyOn(dns, "lookup").mockImplementation(async () => [{ address: "8.8.8.8", family: 4 }] as any);
    spyOn(https, "request").mockImplementation(((url: URL, options: https.RequestOptions, callback: (response: IncomingMessage) => void) => {
        requests.push({ url, options });
        const reply = replies.shift()!;
        const request = new EventEmitter() as EventEmitter & { end: () => void };
        request.end = () => {
            const response = Object.assign(Readable.from([reply.body || ""]), { statusCode: reply.status || 200, headers: { location: reply.location, "content-type": reply.type || "image/png" } });
            callback(response as unknown as IncomingMessage);
        };
        return request;
    }) as typeof https.request);
    return requests;
}

test("temporary media follows relative and cross-host redirects without losing signatures", async () => {
    const requests = mockDownloads([
        { status: 302, location: "/download?signature=a%2Bb&expires=123" },
        { status: 307, location: "https://storage.example/result?signature=c%2Fd" },
        { type: "application/octet-stream", body: "image bytes" },
    ]);
    const response = await openRemoteMedia(new URL("https://provider.example/image"), new AbortController().signal);
    expect(requests.map(({ url }) => url.href)).toEqual(["https://provider.example/image", "https://provider.example/download?signature=a%2Bb&expires=123", "https://storage.example/result?signature=c%2Fd"]);
    expect(dns.lookup).toHaveBeenCalledTimes(3);
    for (const { options } of requests) {
        expect(options.headers).toBeUndefined();
        options.lookup!("provider.example", {} as any, ((error: unknown, address: string) => {
            expect(error).toBeNull();
            expect(address).toBe("8.8.8.8");
        }) as any);
    }
    expect(response.headers["content-type"]).toBe("application/octet-stream");
    let body = "";
    for await (const chunk of response) body += chunk;
    expect(body).toBe("image bytes");
});

test("redirects to private addresses are rejected before a second connection", async () => {
    const requests = mockDownloads([{ status: 302, location: "https://internal.example/private" }]);
    spyOn(dns, "lookup").mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }] as any).mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }] as any);
    await expect(openRemoteMedia(new URL("https://provider.example/image"), new AbortController().signal)).rejects.toThrow("目标地址不是公网地址");
    expect(requests).toHaveLength(1);
});

test("pinned DNS lookup returns an address array when the runtime requests all addresses", async () => {
    const requests = mockDownloads([{ body: "image" }]);
    const response = await openRemoteMedia(new URL("https://provider.example/image"), new AbortController().signal);
    requests[0].options.lookup!("provider.example", { all: true }, (error, addresses, family) => {
        expect(error).toBeNull();
        expect(addresses).toEqual([{ address: "8.8.8.8", family: 4 }]);
        expect(family).toBeUndefined();
    });
    response.destroy();
});

test("redirects reject HTTP, embedded credentials, and nonstandard ports", async () => {
    for (const location of ["http://storage.example/image", "https://user@storage.example/image", "https://storage.example:8443/image"]) {
        const requests = mockDownloads([{ status: 302, location }]);
        await expect(openRemoteMedia(new URL("https://provider.example/image"), new AbortController().signal)).rejects.toThrow("仅支持公网 HTTPS 地址");
        expect(requests).toHaveLength(1);
    }
});

test("redirect cycles and missing locations fail explicitly", async () => {
    mockDownloads([{ status: 302, location: "/image#fragment" }]);
    await expect(openRemoteMedia(new URL("https://provider.example/image"), new AbortController().signal)).rejects.toThrow("重定向循环");
    mockDownloads([{ status: 302 }]);
    await expect(openRemoteMedia(new URL("https://provider.example/image"), new AbortController().signal)).rejects.toThrow("缺少下载地址");
});

test("expired downloads preserve their status and cancellation reaches the request", async () => {
    const requests = mockDownloads([{ status: 403, type: "application/json", body: '{"error":"expired"}' }]);
    const controller = new AbortController();
    const response = await openRemoteMedia(new URL("https://provider.example/image"), controller.signal);
    expect(response.statusCode).toBe(403);
    expect(requests[0].options.signal).toBe(controller.signal);
    response.destroy();
    controller.abort();
    await expect(openRemoteMedia(new URL("https://provider.example/image"), controller.signal)).rejects.toThrow();
    expect(requests).toHaveLength(1);
});
