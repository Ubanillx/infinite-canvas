import { expect, test } from "bun:test";

import { cloneCanvasTemplateContent, templateSelection, defineTemplateInputs, prepareTemplateContent, positionTemplateContent } from "../src/lib/canvas/canvas-template";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
import type { CanvasTemplateContent } from "../src/types/canvas-template";

const node = (id: string, type: CanvasNodeData["type"], metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData => ({ id, type, title: id, position: { x: 10, y: 20 }, width: 200, height: 160, metadata });
const content = (nodes: CanvasNodeData[]): CanvasTemplateContent => ({ nodes, connections: [], backgroundMode: "lines", showImageInfo: true, viewport: { x: 12, y: 34, k: 0.8 } });

test("selection expands nested groups and upstream dependencies, but excludes outgoing links", () => {
    const source = content([node("group", CanvasNodeType.Group), node("nested", CanvasNodeType.Group, { groupId: "group" }), node("result", CanvasNodeType.Image, { groupId: "nested" }), node("config", CanvasNodeType.Config), node("input", CanvasNodeType.Text), node("outside", CanvasNodeType.Image)]);
    source.connections = [{ id: "a", fromNodeId: "input", toNodeId: "config" }, { id: "b", fromNodeId: "config", toNodeId: "result" }, { id: "c", fromNodeId: "result", toNodeId: "outside" }];
    const before = structuredClone(source);
    const selected = templateSelection(source, ["group"], true);
    expect(selected.content.nodes.map((item) => item.id)).toEqual(["group", "nested", "result", "config", "input"]);
    expect(selected.content.connections.map((edge) => edge.id)).toEqual(["a", "b"]);
    expect(() => templateSelection(source, ["group"], false)).toThrow("templateDependenciesRequired");
    expect(source).toEqual(before);
});

test("composer node mentions follow independent node identities on each use", () => {
    const source = content([node("input", CanvasNodeType.Text), node("config", CanvasNodeType.Config, { prompt: "Use @[node:input]", composerContent: "@[node:input]" })]);
    const selected = templateSelection(source, ["config"], true).content;
    expect(selected.nodes).toHaveLength(2);
    const first = cloneCanvasTemplateContent(selected);
    const second = cloneCanvasTemplateContent(first);
    expect(first.nodes[1].metadata?.prompt).toBe(`Use @[node:${first.nodes[0].id}]`);
    expect(second.nodes[1].metadata?.composerContent).toBe(`@[node:${second.nodes[0].id}]`);
});

test("external text and images become required empty inputs without retaining their upstream links", () => {
    const source = content([node("upstream", CanvasNodeType.Config), node("image", CanvasNodeType.Image, { storageKey: "image:old", content: "image:old" }), node("target", CanvasNodeType.Config, { references: ["image:old"] })]);
    source.connections = [{ id: "a", fromNodeId: "upstream", toNodeId: "image" }, { id: "b", fromNodeId: "image", toNodeId: "target" }];
    const selected = templateSelection(source, ["target"], false);
    expect(selected.content.nodes.map((item) => item.id)).toEqual(["image", "target"]);
    expect(selected.content.connections).toHaveLength(1);
    const defined = defineTemplateInputs(selected.content, {}, source);
    expect(defined.nodes[0].metadata?.storageKey).toBeUndefined();
    expect(defined.nodes[1].metadata?.references).toEqual(["template-input:image"]);
});

test("input references survive cloning and resolve to the supplied independent image", () => {
    const source = content([node("image", CanvasNodeType.Image, { content: "image:example", storageKey: "image:example" }), node("config", CanvasNodeType.Config, { references: ["image:example"], model: "missing" })]);
    const defined = defineTemplateInputs(source, { image: { name: "Product", description: "Upload photo", required: true } });
    const template = cloneCanvasTemplateContent(defined);
    const id = template.nodes[0].id;
    expect(template.nodes[1].metadata?.references).toEqual([`template-input:${id}`]);
    expect(() => prepareTemplateContent(template, true, {}, {})).toThrow("templateInputRequired:Product");
    const filled = prepareTemplateContent(template, true, { [id]: { storageKey: "image:new", content: "image:new", naturalWidth: 20, naturalHeight: 10, bytes: 4, mimeType: "image/png" } }, { [template.nodes[1].id]: "replacement" });
    expect(filled.nodes[1].metadata?.references).toEqual(["image:new"]);
    expect(filled.nodes[1].metadata?.model).toBe("replacement");
    expect(filled.nodes[0].title).toBe("Product");
    expect(template.nodes[0].metadata?.content).toBeUndefined();
    expect(source.nodes[0].metadata?.content).toBe("image:example");
});

test("explicit media references detect external nodes even without a visible connection", () => {
    const source = content([node("image", CanvasNodeType.Image, { storageKey: "image:reference" }), node("config", CanvasNodeType.Config, { references: ["image:reference", "image:standalone"] })]);
    const included = templateSelection(source, ["config"], true);
    expect(included.externalCount).toBe(1);
    expect(included.content.nodes.map((item) => item.id)).toEqual(["image", "config"]);
    const pending = templateSelection(source, ["config"], false);
    const defined = defineTemplateInputs(pending.content, {}, source);
    expect(defined.nodes[0].metadata?.templateInput?.required).toBe(true);
    expect(defined.nodes[1].metadata?.references).toEqual(["template-input:image", "image:standalone"]);
    expect(defined.connections).toEqual([]);
});

test("clearing generated examples preserves linked inputs, explicit references and uploaded material", () => {
    const source = content([node("input", CanvasNodeType.Text, { content: "Required input", prompt: "prior generation" }), node("output", CanvasNodeType.Image, { content: "image:result", storageKey: "image:result", prompt: "Generate" }), node("reference", CanvasNodeType.Image, { storageKey: "image:ref", content: "image:ref", prompt: "Prior image" }), node("config", CanvasNodeType.Config, { references: ["image:ref"] }), node("upload", CanvasNodeType.Image, { content: "image:upload", storageKey: "image:upload" })]);
    source.connections = [{ id: "link", fromNodeId: "input", toNodeId: "output" }];
    const prepared = prepareTemplateContent(source, false, {}, {});
    expect(prepared.nodes[0].metadata?.content).toBe("Required input");
    expect(prepared.nodes[1].metadata?.content).toBeUndefined();
    expect(prepared.nodes[1].metadata?.prompt).toBe("Generate");
    expect(prepared.nodes[2].metadata?.storageKey).toBe("image:ref");
    expect(prepared.nodes[4].metadata?.storageKey).toBe("image:upload");
});

test("optional empty inputs remove only their placeholder references", () => {
    const source = content([node("input", CanvasNodeType.Image, { templateInput: { name: "Optional", description: "", required: false } }), node("config", CanvasNodeType.Config, { references: ["template-input:input", "image:retain"] })]);
    expect(prepareTemplateContent(source, true, {}, {}).nodes[1].metadata?.references).toEqual(["image:retain"]);
});

test("positioning inserts at the requested world center without changing relative layout or source viewport", () => {
    const source = content([node("a", CanvasNodeType.Text), { ...node("b", CanvasNodeType.Text), position: { x: 310, y: 20 } }]);
    const before = structuredClone(source);
    const inserted = positionTemplateContent(source, { x: 1000, y: 500 });
    expect(inserted.nodes[1].position.x - inserted.nodes[0].position.x).toBe(300);
    expect(inserted.nodes[0].position).toEqual({ x: 750, y: 420 });
    expect(inserted.viewport).toEqual(before.viewport);
    expect(source).toEqual(before);
});

test("templates clone graph identities, groups, and viewport without changing the source", () => {
    const source = content([node("group", CanvasNodeType.Group), node("input", CanvasNodeType.Image, { groupId: "group", content: "blob:input", storageKey: "image:input" }), node("config", CanvasNodeType.Config, { prompt: "Keep this prompt", model: "model", references: ["image:input"] })]);
    source.connections = [{ id: "connection", fromNodeId: "input", toNodeId: "config" }];
    const before = structuredClone(source);
    const copy = cloneCanvasTemplateContent(source);
    expect(source).toEqual(before);
    expect(copy.nodes.every((item, index) => item.id !== source.nodes[index].id)).toBe(true);
    expect(copy.nodes[1].metadata?.groupId).toBe(copy.nodes[0].id);
    expect(copy.connections[0]).toMatchObject({ fromNodeId: copy.nodes[1].id, toNodeId: copy.nodes[2].id });
    expect(copy.connections[0].id).not.toBe("connection");
    copy.viewport.x = 999;
    copy.nodes[0].position.x = 999;
    copy.nodes[2].metadata!.references!.push("image:other");
    expect(source).toEqual(before);
});

test("template content excludes project sessions and credentials and resets running video jobs", () => {
    const source = { ...content([node("video", CanvasNodeType.Video, { prompt: "A video", status: "loading", errorDetails: "old failure", videoTaskId: "running-job", videoTaskProvider: "custom", interactive: true })]), chatSessions: [{ messages: ["private chat"] }], activeChatId: "chat", apiKey: "not-template-content" };
    const copy = cloneCanvasTemplateContent(source);
    expect(Object.keys(copy).sort()).toEqual(["backgroundMode", "connections", "nodes", "showImageInfo", "viewport"]);
    expect(copy.nodes[0].metadata).toEqual({ prompt: "A video", status: "idle" });
    expect(source.nodes[0].metadata?.videoTaskId).toBe("running-job");
});

test("batch results retain completed media and text with independent primary identities", () => {
    const source = content([node("image", CanvasNodeType.Image, {
        content: "blob:complete", status: "loading", primaryImageId: "complete", primaryTextId: "text",
        images: [
            { id: "complete", content: "blob:complete", storageKey: "image:complete", status: "success", naturalWidth: 100, naturalHeight: 200, bytes: 10, mimeType: "image/png" },
            { id: "pending", content: "", status: "loading", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "" },
        ],
        texts: [{ id: "text", content: "Keep this result", status: "error", errorDetails: "old error" }, { id: "pending", content: "", status: "loading" }],
    })]);
    const copy = cloneCanvasTemplateContent(source);
    const metadata = copy.nodes[0].metadata!;
    expect(metadata.status).toBe("success");
    expect(metadata.images).toHaveLength(1);
    expect(metadata.images![0].id).not.toBe("complete");
    expect(metadata.primaryImageId).toBe(metadata.images![0].id);
    expect(metadata.images![0].storageKey).toBe("image:complete");
    expect(metadata.primaryTextId).toBe(metadata.texts![0].id);
    expect(metadata.texts![0].status).toBe("success");
    expect(metadata.texts![0].errorDetails).toBeUndefined();
    expect(source.nodes[0].metadata?.images).toHaveLength(2);
});

test("cloning a template repeatedly creates independent graphs and removes dangling links", () => {
    const source = content([node("text", CanvasNodeType.Text, { content: "Hello", groupId: "missing-group" })]);
    source.connections = [{ id: "dangling", fromNodeId: "missing", toNodeId: "text" }];
    const template = cloneCanvasTemplateContent(source);
    const first = cloneCanvasTemplateContent(template);
    const second = cloneCanvasTemplateContent(template);
    expect(new Set([source.nodes[0].id, template.nodes[0].id, first.nodes[0].id, second.nodes[0].id]).size).toBe(4);
    expect(first.connections).toEqual([]);
    expect(first.nodes[0].metadata?.groupId).toBeUndefined();
    first.nodes[0].metadata!.content = "Changed";
    expect(template.nodes[0].metadata?.content).toBe("Hello");
    expect(second.nodes[0].metadata?.content).toBe("Hello");
});

test("empty canvases remain valid template content", () => {
    expect(cloneCanvasTemplateContent(content([]))).toEqual(content([]));
});
