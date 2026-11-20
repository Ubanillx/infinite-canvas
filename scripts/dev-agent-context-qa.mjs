import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { attachDiagnostics, launchBrowser } from "./lib/dev-browser.mjs";
import { timestampDir } from "./lib/dev-env.mjs";

// Exercise the real panel/effects with mock Agent events. No platform data or models are used.
const urlIndex = process.argv.indexOf("--url");
if (urlIndex < 0 || !process.argv[urlIndex + 1]) throw new Error("Usage: node scripts/dev-agent-context-qa.mjs --url http://127.0.0.1:3000");
const baseUrl = process.argv[urlIndex + 1];
const runDir = timestampDir("agent-context-qa");
const browser = await launchBrowser({ args: ["--disable-features=LocalNetworkAccessChecks"] });
const context = await browser.newContext();
const page = await context.newPage();
const diagnostics = attachDiagnostics(page);
const checks = [];
const statePosts = [];
const resultPosts = [];
const compactions = [];
let holdStatePublication = null;
const conversation = { engine: "codex", revision: 1, conversationId: "conversation", threadId: "thread", status: "ready", mcpStatuses: {} };
const models = [
    { id: "first", model: "first", displayName: "First", contextWindow: 10000, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }], isDefault: true },
    { id: "second", model: "second", displayName: "Second", contextWindow: 20000, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] },
];

try {
    await context.addInitScript(() => {
        class MockEventSource extends EventTarget {
            static CONNECTING = 0;
            static OPEN = 1;
            static CLOSED = 2;
            readyState = 0;
            onerror = null;
            constructor(url) { super(); this.url = url; window.agentSources.push(this); }
            close() { this.readyState = 2; }
            emit(type, data) { this.readyState = 1; this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) })); }
            fail() { this.readyState = 0; this.onerror?.(new Event("error")); }
        }
        window.agentSources = [];
        window.EventSource = MockEventSource;
        localStorage.setItem("infinite-canvas:active-workspace", JSON.stringify({ id: "workspace-a", name: "QA", role: "viewer" }));
    });
    await page.route("**/mock-agent/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith("/canvas/state")) {
            const url = new URL(route.request().url());
            assert.ok(url.searchParams.get("connectionId"));
            assert.ok(Number(url.searchParams.get("stateRevision")) > 0);
            statePosts.push({ connectionId: url.searchParams.get("connectionId"), revision: Number(url.searchParams.get("stateRevision")) });
            if (holdStatePublication) await holdStatePublication;
        }
        if (path.endsWith("/canvas/result")) resultPosts.push(route.request().postDataJSON());
        if (path.endsWith("/compact")) compactions.push({ engine: path.includes("/pi/") ? "pi" : "codex", ...route.request().postDataJSON() });
        return route.fulfill({ json: path.endsWith("/models") ? { ok: true, data: models } : { ok: true, conversation, workspace: { activeThreadId: "thread" }, data: [], messages: [], settledTurnIds: [] } });
    });
    // Store hydration reads get empty fixtures; unexpected writes fail before reaching the server.
    await page.route("**/api/**", (route) => {
        const path = new URL(route.request().url()).pathname;
        if (!path.startsWith("/api/")) return route.continue();
        if (route.request().method() === "GET" && path.startsWith("/api/data/")) return route.fulfill({ json: { payload: null, revision: 0 } });
        if (route.request().method() === "GET" && path === "/api/media/agent-attachments") return route.fulfill({ json: { version: 1, sessions: [] } });
        return route.fulfill({ status: 418, json: { error: "Unexpected API request in isolated Agent QA" } });
    });
    await page.route("**/__agent-context-qa", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><div id="root"></div>
<script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
</script><script type="module" src="/e2e/fixtures/agent-connection.tsx"></script>` }));
    await page.goto(new URL("/__agent-context-qa", baseUrl).href);
    await page.waitForFunction(() => window.agentSources.length === 1);
    const hello = { protocolVersion: 11, connectionId: "generation-1", pendingToolRequests: [], conversation, workspace: { activeThreadId: "thread" }, codex: { busy: false, threadId: "thread" } };
    await page.evaluate((hello) => window.agentSources[0].emit("hello", hello), hello);
    await page.waitForFunction(() => window.agentStore.getState().models.length === 2 && !window.agentStore.getState().loadingThreads);

    // Changing the selected model does not change which model produced a usage event.
    await page.evaluate(() => {
        window.agentStore.getState().setAgentState({ model: "second" });
        window.agentSources[0].emit("agent_event", { agent: "codex", type: "usage.updated", threadId: "thread", usage: { input_tokens: 5000, context_tokens: 5000 } });
    });
    await page.waitForFunction(() => window.agentStore.getState().tokenUsage?.contextTokens === 5000);
    assert.equal(await page.evaluate(() => window.agentStore.getState().tokenUsage.contextWindow), undefined, "missing call metadata must not borrow the currently selected model window");
    assert.equal(await page.getByRole("meter").count(), 0);
    await page.evaluate(() => window.agentSources[0].emit("agent_event", { agent: "codex", type: "usage.updated", threadId: "thread", usage: { input_tokens: 5000, context_tokens: 5000, model_context_window: 10000 } }));
    await page.waitForFunction(() => window.agentStore.getState().tokenUsage?.contextWindow === 10000);
    assert.equal(await page.getByRole("meter").getAttribute("aria-valuemax"), "10000");
    checks.push("usage uses the reported call window and never substitutes the selected model window");

    // Zero is authoritative after compaction even when the latest-call input is nonzero.
    await page.evaluate(() => window.agentSources[0].emit("agent_event", { agent: "codex", type: "usage.updated", threadId: "thread", usage: { input_tokens: 5000, context_tokens: 0, model_context_window: 20000 } }));
    await page.waitForFunction(() => window.agentStore.getState().tokenUsage?.contextTokens === 0);
    assert.equal(await page.getByRole("meter").getAttribute("aria-valuenow"), "0");
    checks.push("reported zero context survives formatting and reaches the meter");

    // Execute a real panel canvas tool once; repeat delivery must only resend its receipt.
    await page.evaluate(() => {
        window.applied = 0;
        window.agentStore.getState().setCanvasContext({
            instanceId: "canvas-instance", snapshot: { projectId: "canvas-project", nodes: [], connections: [] },
            applyOps: () => { window.applied++; return { projectId: "canvas-project", nodes: [], connections: [] }; },
            finishTurn: async () => null, discardTurn: () => {}, undoOps: () => null, canUndo: false,
        });
        window.agentSources[0].emit("tool_call", { requestId: "write-once", connectionId: "generation-1", name: "canvas_apply_ops", input: { ops: [] } });
    });
    await page.waitForFunction(() => window.applied === 1);
    await page.waitForResponse((response) => response.url().includes("/canvas/result") && response.request().postDataJSON()?.requestId === "write-once");
    await page.evaluate(() => window.agentSources[0].emit("tool_call", { requestId: "write-once", connectionId: "generation-1", name: "canvas_apply_ops", input: { ops: [] } }));
    await page.waitForFunction(() => window.applied === 1);
    checks.push("duplicate tool delivery reuses its stored receipt without executing again");

    // The browser may report many CONNECTING errors during one outage before hello returns.
    await page.evaluate(() => window.agentSources[0].fail());
    await page.waitForFunction(() => !window.agentStore.getState().connected);
    await page.evaluate(() => window.agentSources[0].fail());
    assert.deepEqual(await page.evaluate(() => ({ enabled: window.agentStore.getState().enabled, readyState: window.agentSources[0].readyState })), { enabled: true, readyState: 0 }, "established SSE must keep native reconnect enabled after consecutive failures");
    const reconnectHello = { ...hello, connectionId: "generation-2", pendingToolRequests: [{ requestId: "write-once", connectionId: "generation-1", name: "canvas_apply_ops" }] };
    await page.evaluate((hello) => window.agentSources[0].emit("hello", hello), reconnectHello);
    await page.waitForFunction(() => window.agentStore.getState().connected && !window.agentStore.getState().loadingThreads);
    assert.equal(await page.evaluate(() => window.agentSources.length), 1, "recovery must not create a second event stream");
    checks.push("consecutive outage errors recover through one event stream");

    await page.evaluate(() => window.agentSources[0].emit("tool_call", { requestId: "old-socket", connectionId: "generation-1", name: "canvas_apply_ops", input: { ops: [] } }));
    await page.evaluate(async () => {
        const path = "/src/services/api/canvas-agent.ts";
        const { postState } = await import(path);
        const clientId = new URL(window.agentSources[0].url).searchParams.get("clientId");
        if (await postState(`${location.origin}/mock-agent`, "test", clientId, null, "generation-1")) throw new Error("stale generation was accepted");
    });
    assert.equal(await page.evaluate(() => window.applied), 1);
    assert.ok(statePosts.some((entry) => entry.connectionId === "generation-2"));
    assert.ok(resultPosts.every((entry) => entry.connectionId === "generation-1"));
    checks.push("new state publications use the new generation while old tool receipts retain the origin generation");

    // A tool arriving immediately after hello must wait for the initial state acknowledgement.
    let releaseState;
    holdStatePublication = new Promise((resolve) => { releaseState = resolve; });
    const stateRequest = page.waitForRequest((request) => request.url().includes("/canvas/state") && request.url().includes("generation-3"));
    await page.evaluate((hello) => {
        window.agentSources[0].emit("hello", hello);
        window.agentSources[0].emit("tool_call", { requestId: "after-handshake", connectionId: "generation-3", name: "canvas_apply_ops", input: { ops: [] } });
    }, { ...hello, connectionId: "generation-3" });
    await stateRequest;
    assert.equal(await page.evaluate(() => window.applied), 1, "tool ran before initial state was acknowledged");
    const toolResponse = page.waitForResponse((response) => response.url().includes("/canvas/result") && response.request().postDataJSON()?.requestId === "after-handshake");
    releaseState();
    holdStatePublication = null;
    await toolResponse;
    assert.equal(await page.evaluate(() => window.applied), 2);
    checks.push("tool delivery during hello waits for state readiness and submits its receipt");

    // A newer state can overtake a receipt publication without stranding the receipt.
    await page.route("**/mock-agent/canvas/state?*", async (route) => {
        const url = new URL(route.request().url());
        const revision = Number(url.searchParams.get("stateRevision"));
        await route.fulfill({ status: 409, json: { ok: false, code: "STATE_SUPERSEDED", ready: true, connectionId: "generation-3", stateRevision: revision + 1 } });
    });
    const supersededResult = page.waitForResponse((response) => response.url().includes("/canvas/result") && response.request().postDataJSON()?.requestId === "superseded-state");
    await page.evaluate(() => window.agentSources[0].emit("tool_call", { requestId: "superseded-state", connectionId: "generation-3", name: "canvas_apply_ops", input: { ops: [] } }));
    await supersededResult;
    await page.unroute("**/mock-agent/canvas/state?*");
    assert.equal(await page.evaluate(() => window.applied), 3);
    // 409 is expected by this fault-injection check.
    diagnostics.failures.splice(0, diagnostics.failures.length, ...diagnostics.failures.filter((entry) => !/409.*mock-agent\/canvas\/state|409 \(Conflict\)/.test(entry)));
    checks.push("superseded state publication still delivers an already saved tool result");

    // Pi exposes the same manual compact action and carries its selected model and admission generation.
    await page.evaluate(() => {
        const current = window.agentStore.getState();
        current.setAgentState({ engine: "pi" });
        window.agentStore.getState().setAgentState({ activeThreadId: "pi-thread", loadingThreads: false, model: "second", models: [{ model: "second", displayName: "Second", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }], reasoningEffort: "medium", conversation: { engine: "pi", revision: 2, conversationId: "pi-conversation", threadId: "pi-thread", status: "ready", mcpStatuses: {} } });
    });
    await Promise.all([
        page.waitForResponse((response) => response.url().includes("/agent/pi/compact")),
        page.getByRole("button", { name: "压缩上下文", exact: true }).click(),
    ]);
    const compact = compactions.find((entry) => entry.engine === "pi");
    assert.equal(compact?.threadId, "pi-thread");
    assert.equal(compact?.connectionId, "generation-3");
    assert.equal(compact?.model, "second");
    checks.push("Pi manual compression reaches its API with model, conversation and connection scope");

    // Explicit disconnect still closes the socket and ignores late callbacks.
    await page.evaluate(() => window.agentStore.getState().disconnectAgent());
    await page.waitForFunction(() => window.agentSources[0].readyState === 2);
    await page.evaluate((hello) => window.agentSources[0].emit("hello", hello), hello);
    assert.equal(await page.evaluate(() => window.agentStore.getState().connected), false);
    checks.push("explicit disconnect ignores a late hello");
    diagnostics.assertClean();
    await page.screenshot({ path: resolve(runDir, "panel.png") });
    console.log(`Passed ${checks.length} browser regression checks`);
} catch (error) {
    await page.screenshot({ path: resolve(runDir, "failure.png") }).catch(() => undefined);
    diagnostics.print();
    throw error;
} finally {
    writeFileSync(resolve(runDir, "report.json"), JSON.stringify({ checks, failures: diagnostics.failures }, null, 2));
    console.log(`Report: ${runDir}`);
    await context.close();
    await browser.close();
}
