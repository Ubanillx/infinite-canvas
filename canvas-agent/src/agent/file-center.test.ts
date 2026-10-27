import assert from "node:assert/strict";
import { Readable } from "node:stream";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FileCenter, FILE_LIMITS, artifactKind, safeFileName } from "./file-center.js";

test("上传文件流式落盘并按 fileId 读取", async (t) => {
    const center = await createCenter(t);
    const file = await center.save(Readable.from([Buffer.from("hello "), Buffer.from("world")]), { name: "notes.txt", type: "text/plain" });
    assert.equal(file.name, "notes.txt");
    assert.equal(file.size, 11);
    assert.equal(file.origin, "upload");

    const read = await center.read(file.fileId);
    assert.equal(read.data.toString(), "hello world");
    assert.equal(read.file.type, "text/plain");
    assert.equal(await fs.readFile(file.path).then((data) => data.toString()), "hello world");
});

test("只按 fileId 读取，未知 ID 直接拒绝", async (t) => {
    const center = await createCenter(t);
    await assert.rejects(() => center.read("../../etc/passwd"), /找不到该文件/);
    await assert.rejects(() => center.read("not-a-file"), /找不到该文件/);
});

test("文件名不能逃出 fileId 目录", async (t) => {
    const center = await createCenter(t);
    const file = await center.save(Readable.from([Buffer.from("x")]), { name: "../../evil.txt", type: "text/plain" });
    assert.equal(file.name, "evil.txt");
    assert.equal(path.relative(center.root, file.path).startsWith(".."), false);
    assert.equal(safeFileName(".."), "_");
});

test("超时未绑定的文件会被清理", async (t) => {
    const center = await createCenter(t);
    const file = await center.save(Readable.from([Buffer.from("x")]), { name: "a.md", type: "text/markdown" });
    const indexPath = path.join(center.root, "index.json");
    const index = JSON.parse(await fs.readFile(indexPath, "utf8")) as { version: 1; files: Array<{ createdAt: number }> };
    index.files[0].createdAt = Date.now() - FILE_LIMITS.pendingMs - 1000;
    await fs.writeFile(indexPath, JSON.stringify(index));

    await center.sweep(true);
    assert.deepEqual(await center.list(""), []);
    await assert.rejects(() => fs.access(path.join(center.root, file.fileId)), /ENOENT/);
});

test("未知版本的索引拒绝覆盖", async (t) => {
    const center = await createCenter(t);
    await fs.mkdir(center.root, { recursive: true });
    const indexPath = path.join(center.root, "index.json");
    await fs.writeFile(indexPath, '{"version":99,"files":[]}');
    await assert.rejects(() => center.save(Readable.from([Buffer.from("x")]), { name: "a.txt", type: "text/plain" }), /Unsupported file center index version/);
    assert.equal(await fs.readFile(indexPath, "utf8"), '{"version":99,"files":[]}');
});

test("绑定会话时校验数量与失效文件", async (t) => {
    const center = await createCenter(t);
    const first = await center.save(Readable.from([Buffer.from("1")]), { name: "a.txt", type: "text/plain" });
    const second = await center.save(Readable.from([Buffer.from("2")]), { name: "b.txt", type: "text/plain" });

    const bound = await center.bind([first.fileId], "thread-1");
    assert.equal(bound.length, 1);
    assert.equal(bound[0].threadId, "thread-1");
    assert.equal(bound[0].path, path.join(center.root, first.fileId, "a.txt"));

    await assert.rejects(() => center.bind([first.fileId], "thread-2"), /另一会话/);
    await assert.rejects(() => center.bind(["missing"], "thread-1"), /已失效/);

    const many: string[] = [];
    for (let index = 0; index < FILE_LIMITS.filesPerTurn + 1; index += 1) {
        many.push((await center.save(Readable.from([Buffer.from(String(index))]), { name: `${index}.txt`, type: "text/plain" })).fileId);
    }
    await assert.rejects(() => center.bind(many, "thread-1"), /文件附件/);
    assert.equal((await center.bind([second.fileId], "thread-1")).length, 1);
});

test("删除会话只清理该会话的文件", async (t) => {
    const center = await createCenter(t);
    const kept = await center.save(Readable.from([Buffer.from("keep")]), { name: "keep.txt", type: "text/plain", threadId: "thread-1" });
    const removed = await center.save(Readable.from([Buffer.from("drop")]), { name: "drop.txt", type: "text/plain", threadId: "thread-2" });
    await center.removeThread("thread-2");

    assert.deepEqual((await center.list("thread-1")).map((file) => file.fileId), [kept.fileId]);
    await assert.rejects(() => fs.access(path.join(center.root, removed.fileId)), /ENOENT/);
});

test("产物只允许工作区内的图片与文本文件", async (t) => {
    const center = await createCenter(t);
    const workspace = center.workspacePath;
    const markdown = path.join(workspace, "result.md");
    await fs.writeFile(markdown, "# 标题\n正文");
    const artifact = await center.registerArtifact(markdown, "thread-1");
    assert.equal(artifact.kind, "text");
    assert.equal(artifact.name, "result.md");
    assert.equal(artifact.type, "text/markdown");
    assert.equal(artifact.size, Buffer.byteLength("# 标题\n正文"));

    const png = path.join(workspace, "result.png");
    await fs.writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    assert.equal((await center.registerArtifact(png, "thread-1")).kind, "image");
    await assert.rejects(() => center.registerArtifact(png, "thread-1", "text"), /不是文本/);

    const binary = path.join(workspace, "archive.zip");
    await fs.writeFile(binary, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    await assert.rejects(() => center.registerArtifact(binary, "thread-1"), /只支持导入图片或文本类文件/);

    const outside = path.join(os.tmpdir(), `outside-${Date.now()}.md`);
    await fs.writeFile(outside, "x");
    t.after(() => fs.rm(outside, { force: true }));
    await assert.rejects(() => center.registerArtifact(outside, "thread-1"), /当前工作区内/);

    const missing = path.join(workspace, "missing.md");
    await assert.rejects(() => center.registerArtifact(missing, "thread-1"), /找不到文件/);
});

test("产物类型按 MIME 与扩展名归一", () => {
    assert.equal(artifactKind("image/png", "a.png"), "image");
    assert.equal(artifactKind("text/markdown", "a.md"), "text");
    assert.equal(artifactKind("application/json", "a.json"), "text");
    assert.equal(artifactKind("application/octet-stream", "a.csv"), "text");
    assert.equal(artifactKind("application/octet-stream", "a.pdf"), null);
    assert.equal(artifactKind("application/octet-stream", "a.bin"), null);
});

async function createCenter(t: { after: (fn: () => Promise<unknown>) => void }) {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "file-center-"));
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    return new FileCenter(workspace);
}
