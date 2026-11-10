import { afterEach, beforeEach, expect, mock, test } from "bun:test";

const workspace = { id: "workspace-a", name: "A", role: "editor", createdAt: "2026-01-01T00:00:00Z" };
const graph = { nodes: [{ id: "node-a", type: "text", title: "Text", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: "hello" } }], connections: [], backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } };
const sourceProject = { ...graph, id: "source", title: "Source", description: "", folderId: null, createdAt: "now", updatedAt: "now", chatSessions: [], activeChatId: null };
const targetProject = { ...structuredClone(sourceProject), id: "target", title: "Target", nodes: [], connections: [] };
const savedTemplate = { id: "template-a", title: "Example", description: "", content: graph, cover: { storageKey: "image:cover" }, createdAt: "now", updatedAt: "now" };
let activeWorkspace = workspace;
let pathname = "/canvas";
let canvasState: any;
let templateState: any;
let copied = 0;
let copiedKey: string | null;
let canvasCommit: () => Promise<any>;
let templateCommit: () => Promise<any>;
let originalWindow: PropertyDescriptor | undefined;

const useCanvasStore = Object.assign(() => canvasState, {
    getState: () => canvasState,
    persist: { getOptions: () => ({ name: `workspace:${workspace.id}:infinite-canvas:canvas_store` }) },
});
const useCanvasTemplateStore = Object.assign(() => templateState, { getState: () => templateState });
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null } });

mock.module("../../src/stores/canvas/use-canvas-store", () => ({ useCanvasStore, flushCanvasSave: () => canvasCommit() }));
mock.module("../../src/stores/canvas/use-canvas-template-store", () => ({ useCanvasTemplateStore }));
mock.module("../../src/services/canvas-templates", () => ({
    copyCanvasTemplateContent: async (content: any, _workspaceId: string, copiedKeys?: Set<string>) => { copied += 1; if (copiedKey) copiedKeys?.add(copiedKey); return structuredClone(content); },
    templateMediaError: (error: unknown, keys: Set<string>) => new Error(`${String(error)}；本次已复制媒体（未确认业务提交，请核对）：${[...keys].join(", ")}`),
}));
mock.module("../../src/stores/use-config-store", () => ({ useConfigStore: { getState: () => ({ config: {} }) }, modelCapabilityOf: () => undefined, selectableModelsByCapability: () => [] }));
mock.module("../../src/lib/canvas/node-registry", () => ({ isBuiltinNodeType: (type: string) => ["text", "image", "config", "video", "audio", "group"].includes(type), getNodeDefinition: () => undefined }));

const { runTemplateTool } = await import("../../src/lib/agent/agent-template-tools");

beforeEach(() => {
    originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    activeWorkspace = workspace;
    pathname = "/canvas";
    copied = 0;
    copiedKey = null;
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
        location: { get pathname() { return pathname; } },
        localStorage: { getItem: (key: string) => key === "infinite-canvas:active-workspace" ? JSON.stringify(activeWorkspace) : null },
    } });
    canvasState = {
        hydrated: true, projects: [structuredClone(sourceProject), structuredClone(targetProject)], folders: [],
        updateProject: (id: string, patch: any) => { canvasState.projects = canvasState.projects.map((item: any) => item.id === id ? { ...item, ...patch } : item); },
        createProjectFromTemplateWithCommit: async () => ({ id: "new-project", commit: await canvasCommit() }),
    };
    templateState = {
        loaded: true, workspaceId: workspace.id, templates: [structuredClone(savedTemplate)], load: async () => {},
        save: async () => ({ id: "created", commit: await templateCommit() }),
        update: async () => templateCommit(), replace: async () => templateCommit(), remove: async () => templateCommit(),
    };
    canvasCommit = async () => ({ workspaceId: workspace.id, domain: "canvas", revision: 4, updatedAt: "now" });
    templateCommit = async () => ({ workspaceId: workspace.id, domain: "canvas-templates", revision: 7, updatedAt: "now" });
});

afterEach(() => {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
});

test("list is scoped, and viewer or stale template store cannot write", async () => {
    expect(await runTemplateTool("templates_list", { workspaceId: workspace.id })).toMatchObject({ total: 1, workspaceId: workspace.id });
    activeWorkspace = { ...workspace, role: "viewer" };
    await expect(runTemplateTool("templates_delete", { workspaceId: workspace.id, templateId: "template-a" })).rejects.toThrow("只读");
    activeWorkspace = workspace;
    templateState.workspaceId = "workspace-b";
    await expect(runTemplateTool("templates_delete", { workspaceId: workspace.id, templateId: "template-a" })).rejects.toThrow("切换前");
});

test("saving a selection uses the live canvas snapshot and reports committed revision", async () => {
    pathname = "/canvas/source";
    let captured: any;
    templateState.save = async (content: any) => { captured = content; return { id: "created", commit: await templateCommit() }; };
    const live = { projectId: "source", getContent: () => ({ ...structuredClone(graph), nodes: [{ ...graph.nodes[0], title: "Live" }] }), insert: async () => { throw new Error("unused"); } };
    const result = await runTemplateTool("templates_create", { workspaceId: workspace.id, projectId: "source", title: "Live template", selectionNodeIds: ["node-a"], includeDependencies: true }, live);
    expect(captured.nodes[0].title).toBe("Live");
    expect(result).toMatchObject({ status: "committed", templateId: "created", revision: 7 });
});

test("open source rejects a stale store when its live bridge is not ready", async () => {
    pathname = "/canvas/source";
    await expect(runTemplateTool("templates_create", { workspaceId: workspace.id, projectId: "source", title: "Unsafe" })).rejects.toThrow("编辑器未就绪");
    expect(copied).toBe(0);
});

test("open target uses live insertion; non-open target waits for canvas commit", async () => {
    pathname = "/canvas/target";
    let liveCalls = 0;
    const live = { projectId: "target", getContent: () => structuredClone(graph), insert: async (content: any) => {
        liveCalls += 1;
        return { workspaceId: workspace.id, domain: "canvas" as const, revision: 5, updatedAt: "now", insertedNodeIds: content.nodes.map((node: any) => node.id) };
    } };
    expect(await runTemplateTool("templates_insert", { workspaceId: workspace.id, templateId: "template-a", projectId: "target" }, live)).toMatchObject({ status: "committed", revision: 5, insertedNodeIds: ["node-a"] });
    expect(liveCalls).toBe(1);
    expect(canvasState.projects.find((item: any) => item.id === "target").nodes).toHaveLength(0);
    await expect(runTemplateTool("templates_insert", { workspaceId: workspace.id, templateId: "template-a", projectId: "target" })).rejects.toThrow("编辑器未就绪");
    pathname = "/canvas";
    let resolve!: (value: any) => void;
    canvasCommit = () => new Promise((done) => { resolve = done; });
    let completed = false;
    const pending = runTemplateTool("templates_insert", { workspaceId: workspace.id, templateId: "template-a", projectId: "target" }).then((result) => { completed = true; return result; });
    await new Promise((done) => setTimeout(done, 0));
    expect(completed).toBe(false);
    expect(canvasState.projects.find((item: any) => item.id === "target").nodes).toHaveLength(1);
    resolve({ workspaceId: workspace.id, domain: "canvas", revision: 6, updatedAt: "now" });
    expect(await pending).toMatchObject({ status: "committed", revision: 6, insertedNodeIds: ["node-a"] });
});

test("invalid destination and missing required input reject before copying media", async () => {
    await expect(runTemplateTool("templates_insert", { workspaceId: workspace.id, templateId: "template-a", projectId: "absent" })).rejects.toThrow("画布不存在");
    expect(copied).toBe(0);
    templateState.templates[0].content.nodes[0].metadata.templateInput = { name: "Required", description: "", required: true };
    await expect(runTemplateTool("templates_instantiate", { workspaceId: workspace.id, templateId: "template-a" })).rejects.toThrow("templateInputRequired");
    expect(copied).toBe(0);
});

test("template use validates plugin, model replacement and image input before media copy", async () => {
    templateState.templates[0].content.nodes[0].type = "plugin:missing";
    await expect(runTemplateTool("templates_instantiate", { workspaceId: workspace.id, templateId: "template-a" })).rejects.toThrow("节点插件");
    templateState.templates[0].content.nodes[0].type = "image";
    templateState.templates[0].content.nodes[0].metadata = { templateInput: { name: "Photo", description: "", required: true }, model: "unavailable" };
    await expect(runTemplateTool("templates_instantiate", { workspaceId: workspace.id, templateId: "template-a", inputs: { "node-a": { storageKey: "image:other", naturalWidth: 10, naturalHeight: 10, bytes: 20, mimeType: "image/png", content: "https://untrusted.test/image" } } })).rejects.toThrow("模板模型不可用");
    expect(copied).toBe(0);
    templateState.templates[0].content.nodes[0].metadata.model = undefined;
    await runTemplateTool("templates_instantiate", { workspaceId: workspace.id, templateId: "template-a", inputs: { "node-a": { storageKey: "image:other", naturalWidth: 10, naturalHeight: 10, bytes: 20, mimeType: "image/png", content: "https://untrusted.test/image" } } });
    expect(copied).toBe(1);
});

test("a failed canvas commit reports media copied for this attempt", async () => {
    copiedKey = "image:new-copy";
    canvasCommit = async () => { throw new Error("版本冲突"); };
    await expect(runTemplateTool("templates_instantiate", { workspaceId: workspace.id, templateId: "template-a" })).rejects.toThrow("本次已复制媒体（未确认业务提交，请核对）：image:new-copy");
});
