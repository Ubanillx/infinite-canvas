import fs from "node:fs/promises";
import path from "node:path";

import type { AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

import { logger } from "../../utils/logger.js";
import { errorMessage } from "../../utils/value.js";

/** 服务器配置里可用于对话的渠道字段。 */
export type PiChannel = { id: string; name: string; baseUrl: string; apiKey: string; apiFormat: string; models: Array<{ name: string; capability: string }> };
export type PiModelOption = { id: string; model: string; displayName: string; defaultReasoningEffort: string; supportedReasoningEfforts: Array<{ reasoningEffort: string }>; isDefault?: boolean };
export type PiResolvedModel = { model: Model<any>; apiKey: string };

const MODEL_SEPARATOR = "::";
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;
const REASONING_EFFORTS = ["low", "medium", "high"];

/** 与 web 服务共享的服务器配置文件：容器内是 /data，本机是 ~/.infinite-canvas/data。 */
export function serverConfigFile() {
    const dataDir = process.env.INFINITE_CANVAS_DATA_DIR || path.join(process.env.HOME || process.env.USERPROFILE || ".", ".infinite-canvas", "data");
    return path.join(dataDir, "config.json");
}

/** 读取服务器配置里带密钥的渠道；读取失败时返回空数组，由调用方提示未配置。 */
export async function readPiChannels(): Promise<PiChannel[]> {
    try {
        const raw = JSON.parse(await fs.readFile(serverConfigFile(), "utf8")) as { config?: { channels?: unknown } };
        const channels = Array.isArray(raw.config?.channels) ? raw.config.channels : [];
        return channels.flatMap((item): PiChannel[] => {
            if (!item || typeof item !== "object") return [];
            const channel = item as Record<string, unknown>;
            const baseUrl = typeof channel.baseUrl === "string" ? channel.baseUrl.trim() : "";
            const apiKey = typeof channel.apiKey === "string" ? channel.apiKey : "";
            const models = Array.isArray(channel.models) ? channel.models.flatMap((model) => {
                const value = model && typeof model === "object" ? model as Record<string, unknown> : {};
                const name = typeof value.name === "string" ? value.name.trim() : "";
                return name ? [{ name, capability: String(value.capability || "") }] : [];
            }) : [];
            return baseUrl && apiKey && models.length ? [{ id: String(channel.id || ""), name: String(channel.name || ""), baseUrl, apiKey, apiFormat: String(channel.apiFormat || "openai"), models }] : [];
        });
    } catch (error) {
        logger.debug("Pi channels unavailable", { error: errorMessage(error) });
        return [];
    }
}

/** 列出可用于对话的文本模型；值与 web 端 `channelId::model` 编码保持一致。 */
export function piModelOptions(channels: PiChannel[]): PiModelOption[] {
    return textModels(channels).map(({ channel, model }) => ({
        id: `${channel.id}${MODEL_SEPARATOR}${model}`,
        model: `${channel.id}${MODEL_SEPARATOR}${model}`,
        displayName: `${model}（${channel.name}）`,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: REASONING_EFFORTS.map((reasoningEffort) => ({ reasoningEffort })),
    }));
}

/** 解析面板提交的 `channelId::model`，未指定时退回第一个可用文本模型。 */
export function resolvePiModel(channels: PiChannel[], value: string): PiResolvedModel {
    const index = value.indexOf(MODEL_SEPARATOR);
    const channelId = index < 0 ? "" : value.slice(0, index);
    const modelName = index < 0 ? value : value.slice(index + MODEL_SEPARATOR.length);
    const candidates = textModels(channels);
    const matched = candidates.find((item) => (!channelId || item.channel.id === channelId) && (!modelName || item.model === modelName)) || candidates[0];
    if (!matched) throw new Error("当前没有可用于对话的文本模型，请先在配置中添加文本渠道");
    return { model: buildModel(matched.channel, matched.model), apiKey: matched.channel.apiKey };
}

/** 按模型 api 懒加载流式适配器，避免把未使用的供应商 SDK 拉进进程。 */
export async function streamFor(model: Model<any>, context: Context, options: SimpleStreamOptions): Promise<AssistantMessageEventStream> {
    const adapter = model.api === "google-generative-ai"
        ? await import("@earendil-works/pi-ai/api/google-generative-ai")
        : await import("@earendil-works/pi-ai/api/openai-completions");
    return adapter.streamSimple(model as never, context as never, options);
}

function textModels(channels: PiChannel[]) {
    return channels.flatMap((channel) => channel.models
        .filter((model) => model.capability === "text" && channel.apiFormat !== "custom")
        .map((model) => ({ channel, model: model.name })));
}

/**
 * 构造 pi 模型定义。`compat` 必须显式指定：默认适配器会发送 store、developer role 和
 * max_completion_tokens，这些字段会被多数 OpenAI 兼容中转网关拒绝。
 */
function buildModel(channel: PiChannel, modelName: string): Model<any> {
    const gemini = channel.apiFormat === "gemini";
    return {
        id: modelName,
        name: `${modelName}（${channel.name}）`,
        api: gemini ? "google-generative-ai" : "openai-completions",
        provider: "infinite-canvas",
        baseUrl: providerBaseUrl(channel.baseUrl, channel.apiFormat),
        input: ["text", "image"],
        reasoning: !gemini,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        maxTokens: DEFAULT_MAX_TOKENS,
        ...(gemini ? {} : {
            compat: {
                supportsStore: false,
                supportsDeveloperRole: false,
                supportsReasoningEffort: true,
                // 保留 include_usage，否则面板的 Token 统计恒为 0。
                supportsUsageInStreaming: true,
                maxTokensField: "max_tokens" as const,
            },
        }),
    };
}

/** 按渠道格式补全版本路径，与 web 端 `buildAiRequestUrl` 规则一致。 */
function providerBaseUrl(baseUrl: string, apiFormat: string) {
    const normalized = baseUrl.trim().replace(/\/+$/, "");
    const lower = normalized.toLowerCase();
    if (apiFormat === "gemini") return lower.endsWith("/v1") || lower.endsWith("/v1beta") ? normalized : `${normalized}/v1beta`;
    if (apiFormat === "ark") return lower.endsWith("/api/v3") || lower.endsWith("/api/plan/v3") ? normalized : `${normalized}/api/v3`;
    return lower.endsWith("/v1") ? normalized : `${normalized}/v1`;
}
