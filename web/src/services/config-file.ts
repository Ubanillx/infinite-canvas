import { saveAs } from "file-saver";

import i18n from "@/i18n";
import { defaultWebdavSyncConfig, redactAiConfigSecrets, useConfigStore, type AiConfig, type WebdavSyncConfig } from "@/stores/use-config-store";
import { usePromptSourceStore, type PromptSourceSchedule } from "@/stores/use-prompt-source-store";
import type { PromptSource } from "@/services/api/prompt-source-presets";

export type AppConfigFile = {
    app: "infinite-canvas";
    version: 1;
    exportedAt: string;
    config: AiConfig;
    webdav: WebdavSyncConfig;
    promptSources: {
        sources: PromptSource[];
        schedule: PromptSourceSchedule;
    };
};

export function exportAppConfig() {
    const data = createAppConfigSnapshot();
    saveAs(new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" }), "infinite-canvas-config.json");
}

export function createAppConfigSnapshot(): AppConfigFile {
    const { config, webdav } = useConfigStore.getState();
    const { sources, schedule } = usePromptSourceStore.getState();
    return { app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(), config, webdav, promptSources: { sources, schedule } };
}

export function applyAppConfig(data: AppConfigFile) {
    useConfigStore.setState({ config: data.config, webdav: { ...defaultWebdavSyncConfig, ...data.webdav, autoSyncEnabled: false } });
    usePromptSourceStore.setState(data.promptSources);
}

export function applyServerConfig(data: AppConfigFile) {
    useConfigStore.setState({ config: redactAiConfigSecrets(data.config), webdav: { ...defaultWebdavSyncConfig, ...data.webdav, autoSyncEnabled: false, password: "" } });
    usePromptSourceStore.setState(data.promptSources);
}

export function markServerConfigSaved(saved: AppConfigFile) {
    const current = useConfigStore.getState();
    const savedKeys = new Map(saved.config.channels.map((channel) => [channel.id, channel.apiKey]));
    useConfigStore.setState({
        config: {
            ...current.config,
            apiKey: current.config.apiKey === saved.config.apiKey ? "" : current.config.apiKey,
            channels: current.config.channels.map((channel) => {
                const savedKey = savedKeys.get(channel.id) || "";
                return channel.apiKey === savedKey ? { ...channel, apiKey: "", hasApiKey: channel.hasApiKey || Boolean(savedKey) } : channel;
            }),
        },
        webdav: current.webdav.password === saved.webdav.password ? { ...current.webdav, password: "" } : current.webdav,
    });
}

export function isAppConfigFile(data: unknown): data is AppConfigFile {
    if (!data || typeof data !== "object") return false;
    const value = data as Partial<AppConfigFile>;
    return value.app === "infinite-canvas" && value.version === 1 && Boolean(value.config && value.webdav && value.promptSources && Array.isArray(value.promptSources.sources));
}

export async function importAppConfig(file: File) {
    let data: AppConfigFile;
    try {
        data = JSON.parse(await file.text()) as AppConfigFile;
    } catch {
        throw new Error(i18n.t("config.invalidFile"));
    }
    if (!isAppConfigFile(data)) throw new Error(i18n.t("config.invalidFile"));
    applyAppConfig(data);
}
