import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";

import { createFrameTask } from "../src/lib/canvas/frame-task";
import { getCanvasConnectionIndex, getCanvasNodeIndex } from "../src/lib/canvas/canvas-graph-index";
import { findContainingGroupId, findGroupDropTarget, nodeBounds } from "../src/lib/canvas/canvas-node-geometry";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
const { getGenerationResourceNodes, getMentionResourceNodes, reuseCanvasResourceNodes } = await import("../src/lib/canvas/canvas-resource-references");
const { getNodeDefinition, registerNodeDefinitions, unregisterPluginNodes } = await import("../src/lib/canvas/node-registry");
afterAll(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

const originalRequest = globalThis.requestAnimationFrame;
const originalCancel = globalThis.cancelAnimationFrame;
let frames: Map<number, FrameRequestCallback>;
let frameId: number;

beforeEach(() => {
    frames = new Map();
    frameId = 0;
    globalThis.requestAnimationFrame = (callback) => { const id = frameId++; frames.set(id, callback); return id; };
    globalThis.cancelAnimationFrame = (id) => { frames.delete(id); };
});
afterEach(() => {
    globalThis.requestAnimationFrame = originalRequest;
    globalThis.cancelAnimationFrame = originalCancel;
});

function nextFrame() {
    const scheduled = [...frames.values()];
    frames.clear();
    scheduled.forEach((callback) => callback(0));
}

test("a burst of pointer updates publishes only the final value in the frame", () => {
    const values: number[] = [];
    const task = createFrameTask<number>((value) => values.push(value));
    for (let value = 0; value < 1000; value++) task.schedule(value);
    expect(frames.size).toBe(1);
    expect(values).toEqual([]);
    nextFrame();
    expect(values).toEqual([999]);
    task.schedule(1000);
    nextFrame();
    expect(values).toEqual([999, 1000]);
});

test("ending a gesture flushes the last position exactly once, including frame ID zero", () => {
    const values: number[] = [];
    const task = createFrameTask<number>((value) => values.push(value));
    task.schedule(12);
    task.schedule(24);
    task.flush();
    task.flush();
    nextFrame();
    expect(values).toEqual([24]);
    expect(frames.size).toBe(0);
});

test("cancelled or unmounted gestures cannot update the next canvas", () => {
    const values: number[] = [];
    const task = createFrameTask<number>((value) => values.push(value));
    task.schedule(1);
    task.cancel();
    nextFrame();
    task.flush();
    expect(values).toEqual([]);
    task.schedule(2);
    nextFrame();
    expect(values).toEqual([2]);
});

test("work scheduled while flushing belongs to the following frame", () => {
    const values: number[] = [];
    const task = createFrameTask<number>((value) => { values.push(value); if (value === 1) task.schedule(2); });
    task.schedule(1);
    nextFrame();
    expect(values).toEqual([1]);
    nextFrame();
    expect(values).toEqual([1, 2]);
});

function node(id: string, type = CanvasNodeType.Text, groupId?: string): CanvasNodeData {
    return { id, type, title: id, position: { x: 0, y: 0 }, width: 240, height: 180, metadata: { content: type === CanvasNodeType.Text ? id : undefined, groupId } };
}

test("node indexes reuse a snapshot and follow movement, regrouping, deletion and undo", () => {
    const a = node("a", CanvasNodeType.Text, "group");
    const b = node("b", CanvasNodeType.Text, "group");
    const nodes = [a, b];
    const index = getCanvasNodeIndex(nodes);
    expect(getCanvasNodeIndex(nodes)).toBe(index);
    expect(index.byGroup.get("group")).toEqual([a, b]);
    const moved = { ...a, position: { x: 90, y: 20 }, metadata: { ...a.metadata, groupId: "other" } };
    const next = getCanvasNodeIndex([moved]);
    expect(next.byId.get("a")).toBe(moved);
    expect(next.byId.has("b")).toBe(false);
    expect(next.byGroup.has("group")).toBe(false);
    expect(next.byGroup.get("other")).toEqual([moved]);
    expect(getCanvasNodeIndex(nodes).byId.get("a")).toBe(a);
});

test("connection indexes retain source order and never mutate previous snapshots", () => {
    const connections = [{ id: "b", fromNodeId: "b", toNodeId: "config" }, { id: "a", fromNodeId: "a", toNodeId: "config" }];
    const index = getCanvasConnectionIndex(connections);
    expect(getCanvasConnectionIndex(connections)).toBe(index);
    expect(index.incoming.get("config")).toEqual(connections);
    expect(index.outgoing.get("a")).toEqual([connections[1]]);
    expect(getCanvasConnectionIndex(connections.slice(1)).outgoing.has("b")).toBe(false);
    expect(index.outgoing.has("b")).toBe(true);
});

test("resource snapshots reuse builtin movement and resize but invalidate content, membership and ordering", () => {
    const a = node("a");
    const b = node("b");
    const nodes = [a, b];
    const moved = { ...a, position: { x: 100, y: 80 }, width: 420, height: 300 };
    expect(reuseCanvasResourceNodes(nodes, [moved, b])).toBe(nodes);
    for (const changed of [
        { ...moved, title: "renamed" },
        { ...moved, metadata: { ...a.metadata, content: "updated" } },
        { ...moved, metadata: { ...a.metadata, groupId: "group" } },
        { ...moved, type: CanvasNodeType.Image },
    ]) {
        const next = [changed, b];
        expect(reuseCanvasResourceNodes(nodes, next)).toBe(next);
    }
    const reordered = [b, a];
    expect(reuseCanvasResourceNodes(nodes, reordered)).toBe(reordered);
    const removed = [b];
    expect(reuseCanvasResourceNodes(nodes, removed)).toBe(removed);
    const plugin = { ...a, type: "performance:resource" };
    const movedPlugin = [{ ...plugin, position: { x: 10, y: 20 } }];
    expect(reuseCanvasResourceNodes([plugin], movedPlugin)).toBe(movedPlugin);
});

test("group indexes preserve topmost hit ordering and previous snapshots", () => {
    const a = node("a");
    const back = { ...node("back", CanvasNodeType.Group), width: 600, height: 400 };
    const front = { ...back, id: "front" };
    const nodes = [back, a, front];
    expect(getCanvasNodeIndex(nodes).groups).toEqual([back, front]);
    expect(findGroupDropTarget(new Set([a.id]), nodes)).toBe(front);
    expect(findContainingGroupId(a, nodes)).toBe(front.id);
    expect(findGroupDropTarget(new Set([a.id, back.id]), nodes)).toBeNull();
    expect(findGroupDropTarget(new Set(["deleted"]), nodes)).toBeNull();
    expect(findGroupDropTarget(new Set([a.id]), [a])).toBeNull();
    const far = { ...front, position: { x: 1000, y: 1000 } };
    expect(findGroupDropTarget(new Set([a.id]), [back, a, far])).toBe(back);
    expect(getCanvasNodeIndex(nodes).groups).toEqual([back, front]);
});

test("plugin overrides of builtin resources always receive current geometry", () => {
    const a = node("a");
    const previous = getNodeDefinition(CanvasNodeType.Text);
    registerNodeDefinitions([{ type: CanvasNodeType.Text, title: "Geometry resource", icon: null, defaultSize: { width: 240, height: 180 }, resource: (node) => ({ kind: "text", text: String(node.position.x) }) }], "performance-override");
    try {
        const moved = [{ ...a, position: { x: 80, y: 0 } }];
        expect(reuseCanvasResourceNodes([a], moved)).toBe(moved);
    } finally {
        unregisterPluginNodes("performance-override");
        if (previous) registerNodeDefinitions([previous]);
    }
});

test("node bounds handle empty sets and negative coordinates without changing nodes", () => {
    const a = { ...node("a"), position: { x: -300, y: -250 } };
    const b = { ...node("b"), position: { x: 30, y: 20 } };
    expect(nodeBounds([a, b])).toEqual({ left: -300, top: -250, right: 270, bottom: 200 });
    expect(nodeBounds([])).toEqual({ left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
    expect(a.position).toEqual({ x: -300, y: -250 });
});

test("indexed references preserve config priority, group expansion, deduplication and fallback", () => {
    const source = node("source");
    const sibling = node("sibling");
    const own = node("own");
    const child = node("child", CanvasNodeType.Text, "group");
    const group = node("group", CanvasNodeType.Group);
    const config = node("config", CanvasNodeType.Config);
    const nodes = [source, sibling, own, group, child, config];
    const connections = [
        { id: "own", fromNodeId: "own", toNodeId: "source" },
        { id: "config", fromNodeId: "source", toNodeId: "config" },
        { id: "sibling", fromNodeId: "sibling", toNodeId: "config" },
        { id: "group", fromNodeId: "group", toNodeId: "config" },
        { id: "child", fromNodeId: "child", toNodeId: "config" },
        { id: "missing", fromNodeId: "deleted", toNodeId: "config" },
    ];
    expect(getMentionResourceNodes("source", nodes, connections).map((item) => item.id)).toEqual(["sibling", "child"]);
    expect(getGenerationResourceNodes("source", nodes, connections).map((item) => item.id)).toEqual(["sibling", "group", "child"]);
    expect(getMentionResourceNodes("source", nodes, connections.slice(0, 1))).toEqual([own]);
    expect(getMentionResourceNodes("source", nodes, [])).toEqual([source]);
    expect(getGenerationResourceNodes("source", nodes, [])).toEqual([]);
    expect(getMentionResourceNodes("missing", nodes, [])).toEqual([]);
});
