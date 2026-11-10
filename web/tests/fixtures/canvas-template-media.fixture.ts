import { expect, mock, test } from "bun:test";

Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null } });
mock.module("../../src/lib/workspace", () => ({ getActiveWorkspace: () => ({ id: "workspace-a" }) }));
const copiedSources: string[] = [];
mock.module("../../src/services/api/canvas-template-media", () => ({
    copyCanvasTemplateMedia: async (key: string) => {
        copiedSources.push(key);
        if (key === "image:failed") throw new Error("复制失败");
        await new Promise((resolve) => setTimeout(resolve, 10));
        return "image:new-copy";
    },
    readCanvasTemplateMedia: async () => { throw new Error("unexpected read"); },
}));
mock.module("../../src/services/workspace-media", () => ({ saveMediaBlob: async () => { throw new Error("unexpected upload"); } }));

const { copyCanvasTemplateContent } = await import("../../src/services/canvas-templates");

test("a failed copy waits for other started copies and reports only newly created keys", async () => {
    const content = {
        nodes: [
            { id: "a", type: "image", title: "A", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { storageKey: "image:failed", content: "image:failed" } },
            { id: "b", type: "image", title: "B", position: { x: 110, y: 0 }, width: 100, height: 100, metadata: { storageKey: "image:existing", content: "image:existing" } },
        ], connections: [], backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 },
    };
    const keys = new Set<string>();
    let error: Error & { createdMediaKeys?: string[] } | undefined;
    try { await copyCanvasTemplateContent(content as any, "workspace-a", keys); }
    catch (reason) { error = reason as typeof error; }
    expect(error?.message).toContain("复制失败");
    expect(error?.message).toContain("本次已复制媒体（未确认业务提交，请核对）：image:new-copy");
    expect(error?.createdMediaKeys).toEqual(["image:new-copy"]);
    expect(keys.has("image:existing")).toBe(false);
});

test("exact media key in text content and nested texts is copied once; prose is unchanged", async () => {
    copiedSources.length = 0;
    const original = {
        nodes: [
            { id: "a", type: "text", title: "A", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: "image:source", prompt: "Use image:source in the prompt", texts: [{ id: "t1", content: "image:source" }, { id: "t2", content: "image:source in prose" }] } },
            { id: "b", type: "text", title: "B", position: { x: 110, y: 0 }, width: 100, height: 100, metadata: { content: "An image:source reference is ordinary prose", references: ["image:source"] } },
        ], connections: [], backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 },
    };
    const copied = await copyCanvasTemplateContent(original as any, "workspace-a");
    expect(copiedSources).toEqual(["image:source"]);
    expect(copied.nodes[0].metadata?.content).toBe("image:new-copy");
    expect(copied.nodes[0].metadata?.texts?.map((text) => text.content)).toEqual(["image:new-copy", "image:source in prose"]);
    expect(copied.nodes[0].metadata?.prompt).toBe("Use image:source in the prompt");
    expect(copied.nodes[1].metadata?.content).toBe("An image:source reference is ordinary prose");
    expect(copied.nodes[1].metadata?.references).toEqual(["image:new-copy"]);
    expect(original.nodes[0].metadata.content).toBe("image:source");
});
