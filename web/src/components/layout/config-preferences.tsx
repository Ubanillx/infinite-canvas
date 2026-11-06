import { App, Button, Form, Input, Radio, Select, Switch } from "antd";
import { Info, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ModelPicker } from "@/components/model-picker";
import { videoResolutionOptions } from "@/components/video-settings-panel";
import { audioFormatOptions, audioVoiceOptions, normalizeAudioSpeedValue } from "@/lib/audio-generation";
import { computeMediaSize, inferMediaRatio, inferMediaScale, mediaScaleOptions, parseVideoResolution } from "@/lib/media-size";
import { getUserPreferenceOverrideCount, resetUserPreferences, waitForUserPreferencesSave } from "@/services/user-preferences";
import { useConfigStore, type AiConfig, type ModelCapability } from "@/stores/use-config-store";

type ModelGroup = {
    capability: ModelCapability;
    modelKey: "imageModel" | "videoModel" | "textModel" | "audioModel";
    labelKey: string;
};

const modelGroups: ModelGroup[] = [
    { capability: "image", modelKey: "imageModel", labelKey: "config.preferences.defaultImageModel" },
    { capability: "video", modelKey: "videoModel", labelKey: "config.preferences.defaultVideoModel" },
    { capability: "text", modelKey: "textModel", labelKey: "config.preferences.defaultTextModel" },
    { capability: "audio", modelKey: "audioModel", labelKey: "config.preferences.defaultAudioModel" },
];

export function ConfigPreferencesForm({ mode }: { mode: "defaults" | "personal" }) {
    const { message, modal } = App.useApp();
    const { t } = useTranslation();
    const config = useConfigStore((state) => state.config);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const imageResolutionOptions = mediaScaleOptions.map((value) => ({ value, label: value === "auto" ? t("settingsPanels.common.auto") : value.toUpperCase() }));
    const overrideCount = mode === "personal" ? getUserPreferenceOverrideCount(config) : 0;

    const resetPreferences = () => {
        modal.confirm({
            title: t("config.personalPreferences.resetTitle"),
            content: t("config.personalPreferences.resetDescription"),
            okText: t("config.personalPreferences.reset"),
            cancelText: t("common.cancel"),
            onOk: async () => {
                resetUserPreferences();
                try {
                    await waitForUserPreferencesSave();
                    message.success(t("config.personalPreferences.resetDone"));
                } catch (error) {
                    message.error(error instanceof Error ? error.message : t("config.personalPreferences.saveFailed"));
                }
            },
        });
    };

    return (
        <div className="space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border bg-muted/30 px-4 py-3">
                <div className="flex min-w-0 items-start gap-2">
                    <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 text-xs leading-5 text-muted-foreground">
                        <p>{t(mode === "personal" ? "config.personalPreferences.notice" : "config.defaultPreferences.notice")}</p>
                        {mode === "personal" ? <p className="mt-0.5">{t(overrideCount ? "config.personalPreferences.customized" : "config.personalPreferences.defaultsActive", { count: overrideCount })}</p> : null}
                    </div>
                </div>
                {mode === "personal" && overrideCount ? <Button size="small" icon={<RotateCcw className="size-3.5" />} onClick={resetPreferences}>{t("config.personalPreferences.reset")}</Button> : null}
            </div>
            <Form layout="vertical" requiredMark={false} className="space-y-5">
                <section className="rounded-xl border border-border p-5">
                    <h2 className="mb-4 text-sm font-semibold">{t("config.preferences.defaultModels")}</h2>
                    <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
                        {modelGroups.map((group) => (
                            <Form.Item key={group.modelKey} label={t(group.labelKey)} className="mb-0">
                                <ModelPicker config={config} value={config[group.modelKey]} onChange={(model) => updateConfig(group.modelKey, model)} capability={group.capability} fullWidth onMissingConfig={mode === "personal" ? () => message.info(t("config.personalPreferences.noModels")) : undefined} />
                            </Form.Item>
                        ))}
                    </div>
                </section>
                <section className="rounded-xl border border-border p-5">
                    <h2 className="mb-4 text-sm font-semibold">{t("config.preferences.generation")}</h2>
                    <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
                        <Form.Item label={t("config.preferences.canvasImageCount")} extra={t("config.preferences.canvasImageCountDescription")} className="mb-0">
                            <Input type="number" min={1} max={15} value={config.canvasImageCount} onChange={(event) => updateConfig("canvasImageCount", event.target.value)} onBlur={(event) => updateConfig("canvasImageCount", normalizeImageCount(event.target.value))} />
                        </Form.Item>
                        <Form.Item label={t("config.preferences.imageResolution")} className="mb-0">
                            <Select value={inferMediaScale(config.size)} options={imageResolutionOptions} onChange={(scale) => updateConfig("size", computeMediaSize(scale, inferMediaRatio(config.size)))} />
                        </Form.Item>
                        <Form.Item label={t("config.preferences.videoResolution")} className="mb-0">
                            <Select value={parseVideoResolution(config.vquality)} options={videoResolutionOptions} onChange={(value) => updateConfig("vquality", value)} />
                        </Form.Item>
                        <Form.Item label={t("config.preferences.audioVoice")} className="mb-0">
                            <Select value={config.audioVoice} options={audioVoiceOptions} onChange={(value) => updateConfig("audioVoice", value)} />
                        </Form.Item>
                        <Form.Item label={t("config.preferences.audioFormat")} className="mb-0">
                            <Select value={config.audioFormat} options={audioFormatOptions} onChange={(value) => updateConfig("audioFormat", value)} />
                        </Form.Item>
                        <Form.Item label={t("config.preferences.audioSpeed")} className="mb-0">
                            <Input type="number" min={0.25} max={4} step={0.05} value={config.audioSpeed} onChange={(event) => updateConfig("audioSpeed", event.target.value)} onBlur={(event) => updateConfig("audioSpeed", normalizeAudioSpeedValue(event.target.value))} />
                        </Form.Item>
                    </div>
                </section>
                <section className="rounded-xl border border-border p-5">
                    <h2 className="mb-4 text-sm font-semibold">{t("config.preferences.canvasBehavior")}</h2>
                    <Form.Item label={t("config.preferences.regenerateBehavior")} className="mb-4">
                        <Radio.Group value={config.nodeRegenerateBehavior} onChange={(event) => updateConfig("nodeRegenerateBehavior", event.target.value)} className="flex flex-col gap-2">
                            <Radio value="overwrite">
                                <span className="block text-sm font-medium">{t("config.preferences.regenerateBehaviorOverwrite")}</span>
                                <span className="mt-0.5 block text-xs opacity-60">{t("config.preferences.regenerateBehaviorOverwriteDescription")}</span>
                            </Radio>
                            <Radio value="new-node">
                                <span className="block text-sm font-medium">{t("config.preferences.regenerateBehaviorNewNode")}</span>
                                <span className="mt-0.5 block text-xs opacity-60">{t("config.preferences.regenerateBehaviorNewNodeDescription")}</span>
                            </Radio>
                        </Radio.Group>
                    </Form.Item>
                    <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
                        <span className="text-sm">{t("config.preferences.autoFocusOnSelect")}</span>
                        <Switch checked={config.autoFocusOnSelect} onChange={(checked) => updateConfig("autoFocusOnSelect", checked)} />
                    </div>
                </section>
                <section className="rounded-xl border border-border p-5">
                    <h2 className="mb-4 text-sm font-semibold">{t("config.preferences.instructions")}</h2>
                    <Form.Item label={t("config.preferences.audioInstructions")} className="mb-4">
                        <Input.TextArea rows={2} value={config.audioInstructions} placeholder={t("config.preferences.audioInstructionsPlaceholder")} onChange={(event) => updateConfig("audioInstructions", event.target.value)} />
                    </Form.Item>
                    <Form.Item label={t("config.preferences.systemPrompt")} className="mb-0">
                        <Input.TextArea rows={4} value={config.systemPrompt} placeholder={t("config.preferences.systemPromptPlaceholder")} onChange={(event) => updateConfig("systemPrompt", event.target.value)} />
                    </Form.Item>
                </section>
            </Form>
        </div>
    );
}

function normalizeImageCount(value: string) {
    return String(Math.max(1, Math.min(15, Math.floor(Math.abs(Number(value)) || 3))));
}
