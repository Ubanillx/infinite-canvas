import { expect, test } from "bun:test";

import { autoLayoutCanvas } from "../src/lib/canvas/canvas-auto-layout";
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
