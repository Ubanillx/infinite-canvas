import i18n from "@/i18n";
import { countUserPreferenceOverrides, normalizeUserPreferences, userPreferenceDefaults, userPreferenceKeys, userPreferenceOverrides, type UserPreferenceKey, type UserPreferences } from "@/lib/user-preferences";
import { selectableModelsByCapability, useConfigStore, type AiConfig, type ModelCapability } from "@/stores/use-config-store";

const preferencesUrl = "/api/preferences";
const modelPreferenceKeys: Array<[UserPreferenceKey, ModelCapability]> = [
    ["imageModel", "image"],
    ["videoModel", "video"],
    ["textModel", "text"],
    ["audioModel", "audio"],
];

let defaults: AiConfig | null = null;
let muted = false;

export function setUserPreferenceDefaults(config: AiConfig) {
    defaults = config;
}

function getUserPreferenceOverrides() {
    return defaults ? userPreferenceOverrides(useConfigStore.getState().config, defaults) : {};
}

export function getUserPreferenceOverrideCount(config: AiConfig) {
    return defaults ? countUserPreferenceOverrides(config, defaults) : 0;
}

export async function loadUserPreferences(): Promise<UserPreferences> {
    const response = await fetch(preferencesUrl, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!response.ok) throw new Error(i18n.t("config.personalPreferences.loadFailed"));
    const data = (await response.json().catch(() => null)) as { preferences?: unknown } | null;
    return normalizeUserPreferences(data?.preferences) || {};
}

export function applyUserPreferences(preferences: UserPreferences) {
    if (!defaults) return;
    const base = defaults;
    const next: UserPreferences = { ...preferences };
    let dropped = false;
    for (const [key, capability] of modelPreferenceKeys) {
        const value = next[key];
        if (typeof value !== "string") continue;
        if (!value || !selectableModelsByCapability(base, capability).includes(value)) {
            delete next[key];
            dropped = true;
        }
    }
    if (typeof next.model === "string" && (!next.model || !selectableModelsByCapability(base).includes(next.model))) {
        delete next.model;
        dropped = true;
    }
    for (const key of userPreferenceKeys) {
        if (key in next && next[key] === base[key]) {
            delete next[key];
            dropped = true;
        }
    }
    muted = true;
    try {
        useConfigStore.setState((state) => ({ config: { ...state.config, ...next } }));
    } finally {
        muted = false;
    }
    if (dropped) scheduleSave();
}

export function resetUserPreferences() {
    if (!defaults) return;
    const next = userPreferenceDefaults(defaults);
    muted = true;
    try {
        useConfigStore.setState((state) => ({ config: { ...state.config, ...next } }));
    } finally {
        muted = false;
    }
    scheduleSave();
}

type PreferencesSaveStatus = { saving: boolean; error: string };
let saveStatus: PreferencesSaveStatus = { saving: false, error: "" };
const saveStatusListeners = new Set<() => void>();

export function getUserPreferencesSaveStatus() {
    return saveStatus;
}

export function subscribeUserPreferencesSaveStatus(listener: () => void) {
    saveStatusListeners.add(listener);
    return () => { saveStatusListeners.delete(listener); };
}

function updateSaveStatus(status: PreferencesSaveStatus) {
    saveStatus = status;
    saveStatusListeners.forEach((listener) => listener());
}

let changed = 0;
let saved = 0;
let writing = false;

export async function saveUserPreferencesNow() {
    changed++;
    updateSaveStatus({ saving: true, error: "" });
    void flushUserPreferences();
    await waitForUserPreferencesSave();
}

export async function waitForUserPreferencesSave() {
    if (saveStatus.saving) await new Promise<void>((resolve) => {
        const unsubscribe = subscribeUserPreferencesSaveStatus(() => {
            if (saveStatus.saving) return;
            unsubscribe();
            resolve();
        });
    });
    if (saveStatus.error) throw new Error(saveStatus.error);
}

export function retryUserPreferencesSave() {
    void flushUserPreferences();
}

export function startUserPreferencesAutoSave() {
    return useConfigStore.subscribe((current, previous) => {
        if (!muted && current.config !== previous.config) scheduleSave();
    });
}

function scheduleSave() {
    if (!defaults) return;
    changed++;
    updateSaveStatus({ saving: true, error: "" });
    queueMicrotask(() => { void flushUserPreferences(); });
}

async function flushUserPreferences() {
    if (writing || changed === saved) return;
    writing = true;
    updateSaveStatus({ saving: true, error: "" });
    try {
        while (saved !== changed) {
            const version = changed;
            await putUserPreferences(getUserPreferenceOverrides());
            saved = version;
        }
        updateSaveStatus({ saving: false, error: "" });
    } catch (error) {
        updateSaveStatus({ saving: false, error: error instanceof Error ? error.message : i18n.t("config.personalPreferences.saveFailed") });
    } finally {
        writing = false;
    }
}

async function putUserPreferences(preferences: UserPreferences) {
    const response = await fetch(preferencesUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preferences }),
    });
    if (!response.ok) throw new Error(i18n.t("config.personalPreferences.saveFailed"));
}
