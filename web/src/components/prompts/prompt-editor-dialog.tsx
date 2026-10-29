import { useEffect, useState } from "react";
import { Button, Form, Image, Input, Modal, Switch, Tooltip } from "antd";
import { useTranslation } from "react-i18next";
import { ImagePlus, WandSparkles } from "lucide-react";

import { readFileAsDataUrl } from "@/lib/image-utils";
import { createImageThumbnail } from "@/lib/image-thumbnail";
import { requestGeneration, requestImageQuestion } from "@/services/api/image";
import { imageToDataUrl } from "@/services/image-storage";
import type { Prompt } from "@/services/api/prompts";
import type { WorkspacePromptInput } from "@/services/api/workspace-prompts";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";

type PromptForm = Pick<WorkspacePromptInput, "title" | "prompt" | "shared"> & { tagsText: string };

export function PromptEditorDialog({ open, prompt, draft, onClose, onSave, onError }: {
    open: boolean;
    prompt: Prompt | null;
    draft?: { title: string; prompt: string } | null;
    onClose: () => void;
    onSave: (input: WorkspacePromptInput, id?: string) => Promise<void>;
    onError: (error: unknown) => void;
}) {
    const { t } = useTranslation();
    const [form] = Form.useForm<PromptForm>();
    const [saving, setSaving] = useState(false);
    const [generatingImage, setGeneratingImage] = useState(false);
    const [rewriting, setRewriting] = useState(false);
    const [coverDataUrl, setCoverDataUrl] = useState<string | null | undefined>();
    const [coverPreview, setCoverPreview] = useState("");
    const config = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);

    useEffect(() => {
        if (!open) return;
        form.setFieldsValue({ title: prompt?.title || draft?.title || "", prompt: prompt?.prompt || draft?.prompt || "", tagsText: prompt?.tags.join(", ") || "", shared: prompt?.shared || false });
        setCoverDataUrl(undefined);
        setCoverPreview(prompt?.coverUrl || "");
    }, [form, open, prompt, draft]);

    const save = async () => {
        try {
            const values = await form.validateFields();
            setSaving(true);
            await onSave({ title: values.title.trim(), prompt: values.prompt.trim(), description: prompt?.description || "", tags: values.tagsText.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean), shared: values.shared || false, coverDataUrl }, prompt?.id);
        } catch (error) {
            if (!(error && typeof error === "object" && "errorFields" in error)) onError(error);
        } finally {
            setSaving(false);
        }
    };

    const rewrite = async () => {
        const values = form.getFieldsValue();
        const brief = (values.prompt || "").trim();
        if (!brief) return onError(new Error(t("prompts.aiBriefRequired")));
        if (!isAiConfigReady(config, config.textModel)) {
            openConfigDialog(false, "channels");
            return onError(new Error(t("prompts.aiModelRequired")));
        }
        setRewriting(true);
        try {
            const answer = await requestImageQuestion({ ...config, model: config.textModel }, [{ role: "user", content: `${t("prompts.aiRewriteInstruction")}\n\n${brief}` }], () => undefined);
            form.setFieldValue("prompt", answer.trim());
        } catch (error) {
            onError(error);
        } finally {
            setRewriting(false);
        }
    };

    const generateImage = async () => {
        const text = (form.getFieldValue("prompt") || "").trim();
        if (!text) return onError(new Error(t("prompts.aiBriefRequired")));
        if (!isAiConfigReady(config, config.imageModel)) {
            openConfigDialog(false, "channels");
            return onError(new Error(t("prompts.imageModelRequired")));
        }
        setGeneratingImage(true);
        try {
            const images = await requestGeneration({ ...config, model: config.imageModel, count: "1" }, text);
            if (!images[0]) throw new Error(t("prompts.imageMissing"));
            const dataUrl = await imageToDataUrl({ url: images[0].dataUrl });
            const original = await (await fetch(dataUrl)).blob();
            const preview = await createImageThumbnail(original) || original;
            const saved = await readFileAsDataUrl(new File([preview], "prompt-preview", { type: preview.type || original.type }));
            setCoverDataUrl(saved);
            setCoverPreview(saved);
        } catch (error) {
            onError(error);
        } finally {
            setGeneratingImage(false);
        }
    };

    return (
        <Modal title={prompt ? t("prompts.edit") : t("prompts.create")} open={open} onCancel={() => { if (!saving && !generatingImage && !rewriting) onClose(); }} onOk={() => void save()} okText={t("prompts.save")} okButtonProps={{ loading: saving, disabled: generatingImage || rewriting, className: "!shadow-none" }} width={720} destroyOnHidden styles={{ container: { boxShadow: "none", border: "1px solid var(--border)" } }}>
            <Form form={form} layout="vertical" className="pt-3" initialValues={{ shared: false }}>
                <Form.Item name="title" label={t("prompts.promptTitle")} rules={[{ required: true, whitespace: true, message: t("prompts.titleRequired") }]}><Input /></Form.Item>
                <Form.Item name="prompt" label={t("prompts.promptText")} rules={[{ required: true, whitespace: true, message: t("prompts.textRequired") }]}>
                    <Input.TextArea rows={8} placeholder={t("prompts.promptPlaceholder")} />
                </Form.Item>
                <div className="mb-4 flex flex-wrap items-center gap-2">
                    <Button className="!shadow-none" icon={<ImagePlus className="size-4" />} loading={generatingImage} disabled={rewriting} onClick={() => void generateImage()}>{t("prompts.aiGenerateImage")}</Button>
                    <Tooltip title={t("prompts.aiRewrite")}><Button className="!shadow-none" icon={<WandSparkles className="size-4" />} aria-label={t("prompts.aiRewrite")} loading={rewriting} disabled={generatingImage} onClick={() => void rewrite()} /></Tooltip>
                    <span className="text-xs text-muted-foreground">{t("prompts.aiDraftHint")}</span>
                </div>
                {coverPreview ? <div className="mb-4 flex items-end gap-3"><Image src={coverPreview} alt={t("prompts.exampleImage")} className="!h-28 !w-40 rounded-md !object-cover" /><Button type="text" size="small" onClick={() => { setCoverDataUrl(null); setCoverPreview(""); }}>{t("prompts.removeImage")}</Button></div> : null}
                <Form.Item name="tagsText" label={t("prompts.tags")}><Input placeholder={t("prompts.tagsHint")} /></Form.Item>
                <Form.Item name="shared" label={t("prompts.shareWithEveryone")} valuePropName="checked"><Switch /></Form.Item>
                <p className="-mt-4 text-xs text-muted-foreground">{t("prompts.shareHint")}</p>
            </Form>
        </Modal>
    );
}
