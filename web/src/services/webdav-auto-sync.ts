import { syncAppDataToWebdav, type AppSyncProgress } from "@/services/app-sync";
import { createAppConfigSnapshot } from "@/services/config-file";
import { uploadWebdavConfigFile } from "@/services/webdav-sync";
import { useConfigStore, type WebdavSyncConfig } from "@/stores/use-config-store";

export type WebdavAutoSyncStatus = {
    state: "idle" | "syncing" | "success" | "error";
    reason: "config" | "data" | "manual";
    stage: string;
    syncedAt: string;
    error: string;
};

type StatusListener = (status: WebdavAutoSyncStatus) => void;

let queue = Promise.resolve<unknown>(undefined);
let status: WebdavAutoSyncStatus = { state: "idle", reason: "data", stage: "", syncedAt: "", error: "" };
const listeners = new Set<StatusListener>();

export function subscribeWebdavAutoSync(listener: StatusListener) {
    listeners.add(listener);
    listener(status);
    return () => {
        listeners.delete(listener);
    };
}

export function getWebdavAutoSyncStatus() {
    return status;
}

export function syncConfigToWebdav(config = useConfigStore.getState().webdav) {
    return enqueue("config", async () => {
        await uploadWebdavConfigFile(config, createAppConfigSnapshot());
        const syncedAt = new Date().toISOString();
        useConfigStore.getState().updateWebdavConfig("lastConfigSyncedAt", syncedAt);
        return syncedAt;
    });
}

export function syncAllDataToWebdav(config = useConfigStore.getState().webdav, reason: "data" | "manual" = "data", onProgress?: AppSyncProgress) {
    return enqueue(reason, async () => {
        const result = await syncAppDataToWebdav(config, (event) => {
            updateStatus({ stage: event.stage });
            onProgress?.(event);
        });
        useConfigStore.getState().updateWebdavConfig("lastSyncedAt", result.syncedAt);
        return result;
    });
}

export function isWebdavConfigured(config: WebdavSyncConfig) {
    return Boolean(config.url.trim() && config.directory.trim());
}

function enqueue<T>(reason: WebdavAutoSyncStatus["reason"], task: () => Promise<T>) {
    const run = async () => {
        updateStatus({ state: "syncing", reason, stage: "", error: "" });
        try {
            const result = await task();
            updateStatus({ state: "success", reason, stage: "", syncedAt: new Date().toISOString(), error: "" });
            return result;
        } catch (error) {
            updateStatus({ state: "error", reason, stage: "", error: error instanceof Error ? error.message : String(error) });
            throw error;
        }
    };
    const result = queue.catch(() => undefined).then(run);
    queue = result;
    return result;
}

function updateStatus(patch: Partial<WebdavAutoSyncStatus>) {
    status = { ...status, ...patch };
    listeners.forEach((listener) => listener(status));
}
