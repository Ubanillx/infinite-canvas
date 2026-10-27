import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { attachDiagnostics, launchBrowser } from "./lib/dev-browser.mjs";
import { timestampDir } from "./lib/dev-env.mjs";

// Uses a separate browser/account. --codex / --pi opt into a real request for that engine.
const urlIndex = process.argv.indexOf("--url");
const baseURL = urlIndex < 0 ? "http://127.0.0.1:3000" : process.argv[urlIndex + 1];
const runDir = timestampDir("agent-check");
const browser = await launchBrowser();
const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const diagnostics = attachDiagnostics(page);
const report = { checks: [], failures: [] };
const record = (check) => { report.checks.push(check); console.log(`ok: ${check}`); };
try {
    if (process.argv.includes("--runtime-logs")) await context.addInitScript(() => {
        window.agentRuntimeLogs = [];
        const Source = window.EventSource;
        window.EventSource = class extends Source {
            constructor(...args) {
                super(...args);
                this.addEventListener("agent_log", (event) => {
                    try {
                        const payload = JSON.parse(event.data);
                        const entry = JSON.parse(payload.text);
                        window.agentRuntimeLogs.push({ level: entry.level, target: entry.target, message: entry.fields?.message });
                    } catch { /* Only collect structured runtime diagnostics, never raw payloads. */ }
                });
            }
        };
    });
    const accountResponse = await context.request.post("/api/auth/register", { data: { username: `qa-agent-${randomUUID()}`, password: randomUUID() } });
    assert.equal(accountResponse.status(), 201);
    const account = await accountResponse.json();
    const workspace = account.workspaces[0];
    const canvasId = process.argv.includes("--canvas-tools") ? `qa-agent-${randomUUID()}` : "";
    if (canvasId) {
        const now = new Date().toISOString();
        const project = { id: canvasId, title: "Agent 日志验收", folderId: null, createdAt: now, updatedAt: now, nodes: [], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } };
        const seeded = await context.request.put("/api/data/canvas", { headers: { "x-infinite-canvas-workspace": workspace.id }, data: { revision: 0, payload: { state: { projects: [project], folders: [], deletedProjects: [] }, version: 0 } } });
        assert.equal(seeded.status(), 200);
    }
    await context.addInitScript((workspace) => {
        localStorage.setItem("infinite-canvas:active-workspace", JSON.stringify(workspace));
        if (!localStorage.getItem("canvas-agent-engine")) localStorage.setItem("canvas-agent-engine", "codex");
    }, workspace);
    const anonymous = await browser.newContext({ baseURL });
    assert.equal((await anonymous.request.get("/api/canvas-agent/agent/pi/models", { headers: { "x-infinite-canvas-workspace": workspace.id } })).status(), 403);
    await anonymous.close();
    assert.equal((await context.request.get("/api/canvas-agent/agent/pi/models", { headers: { "x-infinite-canvas-workspace": randomUUID() } })).status(), 403);
    record("gateway denies anonymous and non-member workspaces");
    const firstPreparation = prepareFor("codex");
    await page.goto(canvasId ? `/canvas/${canvasId}` : "/", { waitUntil: "domcontentloaded" });
    await page.getByRole("button").filter({ hasText: "AI助手" }).first().click();
    const codex = await firstPreparation;
    await page.locator('[role="textbox"][contenteditable="true"]').waitFor({ timeout: 120000 });
    assert.equal(codex.engine, "codex");
    assert.ok(codex.threadId);
    record("fresh browser connects without a local Agent token");
    if (process.argv.includes("--codex")) {
        const composer = page.locator('[role="textbox"][contenteditable="true"]');
        await expectEditable(composer);
        await composer.fill("不要调用工具，仅回复 CODEX_OK");
        await expectEditable(composer);
        await composer.press("Enter");
        await page.getByText("CODEX_OK", { exact: true }).waitFor({ timeout: 120000 });
        record("Codex real provider turn replies CODEX_OK");
        if (canvasId) {
            await composer.fill("请使用 infinite-canvas 的画布工具读取当前画布，然后创建且只创建一个文本节点，标题和内容都为 LOG_CANVAS_OK。不要使用命令行或文件工具，不要修改其他节点，完成后回复 CANVAS_TOOL_OK。");
            await composer.press("Enter");
            await page.locator(".agent-streamdown").filter({ hasText: "CANVAS_TOOL_OK" }).waitFor({ timeout: 120000 });
            await page.locator("[data-node-id]").filter({ hasText: "LOG_CANVAS_OK" }).first().waitFor({ timeout: 120000 });
            const saved = await context.request.get("/api/data/canvas", { headers: { "x-infinite-canvas-workspace": workspace.id } });
            assert.equal(saved.status(), 200);
            const project = (await saved.json()).payload.state.projects.find((item) => item.id === canvasId);
            assert.equal(project.nodes.filter((item) => item.title === "LOG_CANVAS_OK").length, 1);
            record("Codex reads the real canvas, creates one text node and persists it server-side");
        }
    }
    await page.screenshot({ path: resolve(runDir, "codex.png") });
    if (process.argv.includes("--runtime-logs")) {
        const logs = await page.evaluate(() => window.agentRuntimeLogs);
        report.runtimeLogs = logs;
        const serious = logs.filter((entry) => entry.level === "ERROR" || /models cache|renew cache TTL|unknown feature key|ignoring hooks|failed to connect to websocket|Shell snapshot not supported|list_turns is not supported/i.test(entry.message || ""));
        assert.deepEqual(serious, [], "Codex must not emit schema, transport or unsupported-shell diagnostics");
        record("Codex runtime has no model-cache, hook-schema, transport or unsupported-shell diagnostics");
    }
    const piModels = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/canvas-agent/agent/pi/models");
    const piPreparation = prepareFor("pi");
    await page.getByRole("button", { name: /切换 Agent 引擎.*Codex/ }).click();
    const pi = await piPreparation;
    assert.equal(pi.engine, "pi");
    assert.notEqual(pi.threadId, codex.threadId);
    assert.equal(await page.getByText("CODEX_OK", { exact: true }).count(), 0);
    record("switching to Pi does not retain Codex replies");
    const discovered = (await (await piModels).json()).data;
    if (!discovered.length) {
        assert.ok(!process.argv.includes("--pi"), "Pi real-provider check requires a configured text channel");
        await page.getByRole("textbox", { name: /当前没有可用的文本模型/ }).waitFor();
        assert.equal(await page.getByRole("textbox", { name: /当前没有可用的文本模型/ }).getAttribute("contenteditable"), "false");
        record("Pi without credentials explains configuration instead of initializing forever");
    }
    if (discovered.length) {
        await page.getByRole("combobox", { name: /选择模型/ }).click();
        assert.deepEqual(await page.getByRole("option").allTextContents(), discovered.map((item) => item.model.slice(item.model.indexOf("::") + 2)));
        assert.equal(await page.locator('[data-slot="select-scroll-up-button"], [data-slot="select-scroll-down-button"]').count(), 0);
        const viewport = page.locator("[data-radix-select-viewport]");
        const overflows = await viewport.evaluate((element) => element.scrollHeight > element.clientHeight);
        if (overflows) {
            await viewport.hover();
            await page.mouse.wheel(0, 300);
            await page.waitForFunction(() => document.querySelector("[data-radix-select-viewport]")?.scrollTop > 0);
        }
        await page.keyboard.press("End");
        await page.waitForFunction(() => {
            const options = document.querySelectorAll('[role="option"]');
            return options[options.length - 1]?.hasAttribute("data-highlighted");
        });
        await page.keyboard.press("Home");
        await page.waitForFunction(() => document.querySelector('[role="option"]')?.hasAttribute("data-highlighted"));
        await page.screenshot({ path: resolve(runDir, "pi-model-list.png") });
        await page.keyboard.press("Escape");
        record("Pi model list shows only model names without channel or protocol suffixes");
        record("model list omits scroll arrows while keeping wheel and keyboard navigation");
    }
    if (process.argv.includes("--pi")) {
        assert.ok(discovered.length > 1, "Pi should discover models beyond the manually configured model");
        record(`Pi automatically discovers ${discovered.length} text models`);
        const composer = page.locator('[role="textbox"][contenteditable="true"]');
        await expectEditable(composer);
        await composer.fill("不要调用任何工具，仅回复 PI_OK");
        await expectEditable(composer);
        await composer.press("Enter");
        await page.getByText("PI_OK", { exact: true }).waitFor({ timeout: 120000 });
        record("Pi real provider turn replies PI_OK");
        await expectEditable(composer);
        await composer.fill("你现在运行在哪个助手引擎下？不要调用工具，只回答引擎名称。");
        await composer.press("Enter");
        await page.locator(".agent-streamdown").filter({ hasText: /^Pi[。.!]*$/i }).waitFor({ timeout: 120000 });
        await page.getByRole("button", { name: /切换 Agent 引擎.*Pi/ }).waitFor();
        record("Pi identifies itself as Pi, not Codex");
        const responses = discovered.find((item) => item.model.endsWith("::grok-4.7"));
        if (responses) {
            await page.getByRole("combobox", { name: /选择模型/ }).click();
            await page.getByRole("option", { name: responses.model.slice(responses.model.indexOf("::") + 2), exact: true }).click();
            await composer.fill("不要调用任何工具，仅回复 PI_RESPONSES_OK");
            await composer.press("Enter");
            await page.getByText("PI_RESPONSES_OK", { exact: true }).waitFor({ timeout: 120000 });
            record("Pi discovered Responses model completes a real turn after switching models");
        }
    }
    await page.screenshot({ path: resolve(runDir, "pi.png") });
    const piReload = prepareFor("pi");
    await page.reload({ waitUntil: "domcontentloaded" });
    assert.equal((await piReload).threadId, pi.threadId);
    record("Pi refresh restores its own thread");
    await page.getByRole("button").filter({ hasText: "AI助手" }).first().click();
    if (process.argv.includes("--pi")) {
        await page.getByText("PI_OK", { exact: true }).waitFor({ timeout: 120000 });
        record("Pi real reply persists after refresh");
    }
    const restoredCodex = prepareFor("codex");
    await page.getByRole("button", { name: /切换 Agent 引擎.*Pi/ }).click();
    const restored = await restoredCodex;
    assert.equal(restored.engine, "codex");
    if (process.argv.includes("--codex")) assert.equal(restored.threadId, codex.threadId);
    record("switching engines restores Codex; materialized threads keep their identity");
    assert.equal(await page.getByText("PI_OK", { exact: true }).count(), 0);
    assert.equal(await page.getByText("PI_RESPONSES_OK", { exact: true }).count(), 0);
    record("Pi replies do not leak into restored Codex history");
    if (process.argv.includes("--codex")) {
        await page.getByText("CODEX_OK", { exact: true }).waitFor({ timeout: 120000 });
        const history = await context.request.get(`/api/canvas-agent/agent/codex/threads/${codex.threadId}`, { headers: { "x-infinite-canvas-workspace": workspace.id } });
        assert.equal(history.status(), 200);
        assert.ok((await history.json()).messages.some((item) => item.role === "assistant" && item.text === "CODEX_OK"));
        record("Codex persisted history loads without HTTP 500 after engine switching");
    }
    diagnostics.assertClean();
} catch (error) {
    report.failures.push(error.message);
    console.error(error.stack);
    await page.screenshot({ path: resolve(runDir, "failure.png") }).catch(() => undefined);
    writeFileSync(resolve(runDir, "failure.html"), await page.content());
    process.exitCode = 1;
} finally {
    report.diagnostics = diagnostics.failures;
    writeFileSync(resolve(runDir, "report.json"), JSON.stringify(report, null, 2));
    console.log(`Report: ${resolve(runDir, "report.json")}`);
    await context.close();
    await browser.close();
}

function prepareFor(engine) {
    const pending = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/canvas-agent/agent/${engine}/prepare`, { timeout: 120000 })
        .then(async (response) => {
            const data = await response.json();
            assert.equal(response.status(), 200, data.error);
            return data.conversation;
        });
    pending.catch(() => undefined);
    return pending;
}
async function expectEditable(locator) {
    for (let attempt = 0; attempt < 12; attempt++) {
        if (await locator.count() && await locator.isEditable().catch(() => false)) return;
        await page.waitForTimeout(500);
    }
    throw new Error("AI 助手输入框仍未进入可编辑状态");
}
