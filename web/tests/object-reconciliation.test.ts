import { expect, test } from "bun:test";
import { listWorkspaceMediaObjects } from "../src/server/object-storage";

test("object reconciliation walks every page under the exact workspace prefix", async () => {
    const tokens: Array<string | undefined> = [];
    const objects = await listWorkspaceMediaObjects("workspace", async (input) => {
        expect(input.Prefix).toBe("media/workspace/");
        tokens.push(input.ContinuationToken);
        return { $metadata: {}, IsTruncated: !input.ContinuationToken, ...(!input.ContinuationToken ? { NextContinuationToken: "next" } : {}), Contents: [{ Key: `media/workspace/${input.ContinuationToken || "first"}`, Size: 3, ETag: '"tag"' }] };
    });
    expect(tokens).toEqual([undefined, "next"]);
    expect(objects).toHaveLength(2);
});

test("incomplete, repeating or cross-workspace listing never becomes a successful partial inventory", async () => {
    await expect(listWorkspaceMediaObjects("one", async () => ({ $metadata: {}, IsTruncated: true }))).rejects.toThrow();
    await expect(listWorkspaceMediaObjects("one", async () => ({ $metadata: {}, IsTruncated: true, NextContinuationToken: "loop" }))).rejects.toThrow();
    await expect(listWorkspaceMediaObjects("one", async () => ({ $metadata: {}, Contents: [{ Key: "media/another/key", Size: 1 }] }))).rejects.toThrow();
    await expect(listWorkspaceMediaObjects("one", async () => ({ $metadata: {}, Contents: [{ Key: "media/one/key" }] }))).rejects.toThrow();
});
