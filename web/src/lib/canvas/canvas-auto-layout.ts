import { Graph, layout } from "@dagrejs/dagre";

import { getGroupWrapRect } from "@/lib/canvas/canvas-node-geometry";
import { expandCanvasGroups } from "@/lib/canvas/canvas-node-placement";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type Position } from "@/types/canvas";

const NODE_GAP = 56;
const RANK_GAP = 100;
const COMPONENT_GAP = 100;

type LayoutItem = { id: string; width: number; height: number; position: Position };
type Rect = { x: number; y: number; width: number; height: number };

function bounds(items: LayoutItem[]): Rect {
    const x = Math.min(...items.map((item) => item.position.x));
    const y = Math.min(...items.map((item) => item.position.y));
    return { x, y, width: Math.max(...items.map((item) => item.position.x + item.width)) - x, height: Math.max(...items.map((item) => item.position.y + item.height)) - y };
}

function layoutItems(items: LayoutItem[], connections: CanvasConnection[], origin: Position) {
    if (!items.length) return new Map<string, Position>();
    const byId = new Map(items.map((item) => [item.id, item]));
    const neighbors = new Map(items.map((item) => [item.id, new Set<string>()]));
    for (const edge of connections) {
        if (edge.fromNodeId === edge.toNodeId || !byId.has(edge.fromNodeId) || !byId.has(edge.toNodeId)) continue;
        neighbors.get(edge.fromNodeId)!.add(edge.toNodeId);
        neighbors.get(edge.toNodeId)!.add(edge.fromNodeId);
    }

    const components: { positions: Map<string, Position>; width: number; height: number; original: Position }[] = [];
    const seen = new Set<string>();
    for (const item of items) {
        if (seen.has(item.id)) continue;
        const queue = [item.id];
        const ids = new Set<string>();
        seen.add(item.id);
        for (let i = 0; i < queue.length; i += 1) {
            const id = queue[i];
            ids.add(id);
            for (const neighbor of neighbors.get(id)!) {
                if (seen.has(neighbor)) continue;
                seen.add(neighbor);
                queue.push(neighbor);
            }
        }
        const componentItems = items.filter((candidate) => ids.has(candidate.id));
        const graph = new Graph();
        graph.setGraph({ rankdir: "LR", nodesep: NODE_GAP, ranksep: RANK_GAP });
        graph.setDefaultEdgeLabel(() => ({}));
        for (const node of componentItems) graph.setNode(node.id, { width: node.width, height: node.height });
        for (const edge of connections) if (ids.has(edge.fromNodeId) && ids.has(edge.toNodeId) && edge.fromNodeId !== edge.toNodeId) graph.setEdge(edge.fromNodeId, edge.toNodeId);
        layout(graph);
        const local = componentItems.map((node) => ({ ...node, position: { x: graph.node(node.id).x - node.width / 2, y: graph.node(node.id).y - node.height / 2 } }));
        const rect = bounds(local);
        components.push({
            positions: new Map(local.map((node) => [node.id, { x: node.position.x - rect.x, y: node.position.y - rect.y }])),
            width: rect.width, height: rect.height, original: { x: Math.min(...componentItems.map((node) => node.position.x)), y: Math.min(...componentItems.map((node) => node.position.y)) },
        });
    }

    components.sort((a, b) => a.original.y - b.original.y || a.original.x - b.original.x);
    const totalArea = components.reduce((sum, component) => sum + (component.width + COMPONENT_GAP) * (component.height + COMPONENT_GAP), 0);
    const rowWidth = Math.max(...components.map((component) => component.width), Math.sqrt(totalArea) * 1.5);
    const result = new Map<string, Position>();
    let x = 0;
    let y = 0;
    let rowHeight = 0;
    for (const component of components) {
        if (x > 0 && x + component.width > rowWidth) {
            x = 0;
            y += rowHeight + COMPONENT_GAP;
            rowHeight = 0;
        }
        for (const [id, position] of component.positions) result.set(id, { x: origin.x + x + position.x, y: origin.y + y + position.y });
        x += component.width + COMPONENT_GAP;
        rowHeight = Math.max(rowHeight, component.height);
    }
    return result;
}

function intersects(a: Rect, b: Rect) {
    return a.x < b.x + b.width + NODE_GAP && a.x + a.width + NODE_GAP > b.x && a.y < b.y + b.height + NODE_GAP && a.y + a.height + NODE_GAP > b.y;
}

function clearPosition(moving: Rect, obstacles: Rect[]) {
    if (!obstacles.some((obstacle) => intersects(moving, obstacle))) return { x: 0, y: 0 };
    const candidates = [{ x: moving.x, y: moving.y }];
    for (const obstacle of obstacles) {
        candidates.push({ x: obstacle.x + obstacle.width + NODE_GAP, y: moving.y });
        candidates.push({ x: moving.x, y: obstacle.y + obstacle.height + NODE_GAP });
    }
    candidates.sort((a, b) => Math.abs(a.x - moving.x) + Math.abs(a.y - moving.y) - Math.abs(b.x - moving.x) - Math.abs(b.y - moving.y));
    const candidate = candidates.find((point) => !obstacles.some((obstacle) => intersects({ ...moving, ...point }, obstacle)))!;
    return { x: candidate.x - moving.x, y: candidate.y - moving.y };
}

export function autoLayoutCanvas(nodes: CanvasNodeData[], connections: CanvasConnection[], selectedIds?: string[]): CanvasNodeData[] {
    if (!nodes.length) return nodes;
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const groups = new Map(nodes.filter((node) => node.type === CanvasNodeType.Group).map((node) => [node.id, node]));
    const groupFor = (node: CanvasNodeData) => node.type !== CanvasNodeType.Group && groups.has(node.metadata?.groupId || "") ? node.metadata!.groupId! : node.id;
    const selected = selectedIds?.length ? new Set(selectedIds) : null;
    const moving = new Set(nodes.filter((node) => !selected || selected.has(node.id) || selected.has(groupFor(node))).map(groupFor));
    if (!moving.size) return nodes;

    const next = new Map(nodes.map((node) => [node.id, node]));
    const units: CanvasNodeData[] = [];
    for (const node of nodes) {
        if (node.type !== CanvasNodeType.Group && groupFor(node) !== node.id) continue;
        if (!moving.has(node.id)) continue;
        if (node.type !== CanvasNodeType.Group) {
            units.push(node);
            continue;
        }
        const members = nodes.filter((member) => member.type !== CanvasNodeType.Group && groupFor(member) === node.id);
        if (!members.length) {
            units.push(node);
            continue;
        }
        const inside = layoutItems(members, connections, { x: node.position.x + 24, y: node.position.y + 52 });
        const placed = members.map((member) => ({ ...member, position: inside.get(member.id)! }));
        for (const member of placed) next.set(member.id, member);
        const rect = getGroupWrapRect(placed);
        const group = { ...node, position: { x: rect.x, y: rect.y }, width: rect.width, height: rect.height };
        next.set(node.id, group);
        units.push(group);
    }
    if (!units.length) return nodes;
    const unitIds = new Set(units.map((unit) => unit.id));
    const edges = connections.flatMap((edge) => {
        const from = nodeById.get(edge.fromNodeId);
        const to = nodeById.get(edge.toNodeId);
        if (!from || !to) return [];
        const fromNodeId = groupFor(from);
        const toNodeId = groupFor(to);
        return unitIds.has(fromNodeId) && unitIds.has(toNodeId) && fromNodeId !== toNodeId ? [{ ...edge, fromNodeId, toNodeId }] : [];
    });
    const original = bounds(units);
    const positions = layoutItems(units, edges, { x: original.x, y: original.y });
    for (const unit of units) {
        const position = positions.get(unit.id)!;
        next.set(unit.id, { ...next.get(unit.id)!, position });
        if (unit.type !== CanvasNodeType.Group) continue;
        for (const member of nodes) {
            if (groupFor(member) !== unit.id || member.id === unit.id) continue;
            const placed = next.get(member.id)!;
            next.set(member.id, { ...placed, position: { x: placed.position.x + position.x - unit.position.x, y: placed.position.y + position.y - unit.position.y } });
        }
    }

    if (selected) {
        const movedUnits = units.map((unit) => next.get(unit.id)!);
        const movingBounds = bounds(movedUnits);
        const obstacles = nodes.filter((node) => !moving.has(groupFor(node))).map((node) => ({ ...node.position, width: node.width, height: node.height }));
        const shift = clearPosition(movingBounds, obstacles);
        if (shift.x || shift.y) for (const [id, node] of next) if (moving.has(groupFor(node))) next.set(id, { ...node, position: { x: node.position.x + shift.x, y: node.position.y + shift.y } });
    }
    return nodes.map((node) => next.get(node.id)!);
}

/** Arrange one Agent turn while keeping every unrelated node, pinned node and group member in place. */
export function autoLayoutCanvasChanges(nodes: CanvasNodeData[], connections: CanvasConnection[], changedIds: string[], pinnedIds?: ReadonlySet<string>): CanvasNodeData[] {
    const changed = new Set(pinnedIds ? changedIds.filter((id) => !pinnedIds.has(id)) : changedIds);
    if (!changed.size) return nodes;
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const moving = nodes.filter((node) => changed.has(node.id) && node.type !== CanvasNodeType.Group);
    if (!moving.length) return nodes;
    const movingIds = new Set(moving.map((node) => node.id));
    const groups = nodes.filter((node) => node.type === CanvasNodeType.Group);
    const wholeGroups = new Map(groups.filter((group) => changed.has(group.id) && nodes.some((node) => node.metadata?.groupId === group.id)
        && nodes.every((node) => node.metadata?.groupId !== group.id || movingIds.has(node.id))).map((group) => [group.id, group]));
    const neighbors = new Map(moving.map((node) => [node.id, new Set<string>()]));
    const fixedGroup = (node: CanvasNodeData) => node.metadata?.groupId && !wholeGroups.has(node.metadata.groupId) ? node.metadata.groupId : null;
    for (const edge of connections) {
        if (!movingIds.has(edge.fromNodeId) || !movingIds.has(edge.toNodeId)) continue;
        if (fixedGroup(byId.get(edge.fromNodeId)!) !== fixedGroup(byId.get(edge.toNodeId)!)) continue;
        neighbors.get(edge.fromNodeId)!.add(edge.toNodeId);
        neighbors.get(edge.toNodeId)!.add(edge.fromNodeId);
    }
    for (const group of wholeGroups.values()) {
        const members = moving.filter((node) => node.metadata?.groupId === group.id);
        for (const member of members.slice(1)) {
            neighbors.get(members[0].id)!.add(member.id);
            neighbors.get(member.id)!.add(members[0].id);
        }
    }

    const next = new Map(nodes.map((node) => [node.id, node]));
    const obstacles = nodes.filter((node) => !movingIds.has(node.id) && !wholeGroups.has(node.id));
    const visited = new Set<string>();
    const affectedGroups = new Set<string>();
    for (const node of moving) {
        if (visited.has(node.id)) continue;
        const queue = [node.id];
        const ids = new Set<string>(queue);
        visited.add(node.id);
        for (let index = 0; index < queue.length; index += 1) {
            for (const neighbor of neighbors.get(queue[index])!) {
                if (visited.has(neighbor)) continue;
                visited.add(neighbor);
                ids.add(neighbor);
                queue.push(neighbor);
            }
        }
        const component = moving.filter((item) => ids.has(item.id));
        const componentGroups = [...wholeGroups.values()].filter((group) => component.some((item) => item.metadata?.groupId === group.id));
        const internalEdges = connections.filter((edge) => ids.has(edge.fromNodeId) && ids.has(edge.toNodeId));
        const positions = componentGroups.length ? null : layoutItems(component, internalEdges, { x: 0, y: 0 });
        const laidOut = componentGroups.length ? autoLayoutCanvas([...component, ...componentGroups], internalEdges) : component.map((item) => ({ ...item, position: positions!.get(item.id)! }));
        const layoutRect = bounds(laidOut);
        const local = new Map(laidOut.map((item) => [item.id, { x: item.position.x - layoutRect.x, y: item.position.y - layoutRect.y }]));
        const incoming = connections.filter((edge) => ids.has(edge.toNodeId) && !movingIds.has(edge.fromNodeId) && byId.has(edge.fromNodeId));
        const outgoing = connections.filter((edge) => ids.has(edge.fromNodeId) && !movingIds.has(edge.toNodeId) && byId.has(edge.toNodeId));
        const original = bounds([...component, ...componentGroups]);
        let origin: Position = { x: original.x, y: original.y };
        if (incoming.length) {
            origin = {
                x: Math.max(...incoming.map((edge) => byId.get(edge.fromNodeId)!.position.x + byId.get(edge.fromNodeId)!.width + RANK_GAP - local.get(edge.toNodeId)!.x)),
                y: byId.get(incoming[0].fromNodeId)!.position.y + byId.get(incoming[0].fromNodeId)!.height / 2 - local.get(incoming[0].toNodeId)!.y - byId.get(incoming[0].toNodeId)!.height / 2,
            };
        } else if (outgoing.length) {
            const edge = outgoing[0];
            const fixed = byId.get(edge.toNodeId)!;
            const source = byId.get(edge.fromNodeId)!;
            origin = { x: fixed.position.x - RANK_GAP - source.width - local.get(source.id)!.x, y: fixed.position.y + fixed.height / 2 - local.get(source.id)!.y - source.height / 2 };
        }
        const positioned = component.map((item) => ({ ...item, position: { x: origin.x + local.get(item.id)!.x, y: origin.y + local.get(item.id)!.y } }));
        const containers = componentGroups.map((group) => {
            const placed = laidOut.find((item) => item.id === group.id)!;
            return { ...group, position: { x: origin.x + local.get(group.id)!.x, y: origin.y + local.get(group.id)!.y }, width: placed.width, height: placed.height };
        });
        const candidates = [...positioned, ...containers];
        const clear = (dx: number, dy: number) => candidates.every((item) => obstacles.every((fixed) =>
            (fixed.type === CanvasNodeType.Group && item.metadata?.groupId === fixed.id)
            || !intersects({ x: item.position.x + dx, y: item.position.y + dy, width: item.width, height: item.height }, { ...fixed.position, width: fixed.width, height: fixed.height })));
        const offsets = [{ x: 0, y: 0 }];
        for (const item of candidates) for (const fixed of obstacles) {
            if (fixed.type === CanvasNodeType.Group && item.metadata?.groupId === fixed.id) continue;
            offsets.push({ x: fixed.position.x + fixed.width + NODE_GAP - item.position.x, y: 0 });
            offsets.push({ x: fixed.position.x - item.position.x - item.width - NODE_GAP, y: 0 });
            offsets.push({ x: 0, y: fixed.position.y + fixed.height + NODE_GAP - item.position.y });
            offsets.push({ x: 0, y: fixed.position.y - item.position.y - item.height - NODE_GAP });
        }
        offsets.push({ x: Math.max(...obstacles.map((item) => item.position.x + item.width), 0) + NODE_GAP - Math.min(...candidates.map((item) => item.position.x)), y: 0 });
        const shift = offsets.sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y) || Math.abs(b.x) - Math.abs(a.x)).find((offset) => clear(offset.x, offset.y))!;
        for (const item of candidates) {
            const placed = shift.x || shift.y ? { ...item, position: { x: item.position.x + shift.x, y: item.position.y + shift.y } } : item;
            next.set(item.id, placed);
            obstacles.push(placed);
            if (item.metadata?.groupId && !wholeGroups.has(item.metadata.groupId)) affectedGroups.add(item.metadata.groupId);
        }
    }
    const result = nodes.map((node) => next.get(node.id)!);
    const expandedGroups = pinnedIds ? new Set([...affectedGroups].filter((id) => !pinnedIds.has(id))) : affectedGroups;
    return expandedGroups.size ? expandCanvasGroups(result, expandedGroups) : result;
}
