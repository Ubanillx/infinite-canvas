import { useEffect, useMemo, useState } from "react";
import { App, Button, Input } from "antd";
import { Check, LayoutTemplate, Pencil, Search, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { CanvasTemplateEditorDialog } from "@/components/canvas/canvas-template-editor-dialog";
import { CanvasTemplateCover, CanvasTemplatePreviewDialog } from "@/components/canvas/canvas-template-preview";
import { getActiveWorkspace } from "@/lib/workspace";
import { useCanvasTemplateStore } from "@/stores/canvas/use-canvas-template-store";
import type { CanvasTemplate } from "@/types/canvas-template";

export function CanvasTemplateGallery({ selectedId, onSelect, manage = false, disabled = false, fullPage = false }: { selectedId?: string; onSelect: (template: CanvasTemplate) => void; manage?: boolean; disabled?: boolean; fullPage?: boolean }) {
    const { t } = useTranslation();
    const { message, modal } = App.useApp();
    const templates = useCanvasTemplateStore((state) => state.templates);
    const loaded = useCanvasTemplateStore((state) => state.loaded);
    const loading = useCanvasTemplateStore((state) => state.loading);
    const error = useCanvasTemplateStore((state) => state.error);
    const load = useCanvasTemplateStore((state) => state.load);
    const remove = useCanvasTemplateStore((state) => state.remove);
    const [keyword, setKeyword] = useState("");
    const [preview, setPreview] = useState<CanvasTemplate | null>(null);
    const [editing, setEditing] = useState<CanvasTemplate | null>(null);
    const [busyId, setBusyId] = useState("");
    const readOnly = getActiveWorkspace()?.role === "viewer";
    const matches = useMemo(() => {
        const query = keyword.trim().toLocaleLowerCase();
        return templates.filter((template) => `${template.title}\n${template.description}`.toLocaleLowerCase().includes(query));
    }, [keyword, templates]);
    useEffect(() => { void load().catch(() => undefined); }, [load]);
    const deleteTemplate = (template: CanvasTemplate) => modal.confirm({
        title: t("canvas.templates.deleteTitle", { name: template.title }),
        content: t("canvas.templates.deleteHint"),
        okText: t("common.delete"), cancelText: t("common.cancel"), okButtonProps: { danger: true },
        onOk: async () => {
            setBusyId(template.id);
            try {
                await remove(template.id);
                message.success(t("canvas.templates.deleted"));
            } catch (reason) {
                message.error(reason instanceof Error ? reason.message : t("canvas.templates.saveFailed"));
                throw reason;
            } finally { setBusyId(""); }
        },
    });
    return <>
        <div className={fullPage ? "mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-5" : "mb-4 flex flex-wrap items-center justify-between gap-3"}>
            {fullPage ? <span className="text-sm text-muted-foreground">{t("canvas.templates.count", { count: templates.length })}</span> : null}
            <Input className={fullPage ? "app-search-input w-full sm:!ml-auto sm:!w-[min(26rem,100%)]" : "app-search-input w-full sm:!w-72"} prefix={<Search className="size-4 text-muted-foreground" />} value={keyword} allowClear placeholder={t("canvas.templates.search")} aria-label={t("canvas.templates.search")} onChange={(event) => setKeyword(event.target.value)} />
            {!fullPage ? <span className="text-xs text-muted-foreground">{t("canvas.templates.count", { count: templates.length })}</span> : null}
        </div>
        {loading ? <p role="status" className="py-12 text-center text-sm text-muted-foreground">{t("canvas.loading")}</p> : error ? <div role="alert" className="py-8 text-center"><p className="mb-4 text-sm text-red-500">{error}</p><Button onClick={() => void load().catch(() => undefined)}>{t("canvas.templates.retry")}</Button></div> : loaded && !matches.length ? <div className="flex flex-col items-center gap-3 py-12 text-center text-muted-foreground"><LayoutTemplate className="size-9 opacity-50" /><p className="text-sm">{t(keyword.trim() ? "canvas.templates.noMatches" : "canvas.templates.empty")}</p><p className="max-w-md text-xs leading-5">{t("canvas.templates.emptyHint")}</p></div> : <div className={fullPage ? "grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5" : "grid max-h-[45dvh] grid-cols-1 gap-4 overflow-y-auto p-1 sm:grid-cols-2 lg:grid-cols-3"}>
            {matches.map((template) => <article key={template.id} className={`min-w-0 overflow-hidden rounded-lg border bg-card ${selectedId === template.id ? "border-foreground/50" : "border-border"}`}>
                <button type="button" disabled={disabled} className="block w-full cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2" aria-label={t("canvas.templates.previewNamed", { name: template.title })} onClick={() => setPreview(template)}><CanvasTemplateCover template={template} /></button>
                <div className="p-3">
                    <h3 className="truncate text-sm font-medium" title={template.title}>{template.title}</h3>
                    <p className="mt-1 line-clamp-2 min-h-10 whitespace-pre-line text-xs leading-5 text-muted-foreground">{template.description || t("canvas.project.noDescription")}</p>
                    <p className="mt-2 text-xs text-muted-foreground">{t("canvas.project.stats", { nodes: template.content.nodes.length, connections: template.content.connections.length })}</p>
                    <div className="mt-3 flex items-center justify-between gap-1">
                        <Button type="text" size="small" disabled={disabled || Boolean(busyId) || readOnly} icon={selectedId === template.id ? <Check className="size-3.5" /> : undefined} onClick={() => onSelect(template)}>{t(selectedId === template.id ? "canvas.templates.selected" : "canvas.templates.use")}</Button>
                        {manage && !readOnly ? <div className="flex gap-1"><Button type="text" size="small" disabled={Boolean(busyId)} icon={<Pencil className="size-3.5" />} aria-label={t("canvas.templates.editNamed", { name: template.title })} onClick={() => setEditing(template)} /><Button type="text" size="small" danger loading={busyId === template.id} icon={<Trash2 className="size-3.5" />} aria-label={t("canvas.templates.deleteTitle", { name: template.title })} onClick={() => deleteTemplate(template)} /></div> : null}
                    </div>
                </div>
            </article>)}
        </div>}
        <CanvasTemplatePreviewDialog template={preview} onClose={() => setPreview(null)} onUse={disabled || readOnly ? undefined : (template) => { setPreview(null); onSelect(template); }} />
        <CanvasTemplateEditorDialog template={editing} onClose={() => setEditing(null)} />
    </>;
}
