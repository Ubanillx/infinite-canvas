import { expect, test } from "bun:test";
import { assertCanvasGenerationBinding, generationRequestHash, normalizeGenerationRequest, publicGenerationTask, type GenerationTaskRow } from "../src/server/generation-tasks";

test("task receipt restores stable typed input references without private object versions or URLs", () => {
    const references = [
        { kind: "image", storageKey: "image:input", name: "reference.png", mimeType: "image/png", width: 640, height: 480, objectVersion: "private-version" },
        { kind: "video", storageKey: "video:input", name: "reference.mp4", mimeType: "video/mp4", durationMs: 5000, objectVersion: "private-version" },
        { kind: "audio", storageKey: "audio:input", name: "reference.mp3", mimeType: "audio/mpeg", durationMs: 2000, objectVersion: "private-version" },
    ];
    const row = { id: "task", workspace_id: "workspace", request_id: "request", kind: "video", request_snapshot: { prompt: "test", model: "mock", settings: {}, references }, status: "queued", outputs: [], created_at: new Date(0), updated_at: new Date(0), revision: 1 } as unknown as GenerationTaskRow;
    const task = publicGenerationTask(row);
    expect(task.references).toEqual(references.map(({ objectVersion: _version, ...reference }) => reference));
    expect(JSON.stringify(task)).not.toContain("private-version");
});

test("normalization keeps optional reference dimensions and duration for history restoration", () => {
    const input = normalizeGenerationRequest({ requestId: "request", kind: "video", prompt: "test", model: "mock", settings: {}, references: [{ kind: "video", storageKey: "video:input", name: "clip", width: 640, height: 480, durationMs: 5000 }] });
    expect(input.references[0]).toMatchObject({ width: 640, height: 480, durationMs: 5000 });
});

test("canvas target is whitelisted in receipts and participates in request identity", () => {
    const input = { requestId: "request", kind: "image", prompt: "test", model: "mock", settings: {}, references: [], canvasTarget: { projectId: "project", nodeId: "node", apiKey: "private" } };
    const normalized = normalizeGenerationRequest(input);
    expect(normalized.canvasTarget).toEqual({ projectId: "project", nodeId: "node" });
    expect(generationRequestHash(normalized)).not.toBe(generationRequestHash({ ...normalized, canvasTarget: { projectId: "other-project", nodeId: "node" } }));
    const row = { id: "task", workspace_id: "workspace", request_id: "request", kind: "image", request_snapshot: { ...normalized, canvasTarget: input.canvasTarget }, status: "queued", outputs: [], created_at: new Date(0), updated_at: new Date(0), revision: 1 } as unknown as GenerationTaskRow;
    expect(publicGenerationTask(row).canvasTarget).toEqual({ projectId: "project", nodeId: "node" });
    expect(JSON.stringify(publicGenerationTask(row))).not.toContain("private");
    for (const canvasTarget of [null, [], {}, { projectId: "", nodeId: "node" }, { projectId: "project", nodeId: 1 }]) expect(() => normalizeGenerationRequest({ ...input, canvasTarget })).toThrow("目标无效");
});

test("canvas billing requires the committed node to carry exactly the request binding", () => {
    const target = { projectId: "project", nodeId: "node" };
    const payload = { state: { projects: [{ id: "project", nodes: [{ id: "node", metadata: { generationTask: { requestId: "request" } } }] }] } };
    expect(() => assertCanvasGenerationBinding(payload, target, "request")).not.toThrow();
    for (const badTarget of [{ ...target, projectId: "other" }, { ...target, nodeId: "other" }]) expect(() => assertCanvasGenerationBinding(payload, badTarget, "request")).toThrow("绑定已变化");
    expect(() => assertCanvasGenerationBinding(payload, target, "new-request")).toThrow("绑定已变化");
    expect(() => assertCanvasGenerationBinding(null, target, "request")).toThrow("绑定已变化");
});

test("canvas image batches retain 15 slots while workbench batches retain 10", () => {
    const input = { requestId: "request", kind: "image", prompt: "test", model: "mock", references: [] };
    const canvasTarget = { projectId: "project", nodeId: "node" };
    expect(normalizeGenerationRequest({ ...input, canvasTarget, settings: { count: 15 } }).settings.count).toBe(15);
    expect(() => normalizeGenerationRequest({ ...input, canvasTarget, settings: { count: 16 } })).toThrow("不能超过 15");
    expect(normalizeGenerationRequest({ ...input, settings: { count: 10 } }).settings.count).toBe(10);
    expect(() => normalizeGenerationRequest({ ...input, settings: { count: 11 } })).toThrow("不能超过 10");
});
