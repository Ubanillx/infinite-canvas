import { useState } from "react";
import { Button, Modal } from "antd";
import { useTranslation } from "react-i18next";

import { CanvasTemplateGallery } from "@/components/canvas/canvas-template-library";
import { CanvasTemplateUseFields, useCanvasTemplateOptions } from "@/components/canvas/canvas-template-use-fields";
import type { CanvasTemplate, CanvasTemplateContent } from "@/types/canvas-template";

export function CanvasTemplateInsertDialog({ onClose, onInsert, onCreate }: { onClose: () => void; onInsert: (content: CanvasTemplateContent) => Promise<void>; onCreate: (templateId: string) => void }) {
    const { t } = useTranslation();
    const [template, setTemplate] = useState<CanvasTemplate>();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const options = useCanvasTemplateOptions(template?.content);
    const insert = async () => {
        if (busy) return;
        setBusy(true); setError("");
        try { await onInsert(await options.prepare()); onClose(); }
        catch (reason) { setError(reason instanceof Error ? reason.message : t("canvas.templates.createFailed")); }
        finally { setBusy(false); }
    };
    return <Modal open title={t("canvas.templates.library")} onCancel={() => { if (!busy) onClose(); }} width={1000} footer={null} closable={!busy} keyboard={!busy} mask={{ closable: !busy }} styles={{ body: { maxHeight: "72dvh", overflowY: "auto" } }}>
        <CanvasTemplateGallery selectedId={template?.id} disabled={busy} onSelect={(value) => { setTemplate(value); setError(""); }} />
        {template ? <div className="mt-5 border-t border-border pt-5"><h3 className="mb-3 font-medium">{template.title}</h3><CanvasTemplateUseFields options={options} disabled={busy} />{error ? <p role="alert" className="mb-4">{error}</p> : null}<div className="flex flex-wrap justify-end gap-2"><Button disabled={busy} onClick={onClose}>{t("common.cancel")}</Button><Button disabled={busy || options.blocked} onClick={() => onCreate(template.id)}>{t("canvas.templates.v2.newCanvas")}</Button><Button type="primary" aria-label={t("canvas.templates.v2.insert")} loading={busy} disabled={options.blocked} onClick={() => void insert()}>{t("canvas.templates.v2.insert")}</Button></div></div> : null}
    </Modal>;
}
