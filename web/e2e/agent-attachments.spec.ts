import { randomUUID } from "node:crypto";
import { test, expect } from "./auth";
import { type APIRequestContext, type Page } from "@playwright/test";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

async function setup(request: APIRequestContext, page: Page) {
    const workspace = (await (await request.get("/api/auth/me")).json()).workspaces[0];
    const headers = { "x-infinite-canvas-workspace": workspace.id };
    await page.addInitScript((workspace) => localStorage.setItem("infinite-canvas:active-workspace", JSON.stringify(workspace)), workspace);
    await page.goto("/canvas");
    await expect(page.getByRole("heading", { name: "我的画布", exact: true })).toBeVisible();
    return { workspace, headers };
}

test("Agent attachment reads keep the authenticated workspace context", async ({ request, page }) => {
    const { workspace } = await setup(request, page);
    await page.route("**/mock-agent/agent/attachments/*?*", async (route) => {
        const url = new URL(route.request().url());
        expect(url.searchParams.get("workspaceId")).toBe(workspace.id);
        expect(url.searchParams.get("clientId")).toBe("source-tab");
        expect(route.request().headers()["x-infinite-canvas-workspace"]).toBe(workspace.id);
        await route.fulfill({ contentType: "image/png", body: Buffer.from(png, "base64") });
    });
    const result = await page.evaluate(async () => {
        const modulePath = "/src/services/api/canvas-agent.ts";
        const { fetchAgentAttachment } = await import(modulePath);
        const response = await fetchAgentAttachment(`${location.origin}/mock-agent`, "test", "source-tab", "attachment-1");
        return { status: response.status, bytes: (await response.arrayBuffer()).byteLength };
    });
    expect(result).toEqual({ status: 200, bytes: Buffer.from(png, "base64").length });
});

test("canvas image export copies original bytes to the current thread without changing nodes", async ({ request, page }) => {
    const { workspace, headers } = await setup(request, page);
    const key = `image:${randomUUID().replaceAll("-", "")}`;
    const original = Buffer.from(await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 2;
        canvas.getContext("2d")!.fillRect(0, 0, 1, 1);
        return canvas.toDataURL("image/png").split(",")[1];
    }), "base64");
    expect((await request.put(`/api/media/blob/${encodeURIComponent(key)}`, { headers: { ...headers, "content-type": "image/png" }, data: original })).ok()).toBe(true);
    let uploaded = 0;
    await page.route("**/mock-agent/agent/files?*", async (route) => {
        const url = new URL(route.request().url());
        expect(url.searchParams.get("workspaceId")).toBe(workspace.id);
        expect(url.searchParams.get("threadId")).toBe("source-thread");
        expect(url.searchParams.get("name")).toBe("canvas-image.png");
        expect(route.request().postDataBuffer()).toEqual(original);
        uploaded++;
        await route.fulfill({ json: { ok: true, file: { fileId: "exported-file" } } });
    });
    const result = await page.evaluate(async (key) => {
        const modulePath = "/src/services/api/canvas-agent.ts";
        const { exportCanvasImage } = await import(modulePath);
        const snapshot = { projectId: "canvas", nodes: [{ id: "image", type: "image", metadata: { images: [{ id: "selected", storageKey: key, status: "success" }] } }] };
        const before = JSON.stringify(snapshot);
        const file = await exportCanvasImage(`${location.origin}/mock-agent`, "test", snapshot, { nodeId: "image", imageId: "selected", threadId: "source-thread" });
        return { file, unchanged: JSON.stringify(snapshot) === before };
    }, key);
    expect(result).toEqual({ file: { fileId: "exported-file" }, unchanged: true });
    expect(uploaded).toBe(1);
    expect(await (await request.get(`/api/media/blob/${encodeURIComponent(key)}`, { headers })).body()).toEqual(original);
});

test("403 JSON and invalid image bytes cannot be exported as PNG", async ({ request, page }) => {
    await setup(request, page);
    let uploaded = 0;
    await page.route("**/mock-agent/agent/files?*", async (route) => { uploaded++; await route.fulfill({ status: 500 }); });
    for (const status of [403, 200]) {
        await page.route("**/api/media/blob/image%3Ainvalid-export", (route) => route.fulfill({ status, contentType: status === 403 ? "application/json" : "image/png", body: '{"error":"denied"}' }));
        const failed = await page.evaluate(async () => {
            const modulePath = "/src/services/api/canvas-agent.ts";
            const { exportCanvasImage } = await import(modulePath);
            try {
                await exportCanvasImage(`${location.origin}/mock-agent`, "test", { nodes: [{ id: "image", type: "image", metadata: { storageKey: "image:invalid-export" } }] }, { nodeId: "image", threadId: "thread" });
                return false;
            } catch { return true; }
        });
        expect(failed).toBe(true);
        await page.unroute("**/api/media/blob/image%3Ainvalid-export");
    }
    expect(uploaded).toBe(0);
});

test("live MCP errors expose result.content instead of hiding the failure", async ({ request, page }) => {
    await setup(request, page);
    const detail = await page.evaluate(async () => {
        const modulePath = "/src/components/agent/agent-event-formatters.ts";
        const { formatAgentActivity } = await import(modulePath);
        return formatAgentActivity({ type: "item.completed", item: { type: "mcp_tool_call", tool: "canvas_create_attachment_nodes", status: "completed", arguments: { attachmentIds: ["image"] }, result: { isError: true, content: [{ type: "text", text: "workspace denied" }] } } })?.detail;
    });
    expect(detail.status).toBe("failed");
    expect(detail.output).toBe("workspace denied");
});

test("switching workspace during export cancels before reading or uploading another workspace", async ({ request, page }) => {
    await setup(request, page);
    let transfers = 0;
    await page.route("**/api/media/blob/image%3Aexport-race", async (route) => { transfers++; await route.fulfill({ status: 403 }); });
    await page.route("**/mock-agent/agent/files?*", async (route) => { transfers++; await route.fulfill({ status: 403 }); });
    const error = await page.evaluate(async () => {
        const modulePath = "/src/services/api/canvas-agent.ts";
        const { exportCanvasImage } = await import(modulePath);
        const key = "infinite-canvas:active-workspace";
        const original = localStorage.getItem(key)!;
        const result = exportCanvasImage(`${location.origin}/mock-agent`, "test", { nodes: [{ id: "image", type: "image", metadata: { storageKey: "image:export-race" } }] }, { nodeId: "image", threadId: "thread" });
        localStorage.setItem(key, JSON.stringify({ ...JSON.parse(original), id: "00000000-0000-4000-8000-000000000000" }));
        try { await result; return "accepted"; }
        catch (error) { return String(error); }
        finally { localStorage.setItem(key, original); }
    });
    expect(error).toContain("工作区已切换");
    expect(transfers).toBe(0);
});

test("only initialization, not a long running turn, shows the initialization warning", async ({ request, page }) => {
    await setup(request, page);
    await page.route("**/mock-agent/**", (route) => route.fulfill({ json: { ok: true, data: [], messages: [] } }));
    await page.clock.install();
    await page.evaluate(async () => {
        const modulePath = "/src/stores/use-agent-store.ts";
        const { useAgentStore } = await import(modulePath);
        useAgentStore.getState().setAgentState({ url: `${location.origin}/mock-agent`, token: "test", connected: true, enabled: false, panelMounted: true, panelOpen: true, activeTab: "chat", loadingThreads: false, activeThreadId: "thread", conversation: { engine: "codex", revision: 1, conversationId: "conversation", threadId: "thread", status: "running", mcpStatuses: {} } });
    });
    const composer = page.locator("aside[data-canvas-shortcuts-ignore] [role=textbox]");
    await expect(composer).toHaveAttribute("aria-label", /询问 Codex/);
    await page.clock.fastForward(60_001);
    await expect(composer).toHaveAttribute("aria-label", /询问 Codex/);
    await page.evaluate(async () => {
        const modulePath = "/src/stores/use-agent-store.ts";
        const { useAgentStore } = await import(modulePath);
        const state = useAgentStore.getState();
        state.setAgentState({ conversation: { ...state.conversation, status: "preparing" } });
    });
    await expect(composer).toHaveAttribute("aria-label", /正在初始化/);
    await page.clock.fastForward(60_001);
    await expect(composer).toHaveAttribute("aria-label", /初始化时间较长/);
    await page.evaluate(async () => {
        const modulePath = "/src/stores/use-agent-store.ts";
        const { useAgentStore } = await import(modulePath);
        const state = useAgentStore.getState();
        state.setAgentState({ conversation: { ...state.conversation, status: "running" } });
    });
    await expect(composer).toHaveAttribute("aria-label", /询问 Codex/);
});

test("Codex and Pi send only after originals are inventoried, restore by message scope, and release references without deleting media", async ({ request, page }) => {
    const { headers } = await setup(request, page);
    const messages = new Map<string, string>();
    let sent = 0;
    await page.route("**/mock-agent/agent/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        const engine = path.includes("/pi/") ? "pi" : "codex";
        if (path.endsWith("/turn")) {
            sent++;
            const body = route.request().postDataJSON();
            messages.set(engine, body.messageId);
            const manifest = await (await request.get("/api/media/agent-attachments", { headers })).json();
            const pending = manifest.sessions.find((session: { engine: string }) => session.engine === engine);
            expect(pending.messages[0].clientMessageId).toBe(body.messageId);
            const saved = await request.get(`/api/media/blob/${encodeURIComponent(pending.messages[0].attachments[0].storageKey)}`, { headers });
            expect(await saved.body()).toEqual(Buffer.from(png, "base64"));
            await route.fulfill({ json: { ok: true, threadId: "thread" } });
        } else if (path.endsWith("/delete")) await route.fulfill({ json: { ok: true } });
        else await route.fulfill({ json: { ok: true, messages: [{ id: "message", role: "user", threadId: "thread", turnId: "turn", itemId: "item", clientMessageId: messages.get(engine), text: "Original" }] } });
    });
    const keys: string[] = [];
    for (const engine of ["codex", "pi"]) {
        const result = await page.evaluate(async ({ engine, png, id }) => {
            const modulePath = "/src/services/api/canvas-agent.ts";
            const { fetchAgentJson } = await import(modulePath);
            const endpoint = `${location.origin}/mock-agent`;
            await fetchAgentJson(endpoint, "test", `/agent/${engine}/turn`, { method: "POST", body: JSON.stringify({ messageId: id, threadId: "", attachments: [{ id: "file", name: "original.png", type: "image/png", width: 1, height: 1, dataUrl: `data:image/png;base64,${png}` }], messageMetadata: { attachments: [{ id: "file" }] } }) });
            return fetchAgentJson(endpoint, "test", `/agent/${engine}/threads/thread`);
        }, { engine, png, id: randomUUID() });
        const attachment = result.messages[0].attachments[0];
        // Restored attachments expose the original through a media URL, not a storageKey field.
        keys.push(decodeURIComponent(new URL(attachment.url, page.url()).pathname.split("/").at(-1)!));
        expect(attachment.url).toContain("/api/media/blob/");
        expect(attachment.dataUrl).toBeUndefined();
        expect(await (await request.get(attachment.url)).body()).toEqual(Buffer.from(png, "base64"));
    }
    expect(sent).toBe(2); expect(new Set(keys).size).toBe(2);
    const scan = await (await request.post("/api/media/gc/dry-run", { headers })).json();
    expect(scan.status).toBe("succeeded"); expect(scan.candidates).toEqual([]);
    const manifest = await (await request.get("/api/data/agent-sessions", { headers })).json();
    expect(manifest.payload.version).toBe(1);
    expect(JSON.stringify(manifest.payload)).not.toContain("data:image");
    expect(manifest.payload.sessions.every((session: { messages: Array<{ turnId: string; itemId: string }> }) => session.messages[0].turnId === "turn" && session.messages[0].itemId === "item")).toBe(true);
    await page.evaluate(async () => {
        const modulePath = "/src/services/api/canvas-agent.ts";
        const { fetchAgentJson } = await import(modulePath);
        await fetchAgentJson(`${location.origin}/mock-agent`, "test", "/agent/codex/threads/thread/delete", { method: "POST" });
    });
    const after = await (await request.post("/api/media/gc/dry-run", { headers })).json();
    expect(after.candidates.map((entry: { storageKey: string }) => entry.storageKey)).toEqual([keys[0]]);
    for (const key of keys) expect((await request.get(`/api/media/blob/${encodeURIComponent(key)}`, { headers })).ok()).toBe(true);
});

test("failed original upload prevents an Agent turn; failed bind keeps pending originals protected for history retry", async ({ request, page }) => {
    const { headers } = await setup(request, page);
    let sent = 0;
    const id = randomUUID();
    await page.route("**/mock-agent/agent/**", async (route) => {
        if (new URL(route.request().url()).pathname.endsWith("/turn")) {
            sent++; await route.fulfill({ json: { ok: true, threadId: "thread" } });
        } else await route.fulfill({ json: { messages: [{ role: "user", threadId: "thread", turnId: "turn", itemId: "item", clientMessageId: id }] } });
    });
    await page.route("**/api/media/blob/*", (route) => route.fulfill({ status: 503 }));
    const send = () => page.evaluate(async ({ id, png }) => {
        const modulePath = "/src/services/api/canvas-agent.ts";
        const { fetchAgentJson } = await import(modulePath);
        try {
            await fetchAgentJson(`${location.origin}/mock-agent`, "test", "/agent/codex/turn", { method: "POST", body: JSON.stringify({ messageId: id, attachments: [{ id: "file", name: "file.png", width: 1, height: 1, dataUrl: `data:image/png;base64,${png}` }], messageMetadata: { attachments: [{ id: "file" }] } }) });
            return "accepted";
        } catch (error) { return String(error); }
    }, { id, png });
    expect(await send()).toContain("任务未发送"); expect(sent).toBe(0);
    await page.unroute("**/api/media/blob/*");
    await page.route("**/api/media/agent-attachments", (route) => route.request().method() === "PATCH" ? route.fulfill({ status: 503 }) : route.continue());
    expect(await send()).toBe("accepted"); expect(sent).toBe(1);
    const pending = await (await request.get("/api/media/agent-attachments", { headers })).json();
    expect(pending.sessions[0].threadId).toBe("");
    expect((await (await request.post("/api/media/gc/dry-run", { headers })).json()).candidates).toEqual([]);
    await page.unroute("**/api/media/agent-attachments");
    await page.evaluate(async () => {
        const modulePath = "/src/services/api/canvas-agent.ts";
        const { fetchAgentJson } = await import(modulePath);
        await fetchAgentJson(`${location.origin}/mock-agent`, "test", "/agent/codex/threads/thread");
    });
    const bound = await (await request.get("/api/media/agent-attachments", { headers })).json();
    expect(bound.sessions[0].threadId).toBe("thread");
    expect(bound.sessions[0].messages[0].turnId).toBe("turn"); expect(sent).toBe(1);
});

test("concurrent Agent attachment updates preserve both messages; unknown formats and cross-turn rebinding cannot overwrite them", async ({ request }) => {
    const workspace = (await (await request.get("/api/auth/me")).json()).workspaces[0];
    const headers = { "x-infinite-canvas-workspace": workspace.id };
    const key = "image:agent_original";
    expect((await request.put(`/api/media/blob/${encodeURIComponent(key)}`, { headers: { ...headers, "content-type": "image/png" }, data: Buffer.from(png, "base64") })).ok()).toBe(true);
    const attachment = { id: "file", name: "file.png", storageKey: key, type: "image/png", size: Buffer.from(png, "base64").length, width: 1, height: 1, purpose: "attachment" };
    const reserve = (id: string) => request.post("/api/media/agent-attachments", { headers, data: { engine: "pi", threadId: "thread", clientMessageId: id, attachments: [attachment] } });
    expect((await Promise.all([reserve("one"), reserve("two")])).every((response) => response.ok())).toBe(true);
    const stored = await (await request.get("/api/data/agent-sessions", { headers })).json();
    expect(stored.payload.sessions[0].messages).toHaveLength(2);
    expect((await request.patch("/api/media/agent-attachments", { headers, data: { engine: "pi", threadId: "other-thread", clientMessageId: "one", turnId: "turn", itemId: "item" } })).status()).toBe(422);
    expect((await request.put("/api/data/agent-sessions", { headers, data: { revision: stored.revision, payload: { ...stored.payload, version: 99 } } })).status()).toBe(422);
    expect((await (await request.get("/api/data/agent-sessions", { headers })).json()).payload).toEqual(stored.payload);
    const report = await (await request.post("/api/media/gc/dry-run", { headers })).json();
    expect(report.status).toBe("succeeded"); expect(report.referenceCount).toBe(2); expect(report.referencedObjectCount).toBe(1); expect(report.candidates).toEqual([]);
});
