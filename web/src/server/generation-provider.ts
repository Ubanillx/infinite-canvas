import { Buffer } from "node:buffer";
import { computeVideoSize, imageSizePresets, inferVideoRatio, clampVideoSeconds } from "../lib/media-size";
import { openRemoteMedia } from "./remote-media";
import { GENERATION_JSON_LIMIT_BYTES, GENERATION_MEDIA_LIMIT_BYTES, readGenerationBytes } from "./generation-media";

export type GenerationChannel = {
    channelId: string;
    baseUrl: string;
    apiKey: string;
    apiFormat: "openai" | "gemini" | "ark" | "custom";
    model: string;
    script?: string;
};
export type ResolvedGenerationChannel = Omit<GenerationChannel, "channelId"> & { id: string };
export type GenerationReference = { bytes: Buffer; mimeType: string; name?: string };
export type GenerationRequest = { kind: "image" | "video" | "text" | "audio"; prompt: string; settings: Record<string, unknown>; references: Array<GenerationReference & { kind: "image" | "video" | "audio" }> };
export type GenerationInput = {
    prompt: string;
    images?: GenerationReference[];
    videos?: GenerationReference[];
    audios?: GenerationReference[];
    count?: number;
    size?: string;
    quality?: string;
    background?: string;
    seconds?: string;
    resolution?: string;
    generateAudio?: boolean;
    watermark?: boolean;
    mode?: "frames" | "reference";
    systemPrompt?: string;
};
export type GenerationMedia = { bytes: Buffer; mimeType: string };
export type OutputDescriptor = { kind: "inline"; dataUrl: string } | { kind: "remote"; url: string } | { kind: "provider"; path: string };
export type UpstreamVideoTask = { id: string; provider: "openai" | "gemini" | "seedance" | "custom"; model: string; channelId: string };
export type VideoPollResult = { status: "pending" } | { status: "failed"; error: string } | { status: "completed"; output: OutputDescriptor };
export type ProviderRequest = (url: URL, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: Buffer; signal?: AbortSignal }) => Promise<{ status: number; headers: Record<string, string>; bytes: Buffer }>;
export type ProviderFailureKind = "retryable" | "definitive" | "uncertain";
export class ProviderRequestError extends Error {
    constructor(message: string, readonly status: number, readonly failureKind: ProviderFailureKind) {
        super(message);
        this.name = "ProviderRequestError";
    }
}
function failureKindForStatus(status: number): ProviderFailureKind {
    return [401, 403, 404, 408, 409, 425, 429].includes(status) || status >= 500 ? "retryable" : "definitive";
}
/** Only provider responses prove the request did not produce a result; transport errors stay uncertain. */
export function providerFailureKind(error: unknown): ProviderFailureKind {
    return error instanceof ProviderRequestError ? error.failureKind : "uncertain";
}

/** The channel URL is an administrator-configured endpoint; provider redirects are never followed. */
export const requestGenerationProvider: ProviderRequest = async (url, init) => {
    const response = await fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: init.signal, redirect: "error" });
    const contentType = response.headers.get("content-type") || "";
    const limit = /^(image|video|audio)\//i.test(contentType) || contentType.startsWith("application/octet-stream") ? GENERATION_MEDIA_LIMIT_BYTES : GENERATION_JSON_LIMIT_BYTES;
    let bytes: Buffer;
    try { bytes = response.body ? await readGenerationBytes(response.body as unknown as AsyncIterable<Uint8Array>, limit, response.headers.get("content-length") || undefined) : Buffer.alloc(0); }
    catch (error) { await response.body?.cancel().catch(() => undefined); throw error; }
    return { status: response.status, headers: { "content-type": contentType }, bytes };
};

export function target(channel: GenerationChannel, path: string) {
    if (!channel.apiKey || !channel.model || channel.script) throw new Error("渠道密钥、模型缺失或脚本模型不支持服务端生成");
    const base = new URL(channel.baseUrl);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error("无效的供应商渠道地址");
    const normalized = base.href.replace(/\/+$/, "");
    const suffix = channel.apiFormat === "gemini" ? "/v1beta" : channel.apiFormat === "ark" ? "/api/v3" : "/v1";
    const root = /\/(?:v1beta|v1|api\/(?:plan\/)?v3)$/i.test(normalized) ? normalized : `${normalized}${suffix}`;
    const rootUrl = new URL(`${root}/`);
    const result = new URL(path.replace(/^\/+/, ""), rootUrl);
    if (result.origin !== base.origin || !result.pathname.startsWith(rootUrl.pathname)) throw new Error("无效的供应商请求路径");
    return result;
}

export function headers(channel: GenerationChannel, contentType = "application/json") {
    return { "content-type": contentType, ...(channel.apiFormat === "gemini" ? { "x-goog-api-key": channel.apiKey } : { authorization: `Bearer ${channel.apiKey}` }) };
}

function errorText(response: { status: number; bytes: Buffer }) {
    let message = "";
    try {
        const payload = JSON.parse(response.bytes.toString("utf8"));
        message = payload.error?.message || payload.msg || payload.message || "";
    } catch { /* Binary provider errors have no message. */ }
    return message || `供应商请求失败 (${response.status})`;
}

async function call(channel: GenerationChannel, path: string, method: "GET" | "POST", body: unknown, request: ProviderRequest, signal?: AbortSignal) {
    const serialized = body instanceof FormData ? new Response(body) : null;
    const contentType = serialized?.headers.get("content-type") || "application/json";
    const encoded = body === undefined ? undefined : serialized ? Buffer.from(await serialized.arrayBuffer()) : Buffer.from(JSON.stringify(body));
    const response = await request(target(channel, path), { method, headers: headers(channel, contentType), body: encoded, signal });
    if (response.status < 200 || response.status >= 300) throw new ProviderRequestError(errorText(response), response.status, failureKindForStatus(response.status));
    return response;
}

function dataUrl(reference: GenerationReference) { return `data:${reference.mimeType};base64,${reference.bytes.toString("base64")}`; }
function json(response: { bytes: Buffer }): any { return JSON.parse(response.bytes.toString("utf8")); }
function unwrap(payload: any) {
    if (payload?.code !== undefined && payload.code !== 0 && payload.code !== "0") throw new ProviderRequestError(payload.msg || payload.error?.message || "供应商返回错误", 200, "retryable");
    if (payload?.error?.message) throw new ProviderRequestError(payload.error.message, 200, "retryable");
    return payload?.data && !Array.isArray(payload.data) ? payload.data : payload;
}

async function remoteBytes(url: string, signal?: AbortSignal): Promise<GenerationMedia> {
    const source = new URL(url);
    const response = await openRemoteMedia(source, signal || new AbortController().signal);
    if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) throw new Error(`媒体下载失败 (${response.statusCode})`);
    let bytes: Buffer;
    try { bytes = await readGenerationBytes(response, GENERATION_MEDIA_LIMIT_BYTES, response.headers["content-length"]); }
    catch (error) { response.destroy(); throw error; }
    return { bytes, mimeType: String(response.headers["content-type"] || "application/octet-stream").split(";")[0] };
}

function imageOutput(value: unknown): OutputDescriptor {
    const item = typeof value === "string" ? { url: value } : value as { b64_json?: string; url?: string };
    if (item?.b64_json) return { kind: "inline", dataUrl: `data:image/png;base64,${item.b64_json}` };
    if (item?.url?.startsWith("data:image/")) return { kind: "inline", dataUrl: item.url };
    if (item?.url?.startsWith("https://")) return { kind: "remote", url: item.url };
    throw new ProviderRequestError("供应商未返回可保存的图片", 200, "definitive");
}

export async function downloadOutput(channel: ResolvedGenerationChannel, output: OutputDescriptor, signal?: AbortSignal, request: ProviderRequest = requestGenerationProvider): Promise<GenerationMedia> {
    if (output.kind === "remote") return remoteBytes(output.url, signal);
    if (output.kind === "inline") {
        const match = /^data:(image\/[a-zA-Z0-9.+-]+|video\/[a-zA-Z0-9.+-]+|audio\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=]+)$/.exec(output.dataUrl);
        if (!match) throw new Error("无效的生成媒体数据");
        if (Buffer.byteLength(match[2], "base64") > GENERATION_MEDIA_LIMIT_BYTES) throw new Error("生成媒体大小超过现有媒体边界");
        return { bytes: Buffer.from(match[2], "base64"), mimeType: match[1] };
    }
    if (!/^(?:videos\/[^/]+\/content|files\/[^/]+:download(?:\?alt=media)?)$/.test(output.path) || output.path.includes("..")) throw new Error("无效的供应商媒体路径");
    const response = await call(toChannel(channel), output.path, "GET", undefined, request, signal);
    return { bytes: response.bytes, mimeType: response.headers["content-type"]?.split(";")[0] || "video/mp4" };
}

function toChannel(channel: ResolvedGenerationChannel): GenerationChannel { return { ...channel, channelId: channel.id }; }
function toInput(request: GenerationRequest): GenerationInput {
    const settings = request.settings;
    const value = (key: string) => typeof settings[key] === "string" ? settings[key] as string : undefined;
    const bool = (key: string) => typeof settings[key] === "boolean" ? settings[key] as boolean : undefined;
    return { prompt: request.prompt, images: request.references.filter((ref) => ref.kind === "image"), videos: request.references.filter((ref) => ref.kind === "video"), audios: request.references.filter((ref) => ref.kind === "audio"), count: typeof settings.count === "number" ? settings.count : undefined, size: value("size"), quality: value("quality"), background: value("background"), seconds: value("seconds"), resolution: value("resolution"), generateAudio: bool("generateAudio"), watermark: bool("watermark"), mode: value("mode") === "reference" ? "reference" : undefined, systemPrompt: value("systemPrompt") };
}

function imageSize(value: string | undefined) {
    const size = value?.trim();
    if (!size || size.toLowerCase() === "auto") return undefined;
    const pixels = /^(\d+)x(\d+)$/i.exec(size);
    if (pixels) {
        const width = Number(pixels[1]); const height = Number(pixels[2]);
        validateImageDimensions(width, height);
        return `${width}x${height}`;
    }
    const ratio = parseImageRatio(size);
    const preset = imageSizePresets["1k"][size];
    if (preset) return preset;
    const landscape = ratio[0] >= ratio[1];
    const longSide = Math.round(1024 * Math.max(...ratio) / Math.min(...ratio) / 16) * 16;
    const width = landscape ? longSide : 1024; const height = landscape ? 1024 : longSide;
    validateImageDimensions(width, height);
    return `${width}x${height}`;
}
function parseImageRatio(value: string): [number, number] {
    const parts = value.split(":");
    if (parts.length !== 2) throw new Error("图片尺寸格式无效");
    const width = Number(parts[0]); const height = Number(parts[1]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error("图片比例必须为正数");
    if (Math.max(width, height) / Math.min(width, height) > 3) throw new Error("图片比例超出支持范围");
    return [width, height];
}
function validateImageDimensions(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error("图片尺寸必须为正整数");
    if (width % 16 || height % 16 || Math.max(width, height) > 3840 || Math.max(width, height) / Math.min(width, height) > 3 || width * height < 655360 || width * height > 8294400) throw new Error("图片尺寸超出支持范围");
}
function geminiImageConfig(size: string | undefined) {
    const value = size?.trim() || "";
    if (!value || value.toLowerCase() === "auto") return {};
    const pixels = /^(\d+)x(\d+)$/i.exec(value);
    const dimensions = pixels ? [Number(pixels[1]), Number(pixels[2])] as [number, number] : null;
    const [width, height] = dimensions || parseImageRatio(value);
    const options = ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"];
    const aspectRatio = options.reduce((best, option) => { const [w, h] = option.split(":").map(Number); const [bw, bh] = best.split(":").map(Number); return Math.abs(w / h - width / height) < Math.abs(bw / bh - width / height) ? option : best; });
    if (!dimensions) return { imageConfig: { aspectRatio } };
    const preset = Object.keys(imageSizePresets).find((scale) => Object.values(imageSizePresets[scale]).includes(`${width}x${height}`));
    const edge = Math.max(width, height);
    const imageSize = preset ? preset.toUpperCase() : edge <= 768 ? "512" : edge <= 1536 ? "1K" : edge <= 3072 ? "2K" : "4K";
    return { imageConfig: { aspectRatio, imageSize } };
}
function referencePrompt(prompt: string, imageCount: number) {
    if (!imageCount) return prompt;
    return `参考图片编号：${Array.from({ length: imageCount }, (_, index) => `图片${index + 1}`).join("、")}。请按这些编号理解提示词中的图片引用。\n\n${prompt.trim()}`;
}
function videoReferencePrompt(prompt: string, images: number, videos: number, audios: number) {
    const labels = [...Array.from({ length: images }, (_, index) => `图片${index + 1}`), ...Array.from({ length: videos }, (_, index) => `视频${index + 1}`), ...Array.from({ length: audios }, (_, index) => `音频${index + 1}`)];
    return labels.length ? `参考素材编号：${labels.join("、")}。请按这些编号理解提示词中的素材引用。\n\n${prompt.trim()}` : prompt.trim();
}

export async function submitImage(resolved: ResolvedGenerationChannel, job: GenerationRequest, signal?: AbortSignal, request: ProviderRequest = requestGenerationProvider): Promise<OutputDescriptor[]> {
    if (job.kind !== "image") throw new Error("任务类型不是图片");
    const channel = toChannel(resolved);
    const input = toInput(job);
    const images = input.images || [];
    if (input.count !== undefined && input.count !== 1) throw new Error("单次图片提交仅支持一张；批量请持久化为独立子任务");
    const requestPrompt = referencePrompt(input.prompt, images.length);
    const prompt = input.systemPrompt?.trim() ? `${input.systemPrompt.trim()}\n\n${requestPrompt}` : requestPrompt;
    const qualityValue = input.quality?.trim().toLowerCase();
    const quality = ["low", "medium", "high", "xhigh", "max"].includes(qualityValue || "") ? qualityValue : undefined;
    const size = channel.apiFormat === "gemini" ? undefined : imageSize(input.size);
    const imageSignal = AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(10 * 60_000)]);
    let response;
    if (channel.apiFormat === "gemini") {
        const parts = [{ text: requestPrompt }, ...images.map((image) => ({ inlineData: { mimeType: image.mimeType, data: image.bytes.toString("base64") } }))];
        response = await call(channel, `models/${encodeURIComponent(channel.model.replace(/^models\//, ""))}:generateContent`, "POST", {
            contents: [{ role: "user", parts }], ...(input.systemPrompt?.trim() ? { systemInstruction: { parts: [{ text: input.systemPrompt.trim() }] } } : {}), generationConfig: { responseModalities: ["TEXT", "IMAGE"], ...geminiImageConfig(input.size) },
        }, request, imageSignal);
        const payload = json(response);
        if (payload.promptFeedback?.blockReason) throw new ProviderRequestError(payload.promptFeedback.blockReason, 200, "definitive");
        if (payload.error?.message) throw new ProviderRequestError(payload.error.message, 200, "retryable");
        const items = payload.candidates?.flatMap((candidate: any) => candidate.content?.parts || []) || [];
        const media = items.map((part: any) => part.inlineData || part.inline_data).filter(Boolean);
        if (!media.length) throw new ProviderRequestError("供应商未返回图片", 200, "definitive");
        return media.map((item: any) => ({ kind: "inline", dataUrl: `data:${item.mimeType || item.mime_type || "image/png"};base64,${item.data}` }));
    }
    const common = { model: channel.model, prompt, n: 1, ...(/gpt-image/.test(channel.model) && !(images.length && channel.apiFormat === "ark") ? {} : { response_format: "b64_json" }), output_format: "png", ...(quality ? { quality } : {}), ...(size ? { size } : {}), ...(input.background?.trim().toLowerCase() === "transparent" ? { background: "transparent" } : {}) };
    if (images.length && channel.apiFormat !== "ark") {
        const form = new FormData();
        for (const [key, value] of Object.entries(common)) form.set(key, String(value));
        images.forEach((image) => form.append(images.length > 1 ? "image[]" : "image", new Blob([new Uint8Array(image.bytes)], { type: image.mimeType }), image.name || "reference.png"));
        response = await call(channel, "images/edits", "POST", form, request, imageSignal);
    } else {
        response = await call(channel, "images/generations", "POST", { ...common, ...(images.length ? { image: images.map(dataUrl) } : {}) }, request, imageSignal);
    }
    const payload = unwrap(json(response));
    const list = payload.data || payload.images || payload.results || payload.url || payload;
    const items = Array.isArray(list) ? list : [list];
    if (!items.length) throw new ProviderRequestError("供应商未返回图片", 200, "definitive");
    return items.map(imageOutput);
}

function videoRatio(input: GenerationInput) { const ratio = inferVideoRatio(input.size || "16:9"); return ratio === "auto" ? "16:9" : ratio; }
function videoResolution(input: GenerationInput) { const value = input.resolution || "720"; return value === "low" ? "480p" : /^(auto|high|medium)$/.test(value) ? "720p" : `${value.replace(/p$/i, "")}p`; }
function videoSeconds(input: GenerationInput) { return clampVideoSeconds(input.seconds || "6"); }
function seedanceDuration(value: string) { if (value.trim() === "-1") return -1; return Math.max(4, Math.min(15, Math.floor(Number(value) || 5))); }
function seedanceResolution(value: string) { const resolution = videoResolution({ prompt: "", resolution: value }); return ["480p", "720p", "1080p"].includes(resolution) ? resolution : "720p"; }
function seedanceRatio(value: string) {
    if (!value || value === "auto" || value === "adaptive") return "adaptive";
    const ratios = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];
    if (ratios.includes(value)) return value;
    const dimensions = /^(\d+)x(\d+)$/.exec(value);
    if (!dimensions || !Number(dimensions[2])) return "adaptive";
    const target = Number(dimensions[1]) / Number(dimensions[2]);
    return ratios.reduce((best, item) => { const ratio = item.split(":").map(Number); const current = best.split(":").map(Number); return Math.abs(ratio[0] / ratio[1] - target) < Math.abs(current[0] / current[1] - target) ? item : best; });
}

export async function submitVideo(resolved: ResolvedGenerationChannel, job: GenerationRequest, signal?: AbortSignal, request: ProviderRequest = requestGenerationProvider): Promise<UpstreamVideoTask> {
    if (job.kind !== "video") throw new Error("任务类型不是视频");
    const channel = toChannel(resolved);
    const input = toInput(job);
    const images = input.images || [];
    const videos = input.videos || [];
    const audios = input.audios || [];
    const provider = channel.apiFormat === "ark" ? "seedance" : channel.apiFormat === "gemini" ? "gemini" : channel.apiFormat === "custom" ? "custom" : "openai";
    let response;
    if (provider === "gemini") {
        const mode = input.mode || (images.length > 2 ? "reference" : "frames");
        const instance: Record<string, unknown> = { prompt: input.prompt };
        const inline = (image: GenerationReference) => ({ mimeType: image.mimeType, bytesBase64Encoded: image.bytes.toString("base64") });
        if (mode === "frames") {
            if (images[0]) instance.image = inline(images[0]);
            if (images[1]) instance.lastFrame = inline(images[1]);
        } else instance.referenceImages = images.map((image) => ({ image: inline(image), referenceType: "asset" }));
        if (videos[0]) instance.video = inline(videos[0]);
        if (audios[0]) instance.audio = inline(audios[0]);
        response = await call(channel, `models/${encodeURIComponent(channel.model.replace(/^models\//, ""))}:predictLongRunning`, "POST", {
            instances: [instance], parameters: { aspectRatio: videoRatio(input), durationSeconds: Number(videoSeconds(input)), resolution: videoResolution(input), generateAudio: input.generateAudio ?? true, addWatermark: input.watermark ?? false },
        }, request, signal);
    } else if (provider === "openai") {
        const form = new FormData();
        const size = input.size && /^\d+x\d+$/.test(input.size) ? input.size : computeVideoSize(input.resolution || "720", videoRatio(input));
        for (const [key, value] of Object.entries({ model: channel.model, prompt: input.prompt, seconds: videoSeconds(input), size: size || "1280x720", ratio: videoRatio(input), resolution_name: videoResolution(input), generate_audio: input.generateAudio ?? true, watermark: input.watermark ?? false, mode: input.mode || (images.length > 2 ? "reference" : "frames") })) form.append(key, String(value));
        images.forEach((image, index) => {
            const file = new Blob([new Uint8Array(image.bytes)], { type: image.mimeType });
            if (form.get("mode") === "frames") {
                if (index < 2) {
                    form.append(index ? "last_frame" : "first_frame", file, index ? "last.png" : "first.png");
                    form.append("images", file, index ? "last.png" : "first.png");
                }
            } else {
                form.append("image[]", file, `ref_${index + 1}.png`);
                form.append("images", file, `ref_${index + 1}.png`);
            }
        });
        videos.forEach((video) => form.append("video[]", new Blob([new Uint8Array(video.bytes)], { type: video.mimeType }), video.name || "reference.mp4"));
        audios.forEach((audio) => form.append("audio[]", new Blob([new Uint8Array(audio.bytes)], { type: audio.mimeType }), audio.name || "reference.mp3"));
        response = await call(channel, "videos", "POST", form, request, signal);
    } else {
        const media = (list: GenerationReference[]) => list.map(dataUrl);
        if (provider === "seedance") {
            const content: unknown[] = [{ type: "text", text: videoReferencePrompt(input.prompt, images.length, videos.length, audios.length) }, ...media(images).map((url) => ({ type: "image_url", image_url: { url }, role: "reference_image" })), ...media(videos).map((url) => ({ type: "video_url", video_url: { url }, role: "reference_video" })), ...media(audios).map((url) => ({ type: "audio_url", audio_url: { url }, role: "reference_audio" }))];
            response = await call(channel, "contents/generations/tasks", "POST", { model: channel.model, content, ratio: seedanceRatio(input.size || "auto"), resolution: seedanceResolution(input.resolution || "720"), duration: seedanceDuration(input.seconds || "6"), generate_audio: input.generateAudio ?? true, watermark: input.watermark ?? false }, request, signal);
        } else {
            response = await call(channel, "video/generations", "POST", { model: channel.model, prompt: videoReferencePrompt(input.prompt, images.length, videos.length, audios.length), duration: /seedance/i.test(channel.model) ? seedanceDuration(input.seconds || "6") : Number(videoSeconds(input)), resolution: /seedance/i.test(channel.model) ? seedanceResolution(input.resolution || "720") : videoResolution(input), aspect_ratio: seedanceRatio(input.size || "auto") === "adaptive" ? "16:9" : seedanceRatio(input.size || "auto"), generate_audio: input.generateAudio ?? true, prompt_extend: false, ...(images.length ? { reference_images: media(images) } : {}), ...(videos.length ? { reference_videos: media(videos) } : {}), ...(audios.length ? { reference_audios: media(audios) } : {}) }, request, signal);
        }
    }
    const created = unwrap(json(response));
    const id = provider === "gemini" ? created.name : created.id || created.task_id;
    if (typeof id !== "string" || !id) throw new Error("供应商未返回任务 ID，提交状态不确定，请勿自动重试");
    return { id, provider, model: channel.model, channelId: channel.channelId };
}

export async function pollVideo(resolved: ResolvedGenerationChannel, task: UpstreamVideoTask, signal?: AbortSignal, request: ProviderRequest = requestGenerationProvider): Promise<VideoPollResult> {
    const channel = toChannel(resolved);
    if (channel.channelId !== task.channelId || channel.model !== task.model) throw new Error("任务与供应商渠道不匹配");
    const path = task.provider === "gemini" ? task.id.replace(/^\/+/, "") : task.provider === "seedance" ? `contents/generations/tasks/${encodeURIComponent(task.id)}` : task.provider === "custom" ? `video/generations/${encodeURIComponent(task.id)}` : `videos/${encodeURIComponent(task.id)}`;
    const payload = json(await call(channel, path, "GET", undefined, request, signal));
    if (payload?.code !== undefined && payload.code !== 0 && payload.code !== "0") throw new Error(payload.msg || "供应商查询失败");
    const state = payload?.data && !Array.isArray(payload.data) ? payload.data : payload;
    if (state.error?.message || ["failed", "cancelled", "expired"].includes(state.status)) return { status: "failed", error: state.fail_reason || state.error?.message || "视频生成失败" };
    if (task.provider === "gemini") {
        if (!state.done) return { status: "pending" };
        const uri = state.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
        if (!uri) return { status: "failed", error: "供应商未返回视频" };
        const root = new URL(target(channel, "files/example"));
        const source = new URL(uri, root);
        const basePath = root.pathname.replace(/files\/example$/, "");
        if (source.origin !== root.origin || !source.pathname.startsWith(basePath) || (source.search && source.search !== "?alt=media")) throw new Error("Gemini 视频地址不属于当前渠道");
        const relative = source.pathname.slice(basePath.length) + source.search;
        if (!/^files\/[^/]+:download(?:\?alt=media)?$/.test(relative)) throw new Error("Gemini 视频下载路径无效");
        return { status: "completed", output: { kind: "provider", path: relative } };
    }
    const url = [state.video_url, state.result_url, state.url, state.content?.video_url, state.content?.url].find((value) => typeof value === "string" && value.startsWith("https://"));
    if (url) return { status: "completed", output: { kind: "remote", url } };
    if (state.status === "completed" || state.status === "succeeded") {
        if (task.provider !== "openai") return { status: "failed", error: "供应商未返回视频地址" };
        return { status: "completed", output: { kind: "provider", path: `videos/${encodeURIComponent(task.id)}/content` } };
    }
    return { status: "pending" };
}
