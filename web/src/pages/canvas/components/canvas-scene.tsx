import { memo, useLayoutEffect, useMemo, useRef, type MouseEvent, type ReactNode, type RefObject } from "react";

import { ConnectionPath } from "@/components/canvas/canvas-connections";
import { getCanvasViewPadding } from "@/components/canvas/infinite-canvas";
import { getCanvasConnectionGeometry } from "@/lib/canvas/canvas-connection-geometry";
import { getNodePluginId } from "@/lib/canvas/node-registry";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type ViewportTransform } from "@/types/canvas";

type CanvasSceneProps = {
    viewport: ViewportTransform;
    isPanning: boolean;
    visibleOnly: boolean;
    size: { width: number; height: number };
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    nodeById: ReadonlyMap<string, CanvasNodeData>;
    dialogNodeId: string | null;
    pinnedNodeIds?: ReadonlySet<string>;
    coverageRef: RefObject<((viewport: ViewportTransform) => boolean) | null>;
    selectedConnectionId: string | null;
    highlightedConnectionIds: ReadonlySet<string>;
    activeConnection: ReactNode;
    renderNode: (node: CanvasNodeData) => ReactNode;
    onConnectionSelect: (id: string) => void;
    onConnectionContextMenu: (event: MouseEvent<SVGPathElement>, id: string) => void;
};

type SceneBounds = { left: number; top: number; right: number; bottom: number };
type VisibleConnection = { connection: CanvasConnection; from: CanvasNodeData; to: CanvasNodeData };

function nodeIntersects(node: CanvasNodeData, bounds: SceneBounds) {
    const { x, y } = node.position;
    return x + node.width > bounds.left && x < bounds.right && y + node.height > bounds.top && y < bounds.bottom;
}

function boundsIntersect(a: SceneBounds, b: SceneBounds) {
    return a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
}

function getViewBounds(viewport: ViewportTransform, size: CanvasSceneProps["size"], padding: number): SceneBounds {
    const left = -viewport.x / viewport.k - padding;
    const top = -viewport.y / viewport.k - padding;
    return { left, top, right: left + size.width / viewport.k + padding * 2, bottom: top + size.height / viewport.k + padding * 2 };
}

export const CanvasScene = memo(function CanvasScene({
    viewport, isPanning, visibleOnly, size, nodes, connections, nodeById, dialogNodeId, pinnedNodeIds, coverageRef, selectedConnectionId, highlightedConnectionIds,
    activeConnection, renderNode, onConnectionSelect, onConnectionContextMenu,
}: CanvasSceneProps) {
    const padding = getCanvasViewPadding(viewport.k);
    const viewBounds = useMemo(() => getViewBounds(viewport, size, visibleOnly ? 0 : padding), [padding, size, viewport, visibleOnly]);

    const visibleNodesRef = useRef<CanvasNodeData[]>([]);
    const visibleNodes = useMemo(() => {
        const previous = visibleNodesRef.current;
        const mounted = isPanning ? new Set(previous.map((node) => node.id)) : null;
        const retainedBounds = isPanning ? getViewBounds(viewport, size, padding + Math.max(size.width, size.height) / viewport.k) : null;
        const visible = nodes.filter((node) => node.id === dialogNodeId || pinnedNodeIds?.has(node.id) || nodeIntersects(node, viewBounds)
            || (retainedBounds && node.type === CanvasNodeType.Config && mounted?.has(node.id)
                && nodeIntersects(node, retainedBounds) && getNodePluginId(node.type) === "builtin"));
        return visible.length === previous.length && visible.every((node, index) => node === previous[index]) ? previous : visible;
    }, [dialogNodeId, isPanning, nodes, padding, pinnedNodeIds, size, viewBounds, viewport]);

    // A curve may cross the viewport while both endpoints are outside it.
    const sceneConnections = useMemo(() => connections.flatMap((connection) => {
        const from = nodeById.get(connection.fromNodeId);
        const to = nodeById.get(connection.toNodeId);
        if (!from || !to) return [];
        return [{ connection, from, to, bounds: getCanvasConnectionGeometry(from, to) }];
    }), [connections, nodeById]);
    const visibleConnectionsRef = useRef<VisibleConnection[]>([]);
    const visibleConnections = useMemo(() => {
        const visible = sceneConnections.filter(({ bounds }) => boundsIntersect(bounds, viewBounds));
        const previous = visibleConnectionsRef.current;
        return visible.length === previous.length && visible.every((item, index) => (
            item.connection === previous[index].connection && item.from === previous[index].from && item.to === previous[index].to
        )) ? previous : visible;
    }, [sceneConnections, viewBounds]);

    useLayoutEffect(() => {
        visibleNodesRef.current = visibleNodes;
        visibleConnectionsRef.current = visibleConnections;
        const nodeIds = new Set(visibleNodes.map((node) => node.id));
        const connectionIds = new Set(visibleConnections.map(({ connection }) => connection.id));
        const unmountedNodes = nodes.filter((node) => !nodeIds.has(node.id));
        const unmountedConnections = sceneConnections.filter(({ connection }) => !connectionIds.has(connection.id));
        coverageRef.current = (next) => {
            const screen = getViewBounds(next, size, 0);
            return !unmountedNodes.some((node) => nodeIntersects(node, screen))
                && !unmountedConnections.some(({ bounds }) => boundsIntersect(bounds, screen));
        };
    }, [coverageRef, nodes, sceneConnections, size, visibleNodes, visibleConnections]);

    const connectionPaths = useMemo(() => visibleConnections.map(({ connection, from, to }) => (
        <ConnectionPath
            key={connection.id}
            connection={connection}
            from={from}
            to={to}
            active={selectedConnectionId === connection.id || highlightedConnectionIds.has(connection.id)}
            onSelect={onConnectionSelect}
            onContextMenu={onConnectionContextMenu}
        />
    )), [visibleConnections, selectedConnectionId, highlightedConnectionIds, onConnectionSelect, onConnectionContextMenu]);
    const renderedNodes = useMemo(() => visibleNodes.map(renderNode), [visibleNodes, renderNode]);

    return (
        <>
            <svg className="absolute left-0 top-0 overflow-visible" width={1} height={1} style={{ pointerEvents: "none", zIndex: 0 }}>
                {connectionPaths}
                {activeConnection}
            </svg>
            {renderedNodes}
        </>
    );
});
