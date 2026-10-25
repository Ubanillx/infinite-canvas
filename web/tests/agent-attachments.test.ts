import { expect, test } from "bun:test";
import { parseAgentAttachmentManifest, type AgentAttachmentManifest } from "../src/lib/agent/agent-attachment-contract";
import { updateAgentAttachments } from "../src/server/agent-attachments";

const attachment = { id: "file", name: "File", storageKey: "image:agent", type: "image/png", size: 2, width: 1, height: 1, purpose: "attachment" };
const manifest = (): AgentAttachmentManifest => ({ version: 1, sessions: [] });
const reserve = { engine: "codex", threadId: "", clientMessageId: "message", attachments: [attachment] };

test("pending originals bind once to a thread, turn and item without retaining runtime URLs", () => {
    const pending = updateAgentAttachments(manifest(), "POST", reserve);
    const bound = updateAgentAttachments(pending, "PATCH", { ...reserve, threadId: "thread", turnId: "turn", itemId: "item" });
    expect(bound.sessions).toHaveLength(1);
    expect(bound.sessions[0].threadId).toBe("thread");
    expect(bound.sessions[0].messages[0].attachments[0].storageKey).toBe("image:agent");
    const roundtrip = parseAgentAttachmentManifest(JSON.parse(JSON.stringify(bound)));
    expect(roundtrip).toEqual(bound);
    for (const patch of [{ threadId: "other" }, { turnId: "other" }, { itemId: "other" }]) {
        expect(() => updateAgentAttachments(structuredClone(bound), "PATCH", { ...reserve, threadId: "thread", turnId: "turn", itemId: "item", ...patch })).toThrow();
    }
});

test("engine identities stay separate and deleting a thread releases only its inventory", () => {
    let value = updateAgentAttachments(manifest(), "POST", { ...reserve, threadId: "thread" });
    value = updateAgentAttachments(value, "POST", { ...reserve, engine: "pi", threadId: "thread" });
    expect(value.sessions).toHaveLength(2);
    value = updateAgentAttachments(value, "DELETE", { ...reserve, threadId: "thread" });
    expect(value.sessions).toHaveLength(1);
    expect(value.sessions[0].engine).toBe("pi");
});

test("unknown formats, duplicate messages and extra credential fields fail closed", () => {
    const value = updateAgentAttachments(manifest(), "POST", reserve);
    expect(() => updateAgentAttachments(structuredClone(value), "POST", reserve)).toThrow();
    expect(() => parseAgentAttachmentManifest({ ...value, version: 2 })).toThrow();
    expect(() => parseAgentAttachmentManifest({ ...value, apiKey: "not-stored" })).toThrow();
    expect(() => parseAgentAttachmentManifest({ ...value, sessions: [...value.sessions, value.sessions[0]] })).toThrow();
    const duplicate = structuredClone(value);
    duplicate.sessions[0].messages.push(duplicate.sessions[0].messages[0]);
    expect(() => parseAgentAttachmentManifest(duplicate)).toThrow();
});
