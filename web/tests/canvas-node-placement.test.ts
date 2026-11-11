import { expect, test } from "bun:test";
import { avoidCanvasNodeOverlap, expandCanvasGroups, placeCanvasNodes } from "../src/lib/canvas/canvas-node-placement";
import type { CanvasNodeData } from "../src/types/canvas";

function node(id: string, x: number, y: number, width = 100, height = 100): CanvasNodeData {
    return { id, type: "text", title: id, position: { x, y }, width, height };
}

function intersect(a: CanvasNodeData, b: CanvasNodeData) {
    return a.position.x < b.position.x + b.width && a.position.x + a.width > b.position.x
        && a.position.y < b.position.y + b.height && a.position.y + a.height > b.position.y;
}

test("a batch avoids itself and existing nodes without moving the existing nodes", () => {
    const old = node("old", 0, 0);
    const incoming = [node("one", 0, 0), node("two", 0, 0)];
    const placed = placeCanvasNodes([old], incoming);
    expect(placed.map((item) => item.id)).toEqual(["one", "two"]);
    expect(placed.every((item) => !intersect(item, old))).toBe(true);
    expect(intersect(placed[0], placed[1])).toBe(false);
    expect(old.position).toEqual({ x: 0, y: 0 });
});

test("a resized node moves around a neighbor while keeping the neighbor fixed", () => {
    const old = node("old", 0, 0);
    const expanded = node("expanded", 120, 0, 160);
    const result = avoidCanvasNodeOverlap([old, expanded], new Set(["expanded"]));
    expect(result[0]).toBe(old);
    expect(intersect(result[0], result[1])).toBe(false);
    expect(result[1].width).toBe(160);
});

test("placement uses nearby horizontal space when vertical clearance is farther", () => {
    const placed = placeCanvasNodes([node("old", 0, 0, 100, 500)], [node("new", 80, 0)])[0];
    expect(placed.position).toEqual({ x: 148, y: 0 });
});

test("group containers can contain their members while members avoid each other", () => {
    const group: CanvasNodeData = { ...node("group", -24, -52, 240, 176), type: "group" };
    const first = { ...node("first", 0, 0), metadata: { groupId: "group" } };
    const second = { ...node("second", 0, 0), metadata: { groupId: "group" } };
    const placed = placeCanvasNodes([], [group, first, second]);
    expect(intersect(placed[1], placed[2])).toBe(false);
    expect(placed[1].metadata?.groupId).toBe("group");
    expect(placed[2].metadata?.groupId).toBe("group");
    expect(placed[0].height).toBeGreaterThan(group.height);
});

test("a new member stays inside its existing group and expands the container", () => {
    const group: CanvasNodeData = { ...node("group", -24, -52, 148, 176), type: "group" };
    const child = { ...node("child", 0, 0, 180), metadata: { groupId: "group" } };
    const placed = placeCanvasNodes([group], [child]);
    const [expanded] = expandCanvasGroups([group, ...placed]);
    expect(placed[0].position).toEqual(child.position);
    expect(expanded.width).toBeGreaterThan(group.width);
});

test("two incoming groups move as whole units without splitting their members", () => {
    const firstGroup: CanvasNodeData = { ...node("group-1", -24, -52, 148, 176), type: "group" };
    const secondGroup: CanvasNodeData = { ...node("group-2", -24, -52, 148, 176), type: "group" };
    const first = { ...node("first", 0, 0), metadata: { groupId: firstGroup.id } };
    const second = { ...node("second", 0, 0), metadata: { groupId: secondGroup.id } };
    const [a, aChild, b, bChild] = placeCanvasNodes([], [firstGroup, first, secondGroup, second]);
    expect(intersect(a, b)).toBe(false);
    expect(aChild.position.x - a.position.x).toBe(bChild.position.x - b.position.x);
    expect(aChild.position.y - a.position.y).toBe(bChild.position.y - b.position.y);
});
