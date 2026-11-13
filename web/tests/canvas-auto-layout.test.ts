import { expect, test } from "bun:test";

import { autoLayoutCanvas, autoLayoutCanvasChanges } from "../src/lib/canvas/canvas-auto-layout";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../src/types/canvas";

function node(id: string, x: number, y: number, type: CanvasNodeType = CanvasNodeType.Text, groupId?: string): CanvasNodeData {
    return { id, type, title: id, position: { x, y }, width: 120, height: 80, metadata: groupId ? { groupId } : undefined };
}

function overlaps(a: CanvasNodeData, b: CanvasNodeData) {
    return a.position.x < b.position.x + b.width && a.position.x + a.width > b.position.x && a.position.y < b.position.y + b.height && a.position.y + a.height > b.position.y;
}

test("lays out connected nodes left to right without overlaps and preserves dimensions", () => {
    const nodes = [node("a", 0, 0), node("b", 10, 10), node("c", 20, 20), node("d", 30, 30)];
    const edges: CanvasConnection[] = [{ id: "ab", fromNodeId: "a", toNodeId: "b" }, { id: "bc", fromNodeId: "b", toNodeId: "c" }, { id: "cd", fromNodeId: "c", toNodeId: "d" }];
    const result = autoLayoutCanvas(nodes, edges);
    for (let i = 1; i < result.length; i += 1) {
        expect(result[i].position.x).toBeGreaterThan(result[i - 1].position.x + result[i - 1].width);
        expect(result[i].width).toBe(nodes[i].width);
        expect(result[i].height).toBe(nodes[i].height);
    }
    expect(nodes[1].position).toEqual({ x: 10, y: 10 });
});

test("packs independent chains in rows instead of one long strip", () => {
    const nodes = Array.from({ length: 9 }, (_, i) => node(String(i), 0, 0));
    const result = autoLayoutCanvas(nodes, []);
    expect(new Set(result.map((item) => item.position.y)).size).toBeGreaterThan(1);
    for (let i = 0; i < result.length; i += 1) for (let j = i + 1; j < result.length; j += 1) expect(overlaps(result[i], result[j])).toBe(false);
});

test("selection moves a whole group, rewraps members, and avoids fixed nodes", () => {
    const nodes = [
        { ...node("group", 0, 0, CanvasNodeType.Group), width: 160, height: 140 },
        node("a", 24, 52, CanvasNodeType.Text, "group"),
        node("b", 24, 52, CanvasNodeType.Text, "group"),
        node("fixed", 200, 0),
    ];
    const result = autoLayoutCanvas(nodes, [], ["a"]);
    const [group, a, b, fixed] = result;
    expect(fixed).toBe(nodes[3]);
    expect(a.metadata?.groupId).toBe("group");
    expect(b.metadata?.groupId).toBe("group");
    expect(overlaps(a, b)).toBe(false);
    expect(overlaps(group, fixed)).toBe(false);
    expect(group.position.x).toBeLessThanOrEqual(Math.min(a.position.x, b.position.x));
    expect(group.position.y).toBeLessThanOrEqual(Math.min(a.position.y, b.position.y));
});

test("selected chain clears staggered fixed obstacles and ignores stale connections", () => {
    const nodes = [node("a", 0, 0), node("b", 0, 0), node("left", 130, 0), node("right", 300, 60), node("lower", 440, 130)];
    const edges: CanvasConnection[] = [{ id: "ab", fromNodeId: "a", toNodeId: "b" }, { id: "stale", fromNodeId: "removed", toNodeId: "a" }];
    const result = autoLayoutCanvas(nodes, edges, ["a", "b"]);
    for (const moving of result.slice(0, 2)) for (const fixed of result.slice(2)) expect(overlaps(moving, fixed)).toBe(false);
    expect(result.slice(2)).toEqual(nodes.slice(2));
});

test("repeated layout is stable with groups, cycles, independent chains, and a selected member", () => {
    const nodes = [
        { ...node("group", 0, 0, CanvasNodeType.Group), width: 260, height: 200 },
        node("a", 24, 52, CanvasNodeType.Text, "group"), node("b", 30, 55, CanvasNodeType.Text, "group"),
        node("c", 300, 0), node("d", 320, 20), node("fixed", 800, 0),
    ];
    const edges: CanvasConnection[] = [
        { id: "ab", fromNodeId: "a", toNodeId: "b" }, { id: "bc", fromNodeId: "b", toNodeId: "c" },
        { id: "cd", fromNodeId: "c", toNodeId: "d" }, { id: "dc", fromNodeId: "d", toNodeId: "c" },
    ];
    const once = autoLayoutCanvas(nodes, edges, ["a", "c", "d"]);
    const twice = autoLayoutCanvas(once, edges, ["a", "c", "d"]);
    expect(twice.map((item) => ({ position: item.position, width: item.width, height: item.height })))
        .toEqual(once.map((item) => ({ position: item.position, width: item.width, height: item.height })));
    expect(once[5]).toBe(nodes[5]);
    expect(once[1].metadata?.groupId).toBe("group");
    expect(once[2].metadata?.groupId).toBe("group");
    expect(overlaps(once[1], once[2])).toBe(false);
    expect(overlaps(once[0], once[5])).toBe(false);
});

test("packs a 109-node collection of short connected chains without changing size", () => {
    const lengths = [3, 4, 5, 6, 7, 3, 4, 5, 6, 7, 3, 4, 5, 6, 7, 3, 4, 5, 6, 7, 4, 5];
    const nodes: CanvasNodeData[] = [];
    const edges: CanvasConnection[] = [];
    for (const [chain, length] of lengths.entries()) for (let i = 0; i < length; i += 1) {
        const id = `${chain}-${i}`;
        nodes.push({ ...node(id, i * 30, chain * 40), width: i % 2 ? 320 : 240, height: i % 3 ? 180 : 240 });
        if (i) edges.push({ id, fromNodeId: `${chain}-${i - 1}`, toNodeId: id });
    }
    expect(nodes).toHaveLength(109);
    const result = autoLayoutCanvas(nodes, edges);
    const left = Math.min(...result.map((item) => item.position.x));
    const top = Math.min(...result.map((item) => item.position.y));
    const width = Math.max(...result.map((item) => item.position.x + item.width)) - left;
    const height = Math.max(...result.map((item) => item.position.y + item.height)) - top;
    expect(width / height).toBeGreaterThan(0.7);
    expect(width / height).toBeLessThan(3);
    for (let i = 0; i < result.length; i += 1) {
        expect(result[i].width).toBe(nodes[i].width);
        expect(result[i].height).toBe(nodes[i].height);
        for (let j = i + 1; j < result.length; j += 1) expect(overlaps(result[i], result[j])).toBe(false);
    }
    expect(autoLayoutCanvas(result, edges).map((item) => item.position)).toEqual(result.map((item) => item.position));
});

test("an Agent turn arranges only its new chain after a fixed source", () => {
    const nodes = [node("source", 0, 0), node("unrelated", 800, 0), node("config", 0, 0), node("result", 0, 0)];
    const edges: CanvasConnection[] = [
        { id: "sc", fromNodeId: "source", toNodeId: "config" },
        { id: "cr", fromNodeId: "config", toNodeId: "result" },
    ];
    const placed = autoLayoutCanvasChanges(nodes, edges, ["config", "result"]);
    expect(placed[0]).toBe(nodes[0]);
    expect(placed[1]).toBe(nodes[1]);
    expect(placed[2].position.x).toBeGreaterThan(nodes[0].position.x + nodes[0].width);
    expect(placed[3].position.x).toBeGreaterThan(placed[2].position.x + placed[2].width);
    for (const moving of placed.slice(2)) for (const fixed of placed.slice(0, 2)) expect(overlaps(moving, fixed)).toBe(false);
    expect(autoLayoutCanvasChanges(placed, edges, ["config", "result"]).map((item) => item.position)).toEqual(placed.map((item) => item.position));
});

test("explicitly positioned nodes keep their coordinates while other changes still lay out", () => {
    const nodes = [node("source", 0, 0), node("moved", 1200, -80), node("extra", 0, 0)];
    const edges: CanvasConnection[] = [{ id: "sm", fromNodeId: "source", toNodeId: "moved" }, { id: "me", fromNodeId: "moved", toNodeId: "extra" }];
    const placed = autoLayoutCanvasChanges(nodes, edges, ["moved", "extra"], new Set(["moved"]));
    expect(placed[1]).toBe(nodes[1]);
    expect(placed[1].position).toEqual({ x: 1200, y: -80 });
    expect(placed[2].position.x).toBeGreaterThan(nodes[1].position.x + nodes[1].width);
});

test("a turn that only writes explicit positions leaves the layout untouched", () => {
    const nodes = [node("a", 2700, -180), node("b", 0, 0)];
    const edges: CanvasConnection[] = [{ id: "ab", fromNodeId: "a", toNodeId: "b" }];
    expect(autoLayoutCanvasChanges(nodes, edges, ["a", "b"], new Set(["a", "b"]))).toBe(nodes);
});

test("an explicitly positioned group container is not rewrapped around a moved member", () => {
    const group = { ...node("group", 2000, 1000, CanvasNodeType.Group), width: 300, height: 200 };
    const member = node("member", 1900, 900, CanvasNodeType.Text, "group");
    const placed = autoLayoutCanvasChanges([group, member], [], ["group", "member"], new Set(["group"]));
    expect(placed[0]).toBe(group);
});

test("new independent nodes pack around fixed content without moving it", () => {
    const nodes = [node("fixed", 0, 0), node("one", 0, 0), node("two", 0, 0), node("three", 0, 0)];
    const placed = autoLayoutCanvasChanges(nodes, [], ["one", "two", "three"]);
    expect(placed[0]).toBe(nodes[0]);
    for (let i = 0; i < placed.length; i += 1) for (let j = i + 1; j < placed.length; j += 1) expect(overlaps(placed[i], placed[j])).toBe(false);
    expect(Math.max(...placed.map((item) => item.position.x)) - Math.min(...placed.map((item) => item.position.x))).toBeLessThan(800);
});

test("changed group member avoids old siblings but does not move them", () => {
    const group = { ...node("group", -24, -52, CanvasNodeType.Group), width: 280, height: 190 };
    const old = node("old", 0, 0, CanvasNodeType.Text, "group");
    const changed = node("changed", 0, 0, CanvasNodeType.Image, "group");
    const external = node("external", 500, 0);
    const nodes = [group, old, changed, external];
    const placed = autoLayoutCanvasChanges(nodes, [{ id: "edge", fromNodeId: "old", toNodeId: "changed" }], ["changed"]);
    expect(placed[1]).toBe(old);
    expect(placed[3]).toBe(external);
    expect(placed[2].metadata?.groupId).toBe("group");
    expect(overlaps(placed[1], placed[2])).toBe(false);
    expect(placed[0].position.x + placed[0].width).toBeGreaterThanOrEqual(placed[2].position.x + placed[2].width);
    expect(placed[2].width).toBe(changed.width);
    expect(placed[2].height).toBe(changed.height);
});

test("new group and all its members move together, leaving fixed nodes untouched", () => {
    const fixed = node("fixed", 0, 0);
    const group = { ...node("group", -24, -52, CanvasNodeType.Group), width: 150, height: 150 };
    const a = node("a", 0, 0, CanvasNodeType.Text, "group");
    const b = node("b", 0, 0, CanvasNodeType.Text, "group");
    const placed = autoLayoutCanvasChanges([fixed, group, a, b], [{ id: "ab", fromNodeId: "a", toNodeId: "b" }], ["group", "a", "b"]);
    expect(placed[0]).toBe(fixed);
    expect(overlaps(placed[1], fixed)).toBe(false);
    expect(overlaps(placed[2], placed[3])).toBe(false);
    expect(placed[1].position.x).toBeLessThanOrEqual(Math.min(placed[2].position.x, placed[3].position.x));
    expect(placed[1].position.x + placed[1].width).toBeGreaterThanOrEqual(placed[3].position.x + placed[3].width);
});

test("an empty turn or group-only change does not trigger node movement", () => {
    const group = { ...node("group", -24, -52, CanvasNodeType.Group), width: 280, height: 190 };
    const member = node("member", 0, 0, CanvasNodeType.Text, "group");
    const nodes = [group, member];
    expect(autoLayoutCanvasChanges(nodes, [], [])).toBe(nodes);
    expect(autoLayoutCanvasChanges(nodes, [], ["group"])).toBe(nodes);
    expect(autoLayoutCanvasChanges(nodes, [], ["missing"])).toBe(nodes);
});

test("a chain across two old groups keeps changed members in their own containers", () => {
    const left = { ...node("left-group", -24, -52, CanvasNodeType.Group), width: 300, height: 190 };
    const right = { ...node("right-group", 476, -52, CanvasNodeType.Group), width: 300, height: 190 };
    const a = node("a", 0, 0, CanvasNodeType.Text, left.id);
    const b = node("b", 500, 0, CanvasNodeType.Image, right.id);
    const oldLeft = node("old-left", 0, 200);
    const oldRight = node("old-right", 500, 200);
    const nodes = [left, right, oldLeft, oldRight, a, b];
    const placed = autoLayoutCanvasChanges(nodes, [{ id: "ab", fromNodeId: "a", toNodeId: "b" }], ["a", "b"]);
    expect(placed.slice(0, 4)).toEqual(nodes.slice(0, 4));
    expect(placed[0]).toBe(left);
    expect(placed[1]).toBe(right);
    expect(placed[2]).toBe(oldLeft);
    expect(placed[3]).toBe(oldRight);
    expect(placed[4].position.x).toBeGreaterThanOrEqual(left.position.x);
    expect(placed[4].position.x + placed[4].width).toBeLessThanOrEqual(left.position.x + left.width);
    expect(placed[5].position.x).toBeGreaterThanOrEqual(right.position.x);
    expect(placed[5].position.x + placed[5].width).toBeLessThanOrEqual(right.position.x + right.width);
});

test("a new group stays atomic when its two members link through an outside node", () => {
    const group = { ...node("group", -24, -52, CanvasNodeType.Group), width: 200, height: 160 };
    const a = node("a", 0, 0, CanvasNodeType.Text, group.id);
    const b = node("b", 0, 0, CanvasNodeType.Text, group.id);
    const outside = node("outside", 0, 0);
    const edges: CanvasConnection[] = [
        { id: "ao", fromNodeId: "a", toNodeId: "outside" },
        { id: "ob", fromNodeId: "outside", toNodeId: "b" },
    ];
    const placed = autoLayoutCanvasChanges([group, a, b, outside], edges, ["group", "a", "b", "outside"]);
    expect(overlaps(placed[0], placed[3])).toBe(false);
    expect(overlaps(placed[1], placed[2])).toBe(false);
    expect(placed[1].position.x).toBeGreaterThanOrEqual(placed[0].position.x);
    expect(placed[2].position.x + placed[2].width).toBeLessThanOrEqual(placed[0].position.x + placed[0].width);
    expect(autoLayoutCanvasChanges(placed, edges, ["group", "a", "b", "outside"]).map((item) => item.position)).toEqual(placed.map((item) => item.position));
});

test("a large Agent batch leaves an existing collection untouched", () => {
    const fixed = Array.from({ length: 80 }, (_, index) => node(`fixed-${index}`, index % 10 * 240, Math.floor(index / 10) * 160));
    const incoming = Array.from({ length: 30 }, (_, index) => node(`new-${index}`, 0, 0));
    const edges = incoming.map((item, index) => ({ id: item.id, fromNodeId: index ? incoming[index - 1].id : fixed[0].id, toNodeId: item.id }));
    const placed = autoLayoutCanvasChanges([...fixed, ...incoming], edges, incoming.map((item) => item.id));
    for (let index = 0; index < fixed.length; index += 1) expect(placed[index]).toBe(fixed[index]);
    for (let index = 1; index < incoming.length; index += 1) {
        expect(placed[fixed.length + index].position.x).toBeGreaterThan(placed[fixed.length + index - 1].position.x);
    }
    for (const item of placed.slice(fixed.length)) for (const obstacle of fixed) expect(overlaps(item, obstacle)).toBe(false);
});
