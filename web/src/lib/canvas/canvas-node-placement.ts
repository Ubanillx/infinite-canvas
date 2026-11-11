import { getGroupWrapRect } from "@/lib/canvas/canvas-node-geometry";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const GAP = 48;

function overlaps(a: CanvasNodeData, b: CanvasNodeData) {
    return a.position.x < b.position.x + b.width + GAP && a.position.x + a.width + GAP > b.position.x
        && a.position.y < b.position.y + b.height + GAP && a.position.y + a.height + GAP > b.position.y;
}

function movePast(nodes: CanvasNodeData[], obstacles: CanvasNodeData[]) {
    const clear = (dx: number, dy: number) => {
        for (const node of nodes) {
            for (const obstacle of obstacles) {
                if (obstacle.type === CanvasNodeType.Group && node.metadata?.groupId === obstacle.id) continue;
                if (overlaps({ ...node, position: { x: node.position.x + dx, y: node.position.y + dy } }, obstacle)) return false;
            }
        }
        return true;
    };
    if (clear(0, 0)) return nodes;
    const candidates: Array<{ dx: number; dy: number }> = [];
    for (const node of nodes) {
        for (const obstacle of obstacles) {
            if (obstacle.type === CanvasNodeType.Group && node.metadata?.groupId === obstacle.id) continue;
            candidates.push(
                { dx: obstacle.position.x + obstacle.width + GAP - node.position.x, dy: 0 },
                { dx: obstacle.position.x - node.position.x - node.width - GAP, dy: 0 },
                { dx: 0, dy: obstacle.position.y + obstacle.height + GAP - node.position.y },
                { dx: 0, dy: obstacle.position.y - node.position.y - node.height - GAP },
            );
        }
    }
    const nearest = candidates
        .sort((a, b) => Math.hypot(a.dx, a.dy) - Math.hypot(b.dx, b.dy) || Math.abs(a.dx) - Math.abs(b.dx))
        .find(({ dx, dy }) => clear(dx, dy));
    return nearest ? nodes.map((node) => ({ ...node, position: { x: node.position.x + nearest.dx, y: node.position.y + nearest.dy } })) : nodes;
}

export function expandCanvasGroups(nodes: CanvasNodeData[], groupIds?: ReadonlySet<string>) {
    return nodes.map((node) => {
        if (node.type !== CanvasNodeType.Group || (groupIds && !groupIds.has(node.id))) return node;
        const members = nodes.filter((member) => member.metadata?.groupId === node.id);
        if (!members.length) return node;
        const rect = getGroupWrapRect(members);
        const x = Math.min(node.position.x, rect.x);
        const y = Math.min(node.position.y, rect.y);
        const right = Math.max(node.position.x + node.width, rect.x + rect.width);
        const bottom = Math.max(node.position.y + node.height, rect.y + rect.height);
        return x === node.position.x && y === node.position.y && right === node.position.x + node.width && bottom === node.position.y + node.height
            ? node : { ...node, position: { x, y }, width: right - x, height: bottom - y };
    });
}

/** Place a batch without moving existing nodes; preserve its relative layout whenever possible. */
export function placeCanvasNodes(existingNodes: CanvasNodeData[], incomingNodes: CanvasNodeData[]): CanvasNodeData[] {
    if (!incomingNodes.length) return incomingNodes;
    const newGroupIds = new Set(incomingNodes.filter((node) => node.type === CanvasNodeType.Group).map((node) => node.id));
    const units: CanvasNodeData[][] = [];
    const handledGroups = new Set<string>();
    for (const node of incomingNodes) {
        const groupId = node.type === CanvasNodeType.Group ? node.id : node.metadata?.groupId;
        if (!groupId || !newGroupIds.has(groupId)) {
            units.push([node]);
            continue;
        }
        if (handledGroups.has(groupId)) continue;
        handledGroups.add(groupId);
        const group = incomingNodes.find((item) => item.id === groupId)!;
        const members: CanvasNodeData[] = [];
        for (const member of incomingNodes.filter((item) => item.metadata?.groupId === groupId && item.id !== groupId)) {
            members.push(movePast([member], members)[0]);
        }
        units.push(expandCanvasGroups([group, ...members]));
    }
    const placed: CanvasNodeData[] = [];
    for (const unit of units) placed.push(...movePast(unit, placed));
    const byId = new Map(movePast(placed, existingNodes).map((node) => [node.id, node]));
    return incomingNodes.map((node) => byId.get(node.id) || node);
}

/** Keep unaffected nodes fixed when an asynchronous result changes a node's dimensions. */
export function avoidCanvasNodeOverlap(nodes: CanvasNodeData[], changedIds: ReadonlySet<string>): CanvasNodeData[] {
    if (!changedIds.size) return nodes;
    const moving = new Set(changedIds);
    for (const node of nodes) {
        if (!moving.has(node.id)) continue;
        if (node.metadata?.groupId) moving.add(node.metadata.groupId);
    }
    for (const node of nodes) {
        if (node.metadata?.groupId && moving.has(node.metadata.groupId)) moving.add(node.id);
    }
    const fixed = nodes.filter((node) => !moving.has(node.id));
    const moved = nodes.filter((node) => moving.has(node.id));
    const placed = placeCanvasNodes(fixed, moved);
    const byId = new Map(placed.map((node) => [node.id, node]));
    return nodes.map((node) => byId.get(node.id) || node);
}
