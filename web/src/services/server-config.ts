import i18n from "@/i18n";
import { createAppConfigSnapshot, isAppConfigFile, markServerConfigSaved, type AppConfigFile } from "@/services/config-file";
import { useConfigStore } from "@/stores/use-config-store";
import { usePromptSourceStore } from "@/stores/use-prompt-source-store";

const serverConfigUrl = "/api/config";
let cachedServerConfigRequest: Promise<AppConfigFile | null> | null = null;

export function loadServerConfig(options: { force?: boolean } = {}) {
    if (options.force) cachedServerConfigRequest = null;
    if (cachedServerConfigRequest) return cachedServerConfigRequest;

    cachedServerConfigRequest = (async () => {
        const response = await fetch(serverConfigUrl, { headers: { Accept: "application/json" }, cache: "no-store" });
        if (response.status === 204) return null;
        if (!response.ok) throw requestError(response.status);

        let data: unknown;
        try {
            data = await response.json();
        } catch {
            throw new Error(i18n.t("config.serverStorage.invalidResponse"));
        }
        if (!isAppConfigFile(data)) throw new Error(i18n.t("config.serverStorage.invalidResponse"));
        return data;
    })().catch((error) => {
        // Failed requests must remain retryable from the loading error view.
        cachedServerConfigRequest = null;
        throw error;
    });
    return cachedServerConfigRequest;
}

export async function saveServerConfig(config: AppConfigFile) {
    const response = await fetch(serverConfigUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
    });
    if (!response.ok) throw requestError(response.status);
    muted = true;
    try { markServerConfigSaved(config); } finally { muted = false; }
    cachedServerConfigRequest = null;
}

type SaveStatus = { saving: boolean; error: string };
let saveStatus: SaveStatus = { saving: false, error: "" };
const statusListeners = new Set<() => void>();

export function getServerConfigSaveStatus() { return saveStatus; }
export function subscribeServerConfigSaveStatus(listener: () => void) {
    statusListeners.add(listener);
    return () => { statusListeners.delete(listener); };
}
function updateSaveStatus(status: SaveStatus) {
    saveStatus = status;
    statusListeners.forEach((listener) => listener());
}

let changed = 0;
let saved = 0;
let writing = false;
let muted = false;

export function retryServerConfigSave() { void flushServerConfig(); }

export async function saveServerConfigNow() {
    changed++;
    updateSaveStatus({ saving: true, error: "" });
    void flushServerConfig();
    await waitForServerConfigSave();
}

export async function waitForServerConfigSave() {
    if (saveStatus.saving) await new Promise<void>((resolve) => {
        const unsubscribe = subscribeServerConfigSaveStatus(() => {
            if (saveStatus.saving) return;
            unsubscribe();
            resolve();
        });
    });
    if (saveStatus.error) throw new Error(saveStatus.error);
}

export function startServerConfigAutoSave() {
    const onConfigChange = (current: ReturnType<typeof useConfigStore.getState>, previous: ReturnType<typeof useConfigStore.getState>) => {
        if (!muted && (current.config !== previous.config || current.webdav !== previous.webdav)) scheduleSave();
    };
    const onSourcesChange = (current: ReturnType<typeof usePromptSourceStore.getState>, previous: ReturnType<typeof usePromptSourceStore.getState>) => {
        if (current.sources !== previous.sources || current.schedule !== previous.schedule) scheduleSave();
    };
    const stopConfig = useConfigStore.subscribe(onConfigChange);
    const stopSources = usePromptSourceStore.subscribe(onSourcesChange);
    void flushServerConfig();
    return () => { stopConfig(); stopSources(); };
}

function scheduleSave() {
    changed++;
    updateSaveStatus({ saving: true, error: "" });
    // Collect synchronous store updates (including a config import) into one snapshot.
    queueMicrotask(() => { void flushServerConfig(); });
}

async function flushServerConfig() {
    if (writing || changed === saved) return;
    writing = true;
    updateSaveStatus({ saving: true, error: "" });
    try {
        while (saved !== changed) {
            const version = changed;
            const snapshot = createAppConfigSnapshot();
            await saveServerConfig(snapshot);
            saved = version;
        }
        updateSaveStatus({ saving: false, error: "" });
    } catch (error) {
        updateSaveStatus({ saving: false, error: error instanceof Error ? error.message : i18n.t("config.serverStorage.saveFailed") });
    } finally {
        writing = false;
    }
}

function requestError(status: number) {
    return new Error(i18n.t("config.serverStorage.requestFailed", { status }));
}
