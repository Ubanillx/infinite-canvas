import { useEffect } from "react";

import { getWebdavAutoSyncStatus, isWebdavConfigured, syncAllDataToWebdav, syncConfigToWebdav } from "@/services/webdav-auto-sync";
import { useAssetStore } from "@/stores/use-asset-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useConfigStore } from "@/stores/use-config-store";
import { usePromptSourceStore } from "@/stores/use-prompt-source-store";

const CONFIG_DEBOUNCE_MS = 1000;
const DATA_DEBOUNCE_MS = 10000;

export function useWebdavAutoSync() {
    const enabled = useConfigStore((state) => state.webdav.autoSyncEnabled);
    const intervalMinutes = useConfigStore((state) => state.webdav.autoSyncIntervalMinutes);

    useEffect(() => {
        if (!enabled) return;
        let configTimer = 0;
        let dataTimer = 0;
        let configPending = false;
        let dataPending = false;

        const canSync = () => isWebdavConfigured(useConfigStore.getState().webdav);
        const syncConfig = () => {
            configPending = false;
            if (canSync()) void syncConfigToWebdav().catch(() => undefined);
        };
        const syncData = () => {
            dataPending = false;
            if (canSync()) void syncAllDataToWebdav().catch(() => undefined);
        };
        const scheduleConfig = () => {
            configPending = true;
            window.clearTimeout(configTimer);
            configTimer = window.setTimeout(syncConfig, CONFIG_DEBOUNCE_MS);
        };
        const scheduleData = () => {
            if (getWebdavAutoSyncStatus().state === "syncing") return;
            dataPending = true;
            window.clearTimeout(dataTimer);
            dataTimer = window.setTimeout(syncData, DATA_DEBOUNCE_MS);
        };

        let previousConfigSignature = configSignature();
        const unsubscribeConfig = useConfigStore.subscribe(() => {
            const signature = configSignature();
            if (signature === previousConfigSignature) return;
            previousConfigSignature = signature;
            scheduleConfig();
        });
        let previousSources = usePromptSourceStore.getState().sources;
        let previousSchedule = usePromptSourceStore.getState().schedule;
        const unsubscribeSources = usePromptSourceStore.subscribe((next) => {
            if (next.sources === previousSources && next.schedule === previousSchedule) return;
            previousSources = next.sources;
            previousSchedule = next.schedule;
            scheduleConfig();
        });
        let previousProjects = useCanvasStore.getState().projects;
        const unsubscribeCanvas = useCanvasStore.subscribe((next) => {
            if (next.projects === previousProjects) return;
            previousProjects = next.projects;
            scheduleData();
        });
        let previousAssets = useAssetStore.getState().assets;
        const unsubscribeAssets = useAssetStore.subscribe((next) => {
            if (next.assets === previousAssets) return;
            previousAssets = next.assets;
            scheduleData();
        });

        const interval = window.setInterval(syncData, Math.max(1, intervalMinutes || 5) * 60_000);
        const handleOnline = () => {
            syncConfig();
            syncData();
        };
        const flushPending = () => {
            if (document.visibilityState !== "hidden") return;
            if (configPending) {
                window.clearTimeout(configTimer);
                syncConfig();
            }
            if (dataPending) {
                window.clearTimeout(dataTimer);
                syncData();
            }
        };
        window.addEventListener("online", handleOnline);
        document.addEventListener("visibilitychange", flushPending);
        scheduleConfig();
        scheduleData();

        return () => {
            window.clearTimeout(configTimer);
            window.clearTimeout(dataTimer);
            window.clearInterval(interval);
            window.removeEventListener("online", handleOnline);
            document.removeEventListener("visibilitychange", flushPending);
            unsubscribeConfig();
            unsubscribeSources();
            unsubscribeCanvas();
            unsubscribeAssets();
        };
    }, [enabled, intervalMinutes]);
}

function configSignature() {
    const { config, webdav } = useConfigStore.getState();
    const { lastSyncedAt: _lastSyncedAt, lastConfigSyncedAt: _lastConfigSyncedAt, ...settings } = webdav;
    return JSON.stringify({ config, webdav: settings });
}
