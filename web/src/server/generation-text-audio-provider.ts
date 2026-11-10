import { Buffer } from "node:buffer";
import { audioMimeType, normalizeAudioFormatValue, normalizeAudioSpeedValue, normalizeAudioVoiceValue } from "../lib/audio-generation";
import { GENERATION_JSON_LIMIT_BYTES, GENERATION_MEDIA_LIMIT_BYTES, readGenerationBytes } from "./generation-media";
import { headers, target, type GenerationRequest, type OutputDescriptor, type ResolvedGenerationChannel } from "./generation-provider";

const channelValue = (channel: ResolvedGenerationChannel) => ({ ...channel, channelId: channel.id });
const setting = (request: GenerationRequest, name: string) => typeof request.settings[name] === "string" ? request.settings[name] as string : "";

/** Keep the current canvas's Responses/Gemini input semantics; references have already passed workspace/version checks. */
export function textGenerationBody(channel: ResolvedGenerationChannel, request: GenerationRequest) {
    const systemPrompt = setting(request, "systemPrompt").trim();
    const images = request.references.filter((ref) => ref.kind === "image");
    if (channel.apiFormat === "gemini") return {
        contents: [{ role: "user", parts: [{ text: request.prompt }, ...images.map((ref) => ({ inlineData: { mimeType: ref.mimeType, data: ref.bytes.toString("base64") } }))] }],
        ...(systemPrompt ? { systemInstruction: { parts: [{ text: systemPrompt }] } } : {}),
    };
    const content = images.length ? [{ type: "input_text", text: request.prompt }, ...images.map((ref) => ({ type: "input_image", image_url: `data:${ref.mimeType};base64,${ref.bytes.toString("base64")}` }))] : request.prompt;
    const effort = setting(request, "reasoningEffort");
    return { model: channel.model, input: [...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []), { role: "user", content }], ...(effort && effort !== "auto" ? { reasoning: { effort } } : {}), stream: true };
}

function responseText(value: any): string {
    return typeof value.output_text === "string" ? value.output_text : (value.output || []).flatMap((entry: any) => entry.type === "message" ? (entry.content || []).flatMap((part: any) => typeof part.text === "string" ? [part.text] : []) : []).join("");
}

/** A durable checkpoint is awaited before consuming more data. EOF alone never establishes completion. */
export async function readTextGenerationStream(response: Response, gemini: boolean, onDelta: (content: string) => Promise<void>) {
    if (!response.ok) throw new Error(`文本供应商请求失败 (${response.status})`);
    if (!(response.headers.get("content-type") || "").includes("text/event-stream")) {
        const bytes = response.body ? await readGenerationBytes(response.body as unknown as AsyncIterable<Uint8Array>, GENERATION_JSON_LIMIT_BYTES, response.headers.get("content-length") || undefined) : Buffer.alloc(0);
        const payload = JSON.parse(bytes.toString("utf8"));
        if (payload.error || payload.promptFeedback?.blockReason) throw new Error("文本供应商返回错误");
        const candidate = payload.candidates?.[0];
        if (gemini ? candidate?.finishReason !== "STOP" : payload.status !== "completed") throw new Error("文本结果没有完成凭据");
        const content = gemini ? (candidate.content?.parts || []).filter((part: any) => !part.thought).map((part: any) => part.text || "").join("") : responseText(payload);
        if (!content) throw new Error("文本供应商未返回内容");
        await onDelta(content);
        return content;
    }
    if (!response.body) throw new Error("文本供应商缺少响应流");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let complete = false;
    let bytes = 0;
    const block = async (value: string) => {
        const data = value.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
        if (!data || data === "[DONE]") return;
        const event = JSON.parse(data);
        if (event.error || event.type === "error" || event.type === "response.failed" || event.type === "response.incomplete" || event.promptFeedback?.blockReason) throw new Error("文本供应商流未正常完成");
        let next = content;
        if (gemini) {
            const candidate = event.candidates?.[0];
            next += (candidate?.content?.parts || []).filter((part: any) => !part.thought).map((part: any) => part.text || "").join("");
            if (candidate?.finishReason) {
                if (candidate.finishReason !== "STOP") throw new Error("文本供应商流未正常完成");
                complete = true;
            }
        } else {
            if (event.type === "response.output_text.delta") next += typeof event.delta === "string" ? event.delta : "";
            if (event.type === "response.completed") {
                if (event.response?.status && event.response.status !== "completed") throw new Error("文本供应商流未正常完成");
                next = responseText(event.response || {}) || next;
                complete = true;
            }
        }
        if (next !== content) { content = next; await onDelta(content); }
    };
    try {
        const declared = Number(response.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > GENERATION_JSON_LIMIT_BYTES) throw new Error("生成响应大小超过现有媒体边界");
        for (;;) {
            const read = await reader.read();
            if (read.done) break;
            bytes += read.value.byteLength;
            if (bytes > GENERATION_JSON_LIMIT_BYTES) throw new Error("生成响应大小超过现有媒体边界");
            buffer += decoder.decode(read.value, { stream: true });
            for (;;) {
                const boundary = /\r?\n\r?\n/.exec(buffer);
                if (!boundary) break;
                await block(buffer.slice(0, boundary.index));
                buffer = buffer.slice(boundary.index + boundary[0].length);
            }
        }
        buffer += decoder.decode();
        if (buffer.trim()) await block(buffer);
        if (!complete || !content) throw new Error("文本响应中断，已保留收到的内容，请核对原请求");
        return content;
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export async function submitText(channel: ResolvedGenerationChannel, request: GenerationRequest, onDelta: (content: string) => Promise<void>, signal?: AbortSignal) {
    const gemini = channel.apiFormat === "gemini";
    const url = target(channelValue(channel), gemini ? `models/${encodeURIComponent(channel.model.replace(/^models\//, ""))}:streamGenerateContent` : "responses");
    if (gemini) url.searchParams.set("alt", "sse");
    const response = await fetch(url, { method: "POST", headers: { ...headers(channelValue(channel)), accept: "text/event-stream" }, body: JSON.stringify(textGenerationBody(channel, request)), redirect: "error", signal });
    return readTextGenerationStream(response, gemini, onDelta);
}

export async function submitAudio(channel: ResolvedGenerationChannel, request: GenerationRequest, signal?: AbortSignal): Promise<OutputDescriptor> {
    if (channel.apiFormat === "gemini") throw new Error("Gemini 音频生成暂不支持，请使用现有脚本模型");
    const format = normalizeAudioFormatValue(setting(request, "format"));
    const instructions = setting(request, "instructions").trim();
    const response = await fetch(target(channelValue(channel), "audio/speech"), { method: "POST", headers: headers(channelValue(channel)), redirect: "error", signal,
        body: JSON.stringify({ model: channel.model, input: request.prompt, voice: normalizeAudioVoiceValue(setting(request, "voice")), response_format: format, speed: Number(normalizeAudioSpeedValue(setting(request, "speed"))), ...(instructions ? { instructions } : {}) }) });
    if (!response.ok) throw new Error(`音频供应商请求失败 (${response.status})`);
    const mime = (response.headers.get("content-type") || "").split(";")[0];
    if (mime.includes("json") || mime.includes("text/html")) throw new Error("音频供应商未返回音频");
    const bytes = response.body ? await readGenerationBytes(response.body as unknown as AsyncIterable<Uint8Array>, GENERATION_MEDIA_LIMIT_BYTES, response.headers.get("content-length") || undefined) : Buffer.alloc(0);
    if (!bytes.length) throw new Error("音频供应商未返回内容");
    return { kind: "inline", dataUrl: `data:${mime.startsWith("audio/") ? mime : audioMimeType(format)};base64,${bytes.toString("base64")}` };
}
