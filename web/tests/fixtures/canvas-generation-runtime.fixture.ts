import { expect, mock, test } from "bun:test";
import type { CanvasNodeData } from "../../src/types/canvas";
import type { GenerationTask } from "../../src/types/generation-task";

mock.module("react", () => ({ useRef: (value: unknown) => ({ current: value }), useCallback: (callback: unknown) => callback, useEffect: () => {}, useLayoutEffect: () => {} }));
mock.module("react-dom", () => ({ flushSync: (callback: () => void) => callback() }));
mock.module("../../src/lib/workspace", () => ({ getActiveWorkspace: () => ({ id: "workspace" }) }));
mock.module("../../src/services/image-storage", () => ({ uploadImage: () => { throw new Error("unexpected upload"); } }));
mock.module("../../src/services/file-storage", () => ({ uploadMediaFile: () => { throw new Error("unexpected upload"); } }));
let flush: () => Promise<unknown>;
let submit: (input: any) => Promise<GenerationTask>;
let postCount = 0;
let readTask: () => Promise<GenerationTask> = async () => { throw new Error("unexpected poll"); };
let onUpdate: (nodes: CanvasNodeData[]) => void = () => {};
const saved: CanvasNodeData[][] = [];
mock.module("../../src/stores/canvas/use-canvas-store", () => ({ flushCanvasSave: () => flush(), useCanvasStore: { getState: () => ({ updateProject: (_id: string, value: { nodes: CanvasNodeData[] }) => saved.push(structuredClone(value.nodes)) }) } }));
mock.module("../../src/services/api/generation-tasks", () => ({ submitGenerationTask: (_workspace: string, input: any) => { postCount++; return submit(input); }, getGenerationTask: () => readTask(), getGenerationTaskByRequestId: () => { throw new Error("unexpected recovery"); }, listCanvasGenerationTasks: async () => [] }));
const { useCanvasGenerationTasks } = await import("../../src/pages/canvas/hooks/use-canvas-generation-tasks");
const { hydrateCanvasTaskOutputDimensions, projectCanvasTask } = await import("../../src/lib/canvas/canvas-generation-tasks");

function fixture() {
    saved.length = 0; postCount = 0; onUpdate = () => {};
    const nodesRef = { current: [{ id: "node", type: "image", title: "image", position: { x: 0, y: 0 }, width: 240, height: 240, metadata: {} }] as CanvasNodeData[] };
    const setNodes = (value: any) => { nodesRef.current = typeof value === "function" ? value(nodesRef.current) : value; onUpdate(nodesRef.current); };
    const runtime = useCanvasGenerationTasks({ projectId: "project", loaded: false, nodes: nodesRef.current, nodesRef, connectionsRef: { current: [] }, setNodes });
    const controller = new AbortController();
    const run = (overrides: Record<string, unknown> = {}) => runtime.run({ nodeId: "node", requestId: "request", kind: "image", prompt: "prompt", config: { model: "fixture" } as any, signal: controller.signal, ...overrides });
    return { nodesRef, controller, run, runtime };
}
const completed = (overrides: Partial<GenerationTask> = {}): GenerationTask => ({ id: "task", workspaceId: "workspace", requestId: "request", kind: "image", canvasTarget: { projectId: "project", nodeId: "node" }, prompt: "prompt", model: "fixture", settings: {}, references: [], outputs: [], status: "succeeded", successCount: 0, failCount: 0, revision: 1, createdAt: "now", updatedAt: "now", ...overrides });

test("text retry input and stable references are saved before submission", async () => {
    flush = async () => {};
    const config = { model: "model", systemPrompt: "original system", reasoningEffort: "low", audioVoice: "", audioFormat: "mp3", audioSpeed: "1", audioInstructions: "" };
    submit = async (input) => {
        expect(saved[0][0].metadata!.generationTask).toMatchObject({ retryInput: { prompt: "original prompt", ...config }, references: [{ kind: "image", storageKey: "image:original" }] });
        expect(input.settings.systemPrompt).toBe("original system");
        return completed({ kind: "text", textOutputs: [] });
    };
    const state = fixture();
    await state.run({ kind: "text", prompt: "original prompt", config, images: [{ id: "image", name: "image.png", type: "image/png", dataUrl: "", storageKey: "image:original" }] });
});

test("stop after saved marker but before POST persists a retryable no-submission state", async () => {
    let release!: () => void;
    let calls = 0;
    flush = () => ++calls === 1 ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve();
    submit = async () => { throw new Error("must not submit"); };
    const state = fixture();
    const running = state.run();
    expect(saved[0][0].metadata!.generationTask!.status).toBe("queued");
    state.controller.abort(); release();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(postCount).toBe(0);
    expect(calls).toBe(2);
    expect(saved.at(-1)![0].metadata!.generationTask).toMatchObject({ status: "failed", submissionState: "not_submitted" });
    expect(state.nodesRef.current[0].metadata!.images![0].status).toBe("error");
});

test("failed marker save cleans up and confirms failed state without POST", async () => {
    let calls = 0;
    flush = () => ++calls === 1 ? Promise.reject(new Error("save failed")) : Promise.resolve();
    const state = fixture();
    await expect(state.run()).rejects.toThrow("save failed");
    expect(postCount).toBe(0);
    expect(calls).toBe(2);
    expect(saved.at(-1)![0].metadata!.generationTask!.submissionState).toBe("not_submitted");
});

test("fresh 400 is retryable; unknown POST failure preserves original request", async () => {
    flush = async () => {};
    submit = async () => { throw Object.assign(new Error("invalid size"), { status: 400 }); };
    const rejected = fixture(); await rejected.run();
    expect(postCount).toBe(1);
    expect(rejected.nodesRef.current[0].metadata!.generationTask).toMatchObject({ status: "failed", submissionState: "not_submitted" });
    submit = async () => { throw new Error("lost receipt"); };
    const unknown = fixture(); await unknown.run();
    expect(postCount).toBe(1);
    expect(unknown.nodesRef.current[0].metadata!.generationTask).toMatchObject({ requestId: "request", status: "queued" });
    expect(unknown.nodesRef.current[0].metadata!.generationTask!.submissionState).toBeUndefined();
});

test("pre-submit cleanup cannot overwrite a later attempt", async () => {
    let release!: () => void;
    flush = () => new Promise<void>((resolve) => { release = resolve; });
    const state = fixture(); const running = state.run();
    state.nodesRef.current = state.nodesRef.current.map((node) => ({ ...node, metadata: { ...node.metadata, generationTask: { ...node.metadata!.generationTask!, requestId: "replacement" } } }));
    state.controller.abort(); release();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(state.nodesRef.current[0].metadata!.generationTask!.requestId).toBe("replacement");
    expect(postCount).toBe(0);
});

test("real DOM media metadata determines portrait image and landscape video dimensions", async () => {
    const urls: string[] = [];
    class ImageFixture { naturalWidth = 320; naturalHeight = 960; onload?: () => void; onerror?: () => void; set src(url: string) { urls.push(url); queueMicrotask(() => this.onload?.()); } }
    class VideoFixture { videoWidth = 1920; videoHeight = 1080; duration = 6; onload?: () => void; onerror?: () => void; onloadedmetadata?: () => void; preload = ""; removeAttribute() {} load() {} set src(url: string) { urls.push(url); queueMicrotask(() => this.onloadedmetadata?.()); } }
    Object.assign(globalThis, { Image: ImageFixture, document: { createElement: () => new VideoFixture() } });
    const output = { id: "out", slotIndex: 0, storageKey: "image:archived", bytes: 10, mimeType: "image/png" };
    const image = await hydrateCanvasTaskOutputDimensions(completed({ outputs: [output] }), new AbortController().signal);
    expect(image.outputs[0]).toMatchObject({ width: 320, height: 960 });
    const owner = { requestId: "request", workspaceId: "workspace", projectId: "project", nodeId: "node", kind: "image" as const, slotIds: ["slot"] };
    const node: CanvasNodeData = { id: "node", type: "image", title: "portrait", width: 240, height: 240, position: { x: 0, y: 0 }, metadata: { generationTask: owner } };
    const projected = projectCanvasTask(node, owner, image);
    expect(projected.width / projected.height).toBeCloseTo(1 / 3);
    expect(projected.metadata!.naturalHeight).toBe(960);
    const video = await hydrateCanvasTaskOutputDimensions(completed({ kind: "video", outputs: [{ ...output, storageKey: "video:archived", mimeType: "video/mp4" }] }), new AbortController().signal);
    expect(video.outputs[0]).toMatchObject({ width: 1920, height: 1080, durationMs: 6000 });
    expect(urls.every((url) => url.startsWith("/api/media/blob/") && url.includes("workspaceId=workspace"))).toBe(true);
});

test("decode failure keeps stable results readable without inventing dimensions; abort is respected", async () => {
    const source = completed({ outputs: [{ id: "out", storageKey: "image:archived", bytes: 10, mimeType: "image/png" }] });
    const hydrated = await hydrateCanvasTaskOutputDimensions(source, new AbortController().signal, async () => { throw new Error("unavailable"); });
    expect(hydrated.outputs[0].width).toBeUndefined();
    expect(hydrated.outputs[0].storageKey).toBe("image:archived");
    const controller = new AbortController();
    await expect(hydrateCanvasTaskOutputDimensions(source, controller.signal, async () => { controller.abort(); return { width: 1, height: 1 }; })).rejects.toMatchObject({ name: "AbortError" });
});


test("pending metadata does not block GET updates and late decoding uses the latest revision", async () => {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const originalImage = globalThis.Image;
    let tick!: () => void;
    let decoded!: () => void;
    let started!: () => void;
    const mediaStarted = new Promise<void>((resolve) => { started = resolve; });
    let decodeCount = 0;
    class PendingImage { naturalWidth = 320; naturalHeight = 960; onload?: () => void; onerror?: () => void; set src(_url: string) { decodeCount++; decoded = () => this.onload?.(); started(); } }
    Object.assign(globalThis, { Image: PendingImage, setInterval: (callback: () => void) => { tick = callback; return 1; }, clearInterval: () => {} });
    try {
        flush = async () => {};
        const first = { id: "out-old", storageKey: "image:old", slotIndex: 0, mimeType: "image/png", bytes: 12 };
        const second = { id: "out-new", storageKey: "image:new", slotIndex: 1, mimeType: "image/png", bytes: 14, width: 640, height: 320 };
        submit = async () => completed({ status: "archiving", revision: 1, outputs: [first] });
        let getCount = 0;
        readTask = async () => { getCount++; return completed({ status: "succeeded", revision: 3, outputs: [first, second], successCount: 2 }); };
        const state = fixture();
        const running = state.run({ slotIds: ["slot-a", "slot-b"] });
        await mediaStarted;
        expect(state.nodesRef.current[0].metadata!.generationTask!.status).toBe("archiving");
        tick();
        await running;
        expect(getCount).toBe(1);
        expect(decodeCount).toBe(1);
        expect(state.nodesRef.current[0].metadata!.generationTask!.status).toBe("succeeded");
        expect(state.nodesRef.current[0].metadata!.images![1].storageKey).toBe("image:new");
        const projected = new Promise<void>((resolve) => { onUpdate = (nodes) => { if (nodes[0].metadata?.naturalWidth === 320) resolve(); }; });
        decoded();
        await projected;
        expect(state.nodesRef.current[0].metadata!.generationTask!.status).toBe("succeeded");
        expect(state.nodesRef.current[0].metadata!.images!.map((image) => image.storageKey)).toEqual(["image:old", "image:new"]);
        expect(state.nodesRef.current[0].metadata!.naturalHeight).toBe(960);
        state.controller.abort();
    } finally {
        Object.assign(globalThis, { setInterval: originalSetInterval, clearInterval: originalClearInterval, Image: originalImage });
        onUpdate = () => {};
    }
});

test("late GET from an old watcher cannot overwrite a newer task binding or result", async () => {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    let tick!: () => void;
    let releaseOld!: (task: GenerationTask) => void;
    let oldGetStarted!: () => void;
    const oldGet = new Promise<void>((resolve) => { oldGetStarted = resolve; });
    Object.assign(globalThis, { setInterval: (callback: () => void) => { tick = callback; return 1; }, clearInterval: () => {} });
    try {
        flush = async () => {};
        submit = async (input) => input.requestId === "request"
            ? completed({ kind: "text", status: "running", textOutputs: [{ id: "old", slotIndex: 0, content: "old partial", status: "running" }] })
            : completed({ id: "new-task", requestId: "new-request", kind: "text", status: "succeeded", textOutputs: [{ id: "new", slotIndex: 0, content: "new result", status: "succeeded" }] });
        readTask = () => { oldGetStarted(); return new Promise<GenerationTask>((resolve) => { releaseOld = resolve; }); };
        const state = fixture();
        const started = new Promise<void>((resolve) => { onUpdate = (nodes) => { if (nodes[0].metadata?.content === "old partial") resolve(); }; });
        const first = state.run({ kind: "text", slotIds: ["slot"] });
        await started;
        tick();
        await oldGet;
        await state.run({ requestId: "new-request", kind: "text", slotIds: ["slot"] });
        releaseOld(completed({ kind: "text", status: "succeeded", revision: 2, textOutputs: [{ id: "old", slotIndex: 0, content: "late old result", status: "succeeded" }] }));
        await first;
        await Promise.resolve();
        expect(state.nodesRef.current[0].metadata).toMatchObject({ content: "new result", status: "success", generationTask: { requestId: "new-request", taskId: "new-task", status: "succeeded" }, texts: [{ id: "slot", content: "new result", status: "success" }] });
    } finally { Object.assign(globalThis, { setInterval: originalSetInterval, clearInterval: originalClearInterval }); onUpdate = () => {}; }
});

test("text GET interruption preserves partial text without reporting it as successful", async () => {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    let tick!: () => void;
    Object.assign(globalThis, { setInterval: (callback: () => void) => { tick = callback; return 1; }, clearInterval: () => {} });
    try {
        flush = async () => {};
        submit = async () => completed({ kind: "text", status: "submitting", textOutputs: [{ id: "task-0", slotIndex: 0, content: "partial", status: "running" }] });
        readTask = async () => { throw new Error("offline"); };
        const state = fixture();
        const started = new Promise<void>((resolve) => { onUpdate = (nodes) => { if (nodes[0].metadata?.content === "partial") resolve(); }; });
        const running = state.run({ kind: "text", slotIds: ["slot-a"] });
        await started;
        tick();
        await running;
        expect(state.nodesRef.current[0].metadata).toMatchObject({ status: "error", content: "partial", texts: [{ id: "slot-a", status: "error", content: "partial" }] });
    } finally { Object.assign(globalThis, { setInterval: originalSetInterval, clearInterval: originalClearInterval }); onUpdate = () => {}; }
});

test("stopping a partial text keeps completed siblings and marks only unfinished candidates", async () => {
    flush = async () => {};
    submit = async () => completed({ kind: "text", status: "submitting", textOutputs: [{ id: "task-0", slotIndex: 0, content: "complete", status: "succeeded" }, { id: "task-1", slotIndex: 1, content: "partial", status: "running" }] });
    const state = fixture();
    const started = new Promise<void>((resolve) => { onUpdate = (nodes) => { if (nodes[0].metadata?.texts?.[1]?.content === "partial") resolve(); }; });
    const running = state.run({ kind: "text", slotIds: ["slot-a", "slot-b"] });
    await started;
    state.runtime.stop("node");
    await running;
    expect(state.nodesRef.current[0].metadata).toMatchObject({ status: "success", texts: [{ id: "slot-a", status: "success", content: "complete" }, { id: "slot-b", status: "error", content: "partial" }] });
    onUpdate = () => {};
});
