import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { zodToJsonSchema } from "zod-to-json-schema";
import { Compile } from "typebox/compile";

import { toolDescriptions, toolInputSchemas, toolNames } from "../../canvas/schemas.js";
import { createReadSkillTool, loadPiSkills, piSkillSummaries, resolveExplicitSkill, setPiSkillEnabled, skillsFingerprint, skillsPromptBlock } from "./skills.js";
import { piToolSchema } from "./tools.js";
import { PiThreadStore, readPiThread, settledTurnIds, threadMessages } from "./store.js";
import { piModelOptions, readPiChannels } from "./model.js";

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
