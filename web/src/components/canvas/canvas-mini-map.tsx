import { memo, useCallback, useEffect, useMemo, useRef } from "react";

import { canvasThemes } from "@/lib/canvas-theme";
import { getNodeDefinition, useNodeRegistryVersion } from "@/lib/canvas/node-registry";
import { createFrameTask } from "@/lib/canvas/frame-task";
import { useThemeStore } from "@/stores/use-theme-store";
import { type CanvasNodeData, type Position, type ViewportTransform } from "@/types/canvas";

export const Minimap = memo(function Minimap({ nodes, viewport, viewportSize, onViewportChange }: { nodes: CanvasNodeData[]; viewport: ViewportTransform; viewportSize: { width: number; height: number }; onViewportChange: (viewport: ViewportTransform) => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const containerRef = useRef<HTMLDivElement>(null);
    const draggingRef = useRef(false);
    const registryVersion = useNodeRegistryVersion((state) => state.version);
    const width = 240;
    const height = 160;

    const { worldBounds, scale, offset } = useMemo(() => {
        if (!nodes.length) {
            return { worldBounds: { x: -500, y: -500, w: 1000, h: 1000 }, scale: 0.16, offset: { x: 40, y: 0 } };
        }

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        nodes.forEach((node) => {
            minX = Math.min(minX, node.position.x);
            minY = Math.min(minY, node.position.y);
            maxX = Math.max(maxX, node.position.x + node.width);
            maxY = Math.max(maxY, node.position.y + node.height);
        });

        minX -= 500;
        minY -= 500;
        maxX += 500;
        maxY += 500;

        const boundsWidth = maxX - minX;
        const boundsHeight = maxY - minY;
        const nextScale = Math.min(width / boundsWidth, height / boundsHeight);
        const mapContentW = boundsWidth * nextScale;
        const mapContentH = boundsHeight * nextScale;

        return {
            worldBounds: { x: minX, y: minY, w: boundsWidth, h: boundsHeight },
            scale: nextScale,
            offset: { x: (width - mapContentW) / 2, y: (height - mapContentH) / 2 },
        };
    }, [nodes]);

    const toMinimap = useCallback(
        (worldX: number, worldY: number) => {
            return {
                x: (worldX - worldBounds.x) * scale + offset.x,
                y: (worldY - worldBounds.y) * scale + offset.y,
            };
        },
        [offset.x, offset.y, scale, worldBounds.x, worldBounds.y],
    );

    const toWorld = useCallback(
        (minimapX: number, minimapY: number) => {
            return {
                x: (minimapX - offset.x) / scale + worldBounds.x,
                y: (minimapY - offset.y) / scale + worldBounds.y,
            };
        },
        [offset.x, offset.y, scale, worldBounds.x, worldBounds.y],
    );

    const viewportRect = useMemo(() => {
        const vx = -viewport.x / viewport.k;
        const vy = -viewport.y / viewport.k;
        const vw = viewportSize.width / viewport.k;
        const vh = viewportSize.height / viewport.k;
        const p1 = toMinimap(vx, vy);
        const p2 = toMinimap(vx + vw, vy + vh);

        return {
            x: p1.x,
            y: p1.y,
            w: Math.max(p2.x - p1.x, 4),
            h: Math.max(p2.y - p1.y, 4),
        };
    }, [toMinimap, viewport.k, viewport.x, viewport.y, viewportSize.height, viewportSize.width]);

    const viewportTask = useMemo(() => createFrameTask<Position>(({ x, y }) => {
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;

        const world = toWorld(x - rect.left, y - rect.top);
        onViewportChange({
            x: viewportSize.width / 2 - world.x * viewport.k,
            y: viewportSize.height / 2 - world.y * viewport.k,
            k: viewport.k,
        });
    }), [onViewportChange, toWorld, viewport.k, viewportSize.width, viewportSize.height]);
    useEffect(() => () => viewportTask.cancel(), [viewportTask]);
    const finishDrag = useCallback(() => {
        viewportTask.flush();
        draggingRef.current = false;
    }, [viewportTask]);
    useEffect(() => {
        window.addEventListener("blur", finishDrag);
        return () => window.removeEventListener("blur", finishDrag);
    }, [finishDrag]);

    // Panning changes only the viewport rectangle, not every node's DOM and inline styles.
    const nodeMarkers = useMemo(() => nodes.map((node) => {
        const pos = toMinimap(node.position.x, node.position.y);
        return <div key={node.id} className="absolute rounded-[1px]" style={{
            transform: `translate(${pos.x}px, ${pos.y}px)`,
            width: Math.max(node.width * scale, 2),
            height: Math.max(node.height * scale, 2),
            backgroundColor: getNodeDefinition(node.type)?.minimapColor || theme.node.muted,
            opacity: 0.8,
        }} />;
    }), [nodes, toMinimap, scale, theme.node.muted, registryVersion]);

    return (
        <div className="absolute bottom-24 left-6 z-50 overflow-hidden rounded-lg border shadow-2xl backdrop-blur-sm" style={{ width, height, background: theme.toolbar.panel, borderColor: theme.toolbar.border }}>
            <div
                ref={containerRef}
                className="relative h-full w-full cursor-crosshair"
                onPointerDown={(event) => {
                    event.preventDefault();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    draggingRef.current = true;
                    viewportTask.schedule({ x: event.clientX, y: event.clientY });
                }}
                onPointerMove={(event) => {
                    if (draggingRef.current) viewportTask.schedule({ x: event.clientX, y: event.clientY });
                }}
                onPointerUp={(event) => {
                    if (!draggingRef.current) return;
                    viewportTask.schedule({ x: event.clientX, y: event.clientY });
                    finishDrag();
                }}
                onPointerCancel={finishDrag}
                onLostPointerCapture={finishDrag}
            >
                {nodeMarkers}
                <div className="pointer-events-none absolute border" style={{ transform: `translate(${viewportRect.x}px, ${viewportRect.y}px)`, width: viewportRect.w, height: viewportRect.h, borderColor: theme.node.activeStroke, background: `${theme.node.activeStroke}18` }} />
            </div>
        </div>
    );
});
