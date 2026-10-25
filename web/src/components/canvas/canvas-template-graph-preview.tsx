import { useState } from "react";
import { useTranslation } from "react-i18next";

import { nodeBounds } from "@/lib/canvas/canvas-node-geometry";
import type { CanvasTemplateContent } from "@/types/canvas-template";

// Deliberately render data, not CanvasNode/plugin components: preview must never execute a node.
export function CanvasTemplateGraphPreview({ content }: { content: CanvasTemplateContent }) {
    const { t } = useTranslation();
    const [zoom, setZoom] = useState(1);
    const [selectedId, setSelectedId] = useState("");
    const selected = content.nodes.find((node) => node.id === selectedId);
    const bounds = content.nodes.length ? nodeBounds(content.nodes) : { left: 0, top: 0, right: 400, bottom: 300 };
    const nodes = new Map(content.nodes.map((node) => [node.id, node]));
    const controlClass = "rounded px-3 py-1 hover:bg-muted focus-visible:outline-2";
    return <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-sm"><span className="mr-auto text-xs text-muted-foreground">{t("canvas.templates.v2.readOnlyPreview")}</span><button type="button" className={controlClass} aria-label={t("canvas.templates.v2.zoomOut")} onClick={() => setZoom((value) => value / 1.25)}>-</button><button type="button" className={controlClass} onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button><button type="button" className={controlClass} aria-label={t("canvas.templates.v2.zoomIn")} onClick={() => setZoom((value) => value * 1.25)}>+</button></div>
        <div className="h-[42dvh] overflow-auto rounded-lg border border-border bg-background">
            <svg aria-label={t("canvas.templates.v2.readOnlyPreview")} style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%`, minWidth: "100%", minHeight: "100%" }} viewBox={`${bounds.left - 20} ${bounds.top - 20} ${bounds.right - bounds.left + 40} ${bounds.bottom - bounds.top + 40}`}>
                {content.connections.map((edge) => { const from = nodes.get(edge.fromNodeId); const to = nodes.get(edge.toNodeId); return from && to ? <line key={edge.id} x1={from.position.x + from.width} y1={from.position.y + from.height / 2} x2={to.position.x} y2={to.position.y + to.height / 2} stroke="currentColor" className="text-muted-foreground" /> : null; })}
                {content.nodes.map((node) => <g key={node.id} role="button" tabIndex={0} aria-label={node.title} aria-pressed={selectedId === node.id} className="cursor-pointer focus-visible:outline-2" onClick={() => setSelectedId(node.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedId(node.id); } }}>
                    <rect x={node.position.x} y={node.position.y} width={node.width} height={node.height} rx={8} fill="var(--color-card)" stroke="currentColor" strokeWidth={selectedId === node.id ? 3 : 1} className={selectedId === node.id ? "text-foreground" : "text-muted-foreground"} />
                    <text x={node.position.x + 12} y={node.position.y + 24} fill="currentColor" fontSize={14}>{node.title.slice(0, 30)}</text>
                    <text x={node.position.x + 12} y={node.position.y + 48} fill="currentColor" fontSize={12}>{node.metadata?.templateInput ? `${t("canvas.templates.v2.input")}: ${node.metadata.templateInput.name}` : node.type}</text>
                </g>)}
            </svg>
        </div>
        {selected ? <section aria-label={t("canvas.templates.v2.nodeDetails")} className="space-y-2 break-words rounded border border-border p-3 text-xs"><h4 className="text-sm font-medium">{selected.title}</h4><p>{selected.type}{selected.metadata?.model ? ` · ${selected.metadata.model}` : ""}</p><p className="max-h-40 overflow-auto whitespace-pre-wrap">{selected.metadata?.prompt || selected.metadata?.composerContent || (selected.type === "text" ? selected.metadata?.content : "")}</p>{selected.metadata?.templateInput ? <p>{t("canvas.templates.v2.input")}: {selected.metadata.templateInput.name} — {selected.metadata.templateInput.description}</p> : null}</section> : null}
    </div>;
}
