import { expect, mock, test } from "bun:test";

Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null } });
const workspaceId = "workspace-a";
let persisted = { version: 1, templates: [{ id: "template", title: "Original", description: "Original description", cover: { storageKey: "image:cover" }, content: { nodes: [], connections: [], backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } }, createdAt: "now", updatedAt: "now" }] };
const commits: Array<{ title: string; description: string }> = [];

mock.module("../../src/lib/workspace", () => ({ getActiveWorkspace: () => ({ id: workspaceId }) }));
mock.module("../../src/lib/canvas/canvas-template-thumbnail", () => ({ createCanvasTemplateThumbnail: async () => new Blob() }));
mock.module("../../src/services/canvas-templates", () => ({ requireTemplateWorkspace: () => {}, copyCanvasTemplateContent: async (value: unknown) => value, templateMediaError: (error: unknown) => error }));
mock.module("../../src/services/workspace-media", () => ({ saveMediaBlob: async () => {} }));
mock.module("../../src/services/workspace-data", () => ({
    loadWorkspaceData: async () => structuredClone(persisted),
    saveWorkspaceData: async (_domain: string, value: typeof persisted) => {
        persisted = structuredClone(value);
        commits.push({ title: value.templates[0].title, description: value.templates[0].description });
        return { workspaceId, domain: "canvas-templates", revision: commits.length, updatedAt: "now" };
    },
}));

const { useCanvasTemplateStore } = await import("../../src/stores/canvas/use-canvas-template-store");

test("queued partial metadata updates preserve the other writer's field", async () => {
    await useCanvasTemplateStore.getState().load();
    const first = useCanvasTemplateStore.getState().update("template", "Renamed");
    const second = useCanvasTemplateStore.getState().update("template", undefined, "Later description");
    await Promise.all([first, second]);
    expect(commits).toEqual([
        { title: "Renamed", description: "Original description" },
        { title: "Renamed", description: "Later description" },
    ]);
    expect(persisted.templates[0]).toMatchObject({ title: "Renamed", description: "Later description" });
});
