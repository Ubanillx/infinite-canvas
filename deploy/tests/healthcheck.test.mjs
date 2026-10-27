import assert from "node:assert/strict";
import { test } from "node:test";

const page = '<div id="root"></div><script type="module" src="/assets/app.js"></script>';
for (const scenario of ["healthy", "missing-page", "missing-asset", "database-error", "legacy-auth-401", "agent-error", "network-error"]) {
    test(scenario, async () => {
        const original = globalThis.fetch;
        const oldExit = process.exitCode;
        const log = console.error;
        const errors = [];
        console.error = (message) => errors.push(message);
        globalThis.fetch = async (url) => {
            if (scenario === "network-error") throw new Error("connection refused");
            const path = new URL(url).pathname;
            if (path === "/") return new Response(scenario === "missing-page" ? "" : page);
            if (path === "/assets/app.js") return new Response("// js", { headers: { "content-type": scenario === "missing-asset" ? "text/html" : "text/javascript" } });
            if (path === "/api/auth/me") return Response.json(
                scenario === "database-error" ? { error: "database unavailable" } : scenario === "legacy-auth-401" ? { error: "尚未登录" } : { user: null, workspaces: [] },
                { status: scenario === "database-error" ? 500 : scenario === "legacy-auth-401" ? 401 : 200 },
            );
            if (path === "/api/canvas-agent/health") return Response.json({ ok: scenario !== "agent-error" });
            throw new Error(`Unexpected URL: ${url}`);
        };
        try {
            process.exitCode = 0;
            await import(`../healthcheck.mjs?test=${scenario}`);
            assert.equal(process.exitCode, scenario === "healthy" ? 0 : 1);
            assert.equal(errors.length, scenario === "healthy" ? 0 : 1);
        } finally {
            globalThis.fetch = original;
            console.error = log;
            process.exitCode = oldExit;
        }
    });
}
