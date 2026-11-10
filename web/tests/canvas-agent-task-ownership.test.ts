import { afterAll, expect, test } from "bun:test";
import type { CanvasAgentSnapshot } from "../src/lib/canvas/canvas-agent-ops";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {} } });
const { applyCanvasAgentOps } = await import("../src/lib/canvas/canvas-agent-ops");
afterAll(() => { if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage); else Reflect.deleteProperty(globalThis, "localStorage"); });

const binding = { requestId: "request", workspaceId: "workspace", projectId: "project", nodeId: "node", kind: "text" as const, slotIds: ["a", "b"] };
const snapshot: CanvasAgentSnapshot = { projectId: "project", title: "test", nodes: [{ id: "node", type: "text", title: "user title", position: { x: 0, y: 0 }, width: 240, height: 180, metadata: { content: "streamed", generationTask: binding, primaryTextId: "a" } }], connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 } };

test("MCP content, media and node identity replacements detach the paid task binding", () => {
    for (const metadata of [{ content: "user edit" }, { storageKey: "audio:replacement" }, { texts: [] }, { images: [] }]) {
        const result = applyCanvasAgentOps(snapshot, [{ type: "update_node", id: "node", metadata }]);
        expect(result.nodes[0].metadata!.generationTask).toBeUndefined();
    }
    for (const patch of [{ metadata: { content: "patch edit" } }, { type: "audio" }, { id: "replacement-node" }]) {
        expect(applyCanvasAgentOps(snapshot, [{ type: "update_node", id: "node", patch }]).nodes[0].metadata!.generationTask).toBeUndefined();
    }
    const replacement = applyCanvasAgentOps(snapshot, [{ type: "update_node", id: "node", metadata: { content: "user edit", generationTask: { ...binding, requestId: "new-user-intent" } } }]);
    expect(replacement.nodes[0].metadata).toMatchObject({ content: "user edit" });
    expect(replacement.nodes[0].metadata!.generationTask).toBeUndefined();
    expect(snapshot.nodes[0].metadata!.generationTask).toBe(binding);
});

test("MCP layout and primary selection keep recovery while a copied node cannot inherit a task", () => {
    const selected = applyCanvasAgentOps(snapshot, [{ type: "update_node", id: "node", patch: { title: "edited title", position: { x: 50, y: 60 } }, metadata: { primaryTextId: "b" } }]);
    expect(selected.nodes[0].metadata!.generationTask).toEqual(binding);
    expect(selected.nodes[0].metadata!.primaryTextId).toBe("b");
    const copied = applyCanvasAgentOps(snapshot, [{ type: "add_node", id: "copied", nodeType: "text", metadata: snapshot.nodes[0].metadata }]);
    expect(copied.nodes[1].metadata!.generationTask).toBeUndefined();
});
