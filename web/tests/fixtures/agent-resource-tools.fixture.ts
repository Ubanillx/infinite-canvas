import { afterEach, beforeEach, expect, mock, test } from "bun:test";

const workspace = { id: "workspace-a", name: "A", role: "editor", createdAt: "2026-01-01T00:00:00Z" };
let activeWorkspace = workspace;
let canvasState: any;
let assetState: any;
let canvasCommit: () => Promise<any>;
let assetCommit: () => Promise<any>;
let imageUpload: () => Promise<any>;
let canvasPersistName: string;
let assetPersistName: string;
let originalWindow: PropertyDescriptor | undefined;

const useCanvasStore = Object.assign(() => canvasState, {
    getState: () => canvasState,
    setState: (updater: any) => { canvasState = { ...canvasState, ...(typeof updater === "function" ? updater(canvasState) : updater) }; },
    persist: { getOptions: () => ({ name: canvasPersistName }) },
});
const useAssetStore = Object.assign(() => assetState, { getState: () => assetState, persist: { getOptions: () => ({ name: assetPersistName }) } });

mock.module("../../src/stores/canvas/use-canvas-store", () => ({ useCanvasStore, flushCanvasSave: () => canvasCommit() }));
mock.module("../../src/stores/use-asset-store", () => ({ useAssetStore }));
mock.module("../../src/services/workspace-data", () => ({ waitForWorkspaceDataSave: () => assetCommit() }));
mock.module("../../src/services/image-storage", () => ({ uploadImage: () => imageUpload() }));
mock.module("../../src/services/api/agent-media", () => ({ readAgentMedia: async () => new Blob(["image"], { type: "image/png" }) }));

const { runResourceTool } = await import("../../src/lib/agent/agent-resource-tools");

beforeEach(() => {
    originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    activeWorkspace = workspace;
    canvasPersistName = `workspace:${workspace.id}:infinite-canvas:canvas_store`;
    assetPersistName = `workspace:${workspace.id}:infinite-canvas:asset_store`;
    Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: { location: { pathname: "/canvas" }, localStorage: { getItem: (key: string) => key === "infinite-canvas:active-workspace" ? JSON.stringify(activeWorkspace) : null } },
    });
    canvasState = {
        hydrated: true, projects: [], folders: [], deletedProjects: [],
        createProject: (title: string, folderId: string | null, description: string) => {
            canvasState.projects = [{ id: "project-1", title, folderId, description, nodes: [], connections: [], createdAt: "now", updatedAt: "now" }, ...canvasState.projects];
            return "project-1";
        },
        deleteProjects: (ids: string[]) => { canvasState.projects = canvasState.projects.filter((item: any) => !ids.includes(item.id)); },
        deleteFolders: (ids: string[]) => { canvasState.folders = canvasState.folders.filter((item: any) => !ids.includes(item.id)); },
    };
    assetState = {
        hydrated: true, assets: [],
        addAsset: (item: any) => { assetState.assets.push({ id: "asset-1", ...item }); return "asset-1"; },
        updateAsset: (id: string, patch: any) => { assetState.assets = assetState.assets.map((item: any) => item.id === id ? { ...item, ...patch, updatedAt: "changed" } : item); },
        removeAsset: (id: string) => { assetState.assets = assetState.assets.filter((item: any) => item.id !== id); },
    };
    canvasCommit = async () => ({ workspaceId: workspace.id, domain: "canvas", revision: 4, updatedAt: "now" });
    assetCommit = async () => ({ workspaceId: workspace.id, domain: "assets", revision: 8, updatedAt: "now" });
    imageUpload = async () => ({ url: "blob:image", storageKey: "image:1", width: 1, height: 1, bytes: 1, mimeType: "image/png" });
});

afterEach(() => {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
});

test("creation reports committed only after the canvas write completes", async () => {
    let resolve!: (value: any) => void;
    canvasCommit = () => new Promise((done) => { resolve = done; });
    let returned = false;
    const pending = runResourceTool("canvas_create_project", { workspaceId: workspace.id, title: "New" }).then((result) => { returned = true; return result; });
    await Promise.resolve();
    expect(returned).toBe(false);
    expect(canvasState.projects[0].title).toBe("New");
    resolve({ workspaceId: workspace.id, domain: "canvas", revision: 4, updatedAt: "now" });
    expect(await pending).toMatchObject({ status: "committed", id: "project-1", revision: 4 });
});

test("viewer and mismatched workspace cannot mutate stores", async () => {
    activeWorkspace = { ...workspace, role: "viewer" };
    await expect(runResourceTool("canvas_create_project", { workspaceId: workspace.id, title: "No" })).rejects.toThrow("只读");
    activeWorkspace = workspace;
    await expect(runResourceTool("assets_delete", { workspaceId: "workspace-b", assetId: "asset-1" })).rejects.toThrow("不一致");
    expect(canvasState.projects).toHaveLength(0);
});

test("switching workspace before store rehydration rejects both resource writes", async () => {
    activeWorkspace = { ...workspace, id: "workspace-b" };
    await expect(runResourceTool("canvas_create_project", { workspaceId: "workspace-b", title: "No" })).rejects.toThrow("画布数据仍属于");
    await expect(runResourceTool("assets_create", { workspaceId: "workspace-b", kind: "text", title: "No", content: "Text" })).rejects.toThrow("素材数据仍属于");
    expect(canvasState.projects).toHaveLength(0);
    expect(assetState.assets).toHaveLength(0);
});

test("folder deletion reports cascade and refuses to delete an open project", async () => {
    canvasState.folders = [{ id: "parent", parentId: null }, { id: "child", parentId: "parent" }];
    canvasState.projects = [{ id: "project-1", folderId: "child", nodes: [], connections: [] }];
    (globalThis.window as any).location.pathname = "/canvas/project-1";
    await expect(runResourceTool("canvas_delete_folder", { workspaceId: workspace.id, folderId: "parent" })).rejects.toThrow("当前打开的画布");
    expect(canvasState.projects).toHaveLength(1);
    (globalThis.window as any).location.pathname = "/canvas";
    expect(await runResourceTool("canvas_delete_folder", { workspaceId: workspace.id, folderId: "parent" })).toMatchObject({
        status: "committed", deletedFolderIds: ["parent", "child"], deletedProjectIds: ["project-1"], revision: 4,
    });
});

test("asset write failure never claims a committed result", async () => {
    assetCommit = async () => { throw new Error("save failed"); };
    await expect(runResourceTool("assets_create", { workspaceId: workspace.id, kind: "text", title: "Note", content: "Text" })).rejects.toThrow("save failed");
    expect(assetState.assets).toHaveLength(1);
});

test("image update rejects a concurrent deletion or edit during upload", async () => {
    for (const change of ["delete", "edit"]) {
        const original = { id: "asset-1", kind: "image", title: "Original", tags: [], updatedAt: "before", data: { dataUrl: "blob:old" } };
        assetState.assets = [original];
        let finishUpload!: (image: any) => void;
        imageUpload = () => new Promise((resolve) => { finishUpload = resolve; });
        const pending = runResourceTool("assets_update", { workspaceId: workspace.id, assetId: "asset-1", imageUrl: "data:image/png;base64,AA==" });
        await Promise.resolve();
        assetState.assets = change === "delete" ? [] : [{ ...original, title: "Someone else's edit", updatedAt: "after" }];
        finishUpload({ url: "blob:new", storageKey: "image:new", width: 1, height: 1, bytes: 1, mimeType: "image/png" });
        await expect(pending).rejects.toThrow("素材已被修改或删除");
        if (change === "edit") expect(assetState.assets[0].title).toBe("Someone else's edit");
    }
});
