import i18n from "@/i18n";
import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { getCanvasNodeIndex } from "@/lib/canvas/canvas-graph-index";
import { createCanvasNode } from "@/lib/canvas/canvas-node-factory";
import { nodeBounds } from "@/lib/canvas/canvas-node-geometry";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import { nanoid } from "nanoid";

export type CanvasReversePromptOptions = {
    nodeIds: string[];
    model: string;
    requirement: string;
    generate: boolean;
};

export function createReversePromptWorkflow(nodes: CanvasNodeData[], options: CanvasReversePromptOptions) {
    const byId = getCanvasNodeIndex(nodes).byId;
    const images = [...new Set(options.nodeIds)].map((id) => byId.get(id));
    if (!images.length || images.some((node) => node?.type !== CanvasNodeType.Image || !node.metadata?.content)) return null;

    const sources = images as CanvasNodeData[];
    const bounds = nodeBounds(sources);
    const gap = 96;
    const centerY = (bounds.top + bounds.bottom) / 2;
    const textSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
    const configSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Config];
    const preset = i18n.t(sources.length > 1 ? "canvas.reversePrompt.multiPreset" : "canvas.projectPage.reversePreset");
    const requirement = options.requirement.trim();
    const instruction = requirement ? `${preset}\n\n${i18n.t("canvas.reversePrompt.requirementLabel")}\n${requirement}` : preset;
    const textNode = {
        ...createCanvasNode(CanvasNodeType.Text, { x: bounds.right + gap + textSpec.width / 2, y: centerY }, { content: instruction, prompt: instruction, status: "success", fontSize: 14 }),
        title: i18n.t("canvas.projectPage.reverseTitle"),
    };
    const composerContent = sources.length > 1
        ? i18n.t("canvas.reversePrompt.multiComposer", { main: `@[node:${sources[0].id}]`, others: sources.slice(1).map((node) => `@[node:${node.id}]`).join(" "), task: `@[node:${textNode.id}]` })
        : i18n.t("canvas.reverseComposer", { imageId: sources[0].id, textId: textNode.id });
    const configNode = {
        ...createCanvasNode(CanvasNodeType.Config, { x: textNode.position.x + textNode.width + gap + configSpec.width / 2, y: centerY }, { generationMode: "text", model: options.model, textCount: 1, composerContent }),
        title: i18n.t("canvas.projectPage.reverseConfigTitle"),
    };
    const connections: CanvasConnection[] = [...sources, textNode].map((node) => ({ id: nanoid(), fromNodeId: node.id, toNodeId: configNode.id }));
    return { nodes: [textNode, configNode], connections, configNode };
}
