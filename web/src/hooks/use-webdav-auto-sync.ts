import { useEffect } from "react";

import { getWebdavAutoSyncStatus, isWebdavConfigured, syncAssetsToWebdav } from "@/services/webdav-auto-sync";
import { getActiveWorkspace } from "@/lib/workspace";
import { useConfigStore } from "@/stores/use-config-store";

const ASSET_SYNC_INTERVAL_MS = 5 * 60_000;

export function useWebdavAutoSync() {
    useEffect(() => {
        const canSync = () => Boolean(getActiveWorkspace()) && isWebdavConfigured(useConfigStore.getState().webdav);
        const syncAssets = () => {
            if (getWebdavAutoSyncStatus().state === "syncing") return;
            if (canSync()) void syncAssetsToWebdav().catch(() => undefined);
        };

        const interval = window.setInterval(syncAssets, ASSET_SYNC_INTERVAL_MS);
        window.addEventListener("online", syncAssets);

        return () => {
            window.clearInterval(interval);
            window.removeEventListener("online", syncAssets);
        };
    }, []);
}
