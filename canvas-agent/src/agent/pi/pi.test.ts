import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import test, { after } from "node:test";

import { zodToJsonSchema } from "zod-to-json-schema";
import { Compile } from "typebox/compile";

import { toolDescriptions, toolInputSchemas, toolNames } from "../../canvas/schemas.js";
import { createReadSkillTool, loadPiSkills, piSkillSummaries, resolveExplicitSkill, setPiSkillEnabled, skillsFingerprint, skillsPromptBlock } from "./skills.js";
import { piToolSchema } from "./tools.js";
import { PiThreadStore, readPiThread, settledTurnIds, threadMessages } from "./store.js";
import { piModelOptions, readPiChannels, resolvePiModel, type PiChannel } from "./model.js";
import { generatePiSkillDraft, interruptPiTurn, releasePiRuntime, runPiTurn } from "./engine.js";
import { CanvasSession } from "../../canvas/session.js";

const temporaryDirectories: string[] = [];

after(async () => {
    await Promise.all(temporaryDirectories.map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

/**
 * 工具平移的关键约束：同一份 zod schema 必须能同时服务 MCP 和 pi。
 * pi 内部用 TypeBox 的 Compile 校验参数，这里直接复用同一套校验。
 */
test("全部画布工具都能转成 pi 可用的 JSON Schema", () => {
    toolNames.forEach((name) => {
        const json = piToolSchema(name);
        assert.equal(json.type, "object", `${name} 必须是对象 schema`);
        assert.equal(json.$schema, undefined, `${name} 不应带上 $schema`);
        assert.doesNotThrow(() => Compile(json), `${name} 必须能被 TypeBox 编译`);
        assert.ok(toolDescriptions[name], `${name} 必须有描述`);
    });
});

test("转换后的 schema 保留原有必填约束", () => {
    assert.equal(Compile(piToolSchema("canvas_apply_ops")).Check({ ops: [{ type: "add_node" }] }), true);
    assert.equal(Compile(piToolSchema("canvas_apply_ops")).Check({}), false);
    assert.equal(Compile(piToolSchema("canvas_move_nodes")).Check({ items: [] }), false);
    assert.equal(Compile(piToolSchema("canvas_get_state")).Check({}), true);
});

test("piToolSchema 对 z.record 字段仍能转换", () => {
    const json = zodToJsonSchema(toolInputSchemas.canvas_update_node, { target: "jsonSchema7", $refStrategy: "none" });
    assert.deepEqual(Object.keys(json.properties ?? {}).sort(), ["id", "metadata", "patch"]);
});

async function temporaryWorkspace() {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-store-test-"));
    temporaryDirectories.push(directory);
    return directory;
}

test("会话存储可创建、追加轮次并读取", async () => {
    const workspace = await temporaryWorkspace();
    const store = new PiThreadStore(workspace);
    const created = await store.create();
    assert.equal((await store.list()).length, 1);
    const turn = { turnId: "turn-1", userText: "你好", startedAt: 1, finishedAt: 2, status: "completed" as const, messages: [
        { itemId: "synthetic:user", turnId: "turn-1", role: "user" as const, text: "你好" },
        { itemId: "assistant:1", turnId: "turn-1", role: "assistant" as const, text: "在的" },
    ] };
    await store.saveTurn(created.id, turn, [{ role: "user", content: "你好", timestamp: 1 }]);
    const detail = await readPiThread(workspace, created.id);
    assert.ok(detail);
    assert.deepEqual(detail.messages.map((message) => message.role), ["user", "assistant"]);
    assert.deepEqual(detail.settledTurnIds, ["turn-1"]);
    assert.equal((await store.list())[0].preview, "在的");
});

test("未知版本的会话文件不会被当成空会话覆盖", async () => {
    const workspace = await temporaryWorkspace();
    const store = new PiThreadStore(workspace);
    const created = await store.create();
    await fs.writeFile(path.join(store.root(), `${created.id}.json`), JSON.stringify({ version: 99, id: created.id }));
    assert.equal(await store.read(created.id), null);
    assert.equal(await readPiThread(workspace, created.id), null);
    // 原文件保持不动
    const raw = JSON.parse(await fs.readFile(path.join(store.root(), `${created.id}.json`), "utf8"));
    assert.equal(raw.version, 99);
});

test("非法 threadId 不会读写文件系统", async () => {
    const store = new PiThreadStore(await temporaryWorkspace());
    assert.equal(await store.read("../../etc/passwd"), null);
    await store.remove("../../etc/passwd");
});

test("进行中的轮次不会进入权威历史", () => {
    const turns = [
        { turnId: "a", userText: "x", startedAt: 1, status: "running" as const, messages: [{ itemId: "i", turnId: "a", role: "user" as const, text: "x" }] },
        { turnId: "b", userText: "y", startedAt: 2, finishedAt: 3, status: "completed" as const, messages: [{ itemId: "j", turnId: "b", role: "user" as const, text: "y" }] },
    ];
    assert.deepEqual(settledTurnIds(turns), ["b"]);
    assert.deepEqual(threadMessages("thread-1", turns).map((message) => message.id), ["thread-1:b:j"]);
});

test("缺少配置时模型列表为空而不是抛错", async () => {
    const previous = process.env.INFINITE_CANVAS_DATA_DIR;
    process.env.INFINITE_CANVAS_DATA_DIR = await temporaryWorkspace();
    try {
        assert.deepEqual(await readPiChannels(), []);
        assert.deepEqual(piModelOptions([]), []);
    } finally {
        process.env.INFINITE_CANVAS_DATA_DIR = previous;
    }
});

test("兼容渠道才会进入 pi 模型列表", async () => {
    const dir = await temporaryWorkspace();
    const previous = process.env.INFINITE_CANVAS_DATA_DIR;
    process.env.INFINITE_CANVAS_DATA_DIR = dir;
    await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({
        config: { channels: [
            { id: "a", name: "开放", baseUrl: "https://a.example.com", apiKey: "k", apiFormat: "openai", models: [{ name: "m1", capability: "text" }, { name: "img", capability: "image" }] },
            { id: "b", name: "脚本", baseUrl: "https://b.example.com", apiKey: "k", apiFormat: "custom", models: [{ name: "m2", capability: "text" }] },
            { id: "c", name: "无密钥", baseUrl: "https://c.example.com", apiKey: "", apiFormat: "openai", models: [{ name: "m3", capability: "text" }] },
        ] },
    }));
    try {
        const options = piModelOptions(await readPiChannels());
        assert.deepEqual(options.map((item) => item.model), ["a::m1"]);
        assert.equal(options[0].displayName, "m1（开放）");
    } finally {
        process.env.INFINITE_CANVAS_DATA_DIR = previous;
    }
});

test("Pi 从密钥自动发现模型并优先使用上游协议能力", async () => {
    const dir = await temporaryWorkspace();
    const previous = process.env.INFINITE_CANVAS_DATA_DIR;
    process.env.INFINITE_CANVAS_DATA_DIR = dir;
    let unavailable = false;
    let requests = 0;
    const server = createServer((req, res) => {
        requests++;
        assert.equal(req.url, "/v1/models");
        assert.equal(req.headers.authorization, "Bearer discovery-test");
        res.setHeader("Content-Type", "application/json");
        if (unavailable) {
            res.statusCode = 503;
            return res.end(JSON.stringify({ error: { message: "discovery unavailable" } }));
        }
        res.end(JSON.stringify({ data: [
            { id: "deepseek-v4-flash", supported_endpoint_types: ["openai", "openai-response"], context_length: 262144, max_output_tokens: 32768 },
            { id: "gpt-6.1-sol", supported_endpoint_types: ["openai"] },
            { id: "qwen3.8-max", supported_endpoint_types: ["openai"] },
            { id: "gpt-image-2", supported_endpoint_types: ["image-generation", "openai"] },
            { id: "text-embedding-3-small" },
        ] }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
        await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({ config: { channels: [{ id: "discovery", name: "Discovery", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKey: "discovery-test", apiFormat: "openai", models: [] }] } }));
        const channels = await readPiChannels(true);
        assert.equal(channels.length, 1, "只有密钥和地址的渠道也应自动发现模型");
        assert.deepEqual(piModelOptions(channels).map((item) => item.model), ["discovery::deepseek-v4-flash", "discovery::gpt-6.1-sol", "discovery::qwen3.8-max"]);
        const responses = resolvePiModel(channels, "discovery::deepseek-v4-flash").model;
        assert.equal(responses.api, "openai-responses");
        assert.equal(responses.contextWindow, 262144);
        assert.equal(responses.maxTokens, 32768);
        assert.equal(resolvePiModel(channels, "discovery::gpt-6.1-sol").model.api, "openai-completions");
        assert.equal(resolvePiModel(channels, "discovery::qwen3.8-max").model.api, "openai-completions");
        assert.equal(requests, 1);
        assert.deepEqual(piModelOptions(await readPiChannels()), piModelOptions(channels));
        assert.equal(requests, 1, "发送时复用发现结果，不重复请求模型目录");
        unavailable = true;
        assert.deepEqual(piModelOptions(await readPiChannels(true)), piModelOptions(channels), "目录失败保留同一渠道缓存");
        assert.equal(requests, 2);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (previous === undefined) delete process.env.INFINITE_CANVAS_DATA_DIR;
        else process.env.INFINITE_CANVAS_DATA_DIR = previous;
    }
});

test("Pi 复用内置模型参数、尊重显式覆盖并推断未知型号协议", () => {
    const channels: PiChannel[] = [{ id: "auto", name: "Auto", baseUrl: "https://example.com/v1", apiKey: "test", apiFormat: "openai", models: [
        { name: "gpt-4", capability: "text" },
        { name: "gpt-6.1-sol", capability: "text" },
        { name: "qwen3.8-max", capability: "text" },
        { name: "deepseek-v4-pro", capability: "text", apiFormat: "openai-completions", endpointTypes: ["openai-response"], contextWindow: 100000, maxTokens: 5000, reasoning: false },
    ] }];
    const known = resolvePiModel(channels, "auto::gpt-4").model;
    assert.equal(known.reasoning, false);
    assert.deepEqual(known.input, ["text"]);
    assert.equal(known.contextWindow, 8192);
    assert.equal(known.maxTokens, 8192);
    assert.deepEqual(piModelOptions(channels)[0].supportedReasoningEfforts, [{ reasoningEffort: "none" }]);
    const gpt = resolvePiModel(channels, "auto::gpt-6.1-sol").model;
    assert.equal(gpt.api, "openai-responses");
    assert.equal(gpt.reasoning, true);
    assert.equal(resolvePiModel(channels, "auto::qwen3.8-max").model.api, "openai-completions");
    const overridden = resolvePiModel(channels, "auto::deepseek-v4-pro").model;
    assert.equal(overridden.api, "openai-completions");
    assert.equal(overridden.contextWindow, 100000);
    assert.equal(overridden.maxTokens, 5000);
    assert.equal(overridden.reasoning, false);
});

test("Pi Chat Completions 适配器覆盖成功、工具往返、上游错误、中断和配置缺失", async (t) => {
    const dataDir = await temporaryWorkspace();
    const previous = process.env.INFINITE_CANVAS_DATA_DIR;
    process.env.INFINITE_CANVAS_DATA_DIR = dataDir;
    let mode = "success";
    let requests: Array<Record<string, any>> = [];
    let cwd = "";
    const server = createServer(async (req, res) => {
        let body = "";
        for await (const chunk of req) body += chunk;
        const input = JSON.parse(body);
        requests.push(input);
        if (mode === "error") {
            res.writeHead(401, { "content-type": "application/json" });
            return res.end(JSON.stringify({ error: { message: "test credential rejected", type: "invalid_api_key" } }));
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        chunk({ role: "assistant" });
        if (mode === "abort") {
            chunk({ content: "partial" });
            setImmediate(() => interruptPiTurn(cwd));
            return;
        }
        if (mode === "tool" && !input.messages.some((message: any) => message.role === "tool")) {
            chunk({ tool_calls: [{ index: 0, id: "skill-call", type: "function", function: { name: "read_skill", arguments: '{"name":"alpha-skill"}' } }] });
            chunk({}, "tool_calls");
        } else {
            chunk({ content: "PI_OK" });
            chunk({}, "stop");
        }
        res.end("data: [DONE]\n\n");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const config = { config: { channels: [{ id: "test", name: "Test", baseUrl: `http://127.0.0.1:${port}`, apiKey: "test-key", apiFormat: "ark", models: [{ name: "test-model", capability: "text" }] }] } };
    try {
        await fs.writeFile(path.join(dataDir, "config.json"), JSON.stringify(config));
        assert.throws(() => resolvePiModel(config.config.channels as any, "test::missing"), /不可用/);
        for (const scenario of ["success", "tool", "error", "abort", "missing"] as const) {
            await t.test(scenario, async () => {
                cwd = await skillWorkspace();
                const store = new PiThreadStore(cwd);
                const thread = await store.create();
                const events: Array<Record<string, any>> = [];
                let boundTurn = "";
                mode = scenario;
                requests = [];
                if (scenario === "missing") await fs.writeFile(path.join(dataDir, "config.json"), "{}");
                await runPiTurn("Reply PI_OK", (_type, payload) => events.push(payload as Record<string, any>), [], {
                    cwd, session: new CanvasSession(), threadId: thread.id, onTurn: (id) => { boundTurn = id; },
                });
                const expected = scenario === "error" || scenario === "missing" ? "failed" : scenario === "abort" ? "interrupted" : "completed";
                assert.ok(boundTurn);
                assert.equal(events.find((event) => event.type === "turn.completed")?.status, expected);
                const stored = await store.read(thread.id);
                assert.equal(stored?.turns[0].status, expected);
                assert.equal(stored?.turns[0].turnId, boundTurn);
                if (expected === "failed") assert.ok(stored?.turns[0].messages.some((item) => item.role === "error"));
                if (scenario === "success" || scenario === "tool") assert.ok(stored?.turns[0].messages.some((item) => item.text === "PI_OK"));
                if (scenario === "success") assert.ok(JSON.stringify(requests[0].messages).includes("你是 Pi"), "Pi 的真实请求应携带引擎身份");
                if (scenario === "tool") {
                    assert.equal(requests.length, 2);
                    assert.ok(events.some((event) => event.item?.tool === "read_skill" && event.item.status === "completed"));
                }
                releasePiRuntime(cwd, thread.id);
            });
        }
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (previous === undefined) delete process.env.INFINITE_CANVAS_DATA_DIR;
        else process.env.INFINITE_CANVAS_DATA_DIR = previous;
    }
});

test("Pi OpenAI 使用 Responses 完成流式回复与工具往返", async () => {
    const dataDir = await temporaryWorkspace();
    const previous = process.env.INFINITE_CANVAS_DATA_DIR;
    process.env.INFINITE_CANVAS_DATA_DIR = dataDir;
    const requests: Array<{ url: string; body: Record<string, any> }> = [];
    const server = createServer(async (req, res) => {
        let body = "";
        for await (const chunk of req) body += chunk;
        const input = JSON.parse(body);
        requests.push({ url: req.url || "", body: input });
        const tool = !input.input.some((item: any) => item.type === "function_call_output");
        const item = tool
            ? { id: "fc_skill", type: "function_call", call_id: "skill-call", name: "read_skill", arguments: '{"name":"alpha-skill"}', status: "completed" }
            : { id: "msg_reply", type: "message", role: "assistant", content: [{ type: "output_text", text: "PI_RESPONSES_OK", annotations: [] }], status: "completed" };
        res.writeHead(200, { "content-type": "text/event-stream" });
        const event = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        event("response.created", { response: { id: `resp_${requests.length}`, status: "in_progress" } });
        event("response.output_item.added", { output_index: 0, item: { ...item, arguments: "", content: [] } });
        if (!tool) event("response.output_text.delta", { output_index: 0, content_index: 0, delta: "PI_RESPONSES_OK" });
        event("response.output_item.done", { output_index: 0, item });
        event("response.completed", { response: { id: `resp_${requests.length}`, status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } });
        res.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const cwd = await skillWorkspace();
    const store = new PiThreadStore(cwd);
    const thread = await store.create();
    try {
        const channels = [{ id: "responses", name: "Responses", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "test-key", apiFormat: "openai", models: [{ name: "test-model", capability: "text", apiFormat: "openai-responses" }] }];
        await fs.writeFile(path.join(dataDir, "config.json"), JSON.stringify({ config: { channels } }));
        assert.equal(resolvePiModel(channels, "responses::test-model").model.api, "openai-responses");
        const events: Array<Record<string, any>> = [];
        await runPiTurn("Read alpha-skill, then reply PI_RESPONSES_OK", (_type, payload) => events.push(payload as Record<string, any>), [], { cwd, session: new CanvasSession(), threadId: thread.id });
        assert.equal(events.find((event) => event.type === "turn.completed")?.status, "completed");
        assert.equal(requests.length, 2);
        assert.ok(requests.every((request) => request.url === "/v1/responses" && request.body.stream === true && !request.body.messages));
        assert.ok(events.some((event) => event.item?.tool === "read_skill" && event.item.status === "completed"));
        assert.ok(events.some((event) => event.type === "usage.updated" && event.usage?.input_tokens === 10 && event.usage?.output_tokens === 5));
        assert.ok((await store.read(thread.id))?.turns[0].messages.some((item) => item.text === "PI_RESPONSES_OK"));
    } finally {
        releasePiRuntime(cwd, thread.id);
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (previous === undefined) delete process.env.INFINITE_CANVAS_DATA_DIR;
        else process.env.INFINITE_CANVAS_DATA_DIR = previous;
    }
});

async function skillWorkspace() {
    const workspace = await temporaryWorkspace();
    for (const [name, description] of [["alpha-skill", "处理甲类任务。"], ["beta-skill", "处理乙类任务。"]] as const) {
        const directory = path.join(workspace, ".agents", "skills", name);
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nbody of ${name}\n`);
    }
    return workspace;
}

test("Skill 从工作空间 .agents/skills 读取并默认启用", async () => {
    const workspace = await skillWorkspace();
    const { skills, errors } = await loadPiSkills(workspace);
    assert.deepEqual(skills.map((skill) => skill.name), ["alpha-skill", "beta-skill"]);
    assert.ok(skills.every((skill) => skill.enabled));
    assert.deepEqual(errors, []);
    const summaries = piSkillSummaries(skills);
    assert.equal(summaries[0].scope, "repo");
    assert.equal(summaries[0].managed, true);
});

test("没有 Skill 目录时返回空列表而不是抛错", async () => {
    const { skills, errors } = await loadPiSkills(await temporaryWorkspace());
    assert.deepEqual(skills, []);
    assert.deepEqual(errors, []);
    assert.equal(skillsPromptBlock(skills), "");
});

test("系统提示词只包含已启用 Skill，且使用 read_skill 加载", async () => {
    const workspace = await skillWorkspace();
    await setPiSkillEnabled(workspace, "alpha-skill", false);
    const { skills } = await loadPiSkills(workspace);
    const block = skillsPromptBlock(skills);
    assert.ok(!block.includes("alpha-skill"), "停用的 Skill 不应出现在清单里");
    assert.ok(block.includes("beta-skill"));
    assert.ok(block.includes("<available_skills>"));
    assert.ok(block.includes("read_skill"), "应提示模型用 read_skill 加载");
});

test("停用状态持久化并可恢复", async () => {
    const workspace = await skillWorkspace();
    await setPiSkillEnabled(workspace, "alpha-skill", false);
    assert.equal((await loadPiSkills(workspace)).skills.find((skill) => skill.name === "alpha-skill")?.enabled, false);
    const raw = JSON.parse(await fs.readFile(path.join(workspace, ".infinite-canvas", "pi-skills.json"), "utf8"));
    assert.deepEqual(raw, { version: 1, disabled: ["alpha-skill"] });
    await setPiSkillEnabled(workspace, "alpha-skill", true);
    assert.equal((await loadPiSkills(workspace)).skills.every((skill) => skill.enabled), true);
});

test("切换不存在的 Skill 返回 404", async () => {
    const workspace = await skillWorkspace();
    await assert.rejects(() => setPiSkillEnabled(workspace, "missing", false), (error: Error & { statusCode?: number }) => error.statusCode === 404);
});

test("read_skill 返回正文并拒绝未启用或不存在", async () => {
    const workspace = await skillWorkspace();
    await setPiSkillEnabled(workspace, "alpha-skill", false);
    const { skills } = await loadPiSkills(workspace);
    const tool = createReadSkillTool(skills);
    const disabled = await tool.execute("t1", { name: "alpha-skill" });
    assert.equal(disabled.isError, true);
    const missing = await tool.execute("t2", { name: "nope" });
    assert.equal(missing.isError, true);
    const ok = await tool.execute("t3", { name: "beta-skill" });
    assert.equal(ok.isError, undefined);
    assert.ok(String(ok.content[0].text).includes("body of beta-skill"));
    assert.ok(!String(ok.content[0].text).includes("description:"), "应去掉 frontmatter");
});

test("显式选择 Skill 需要名称和路径同时匹配", async () => {
    const workspace = await skillWorkspace();
    const file = path.join(workspace, ".agents", "skills", "alpha-skill", "SKILL.md");
    const text = await resolveExplicitSkill(workspace, { name: "alpha-skill", path: file });
    assert.ok(text.startsWith("已加载 Skill：alpha-skill"));
    assert.ok(text.includes("body of alpha-skill"));
    await assert.rejects(() => resolveExplicitSkill(workspace, { name: "alpha-skill", path: "/elsewhere/SKILL.md" }), /找不到指定 Skill/);
    await assert.rejects(() => resolveExplicitSkill(workspace, { name: "", path: "" }), /Skill 选择无效/);
    await setPiSkillEnabled(workspace, "alpha-skill", false);
    await assert.rejects(() => resolveExplicitSkill(workspace, { name: "alpha-skill", path: file }), /已停用/);
});

test("Skill 指纹随启停变化，用于重建运行时", async () => {
    const workspace = await skillWorkspace();
    const before = skillsFingerprint((await loadPiSkills(workspace)).skills);
    await setPiSkillEnabled(workspace, "alpha-skill", false);
    const after = skillsFingerprint((await loadPiSkills(workspace)).skills);
    assert.notEqual(before, after);
});

test("Pi Skill 草稿使用所选模型，支持对话与画布来源、校验和停止，且不改写历史", async (t) => {
    const dataDir = await temporaryWorkspace();
    const cwd = await temporaryWorkspace();
    const previous = process.env.INFINITE_CANVAS_DATA_DIR;
    process.env.INFINITE_CANVAS_DATA_DIR = dataDir;
    const draft = { name: "pi-workflow", displayName: "Pi 工作流", description: "复用已完成的商品创作步骤", instructions: "分析产品信息，再组织可复用的生成步骤。", shortDescription: "", defaultPrompt: "使用 $pi-workflow 完成任务。" };
    let output: Record<string, unknown> = draft;
    let mode = "tool";
    let request: Record<string, any> = {};
    const server = createServer(async (req, res) => {
        let body = "";
        for await (const chunk of req) body += chunk;
        request = JSON.parse(body);
        if (mode === "error") {
            res.writeHead(401, { "content-type": "application/json" });
            return res.end(JSON.stringify({ error: { message: "draft credential rejected", type: "invalid_api_key" } }));
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: "draft", object: "chat.completion.chunk", created: 1, model: "selected-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        chunk({ role: "assistant" });
        if (mode === "abort") {
            chunk({ content: "partial" });
            setImmediate(() => interruptPiTurn(cwd));
            return;
        }
        if (mode === "text") chunk({ content: JSON.stringify(output) });
        else chunk({ tool_calls: [{ index: 0, id: "draft-call", type: "function", function: { name: "submit_skill_draft", arguments: JSON.stringify(output) } }] });
        chunk({}, mode === "text" ? "stop" : "tool_calls");
        res.end("data: [DONE]\n\n");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const store = new PiThreadStore(cwd);
    const thread = await store.create();
    await store.saveTurn(thread.id, { turnId: "completed-turn", userText: "创作商品图片", startedAt: 1, finishedAt: 2, status: "completed", messages: [
        { itemId: "user", turnId: "completed-turn", role: "user", text: "已完成任务的输入" },
        { itemId: "assistant", turnId: "completed-turn", role: "assistant", text: "已完成任务的步骤" },
        { itemId: "tool", turnId: "completed-turn", role: "tool", text: "不应提炼的工具日志" },
    ] }, [{ role: "user", content: "历史保留", timestamp: 1 }]);
    await store.saveTurn(thread.id, { turnId: "failed-turn", userText: "失败任务", startedAt: 3, finishedAt: 4, status: "failed", messages: [
        { itemId: "user", turnId: "failed-turn", role: "user", text: "不应提炼的失败任务" },
    ] }, [{ role: "user", content: "历史保留", timestamp: 1 }]);
    const before = await store.read(thread.id);
    const conversation = { source: "conversation" as const, threadId: thread.id, model: "draft::selected-model", effort: "none" };
    try {
        await fs.writeFile(path.join(dataDir, "config.json"), JSON.stringify({ config: { channels: [{ id: "draft", name: "Draft", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKey: "draft-key", apiFormat: "openai", models: [
            { name: "other-model", capability: "text", apiFormat: "openai-completions", reasoning: false },
            { name: "selected-model", capability: "text", apiFormat: "openai-completions", reasoning: false },
        ] }] } }));
        await t.test("对话来源使用独立上下文和唯一草稿工具", async () => {
            assert.deepEqual(await generatePiSkillDraft(cwd, conversation), draft);
            assert.equal(request.model, "selected-model");
            assert.deepEqual(request.tools.map((tool: any) => tool.function.name), ["submit_skill_draft"]);
            const text = JSON.stringify(request.messages);
            assert.match(text, /已完成任务的输入/);
            assert.match(text, /已完成任务的步骤/);
            assert.doesNotMatch(text, /不应提炼的工具日志|不应提炼的失败任务/);
        });
        await t.test("画布来源复用清理规则并接受 JSON 文本结果", async () => {
            mode = "text";
            assert.deepEqual(await generatePiSkillDraft(cwd, { source: "canvas", model: conversation.model, snapshot: { nodes: [{ id: "private-node-id", type: "text", title: "产品流程", metadata: { content: "分析产品，再生成图片", apiKey: "private-test-token" } }], connections: [] } }), draft);
            assert.doesNotMatch(JSON.stringify(request.messages), /private-node-id|private-test-token/);
            assert.match(JSON.stringify(request.messages), /产品流程/);
        });
        await t.test("无已完成对话时拒绝生成", async () => {
            const empty = await store.create();
            await assert.rejects(generatePiSkillDraft(cwd, { ...conversation, threadId: empty.id }), /没有可提炼的已完成内容/);
        });
        await t.test("拒绝格式错误、无效默认提示词与敏感结果", async () => {
            mode = "tool";
            output = { ...draft, name: "Invalid_Name" };
            await assert.rejects(generatePiSkillDraft(cwd, conversation), /格式不正确/);
            output = { ...draft, defaultPrompt: "缺少调用标记" };
            await assert.rejects(generatePiSkillDraft(cwd, conversation), /格式不正确/);
            output = { ...draft, instructions: "复制 https://example.com/private-result" };
            await assert.rejects(generatePiSkillDraft(cwd, conversation), /包含外部地址/);
            output = draft;
        });
        await t.test("上游错误与停止后仍能继续生成", async () => {
            mode = "error";
            await assert.rejects(generatePiSkillDraft(cwd, conversation), /draft credential rejected/);
            mode = "abort";
            await assert.rejects(generatePiSkillDraft(cwd, conversation), /已取消/);
            assert.equal(interruptPiTurn(cwd), false);
            mode = "tool";
            assert.deepEqual(await generatePiSkillDraft(cwd, conversation), draft);
        });
        assert.deepEqual(await store.read(thread.id), before, "提炼草稿不得改写原始对话");
        await assert.rejects(fs.access(path.join(cwd, ".agents", "skills")), "确认前不得写入 Skill 文件");
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (previous === undefined) delete process.env.INFINITE_CANVAS_DATA_DIR;
        else process.env.INFINITE_CANVAS_DATA_DIR = previous;
    }
});
