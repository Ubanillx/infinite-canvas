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
        keys.push(attachment.storageKey);
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
