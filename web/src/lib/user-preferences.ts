import type { AiConfig } from "@/stores/use-config-store";

export const userPreferenceKeys = [
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

export type UserPreferenceKey = (typeof userPreferenceKeys)[number];
export type UserPreferences = Partial<Pick<AiConfig, UserPreferenceKey>>;

const booleanPreferenceKeys = new Set<UserPreferenceKey>(["proxyEnabled", "autoFocusOnSelect"]);
const allowedPreferenceValues: Partial<Record<UserPreferenceKey, readonly string[]>> = {
    nodeRegenerateBehavior: ["new-node", "overwrite"],
    quality: ["auto", "low", "medium", "high", "xhigh", "max"],
    reasoningEffort: ["auto", "low", "medium", "high", "xhigh"],
    videoMode: ["frames", "reference"],
};

export function normalizeUserPreferences(value: unknown): UserPreferences | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const source = value as Record<string, unknown>;
    const preferences: Record<string, unknown> = {};
    for (const key of userPreferenceKeys) {
        if (!(key in source)) continue;
        const item = source[key];
        if (booleanPreferenceKeys.has(key)) {
            if (typeof item === "boolean") preferences[key] = item;
        } else if (typeof item === "string") {
            const allowed = allowedPreferenceValues[key];
            if (!allowed || allowed.includes(item)) preferences[key] = item;
        }
    }
    return preferences as UserPreferences;
}

export function userPreferenceOverrides(config: AiConfig, defaults: AiConfig): UserPreferences {
    const preferences: Record<string, unknown> = {};
    for (const key of userPreferenceKeys) {
        if (config[key] !== defaults[key]) preferences[key] = config[key];
    }
    return preferences as UserPreferences;
}

export function userPreferenceDefaults(defaults: AiConfig): UserPreferences {
    const preferences: Record<string, unknown> = {};
    for (const key of userPreferenceKeys) preferences[key] = defaults[key];
    return preferences as UserPreferences;
}

export function countUserPreferenceOverrides(config: AiConfig, defaults: AiConfig) {
    return userPreferenceKeys.reduce((count, key) => count + (config[key] !== defaults[key] ? 1 : 0), 0);
}
