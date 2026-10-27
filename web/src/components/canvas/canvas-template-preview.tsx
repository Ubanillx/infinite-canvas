import { useEffect, useState } from "react";
import { Button, Modal } from "antd";
import { LayoutTemplate } from "lucide-react";
import { useTranslation } from "react-i18next";

import { resolveImageUrl } from "@/services/image-storage";
import { CanvasTemplateGraphPreview } from "@/components/canvas/canvas-template-graph-preview";
import type { CanvasTemplate } from "@/types/canvas-template";

export function CanvasTemplateCover({ template, className = "" }: { template: CanvasTemplate; className?: string }) {
    const { t } = useTranslation();
    const [url, setUrl] = useState("");
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        let active = true;
        setUrl("");
        setFailed(false);
        void resolveImageUrl(template.cover.storageKey).then((value) => {
            if (!active) return;
            setUrl(value);
            setFailed(!value);
        }).catch(() => { if (active) setFailed(true); });
        return () => { active = false; };
    }, [template.cover.storageKey]);
    return <div className={`flex aspect-[4/3] items-center justify-center overflow-hidden bg-background ${className}`}>
        {url ? <img src={url} alt={t("canvas.templates.coverAlt", { name: template.title })} className="size-full object-contain" loading="lazy" onError={() => { setUrl(""); setFailed(true); }} /> : <div className="flex flex-col items-center gap-2 p-3 text-xs text-muted-foreground"><LayoutTemplate className="size-7 opacity-50" /><span>{t(failed ? "canvas.templates.coverUnavailable" : "canvas.templates.loadingCover")}</span></div>}
    </div>;
}

export function CanvasTemplatePreviewDialog({ template, onClose, onUse }: { template: CanvasTemplate | null; onClose: () => void; onUse?: (template: CanvasTemplate) => void }) {
    const { t } = useTranslation();
    return <Modal title={template?.title} open={Boolean(template)} onCancel={onClose} width={920} destroyOnHidden styles={{ body: { maxHeight: "70dvh", overflowY: "auto" } }} footer={<>
        <Button onClick={onClose}>{t("canvas.templates.close")}</Button>
        {template && onUse ? <Button type="primary" onClick={() => onUse(template)}>{t("canvas.templates.use")}</Button> : null}
    </>}>
        {template ? <>
            <CanvasTemplateGraphPreview key={template.id} content={template.content} />
            <p className="mt-4 whitespace-pre-wrap break-words text-sm text-muted-foreground">{template.description || t("canvas.project.noDescription")}</p>
            <p className="mt-3 text-xs text-muted-foreground">{t("canvas.project.stats", { nodes: template.content.nodes.length, connections: template.content.connections.length })}</p>
            <p className="mt-2 text-xs text-muted-foreground">{t("canvas.templates.independent")}</p>
        </> : null}
    </Modal>;
}
