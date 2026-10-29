import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SkillStore, SkillStoreError } from "./store.js";

function importFile(filePath: string, content: string | Buffer) {
    return { path: filePath, content: Buffer.from(content).toString("base64") };
}

function importDocument(name = "imported-skill") {
    return `---\nname: ${name}\ndescription: 导入可复用的技能\nmetadata:\n  source: upload\n---\n\n# 执行说明\n\n读取 references/说明.md 并运行 scripts/run.py。\n`;
}

test("导入带外层目录的 Skill，按声明名称安装并保留二进制及元数据", async (context) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-skill-import-"));
    context.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const store = new SkillStore(workspace);
    const document = importDocument();
    const binary = Buffer.from([0, 255, 10, 128, 1]);
    const openAi = 'interface:\n  display_name: "导入技能"\n  default_prompt: "使用 $imported-skill"\npolicy:\n  allow_implicit_invocation: false\n';
    const result = await store.import([
        importFile("archive/skill-folder/SKILL.md", document),
        importFile("archive/skill-folder/agents/openai.yaml", openAi),
        importFile("archive/skill-folder/references/说明.md", "参考资料"),
        importFile("archive/skill-folder/scripts/run.py", "print('ok')\n"),
        importFile("archive/skill-folder/assets/sample.bin", binary),
        importFile("archive/README.md", "外层文件"),
        importFile("__MACOSX/skill-folder/._SKILL.md", "忽略元数据"),
        importFile("archive/skill-folder/.DS_Store", "忽略元数据"),
    ]);
    assert.equal(result.name, "imported-skill");
    assert.equal(result.interface?.displayName, "导入技能");
    assert.equal(result.managed, true);
    assert.equal(store.isManagedPath(result.path), true);
    const directory = path.dirname(result.path);
    assert.equal(await fs.readFile(result.path, "utf8"), document);
    assert.equal(await fs.readFile(path.join(directory, "agents/openai.yaml"), "utf8"), openAi);
    assert.equal(await fs.readFile(path.join(directory, "references/说明.md"), "utf8"), "参考资料");
    assert.deepEqual(await fs.readFile(path.join(directory, "assets/sample.bin")), binary);
    await assert.rejects(fs.access(path.join(directory, "README.md")));
    await assert.rejects(fs.access(path.join(directory, ".DS_Store")));
    assert.deepEqual(await store.get(result.name), result);
});

test("导入根目录 Skill，保留资源中的嵌套 Skill 示例", async (context) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-skill-import-"));
    context.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const store = new SkillStore(workspace);
    const result = await store.import([
        importFile("SKILL.md", importDocument()),
        importFile("references/example/SKILL.md", "# 示例"),
    ]);
    assert.equal(await fs.readFile(path.join(path.dirname(result.path), "references/example/SKILL.md"), "utf8"), "# 示例");
});

test("缺少入口、多个独立 Skill 或无效描述与正文时不写文件", async (context) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-skill-import-"));
    context.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const store = new SkillStore(workspace);
    await assert.rejects(store.import([]), /未选择/);
    await assert.rejects(store.import(undefined as never), /未选择/);
    await assert.rejects(store.import([importFile("README.md", "说明")]), /未找到 SKILL.md/);
    await assert.rejects(store.import([importFile("a/SKILL.md", importDocument()), importFile("b/SKILL.md", importDocument("another-skill"))]), /多个 Skill/);
    for (const content of ["# 无 frontmatter", "---\nname: invalid_name\ndescription: 示例\n---\n正文", "---\nname: example\n---\n正文", "---\nname: example\ndescription: 示例\n---\n", "---\nname: [invalid\n---\n正文"]) {
        await assert.rejects(store.import([importFile("SKILL.md", content)]), (error: unknown) => error instanceof SkillStoreError);
    }
    assert.deepEqual(await fs.readdir(workspace), []);
});

test("上传的 frontmatter 只能是 YAML，不能执行 JavaScript", async (context) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-skill-import-"));
    context.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const store = new SkillStore(workspace);
    const content = '---javascript\n(() => { throw new Error("不应执行此代码"); })()\n---\n正文';
    await assert.rejects(store.import([importFile("SKILL.md", content)]), /必须以 YAML frontmatter/);
    assert.deepEqual(await fs.readdir(workspace), []);
});

test("拒绝越界路径、Windows 特殊路径、重复与文件目录冲突", async (context) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-skill-import-"));
    context.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const store = new SkillStore(workspace);
    const entry = importFile("SKILL.md", importDocument());
    for (const filePath of ["../escape.txt", "/absolute.txt", "C:\\escape.txt", "safe/../../escape.txt", "safe\\..\\escape.txt", "script.py:payload", "scripts/file. ", "NUL.txt"]) {
        await assert.rejects(store.import([entry, importFile(filePath, "内容")]), /不安全的文件路径/);
    }
    await assert.rejects(store.import([entry, importFile("skill.md", "重复")]), /重复文件路径/);
    await assert.rejects(store.import([entry, importFile("scripts", "文件"), importFile("scripts/run.py", "正文")]), /文件与目录路径冲突/);
    await assert.rejects(store.import([entry, importFile("agents", "文件")]), /必须是目录/);
    await assert.rejects(store.import([entry, { path: "data.bin", content: "无效 base64" }]), /文件编码无效/);
    assert.deepEqual(await fs.readdir(workspace), []);
});

test("并发导入同名 Skill 只成功一次，已有内容不被覆盖", async (context) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-skill-import-"));
    context.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const store = new SkillStore(workspace);
    const results = await Promise.allSettled([
        store.import([importFile("SKILL.md", importDocument()), importFile("data.txt", "保留内容")]),
        store.import([importFile("SKILL.md", importDocument()), importFile("data.txt", "不得覆盖")]),
    ]);
    assert.equal(results[0].status, "fulfilled");
    assert.equal(results[1].status, "rejected");
    if (results[1].status === "rejected") assert.match(results[1].reason.message, /同名 Skill 已存在/);
    const result = await store.get("imported-skill");
    assert.equal(await fs.readFile(path.join(path.dirname(result.path), "data.txt"), "utf8"), "保留内容");
});

test("无效 openai.yaml 在写入前被拒绝，失败后仍可重新导入", async (context) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-skill-import-"));
    context.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const store = new SkillStore(workspace);
    const files = [importFile("SKILL.md", importDocument())];
    await assert.rejects(store.import([...files, importFile("agents/openai.yaml", "interface: false\n")]), /interface 格式无效/);
    assert.deepEqual(await fs.readdir(workspace), []);
    assert.equal((await store.import(files)).name, "imported-skill");
});

test("资源写入失败时清理本次创建的目录，不留下半成品 Skill", async (context) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-skill-import-"));
    context.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const store = new SkillStore(workspace);
    const entry = importFile("SKILL.md", importDocument());
    await assert.rejects(store.import([entry, importFile("assets/first.txt", "先写入资源"), importFile("x".repeat(300), "触发文件系统错误")]));
    assert.deepEqual(await fs.readdir(store.skillsPath), []);
    assert.equal((await store.import([entry])).name, "imported-skill");
});

test("创建、读取和更新画布专属 Skill", async (context) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-skill-store-"));
    context.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const store = new SkillStore(workspace);

    const created = await store.create({
        name: "product-grid",
        description: "生成商品九宫格",
        instructions: "根据商品信息创建九宫格生成流程。",
        interface: {
            displayName: "产品九宫格生成",
            shortDescription: "根据商品资料与参考图自动规划并生成产品图片九宫格流程",
            defaultPrompt: "Use $product-grid to build a product image grid.",
        },
    });
    assert.equal(created.managed, true);
    assert.equal(created.interface?.displayName, "产品九宫格生成");
    assert.equal(created.revision.length, 64);
    assert.equal(store.isManagedPath(created.path), true);
    const openAi = await fs.readFile(path.join(path.dirname(created.path), "agents", "openai.yaml"), "utf8");
    assert.match(openAi, /^interface:/m);
    assert.match(openAi, /display_name: "产品九宫格生成"/);

    const updated = await store.update("product-grid", {
        description: "生成商品图片九宫格",
        instructions: "先分析商品，再创建九宫格生成流程。",
        interface: { displayName: "产品九宫格生成" },
        expectedRevision: created.revision,
    });
    assert.equal(updated.description, "生成商品图片九宫格");
    assert.notEqual(updated.revision, created.revision);
    assert.deepEqual(updated.interface, { displayName: "产品九宫格生成" });
});

test("revision 不匹配时拒绝覆盖或删除", async (context) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-skill-store-"));
    context.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const store = new SkillStore(workspace);
    const created = await store.create({ name: "demo", description: "演示 Skill", instructions: "执行演示流程。" });

    await assert.rejects(store.update("demo", {
        description: "已过期的修改",
        instructions: "不会写入。",
        expectedRevision: "0".repeat(64),
    }), (error: unknown) => error instanceof SkillStoreError && error.statusCode === 409);
    await assert.rejects(store.delete("demo", "0".repeat(64)), (error: unknown) => error instanceof SkillStoreError && error.statusCode === 409);
    assert.equal((await store.get("demo")).revision, created.revision);
});

test("清空界面字段时保留未由画布管理的 openai 元数据", async (context) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-skill-store-"));
    context.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const store = new SkillStore(workspace);
    const created = await store.create({
        name: "metadata-demo",
        description: "演示界面元数据",
        instructions: "执行演示流程。",
        interface: { displayName: "演示", defaultPrompt: "Use $metadata-demo to run the demo." },
    });
    const openAiFile = path.join(path.dirname(created.path), "agents", "openai.yaml");
    await fs.writeFile(openAiFile, "interface:\n  display_name: 演示\n  default_prompt: Use $metadata-demo to run the demo.\n  icon_small: ./assets/icon.png\n  brand_color: '#336699'\n", "utf8");
    const current = await store.get("metadata-demo");

    const updated = await store.update("metadata-demo", {
        description: current.description,
        instructions: current.instructions,
        interface: null,
        expectedRevision: current.revision,
    });
    const openAi = await fs.readFile(openAiFile, "utf8");
    assert.equal(updated.interface, undefined);
    assert.match(openAi, /icon_small:/);
    assert.match(openAi, /brand_color:/);
    assert.doesNotMatch(openAi, /display_name:|default_prompt:/);
});

test("名称、正文大小和默认提示词均经过校验", async (context) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-skill-store-"));
    context.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const store = new SkillStore(workspace);

    await assert.rejects(store.create({ name: "Invalid_Name", description: "无效", instructions: "无效" }), (error: unknown) => error instanceof SkillStoreError && error.statusCode === 400);
    await assert.rejects(store.create({ name: "invalid-description", description: "包含 <标签>", instructions: "无效" }), /尖括号/);
    await assert.rejects(store.create({ name: "too-large", description: "过大", instructions: "中".repeat(90_000) }), /256KiB/);
    await assert.rejects(store.create({
        name: "prompt-check",
        description: "校验默认提示词",
        instructions: "执行流程。",
        interface: { defaultPrompt: "Use this skill." },
    }), /\$prompt-check/);
    await assert.rejects(store.create({
        name: "prompt-check",
        description: "校验默认提示词边界",
        instructions: "执行流程。",
        interface: { defaultPrompt: "Use $prompt-check-extra instead." },
    }), /\$prompt-check/);
    await assert.rejects(store.create({
        name: "prompt-check",
        description: "校验命名空间提示词边界",
        instructions: "执行流程。",
        interface: { defaultPrompt: "Use $prompt-check:other instead." },
    }), /\$prompt-check/);
    await assert.rejects(store.create({
        name: "short-description-check",
        description: "校验卡片短说明长度",
        instructions: "执行流程。",
        interface: { shortDescription: "过短" },
    }), /不能少于 25 个字符/);
    await assert.rejects(store.create({
        name: "prompt-check",
        description: "校验默认提示词大小写",
        instructions: "执行流程。",
        interface: { defaultPrompt: "Use $PROMPT-CHECK instead." },
    }), /\$prompt-check/);
    await assert.rejects(store.create({
        name: "invalid-interface",
        description: "校验界面元数据",
        instructions: "执行流程。",
        interface: false as never,
    }), /界面元数据无效/);
});

test("更新校验失败时不会提前改写 SKILL.md", async (context) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-skill-store-"));
    context.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const store = new SkillStore(workspace);
    const created = await store.create({ name: "safe-update", description: "保留原内容", instructions: "执行原流程。" });

    await assert.rejects(store.update("safe-update", {
        description: "不应写入",
        instructions: "不应写入。",
        interface: { defaultPrompt: "缺少 Skill 名称" },
        expectedRevision: created.revision,
    }), /\$safe-update/);
    assert.deepEqual(await store.get("safe-update"), created);
});

test("拒绝读取非对象格式的 openai.yaml", async (context) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-skill-store-"));
    context.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const store = new SkillStore(workspace);
    const created = await store.create({ name: "invalid-metadata", description: "校验元数据", instructions: "执行流程。" });
    const agentsDir = path.join(path.dirname(created.path), "agents");
    await fs.mkdir(agentsDir);
    await fs.writeFile(path.join(agentsDir, "openai.yaml"), "- invalid\n", "utf8");

    await assert.rejects(store.get("invalid-metadata"), (error: unknown) => error instanceof SkillStoreError && error.statusCode === 409);
});

test("不完整更新请求返回校验错误而不是运行时异常", async (context) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-skill-store-"));
    context.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const store = new SkillStore(workspace);

    await assert.rejects(store.update("demo", undefined as never), (error: unknown) => error instanceof SkillStoreError && error.statusCode === 400);
});

test("空 interface 元数据读取为空", async (context) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-skill-store-"));
    context.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const store = new SkillStore(workspace);
    const created = await store.create({ name: "empty-interface", description: "空界面元数据", instructions: "执行流程。" });
    const agentsDir = path.join(path.dirname(created.path), "agents");
    await fs.mkdir(agentsDir);
    await fs.writeFile(path.join(agentsDir, "openai.yaml"), "interface: {}\n", "utf8");

    assert.equal((await store.get("empty-interface")).interface, undefined);
});

test("读取或修改不存在的 Skill 不会创建目录", async (context) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-skill-store-"));
    context.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const store = new SkillStore(workspace);
    const skillsRoot = path.join(workspace, ".agents", "skills");

    await assert.rejects(store.get("missing"), (error: unknown) => error instanceof SkillStoreError && error.statusCode === 404);
    await assert.rejects(store.update("missing", {
        description: "不存在",
        instructions: "不会写入。",
        expectedRevision: "0".repeat(64),
    }), (error: unknown) => error instanceof SkillStoreError && error.statusCode === 404);
    await assert.rejects(store.delete("missing", "0".repeat(64)), (error: unknown) => error instanceof SkillStoreError && error.statusCode === 404);
    await assert.rejects(fs.access(skillsRoot));
});

test("更新后只保留完整文件且不遗留临时文件", async (context) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-skill-store-"));
    context.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const store = new SkillStore(workspace);
    const created = await store.create({
        name: "atomic-update",
        description: "验证原子更新",
        instructions: "执行旧流程。",
        interface: { displayName: "原子更新" },
    });

    const updated = await store.update("atomic-update", {
        description: "验证完整更新",
        instructions: "执行新流程。",
        interface: { displayName: "完整更新" },
        expectedRevision: created.revision,
    });
    const skillDirectory = path.dirname(updated.path);
    const skillText = await fs.readFile(updated.path, "utf8");
    const openAiText = await fs.readFile(path.join(skillDirectory, "agents", "openai.yaml"), "utf8");
    assert.match(skillText, /description: 验证完整更新/);
    assert.match(skillText, /执行新流程/);
    assert.match(openAiText, /display_name: "完整更新"/);
    assert.deepEqual((await fs.readdir(skillDirectory)).filter((name) => name.endsWith(".tmp")), []);
    assert.deepEqual((await fs.readdir(path.join(skillDirectory, "agents"))).filter((name) => name.endsWith(".tmp")), []);
});

test("拒绝读取非对象格式的 interface 元数据", async (context) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-skill-store-"));
    context.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const store = new SkillStore(workspace);
    const created = await store.create({ name: "invalid-interface", description: "校验界面元数据", instructions: "执行流程。" });
    const agentsDir = path.join(path.dirname(created.path), "agents");
    await fs.mkdir(agentsDir);
    await fs.writeFile(path.join(agentsDir, "openai.yaml"), "interface: false\n", "utf8");

    await assert.rejects(store.get("invalid-interface"), (error: unknown) => error instanceof SkillStoreError && error.statusCode === 409);
});
