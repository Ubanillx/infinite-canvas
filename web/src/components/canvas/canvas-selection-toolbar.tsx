import type { CSSProperties, ReactNode } from "react";
import { Group, ScanText, Ungroup } from "lucide-react";
import { Tooltip } from "antd";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { nodeBounds } from "@/lib/canvas/canvas-node-geometry";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeData, type ViewportTransform } from "@/types/canvas";

const SELECTION_PAD = 14;

export function CanvasSelectionToolbar({
    nodes,
    viewport,
    showToolbar,
    canGroup,
    canUngroup,
    onGroup,
    onUngroup,
    onReversePrompt,
}: {
    nodes: CanvasNodeData[];
    viewport: ViewportTransform;
    showToolbar: boolean;
    canGroup: boolean;
    canUngroup: boolean;
    onGroup: () => void;
    onUngroup: () => void;
    onReversePrompt: () => void;
}) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    if (nodes.length < 2) return null;

    const bounds = nodeBounds(nodes);
    const left = viewport.x + bounds.left * viewport.k - SELECTION_PAD;
    const top = viewport.y + bounds.top * viewport.k - SELECTION_PAD;
    const width = (bounds.right - bounds.left) * viewport.k + SELECTION_PAD * 2;
    const height = (bounds.bottom - bounds.top) * viewport.k + SELECTION_PAD * 2;
    const imageCount = nodes.filter((node) => node.type === CanvasNodeType.Image && node.metadata?.content).length;
    const showActions = showToolbar && (canGroup || canUngroup || imageCount > 1);

    return (
        <>
            <svg className="pointer-events-none absolute z-[65] overflow-visible" style={{ left, top, width, height }}>
                <rect
                    x={1}
                    y={1}
                    width={Math.max(width - 2, 0)}
                    height={Math.max(height - 2, 0)}
                    rx={16}
                    ry={16}
                    fill={theme.canvas.selectionFill}
                    stroke={theme.canvas.selectionStroke}
                    strokeOpacity={0.55}
                    strokeWidth={1.5}
                    strokeDasharray="7 5"
                    strokeLinecap="round"
                />
            </svg>
            {showActions ? (
                <div
                    className="absolute top-[max(176px,var(--selection-toolbar-top))] z-[70] flex w-max max-w-[calc(100%-24px)] -translate-x-1/2 -translate-y-full flex-wrap items-center justify-center gap-x-2 text-sm sm:top-[max(128px,var(--selection-toolbar-top))]"
                    style={{ "--selection-toolbar-top": `${top - 8}px`, left: `clamp(min(200px, 50%), ${left + width / 2}px, max(calc(100% - 200px), 50%))`, color: theme.node.text } as CSSProperties}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    data-canvas-selection-toolbar
                >
                    {imageCount > 1 ? <SelectionAction title={t("canvas.reversePrompt.selectionTitle", { count: imageCount })} label={t("canvas.reversePrompt.selectionAction")} description={t("canvas.reversePrompt.selectionSummary", { count: imageCount })} icon={<ScanText className="size-4" />} onClick={onReversePrompt} /> : null}
                    {canGroup ? <SelectionAction title={t("canvas.nodeToolbar.groupTitle")} label={t("canvas.nodeToolbar.group")} icon={<Group className="size-4" />} onClick={onGroup} /> : null}
                    {canUngroup ? <SelectionAction title={t("canvas.nodeToolbar.ungroupTitle")} label={t("canvas.nodeToolbar.ungroup")} icon={<Ungroup className="size-4" />} onClick={onUngroup} /> : null}
                </div>
            ) : null}
        </>
    );
}

function SelectionAction({ title, label, description, icon, onClick }: { title: string; label: string; description?: string; icon: ReactNode; onClick: () => void }) {
    return (
        <Tooltip title={title} placement="top" mouseEnterDelay={0.2}>
            <button type="button" className="group relative flex h-10 items-center whitespace-nowrap rounded-lg px-1 focus-visible:outline-2 focus-visible:outline-offset-2" onClick={onClick} aria-label={title}>
                <span className="flex h-9 items-center gap-2 rounded-lg px-2.5 transition-colors group-hover:bg-black/5 dark:group-hover:bg-white/10">
                    {icon}
                    <span className="flex flex-col text-left leading-4">
                        <span>{label}</span>
                        {description ? <span className="mt-0.5 text-[11px] font-normal opacity-70">{description}</span> : null}
                    </span>
                </span>
            </button>
        </Tooltip>
    );
}
