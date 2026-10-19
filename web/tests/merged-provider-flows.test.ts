import { afterAll, beforeEach, expect, test } from "bun:test";
import axios from "axios";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
const { defaultConfig, useConfigStore } = await import("../src/stores/use-config-store");
const { createVideoGenerationTask, pollVideoGenerationTask } = await import("../src/services/api/video");
const { requestGeneration, requestEdit } = await import("../src/services/api/image");
const { requestAudioGeneration } = await import("../src/services/api/audio");
const { getPluginTemplates, runModelPlugin } = await import("../src/services/api/model-plugin");

const originalPost = axios.post;
const originalGet = axios.get;
const originalRequest = axios.request;
const calls: Array<{ method: string; url: string; data?: any; options?: any }> = [];
let response: any;
beforeEach(() => {
    calls.length = 0;
    useConfigStore.setState({ config: { ...defaultConfig, proxyEnabled: true } });
    axios.post = (async (url: string, data: unknown, options: unknown) => { calls.push({ method: "post", url, data, options }); return { data: response }; }) as typeof axios.post;
    axios.get = (async (url: string, options: unknown) => { calls.push({ method: "get", url, options }); return { data: response }; }) as typeof axios.get;
});
afterAll(() => {
    axios.post = originalPost;
    axios.get = originalGet;
    axios.request = originalRequest;
    useConfigStore.setState({ config: defaultConfig });
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

const configured = (apiFormat: "openai" | "gemini" | "ark" | "custom", capability: "video" | "image" | "audio" = "video") => ({
    ...defaultConfig,
    model: "managed::model",
    videoModel: "managed::model",
    imageModel: "managed::model",
    audioModel: "managed::model",
    size: "2048x2048",
    channels: [{ id: "managed", name: "Managed", apiFormat, baseUrl: "https://provider.example", apiKey: "", hasApiKey: true, models: [{ name: "model", capability }] }],
});

test("Gemini create and polling use the authenticated channel instead of a local proxy", async () => {
    response = { name: "models/model/operations/task" };
    const task = await createVideoGenerationTask(configured("gemini"), "prompt");
    expect(task.provider).toBe("gemini");
    expect(calls[0].url).toBe("/api/ai/managed/models/model:predictLongRunning");
    expect(calls[0].options.headers["x-goog-api-key"]).toBeUndefined();
    response = { done: false };
    expect(await pollVideoGenerationTask(configured("gemini"), task)).toEqual({ status: "pending" });
    expect(calls[1].url).toBe("/api/ai/managed/models/model/operations/task");
});

test("Gemini download stays on the channel and never places a secret in a URL", async () => {
    axios.get = (async (url: string, options: unknown) => {
        calls.push({ method: "get", url, options });
        return { data: calls.length === 1 ? { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: "https://provider.example/v1beta/files/result:download?alt=media" } }] } } } : new Blob(["video"], { type: "video/mp4" }) };
    }) as typeof axios.get;
    const result = await pollVideoGenerationTask(configured("gemini"), { id: "operations/task", provider: "gemini", model: "managed::model" });
    expect(result.status).toBe("completed");
    expect(calls[1].url).toBe("/api/ai/managed/files/result:download?alt=media");
});

test("OpenAI reference mode submits images and preserves ratio fields", async () => {
    response = { id: "task" };
    const image = { id: "ref", name: "ref.png", type: "image/png", dataUrl: "data:image/png;base64,aA==" };
    await createVideoGenerationTask({ ...configured("openai"), videoMode: "reference" }, "prompt", [image]);
    const body = calls[0].data as FormData;
    expect(calls[0].url).toBe("/api/ai/managed/videos");
    expect(body.get("mode")).toBe("reference");
    expect(body.getAll("image[]").length).toBe(1);
    expect(body.getAll("images").length).toBe(1);
    expect(body.get("ratio")).toBe("1:1");
});

test("custom and Ark video integrations remain available", async () => {
    for (const [format, provider, path] of [["custom", "custom", "/video/generations"], ["ark", "seedance", "/contents/generations/tasks"]] as const) {
        response = { id: "task" };
        const task = await createVideoGenerationTask(configured(format), "prompt");
        expect(task.provider).toBe(provider);
        expect(calls.at(-1)?.url).toBe(`/api/ai/managed${path}`);
    }
});

test("Gemini image resolution, Ark editing timeout and audio retain server-owned credentials", async () => {
    response = { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "aA==" } }] } }] };
    await requestGeneration(configured("gemini", "image"), "prompt");
    expect(calls[0].data.generationConfig.imageConfig.imageSize).toBe("2K");
    expect(calls[0].options.timeout).toBe(600000);
    response = { data: [{ b64_json: "aA==" }] };
    await requestEdit(configured("ark", "image"), "prompt", []);
    expect(calls.at(-1)?.url).toBe("/api/ai/managed/images/generations");
    expect(calls.at(-1)?.data.size).toBe("2048x2048");
    expect(calls.at(-1)?.options.timeout).toBe(600000);
    response = new Blob(["audio"], { type: "audio/mpeg" });
    await requestAudioGeneration(configured("openai", "audio"), "prompt");
    expect(calls.at(-1)?.url).toBe("/api/ai/managed/audio/speech");
    expect(calls.at(-1)?.options.headers.Authorization).toBeUndefined();
});

test("Gemini video script template downloads through its request helper", async () => {
    const template = getPluginTemplates().video.find((item) => item.script.includes("predictLongRunning"))!;
    axios.request = (async (request: any) => {
        calls.push({ method: request.method, url: request.url });
        if (request.method === "post") return { data: { name: "operations/task" } };
        if (request.url.includes("operations/")) return { data: { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: "https://provider.example/v1beta/files/result:download?alt=media" } }] } } } };
        return { data: new Blob(["video"], { type: "video/mp4" }) };
    }) as typeof axios.request;
    const result = await runModelPlugin({ capability: "video", script: template.script, config: { ...configured("gemini"), apiFormat: "gemini", model: "model", channelId: "managed" }, params: { mode: "frames", ratio: "16:9" } });
    expect(result).toBeInstanceOf(Blob);
    expect(calls.at(-1)?.url).toBe("/api/ai/managed/files/result:download?alt=media");
});
