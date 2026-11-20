import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CanvasSession } from "./session.js";

test("settled tool receipts survive Agent restart and conversation changes without another tool call", async (t) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-receipts-restart-"));
    const otherWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-receipts-other-"));
    t.after(async () => {
        await fs.rm(workspace, { recursive: true, force: true });
        await fs.rm(otherWorkspace, { recursive: true, force: true });
    });
    const original = new CanvasSession("thread-a", "codex", workspace);
    const page = connect(original, "tab");
    t.after(() => page.close());

    const done = original.callTool("canvas_create_text_node", { text: "created once" });
    const doneCall = page.events("tool_call").at(-1)!;
    const doneId = String(doneCall.requestId);
    const connectionId = String(doneCall.connectionId);
    assert.equal(original.resolveResult("tab", { requestId: doneId, connectionId, result: { nodeId: "saved" } }), true);
    assert.deepEqual(await done, { nodeId: "saved" });

    const failed = original.callTool("canvas_create_text_node", { text: "failed once" });
    const failedCall = page.events("tool_call").at(-1)!;
    const failedId = String(failedCall.requestId);
    assert.equal(original.resolveResult("tab", { requestId: failedId, connectionId, error: "rejected" }), true);
    await assert.rejects(failed, /rejected/);
    original.activateConversation("thread-b");

    const restored = new CanvasSession("thread-b", "codex", workspace);
    const newPage = connect(restored, "tab");
    t.after(() => newPage.close());
    assert.deepEqual(restored.toolResult("tab", connectionId, doneId), { status: "completed", requestId: doneId, result: { nodeId: "saved" } });
    assert.deepEqual(await restored.callTool("canvas_get_tool_result", { requestId: failedId }), { status: "failed", requestId: failedId, error: "rejected" });
    assert.equal(restored.resolveResult("tab", { requestId: doneId, connectionId, result: { nodeId: "saved" } }), true);
    assert.equal(restored.resolveResult("tab", { requestId: doneId, connectionId, result: { nodeId: "different" } }), false);
    assert.equal(restored.resolveResult("other-client", { requestId: doneId, connectionId, result: { nodeId: "saved" } }), false);
    assert.equal(restored.resolveResult("tab", { requestId: doneId, connectionId: String(newPage.event("hello")?.connectionId), result: { nodeId: "saved" } }), false);
    assert.equal(newPage.events("tool_call").length, 0);
    assert.deepEqual(new CanvasSession("", "codex", otherWorkspace).toolResult("tab", connectionId, doneId), { status: "not_found", requestId: doneId });
});

test("a request persisted before dispatch becomes unknown after restart and accepts its original late result", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-receipts-pending-"));
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const original = new CanvasSession("thread-a", "codex", workspace);
    const first = connect(original, "tab");
    t.after(() => first.close());
    const pending = original.callTool("canvas_create_text_node", { text: "maybe saved" });
    const rejected = pending.catch((error: unknown) => error);
    const call = first.events("tool_call").at(-1)!;
    const requestId = String(call.requestId);
    const connectionId = String(call.connectionId);
    first.close();

    const restored = new CanvasSession("thread-a", "codex", workspace);
    const second = connect(restored, "tab");
    t.after(() => second.close());
    assert.deepEqual(second.event("hello")?.pendingToolRequests, [{ requestId, connectionId, name: "canvas_apply_ops" }]);
    assert.equal(second.events("tool_call").length, 0);
    assert.deepEqual(restored.toolResult("tab", connectionId, requestId), { status: "unknown", requestId });
    assert.equal(restored.resolveResult("tab", { requestId, connectionId, outcome: "unknown" }), true);
    t.mock.timers.tick(30000);
    assert.match(String((await rejected)?.message), /结果未确认/);
    assert.equal(restored.resolveResult("tab", { requestId, connectionId, result: { nodeId: "original" } }), true);
    assert.equal(restored.resolveResult("tab", { requestId, connectionId, result: { nodeId: "duplicate" } }), false);
    assert.deepEqual(new CanvasSession("thread-a", "codex", workspace).toolResult("tab", connectionId, requestId), { status: "completed", requestId, result: { nodeId: "original" } });
});

test("corrupt or unknown-version receipt storage refuses to start instead of silently losing deduplication", async (t) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-receipts-corrupt-"));
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const session = new CanvasSession("", "codex", workspace);
    const page = connect(session, "tab");
    t.after(() => page.close());
    const pending = session.callTool("canvas_create_text_node", { text: "once" });
    const call = page.events("tool_call").at(-1)!;
    const requestId = String(call.requestId);
    session.resolveResult("tab", { requestId, connectionId: String(call.connectionId), outcome: "unknown" });
    await assert.rejects(pending, /未确认/);
    const file = path.join(workspace, ".infinite-canvas", "tool-receipts", `${requestId}.json`);
    const original = JSON.parse(await fs.readFile(file, "utf8"));
    await fs.writeFile(file, "{bad json");
    assert.throws(() => new CanvasSession("", "codex", workspace));
    await fs.writeFile(file, JSON.stringify({ ...original, version: 999 }));
    assert.throws(() => new CanvasSession("", "codex", workspace));
});

test("a write failure blocks dispatch and acknowledgement until the receipt is durable", async (t) => {
    const blockedWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-receipts-blocked-"));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-receipts-write-"));
    t.after(async () => {
        await fs.rm(blockedWorkspace, { recursive: true, force: true });
        await fs.rm(workspace, { recursive: true, force: true });
    });
    const blocked = new CanvasSession("", "codex", blockedWorkspace);
    const blockedPage = connect(blocked, "tab");
    t.after(() => blockedPage.close());
    await fs.mkdir(path.join(blockedWorkspace, ".infinite-canvas"));
    await fs.writeFile(path.join(blockedWorkspace, ".infinite-canvas", "tool-receipts"), "blocked directory");
    await assert.rejects(blocked.callTool("canvas_create_text_node", { text: "never dispatched" }));
    assert.equal(blockedPage.events("tool_call").length, 0);

    const session = new CanvasSession("", "codex", workspace);
    const page = connect(session, "tab");
    t.after(() => page.close());
    const pending = session.callTool("canvas_create_text_node", { text: "once" });
    const call = page.events("tool_call").at(-1)!;
    const requestId = String(call.requestId);
    const connectionId = String(call.connectionId);
    const originalRename = fsSync.renameSync;
    const failure = t.mock.method(fsSync, "renameSync", (source: fsSync.PathLike, destination: fsSync.PathLike) => {
        if (String(destination).endsWith(`${requestId}.json`)) throw new Error("disk commit failed");
        return originalRename(source, destination);
    });
    assert.throws(() => session.resolveResult("tab", { requestId, connectionId, result: { saved: true } }), /disk commit failed/);
    assert.equal(session.toolResult("tab", connectionId, requestId).status, "pending");
    assert.deepEqual(new CanvasSession("", "codex", workspace).toolResult("tab", connectionId, requestId), { status: "unknown", requestId });
    failure.mock.restore();
    assert.equal(session.resolveResult("tab", { requestId, connectionId, result: { saved: true } }), true);
    assert.deepEqual(await pending, { saved: true });
});

test("an actual Agent process exit recovers an in-flight request without redispatch", async (t) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-receipts-process-"));
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const fixture = path.join(import.meta.dirname, "fixtures", "receipt-restart-child.ts");
    const run = (phase: string, requestId = "", connectionId = "") => {
        const child = spawnSync(process.execPath, [path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), fixture], {
            cwd: process.cwd(),
            env: { ...process.env, RECEIPT_TEST_WORKSPACE: workspace, RECEIPT_TEST_PHASE: phase, RECEIPT_TEST_REQUEST_ID: requestId, RECEIPT_TEST_CONNECTION_ID: connectionId },
            encoding: "utf8",
        });
        assert.equal(child.status, 0, child.stderr || child.stdout);
        const output = child.stdout.match(/^RECEIPT:(.+)$/m)?.[1];
        assert.ok(output, child.stdout);
        return JSON.parse(output) as Record<string, unknown>;
    };
    const created = run("dispatch");
    const requestId = String(created.requestId);
    const connectionId = String(created.connectionId);
    assert.deepEqual(run("recover", requestId, connectionId), { statusBefore: "unknown", toolCalls: 0, lateAccepted: true, statusAfter: "completed" });
    assert.deepEqual(new CanvasSession("", "codex", workspace).toolResult("tab", connectionId, requestId), { status: "completed", requestId, result: { saved: true } });
});

function connect(session: CanvasSession, clientId: string) {
    const response = new FakeSseResponse();
    session.openEvents(new URL(`http://127.0.0.1/events?clientId=${clientId}`), response as unknown as ServerResponse);
    return response;
}

class FakeSseResponse extends EventEmitter {
    private chunks: string[] = [];
    writeHead() { return this; }
    write(chunk: string) { this.chunks.push(chunk); return true; }
    end() { this.emit("close"); }
    close() { this.emit("close"); }
    event(type: string) { return this.events(type)[0]; }
    events(type: string): Record<string, unknown>[] {
        return this.chunks.flatMap((chunk) => {
            if (!chunk.startsWith(`event: ${type}\n`)) return [];
            const data = chunk.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
            return data ? [JSON.parse(data) as Record<string, unknown>] : [];
        });
    }
}
