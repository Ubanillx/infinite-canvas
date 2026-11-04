import type { CanvasNodeData } from "@/types/canvas";

type ConnectionGeometry = {
    path: string;
    left: number;
    right: number;
    top: number;
    bottom: number;
};

// Endpoint snapshots are immutable; moving one node only invalidates its incident curves.
const geometries = new WeakMap<CanvasNodeData, WeakMap<CanvasNodeData, ConnectionGeometry>>();

export function getCanvasConnectionGeometry(from: CanvasNodeData, to: CanvasNodeData) {
    let targets = geometries.get(from);
    if (!targets) geometries.set(from, targets = new WeakMap());
    let geometry = targets.get(to);
    if (!geometry) {
        const startX = from.position.x + from.width;
        const startY = from.position.y + from.height / 2;
        const endX = to.position.x;
        const endY = to.position.y + to.height / 2;
        const curvature = Math.max(Math.abs(endX - startX) * 0.5, 50);
        geometry = {
            path: `M ${startX} ${startY} C ${startX + curvature} ${startY}, ${endX - curvature} ${endY}, ${endX} ${endY}`,
            left: Math.min(startX, endX - curvature),
            right: Math.max(startX + curvature, endX),
            top: Math.min(startY, endY),
            bottom: Math.max(startY, endY),
        };
        targets.set(to, geometry);
    }
    return geometry;
}
