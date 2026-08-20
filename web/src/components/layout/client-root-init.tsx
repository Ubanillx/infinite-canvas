import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { App, Button, Result, Spin } from "antd";
import { useTranslation } from "react-i18next";

import { applyServerConfig, createAppConfigSnapshot } from "@/services/config-file";
import { loadServerConfig, saveServerConfig } from "@/services/server-config";
import { createModelChannel, useConfigStore } from "@/stores/use-config-store";
import { usePromptSourceStore } from "@/stores/use-prompt-source-store";
import { usePromptSourceScheduler } from "@/hooks/use-prompt-source-scheduler";
import { useWebdavAutoSync } from "@/hooks/use-webdav-auto-sync";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const { t } = useTranslation();
    const [attempt, setAttempt] = useState(0);
    const { ready, error } = useServerConfigSync(attempt);

    if (error) {
        return <Result status="error" title={t("config.serverStorage.loadFailed")} subTitle={error} extra={<Button type="primary" onClick={() => setAttempt((value) => value + 1)}>{t("common.retry")}</Button>} />;
    }
    if (!ready) {
        return (
            <div className="flex min-h-screen items-center justify-center">
                <div className="flex flex-col items-center gap-3 text-sm text-stone-500">
                    <Spin size="large" />
                    <span>{t("config.serverStorage.loading")}</span>
                </div>
            </div>
        );
    }
    return <ReadyClientRoot>{children}</ReadyClientRoot>;
}

function ReadyClientRoot({ children }: { children: ReactNode }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const handledConfigParams = useRef(false);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const config = useConfigStore((state) => state.config);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);

    usePromptSourceScheduler();
    useWebdavAutoSync();

    useEffect(() => {
        if (handledConfigParams.current) return;
        const searchParams = new URLSearchParams(window.location.search);
        const baseUrl = searchParams.get("baseUrl") || searchParams.get("baseurl");
        const apiKey = searchParams.get("apiKey") || searchParams.get("apikey");
        if (!baseUrl && !apiKey) return;
        handledConfigParams.current = true;
        searchParams.delete("baseUrl");
        searchParams.delete("baseurl");
        searchParams.delete("apiKey");
        searchParams.delete("apikey");
        window.history.replaceState(null, "", `${window.location.pathname}${searchParams.size ? `?${searchParams}` : ""}${window.location.hash}`);
        const firstChannel = config.channels[0];
        updateConfig(
            "channels",
            firstChannel
                ? config.channels.map((channel, index) =>
                      index === 0
                          ? {
                                ...channel,
                                ...(baseUrl ? { baseUrl } : {}),
                                ...(apiKey ? { apiKey } : {}),
                            }
                          : channel,
                  )
                : [createModelChannel({ id: "default", name: t("config.channels.defaultName"), baseUrl: baseUrl || undefined, apiKey: apiKey || "" })],
        );
        if (baseUrl) updateConfig("baseUrl", baseUrl);
        if (apiKey) updateConfig("apiKey", apiKey);
        openConfigDialog(false);
        message.success(t("config.importedDirectConfig"));
    }, [config.channels, message, openConfigDialog, t, updateConfig]);

    return <>{children}</>;
}

function useServerConfigSync(attempt: number) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const [state, setState] = useState<{ ready: boolean; error: string }>({ ready: false, error: "" });

    useEffect(() => {
        let active = true;
        let saveTimer = 0;
        let unsubscribeConfig: () => void = () => undefined;
        let unsubscribePromptSources: () => void = () => undefined;
        let saveQueue = Promise.resolve();

        setState({ ready: false, error: "" });

        const reportSaveError = (reason: unknown) => {
            if (!active) return;
            const detail = reason instanceof Error ? reason.message : t("config.serverStorage.saveFailed");
            message.open({ key: "server-config-save", type: "error", content: `${t("config.serverStorage.saveFailed")}：${detail}` });
        };
        const scheduleSave = () => {
            window.clearTimeout(saveTimer);
            saveTimer = window.setTimeout(() => {
                const snapshot = createAppConfigSnapshot();
                saveQueue = saveQueue.catch(() => undefined).then(() => saveServerConfig(snapshot)).catch(reportSaveError);
            }, 500);
        };

        void (async () => {
            try {
                await Promise.all([waitForStoreHydration(useConfigStore), waitForStoreHydration(usePromptSourceStore)]);
                const serverConfig = await loadServerConfig();
                if (!active) return;
                if (serverConfig) applyServerConfig(serverConfig);
                else await saveServerConfig(createAppConfigSnapshot());
                if (!active) return;

                let previousConfig = useConfigStore.getState().config;
                let previousWebdav = useConfigStore.getState().webdav;
                let previousSources = usePromptSourceStore.getState().sources;
                let previousSchedule = usePromptSourceStore.getState().schedule;
                unsubscribeConfig = useConfigStore.subscribe((next) => {
                    if (next.config === previousConfig && next.webdav === previousWebdav) return;
                    previousConfig = next.config;
                    previousWebdav = next.webdav;
                    scheduleSave();
                });
                unsubscribePromptSources = usePromptSourceStore.subscribe((next) => {
                    if (next.sources === previousSources && next.schedule === previousSchedule) return;
                    previousSources = next.sources;
                    previousSchedule = next.schedule;
                    scheduleSave();
                });
                setState({ ready: true, error: "" });
            } catch (reason) {
                if (!active) return;
                setState({ ready: false, error: reason instanceof Error ? reason.message : t("config.serverStorage.loadFailed") });
            }
        })();

        return () => {
            active = false;
            window.clearTimeout(saveTimer);
            unsubscribeConfig();
            unsubscribePromptSources();
        };
    }, [attempt, message, t]);

    return state;
}

function waitForStoreHydration(store: { persist: { hasHydrated: () => boolean; onFinishHydration: (listener: () => void) => () => void } }) {
    if (store.persist.hasHydrated()) return Promise.resolve();
    return new Promise<void>((resolve) => {
        const unsubscribe = store.persist.onFinishHydration(() => {
            unsubscribe();
            resolve();
        });
    });
}
