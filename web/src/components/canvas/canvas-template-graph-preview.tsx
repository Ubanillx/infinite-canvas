import { memo, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { CanvasTemplatePreviewNode, type TemplatePreviewInputs } from "@/components/canvas/canvas-template-preview-node";
import { nodeBounds } from "@/lib/canvas/canvas-node-geometry";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType } from "@/types/canvas";
import type { CanvasTemplateContent } from "@/types/canvas-template";

export const CanvasTemplateGraphPreview = memo(function CanvasTemplateGraphPreview({ content, viewportClassName = "h-[42dvh]" }: { content: CanvasTemplateContent; viewportClassName?: string }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const gridId = useId();
    const viewportRef = useRef<HTMLDivElement>(null);
    const [zoom, setZoom] = useState(1);
    const [selectedId, setSelectedId] = useState("");
    // Build geometry and connection summaries once per snapshot, not on zoom or selection.
    const scene = useMemo(() => {
        const byId = new Map(content.nodes.map((node) => [node.id, node]));
        const inputs = new Map<string, TemplatePreviewInputs>();
        const childCounts = new Map<string, number>();
        const groups = content.nodes.filter((node) => node.type === CanvasNodeType.Group);
        const nodes = content.nodes.filter((node) => node.type !== CanvasNodeType.Group);
        for (const node of content.nodes) {
            if (node.metadata?.groupId) childCounts.set(node.metadata.groupId, (childCounts.get(node.metadata.groupId) || 0) + 1);
        }
        const paths = content.connections.flatMap((edge) => {
            const from = byId.get(edge.fromNodeId);
            const to = byId.get(edge.toNodeId);
            if (!from || !to) return [];
            const counts = inputs.get(to.id) || {};
            const type = from.type;
            counts[type] = (counts[type] || 0) + 1;
            inputs.set(to.id, counts);
            const x1 = from.position.x + from.width;
            const y1 = from.position.y + from.height / 2;
            const x2 = to.position.x;
            const y2 = to.position.y + to.height / 2;
            const curve = Math.max(Math.abs(x2 - x1) * 0.5, 50);
            return [{ id: edge.id, d: `M ${x1} ${y1} C ${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2}` }];
        });
        const bounds = content.nodes.length ? nodeBounds(content.nodes) : { left: 0, top: 0, right: 400, bottom: 300 };
        return { byId, groups, nodes, paths, inputs, childCounts, bounds };
    }, [content.nodes, content.connections]);
    const selected = scene.byId.get(selectedId);
    const primaryText = selected?.metadata?.texts?.find((item) => item.id === selected.metadata?.primaryTextId) || selected?.metadata?.texts?.[0];
    const selectedText = selected?.metadata?.composerContent || selected?.metadata?.prompt || (selected?.type === "text" ? primaryText?.content || selected.metadata?.content : "");
    const nodeTypeLabel = (type: string) => t(`canvas.nodeTypes.${type}`, { defaultValue: t("canvas.templates.editor.customNode") });
    const { bounds } = scene;
    const controlClass = "rounded-md px-2.5 py-1 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2";
    return <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-1 text-sm"><span className="mr-auto text-xs text-muted-foreground">{t("canvas.templates.editor.previewHint")}</span><button type="button" className={controlClass} aria-label={t("canvas.templates.v2.zoomOut")} onClick={() => setZoom((value) => value / 1.25)}>−</button><button type="button" className={controlClass} aria-label={t("canvas.templates.editor.resetZoom")} onClick={() => { setZoom(1); viewportRef.current?.scrollTo(0, 0); }}>{Math.round(zoom * 100)}%</button><button type="button" className={controlClass} aria-label={t("canvas.templates.v2.zoomIn")} onClick={() => setZoom((value) => value * 1.25)}>+</button></div>
        <div ref={viewportRef} className={`overflow-auto rounded-lg border border-border ${viewportClassName}`} style={{ background: theme.canvas.background }}>
            {!content.nodes.length ? <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">{t("canvas.templates.editor.emptyPreview")}</div> : <div className="grid place-items-center" style={{ width: `${Math.max(1, zoom) * 100}%`, height: `${Math.max(1, zoom) * 100}%` }}>
                <svg data-template-preview-scene aria-label={t("canvas.templates.v2.readOnlyPreview")} style={{ width: `${Math.min(1, zoom) * 100}%`, height: `${Math.min(1, zoom) * 100}%` }} viewBox={`${bounds.left - 32} ${bounds.top - 32} ${bounds.right - bounds.left + 64} ${bounds.bottom - bounds.top + 64}`}>
                    {content.backgroundMode !== "blank" ? <>
                        <defs><pattern id={gridId} patternUnits="userSpaceOnUse" width={48} height={48}>{content.backgroundMode === "dots" ? <circle cx={1} cy={1} r={1.15} fill={theme.canvas.dot} /> : <path d="M 48 0 H 0 V 48" fill="none" stroke={theme.canvas.line} />}</pattern></defs>
                        <rect x={bounds.left - 32} y={bounds.top - 32} width={bounds.right - bounds.left + 64} height={bounds.bottom - bounds.top + 64} fill={`url(#${gridId})`} opacity={0.4} />
                    </> : null}
                    {scene.groups.map((node) => <CanvasTemplatePreviewNode key={node.id} node={node} selected={selectedId === node.id} childCount={scene.childCounts.get(node.id)} onSelect={setSelectedId} />)}
                    {scene.paths.map((edge) => <path key={edge.id} d={edge.d} fill="none" stroke={theme.node.muted} strokeWidth={2} strokeOpacity={0.82} pointerEvents="none" />)}
                    {scene.nodes.map((node) => <CanvasTemplatePreviewNode key={node.id} node={node} selected={selectedId === node.id} inputs={scene.inputs.get(node.id)} onSelect={setSelectedId} />)}
                </svg>
            </div>}
        </div>
        {selected ? <section aria-label={t("canvas.templates.v2.nodeDetails")} className="space-y-2 break-words rounded-lg border border-border p-3 text-xs"><h4 className="text-sm font-medium">{selected.title}</h4><p className="text-muted-foreground">{nodeTypeLabel(selected.type)}{selected.metadata?.model ? ` · ${selected.metadata.model}` : ""}</p>{selectedText ? <p className="max-h-40 overflow-auto whitespace-pre-wrap">{selectedText}</p> : null}{selected.metadata?.templateInput ? <p>{t("canvas.templates.v2.input")}: {selected.metadata.templateInput.name}{selected.metadata.templateInput.description ? ` · ${selected.metadata.templateInput.description}` : ""}</p> : null}</section> : null}
    </div>;
});
