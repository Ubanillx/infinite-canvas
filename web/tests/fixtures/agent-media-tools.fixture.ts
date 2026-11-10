import { beforeEach, expect, mock, test } from "bun:test";

const workspace = { id: "workspace-a", name: "A", role: "editor", createdAt: "now" };
const source = new Uint8Array([1, 2, 3, 4]);
let template: any;
let commit: any;
let uploadCount: number;
let failCommit: boolean;

const store = { getState: () => ({
    workspaceId: workspace.id,
    templates: [template],
    load: async () => undefined,
    addImportedTemplate: async (item: any) => {
        if (failCommit) throw new Error("CAS conflict");
        commit = item;
        return { workspaceId: workspace.id, domain: "canvas-templates", revision: 2, updatedAt: "now" };
    },
}) };
mock.module("../../src/stores/canvas/use-canvas-template-store", () => ({ useCanvasTemplateStore: store }));
mock.module("../../src/services/image-storage", () => ({ uploadImage: async () => ({ storageKey: `image:new-${++uploadCount}`, mimeType: "image/png", bytes: source.length, width: 1, height: 1 }) }));
mock.module("../../src/services/file-storage", () => ({ uploadMediaFile: async () => ({ storageKey: `file:new-${++uploadCount}`, mimeType: "application/octet-stream", bytes: source.length }) }));

const { runMediaTool } = await import("../../src/lib/agent/agent-media-tools");

beforeEach(() => {
    uploadCount = 0;
    failCommit = false;
    commit = null;
    template = {
        id: "template-old", title: "Portable", description: "Sample", cover: { storageKey: "image:cover" },
        content: {
            backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 }, connections: [],
            nodes: [{ id: "node-1", type: "image", title: "Example", position: { x: 0, y: 0 }, width: 100, height: 100,
                metadata: { storageKey: "image:node", content: "image:node", status: "success", references: ["image:node", "image:cover"], images: [{ id: "result-1", status: "success", content: "image:node", storageKey: "image:node", naturalWidth: 1, naturalHeight: 1, bytes: 4, mimeType: "image/png", errorDetails: undefined }] } },
                { id: "text-1", type: "text", title: "Media as text", position: { x: 120, y: 0 }, width: 100, height: 100,
                    metadata: { content: "image:node", status: "success", texts: [{ id: "text-result-1", status: "success", content: "image:cover" }, { id: "text-result-2", status: "success", content: "literal text" }] } }],
        },
    };
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
        localStorage: { getItem: (key: string) => key === "infinite-canvas:active-workspace" ? JSON.stringify(workspace) : null },
        sessionStorage: { getItem: () => null, setItem: () => undefined },
    } });
    globalThis.fetch = async (url, options) => {
        expect(new Headers(options?.headers).get("x-infinite-canvas-workspace")).toBe(workspace.id);
        const key = decodeURIComponent(String(url).split("/").at(-1)!);
        if (key !== "image:cover" && key !== "image:node") return new Response(null, { status: 404 });
        return new Response(source, { headers: { "content-type": "image/png" } });
    };
});

test("portable package contains bytes but no original keys, then imports independent references", async () => {
    const exported = await runMediaTool("templates_export", { workspaceId: workspace.id, templateId: template.id }) as any;
    expect(exported.package.media).toHaveLength(2);
    expect(JSON.stringify(exported.package)).not.toContain("image:node");
    expect(JSON.stringify(exported.package)).not.toContain("image:cover");
    expect(JSON.stringify(exported.package)).not.toContain("errorDetails");
    const imported = await runMediaTool("templates_import", { workspaceId: workspace.id, package: exported.package }) as any;
    expect(imported).toMatchObject({ status: "committed", revision: 2 });
    expect(commit.id).not.toBe(template.id);
    expect(commit.cover.storageKey).toBe("image:new-1");
    expect(commit.content.nodes[0].metadata).toMatchObject({ storageKey: "image:new-2", content: "image:new-2", references: ["image:new-2", "image:new-1"] });
    expect(commit.content.nodes[0].metadata.images[0].storageKey).toBe("image:new-2");
    expect(commit.content.nodes[0].metadata.images[0].id).not.toBe("result-1");
    expect(commit.content.nodes[1].metadata.content).toBe("image:new-2");
    expect(commit.content.nodes[1].metadata.texts.map((item: any) => item.content)).toEqual(["image:new-1", "literal text"]);
    expect(uploadCount).toBe(2);
});

test("invalid package references and unknown metadata never upload or commit", async () => {
    const exported = await runMediaTool("templates_export", { workspaceId: workspace.id, templateId: template.id }) as any;
    const missing = structuredClone(exported.package);
    missing.media.pop();
    await expect(runMediaTool("templates_import", { workspaceId: workspace.id, package: missing })).rejects.toThrow("清单与引用不匹配");
    const credentials = structuredClone(exported.package);
    credentials.template.content.nodes[0].metadata.apiKey = "secret";
    await expect(runMediaTool("templates_import", { workspaceId: workspace.id, package: credentials })).rejects.toThrow("格式不受支持");
    const task = structuredClone(exported.package);
    task.template.content.nodes[0].metadata.videoTaskId = "charged-job";
    await expect(runMediaTool("templates_import", { workspaceId: workspace.id, package: task })).rejects.toThrow("格式不受支持");
    const duplicate = structuredClone(exported.package);
    duplicate.template.content.nodes.push(structuredClone(duplicate.template.content.nodes[0]));
    await expect(runMediaTool("templates_import", { workspaceId: workspace.id, package: duplicate })).rejects.toThrow("节点类型或标识无效");
    const link = structuredClone(exported.package);
    link.template.content.connections.push({ id: "edge", fromNodeId: "node-1", toNodeId: "missing" });
    await expect(runMediaTool("templates_import", { workspaceId: workspace.id, package: link })).rejects.toThrow("模板连线无效");
    const remote = structuredClone(exported.package);
    remote.template.content.nodes[0].metadata.references = ["https://example.com/private.png"];
    await expect(runMediaTool("templates_import", { workspaceId: workspace.id, package: remote })).rejects.toThrow("当前工作区引用");
    const foreign = structuredClone(exported.package);
    foreign.template.content.nodes[1].metadata.texts[0].content = "image:foreign";
    await expect(runMediaTool("templates_import", { workspaceId: workspace.id, package: foreign })).rejects.toThrow("混入了其他工作区媒体引用");
    const cover = structuredClone(exported.package);
    cover.media[0].kind = "file";
    await expect(runMediaTool("templates_import", { workspaceId: workspace.id, package: cover })).rejects.toThrow("封面必须是图片");
    const wrongKind = structuredClone(exported.package);
    wrongKind.media[1].kind = "video";
    wrongKind.media[1].mimeType = "video/mp4";
    wrongKind.media[1].dataUrl = "data:video/mp4;base64,AQIDBA==";
    await expect(runMediaTool("templates_import", { workspaceId: workspace.id, package: wrongKind })).rejects.toThrow("节点媒体类型与节点不匹配");
    const invalidInput = structuredClone(exported.package);
    invalidInput.template.content.nodes[0].type = "config";
    invalidInput.template.content.nodes[0].metadata.templateInput = { name: "Input", description: "", required: true };
    await expect(runMediaTool("templates_import", { workspaceId: workspace.id, package: invalidInput })).rejects.toThrow("只有文本和图片节点");
    expect(uploadCount).toBe(0);
    expect(commit).toBeNull();
});

test("failed template commit reports media uploads without claiming success", async () => {
    const exported = await runMediaTool("templates_export", { workspaceId: workspace.id, templateId: template.id }) as any;
    failCommit = true;
    await expect(runMediaTool("templates_import", { workspaceId: workspace.id, package: exported.package })).rejects.toThrow("已上传但尚未引用的媒体：image:new-1, image:new-2");
    expect(commit).toBeNull();
});

test("media_get is scoped and import returns stored rather than committed", async () => {
    expect(await runMediaTool("media_get", { workspaceId: workspace.id, storageKey: "image:node" })).toMatchObject({ storageKey: "image:node", mimeType: "image/png", bytes: 4 });
    const result = await runMediaTool("media_import", { workspaceId: workspace.id, kind: "image", dataUrl: "data:image/png;base64,AQIDBA==" });
    expect(result).toMatchObject({ status: "stored", storageKey: "image:new-1", bytes: 4 });
    await expect(runMediaTool("media_get", { workspaceId: "workspace-b", storageKey: "image:node" })).rejects.toThrow("不一致");
});
