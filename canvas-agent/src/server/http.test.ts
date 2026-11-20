import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

import { CanvasSession } from "../canvas/session.js";
import { registerCanvasConnectionRoutes, runtimeWorkspaceId, setCors } from "./http.js";

test("requests without a workspace ID use site even after a workspace request", () => {
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    assert.equal(runtimeWorkspaceId({ headers: { "x-infinite-canvas-workspace": workspaceId }, query: {} }), workspaceId);
    assert.equal(runtimeWorkspaceId({ headers: {}, query: {} }), "site");
    assert.equal(runtimeWorkspaceId({ headers: {}, query: { workspaceId } }), workspaceId);
    assert.equal(runtimeWorkspaceId({ headers: {}, query: { workspaceId: "invalid" } }), "site");
});

test("cross-origin workspace state preflight allows its workspace header", async (t) => {
    const app = express();
    const config = { url: "http://127.0.0.1", token: "test-token" };
    app.use((req, res) => {
        if (!setCors(req, res, new URL(req.url, config.url), config)) return void res.sendStatus(403);
        res.status(req.method === "OPTIONS" ? 200 : 404).end();
    });
    const server = app.listen(0, "127.0.0.1");
    t.after(() => server.close());
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const response = await fetch(`http://127.0.0.1:${address.port}/canvas/state`, {
        method: "OPTIONS",
        headers: {
            Origin: "http://localhost:3000",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,x-infinite-canvas-workspace",
        },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:3000");
    assert.equal(response.headers.get("access-control-allow-methods")?.toLowerCase().includes("post"), true);
    assert.equal(response.headers.get("access-control-allow-headers")?.toLowerCase().split(",").includes("x-infinite-canvas-workspace"), true);
});

test("HTTP canvas state and receipts enforce connection generations and accept the original receipt after reconnect", async (t) => {
    const session = new CanvasSession();
    const first = new EventEmitter() as EventEmitter & { writes: string[]; writeHead: () => void; write: (data: string) => void; end: () => void };
    first.writes = [];
    first.writeHead = () => undefined;
    first.write = (data) => { first.writes.push(data); };
    first.end = () => first.emit("close");
    session.openEvents(new URL("http://localhost/events?clientId=tab"), first as unknown as ServerResponse);
    t.after(() => first.end());
    const firstId = JSON.parse(first.writes.find((data) => data.startsWith("event: hello"))!.split("data: ")[1])?.connectionId;
    const app = express();
    app.use(express.json());
    registerCanvasConnectionRoutes(app, session);
    const server = app.listen(0, "127.0.0.1");
    t.after(() => server.close());
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const url = `http://127.0.0.1:${address.port}`;
    const post = (path: string, body: unknown) => fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const snapshot = { hasCanvas: true, projectId: "old", nodes: [] };
    assert.equal(session.isClientReady("tab", firstId), false);
    assert.equal((await post(`/canvas/state?clientId=tab&connectionId=${firstId}&stateRevision=1`, snapshot)).status, 200);
    assert.equal(session.isClientReady("tab", firstId), true);
    const pending = session.callTool("canvas_create_text_node", { text: "once" });
    const call = JSON.parse(first.writes.find((data) => data.startsWith("event: tool_call"))!.split("data: ")[1]);
    const second = new EventEmitter() as typeof first;
    second.writes = [];
    second.writeHead = () => undefined;
    second.write = (data) => { second.writes.push(data); };
    second.end = () => second.emit("close");
    session.openEvents(new URL("http://localhost/events?clientId=tab"), second as unknown as ServerResponse);
    t.after(() => second.end());
    const secondId = JSON.parse(second.writes.find((data) => data.startsWith("event: hello"))!.split("data: ")[1])?.connectionId;
    assert.equal(session.isClientReady("tab", secondId), false);
    assert.equal((await post(`/canvas/state?clientId=tab&connectionId=${firstId}&stateRevision=2`, { ...snapshot, projectId: "stale" })).status, 409);
    assert.equal((await post(`/canvas/activate?clientId=tab&connectionId=${firstId}`, {})).status, 409);
    assert.equal((await post(`/canvas/state?clientId=tab&connectionId=${secondId}&stateRevision=1`, { ...snapshot, projectId: "new" })).status, 200);
    assert.equal(session.isClientReady("tab", secondId), true);
    const superseded = await post(`/canvas/state?clientId=tab&connectionId=${secondId}&stateRevision=1`, { ...snapshot, projectId: "late" });
    assert.equal(superseded.status, 409);
    assert.deepEqual(await superseded.json(), { ok: false, connectionId: secondId, stateRevision: 1, ready: true, code: "STATE_SUPERSEDED", error: "画布连接已更换或状态上报顺序已过期" });
    assert.equal(session.canvasStateForClient("tab")?.projectId, "new");
    assert.equal((await post("/canvas/result?clientId=tab", { requestId: call.requestId, connectionId: secondId, result: { saved: true } })).status, 409);
    assert.equal((await post("/canvas/result?clientId=tab", { requestId: call.requestId, connectionId: firstId, result: { saved: true } })).status, 200);
    assert.deepEqual(await pending, { saved: true });
    assert.equal((await post("/canvas/result?clientId=tab", { requestId: call.requestId, connectionId: firstId, result: { saved: true } })).status, 200);
    assert.deepEqual(await (await fetch(`${url}/canvas/result?clientId=tab&connectionId=${firstId}&requestId=${call.requestId}`)).json(), { ok: true, status: "completed", requestId: call.requestId, result: { saved: true } });
});

test("HTTP does not acknowledge an uncommitted tool result and restores the committed receipt after Agent restart", async (t) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-http-receipt-"));
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const session = new CanvasSession("", "codex", workspace);
    const page = new EventEmitter() as EventEmitter & { writes: string[]; writeHead: () => void; write: (data: string) => void; end: () => void };
    page.writes = [];
    page.writeHead = () => undefined;
    page.write = (chunk) => { page.writes.push(chunk); };
    page.end = () => page.emit("close");
    session.openEvents(new URL("http://localhost/events?clientId=tab"), page as unknown as ServerResponse);
    t.after(() => page.end());
    const pending = session.callTool("canvas_create_text_node", { text: "once" });
    let fulfilled = false;
    void pending.then(() => { fulfilled = true; });
    const call = JSON.parse(page.writes.find((chunk) => chunk.startsWith("event: tool_call"))!.split("data: ")[1]);
    const { requestId, connectionId } = call as { requestId: string; connectionId: string };
    const serve = async (current: CanvasSession) => {
        const app = express();
        app.use(express.json());
        registerCanvasConnectionRoutes(app, current);
        app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
            assert.ok(error instanceof Error);
            res.status(500).json({ ok: false });
        });
        const server = app.listen(0, "127.0.0.1");
        t.after(() => server.close());
        if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Expected TCP address");
        return `http://127.0.0.1:${address.port}`;
    };
    const url = await serve(session);
    const body = { requestId, connectionId, result: { saved: true } };
    const post = (endpoint: string) => fetch(`${endpoint}/canvas/result?clientId=tab`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const originalRename = fsSync.renameSync;
    const failure = t.mock.method(fsSync, "renameSync", (source: fsSync.PathLike, destination: fsSync.PathLike) => {
        if (String(destination).endsWith(`${requestId}.json`)) throw new Error("disk commit failed");
        return originalRename(source, destination);
    });
    assert.equal((await post(url)).status, 500);
    assert.equal(fulfilled, false);
    assert.equal(session.toolResult("tab", connectionId, requestId).status, "pending");
    assert.equal(new CanvasSession("", "codex", workspace).toolResult("tab", connectionId, requestId).status, "unknown");
    failure.mock.restore();
    assert.equal((await post(url)).status, 200);
    assert.deepEqual(await pending, { saved: true });
    const restored = new CanvasSession("", "codex", workspace);
    const restartedUrl = await serve(restored);
    assert.deepEqual(await (await fetch(`${restartedUrl}/canvas/result?clientId=tab&connectionId=${connectionId}&requestId=${requestId}`)).json(), { ok: true, status: "completed", requestId, result: { saved: true } });
    assert.equal((await post(restartedUrl)).status, 200);
    assert.equal(restored.resolveResult("tab", { ...body, result: { saved: false } }), false);
});
