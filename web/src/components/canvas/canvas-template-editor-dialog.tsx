import { useEffect, useMemo, useState } from "react";
import { App, Button, Form, Input, Modal } from "antd";
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
    const [includeDependencies, setIncludeDependencies] = useState(true);
    const [slots, setSlots] = useState<Record<string, { name: string; description: string; required: boolean } | null>>({});
    const [targetId, setTargetId] = useState("");
    const [confirmed, setConfirmed] = useState(false);
    useEffect(() => {
        setIncludeDependencies(true); setTargetId(""); setConfirmed(false);
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
    return <Modal title={t(template ? "canvas.templates.edit" : source?.replacing ? "canvas.templates.v2.update" : "canvas.templates.save")} open={Boolean(source || template)} onCancel={() => { if (!saving) onClose(); }} closable={!saving} keyboard={!saving} mask={{ closable: !saving }} footer={null} destroyOnHidden width={640} styles={{ body: { maxHeight: "70dvh", overflowY: "auto" } }} afterClose={() => { form.resetFields(); setError(""); }}>
        {source || template ? <Form form={form} layout="vertical" initialValues={{ title: template?.title || source?.title, description: template?.description || source?.description }} clearOnDestroy disabled={saving} onFinish={(values) => void submit(values)}>
            {!template ? <p className="mb-5 text-sm leading-6 text-muted-foreground">{t("canvas.templates.saveHint")}</p> : null}
            <Form.Item name="title" label={t("canvas.templates.name")} rules={[{ required: true, whitespace: true, message: t("canvas.templates.nameRequired") }]}><Input autoFocus /></Form.Item>
            <Form.Item name="description" label={t("canvas.createDialog.description")}><Input.TextArea rows={3} /></Form.Item>
            {source ? <div className="mb-5 space-y-4 text-sm">
                {source.replacing && loadError ? <div role="alert" className="space-y-2"><p>{loadError}</p><Button onClick={() => void useCanvasTemplateStore.getState().load().catch(() => undefined)}>{t("canvas.templates.retry")}</Button></div> : null}
                {source.selection ? <fieldset className="space-y-2"><legend className="mb-2 font-medium">{t("canvas.templates.v2.selectionDependencies")}</legend><label className="flex gap-2"><input type="radio" checked={includeDependencies} onChange={() => setIncludeDependencies(true)} disabled={saving} />{t("canvas.templates.v2.includeDependencies")}</label><label className="flex gap-2"><input type="radio" checked={!includeDependencies} onChange={() => setIncludeDependencies(false)} disabled={saving} />{t("canvas.templates.v2.pendingDependencies")}</label><p className="text-xs text-muted-foreground">{t("canvas.templates.v2.selectionHint")}</p></fieldset> : null}
                {selection ? <p className="text-xs text-muted-foreground">{t("canvas.templates.v2.scope", { nodes: selection.content.nodes.length, connections: selection.content.connections.length, dependencies: selection.externalCount, references: selection.referenceCount })}</p> : <p role="alert">{t("canvas.templates.v2.dependenciesRequired")}</p>}
                {selection ? <details><summary className="cursor-pointer">{t("canvas.templates.v2.readOnlyPreview")}</summary><CanvasTemplateGraphPreview content={defineTemplateInputs(selection.content, slots, source)} /></details> : null}
                <details><summary className="cursor-pointer font-medium">{t("canvas.templates.v2.defineInputs")}</summary><p className="my-2 text-xs text-muted-foreground">{t("canvas.templates.v2.defineInputsHint")}</p><div className="space-y-3">{selection?.content.nodes.filter((node) => node.type === CanvasNodeType.Text || node.type === CanvasNodeType.Image).map((node) => {
                    const slot = node.id in slots ? slots[node.id] : node.metadata?.templateInput;
                    const change = (patch: Partial<NonNullable<typeof slot>>) => setSlots((previous) => ({ ...previous, [node.id]: { ...slot!, ...patch } }));
                    return <div key={node.id} className="space-y-2 border-b border-border pb-3"><label className="flex gap-2"><input type="checkbox" disabled={saving || Boolean(node.metadata?.templateInput && source.selection && !includeDependencies)} checked={Boolean(slot)} onChange={(event) => setSlots((previous) => ({ ...previous, [node.id]: event.target.checked ? { name: node.title, description: "", required: true } : null }))} />{node.title}</label>{slot ? <><Input aria-label={t("canvas.templates.v2.inputName")} value={slot.name} onChange={(event) => change({ name: event.target.value })} /><Input aria-label={t("canvas.templates.v2.inputDescription")} placeholder={t("canvas.templates.v2.inputDescription")} value={slot.description} onChange={(event) => change({ description: event.target.value })} /><label className="flex gap-2 text-xs"><input type="checkbox" checked={slot.required} onChange={(event) => change({ required: event.target.checked })} />{t("canvas.templates.v2.required")}</label></> : null}</div>;
                })}</div></details>
                {source.replacing ? <div className="space-y-3"><label className="block">{t("canvas.templates.v2.updateTarget")}<select className="mt-2 w-full rounded border border-border bg-background p-2" aria-label={t("canvas.templates.v2.updateTarget")} disabled={saving} value={targetId} onChange={(event) => { setTargetId(event.target.value); setConfirmed(false); const target = templates.find((item) => item.id === event.target.value); if (target) form.setFieldsValue({ title: target.title, description: target.description }); }}><option value="">{t("canvas.templates.choose")}</option>{templates.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><p className="text-xs text-muted-foreground">{t("canvas.templates.v2.updateHint")}</p><label className="flex gap-2"><input type="checkbox" checked={confirmed} disabled={saving || !targetId} onChange={(event) => setConfirmed(event.target.checked)} />{t("canvas.templates.v2.confirmUpdate")}</label></div> : null}
            </div> : null}
            {error ? <p role="alert" className="mb-4 text-sm text-red-500">{error}</p> : null}
            <div className="flex justify-end gap-2"><Button disabled={saving} onClick={onClose}>{t("common.cancel")}</Button><Button type="primary" htmlType="submit" loading={saving}>{t("common.save")}</Button></div>
        </Form> : null}
    </Modal>;
}
