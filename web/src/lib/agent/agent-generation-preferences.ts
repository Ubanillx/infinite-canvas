import { inferMediaRatio, inferMediaScale } from "@/lib/media-size";
import { modelOptionLabel, modelOptionName, type AiConfig } from "@/stores/use-config-store";

export type AgentImageGenerationPreferences = {
    model: string;
    modelName: string;
    quality: string;
    size: string;
    resolution: string;
    aspectRatio: string;
    canvasCount: number;
    workbenchCount: number;
    background: "transparent" | "default";
};

export type AgentGenerationPreferences = {
    image: AgentImageGenerationPreferences;
};

export function buildAgentGenerationPreferences(config: AiConfig): AgentGenerationPreferences {
    const model = config.imageModel || config.model || "";
    const size = config.size || "1:1";
    return {
        image: {
            model,
            modelName: modelOptionName(model),
            quality: config.quality || "auto",
            size,
            resolution: inferMediaScale(size),
            aspectRatio: inferMediaRatio(size),
            canvasCount: normalizeCount(config.canvasImageCount || config.count),
            workbenchCount: normalizeCount(config.count),
            background: config.background === "transparent" ? "transparent" : "default",
        },
    };
}

export function formatAgentGenerationPreferences(preferences: AgentGenerationPreferences, config: AiConfig) {
    const image = preferences.image;
    const label = modelOptionLabel(config, image.model) || image.modelName || image.model;
    return [
        "\n\n[平台默认生图偏好]",
        "仅在用户本轮没有明确指定参数时使用以下默认值；用户本轮明确要求优先。",
        `默认模型：${label}（标识：${image.model || image.modelName}）`,
        `默认分辨率：${image.resolution}；默认比例：${image.aspectRatio}；默认尺寸：${image.size}`,
        `画布默认生成张数：${image.canvasCount}；生图工作台默认生成张数：${image.workbenchCount}`,
        `默认质量：${image.quality}；默认背景：${image.background === "transparent" ? "透明" : "按模型默认"}`,
        "创建画布生图配置、调用画布生成或调用生图工作台时，请优先沿用这些默认值。",
    ].join("\n");
}

function normalizeCount(value: string) {
    return Math.max(1, Math.min(15, Math.floor(Math.abs(Number(value)) || 1)));
}
