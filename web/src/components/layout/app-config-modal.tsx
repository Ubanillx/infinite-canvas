import { App, Button, Modal, Tabs } from "antd";
import type { TFunction } from "i18next";
import { KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ChannelEditorDrawer } from "@/components/layout/channel-editor-drawer";
import { ConfigBackup } from "@/components/layout/config-backup";
import { ConfigPreferencesForm } from "@/components/layout/config-preferences";
import { ConfigPromptSources } from "@/components/layout/config-prompt-sources";
import { ConfigLocalStorage } from "@/components/layout/config-local-storage";
import { SaveConfigButton } from "@/components/layout/config-save-button";
import { createModelChannel, modelOptionsFromChannels, normalizeModelOptionValue, selectableModelsByCapability, useConfigStore, type AiConfig, type ApiCallFormat, type ConfigTabKey, type ModelCapability, type ModelChannel } from "@/stores/use-config-store";
import { useIsAdmin } from "@/stores/use-session-store";
import { RegistrationSettings } from "@/pages/config/components/registration-settings";

export function AppConfigPanel({ showDoneButton = false, showTabs = true, showSaveButton = true, initialTab = "channels" }: { showDoneButton?: boolean; showTabs?: boolean; showSaveButton?: boolean; initialTab?: ConfigTabKey }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const [selectedTab, setSelectedTab] = useState<ConfigTabKey>(initialTab);
    const activeTab = showTabs ? selectedTab : initialTab;
    const [editingChannelId, setEditingChannelId] = useState("");
    const config = useConfigStore((state) => state.config);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const shouldPromptContinue = useConfigStore((state) => state.shouldPromptContinue);
    const isConfigOpen = useConfigStore((state) => state.isConfigOpen);
    const setConfigDialogOpen = useConfigStore((state) => state.setConfigDialogOpen);
    const clearPromptContinue = useConfigStore((state) => state.clearPromptContinue);
    const editingChannel = config.channels.find((channel) => channel.id === editingChannelId) || null;
    useEffect(() => setSelectedTab(initialTab), [initialTab]);

    const saveConfig = (nextConfig: AiConfig) => {
        (Object.keys(nextConfig) as Array<keyof AiConfig>).forEach((key) => updateConfig(key, nextConfig[key]));
    };

    const finishConfig = () => {
        const ready = config.channels.some((channel) => channel.baseUrl.trim() && (channel.hasApiKey || channel.apiKey.trim()) && channel.models.length);
        setConfigDialogOpen(false);
        if (!ready) return;
        message.info(t(shouldPromptContinue ? "config.savedContinue" : "config.saved"));
        clearPromptContinue();
    };

    const updateChannels = (channels: ModelChannel[]) => saveConfig(withChannels(config, channels));

    const addChannel = () => {
        const channel = createModelChannel({ name: t("config.channels.numberedName", { count: config.channels.length + 1 }) });
        updateChannels([...config.channels, channel]);
        setEditingChannelId(channel.id);
    };

    const deleteChannel = (id: string) => {
        if (config.channels.length <= 1) {
            message.warning(t("config.channels.keepOne"));
            return;
        }
        updateChannels(config.channels.filter((channel) => channel.id !== id));
    };

    const saveChannel = (channel: ModelChannel) => {
        updateChannels(config.channels.map((item) => (item.id === channel.id ? channel : item)));
    };

    return (
        <div className={showDoneButton ? "flex h-full min-h-0 flex-col" : undefined}>
            {showSaveButton && !showDoneButton && activeTab !== "local-storage" && activeTab !== "registration" && activeTab !== "webdav" ? <div className="mb-4 flex justify-end"><SaveConfigButton /></div> : null}
            <Tabs
                activeKey={activeTab}
                onChange={(key) => setSelectedTab(key as ConfigTabKey)}
                renderTabBar={showTabs ? undefined : () => <></>}
                className={showDoneButton ? "[&_.ant-tabs-content-holder]:overflow-y-auto" : undefined}
                tabBarExtraContent={showDoneButton && showSaveButton && activeTab !== "local-storage" && activeTab !== "registration" && activeTab !== "webdav" ? <SaveConfigButton /> : undefined}
                styles={showDoneButton ? {
                    root: { display: "flex", flex: 1, flexDirection: "column", minHeight: 0 },
                    header: { marginBottom: 0 },
                    content: { paddingTop: 16, paddingRight: 4 },
                } : undefined}
                items={[
                    { key: "registration", label: t("config.tabs.registration"), children: <RegistrationSettings /> },
                    {
                        key: "channels",
                        label: t("config.tabs.channels"),
                        children: (
                            <section className="overflow-hidden rounded-xl border border-border">
                                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
                                    <div>
                                        <h2 className="text-sm font-semibold">{t("config.channels.listTitle")}</h2>
                                        <p className="mt-1 text-xs text-muted-foreground">{t("config.channels.channelCount", { count: config.channels.length })}</p>
                                    </div>
                                    <Button type="primary" icon={<Plus className="size-4" />} onClick={addChannel}>{t("config.channels.add")}</Button>
                                </div>
                                <div className="divide-y divide-border">
                                    {config.channels.map((channel) => (
                                        <div key={channel.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
                                            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><KeyRound className="size-4" /></div>
                                            <div className="min-w-0 flex-1">
                                                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                                    <span className="truncate text-sm font-semibold">{channel.name || t("config.channels.unnamed")}</span>
                                                    <span className="text-xs text-muted-foreground">{apiFormatLabel(channel.apiFormat, t)} · {t("config.channels.modelCount", { count: channel.models.length })}</span>
                                                </div>
                                                <div className="mt-1 truncate text-xs text-muted-foreground">{channel.baseUrl || t("config.channels.missingUrl")}</div>
                                            </div>
                                            <div className="flex shrink-0 gap-1">
                                                <Button type="text" size="small" icon={<Pencil className="size-3.5" />} onClick={() => setEditingChannelId(channel.id)}>
                                                    {t("common.edit")}
                                                </Button>
                                                <Button type="text" size="small" danger icon={<Trash2 className="size-3.5" />} aria-label={t("config.channels.delete", { name: channel.name || t("config.channels.unnamed") })} onClick={() => deleteChannel(channel.id)} />
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </section>
                        ),
                    },
                    {
                        key: "preferences",
                        label: t("config.tabs.defaultPreferences"),
                        children: <ConfigPreferencesForm mode="defaults" />,
                    },
                    {
                        key: "prompt-sources",
                        label: t("config.tabs.promptSources"),
                        children: <ConfigPromptSources />,
                    },
                    {
                        key: "webdav",
                        label: t("config.tabs.webdav"),
                        children: <ConfigBackup visible={activeTab === "webdav"} />,
                    },
                    {
                        key: "local-storage",
                        label: t("config.tabs.localStorage"),
                        children: <ConfigLocalStorage active={activeTab === "local-storage"} />,
                    },
                ]}
            />
            {showDoneButton ? (
                <div className="flex shrink-0 justify-end border-t border-border pt-3">
                    <Button type="primary" onClick={finishConfig}>
                        {t("common.done")}
                    </Button>
                </div>
            ) : null}
            <ChannelEditorDrawer open={Boolean(editingChannel)} channel={editingChannel} onSave={saveChannel} onClose={() => setEditingChannelId("")} />
        </div>
    );
}

export function AppConfigModal() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const isAdmin = useIsAdmin();
    const isConfigOpen = useConfigStore((state) => state.isConfigOpen);
    const configTab = useConfigStore((state) => state.configTab);
    const setConfigDialogOpen = useConfigStore((state) => state.setConfigDialogOpen);

    useEffect(() => {
        if (!isConfigOpen || isAdmin) return;
        setConfigDialogOpen(false);
        message.warning(t("config.adminOnly"));
    }, [isAdmin, isConfigOpen, message, setConfigDialogOpen, t]);

    if (!isAdmin) return null;
    return (
        <Modal
            title={
                <div>
                    <div className="text-lg font-semibold">{t("config.title")}</div>
                    <div className="mt-1 text-xs font-normal text-muted-foreground">{t("config.modalDescription")}</div>
                </div>
            }
            open={isConfigOpen}
            width={980}
            centered
            onCancel={() => setConfigDialogOpen(false)}
            styles={{ body: { height: "min(620px, calc(100dvh - 160px))", overflow: "hidden" } }}
            footer={null}
        >
            <AppConfigPanel showDoneButton initialTab={configTab} />
        </Modal>
    );
}

function withChannels(config: AiConfig, channels: ModelChannel[]): AiConfig {
    const next: AiConfig = {
        ...config,
        channels,
        models: modelOptionsFromChannels(channels),
        baseUrl: channels[0]?.baseUrl || config.baseUrl,
        apiKey: channels[0]?.apiKey || config.apiKey,
        apiFormat: channels[0]?.apiFormat || config.apiFormat,
    };
    return {
        ...next,
        imageModel: pickDefaultModel(next, "image", config.imageModel),
        videoModel: pickDefaultModel(next, "video", config.videoModel),
        textModel: pickDefaultModel(next, "text", config.textModel),
        audioModel: pickDefaultModel(next, "audio", config.audioModel),
    };
}

function pickDefaultModel(config: AiConfig, capability: ModelCapability, current: string) {
    const options = selectableModelsByCapability(config, capability);
    const normalized = normalizeModelOptionValue(current, config.channels);
    return options.includes(normalized) ? normalized : options[0] || "";
}

function apiFormatLabel(apiFormat: ApiCallFormat, t: TFunction) {
    if (apiFormat === "gemini") return "Gemini";
    if (apiFormat === "ark") return t("config.protocols.ark");
    if (apiFormat === "custom") return t("config.protocols.customVideo");
    return "OpenAI";
}

