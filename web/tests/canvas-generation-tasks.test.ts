import { expect, test } from "bun:test";
import { assertCanvasTaskRequest, canvasTaskRetryConfig, matchesCanvasTask, projectCanvasTask, savedCanvasTaskRetry } from "../src/lib/canvas/canvas-generation-tasks";
import type { AiConfig } from "../src/stores/use-config-store";
import { CanvasNodeType, type CanvasGenerationTaskBinding, type CanvasNodeData, type CanvasNodeImage } from "../src/types/canvas";
import type { GenerationTask } from "../src/types/generation-task";

const binding: CanvasGenerationTaskBinding = { requestId: "request-a", workspaceId: "workspace-a", projectId: "project-a", nodeId: "node-a", kind: "image", slotIds: ["slot-a", "slot-b", "slot-c"] };
const image = (id: string): CanvasNodeImage => ({ id, status: "loading", content: "", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "" });
function node(owner = binding): CanvasNodeData {
    return { id: owner.nodeId, type: owner.kind === "image" ? CanvasNodeType.Image : CanvasNodeType.Video, title: "User title", width: 240, height: 180, position: { x: 100, y: 200 }, metadata: { generationTask: structuredClone(owner), images: owner.slotIds.map(image), prompt: "Keep edited prompt" } };
}
function task(overrides: Partial<GenerationTask> = {}): GenerationTask {
    return { id: "task-a", requestId: binding.requestId, workspaceId: binding.workspaceId, canvasTarget: { projectId: binding.projectId, nodeId: binding.nodeId }, kind: "image", prompt: "Original prompt", model: "fixture", settings: { count: 3 }, references: [], outputs: [], status: "queued", successCount: 0, failCount: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", revision: 1, ...overrides };
}
const output = (slotIndex: number, kind = "image") => ({ id: `output-${slotIndex}`, storageKey: `${kind}:stable-${slotIndex}`, slotIndex, mimeType: kind === "image" ? "image/png" : "video/mp4", bytes: 12, width: 1024, height: 512 });

test("retry uses original system and audio settings including empty values, and old bindings fall back", () => {
    const current = { systemPrompt: "new system", audioInstructions: "new instruction", audioVoice: "new voice" } as AiConfig;
    const retryInput = { prompt: "original", model: "original-model", systemPrompt: "original system", reasoningEffort: "low" as const, audioVoice: "", audioFormat: "mp3", audioSpeed: "1", audioInstructions: "" };
    const restored = canvasTaskRetryConfig(current, { ...binding, kind: "audio", retryInput });
    expect(restored).toMatchObject({ model: "original-model", systemPrompt: "original system", reasoningEffort: "low", audioVoice: "", audioInstructions: "" });
    expect(canvasTaskRetryConfig(current, binding)).toBe(current);
    const textBinding = { ...binding, kind: "text" as const, retryInput, references: [{ kind: "image" as const, storageKey: "image:original" }] };
    expect(savedCanvasTaskRetry(textBinding, "changed prompt")).toMatchObject({ prompt: "original", images: [{ storageKey: "image:original", dataUrl: "" }] });
    expect(savedCanvasTaskRetry({ ...textBinding, retryInput: undefined, references: undefined }, "legacy")).toBeNull();
    expect(savedCanvasTaskRetry({ ...textBinding, kind: "audio", retryInput: undefined, references: undefined }, "legacy")).toEqual({ prompt: "legacy", images: [] });
});

test("same request ID rejects a different source, mode, prompt or configuration fingerprint", () => {
    const owner = { ...binding, originNodeId: "source", requestFingerprint: "original prompt and config" };
    expect(() => assertCanvasTaskRequest(owner, "source", "image", "original prompt and config")).not.toThrow();
    expect(() => assertCanvasTaskRequest(owner, "another-source", "image", "original prompt and config")).toThrow("参数已变化");
    expect(() => assertCanvasTaskRequest(owner, "source", "video", "original prompt and config")).toThrow("参数已变化");
    expect(() => assertCanvasTaskRequest(owner, "source", "image", "changed prompt or config")).toThrow("参数已变化");
});

test("late tasks cannot cross workspace, project, node, request, kind or bound task ownership", () => {
    const source = node();
    expect(matchesCanvasTask(source, binding, task())).toBe(true);
    for (const patch of [{ workspaceId: "other" }, { requestId: "other" }, { kind: "video" as const }, { canvasTarget: { projectId: "other", nodeId: binding.nodeId } }, { canvasTarget: { projectId: binding.projectId, nodeId: "other" } }, { canvasTarget: undefined }]) {
        expect(projectCanvasTask(source, binding, task(patch))).toBe(source);
    }
    for (const patch of [{ workspaceId: "other" }, { projectId: "other" }, { nodeId: "other" }, { requestId: "new-user-request" }]) {
        const changed = node({ ...binding, ...patch });
        expect(projectCanvasTask(changed, binding, task())).toBe(changed);
    }
    const undone = { ...source, metadata: { prompt: "Restored before generation" } };
    expect(projectCanvasTask(undone, binding, task())).toBe(undone);
    expect(projectCanvasTask(source, { ...binding, taskId: "another-task" }, task())).toBe(source);
});

test("out-of-order sparse image outputs retain their original slots and expose stable workspace URLs", () => {
    const result = projectCanvasTask(node(), binding, task({ status: "needs_attention", outputs: [output(2), output(0)], successCount: 2, failCount: 1 }));
    expect(result.metadata!.images!.map(({ id, status, storageKey }) => ({ id, status, storageKey }))).toEqual([
        { id: "slot-a", status: "success", storageKey: "image:stable-0" },
        { id: "slot-b", status: "error", storageKey: undefined },
        { id: "slot-c", status: "success", storageKey: "image:stable-2" },
    ]);
    expect(result.metadata!.primaryImageId).toBe("slot-a");
    const url = new URL(result.metadata!.content!, "http://localhost");
    expect(decodeURIComponent(url.pathname)).toBe("/api/media/blob/image:stable-0");
    expect(url.searchParams.get("workspaceId")).toBe(binding.workspaceId);
    expect(result.metadata!.status).toBe("success");
    expect(result.metadata!.generationTask).toMatchObject({ taskId: "task-a", status: "needs_attention" });
});

test("repeated recovery is idempotent and preserves user title, prompt, position and selected primary", () => {
    const source = node();
    source.metadata!.primaryImageId = "slot-c";
    const completed = task({ status: "succeeded", outputs: [output(0), output(1), output(2)], successCount: 3 });
    const first = projectCanvasTask(source, binding, completed);
    const again = projectCanvasTask(first, first.metadata!.generationTask!, completed);
    expect(again).toEqual(first);
    expect(again.metadata!.primaryImageId).toBe("slot-c");
    expect(again.metadata!.storageKey).toBe("image:stable-2");
    expect(again.title).toBe(source.title);
    expect(again.metadata!.prompt).toBe("Keep edited prompt");
    expect(again.position.x + again.width / 2).toBe(source.position.x + source.width / 2);
    expect(again.position.y + again.height / 2).toBe(source.position.y + source.height / 2);
    expect(source.metadata!.images!.every((image) => !image.storageKey)).toBe(true);
});

test("slot retry preserves another primary and never recreates a user-deleted batch slot", () => {
    const owner = { ...binding, slotIds: ["slot-b"], preservePrimary: true };
    const source = node(owner);
    const primary = { ...image("slot-a"), status: "success" as const, content: "blob:user-primary", storageKey: "image:user-primary", naturalWidth: 400, naturalHeight: 300 };
    source.metadata = { ...source.metadata, images: [primary, image("slot-b")], primaryImageId: primary.id, content: primary.content, storageKey: primary.storageKey };
    const retried = projectCanvasTask(source, owner, task({ status: "succeeded", outputs: [output(0)] }));
    expect(retried.metadata!.images![0]).toEqual(primary);
    expect(retried.metadata!.images![1].storageKey).toBe("image:stable-0");
    expect(retried.metadata!.primaryImageId).toBe(primary.id);
    expect(retried.metadata!.storageKey).toBe(primary.storageKey);
    const deleted = { ...source, metadata: { ...source.metadata, images: [primary] } };
    expect(projectCanvasTask(deleted, owner, task({ status: "succeeded", outputs: [output(0)] })).metadata!.images).toEqual([primary]);
});

test("video recovery reuses archived media without retaining upstream identifiers and repeats without geometry drift", () => {
    const owner = { ...binding, kind: "video" as const, slotIds: ["video-slot"] };
    const source = node(owner);
    const running = projectCanvasTask(source, owner, task({ kind: "video", status: "running" }));
    expect(running.metadata!.status).toBe("loading");
    const completed = task({ kind: "video", status: "succeeded", outputs: [{ ...output(0, "video"), durationMs: 6000 }] });
    const result = projectCanvasTask(running, owner, completed);
    expect(result.metadata).toMatchObject({ storageKey: "video:stable-0", mimeType: "video/mp4", bytes: 12, durationMs: 6000, status: "success" });
    expect(projectCanvasTask(result, result.metadata!.generationTask!, completed)).toEqual(result);
    expect(JSON.stringify(result)).not.toMatch(/data:|upstream|apiKey/);
});

test("text streaming snapshots preserve candidate IDs and selected primary without treating uncertain partial text as success", () => {
    const owner = { ...binding, kind: "text" as const };
    const source: CanvasNodeData = { ...node(owner), type: CanvasNodeType.Text, metadata: { generationTask: owner, texts: owner.slotIds.map((id) => ({ id, status: "loading", content: "" })), primaryTextId: "slot-c" } };
    const running = task({ kind: "text", status: "running", textOutputs: [{ id: "text-0", slotIndex: 0, content: "finished A", status: "succeeded" }, { id: "text-2", slotIndex: 2, content: "stream C", status: "running" }] });
    const projected = projectCanvasTask(source, owner, running);
    expect(projected.metadata).toMatchObject({ primaryTextId: "slot-c", content: "stream C", status: "loading" });
    expect(projected.metadata!.texts!.map(({ id, status }) => ({ id, status }))).toEqual([{ id: "slot-a", status: "success" }, { id: "slot-b", status: "loading" }, { id: "slot-c", status: "loading" }]);
    const uncertain = task({ ...running, status: "needs_attention", textOutputs: [{ id: "text-0", slotIndex: 0, content: "finished A", status: "succeeded" }, { id: "text-2", slotIndex: 2, content: "stream C", status: "needs_attention" }] });
    const restored = projectCanvasTask(projected, owner, uncertain);
    expect(restored.metadata!.texts![2]).toMatchObject({ content: "stream C", status: "error" });
    expect(restored.metadata!.primaryTextId).toBe("slot-c");
    expect(projectCanvasTask(restored, restored.metadata!.generationTask!, uncertain)).toEqual(restored);
    const partialOnly = projectCanvasTask(source, owner, task({ kind: "text", status: "needs_attention", textOutputs: [{ id: "text-2", slotIndex: 2, content: "partial", status: "needs_attention" }] }));
    expect(partialOnly.metadata!.status).toBe("error");
    expect(partialOnly.metadata!.content).toBe("partial");
});

test("text recovery respects removed candidates and retries retain unrelated successful results", () => {
    const owner = { ...binding, kind: "text" as const, slotIds: ["slot-b"], preservePrimary: true };
    const primary = { id: "slot-a", status: "success" as const, content: "keep primary" };
    const source: CanvasNodeData = { ...node(owner), type: CanvasNodeType.Text, metadata: { generationTask: owner, texts: [primary, { id: "slot-b", status: "loading", content: "" }], primaryTextId: primary.id, content: primary.content } };
    const complete = task({ kind: "text", status: "succeeded", textOutputs: [{ id: "text-0", slotIndex: 0, content: "retried", status: "succeeded" }] });
    const result = projectCanvasTask(source, owner, complete);
    expect(result.metadata!.texts).toEqual([primary, { id: "slot-b", status: "success", content: "retried", errorDetails: undefined }]);
    expect(result.metadata!.content).toBe(primary.content);
    const deleted = { ...source, metadata: { ...source.metadata, texts: [primary] } };
    expect(projectCanvasTask(deleted, owner, complete).metadata!.texts).toEqual([primary]);
});

test("audio projection uses stable authenticated media and duration without changing node geometry", () => {
    const owner = { ...binding, kind: "audio" as const, slotIds: ["audio-slot"] };
    const source: CanvasNodeData = { ...node(owner), type: CanvasNodeType.Audio };
    const result = projectCanvasTask(source, owner, task({ kind: "audio", status: "succeeded", outputs: [{ id: "audio", storageKey: "audio:stable", mimeType: "audio/wav", bytes: 88, durationMs: 1500 }] }));
    expect(result.metadata).toMatchObject({ status: "success", storageKey: "audio:stable", mimeType: "audio/wav", durationMs: 1500, bytes: 88 });
    expect(result.metadata!.content).toContain("workspaceId=workspace-a");
    expect(result.position).toEqual(source.position);
    expect(result.width).toBe(source.width);
    expect(projectCanvasTask(result, result.metadata!.generationTask!, task({ kind: "audio", status: "failed" })).metadata!.status).toBe("error");
});
