import { lookup } from "node:dns/promises";
import type { IncomingMessage } from "node:http";
import { request, type RequestOptions } from "node:https";
import ipaddr from "ipaddr.js";

export class RemoteMediaError extends Error {
    constructor(message: string, public status = 502) { super(message); }
}

export async function publicHttpsAddress(target: URL) {
    if (target.protocol !== "https:" || target.username || target.password || (target.port && target.port !== "443")) throw new RemoteMediaError("仅支持公网 HTTPS 地址", 403);
    const addresses = await lookup(target.hostname, { all: true });
    if (!addresses.length || addresses.some(({ address }) => ipaddr.process(address).range() !== "unicast")) throw new RemoteMediaError("目标地址不是公网地址", 403);
    return addresses[0];
}

/** 临时下载链接逐跳校验并固定 DNS 地址，不转发会话或渠道凭据。 */
export async function openRemoteMedia(target: URL, signal: AbortSignal): Promise<IncomingMessage> {
    const visited = new Set<string>();
    for (;;) {
        signal.throwIfAborted();
        target.hash = "";
        if (visited.has(target.href)) throw new RemoteMediaError("远程媒体重定向循环");
        visited.add(target.href);
        const address = await publicHttpsAddress(target);
        const response = await new Promise<IncomingMessage>((resolve, reject) => {
            const upstream = request(target, {
                signal,
                autoSelectFamily: false,
                // Bun 仍可能传入 all: true，须按 DNS 回调约定返回地址数组。
                lookup: (_hostname, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family),
            } as RequestOptions & { autoSelectFamily?: boolean }, resolve);
            upstream.on("error", reject);
            upstream.end();
        });
        if (![301, 302, 303, 307, 308].includes(response.statusCode || 0)) return response;
        const location = response.headers.location;
        response.destroy();
        if (!location) throw new RemoteMediaError("远程媒体重定向缺少下载地址");
        target = new URL(location, target);
    }
}
