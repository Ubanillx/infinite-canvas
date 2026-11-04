import { App, Button, Form, Input, Modal, Progress, Radio, Select, Switch, Tabs } from "antd";
import type { TFunction } from "i18next";
import { Cloud, Download, Info, KeyRound, Pencil, Plus, RefreshCw, Save, Trash2, Upload, Wifi } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { formatCompactBytes as formatBytes } from "@/lib/format";
import { ModelPicker } from "@/components/model-picker";
import { videoResolutionOptions } from "@/components/video-settings-panel";
import { ChannelEditorDrawer } from "@/components/layout/channel-editor-drawer";
import { ConfigPromptSources } from "@/components/layout/config-prompt-sources";
import { ConfigLocalStorage } from "@/components/layout/config-local-storage";
import type { AppLocale } from "@/i18n";
import { getServerConfigSaveStatus, saveServerConfigNow, subscribeServerConfigSaveStatus } from "@/services/server-config";
import { importWorkspaceSnapshot, listWorkspaceSnapshots, type AppSyncDomainKey, type AppSyncProgressEvent, type AppSyncStageKey, type WebdavSnapshot } from "@/services/app-sync";
import { isWebdavConfigured, syncAllDataToWebdav } from "@/services/webdav-auto-sync";
import { testWebdavConnection } from "@/services/webdav-sync";
import { audioFormatOptions, audioVoiceOptions, normalizeAudioSpeedValue } from "@/lib/audio-generation";
import { computeMediaSize, inferMediaRatio, inferMediaScale, mediaScaleOptions, parseVideoResolution } from "@/lib/media-size";
import { createModelChannel, modelOptionsFromChannels, normalizeModelOptionValue, selectableModelsByCapability, useConfigStore, type AiConfig, type ApiCallFormat, type ConfigTabKey, type ModelCapability, type ModelChannel } from "@/stores/use-config-store";
import { useIsAdmin } from "@/stores/use-session-store";

type ModelGroup = {
    capability: ModelCapability;
    modelKey: "imageModel" | "videoModel" | "textModel" | "audioModel";
    labelKey: string;
};

type WebdavDomainProgress = {
    stageKey?: AppSyncStageKey;
    stageDetail?: string;
    stageCount?: number;
    current?: number;
    total?: number;
    status?: "active" | "success" | "exception";
};

const modelGroups: ModelGroup[] = [
    { capability: "image", modelKey: "imageModel", labelKey: "config.preferences.defaultImageModel" },
    { capability: "video", modelKey: "videoModel", labelKey: "config.preferences.defaultVideoModel" },
    { capability: "text", modelKey: "textModel", labelKey: "config.preferences.defaultTextModel" },
    { capability: "audio", modelKey: "audioModel", labelKey: "config.preferences.defaultAudioModel" },
];

const webdavDomainKeys: AppSyncDomainKey[] = ["canvas", "assets", "image-workbench", "video-workbench"];
function createWebdavDomainProgress(): Record<AppSyncDomainKey, WebdavDomainProgress> {
    return webdavDomainKeys.reduce(
        (progress, key) => ({
            ...progress,
            [key]: {},
        }),
        {} as Record<AppSyncDomainKey, WebdavDomainProgress>,
    );
}

export function SaveConfigButton() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const serverSave = useSyncExternalStore(subscribeServerConfigSaveStatus, getServerConfigSaveStatus);

    const save = async () => {
        try {
            await saveServerConfigNow();
            message.success(t("config.serverStorage.saved"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("config.serverStorage.saveFailed"));
        }
    };

    return <Button icon={<Save className="size-4" />} loading={serverSave.saving} onClick={() => void save()}>{t("config.serverStorage.save")}</Button>;
}

export function AppConfigPanel({ showDoneButton = false, showTabs = true, showSaveButton = true, initialTab = "channels" }: { showDoneButton?: boolean; showTabs?: boolean; showSaveButton?: boolean; initialTab?: ConfigTabKey }) {
    const { message } = App.useApp();
    const { i18n, t } = useTranslation();
    const [selectedTab, setSelectedTab] = useState<ConfigTabKey>(initialTab);
    const activeTab = showTabs ? selectedTab : initialTab;
    const [editingChannelId, setEditingChannelId] = useState("");
    const [testingWebdav, setTestingWebdav] = useState(false);
    const [syncingWebdav, setSyncingWebdav] = useState(false);
    const [webdavSyncStatus, setWebdavSyncStatus] = useState("");
    const [webdavSnapshots, setWebdavSnapshots] = useState<WebdavSnapshot[]>([]);
    const [selectedSnapshot, setSelectedSnapshot] = useState("");
    const [loadingSnapshots, setLoadingSnapshots] = useState(false);
    const [importingSnapshot, setImportingSnapshot] = useState(false);
    const [webdavPasswordDraft, setWebdavPasswordDraft] = useState("");
    const [webdavDomainProgress, setWebdavDomainProgress] = useState(createWebdavDomainProgress);
    const config = useConfigStore((state) => state.config);
    const webdav = useConfigStore((state) => state.webdav);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const updateWebdavConfig = useConfigStore((state) => state.updateWebdavConfig);
    const shouldPromptContinue = useConfigStore((state) => state.shouldPromptContinue);
    const isConfigOpen = useConfigStore((state) => state.isConfigOpen);
    const setConfigDialogOpen = useConfigStore((state) => state.setConfigDialogOpen);
    const clearPromptContinue = useConfigStore((state) => state.clearPromptContinue);
    const webdavReady = isWebdavConfigured({ ...webdav, password: webdavPasswordDraft || webdav.password });
    const editingChannel = config.channels.find((channel) => channel.id === editingChannelId) || null;
    const locale = i18n.resolvedLanguage as AppLocale;
    const imageResolutionOptions = mediaScaleOptions.map((value) => ({ value, label: value === "auto" ? t("settingsPanels.common.auto") : value.toUpperCase() }));
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

    const testWebdav = async () => {
        if (!webdavReady) {
            message.error(t("config.webdav.missingUrl"));
            return;
        }
        setTestingWebdav(true);
        try {
            await saveServerConfigNow();
            await testWebdavConnection(webdav);
            message.success(t("config.webdav.available"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("config.webdav.testFailed"));
        } finally {
            setTestingWebdav(false);
        }
    };

    const updateWebdavProgress = (event: AppSyncProgressEvent) => {
        setWebdavSyncStatus(syncStageLabel(event.stage, event.stageDetail, event.stageCount, t));
        if (!event.domain) return;
        setWebdavDomainProgress((current) => ({
            ...current,
            [event.domain as AppSyncDomainKey]: {
                stageKey: event.stage,
                stageDetail: event.stageDetail,
                stageCount: event.stageCount,
                current: event.current,
                total: event.total,
                status: event.status,
            },
        }));
    };

    const syncWebdav = async () => {
        if (!webdavReady) {
            message.error(t("config.webdav.missingUrl"));
            return;
        }
        setSyncingWebdav(true);
        setWebdavDomainProgress(createWebdavDomainProgress());
        setWebdavSyncStatus(t("config.webdav.preparing"));
        try {
            await saveServerConfigNow();
            const result = await syncAllDataToWebdav(webdav, "manual", updateWebdavProgress);
            message.success(t("config.webdav.completed", { projects: result.projects, assets: result.assets, records: result.imageLogs + result.videoLogs, files: result.uploadedFiles, bytes: formatBytes(result.uploadedBytes) }));
        } catch (error) {
            setWebdavSyncStatus(error instanceof Error ? error.message : t("config.webdav.failed"));
            message.error(error instanceof Error ? error.message : t("config.webdav.failed"));
        } finally {
            setSyncingWebdav(false);
        }
    };

    const loadSnapshots = async () => {
        if (!webdavReady) {
            message.error(t("config.webdav.missingUrl"));
            return;
        }
        setLoadingSnapshots(true);
        try {
            await saveServerConfigNow();
            setWebdavSnapshots(await listWorkspaceSnapshots(webdav));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("config.webdav.snapshotLoadFailed"));
        } finally {
            setLoadingSnapshots(false);
        }
    };

    const importSnapshot = async () => {
        if (!selectedSnapshot) {
            message.warning(t("config.webdav.snapshotRequired"));
            return;
        }
        setImportingSnapshot(true);
        setWebdavSyncStatus(t("config.webdav.snapshotImporting"));
        try {
            await saveServerConfigNow();
            const result = await importWorkspaceSnapshot(webdav, selectedSnapshot, updateWebdavProgress);
            message.success(t("config.webdav.snapshotImported", { projects: result.projects, assets: result.assets }));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("config.webdav.snapshotImportFailed"));
        } finally {
            setImportingSnapshot(false);
        }
    };

    return (
        <div className={showDoneButton ? "flex h-full min-h-0 flex-col" : undefined}>
            {showSaveButton && !showDoneButton && activeTab !== "local-storage" ? <div className="mb-4 flex justify-end"><SaveConfigButton /></div> : null}
            <Tabs
                activeKey={activeTab}
                onChange={(key) => setSelectedTab(key as ConfigTabKey)}
                renderTabBar={showTabs ? undefined : () => <></>}
                className={showDoneButton ? "[&_.ant-tabs-content-holder]:overflow-y-auto" : undefined}
                tabBarExtraContent={showDoneButton && showSaveButton && activeTab !== "local-storage" ? <SaveConfigButton /> : undefined}
                styles={showDoneButton ? {
                    root: { display: "flex", flex: 1, flexDirection: "column", minHeight: 0 },
                    header: { marginBottom: 0 },
                    content: { paddingTop: 16, paddingRight: 4 },
                } : undefined}
                items={[
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
                        label: t("config.tabs.preferences"),
                        children: (
                            <Form layout="vertical" requiredMark={false} className="space-y-5">
                                <section className="rounded-xl border border-border p-5">
                                    <h2 className="mb-4 text-sm font-semibold">{t("config.preferences.defaultModels")}</h2>
                                    <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
                                    {modelGroups.map((group) => (
                                        <Form.Item key={group.modelKey} label={t(group.labelKey)} className="mb-0">
                                            <ModelPicker config={config} value={config[group.modelKey]} onChange={(model) => updateConfig(group.modelKey, model)} capability={group.capability} fullWidth />
                                        </Form.Item>
                                    ))}
                                    </div>
                                </section>
                                <section className="rounded-xl border border-border p-5">
                                    <h2 className="mb-4 text-sm font-semibold">{t("config.preferences.generation")}</h2>
                                    <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
                                    <Form.Item label={t("config.preferences.canvasImageCount")} extra={t("config.preferences.canvasImageCountDescription")} className="mb-0">
                                        <Input
                                            type="number"
                                            min={1}
                                            max={15}
                                            value={config.canvasImageCount}
                                            onChange={(event) => updateConfig("canvasImageCount", event.target.value)}
                                            onBlur={(event) => updateConfig("canvasImageCount", normalizeImageCount(event.target.value))}
                                        />
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
                                        <Input
                                            type="number"
                                            min={0.25}
                                            max={4}
                                            step={0.05}
                                            value={config.audioSpeed}
                                            onChange={(event) => updateConfig("audioSpeed", event.target.value)}
                                            onBlur={(event) => updateConfig("audioSpeed", normalizeAudioSpeedValue(event.target.value))}
                                        />
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
                        ),
                    },
                    {
                        key: "prompt-sources",
                        label: t("config.tabs.promptSources"),
                        children: <ConfigPromptSources />,
                    },
                    {
                        key: "webdav",
                        label: t("config.tabs.webdav"),
                        children: (
                            <div className="space-y-5">
                                <section className="rounded-xl border border-border p-5">
                                    <h2 className="text-sm font-semibold">{t("config.webdav.connectionTitle")}</h2>
                                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("config.webdav.connectionDescription")}</p>
                                    <Form layout="vertical" requiredMark={false} className="mt-5 grid gap-x-5 gap-y-3 sm:grid-cols-2">
                                        <Form.Item label={t("config.webdav.url")} className="mb-0 sm:col-span-2">
                                            <Input value={webdav.url === "/api/webdav" ? "" : webdav.url} placeholder={t("config.webdav.urlPlaceholder")} onChange={(event) => updateWebdavConfig("url", event.target.value)} />
                                        </Form.Item>
                                        <Form.Item label={t("config.webdav.directory")} className="mb-0 sm:col-span-2">
                                            <Input value={webdav.directory} placeholder={t("config.webdav.directoryPlaceholder")} onChange={(event) => updateWebdavConfig("directory", event.target.value)} />
                                        </Form.Item>
                                        <Form.Item label={t("config.webdav.username")} className="mb-0">
                                            <Input value={webdav.username} autoComplete="username" onChange={(event) => updateWebdavConfig("username", event.target.value)} />
                                        </Form.Item>
                                        <Form.Item label={t("config.webdav.password")} className="mb-0">
                                            <Input.Password value={webdavPasswordDraft} autoComplete="new-password" placeholder={webdav.hasPassword ? t("config.webdav.passwordConfigured") : t("config.webdav.passwordPlaceholder")} onChange={(event) => setWebdavPasswordDraft(event.target.value)} onBlur={() => { if (webdavPasswordDraft) updateWebdavConfig("password", webdavPasswordDraft); setWebdavPasswordDraft(""); }} />
                                        </Form.Item>
                                    </Form>
                                    <p className="mt-4 flex items-start gap-2 text-xs leading-5 text-muted-foreground"><Info className="mt-0.5 size-3.5 shrink-0" />{t("config.webdav.passwordWriteOnly")}</p>
                                </section>
                                <div className="grid items-start gap-5 md:grid-cols-2">
                                    <section className="rounded-xl border border-border p-5">
                                        <div className="flex items-center gap-2 text-sm font-semibold"><Cloud className="size-4" />{t("config.webdav.syncSection")}</div>
                                        <p className="mt-2 text-xs leading-5 text-muted-foreground">{t("config.webdav.description")}</p>
                                        <p className="mt-5 text-xs text-muted-foreground">{webdav.lastSyncedAt ? t("config.webdav.lastSynced", { time: formatWebdavTime(webdav.lastSyncedAt, locale) }) : t("config.webdav.neverSynced")}</p>
                                        {webdav.lastConfigSyncedAt ? <p className="mt-1 text-xs text-muted-foreground">{t("config.webdav.configLastSynced", { time: formatWebdavTime(webdav.lastConfigSyncedAt, locale) })}</p> : null}
                                        <div className="mt-4 flex flex-wrap gap-2">
                                            <Button type="primary" icon={<RefreshCw className="size-4" />} disabled={!webdavReady || testingWebdav} loading={syncingWebdav} onClick={() => void syncWebdav()}>{t(syncingWebdav ? "config.webdav.syncing" : "config.webdav.syncNow")}</Button>
                                            <Button icon={<Wifi className="size-4" />} disabled={!webdavReady || syncingWebdav} loading={testingWebdav} onClick={() => void testWebdav()}>{t("config.webdav.test")}</Button>
                                        </div>
                                        {webdavSyncStatus ? <p className="mt-3 text-xs text-muted-foreground" role="status">{webdavSyncStatus}</p> : null}
                                        {syncingWebdav || webdavSyncStatus ? <WebdavProgressGrid progress={webdavDomainProgress} t={t} /> : null}
                                    </section>
                                    <section className="rounded-xl border border-border p-5">
                                        <h2 className="text-sm font-semibold">{t("config.webdav.snapshotSection")}</h2>
                                        <p className="mt-2 text-xs leading-5 text-muted-foreground">{t("config.webdav.snapshotDescription")}</p>
                                        <div className="mt-5 flex flex-col items-start gap-4">
                                            <Button icon={<Download className="size-4" />} disabled={!webdavReady || loadingSnapshots || importingSnapshot} loading={loadingSnapshots} onClick={() => void loadSnapshots()}>{t("config.webdav.loadSnapshots")}</Button>
                                            <div className="w-full">
                                                <label className="mb-2 block text-xs text-muted-foreground" htmlFor="webdav-snapshot-select">{t("config.webdav.selectSnapshot")}</label>
                                                <Select id="webdav-snapshot-select" className="w-full" disabled={!webdavSnapshots.length || importingSnapshot} value={selectedSnapshot || undefined} placeholder={t("config.webdav.selectSnapshot")} options={webdavSnapshots.map((snapshot) => ({ value: snapshot.id, label: formatWebdavTime(snapshot.createdAt, locale) }))} onChange={setSelectedSnapshot} />
                                            </div>
                                            <Button icon={<Upload className="size-4" />} disabled={!selectedSnapshot || !webdavReady || loadingSnapshots} loading={importingSnapshot} onClick={() => void importSnapshot()}>{t("config.webdav.importSnapshot")}</Button>
                                        </div>
                                    </section>
                                </div>
                            </div>
                        ),
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

function normalizeImageCount(value: string) {
    return String(Math.max(1, Math.min(15, Math.floor(Math.abs(Number(value)) || 3))));
}

function apiFormatLabel(apiFormat: ApiCallFormat, t: TFunction) {
    if (apiFormat === "gemini") return "Gemini";
    if (apiFormat === "ark") return t("config.protocols.ark");
    if (apiFormat === "custom") return t("config.protocols.customVideo");
    return "OpenAI";
}

function formatWebdavTime(value: string, locale: AppLocale) {
    return new Date(value).toLocaleString(locale, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function WebdavProgressGrid({ progress, t }: { progress: Record<AppSyncDomainKey, WebdavDomainProgress>; t: TFunction }) {
    return (
        <div className="mt-3 grid gap-2">
            {webdavDomainKeys.map((key) => {
                const item = progress[key];
                const count = item.total ? `${item.current || 0}/${item.total}` : "";
                return (
                    <div key={key} className="rounded-md border border-border px-3 py-2">
                        <div className="mb-1 flex min-w-0 items-center justify-between gap-3 text-xs">
                            <span className="shrink-0 font-medium text-foreground">{t(`config.webdav.domains.${domainTranslationKey(key)}`)}</span>
                            <span className="min-w-0 truncate text-right text-muted-foreground">
                                {syncStageLabel(item.stageKey, item.stageDetail, item.stageCount, t)}
                                {count ? ` · ${count}` : ""}
                            </span>
                        </div>
                        <Progress percent={getWebdavProgressPercent(item)} size="small" status={getWebdavProgressStatus(item)} showInfo={false} />
                    </div>
                );
            })}
        </div>
    );
}

function domainTranslationKey(domain: AppSyncDomainKey) {
    if (domain === "image-workbench") return "imageWorkbench";
    if (domain === "video-workbench") return "videoWorkbench";
    return domain;
}

function syncStageLabel(stage: AppSyncStageKey | undefined, detail: string | undefined, count: number | undefined, t: TFunction) {
    if (stage === "waitingLocalData") return t("config.webdav.stages.localWaiting");
    if (stage === "snapshotComplete") return t("config.webdav.stages.snapshotComplete");
    if (stage === "snapshotUploaded") return t("config.webdav.stages.snapshotUploaded");
    if (stage === "importComplete") return t("config.webdav.stages.importComplete");
    if (stage === "readRemoteSnapshot") return t("config.webdav.stages.readRemoteSnapshot");
    if (stage === "readLocalData") return t("config.webdav.stages.localData");
    if (stage === "writeImportData") return t("config.webdav.stages.writeImportData");
    if (stage === "downloadMedia") return t("config.webdav.stages.downloadMedia");
    if (stage === "uploadMedia") return t("config.webdav.stages.uploadMediaFile", { size: detail });
    if (stage === "uploadSnapshotManifest") return t("config.webdav.stages.uploadManifest", { size: detail });
    if (stage === "prunedSnapshots") return t("config.webdav.stages.prunedSnapshots", { count });
    if (stage === "complete") return t("config.webdav.stages.complete");
    if (stage === "error") return detail || t("config.webdav.failed");
    return t("config.webdav.stages.waiting");
}

function getWebdavProgressPercent(item: WebdavDomainProgress) {
    if (item.status === "success") return 100;
    if (item.total) return Math.min(100, Math.round(((item.current || 0) / item.total) * 100));
    if (item.status === "exception") return 100;
    if (item.stageKey === "readRemoteSnapshot") return 12;
    if (item.stageKey === "readLocalData") return 24;
    if (item.stageKey === "downloadMedia") return 36;
    if (item.stageKey === "writeImportData") return 58;
    if (item.stageKey === "uploadMedia") return 66;
    if (item.stageKey === "uploadSnapshotManifest") return 90;
    return item.status === "active" ? 30 : 0;
}

function getWebdavProgressStatus(item: WebdavDomainProgress): "normal" | "active" | "success" | "exception" {
    if (item.status === "success" || item.status === "exception") return item.status;
    return item.status === "active" ? "active" : "normal";
}

