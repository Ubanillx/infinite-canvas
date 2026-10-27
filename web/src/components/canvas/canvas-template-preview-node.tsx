import { memo, useState } from "react";
import { ChevronDown, Group, Image as ImageIcon, MessageSquare, Music2, Play, Puzzle, Settings2, Video } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { canvasTemplateImageUrl } from "@/services/api/canvas-template-media";
import { previewUrlFor } from "@/services/image-storage";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export type TemplatePreviewInputs = Record<string, number>;
const modeIcons = { image: ImageIcon, text: MessageSquare, video: Video, audio: Music2 };

// Static markup only: no editor, plugin renderer, generation callback, or media player is mounted.
export const CanvasTemplatePreviewNode = memo(function CanvasTemplatePreviewNode({ node, selected, inputs, childCount = 0, onSelect }: { node: CanvasNodeData; selected: boolean; inputs?: TemplatePreviewInputs; childCount?: number; onSelect: (id: string) => void }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [failedSource, setFailedSource] = useState("");
    const metadata = node.metadata;
    const isGroup = node.type === CanvasNodeType.Group;
    const image = metadata?.images?.find((item) => item.id === metadata.primaryImageId) || metadata?.images?.[0];
    const text = metadata?.texts?.find((item) => item.id === metadata.primaryTextId) || metadata?.texts?.[0];
    const key = image?.storageKey || metadata?.storageKey;
    const imageSource = node.type === CanvasNodeType.Image ? previewUrlFor(key) || canvasTemplateImageUrl(key, image?.content || metadata?.content) : "";
    const hasImage = Boolean(imageSource && failedSource !== imageSource);
    const Icon = node.type === CanvasNodeType.Image ? ImageIcon : node.type === CanvasNodeType.Video ? Video : node.type === CanvasNodeType.Audio ? Music2 : node.type === CanvasNodeType.Text ? MessageSquare : Puzzle;
    const mode = metadata?.generationMode || "image";
    const batchCount = node.type === CanvasNodeType.Image ? metadata?.images?.length || 0 : metadata?.texts?.length || 0;
    const textContent = text?.content || metadata?.content || "";
    const input = metadata?.templateInput;

    return <foreignObject x={node.position.x} y={node.position.y} width={node.width} height={node.height} overflow="visible">
        <button type="button" data-template-preview-node={node.id} aria-label={node.title} aria-pressed={selected} onClick={() => onSelect(node.id)} className="relative block size-full rounded-3xl border-2 text-left focus-visible:outline-2 focus-visible:outline-offset-4" style={{ color: theme.node.text, background: isGroup || hasImage ? "transparent" : theme.node.fill, borderStyle: isGroup ? "dashed" : "solid", borderColor: selected ? theme.node.activeStroke : hasImage ? "transparent" : theme.node.stroke }}>
            {!isGroup ? <span className="pointer-events-none absolute bottom-[calc(100%+6px)] left-3 max-w-[calc(100%-24px)] truncate text-xs font-medium" style={{ color: theme.node.label }}>{node.title}</span> : null}
            <div className="pointer-events-none relative size-full overflow-hidden rounded-[inherit]">
                {isGroup ? <div className="flex items-center gap-2 p-4 text-xs"><Group className="size-3.5 shrink-0" /><span className="truncate">{node.title}</span><span className="shrink-0" style={{ color: theme.node.muted }}>{t("canvas.node.nodeCount", { count: childCount })}</span></div> : input ? <div className="flex size-full flex-col items-center justify-center gap-3 p-4 text-center"><Icon className="size-7" style={{ color: theme.node.placeholder }} /><span className="text-sm font-medium">{input.name || node.title}</span><span className="text-xs" style={{ color: theme.node.muted }}>{t(input.required ? "canvas.templates.v2.required" : "canvas.templates.editor.optional")} · {t("canvas.templates.v2.input")}</span></div> : node.type === CanvasNodeType.Config ? <div className="flex size-full flex-col gap-2 px-3 pb-3 pt-7 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-semibold">{t("canvas.configNode.title")}</span><div className="flex rounded-md p-0.5" style={{ background: theme.node.panel }}>{Object.entries(modeIcons).map(([value, ModeIcon]) => <span key={value} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]" style={{ background: mode === value ? theme.toolbar.activeBg : "transparent", color: mode === value ? theme.node.text : theme.node.muted }}><ModeIcon className="size-3" />{t(`canvas.configNode.${value}`)}</span>)}</div></div>
                    <div className="flex flex-wrap gap-1.5">{Object.entries(inputs || {}).map(([type, count]) => <span key={type} className="rounded-md border px-2 py-1 text-[11px]" style={{ borderColor: theme.node.stroke }}>{t(`canvas.nodeTypes.${type}`)} {count}</span>)}<span className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px]" style={{ borderColor: theme.node.stroke }}><Settings2 className="size-3" />{t("canvas.configNode.compose")}</span></div>
                    {metadata?.composerContent || metadata?.prompt ? <p className="line-clamp-2 whitespace-pre-wrap break-words text-xs leading-5" style={{ color: theme.node.muted }}>{metadata.composerContent || metadata.prompt}</p> : null}
                    <div className="mt-auto flex min-w-0 items-center justify-between gap-2 py-2 text-xs"><span className="flex min-w-0 items-center gap-1.5"><span className="truncate">{metadata?.model?.split("::").at(-1) || t("canvas.templates.preview.defaultModel")}</span><ChevronDown className="size-3 shrink-0" /></span><span className="shrink-0" style={{ color: theme.node.muted }}>{[metadata?.size, metadata?.quality, metadata?.count ? `× ${metadata.count}` : ""].filter(Boolean).join(" · ")}</span></div>
                    <div className="flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border text-xs" style={{ borderColor: theme.node.stroke, color: theme.node.placeholder }}><Play className="size-3.5" />{t("canvas.configNode.generate")}</div>
                </div> : node.type === CanvasNodeType.Text ? <div className={`size-full overflow-hidden whitespace-pre-wrap break-words font-mono ${batchCount > 1 ? "px-4 pb-4 pt-14" : "p-4"}`} style={{ fontSize: metadata?.fontSize || 14, lineHeight: 1.65, color: textContent ? theme.node.text : theme.node.placeholder }}>{textContent || t("canvas.node.editText")}</div> : hasImage ? <img src={imageSource} alt={node.title} loading="lazy" decoding="async" fetchPriority="low" draggable={false} onError={() => setFailedSource(imageSource)} className="block size-full object-contain" /> : <div className="flex size-full flex-col items-center justify-center gap-3 p-4 text-center" style={{ color: theme.node.placeholder }}>
                    <Icon className="size-7" />
                    <span className="text-sm">{node.type === CanvasNodeType.Image ? t(imageSource ? "canvas.templates.preview.mediaUnavailable" : "canvas.node.emptyImage") : node.type === CanvasNodeType.Video ? t(metadata?.content || metadata?.storageKey ? "canvas.templates.preview.video" : "canvas.node.emptyVideo") : node.type === CanvasNodeType.Audio ? t(metadata?.content || metadata?.storageKey ? "canvas.templates.preview.audio" : "canvas.node.emptyAudio") : node.title}</span>
                    {node.type === CanvasNodeType.Audio && (metadata?.content || metadata?.storageKey) ? <div className="flex h-9 items-center justify-center gap-1" aria-hidden="true">{[12, 24, 16, 30, 20, 14, 26, 18, 30, 12].map((height, index) => <span key={index} className="w-1 rounded-full opacity-50" style={{ height, background: theme.node.muted }} />)}</div> : null}
                </div>}
                {batchCount > 1 && !input ? <span className="absolute right-2.5 top-2.5 rounded-full border px-3 py-1.5 text-xs" style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke }}>{t(node.type === CanvasNodeType.Image ? "canvas.controls.images" : "canvas.controls.texts", { count: batchCount })}</span> : null}
            </div>
        </button>
    </foreignObject>;
});
