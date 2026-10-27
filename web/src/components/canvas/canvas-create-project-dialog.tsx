import { useEffect, useRef, useState } from "react";
import { Button, Form, Input, Modal } from "antd";
import { useTranslation } from "react-i18next";

import { CanvasTemplateGallery } from "@/components/canvas/canvas-template-library";
import { CanvasTemplateUseFields, useCanvasTemplateOptions } from "@/components/canvas/canvas-template-use-fields";
import { getActiveWorkspace } from "@/lib/workspace";
import { copyCanvasTemplateContent } from "@/services/canvas-templates";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useCanvasTemplateStore } from "@/stores/canvas/use-canvas-template-store";
import type { CanvasTemplate } from "@/types/canvas-template";

type CreateProjectValues = { title: string; description?: string };

export function CanvasCreateProjectDialog({ open, folderId = null, initialTemplateId, onCancel, onCreated }: { open: boolean; folderId?: string | null; initialTemplateId?: string; onCancel: () => void; onCreated: (id: string) => void }) {
    const { t } = useTranslation();
    const [form] = Form.useForm<CreateProjectValues>();
    const createProject = useCanvasStore((state) => state.createProject);
    const createProjectFromTemplate = useCanvasStore((state) => state.createProjectFromTemplate);
    const [mode, setMode] = useState<"blank" | "template">("blank");
    const [templateId, setTemplateId] = useState("");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const templates = useCanvasTemplateStore((state) => state.templates);
    const selectedTemplate = templates.find((item) => item.id === templateId);
    const options = useCanvasTemplateOptions(selectedTemplate?.content);
    const activeRef = useRef(false);
    useEffect(() => { activeRef.current = open; return () => { activeRef.current = false; }; }, [open]);
    useEffect(() => {
        if (!open) return;
        setMode(initialTemplateId ? "template" : "blank");
        setTemplateId(initialTemplateId || "");
        setError("");
        form.resetFields();
        const template = useCanvasTemplateStore.getState().templates.find((item) => item.id === initialTemplateId);
        if (template) form.setFieldsValue({ title: template.title, description: template.description });
    }, [form, initialTemplateId, open]);
    const cancel = () => {
        if (saving) return;
        form.resetFields();
        onCancel();
    };
    const create = async (values: CreateProjectValues) => {
        if (saving) return;
        setError("");
        if (mode === "blank") {
            const id = createProject(values.title.trim(), folderId, values.description?.trim() || "");
            form.resetFields();
            onCreated(id);
            return;
        }
        const template = useCanvasTemplateStore.getState().templates.find((item) => item.id === templateId);
        if (!template) { setError(t("canvas.templates.choose")); return; }
        setSaving(true);
        try {
            const workspaceId = getActiveWorkspace()?.id;
            if (!workspaceId) throw new Error(t("canvas.templates.workspaceChanged"));
            const prepared = await options.prepare();
            if (!activeRef.current) return;
            const content = await copyCanvasTemplateContent(prepared, workspaceId);
            if (!activeRef.current) return;
            const id = await createProjectFromTemplate(content, values.title.trim(), values.description?.trim() || "", folderId);
            if (!activeRef.current) return;
            form.resetFields();
            onCreated(id);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : t("canvas.templates.createFailed"));
        } finally { setSaving(false); }
    };
    const selectTemplate = (template: CanvasTemplate) => {
        setTemplateId(template.id);
        setError("");
        form.setFieldsValue({ title: template.title, description: template.description });
    };

    return <Modal title={t("canvas.create")} open={open} onCancel={cancel} footer={null} destroyOnHidden width={mode === "template" ? 1000 : 520} closable={!saving} keyboard={!saving} mask={{ closable: !saving }} styles={{ body: { maxHeight: "74dvh", overflowY: "auto" } }}>
        <div role="group" aria-label={t("canvas.templates.createMode")} className="mb-5 flex gap-5 border-b border-border">
            {(["blank", "template"] as const).map((value) => <button key={value} type="button" aria-pressed={mode === value} disabled={saving} onClick={() => { setMode(value); setError(""); }} className={`border-b-2 px-1 pb-3 text-sm transition-colors focus-visible:outline-2 ${mode === value ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>{t(value === "blank" ? "canvas.templates.blank" : "canvas.templates.fromTemplate")}</button>)}
        </div>
        {mode === "template" ? <div className="mb-5"><CanvasTemplateGallery selectedId={templateId} onSelect={selectTemplate} disabled={saving} /><p className="mt-3 text-xs leading-5 text-muted-foreground">{t("canvas.templates.independent")}</p></div> : null}
        <Form form={form} layout="vertical" onFinish={(values) => void create(values)} clearOnDestroy disabled={saving}>
            {mode === "template" && selectedTemplate ? <CanvasTemplateUseFields options={options} disabled={saving} /> : null}
            <Form.Item name="title" label={t("canvas.createDialog.name")} rules={[{ required: true, whitespace: true, message: t("canvas.createDialog.nameRequired") }]}>
                <Input autoFocus />
            </Form.Item>
            <Form.Item name="description" label={t("canvas.createDialog.description")}>
                <Input.TextArea rows={3} />
            </Form.Item>
            {error ? <p role="alert" className="mb-4 text-sm text-red-500">{error}</p> : null}
            <div className="flex justify-end gap-2">
                <Button disabled={saving} onClick={cancel}>{t("common.cancel")}</Button>
                <Button type="primary" htmlType="submit" loading={saving} disabled={mode === "template" && (!templateId || options.blocked)}>{t("canvas.create")}</Button>
            </div>
        </Form>
    </Modal>;
}
