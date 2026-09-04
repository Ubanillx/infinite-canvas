import { useEffect } from "react";

import { getWebdavAutoSyncStatus, isWebdavConfigured, syncAllDataToWebdav } from "@/services/webdav-auto-sync";
import { getActiveWorkspace } from "@/lib/workspace";
import { useAssetStore } from "@/stores/use-asset-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useConfigStore } from "@/stores/use-config-store";

const DATA_DEBOUNCE_MS = 10000;

export function useWebdavAutoSync() {
    const enabled = useConfigStore((state) => state.webdav.autoSyncEnabled);
    const intervalMinutes = useConfigStore((state) => state.webdav.autoSyncIntervalMinutes);

    useEffect(() => {
        if (!enabled) return;
        let dataTimer = 0;
        let dataPending = false;

        const canSync = () => Boolean(getActiveWorkspace()) && isWebdavConfigured(useConfigStore.getState().webdav);
        const syncData = () => {
            dataPending = false;
            if (canSync()) void syncAllDataToWebdav().catch(() => undefined);
        };
        const scheduleData = () => {
            if (getWebdavAutoSyncStatus().state === "syncing") return;
            dataPending = true;
            window.clearTimeout(dataTimer);
            dataTimer = window.setTimeout(syncData, DATA_DEBOUNCE_MS);
        };

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
            syncData();
        };
        const flushPending = () => {
            if (document.visibilityState !== "hidden") return;
            if (dataPending) {
                window.clearTimeout(dataTimer);
                syncData();
            }
        };
        window.addEventListener("online", handleOnline);
        document.addEventListener("visibilitychange", flushPending);
        scheduleData();

        return () => {
            window.clearTimeout(dataTimer);
            window.clearInterval(interval);
            window.removeEventListener("online", handleOnline);
            document.removeEventListener("visibilitychange", flushPending);
            unsubscribeCanvas();
            unsubscribeAssets();
        };
    }, [enabled, intervalMinutes]);
}
