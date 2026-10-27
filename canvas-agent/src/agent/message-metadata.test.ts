import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { MessageMetadataStore } from "./message-metadata.js";

test("message metadata survives Agent restarts", async (context) => {
    const fixture = await createFixture(context);
    await fixture.store.recordPending("message-1", sampleMetadata());
    await fixture.store.bindThread("message-1", "thread-1");
    await fixture.store.bindTurn("message-1", "thread-1", "turn-1");

    const [message] = await fixture.reopen().mergeThread("thread-1", [{ role: "user", threadId: "thread-1", turnId: "turn-1", text: "Generate product images" }]);
    assert.equal(message.clientMessageId, "message-1");
    assert.equal(message.attachments?.[0].name, "image.png");
    assert.equal(message.canvasReferences?.[0].nodeId, "node-1");
    assert.equal(message.skill?.name, "product-grid");
});

test("message preview assets survive restarts and are deleted with their thread", async (context) => {
    const fixture = await createFixture(context);
    const metadata = await fixture.store.recordPending("message-1", sampleMetadata());
    await fixture.store.bindTurn("message-1", "thread-1", "turn-1");

    const match = metadata?.attachments?.[0].url.match(/^agent-asset:([a-f0-9]{64})\/([a-f0-9]{64}\.png)$/);
    assert.ok(match);
    const asset = await fixture.reopen().readAsset(match[1], match[2]);
    assert.equal(asset?.contentType, "image/png");
    assert.equal(asset?.data.toString(), "a");

    await fixture.store.removeThread("thread-1");
    assert.equal(await fixture.reopen().readAsset(match[1], match[2]), undefined);
});

test("deleting a thread only removes its metadata", async (context) => {
    const fixture = await createFixture(context);
    for (const number of [1, 2]) {
        await fixture.store.recordPending(`message-${number}`, { skill: { name: `skill-${number}`, path: `D:\\skills\\skill-${number}\\SKILL.md` } });
        await fixture.store.bindTurn(`message-${number}`, `thread-${number}`, `turn-${number}`);
    }
    await fixture.store.removeThread("thread-1");

    const first = await fixture.reopen().mergeThread("thread-1", [{ role: "user", threadId: "thread-1", turnId: "turn-1" }]);
    const second = await fixture.reopen().mergeThread("thread-2", [{ role: "user", threadId: "thread-2", turnId: "turn-2" }]);
    assert.equal(first[0].skill, undefined);
    assert.equal(second[0].skill?.name, "skill-2");
});

test("history metadata is matched by thread and turn instead of client message id alone", async (context) => {
    const fixture = await createFixture(context);
    await fixture.store.recordPending("message-1", { skill: { name: "product-grid", path: "D:\\skills\\product-grid\\SKILL.md" } });
    await fixture.store.bindTurn("message-1", "thread-1", "turn-1");

    const [message] = await fixture.store.mergeThread("thread-1", [{ role: "user", threadId: "thread-1", turnId: "turn-2", clientMessageId: "message-1" }]);
    assert.equal(message.skill, undefined);
});

test("unknown storage versions are never overwritten", async (context) => {
    const fixture = await createFixture(context, false);
    await fs.mkdir(fixture.storeDirectory, { recursive: true });
    const manifestFile = path.join(fixture.storeDirectory, "manifest.json");
    await fs.writeFile(manifestFile, '{"version":99}');

    await assert.rejects(() => fixture.store.recordPending("message-1", sampleMetadata()), /Unsupported message metadata version/);
    assert.equal(await fs.readFile(manifestFile, "utf8"), '{"version":99}');
});

test("storage without a manifest is never overwritten", async (context) => {
    const fixture = await createFixture(context, false);
    await fs.mkdir(fixture.storeDirectory, { recursive: true });
    const existingFile = path.join(fixture.storeDirectory, "existing.json");
    await fs.writeFile(existingFile, "existing data");

    await assert.rejects(() => fixture.store.mergeThread("thread-1", []), /missing manifest/);
    assert.equal(await fs.readFile(existingFile, "utf8"), "existing data");
});

test("oversized image previews are rejected instead of silently dropped", async (context) => {
    const fixture = await createFixture(context);
    await assert.rejects(
        () => fixture.store.recordPending("message-1", { attachments: [{ id: "image-1", name: "large.png", url: `data:image/png;base64,${"a".repeat(500_001)}` }] }),
        /attachments metadata is invalid/,
    );
});

test("文件附件只靠 fileId 记录并能在历史里读回", async (context) => {
    const fixture = await createFixture(context);
    const metadata = await fixture.store.recordPending("message-1", { attachments: [{ id: "file-1", name: "report.pdf", size: 1048576, type: "application/pdf", fileId: "6f0c" }] });
    await fixture.store.bindTurn("message-1", "thread-1", "turn-1");

    assert.deepEqual(metadata?.attachments?.[0], { id: "file-1", name: "report.pdf", size: 1048576, type: "application/pdf", kind: "file", fileId: "6f0c" });
    const [message] = await fixture.reopen().mergeThread("thread-1", [{ role: "user", threadId: "thread-1", turnId: "turn-1" }]);
    assert.equal(message.attachments?.[0].fileId, "6f0c");
    assert.equal(message.attachments?.[0].url, undefined);
});

test("v1 存储升级到 v2 前会先备份原目录", async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-agent-message-metadata-"));
    context.after(() => fs.rm(root, { recursive: true, force: true }));
    const storeDirectory = path.join(root, "message-metadata");
    const threadDirectory = path.join(storeDirectory, "threads", createHash("sha256").update("thread-1").digest("hex"));
    await fs.mkdir(threadDirectory, { recursive: true });
    await fs.mkdir(path.join(storeDirectory, "pending"), { recursive: true });
    await fs.mkdir(path.join(storeDirectory, "assets"), { recursive: true });
    await fs.writeFile(path.join(storeDirectory, "manifest.json"), '{"version":1}');
    const record = { version: 1, clientMessageId: "message-1", threadId: "thread-1", turnId: "turn-1", createdAt: 1, metadata: sampleMetadata() };
    await fs.writeFile(path.join(threadDirectory, "record.json"), JSON.stringify(record));

    const store = new MessageMetadataStore(storeDirectory);
    const [message] = await store.mergeThread("thread-1", [{ role: "user", threadId: "thread-1", turnId: "turn-1" }]);
    assert.equal(message.clientMessageId, "message-1");
    assert.equal(message.attachments?.[0].name, "image.png");
    assert.equal(JSON.parse(await fs.readFile(path.join(storeDirectory, "manifest.json"), "utf8")).version, 2);

    const backups = (await fs.readdir(root)).filter((name) => name.startsWith("message-metadata.v1-backup-"));
    assert.equal(backups.length, 1);
    assert.equal(JSON.parse(await fs.readFile(path.join(root, backups[0], "manifest.json"), "utf8")).version, 1);
    assert.ok((await fs.readdir(path.join(root, backups[0], "threads", createHash("sha256").update("thread-1").digest("hex")))).length);
});

test("损坏的 v1 记录中止迁移且不写新版本清单", async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-agent-message-metadata-"));
    context.after(() => fs.rm(root, { recursive: true, force: true }));
    const storeDirectory = path.join(root, "message-metadata");
    await fs.mkdir(path.join(storeDirectory, "pending"), { recursive: true });
    await fs.mkdir(path.join(storeDirectory, "threads"), { recursive: true });
    await fs.writeFile(path.join(storeDirectory, "manifest.json"), '{"version":1}');
    await fs.writeFile(path.join(storeDirectory, "pending", "broken.json"), '{"version":1}');

    await assert.rejects(() => new MessageMetadataStore(storeDirectory).mergeThread("thread-1", []), /record is invalid/);
    assert.equal(JSON.parse(await fs.readFile(path.join(storeDirectory, "manifest.json"), "utf8")).version, 1);
});

async function createFixture(context: TestContext, initialize = true) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-agent-message-metadata-"));
    context.after(() => fs.rm(root, { recursive: true, force: true }));
    const storeDirectory = path.join(root, "message-metadata");
    const createStore = () => new MessageMetadataStore(storeDirectory);
    const fixture = { root, storeDirectory, store: createStore(), reopen: createStore };
    if (initialize) await fixture.store.mergeThread("empty", []);
    return fixture;
}

function sampleMetadata() {
    return {
        attachments: [{ id: "image-1", name: "image.png", url: "data:image/png;base64,YQ==" }],
        canvasReferences: [{ nodeId: "node-1", label: "Image 1", title: "Product image", kind: "image", previewUrl: "data:image/png;base64,YQ==" }],
        skill: { name: "product-grid", path: "D:\\skills\\product-grid\\SKILL.md", displayName: "Product grid" },
    };
}
