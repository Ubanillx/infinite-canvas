import { readFile } from "node:fs/promises";
import { request, type IncomingMessage, type ServerResponse } from "node:http";

export const canvasAgentProxyPath = "/api/canvas-agent";

/** Read credentials for each request: the Agent may start or rotate its token after Web. */
export async function forwardCanvasAgent(req: IncomingMessage, res: ServerResponse, configFile: string) {
    let target: URL;
    let token: string;
    try {
        const config = JSON.parse(await readFile(configFile, "utf8"));
        target = new URL(config.url);
        token = config.token;
        if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || !token) throw new Error("Invalid Agent config");
    } catch {
        return unavailable(res);
    }
    const url = new URL(req.url || "/", "http://localhost");
    url.searchParams.delete("token");
    const headers = { ...req.headers, "x-canvas-agent-token": token, host: target.host };
    delete headers.cookie;
    delete headers.authorization;
    const upstream = request(target, { method: req.method, path: `${url.pathname.slice(canvasAgentProxyPath.length) || "/"}${url.search}`, headers }, (response) => {
        res.writeHead(response.statusCode || 502, response.headers);
        response.on("error", () => res.destroy());
        response.pipe(res);
    });
    upstream.on("error", () => { if (!res.headersSent) unavailable(res); else res.destroy(); });
    res.on("close", () => upstream.destroy());
    req.on("aborted", () => upstream.destroy());
    req.pipe(upstream);
}

function unavailable(res: ServerResponse) {
    res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Canvas Agent 未启动，请运行 npm run dev 或 npm run dev:agent 后重新连接" }));
}
