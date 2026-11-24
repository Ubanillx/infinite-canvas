import React, { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { createFrameTask } from "@/lib/canvas/frame-task";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ViewportTransform } from "@/types/canvas";

const CANVAS_VIEW_PADDING = 280;
const GRID_SPACING = 48;

export function getCanvasViewPadding(scale: number) {
    // Keep the preparation margin in screen pixels at overview zoom.
    return CANVAS_VIEW_PADDING / Math.min(scale, 1);
}

type CullingWindow = { base: ViewportTransform; center: ViewportTransform; visibleOnly?: boolean };

function panDistance(from: ViewportTransform, to: ViewportTransform) {
    return Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
}

function sceneTransform({ x, y, k }: ViewportTransform) {
    return `translate3d(${x}px, ${y}px, 0) scale(${k})`;
}

function gridTransform({ x, y, k }: ViewportTransform) {
    const spacing = GRID_SPACING * k;
    return `translate3d(${x % spacing}px, ${y % spacing}px, 0)`;
}

type InfiniteCanvasProps = {
    containerRef: React.RefObject<HTMLDivElement | null>;
    overlayRef: React.RefObject<HTMLElement | null>;
    viewport: ViewportTransform;
    liveViewportRef: React.RefObject<ViewportTransform>;
    tool: "select" | "pan";
    backgroundMode?: CanvasBackgroundMode;
    onViewportChange: (viewport: ViewportTransform) => void;
    onPanStart: () => void;
    onCanvasMouseDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
    onCanvasDeselect?: () => void;
    onCanvasDoubleClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
    onContextMenu?: (event: React.MouseEvent) => void;
    onDrop?: (event: React.DragEvent<HTMLDivElement>) => void;
    renderScene: (viewport: ViewportTransform, isPanning: boolean, visibleOnly: boolean) => React.ReactNode;
    isSceneCovered: (viewport: ViewportTransform) => boolean;
    children: React.ReactNode;
};

export function InfiniteCanvas({ containerRef, overlayRef, viewport, liveViewportRef, tool, backgroundMode = "lines", onViewportChange, onPanStart, onCanvasMouseDown, onCanvasDeselect, onCanvasDoubleClick, onContextMenu, onDrop, renderScene, isSceneCovered, children }: InfiniteCanvasProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const panState = useRef({
        isPanning: false,
        startX: 0,
        startY: 0,
        initialX: 0,
        initialY: 0,
        hasMoved: false,
        startedOnBackground: false,
    });
    const inputViewportRef = useRef(viewport);
    const renderedViewportRef = useRef(viewport);
    const [cullingWindow, setCullingWindow] = useState<CullingWindow | null>(null);
    const currentWindow = cullingWindow?.base === viewport ? cullingWindow : null;
    const cullingViewport = currentWindow?.center ?? viewport;
    const cullingViewportRef = useRef(cullingViewport);
    const visibleOnlyRef = useRef(false);
    const pendingCullingRef = useRef<CullingWindow | null>(null);
    const sceneRef = useRef<HTMLDivElement>(null);
    const gridRef = useRef<HTMLDivElement>(null);
    const panOverlaysRef = useRef<NodeListOf<HTMLElement | SVGElement> | undefined>(undefined);
    const wheelRectRef = useRef<DOMRect | null>(null);
    const paintPan = useCallback((next: ViewportTransform, base: ViewportTransform) => {
        liveViewportRef.current = next;
        const x = next.x - base.x;
        const y = next.y - base.y;
        const moving = x !== 0 || y !== 0;
        if (sceneRef.current) sceneRef.current.style.transform = sceneTransform(next);
        if (gridRef.current) gridRef.current.style.transform = gridTransform(next);
        // Scope the offsets to the controls using them so the scene's nodes keep their computed styles.
        for (const overlay of panOverlaysRef.current ?? []) {
            if (moving) {
                overlay.style.setProperty("--canvas-pan-x", `${x}px`);
                overlay.style.setProperty("--canvas-pan-y", `${y}px`);
            } else {
                overlay.style.removeProperty("--canvas-pan-x");
                overlay.style.removeProperty("--canvas-pan-y");
            }
        }
    }, [liveViewportRef]);
    const viewportTask = useMemo(() => createFrameTask<ViewportTransform>((next) => {
        wheelRectRef.current = null;
        if (!panState.current.isPanning) {
            onViewportChange(next);
            return;
        }
        const base = renderedViewportRef.current;
        if (next.k !== base.k) {
            flushSync(() => onViewportChange(next));
            return;
        }

        paintPan(next, base);
        const margin = getCanvasViewPadding(base.k) * base.k;
        const anchor = cullingViewportRef.current;
        const distance = panDistance(anchor, next);
        if ((visibleOnlyRef.current || distance >= margin) && !isSceneCovered(next)) {
            // A fast jump only needs the visible nodes now. The rest can still prepare in a transition.
            flushSync(() => setCullingWindow({ base, center: next, visibleOnly: true }));
            pendingCullingRef.current = null;
        }
        if ((visibleOnlyRef.current || distance >= margin / 2) && !pendingCullingRef.current) {
            // Prepare in the drag direction while leaving coverage behind the pointer for a reversal.
            const lead = visibleOnlyRef.current ? 0 : margin / (2 * distance);
            const center = {
                x: next.x + (next.x - anchor.x) * lead,
                y: next.y + (next.y - anchor.y) * lead,
                k: next.k,
            };
            const nextWindow = { base, center };
            pendingCullingRef.current = nextWindow;
            startTransition(() => setCullingWindow(nextWindow));
        }
    }), [isSceneCovered, onViewportChange, paintPan]);
    const [isSpacePressed, setIsSpacePressed] = useState(false);
    const [isControlPressed, setIsControlPressed] = useState(false);
    const [isPanning, setIsPanning] = useState(false);

    useLayoutEffect(() => {
        panOverlaysRef.current = overlayRef.current?.querySelectorAll("[data-canvas-pan-overlay]");
        const pan = panState.current;
        if (renderedViewportRef.current !== viewport) {
            if (pan.isPanning && viewport !== inputViewportRef.current) {
                viewportTask.cancel();
                pan.initialX += viewport.x - inputViewportRef.current.x;
                pan.initialY += viewport.y - inputViewportRef.current.y;
            }
            renderedViewportRef.current = viewport;
            inputViewportRef.current = viewport;
            liveViewportRef.current = viewport;
            pendingCullingRef.current = null;
        }
        cullingViewportRef.current = cullingViewport;
        visibleOnlyRef.current = currentWindow?.visibleOnly ?? false;
        if (pendingCullingRef.current === cullingWindow) pendingCullingRef.current = null;
        const live = pan.isPanning ? liveViewportRef.current : viewport;
        if (pan.isPanning && (visibleOnlyRef.current || panDistance(cullingViewport, live) >= getCanvasViewPadding(viewport.k) * viewport.k) && !isSceneCovered(live)) {
            // A direction reversal can make a prepared window stale before its commit.
            // Layout effects finish the correction before the browser can paint it.
            pendingCullingRef.current = null;
            setCullingWindow({ base: viewport, center: live, visibleOnly: true });
        }
        paintPan(live, viewport);
    });

    useEffect(() => () => viewportTask.cancel(), [viewportTask]);

    const finishPan = useCallback(() => {
        if (!panState.current.isPanning) {
            viewportTask.flush();
            return;
        }
        viewportTask.cancel();
        wheelRectRef.current = null;
        panState.current.isPanning = false;
        const next = inputViewportRef.current;
        if (next !== renderedViewportRef.current) onViewportChange(next);
        setIsPanning(false);
        document.body.style.cursor = "";
    }, [onViewportChange, viewportTask]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Control") setIsControlPressed(true);
            if (event.code !== "Space") return;
            const target = event.target instanceof Element ? event.target : null;
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || target?.closest("[contenteditable='true']")) return;
            event.preventDefault();
            setIsSpacePressed(true);
        };

        const handleKeyUp = (event: KeyboardEvent) => {
            if (event.code === "Space") {
                const target = event.target instanceof Element ? event.target : null;
                if (!(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || target?.closest("[contenteditable='true']"))) event.preventDefault();
                setIsSpacePressed(false);
            }
            if (event.key === "Control") setIsControlPressed(false);
        };

        const handleBlur = () => {
            finishPan();
            setIsSpacePressed(false);
            setIsControlPressed(false);
        };

        window.addEventListener("keydown", handleKeyDown);
        window.addEventListener("keyup", handleKeyUp);
        window.addEventListener("blur", handleBlur);
        return () => {
            window.removeEventListener("keydown", handleKeyDown);
            window.removeEventListener("keyup", handleKeyUp);
            window.removeEventListener("blur", handleBlur);
        };
    }, [finishPan]);

    const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-canvas-no-zoom],.ant-modal,.ant-popover,.ant-dropdown,.ant-select-dropdown,.ant-picker-dropdown")) return;

        const delta = -event.deltaY;
        const factor = Math.pow(1.1, delta / 100);
        const current = inputViewportRef.current;
        const newScale = Math.min(Math.max(current.k * factor, 0.05), 5);
        if (newScale === current.k) return;
        const rect = wheelRectRef.current || containerRef.current?.getBoundingClientRect();
        if (!rect) return;
        wheelRectRef.current = rect;

        const mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;
        const worldX = (mouseX - current.x) / current.k;
        const worldY = (mouseY - current.y) / current.k;

        const next = {
            x: mouseX - worldX * newScale,
            y: mouseY - worldY * newScale,
            k: newScale,
        };
        const pan = panState.current;
        if (pan.isPanning) {
            pan.initialX += next.x - current.x;
            pan.initialY += next.y - current.y;
        }
        inputViewportRef.current = next;
        viewportTask.schedule(next);
    };

    const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-canvas-no-zoom]")) return;
        if (target?.closest("[data-connection-create-menu]")) return;
        const isBackgroundClick = !target?.closest("[data-node-id],[data-connection-id]");
        const temporaryTool = event.ctrlKey || isSpacePressed;
        const activeTool = temporaryTool ? (tool === "select" ? "pan" : "select") : tool;
        const shouldPan = event.button === 1 || (event.button === 0 && activeTool === "pan" && isBackgroundClick);

        if (shouldPan) {
            viewportTask.flush();
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            panState.current = {
                isPanning: true,
                startX: event.clientX,
                startY: event.clientY,
                initialX: inputViewportRef.current.x,
                initialY: inputViewportRef.current.y,
                hasMoved: false,
                startedOnBackground: isBackgroundClick,
            };
            onPanStart();
            setIsPanning(true);
            document.body.style.cursor = "grabbing";
            return;
        }

        if (event.button === 0 && isBackgroundClick) {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            onCanvasMouseDown?.(event);
        }
    };

    const handleDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-canvas-no-zoom],[data-node-id],[data-connection-id]")) return;
        onCanvasDoubleClick?.(event);
    };

    useEffect(() => {
        const handlePointerMove = (event: PointerEvent) => {
            if (!panState.current.isPanning) return;

            const dx = event.clientX - panState.current.startX;
            const dy = event.clientY - panState.current.startY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
                panState.current.hasMoved = true;
            }

            const next = {
                x: panState.current.initialX + dx,
                y: panState.current.initialY + dy,
                k: inputViewportRef.current.k,
            };
            if (next.x === inputViewportRef.current.x && next.y === inputViewportRef.current.y) return;
            inputViewportRef.current = next;
            viewportTask.schedule(next);
        };

        const handlePointerUp = (event: PointerEvent) => {
            if (!panState.current.isPanning) return;
            if (event.type === "pointerup") handlePointerMove(event);
            finishPan();
            if (!panState.current.hasMoved && panState.current.startedOnBackground) {
                onCanvasDeselect?.();
            }
        };

        window.addEventListener("pointermove", handlePointerMove);
        window.addEventListener("pointerup", handlePointerUp);
        window.addEventListener("pointercancel", handlePointerUp);
        return () => {
            window.removeEventListener("pointermove", handlePointerMove);
            window.removeEventListener("pointerup", handlePointerUp);
            window.removeEventListener("pointercancel", handlePointerUp);
            document.body.style.cursor = "";
        };
    }, [finishPan, onCanvasDeselect, viewportTask]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        // Prevent canvas scrolling from moving the page while preserving native scrolling inside overlays and dialogs.
        const preventWheelScroll = (event: WheelEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest("[data-canvas-no-zoom],.ant-modal,.ant-popover,.ant-dropdown,.ant-select-dropdown,.ant-picker-dropdown")) return;
            event.preventDefault();
        };
        container.addEventListener("wheel", preventWheelScroll, { passive: false });
        return () => container.removeEventListener("wheel", preventWheelScroll);
    }, [containerRef]);

    const temporaryTool = isControlPressed || isSpacePressed;
    const activeTool = temporaryTool ? (tool === "select" ? "pan" : "select") : tool;
    const cursor = isPanning ? "grabbing" : activeTool === "pan" ? "grab" : undefined;

    return (
        <div
            ref={containerRef}
            className="relative h-full w-full select-none overflow-hidden"
            style={{ background: theme.canvas.background, cursor }}
            onPointerDown={handlePointerDown}
            onDoubleClick={handleDoubleClick}
            onWheel={handleWheel}
            onContextMenu={onContextMenu}
            onDragOver={(event) => event.preventDefault()}
            onDrop={onDrop}
        >
            <CanvasGrid gridRef={gridRef} viewport={viewport} mode={backgroundMode} />
            <div
                ref={sceneRef}
                className="absolute origin-top-left"
                style={{
                    transform: sceneTransform(viewport),
                    willChange: "transform",
                }}
            >
                {renderScene(cullingViewport, isPanning, currentWindow?.visibleOnly ?? false)}
                {children}
            </div>
        </div>
    );
}

const CanvasGrid = React.memo(function CanvasGrid({ gridRef, viewport, mode }: { gridRef: React.RefObject<HTMLDivElement | null>; viewport: ViewportTransform; mode: CanvasBackgroundMode }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    if (mode === "blank") return null;

    const gridSize = GRID_SPACING * viewport.k;
    const dotSize = viewport.k < 0.12 ? 0.8 : 1.15;
    const backgroundImage =
        mode === "dots" ? `radial-gradient(circle, ${theme.canvas.dot} ${dotSize}px, transparent ${dotSize + 0.2}px)` : `linear-gradient(${theme.canvas.line} 1px, transparent 1px), linear-gradient(90deg, ${theme.canvas.line} 1px, transparent 1px)`;

    return (
        <div
            ref={gridRef}
            className="pointer-events-none absolute opacity-40"
            style={{
                inset: -gridSize,
                backgroundImage,
                backgroundSize: `${gridSize}px ${gridSize}px`,
                transform: gridTransform(viewport),
                willChange: "transform",
            }}
        />
    );
});
