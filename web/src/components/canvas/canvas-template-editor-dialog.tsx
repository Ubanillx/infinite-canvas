import { useEffect, useMemo, useState } from "react";
import { App, Button, Checkbox, Form, Input, Modal, Radio, Select } from "antd";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useCanvasTemplateStore } from "@/stores/canvas/use-canvas-template-store";
import { templateSelection, defineTemplateInputs } from "@/lib/canvas/canvas-template";
import { CanvasTemplateGraphPreview } from "@/components/canvas/canvas-template-graph-preview";
import { CanvasNodeType } from "@/types/canvas";
import type { CanvasTemplate, CanvasTemplateContent } from "@/types/canvas-template";

type TemplateValues = { title: string; description?: string };
export type TemplateSource = CanvasTemplateContent & TemplateValues & { selection?: string[]; replacing?: boolean };

export function CanvasTemplateEditorDialog({ source, template, onClose }: { source?: TemplateSource | null; template?: CanvasTemplate | null; onClose: () => void }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const save = useCanvasTemplateStore((state) => state.save);
    const update = useCanvasTemplateStore((state) => state.update);
    const replace = useCanvasTemplateStore((state) => state.replace);
    const templates = useCanvasTemplateStore((state) => state.templates);
    const loadError = useCanvasTemplateStore((state) => state.error);
    const loading = useCanvasTemplateStore((state) => state.loading);
    const [includeDependencies, setIncludeDependencies] = useState(true);
    const [slots, setSlots] = useState<Record<string, { name: string; description: string; required: boolean } | null>>({});
    const [targetId, setTargetId] = useState("");
    const [confirmed, setConfirmed] = useState(false);
    const [inputsOpen, setInputsOpen] = useState(false);
    useEffect(() => {
        setIncludeDependencies(true); setTargetId(""); setConfirmed(false);
        setInputsOpen(Boolean(source?.nodes.some((node) => node.metadata?.templateInput)));
        setSlots(Object.fromEntries((source?.nodes || []).filter((node) => node.metadata?.templateInput).map((node) => [node.id, { ...node.metadata!.templateInput! }])));
        if (source?.replacing) void useCanvasTemplateStore.getState().load().catch(() => undefined);
    }, [source]);
    const selection = useMemo(() => {
        if (!source) return null;
        try { return source.selection ? templateSelection(source, source.selection, includeDependencies) : { content: structuredClone(source), externalCount: 0, referenceCount: source.nodes.reduce((count, node) => count + (node.metadata?.references?.length || 0), 0) }; }
        catch { return null; }
    }, [source, includeDependencies]);
    const [form] = Form.useForm<TemplateValues>();
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const content = useMemo(() => selection && source ? defineTemplateInputs(selection.content, slots, source) : null, [selection, slots, source]);
    const inputNodes = selection?.content.nodes.filter((node) => node.type === CanvasNodeType.Text || node.type === CanvasNodeType.Image) || [];
    const inputCount = content?.nodes.filter((node) => node.metadata?.templateInput).length || 0;
    const invalidInput = content?.nodes.some((node) => node.metadata?.templateInput && !node.metadata.templateInput.name);
    const submit = async (values: TemplateValues) => {
        if (saving || (!source && !template)) return;
        setSaving(true);
        setError("");
        try {
            if (template) await update(template.id, values.title, values.description || "");
            else {
                if (!selection) throw new Error(t("canvas.templates.v2.dependenciesRequired"));
                const content = defineTemplateInputs(selection.content, slots, source!);
                if (content.nodes.some((node) => node.metadata?.templateInput && !node.metadata.templateInput.name)) throw new Error(t("canvas.templates.v2.inputNameRequired"));
                if (source?.replacing) {
                    if (!targetId || !confirmed) throw new Error(t("canvas.templates.v2.confirmUpdate"));
                    await replace(targetId, content, values.title, values.description || "");
                } else await save(content, values.title, values.description || "");
            }
            message.success(t("canvas.templates.saved"));
            onClose();
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : t("canvas.templates.saveFailed"));
        } finally {
            setSaving(false);
        }
    };
    return <Modal title={t(template ? "canvas.templates.edit" : source?.replacing ? "canvas.templates.v2.update" : "canvas.templates.save")} open={Boolean(source || template)} onCancel={() => { if (!saving) onClose(); }} closable={!saving} keyboard={!saving} mask={{ closable: !saving }} centered destroyOnHidden width={source ? "min(1120px, calc(100vw - 32px))" : 600} styles={{ container: { boxShadow: "none", border: "1px solid var(--border)" }, body: { maxHeight: "74dvh", overflowY: "auto" } }} afterClose={() => { form.resetFields(); setError(""); }} footer={
        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border pt-4">
            {error ? <p role="alert" className="min-w-0 flex-1 text-left text-sm text-destructive">{error}</p> : null}
            <Button disabled={saving} onClick={onClose}>{t("common.cancel")}</Button>
            <Button type="primary" loading={saving} disabled={Boolean(source && (!content || invalidInput || (source.replacing && (!targetId || !confirmed))))} onClick={() => form.submit()}>{t(source?.replacing ? "canvas.templates.editor.updateAction" : template ? "common.save" : "canvas.templates.editor.saveAction")}</Button>
        </div>
    }>
        {source || template ? <Form form={form} layout="vertical" initialValues={{ title: template?.title || source?.title, description: template?.description || source?.description }} clearOnDestroy disabled={saving} scrollToFirstError={{ focus: true }} onFinish={(values) => void submit(values)} className={source ? "grid items-start gap-6 pt-3 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.25fr)]" : "pt-3"}>
            <div className="min-w-0">
                {source?.replacing ? <section className="mb-6 space-y-3 border-b border-border pb-5">
                    <label className="block text-sm font-medium" htmlFor="template-update-target">{t("canvas.templates.v2.updateTarget")}</label>
                    <Select id="template-update-target" className="w-full" loading={loading} value={targetId || undefined} placeholder={t("canvas.templates.choose")} options={templates.map((item) => ({ value: item.id, label: item.title }))} onChange={(value) => { setTargetId(value); setConfirmed(false); const target = templates.find((item) => item.id === value); if (target) form.setFieldsValue({ title: target.title, description: target.description }); }} />
                    {loadError ? <div role="alert" className="flex flex-wrap items-center gap-2 text-sm"><span>{loadError}</span><Button size="small" onClick={() => void useCanvasTemplateStore.getState().load().catch(() => undefined)}>{t("canvas.templates.retry")}</Button></div> : null}
                    <p className="text-xs leading-5 text-muted-foreground">{t("canvas.templates.editor.replaceHint")}</p>
                    <Checkbox checked={confirmed} disabled={saving || !targetId} onChange={(event) => setConfirmed(event.target.checked)}>{t("canvas.templates.v2.confirmUpdate")}</Checkbox>
                </section> : null}
                <Form.Item name="title" label={t("canvas.templates.name")} rules={[{ required: true, whitespace: true, message: t("canvas.templates.nameRequired") }]}><Input autoFocus placeholder={t("canvas.templates.editor.namePlaceholder")} /></Form.Item>
                <Form.Item name="description" label={t("canvas.createDialog.description")}><Input.TextArea rows={3} placeholder={t("canvas.templates.editor.descriptionPlaceholder")} /></Form.Item>
                {source?.selection && Boolean(selection?.externalCount || !includeDependencies) ? <section className="mb-5 border-t border-border pt-5">
                    <h3 className="mb-3 text-sm font-medium">{t("canvas.templates.v2.selectionDependencies")}</h3>
                    <Radio.Group value={includeDependencies} disabled={saving} onChange={(event) => setIncludeDependencies(event.target.value)} className="flex flex-col gap-3">
                        <Radio value={true}>{t("canvas.templates.v2.includeDependencies")}</Radio>
                        <Radio value={false}>{t("canvas.templates.v2.pendingDependencies")}</Radio>
                    </Radio.Group>
                </section> : null}
                {source && inputNodes.length ? <section className="border-t border-border pt-4">
                    <button type="button" className="flex w-full items-center justify-between gap-3 py-1 text-left focus-visible:outline-2 focus-visible:outline-offset-2" aria-expanded={inputsOpen} aria-controls="template-input-settings" onClick={() => setInputsOpen((value) => !value)}>
                        <span className="text-sm font-medium">{t("canvas.templates.editor.inputs")}<span className="ml-2 text-xs font-normal text-muted-foreground">{inputCount ? t("canvas.templates.editor.inputCount", { count: inputCount }) : t("canvas.templates.editor.optional")}</span></span>
                        <ChevronDown className={`size-4 text-muted-foreground transition-transform ${inputsOpen ? "rotate-180" : ""}`} />
                    </button>
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">{t("canvas.templates.editor.inputsHint")}</p>
                    {inputsOpen ? <div id="template-input-settings" className="mt-4 space-y-3">{inputNodes.map((node) => {
                        const slot = node.id in slots ? slots[node.id] : node.metadata?.templateInput;
                        const change = (patch: Partial<NonNullable<typeof slot>>) => setSlots((previous) => ({ ...previous, [node.id]: { ...slot!, ...patch } }));
                        return <div key={node.id} className="rounded-lg border border-border p-3">
                            <Checkbox aria-label={node.title} disabled={saving || Boolean(node.metadata?.templateInput && source.selection && !includeDependencies)} checked={Boolean(slot)} onChange={(event) => setSlots((previous) => ({ ...previous, [node.id]: event.target.checked ? { name: node.title, description: "", required: true } : null }))}><span className="break-words">{node.title}</span><span className="ml-2 text-xs text-muted-foreground">{t(`canvas.nodeTypes.${node.type}`)}</span></Checkbox>
                            {slot ? <div className="mt-3 space-y-3 border-t border-border pt-3">
                                <label className="block text-xs text-muted-foreground">{t("canvas.templates.v2.inputName")}<Input className="mt-1" value={slot.name} status={slot.name.trim() ? undefined : "error"} onChange={(event) => change({ name: event.target.value })} /></label>
                                {!slot.name.trim() ? <p className="text-xs text-destructive">{t("canvas.templates.v2.inputNameRequired")}</p> : null}
                                <Input aria-label={t("canvas.templates.v2.inputDescription")} placeholder={t("canvas.templates.v2.inputDescription")} value={slot.description} onChange={(event) => change({ description: event.target.value })} />
                                <Checkbox checked={slot.required} onChange={(event) => change({ required: event.target.checked })}>{t("canvas.templates.v2.required")}</Checkbox>
                            </div> : null}
                        </div>;
                    })}</div> : null}
                </section> : null}
            </div>
            {source ? <section className="min-w-0 lg:sticky lg:top-0 lg:border-l lg:border-border lg:pl-6">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-medium">{t("canvas.templates.editor.preview")}</h3>
                    <span className="text-xs text-muted-foreground">{t(source.selection ? "canvas.templates.editor.selection" : "canvas.templates.editor.whole")}</span>
                </div>
                {content ? <>
                    <p className="mb-4 text-xs text-muted-foreground">{t("canvas.project.stats", { nodes: content.nodes.length, connections: content.connections.length })}{inputCount ? ` · ${t("canvas.templates.editor.inputCount", { count: inputCount })}` : ""}</p>
                    <CanvasTemplateGraphPreview content={content} viewportClassName="h-[46dvh] min-h-64" />
                </> : <p role="alert" className="py-12 text-sm text-muted-foreground">{t("canvas.templates.v2.dependenciesRequired")}</p>}
            </section> : null}
        </Form> : null}
    </Modal>;
}
