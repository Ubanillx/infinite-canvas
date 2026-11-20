import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { ToolReceiptStore, type ToolReceipt } from "./tool-receipts.js";

function fixture(t: TestContext) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-tool-receipt-store-"));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const store = new ToolReceiptStore(workspace);
    const receipt: ToolReceipt = { requestId: crypto.randomUUID(), clientId: "tab", connectionId: crypto.randomUUID(), name: "canvas_apply_ops", status: "pending" };
    const root = path.join(workspace, ".infinite-canvas", "tool-receipts");
    const file = path.join(root, `${receipt.requestId}.json`);
    return { workspace, store, receipt, root, file };
}

test("a failed flush does not replace the durable intent or publish a result in memory", (t) => {
    const { workspace, store, receipt, root, file } = fixture(t);
    store.set(receipt);
    const original = fs.readFileSync(file, "utf8");
    const flush = t.mock.method(fs, "fsyncSync", () => { throw new Error("disk flush failed"); });
    assert.throws(() => store.set({ ...receipt, status: "completed", result: { saved: true } }), /disk flush failed/);
    flush.mock.restore();
    assert.equal(fs.readFileSync(file, "utf8"), original);
    assert.equal(store.get(receipt.requestId)?.status, "pending");
    assert.equal(new ToolReceiptStore(workspace).get(receipt.requestId)?.status, "unknown");
    assert.deepEqual(fs.readdirSync(root), [`${receipt.requestId}.json`]);
});

test("a failed atomic rename preserves the previous receipt for browser resubmission", (t) => {
    const { workspace, store, receipt, root, file } = fixture(t);
    store.set(receipt);
    const original = fs.readFileSync(file, "utf8");
    const rename = t.mock.method(fs, "renameSync", () => { throw new Error("rename failed"); });
    assert.throws(() => store.set({ ...receipt, status: "completed", result: "saved once" }), /rename failed/);
    rename.mock.restore();
    assert.equal(fs.readFileSync(file, "utf8"), original);
    assert.equal(store.get(receipt.requestId)?.status, "pending");
    assert.deepEqual(fs.readdirSync(root), [`${receipt.requestId}.json`]);
    const restored = new ToolReceiptStore(workspace);
    restored.set({ ...receipt, status: "completed", result: "saved once" });
    assert.equal(new ToolReceiptStore(workspace).get(receipt.requestId)?.result, "saved once");
});

test("a crash-left temporary result is not treated as an acknowledged receipt", (t) => {
    const { workspace, store, receipt, file } = fixture(t);
    store.set(receipt);
    fs.writeFileSync(`${file}.abandoned.tmp`, JSON.stringify({ ...receipt, version: 1, status: "completed", result: "uncommitted" }));
    const restored = new ToolReceiptStore(workspace);
    assert.equal(restored.get(receipt.requestId)?.status, "unknown");
    assert.equal(restored.get(receipt.requestId)?.result, undefined);
    restored.set({ ...receipt, status: "completed", result: "original browser result" });
    assert.equal(new ToolReceiptStore(workspace).get(receipt.requestId)?.result, "original browser result");
});

test("an existing receipt corrupted or removed while running is never overwritten", (t) => {
    const { store, receipt, file } = fixture(t);
    store.set(receipt);
    fs.writeFileSync(file, "{broken");
    assert.throws(() => store.set({ ...receipt, status: "completed", result: "saved" }), /工具回执/);
    assert.equal(fs.readFileSync(file, "utf8"), "{broken");
    fs.rmSync(file);
    assert.throws(() => store.set({ ...receipt, status: "completed", result: "saved" }), /丢失/);
    assert.equal(fs.existsSync(file), false);
    assert.equal(store.get(receipt.requestId)?.status, "pending");
});

test("receipt filenames and ownership cannot substitute another request", (t) => {
    const { workspace, store, receipt, root, file } = fixture(t);
    store.set(receipt);
    assert.throws(() => store.set({ ...receipt, clientId: "other-client" }), /归属冲突/);
    fs.renameSync(file, path.join(root, `${crypto.randomUUID()}.json`));
    assert.throws(() => new ToolReceiptStore(workspace), /文件名与请求不匹配/);
});

test("a structurally valid but contradictory receipt fails closed on restart", (t) => {
    const { workspace, store, receipt, file } = fixture(t);
    store.set(receipt);
    for (const patch of [{ status: "failed" }, { status: "unknown", result: "unverified" }, { status: "completed", error: "failed" }]) {
        const content = JSON.stringify({ ...receipt, ...patch, version: 1 });
        fs.writeFileSync(file, content);
        assert.throws(() => new ToolReceiptStore(workspace), /工具回执/);
        assert.equal(fs.readFileSync(file, "utf8"), content);
    }
});
