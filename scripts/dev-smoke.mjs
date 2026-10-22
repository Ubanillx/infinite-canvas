import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { runDataDir, timestampDir } from "./lib/dev-env.mjs";
import { requestJson } from "./lib/dev-http.mjs";
import { printLogSummary, startDevServer } from "./dev-run.mjs";

const flag = (name, fallback) => {
    const index = process.argv.indexOf(`--${name}`);
    return index > 0 ? process.argv[index + 1] : fallback;
};

const runDir = timestampDir("smoke");
let server = null;
let baseUrl = flag("url", "");
if (!baseUrl) {
    server = await startDevServer({ port: Number(flag("port", 3102)), dataDir: runDataDir(runDir), logFile: resolve(runDir, "server.jsonl"), quiet: true });
    baseUrl = server.baseUrl;
}
console.log(`Smoke target: ${baseUrl}`);

let failed = 0;
const check = async (name, run) => {
    try {
        await run();
        console.log(`  ok   ${name}`);
    } catch (error) {
        failed++;
        console.error(`  FAIL ${name}\n       ${error.message}`);
    }
};
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const workspaces = [];

try {
    await check("GET /api/workspaces returns a list", async () => {
        const response = await requestJson(`${baseUrl}/api/workspaces`);
        assert(response.status === 200, `unexpected status ${response.status}`);
        assert(Array.isArray(response.data?.workspaces), "workspaces is not an array");
    });

    await check("POST /api/workspaces creates isolated workspaces", async () => {
        for (const suffix of ["a", "b"]) {
            const response = await requestJson(`${baseUrl}/api/workspaces`, { method: "POST", body: { name: `smoke-${Date.now()}-${suffix}` } });
            assert(response.status === 201, `unexpected status ${response.status}`);
            workspaces.push(response.data.workspace.id);
        }
    });

    await check("GET /api/data/canvas requires a workspace header", async () => {
        const response = await requestJson(`${baseUrl}/api/data/canvas`);
        assert(response.status === 403, `expected 403, got ${response.status}`);
    });

    await check("workspace data round-trips and isolates workspaces", async () => {
        const headers = { "x-infinite-canvas-workspace": workspaces[0] };
        const write = await requestJson(`${baseUrl}/api/data/canvas`, { method: "PUT", headers, body: { revision: 0, payload: { marker: "smoke" } } });
        assert(write.status === 200 && write.data.revision === 1, `write failed: ${write.status} ${write.text}`);
        const read = await requestJson(`${baseUrl}/api/data/canvas`, { headers });
        assert(read.data?.payload?.marker === "smoke", "payload was not persisted");
        const stale = await requestJson(`${baseUrl}/api/data/canvas`, { method: "PUT", headers, body: { revision: 0, payload: { marker: "stale" } } });
        assert(stale.status === 409, `expected 409 on stale revision, got ${stale.status}`);
        const other = await requestJson(`${baseUrl}/api/data/canvas`, { headers: { "x-infinite-canvas-workspace": workspaces[1] } });
        assert(other.data?.payload === null, "workspaces are not isolated");
    });

    for (const route of (flag("routes", "/,/canvas,/assets,/image,/video,/prompts") || "").split(",").filter(Boolean)) {
        await check(`GET ${route} returns the SPA shell`, async () => {
            const response = await fetch(`${baseUrl}${route}`, { headers: { accept: "text/html" } });
            const html = await response.text();
            assert(response.status === 200, `unexpected status ${response.status}`);
            assert(html.includes('id="root"'), "SPA root element missing");
        });
    }
} finally {
    if (server) await server.stop();
}

const summaryFile = resolve(runDir, "summary.json");
writeFileSync(summaryFile, `${JSON.stringify({ baseUrl, failed, workspaces, log: server?.logFile || null }, null, 2)}\n`);
if (server?.logFile && existsSync(server.logFile)) printLogSummary(server.logFile);
console.log(`\nSmoke ${failed ? `failed: ${failed} check(s)` : "passed"}; artifacts: ${runDir}`);
process.exitCode = failed ? 1 : 0;
