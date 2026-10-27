import { useMemo, useState } from "react";
import { Button, Image, Input, Modal, Tooltip } from "antd";
import { ArrowRight, Check, Eye, FileText, Images, Plus, ScanText, Search, Star } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ModelPicker } from "@/components/model-picker";
import { useImagePreview } from "@/hooks/use-image-preview";
import { canvasThemes } from "@/lib/canvas-theme";
import type { CanvasReversePromptOptions } from "@/lib/canvas/canvas-reverse-prompt";
import { resolveModelForCapability, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export function CanvasReversePromptDialog({ nodes, initialNodeIds, onClose, onConfirm }: {
    nodes: CanvasNodeData[];
    initialNodeIds: string[];
    onClose: () => void;
    onConfirm: (options: CanvasReversePromptOptions) => void;
}) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const config = useEffectiveConfig();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const [selectedIds, setSelectedIds] = useState(initialNodeIds);
    const [query, setQuery] = useState("");
    const [requirement, setRequirement] = useState("");
    const [model, setModel] = useState(() => resolveModelForCapability(config, undefined, "text"));
    const [preview, setPreview] = useState<CanvasNodeData | null>(null);
    const images = useMemo(() => nodes.filter((node) => node.type === CanvasNodeType.Image && node.metadata?.content), [nodes]);
    const imageById = useMemo(() => new Map(images.map((node) => [node.id, node])), [images]);
    const selected = selectedIds.flatMap((id) => imageById.has(id) ? [imageById.get(id)!] : []);
    const main = selected[0];
    const selectedSet = new Set(selected.map((node) => node.id));
    const search = query.trim().toLocaleLowerCase();
    const visible = images.filter((node) => !search || node.title.toLocaleLowerCase().includes(search));
    const confirm = (generate: boolean) => onConfirm({ nodeIds: selected.map((node) => node.id), model, requirement, generate });

    return <Modal
        open
        centered
        width={920}
        onCancel={onClose}
        modalRender={(content) => <div data-canvas-shortcuts-ignore>{content}</div>}
        title={<span className="inline-flex items-center gap-2.5"><ScanText className="size-5" />{t("canvas.projectPage.reverseTitle")}</span>}
        styles={{ container: { background: theme.node.panel, color: theme.node.text, boxShadow: "none" }, header: { background: "transparent" }, body: { maxHeight: "calc(100dvh - 230px)", overflowY: "auto", overscrollBehavior: "contain" } }}
        footer={<div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4" style={{ borderColor: theme.node.stroke }}>
            <span className="text-xs" style={{ color: theme.node.muted }}>{t("canvas.reversePrompt.footerHint")}</span>
            <div className="flex flex-wrap items-center gap-2">
                <Button type="text" disabled={!selected.length} onClick={() => confirm(false)}>{t("canvas.reversePrompt.createNodes")}</Button>
                <Button type="primary" disabled={!selected.length || !model} icon={<ScanText className="size-4" />} onClick={() => confirm(true)}>{t("canvas.reversePrompt.generate")}</Button>
            </div>
        </div>}
    >
        <p className="mb-5 pr-5 text-sm leading-6" style={{ color: theme.node.muted }}>{t("canvas.reversePrompt.description")}</p>
        <div className="grid min-w-0 gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)]">
            <section className="min-w-0 space-y-3" aria-label={t("canvas.reversePrompt.references")}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-medium">{t("canvas.reversePrompt.references")}</h3>
                    <span className="flex items-center gap-2 text-xs" style={{ color: theme.node.muted }} aria-live="polite">
                        <Images className="size-3.5" />{t("canvas.reversePrompt.selectedCount", { count: selected.length })}<ArrowRight className="size-3" /><FileText className="size-3.5" />{t("canvas.reversePrompt.onePrompt")}
                    </span>
                </div>
                <Input className="app-search-input" prefix={<Search className="size-3.5 opacity-60" />} value={query} allowClear onChange={(event) => setQuery(event.target.value)} placeholder={t("canvas.reversePrompt.search")} aria-label={t("canvas.reversePrompt.search")} />
                <div className="thin-scrollbar grid max-h-[min(400px,42dvh)] grid-cols-2 gap-2.5 overflow-y-auto overscroll-contain p-1 sm:grid-cols-3 md:grid-cols-2 lg:grid-cols-3">
                    {visible.map((node) => <ReverseImageCard key={node.id} node={node} selected={selectedSet.has(node.id)} primary={main?.id === node.id}
                        onPreview={() => setPreview(node)}
                        onToggle={() => setSelectedIds((ids) => selectedSet.has(node.id) ? ids.filter((id) => id !== node.id) : [...ids, node.id])}
                        onPrimary={() => setSelectedIds((ids) => [node.id, ...ids.filter((id) => id !== node.id)])}
                    />)}
                    {!visible.length ? <div className="col-span-full space-y-2 py-12 text-center" style={{ color: theme.node.muted }}>
                        <p className="text-sm">{t(images.length ? "canvas.reversePrompt.noImages" : "canvas.reversePrompt.emptyCanvas")}</p>
                        {!images.length ? <p className="text-xs">{t("canvas.reversePrompt.emptyCanvasHint")}</p> : null}
                    </div> : null}
                </div>
                <p className="text-xs leading-5" style={{ color: theme.node.muted }}>{t("canvas.reversePrompt.selectionHint")}</p>
            </section>
            <section className="min-w-0 space-y-4 md:border-l md:pl-6" style={{ borderColor: theme.node.stroke }}>
                <div className="space-y-2.5">
                    <h3 className="flex items-center gap-2 text-sm font-medium"><Star className="size-3.5" />{t("canvas.reversePrompt.mainView")}</h3>
                    <div className="relative grid h-40 place-items-center overflow-hidden rounded-xl border" style={{ background: theme.canvas.background, borderColor: theme.node.stroke }}>
                        {main ? <button type="button" className="absolute inset-0 size-full p-3 focus-visible:outline-2 focus-visible:-outline-offset-2" onClick={() => setPreview(main)} aria-label={t("canvas.reversePrompt.preview", { name: main.title })}>
                            <img src={main.metadata?.content} alt={main.title} className="size-full object-contain" />
                        </button> : <span className="px-4 text-center text-xs" style={{ color: theme.node.muted }}>{t("canvas.reversePrompt.selectHint")}</span>}
                    </div>
                    {main ? <p className="truncate text-xs" style={{ color: theme.node.muted }} title={main.title}>{main.title}</p> : null}
                    <p className="text-xs leading-5" style={{ color: theme.node.muted }}>{t("canvas.reversePrompt.mainHint")}</p>
                </div>
                <div className="space-y-2">
                    <label htmlFor="reverse-prompt-requirement" className="block text-sm font-medium">{t("canvas.reversePrompt.requirement")}<span className="ml-2 text-xs font-normal" style={{ color: theme.node.muted }}>{t("canvas.reversePrompt.optional")}</span></label>
                    <Input.TextArea id="reverse-prompt-requirement" rows={3} value={requirement} onChange={(event) => setRequirement(event.target.value)} placeholder={t("canvas.reversePrompt.requirementPlaceholder")} />
                </div>
                <div className="space-y-2">
                    <label className="block text-sm font-medium">{t("canvas.reversePrompt.model")}</label>
                    <ModelPicker config={config} value={model} onChange={setModel} capability="text" fullWidth flat className="!rounded-lg" onMissingConfig={() => openConfigDialog(true)} />
                    <p className="text-xs leading-5" style={{ color: theme.node.muted }}>{t("canvas.reversePrompt.modelHint")}</p>
                </div>
            </section>
        </div>
        {preview ? <Image src={preview.metadata?.content} alt={preview.title} styles={{ root: { display: "none" } }} preview={{ open: true, getContainer: false, onOpenChange: (open) => !open && setPreview(null) }} /> : null}
    </Modal>;
}

function ReverseImageCard({ node, selected, primary, onPreview, onToggle, onPrimary }: {
    node: CanvasNodeData;
    selected: boolean;
    primary: boolean;
    onPreview: () => void;
    onToggle: () => void;
    onPrimary: () => void;
}) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const thumbnail = useImagePreview(node.metadata?.storageKey);
    return <div className="min-w-0 overflow-hidden rounded-xl border transition-colors" style={{ borderColor: theme.node.stroke, background: selected ? theme.toolbar.activeBg : "transparent" }}>
        <button type="button" className="group relative block aspect-[4/3] w-full p-2 focus-visible:outline-2 focus-visible:-outline-offset-2" onClick={onPreview} aria-label={t("canvas.reversePrompt.preview", { name: node.title })}>
            <img src={thumbnail || node.metadata?.content} alt={node.title} className="size-full object-contain" loading="lazy" decoding="async" draggable={false} />
            {primary ? <span className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px]" style={{ background: theme.node.panel }}><Star className="size-2.5 fill-current" />{t("canvas.reversePrompt.mainView")}</span> : null}
            <Eye className="absolute right-2 top-2 size-3.5 opacity-0 transition-opacity group-hover:opacity-70 group-focus-visible:opacity-70" />
        </button>
        <p className="truncate px-2 text-[11px]" title={node.title}>{node.title}</p>
        <div className="flex items-center justify-between gap-1 px-1 pb-1 pt-0.5">
            <Button type="text" size="small" icon={selected ? <Check className="size-3" /> : <Plus className="size-3" />} className="!px-1.5 !text-[11px]" aria-pressed={selected} aria-label={t(selected ? "canvas.reversePrompt.remove" : "canvas.reversePrompt.add", { name: node.title })} onClick={onToggle}>{t(selected ? "canvas.reversePrompt.selected" : "canvas.reversePrompt.select")}</Button>
            {selected ? <Tooltip title={t("canvas.reversePrompt.setMain")}><Button type="text" size="small" className="!w-6 !min-w-6 !px-0" aria-label={t("canvas.reversePrompt.setMainNamed", { name: node.title })} aria-pressed={primary} onClick={onPrimary} icon={<Star className={`size-3 ${primary ? "fill-current" : ""}`} />} /></Tooltip> : null}
        </div>
    </div>;
}
