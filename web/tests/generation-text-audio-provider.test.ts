import { expect, test } from "bun:test";
import { readTextGenerationStream, submitAudio, textGenerationBody } from "../src/server/generation-text-audio-provider";
import { downloadOutput, type ResolvedGenerationChannel } from "../src/server/generation-provider";
import { normalizeGenerationRequest, publicGenerationTask, type GenerationTaskRow } from "../src/server/generation-tasks";

const channel: ResolvedGenerationChannel = { id: "fixture", model: "text-model", apiFormat: "openai", apiKey: "fixture", baseUrl: "https://fixture.invalid/v1" };
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const stream = (data: string) => new Response(data, { headers: { "content-type": "text/event-stream" } });

test("text request keeps Responses reasoning, system prompt and typed image input; Gemini keeps equivalent context", () => {
    const input = { kind: "text" as const, prompt: "Describe", settings: { systemPrompt: "System", reasoningEffort: "high" }, references: [{ kind: "image" as const, bytes: Buffer.from("image"), mimeType: "image/png" }] };
    expect(textGenerationBody(channel, input)).toMatchObject({ model: "text-model", reasoning: { effort: "high" }, stream: true, input: [{ role: "system", content: "System" }, { role: "user", content: [{ type: "input_text", text: "Describe" }, { type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" }] }] });
    expect(textGenerationBody({ ...channel, apiFormat: "gemini" }, input)).toMatchObject({ systemInstruction: { parts: [{ text: "System" }] }, contents: [{ role: "user", parts: [{ text: "Describe" }, { inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } }] }] });
});

test("Responses streaming awaits checkpoints, reconstructs split Unicode and requires a completion event", async () => {
    const updates: string[] = [];
    const text = event({ type: "response.output_text.delta", delta: "你" }) + event({ type: "response.output_text.delta", delta: "好" }) + event({ type: "response.completed", response: { status: "completed" } });
    const encoded = new TextEncoder().encode(text);
    const body = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of encoded) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
    expect(await readTextGenerationStream(new Response(body, { headers: { "content-type": "text/event-stream" } }), false, async (value) => { updates.push(value); })).toBe("你好");
    expect(updates).toEqual(["你", "你好"]);
    const interrupted: string[] = [];
    await expect(readTextGenerationStream(stream(event({ type: "response.output_text.delta", delta: "partial" }) + "data: [DONE]\n\n"), false, async (value) => { interrupted.push(value); })).rejects.toThrow("中断");
    expect(interrupted).toEqual(["partial"]);
});

test("stream failure/incomplete and Gemini blocked finish never certify partial content as success", async () => {
    for (const type of ["response.failed", "response.incomplete", "error"]) {
        await expect(readTextGenerationStream(stream(event({ type: "response.output_text.delta", delta: "partial" }) + event({ type })), false, async () => undefined)).rejects.toThrow("未正常完成");
    }
    await expect(readTextGenerationStream(stream(event({ candidates: [{ content: { parts: [{ text: "partial" }] } }] }) + event({ candidates: [{ finishReason: "MAX_TOKENS" }] })), true, async () => undefined)).rejects.toThrow("未正常完成");
    expect(await readTextGenerationStream(stream(event({ candidates: [{ content: { parts: [{ thought: true, text: "private thought" }, { text: "answer" }] }, finishReason: "STOP" }] })), true, async () => undefined)).toBe("answer");
    const checkpoints: string[] = [];
    await expect(readTextGenerationStream(stream(event({ candidates: [{ content: { parts: [{ text: "first" }] } }] }) + event({ candidates: [{ content: { parts: [{ text: "last" }] }, finishReason: "MAX_TOKENS" }] })), true, async (content) => { checkpoints.push(content); })).rejects.toThrow("未正常完成");
    expect(checkpoints).toEqual(["first", "firstlast"]);
    const fallback: string[] = [];
    await expect(readTextGenerationStream(Response.json({ candidates: [{ content: { parts: [{ text: "partial" }] }, finishReason: "SAFETY" }] }), true, async (content) => { fallback.push(content); })).rejects.toThrow("完成凭据");
    expect(fallback).toEqual(["partial"]);
});

test("nonstream fallback requires successful terminal status and checkpoints stable content", async () => {
    const updates: string[] = [];
    expect(await readTextGenerationStream(Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "final" }] }] }), false, async (value) => { updates.push(value); })).toBe("final");
    expect(updates).toEqual(["final"]);
    await expect(readTextGenerationStream(Response.json({ output_text: "not certified" }), false, async () => undefined)).rejects.toThrow("完成凭据");
});

test("audio request preserves browser voice/format/speed/instructions and archive bytes", async () => {
    const original = globalThis.fetch;
    const bytes = Buffer.from("RIFF-fixture-audio");
    let posted: any;
    globalThis.fetch = (async (_url, init) => { posted = JSON.parse(String(init?.body)); return new Response(bytes, { headers: { "content-type": "audio/wav" } }); }) as typeof fetch;
    try {
        const output = await submitAudio(channel, { kind: "audio", prompt: "Speak", settings: { voice: "coral", format: "wav", speed: "1.5", instructions: "Calm" }, references: [] });
        expect(posted).toEqual({ model: "text-model", input: "Speak", voice: "coral", response_format: "wav", speed: 1.5, instructions: "Calm" });
        expect(await downloadOutput(channel, output)).toEqual({ bytes, mimeType: "audio/wav" });
        globalThis.fetch = (async () => Response.json({ error: { message: "failed" } })) as typeof fetch;
        await expect(submitAudio(channel, { kind: "audio", prompt: "Speak", settings: {}, references: [] })).rejects.toThrow("未返回音频");
    } finally { globalThis.fetch = original; }
});

test("text candidates expose persisted complete and uncertain content under stable IDs without raw descriptors", () => {
    const row = { id: "task", workspace_id: "workspace", request_id: "request", kind: "text", request_snapshot: { prompt: "p", model: "m", settings: { count: 2 }, references: [] }, status: "needs_attention", submissions: [{ status: "completed", content: "final" }, { status: "uncertain", content: "partial" }], outputs: [], created_at: new Date(0), updated_at: new Date(0), revision: 3 } as unknown as GenerationTaskRow;
    expect(publicGenerationTask(row)).toMatchObject({ successCount: 1, failCount: 1, textOutputs: [{ id: "task-0", slotIndex: 0, status: "succeeded", content: "final" }, { id: "task-1", slotIndex: 1, status: "needs_attention", content: "partial" }] });
    const base = { requestId: "request", kind: "text", prompt: "p", model: "m", canvasTarget: { projectId: "p", nodeId: "n" }, settings: { count: 15, systemPrompt: "system", reasoningEffort: "high" }, references: [] };
    expect(normalizeGenerationRequest(base).settings.count).toBe(15);
    expect(() => normalizeGenerationRequest({ ...base, references: [{ kind: "audio", storageKey: "audio:ref" }] })).toThrow("图片参考");
    expect(() => normalizeGenerationRequest({ ...base, kind: "audio", settings: {}, references: [{ kind: "image", storageKey: "image:ref" }] })).toThrow("不支持参考");
});
