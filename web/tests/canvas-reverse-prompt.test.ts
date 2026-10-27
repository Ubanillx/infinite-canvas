import { afterAll, beforeEach, expect, test } from "bun:test";

import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {} } });
const { default: i18n } = await import("../src/i18n");
const { createReversePromptWorkflow } = await import("../src/lib/canvas/canvas-reverse-prompt");
const { buildNodeGenerationContext, buildNodeResponseMessages } = await import("../src/components/canvas/canvas-node-generation");
const originalLanguage = i18n.language;
beforeEach(async () => { await i18n.changeLanguage("zh-CN"); });
afterAll(async () => {
    await i18n.changeLanguage(originalLanguage);
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

const image = (id: string, x = 0, y = 0): CanvasNodeData => ({
    id, title: id, type: CanvasNodeType.Image, position: { x, y }, width: 240, height: 180,
    metadata: { content: `data:image/png;base64,${id}`, storageKey: `image:${id}`, mimeType: "image/png", status: "success" },
});
const options = { nodeIds: ["front", "side", "back"], model: "vision-model", requirement: "保留磨砂质感，浅色背景", generate: false };

test("multiple views form one reusable text workflow with ordered, deduplicated references", () => {
    const sources = [image("front"), image("side", 400), image("back", 800)];
    const workflow = createReversePromptWorkflow(sources, { ...options, nodeIds: ["side", "front", "side", "back"] })!;
    const config = workflow.configNode;
    expect(workflow.nodes).toHaveLength(2);
    expect(config.metadata).toMatchObject({ generationMode: "text", textCount: 1, model: "vision-model", status: "idle" });
    expect(workflow.connections.map((edge) => edge.fromNodeId)).toEqual(["side", "front", "back", workflow.nodes[0].id]);
    expect(workflow.connections.every((edge) => edge.toNodeId === config.id)).toBe(true);
    expect(config.metadata?.composerContent).toStartWith("主视角：@[node:side]");

    const context = buildNodeGenerationContext(config.id, [...sources, ...workflow.nodes], workflow.connections, config.metadata!.composerContent!);
    expect(context.referenceImages.map((reference) => reference.id)).toEqual(["side", "front", "back"]);
    expect(context.referenceImages.map((reference) => reference.storageKey)).toEqual(["image:side", "image:front", "image:back"]);
    expect(context.imageCount).toBe(3);
    expect(context.textCount).toBe(1);
    expect(context.prompt).toContain(options.requirement);
    expect(context.prompt).toContain("单张、单一视角");
    expect(context.prompt).not.toContain("@[node:");
    const messages = buildNodeResponseMessages(context);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toEqual([
        { type: "text", text: context.prompt },
        ...context.referenceImages.map((reference) => ({ type: "image_url", image_url: { url: reference.dataUrl } })),
    ]);
});

test("single image retains the original preset and composer", () => {
    const workflow = createReversePromptWorkflow([image("front")], { ...options, nodeIds: ["front", "front"], requirement: "   " })!;
    expect(workflow.nodes[0].metadata?.content).toBe(i18n.t("canvas.projectPage.reversePreset"));
    expect(workflow.configNode.metadata?.composerContent).toBe(i18n.t("canvas.reverseComposer", { imageId: "front", textId: workflow.nodes[0].id }));
    expect(workflow.connections).toHaveLength(2);
});

test("changing the main view changes the first image sent to the model", () => {
    const sources = [image("front"), image("side")];
    const workflow = createReversePromptWorkflow(sources, { ...options, nodeIds: ["side", "front"] })!;
    const context = buildNodeGenerationContext(workflow.configNode.id, [...sources, ...workflow.nodes], workflow.connections, workflow.configNode.metadata!.composerContent!);
    expect(context.referenceImages[0].id).toBe("side");
    expect(context.prompt.split("\n")[0]).toContain("主视角");
});

test("empty, missing and non-image references reject the entire workflow", () => {
    const nodes = [image("front"), { ...image("empty"), metadata: {} }, { ...image("text"), type: CanvasNodeType.Text }];
    for (const nodeIds of [[], ["missing"], ["front", "missing"], ["front", "empty"], ["front", "text"]]) {
        expect(createReversePromptWorkflow(nodes, { ...options, nodeIds })).toBeNull();
    }
});

test("workflow sits beyond all reference bounds without changing any source", () => {
    const nodes = [image("front", 0, -100), image("side", 800, 400)];
    const before = structuredClone(nodes);
    const workflow = createReversePromptWorkflow(nodes, { ...options, nodeIds: ["side", "front"] })!;
    expect(workflow.nodes[0].position.x).toBe(800 + 240 + 96);
    expect(workflow.configNode.position.x).toBe(workflow.nodes[0].position.x + workflow.nodes[0].width + 96);
    expect(workflow.nodes[0].position.y + workflow.nodes[0].height / 2).toBe((-100 + 400 + 180) / 2);
    expect(nodes).toEqual(before);
});

test("the multi-view task and reference roles follow the current language", async () => {
    await i18n.changeLanguage("en-US");
    const workflow = createReversePromptWorkflow([image("front"), image("side")], { ...options, nodeIds: ["front", "side"], requirement: "Keep the frosted finish" })!;
    expect(workflow.configNode.metadata?.composerContent).toStartWith("Main view: @[node:front]");
    expect(workflow.nodes[0].metadata?.content).toContain("single viewpoint");
    expect(workflow.nodes[0].metadata?.content).toContain("Additional instructions:\nKeep the frosted finish");
});
