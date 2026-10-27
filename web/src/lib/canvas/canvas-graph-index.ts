import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

type NodeIndex = { byId: Map<string, CanvasNodeData>; byGroup: Map<string, CanvasNodeData[]>; groups: CanvasNodeData[] };
type ConnectionIndex = { incoming: Map<string, CanvasConnection[]>; outgoing: Map<string, CanvasConnection[]> };
// Canvas arrays are immutable snapshots. Weak keys release indexes along with deleted/history snapshots.
const nodeIndexes = new WeakMap<CanvasNodeData[], NodeIndex>();
const connectionIndexes = new WeakMap<CanvasConnection[], ConnectionIndex>();

export function getCanvasNodeIndex(nodes: CanvasNodeData[]) {
    let index = nodeIndexes.get(nodes);
    if (!index) {
        index = { byId: new Map(), byGroup: new Map(), groups: [] };
        for (const node of nodes) {
            index.byId.set(node.id, node);
            if (node.type === CanvasNodeType.Group) index.groups.push(node);
            const groupId = node.metadata?.groupId;
            if (groupId) {
                const children = index.byGroup.get(groupId);
                if (children) children.push(node);
                else index.byGroup.set(groupId, [node]);
            }
        }
        nodeIndexes.set(nodes, index);
    }
    return index;
}

export function getCanvasConnectionIndex(connections: CanvasConnection[]) {
    let index = connectionIndexes.get(connections);
    if (!index) {
        index = { incoming: new Map(), outgoing: new Map() };
        for (const connection of connections) {
            const incoming = index.incoming.get(connection.toNodeId);
            if (incoming) incoming.push(connection);
            else index.incoming.set(connection.toNodeId, [connection]);
            const outgoing = index.outgoing.get(connection.fromNodeId);
            if (outgoing) outgoing.push(connection);
            else index.outgoing.set(connection.fromNodeId, [connection]);
        }
        connectionIndexes.set(connections, index);
    }
    return index;
}
