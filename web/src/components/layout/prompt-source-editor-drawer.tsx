import { App, Button, Drawer, Input, Space, Switch } from "antd";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { PromptSource } from "@/services/api/prompt-source-presets";

export function PromptSourceEditorDrawer({ open, source, onSave, onClose }: { open: boolean; source: PromptSource | null; onSave: (source: PromptSource) => void; onClose: () => void }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const [draft, setDraft] = useState<PromptSource | null>(source);

    useEffect(() => {
        if (open && source) setDraft(source);
    }, [open, source]);

    if (!draft) return null;

    const patch = (value: Partial<PromptSource>) => setDraft((current) => (current ? { ...current, ...value } : current));

    const save = () => {
        const name = draft.name.trim();
        const url = draft.url.trim();
        if (!name) return message.warning(t("config.promptSources.editor.nameRequired"));
        if (!isHttpUrl(url)) return message.warning(t("config.promptSources.editor.invalidUrl"));
        if (draft.homepage.trim() && !isHttpUrl(draft.homepage.trim())) return message.warning(t("config.promptSources.editor.invalidHomepage"));
        onSave({ ...draft, name, url, homepage: draft.homepage.trim(), builtIn: false });
        onClose();
    };

    return (
        <Drawer
            open={open}
            size={560}
            title={t(source?.name ? "config.promptSources.editor.editTitle" : "config.promptSources.editor.addTitle")}
            onClose={onClose}
            styles={{ body: { paddingTop: 16 } }}
            extra={
                <Space>
                    <Button onClick={onClose}>{t("common.cancel")}</Button>
                    <Button type="primary" onClick={save}>
                        {t("common.save")}
                    </Button>
                </Space>
            }
        >
            <div className="space-y-5">
                <label className="block">
                    <span className="mb-1.5 block text-sm font-medium">{t("config.promptSources.editor.name")}</span>
                    <Input value={draft.name} onChange={(event) => patch({ name: event.target.value })} placeholder={t("config.promptSources.editor.namePlaceholder")} />
                </label>
                <label className="block">
                    <span className="mb-1.5 block text-sm font-medium">JSON URL</span>
                    <Input value={draft.url} onChange={(event) => patch({ url: event.target.value })} placeholder="https://example.com/prompts.json" />
                </label>
                <label className="block">
                    <span className="mb-1.5 block text-sm font-medium">{t("config.promptSources.editor.homepage")}</span>
                    <Input value={draft.homepage} onChange={(event) => patch({ homepage: event.target.value })} placeholder="https://example.com" />
                </label>
                <div className="flex items-center justify-between border-y border-border py-3">
                    <span className="text-sm font-medium">{t("config.promptSources.editor.enabled")}</span>
                    <Switch checked={draft.enabled} onChange={(enabled) => patch({ enabled })} />
                </div>
                <div>
                    <div className="mb-2 text-sm font-medium">{t("config.promptSources.editor.jsonFormat")}</div>
                    <pre className="whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs leading-5 text-muted-foreground">{`[
  {
    "id": "product-photo-1",
    "title": "Product photo",
    "prompt": "Generate a professional product photo on a white background",
    "description": "",
    "coverUrl": "",
    "referenceImageUrls": [],
    "tags": ["product", "photography"]
  }
]`}</pre>
                </div>
            </div>
        </Drawer>
    );
}

function isHttpUrl(value: string) {
    try {
        return ["http:", "https:"].includes(new URL(value).protocol);
    } catch {
        return false;
    }
}
