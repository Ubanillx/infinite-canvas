import fs from "node:fs/promises";
import path from "node:path";

import type { AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";

import { logger } from "../../utils/logger.js";
import { errorMessage } from "../../utils/value.js";

/** 服务器配置里可用于对话的渠道字段。 */
export type PiChannelModel = {
    name: string;
    capability: string;
    /** 显式协议覆盖；没有时根据渠道和模型能力推断。 */
    apiFormat?: string;
    endpointTypes?: string[];
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: boolean;
    input?: Array<"text" | "image">;
};
export type PiChannel = { id: string; name: string; baseUrl: string; apiKey: string; apiFormat: string; models: PiChannelModel[] };
export type PiModelOption = { id: string; model: string; displayName: string; defaultReasoningEffort: string; supportedReasoningEfforts: Array<{ reasoningEffort: string }>; isDefault?: boolean };
export type PiResolvedModel = { model: Model<any>; apiKey: string };

const MODEL_SEPARATOR = "::";
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;
const modelDiscoveryCache = new Map<string, PiChannelModel[]>();
const modelDiscoveryPending = new Map<string, Promise<PiChannelModel[]>>();
const catalog = new Map<string, Model<any>>();
// Prefer native catalogs to aggregator entries with provider-specific limits.
for (const provider of ["openai", "deepseek", "google", "zai", "moonshotai", "xai", ...getBuiltinProviders()]) {
    for (const model of getBuiltinModels(provider as ReturnType<typeof getBuiltinProviders>[number])) {
        if (!catalog.has(model.id)) catalog.set(model.id, model);
    }
}

/** 与 web 服务共享的服务器配置文件：容器内是 /data，本机是 ~/.infinite-canvas/data。 */
export function serverConfigFile() {
    const dataDir = process.env.INFINITE_CANVAS_DATA_DIR || path.join(process.env.HOME || process.env.USERPROFILE || ".", ".infinite-canvas", "data");
    return path.join(dataDir, "config.json");
}

/** 读取服务器配置里带密钥的渠道；读取失败时返回空数组，由调用方提示未配置。 */
export async function readPiChannels(refreshModels = false): Promise<PiChannel[]> {
    try {
        const raw = JSON.parse(await fs.readFile(serverConfigFile(), "utf8")) as { config?: { channels?: unknown } };
        const rows = Array.isArray(raw.config?.channels) ? raw.config.channels : [];
        const channels = rows.flatMap((item): PiChannel[] => {
            if (!item || typeof item !== "object") return [];
            const channel = item as Record<string, unknown>;
            const baseUrl = typeof channel.baseUrl === "string" ? channel.baseUrl.trim() : "";
            const apiKey = typeof channel.apiKey === "string" ? channel.apiKey : "";
            const configuredModels = Array.isArray(channel.models) ? channel.models.flatMap((model): PiChannelModel[] => {
                const value = model && typeof model === "object" ? model as Record<string, unknown> : {};
                const name = typeof value.name === "string" ? value.name.trim() : "";
                if (!name) return [];
                const endpointTypes = Array.isArray(value.endpointTypes) ? value.endpointTypes.map(String) : undefined;
                return [{
                    name,
                    capability: String(value.capability || ""),
                    ...(typeof value.apiFormat === "string" ? { apiFormat: value.apiFormat } : {}),
                    ...(endpointTypes?.length ? { endpointTypes } : {}),
                    ...(numberValue(value.contextWindow) ? { contextWindow: numberValue(value.contextWindow) } : {}),
                    ...(numberValue(value.maxTokens) ? { maxTokens: numberValue(value.maxTokens) } : {}),
                    ...(typeof value.reasoning === "boolean" ? { reasoning: value.reasoning } : {}),
                    ...(Array.isArray(value.input) ? { input: value.input.filter((input): input is "text" | "image" => input === "text" || input === "image") } : {}),
                }];
            }) : [];
            if (!baseUrl || !apiKey) return [];
            const apiFormat = String(channel.apiFormat || "openai");
            return [{ id: String(channel.id || ""), name: String(channel.name || ""), baseUrl, apiKey, apiFormat, models: configuredModels }];
        });
        const resolved = await Promise.all(channels.map(async (channel) => {
            const discovered = await discoverModels(channel, refreshModels);
            if (!discovered.length) return channel;
            return { ...channel, models: mergeModels(channel.models, discovered) };
        }));
        return resolved.filter((channel) => channel.models.length);
    } catch (error) {
        logger.debug("Pi channels unavailable", { error: errorMessage(error) });
        return [];
    }
}

/** 列出可用于对话的文本模型；值与 web 端 `channelId::model` 编码保持一致。 */
export function piModelOptions(channels: PiChannel[]): PiModelOption[] {
    return textModels(channels).map(({ channel, model }) => {
        const resolved = buildModel(channel, model);
        const efforts = getSupportedThinkingLevels(resolved).map((level) => level === "off" ? "none" : level);
        return {
            id: `${channel.id}${MODEL_SEPARATOR}${model}`,
            model: `${channel.id}${MODEL_SEPARATOR}${model}`,
            displayName: `${model}（${channel.name}）`,
            defaultReasoningEffort: efforts.includes("medium") ? "medium" : efforts[0],
            supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })),
        };
    });
}

/** 解析面板提交的 `channelId::model`，未指定时退回第一个可用文本模型。 */
export function resolvePiModel(channels: PiChannel[], value: string): PiResolvedModel {
    const index = value.indexOf(MODEL_SEPARATOR);
    const channelId = index < 0 ? "" : value.slice(0, index);
    const modelName = index < 0 ? value : value.slice(index + MODEL_SEPARATOR.length);
    const candidates = textModels(channels);
    const matched = value ? candidates.find((item) => (!channelId || item.channel.id === channelId) && item.model === modelName) : candidates[0];
    if (!matched) throw new Error(value ? "所选文本模型不可用，请重新选择模型或检查渠道密钥" : "当前没有可用于对话的文本模型，请先在配置中添加文本渠道及 API Key");
    return { model: buildModel(matched.channel, matched.model), apiKey: matched.channel.apiKey };
}

/** 按模型 api 懒加载流式适配器，避免把未使用的供应商 SDK 拉进进程。 */
export async function streamFor(model: Model<any>, context: Context, options: SimpleStreamOptions): Promise<AssistantMessageEventStream> {
    const adapter = model.api === "google-generative-ai"
        ? await import("@earendil-works/pi-ai/api/google-generative-ai")
        : model.api === "openai-responses"
            ? await import("@earendil-works/pi-ai/api/openai-responses")
            : await import("@earendil-works/pi-ai/api/openai-completions");
    return adapter.streamSimple(model as never, context as never, options);
}

function textModels(channels: PiChannel[]) {
    return channels.flatMap((channel) => channel.models
        .filter((model) => model.capability === "text" && channel.apiFormat !== "custom")
        .map((model) => ({ channel, model: model.name })));
}

/**
 * 上游元数据优先决定协议，Pi 内置目录补充精确型号的能力和参数。
 */
function buildModel(channel: PiChannel, modelName: string): Model<any> {
    const selected = channel.models.find((item) => item.name === modelName);
    const gemini = channel.apiFormat === "gemini" || selected?.apiFormat === "gemini";
    const api = gemini ? "google-generative-ai" : protocolFor(channel, selected, modelName);
    const known = catalogModel(modelName);
    const id = modelName.toLowerCase();
    const reasoning = selected?.reasoning ?? known?.reasoning ?? /gpt-[5-9]|\bo[134](?:-|$)|deepseek|qwen3|glm-5|kimi-k[23]|grok-4|thinking|reasoner/.test(id);
    const nativeCompat = known?.api === api ? known.compat : undefined;
    const completionCompat = known?.api === "openai-completions" ? (known as Model<"openai-completions">).compat : undefined;
    return {
        id: modelName,
        name: `${modelName}（${channel.name}）`,
        api,
        provider: "infinite-canvas",
        baseUrl: providerBaseUrl(channel.baseUrl, channel.apiFormat),
        input: selected?.input || known?.input || ["text", "image"],
        reasoning,
        ...(known?.thinkingLevelMap ? { thinkingLevelMap: known.thinkingLevelMap } : {}),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: selected?.contextWindow || known?.contextWindow || DEFAULT_CONTEXT_WINDOW,
        maxTokens: selected?.maxTokens || known?.maxTokens || DEFAULT_MAX_TOKENS,
        ...(gemini ? {} : {
            compat: {
                ...nativeCompat,
                supportsDeveloperRole: false,
                ...(api === "openai-completions" ? {
                    supportsStore: false,
                    supportsReasoningEffort: completionCompat?.supportsReasoningEffort ?? reasoning,
                    // 保留 include_usage，否则面板的 Token 统计恒为 0。
                    supportsUsageInStreaming: true,
                    maxTokensField: /^gpt-|^o[134](?:-|$)/.test(id) && reasoning ? "max_completion_tokens" as const : "max_tokens" as const,
                    ...(nativeCompat || /gpt|^o[134](?:-|$)/.test(id) ? {} : {
                        // Gateways expose OpenAI fields even for native non-OpenAI models.
                        requiresReasoningContentOnAssistantMessages: /deepseek|kimi|glm/.test(id),
                    }),
                } : {}),
            },
        }),
    };
}

/** 根据渠道元数据优先选择协议；没有元数据时按模型 ID 推断。 */
function protocolFor(channel: PiChannel, selected: PiChannelModel | undefined, modelName: string) {
    if (selected?.apiFormat === "openai-responses") return "openai-responses" as const;
    if (selected?.apiFormat === "openai-completions") return "openai-completions" as const;
    const endpointTypes = selected?.endpointTypes || [];
    if (endpointTypes.some((item) => /^(openai-response|openai-responses|responses)$/i.test(item))) return "openai-responses" as const;
    if (endpointTypes.some((item) => /^openai$/i.test(item))) return "openai-completions" as const;
    if (channel.apiFormat === "ark" || channel.apiFormat === "custom") return "openai-completions" as const;
    return inferOpenAiProtocol(modelName);
}

/** 无协议元数据时，目录和 OpenAI 模型族使用 Responses，其余走 Chat Completions。 */
export function inferOpenAiProtocol(modelName: string): "openai-responses" | "openai-completions" {
    const api = catalogModel(modelName)?.api;
    if (api === "openai-responses" || api === "openai-completions") return api;
    return /gpt-(?!oss)|(?:^|\/)o[134](?:-|$)|codex/i.test(modelName) ? "openai-responses" : "openai-completions";
}

function catalogModel(name: string) {
    return catalog.get(name) || catalog.get(name.slice(name.lastIndexOf("/") + 1));
}

async function discoverModels(channel: PiChannel, refresh: boolean): Promise<PiChannelModel[]> {
    if (channel.apiFormat === "custom" || channel.apiFormat === "gemini") return [];
    const key = `${channel.id}\0${channel.baseUrl}\0${channel.apiFormat}\0${channel.apiKey}`;
    const cached = modelDiscoveryCache.get(key);
    const pending = modelDiscoveryPending.get(key);
    if (pending) return pending;
    if (!refresh) return cached || [];
    const request = fetchDiscoveredModels(channel).then((models) => {
        if (models) modelDiscoveryCache.set(key, models);
        return models || cached || [];
    }).finally(() => modelDiscoveryPending.delete(key));
    modelDiscoveryPending.set(key, request);
    return request;
}

async function fetchDiscoveredModels(channel: PiChannel): Promise<PiChannelModel[] | null> {
    try {
        const response = await fetch(`${providerBaseUrl(channel.baseUrl, channel.apiFormat)}/models`, {
            headers: { Authorization: `Bearer ${channel.apiKey}`, Accept: "application/json" },
        });
        if (!response.ok) return null;
        const payload = await response.json() as { data?: unknown; models?: unknown };
        const rows = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
        return rows.flatMap((row): PiChannelModel[] => {
            if (!row || typeof row !== "object") return [];
            const value = row as Record<string, unknown>;
            const name = String(value.id || value.name || "").replace(/^models\//, "").trim();
            if (!name) return [];
            const endpointTypes = [...arrayOfStrings(value.supported_endpoint_types), ...arrayOfStrings(value.supportedEndpointTypes)];
            const capability = modelCapability(name, endpointTypes, value);
            return [{
                name,
                capability,
                ...(endpointTypes.length ? { endpointTypes } : {}),
                ...(numberValue(value.context_length || value.contextWindow) ? { contextWindow: numberValue(value.context_length || value.contextWindow) } : {}),
                ...(numberValue(value.max_output_tokens || value.maxTokens) ? { maxTokens: numberValue(value.max_output_tokens || value.maxTokens) } : {}),
            }];
        });
    } catch (error) {
        logger.debug("Pi model discovery unavailable", { channel: channel.id, error: errorMessage(error) });
        return null;
    }
}

function mergeModels(configured: PiChannelModel[], discovered: PiChannelModel[]) {
    const merged = new Map(configured.map((model) => [model.name, model]));
    discovered.forEach((model) => merged.set(model.name, { ...model, ...merged.get(model.name) }));
    return [...merged.values()];
}

function modelCapability(name: string, endpointTypes: string[], value: Record<string, unknown>) {
    const capabilities = [...endpointTypes, ...arrayOfStrings(value.capabilities), ...arrayOfStrings(value.supported_generation_methods)].join(" ").toLowerCase();
    if (/image-generation|embedding|audio|speech|video|rerank|moderation|tts/.test(capabilities) || /image|embed|audio|video|tts|rerank|nano-banana/.test(name.toLowerCase())) return "other";
    return "text";
}

function arrayOfStrings(value: unknown) {
    return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function numberValue(value: unknown) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
}

/** 按渠道格式补全版本路径，与 web 端 `buildAiRequestUrl` 规则一致。 */
function providerBaseUrl(baseUrl: string, apiFormat: string) {
    const normalized = baseUrl.trim().replace(/\/+$/, "");
    const lower = normalized.toLowerCase();
    if (apiFormat === "gemini") return lower.endsWith("/v1") || lower.endsWith("/v1beta") ? normalized : `${normalized}/v1beta`;
    if (apiFormat === "ark") return lower.endsWith("/api/v3") || lower.endsWith("/api/plan/v3") ? normalized : `${normalized}/api/v3`;
    return lower.endsWith("/v1") ? normalized : `${normalized}/v1`;
}
