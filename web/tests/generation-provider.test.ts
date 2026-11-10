import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { downloadOutput, pollVideo, submitImage, submitVideo, type ProviderRequest, type ResolvedGenerationChannel } from "../src/server/generation-provider";

const channel: ResolvedGenerationChannel = { id: "channel-1", baseUrl: "https://provider.example/v1", apiKey: "secret", apiFormat: "openai", model: "image-or-video" };
const imageJob = { kind: "image" as const, prompt: "test", settings: { count: 1 }, references: [] };
const videoJob = { kind: "video" as const, prompt: "test", settings: {}, references: [] };
const reply = (payload: unknown, contentType = "application/json") => ({ status: 200, headers: { "content-type": contentType }, bytes: Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)) });

describe("server generation adapter", () => {
    test("image submission returns replayable descriptor before media archive", async () => {
        let calls = 0;
        const request: ProviderRequest = async (_url, init) => { calls++; expect(init.method).toBe("POST"); return reply({ data: [{ b64_json: "aGVsbG8=" }] }); };
        const outputs = await submitImage(channel, imageJob, undefined, request);
        expect(calls).toBe(1);
        expect(outputs).toEqual([{ kind: "inline", dataUrl: "data:image/png;base64,aGVsbG8=" }]);
        expect(await downloadOutput({ ...channel, model: "image-or-video" }, outputs[0], undefined, request)).toEqual({ bytes: Buffer.from("hello"), mimeType: "image/png" });
        expect(calls).toBe(1);
    });

    test("video polling reuses upstream ID and downloads only after durable descriptor", async () => {
        const calls: string[] = [];
        const request: ProviderRequest = async (url, init) => {
            calls.push(`${init.method} ${url.pathname}`);
            if (init.method === "POST") return reply({ id: "up-1" });
            if (url.pathname.endsWith("/content")) return reply("video bytes", "video/mp4");
            return reply({ status: "completed" });
        };
        const task = await submitVideo(channel, videoJob, undefined, request);
        expect(task).toEqual({ id: "up-1", provider: "openai", model: "image-or-video", channelId: "channel-1" });
        const state = await pollVideo(channel, task, undefined, request);
        expect(state).toEqual({ status: "completed", output: { kind: "provider", path: "videos/up-1/content" } });
        if (state.status !== "completed") throw new Error("expected completion");
        expect(await downloadOutput(channel, state.output, undefined, request)).toEqual({ bytes: Buffer.from("video bytes"), mimeType: "video/mp4" });
        expect(calls).toEqual(["POST /v1/videos", "GET /v1/videos/up-1", "GET /v1/videos/up-1/content"]);
    });

    test("missing video ID is uncertain and never resubmitted", async () => {
        let submits = 0;
        const request: ProviderRequest = async () => { submits++; return reply({ status: "queued" }); };
        expect(submitVideo(channel, videoJob, undefined, request)).rejects.toThrow("请勿自动重试");
        expect(submits).toBe(1);
    });

    test("custom scripts and cross-channel polling are rejected", async () => {
        const request: ProviderRequest = async () => { throw new Error("unexpected request"); };
        expect(submitImage({ ...channel, script: "return 1" }, imageJob, undefined, request)).rejects.toThrow("脚本模型");
        expect(pollVideo(channel, { id: "up-1", provider: "openai", model: channel.model, channelId: "another" }, undefined, request)).rejects.toThrow("不匹配");
    });

    test("Ark image edit sends references in JSON and Gemini image returns inline data", async () => {
        const reference = { kind: "image" as const, mimeType: "image/png", bytes: Buffer.from("source") };
        const ark = { ...channel, apiFormat: "ark" as const, baseUrl: "https://provider.example/api/v3" };
        const arkRequest: ProviderRequest = async (url, init) => {
            expect(url.pathname).toBe("/api/v3/images/generations");
            const body = JSON.parse(init.body!.toString());
            expect(body.image).toEqual(["data:image/png;base64,c291cmNl"]);
            expect(body.n).toBe(1);
            return reply({ data: [{ b64_json: "aW1hZ2U=" }] });
        };
        expect((await submitImage(ark, { ...imageJob, references: [reference] }, undefined, arkRequest)).length).toBe(1);
        const gemini = { ...channel, apiFormat: "gemini" as const, baseUrl: "https://provider.example/v1beta" };
        const geminiRequest: ProviderRequest = async (url) => {
            expect(url.pathname).toBe("/v1beta/models/image-or-video:generateContent");
            return reply({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/jpeg", data: "aW1hZ2U=" } }] } }] });
        };
        expect(await submitImage(gemini, imageJob, undefined, geminiRequest)).toEqual([{ kind: "inline", dataUrl: "data:image/jpeg;base64,aW1hZ2U=" }]);
    });

    test("Gemini operation returns replayable provider path and terminal errors remain failed", async () => {
        const gemini = { ...channel, apiFormat: "gemini" as const, baseUrl: "https://provider.example/v1beta" };
        const task = { id: "operations/op-1", provider: "gemini" as const, model: gemini.model, channelId: gemini.id };
        const request: ProviderRequest = async (url) => {
            expect(url.pathname).toBe("/v1beta/operations/op-1");
            return reply({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: "https://provider.example/v1beta/files/f-1:download?alt=media" } }] } } });
        };
        expect(await pollVideo(gemini, task, undefined, request)).toEqual({ status: "completed", output: { kind: "provider", path: "files/f-1:download?alt=media" } });
        const failed: ProviderRequest = async () => reply({ status: "failed", error: { message: "upstream failed" } });
        expect(await pollVideo(channel, { id: "up-1", provider: "openai", model: channel.model, channelId: channel.id }, undefined, failed)).toEqual({ status: "failed", error: "upstream failed" });
    });

    test("Ark plan endpoint is preserved and reference labels match existing Seedance payload", async () => {
        const plan = { ...channel, apiFormat: "ark" as const, baseUrl: "https://provider.example/api/plan/v3" };
        const reference = { kind: "image" as const, mimeType: "image/png", bytes: Buffer.from("image") };
        const request: ProviderRequest = async (url, init) => {
            expect(url.pathname).toBe("/api/plan/v3/contents/generations/tasks");
            const body = JSON.parse(init.body!.toString());
            expect(body.content[0].text).toBe("参考素材编号：图片1。请按这些编号理解提示词中的素材引用。\n\ntest");
            expect(body.content[1].image_url.url).toBe("data:image/png;base64,aW1hZ2U=");
            return reply({ id: "ark-1" });
        };
        expect((await submitVideo(plan, { ...videoJob, references: [reference] }, undefined, request)).id).toBe("ark-1");
    });

    test("custom Seedance keeps custom endpoint and its duration normalization", async () => {
        const custom = { ...channel, apiFormat: "custom" as const, model: "seedance-v1" };
        const request: ProviderRequest = async (url, init) => {
            expect(url.pathname).toBe("/v1/video/generations");
            const body = JSON.parse(init.body!.toString());
            expect(body.duration).toBe(-1);
            expect(body.resolution).toBe("1080p");
            return reply({ data: { task_id: "custom-1" } });
        };
        expect(await submitVideo(custom, { ...videoJob, settings: { seconds: "-1", resolution: "1080" } }, undefined, request)).toEqual({ id: "custom-1", provider: "custom", model: "seedance-v1", channelId: "channel-1" });
    });

    test("image ratio, quality and Gemini imageConfig follow workbench request", async () => {
        const request: ProviderRequest = async (_url, init) => {
            const body = JSON.parse(init.body!.toString());
            expect(body.size).toBe("1024x1536");
            expect(body.quality).toBe("high");
            expect(body.prompt).toBe("system\n\ntest");
            return reply({ data: [{ b64_json: "aW1hZ2U=" }] });
        };
        await submitImage(channel, { ...imageJob, settings: { count: 1, size: "2:3", quality: " HIGH ", systemPrompt: "system" } }, undefined, request);
        const gemini = { ...channel, apiFormat: "gemini" as const };
        const geminiRequest: ProviderRequest = async (_url, init) => {
            const body = JSON.parse(init.body!.toString());
            expect(body.generationConfig.imageConfig).toEqual({ aspectRatio: "2:3", imageSize: "1K" });
            expect(body.systemInstruction.parts[0].text).toBe("system");
            return reply({ candidates: [{ content: { parts: [{ inlineData: { data: "aW1hZ2U=" } }] } }] });
        };
        await submitImage(gemini, { ...imageJob, settings: { count: 1, size: "1024x1536", systemPrompt: "system" } }, undefined, geminiRequest);
    });

    test("OpenAI reference mode duplicates images field and frames keep first and last", async () => {
        const reference = { kind: "image" as const, mimeType: "image/png", bytes: Buffer.from("image") };
        const request: ProviderRequest = async (_url, init) => {
            const form = await new Response(init.body, { headers: { "content-type": init.headers["content-type"] } }).formData();
            expect(form.getAll("image[]").length).toBe(2);
            expect(form.getAll("images").length).toBe(2);
            expect(form.get("first_frame")).toBeNull();
            return reply({ id: "video-1" });
        };
        await submitVideo(channel, { ...videoJob, references: [reference, reference], settings: { mode: "reference" } }, undefined, request);
        const frames: ProviderRequest = async (_url, init) => {
            const form = await new Response(init.body, { headers: { "content-type": init.headers["content-type"] } }).formData();
            expect(form.getAll("images").length).toBe(2);
            expect(form.get("first_frame")).toBeTruthy();
            expect(form.get("last_frame")).toBeTruthy();
            return reply({ id: "video-2" });
        };
        await submitVideo(channel, { ...videoJob, references: [reference, reference] }, undefined, frames);
    });
});
