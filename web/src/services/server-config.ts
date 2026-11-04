import i18n from "@/i18n";
import { createAppConfigSnapshot, isAppConfigFile, markServerConfigSaved, type AppConfigFile } from "@/services/config-file";
import { useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { usePromptSourceStore } from "@/stores/use-prompt-source-store";

const serverConfigUrl = "/api/config";
const runtimeConfigUrl = "/api/config/runtime";
const localPreferencesPrefix = "infinite-canvas:user-config-preferences:";
const localPreferenceKeys = [
    "model",
    "imageModel",
    "videoModel",
    "textModel",
    "audioModel",
    "audioVoice",
    "audioFormat",
    "audioSpeed",
    "audioInstructions",
    "videoSeconds",
    "vquality",
    "videoGenerateAudio",
    "videoWatermark",
    "videoMode",
    "systemPrompt",
    "reasoningEffort",
    "quality",
    "size",
    "background",
    "count",
    "canvasImageCount",
    "proxyEnabled",
    "proxyUrl",
    "nodeRegenerateBehavior",
    "autoFocusOnSelect",
] as const satisfies ReadonlyArray<keyof AiConfig>;

type LocalPreferences = Partial<Pick<AiConfig, (typeof localPreferenceKeys)[number]>>;
let cachedServerConfig: { runtime: boolean; request: Promise<AppConfigFile | null> } | null = null;

export function loadServerConfig(options: { force?: boolean; runtime?: boolean } = {}) {
    const runtime = Boolean(options.runtime);
    if (options.force) cachedServerConfig = null;
    if (cachedServerConfig?.runtime === runtime) return cachedServerConfig.request;

    const request = (async () => {
        const response = await fetch(runtime ? runtimeConfigUrl : serverConfigUrl, { headers: { Accept: "application/json" }, cache: "no-store" });
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
        cachedServerConfig = null;
        throw error;
    });
    cachedServerConfig = { runtime, request };
    return request;
}

export function applyLocalConfigPreferences(userId: string) {
    const stored = readLocalPreferences(userId);
    const overrides: Partial<AiConfig> = {};
    for (const key of localPreferenceKeys) {
        if (key in stored) Object.assign(overrides, { [key]: stored[key] });
    }
    if (Object.keys(overrides).length) useConfigStore.setState((state) => ({ config: { ...state.config, ...overrides } }));
}

export function startLocalConfigPersistence(userId: string) {
    return useConfigStore.subscribe((current, previous) => {
        if (current.config === previous.config) return;
        const preferences: Record<string, AiConfig[keyof AiConfig]> = {};
        for (const key of localPreferenceKeys) preferences[key] = current.config[key];
        try {
            window.localStorage.setItem(`${localPreferencesPrefix}${userId}`, JSON.stringify(preferences));
        } catch {
            // Storage may be unavailable in private or restricted browser contexts.
        }
    });
}

function readLocalPreferences(userId: string): LocalPreferences {
    try {
        const value = JSON.parse(window.localStorage.getItem(`${localPreferencesPrefix}${userId}`) || "null");
        return value && typeof value === "object" ? (value as LocalPreferences) : {};
    } catch {
        return {};
    }
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
    cachedServerConfig = null;
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
