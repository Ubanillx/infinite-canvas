import { nanoid } from "nanoid";

import { CanvasNodeType } from "@/types/canvas";
import { nodeBounds } from "@/lib/canvas/canvas-node-geometry";
import type { CanvasTemplateContent } from "@/types/canvas-template";

// Copy graph identities together; history, credentials and running jobs are not template content.
export function cloneCanvasTemplateContent(source: CanvasTemplateContent): CanvasTemplateContent {
    const content = structuredClone({ nodes: source.nodes, connections: source.connections, backgroundMode: source.backgroundMode, showImageInfo: source.showImageInfo, viewport: source.viewport });
    const nodeIds = new Map(content.nodes.map((node) => [node.id, nanoid()]));
    content.nodes = content.nodes.map((node) => {
        const metadata = node.metadata;
        if (metadata) {
            delete metadata.errorDetails;
            delete metadata.videoTaskId;
            delete metadata.videoTaskProvider;
            delete metadata.interactive;
            metadata.status = metadata.content ? "success" : "idle";
            if (metadata.groupId) metadata.groupId = nodeIds.get(metadata.groupId);
            for (const field of ["prompt", "composerContent"] as const) if (metadata[field]) metadata[field] = metadata[field].replace(/@\[node:([^\]]+)\]/g, (token, id: string) => nodeIds.has(id) ? `@[node:${nodeIds.get(id)}]` : token);
            if (metadata.references) metadata.references = metadata.references.map((reference) => reference.startsWith("template-input:") ? `template-input:${nodeIds.get(reference.slice(15)) || reference.slice(15)}` : reference);
            if (metadata.images) {
                const primaryId = metadata.primaryImageId;
                metadata.images = metadata.images.filter((image) => image.content || image.storageKey).map((image) => {
                    const id = nanoid();
                    if (image.id === primaryId) metadata.primaryImageId = id;
                    return { ...image, id, status: "success" as const, errorDetails: undefined };
                });
                if (!metadata.images.some((image) => image.id === metadata.primaryImageId)) metadata.primaryImageId = metadata.images[0]?.id;
            }
            if (metadata.texts) {
                const primaryId = metadata.primaryTextId;
                metadata.texts = metadata.texts.filter((text) => text.content).map((text) => {
                    const id = nanoid();
                    if (text.id === primaryId) metadata.primaryTextId = id;
                    return { ...text, id, status: "success" as const, errorDetails: undefined };
                });
                if (!metadata.texts.some((text) => text.id === metadata.primaryTextId)) metadata.primaryTextId = metadata.texts[0]?.id;
            }
        }
        return { ...node, id: nodeIds.get(node.id)! };
    });
    content.connections = content.connections.flatMap((connection) => {
        const fromNodeId = nodeIds.get(connection.fromNodeId);
        const toNodeId = nodeIds.get(connection.toNodeId);
        return fromNodeId && toNodeId ? [{ id: nanoid(), fromNodeId, toNodeId }] : [];
    });
    return content;
}

export function templateSelection(source: CanvasTemplateContent, selection: string[], includeDependencies: boolean) {
    const ids = new Set(selection);
    const expandGroups = () => {
        let changed = true;
        while (changed) {
            changed = false;
            source.nodes.forEach((node) => {
                if (node.metadata?.groupId && ids.has(node.metadata.groupId) && !ids.has(node.id)) { ids.add(node.id); changed = true; }
            });
        }
    };
    expandGroups();
    const selected = new Set(ids);
    const mediaOwners = new Map<string, string>();
    source.nodes.forEach((node) => {
        if (node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Video && node.type !== CanvasNodeType.Audio) return;
        for (const value of [node.metadata?.storageKey, node.metadata?.content, ...(node.metadata?.images || []).flatMap((image) => [image.storageKey, image.content])]) if (value) mediaOwners.set(value, node.id);
    });
    const referenceEdges = source.nodes.flatMap((node) => (node.metadata?.references || []).flatMap((reference) => {
        const owner = mediaOwners.get(reference);
        return owner && owner !== node.id ? [{ id: "", fromNodeId: owner, toNodeId: node.id }] : [];
    }));
    const mentionEdges = source.nodes.flatMap((node) => [...`${node.metadata?.prompt || ""}\n${node.metadata?.composerContent || ""}`.matchAll(/@\[node:([^\]]+)\]/g)].map((match) => ({ id: "", fromNodeId: match[1], toNodeId: node.id })));
    const incoming = () => [...source.connections, ...referenceEdges, ...mentionEdges].filter((edge) => ids.has(edge.toNodeId) && !ids.has(edge.fromNodeId));
    const external = new Set(incoming().map((edge) => edge.fromNodeId));
    if (includeDependencies) {
        while (incoming().length) {
            const before = ids.size;
            incoming().forEach((edge) => { if (source.nodes.some((node) => node.id === edge.fromNodeId)) ids.add(edge.fromNodeId); });
            expandGroups();
            if (before === ids.size) break;
        }
    } else external.forEach((id) => ids.add(id));
    const content = structuredClone(source);
    content.nodes = content.nodes.filter((node) => ids.has(node.id));
    content.nodes.forEach((node) => {
        if (node.metadata?.groupId && !ids.has(node.metadata.groupId)) delete node.metadata.groupId;
        if (!includeDependencies && external.has(node.id)) {
            if (node.type !== CanvasNodeType.Text && node.type !== CanvasNodeType.Image) throw new Error("templateDependenciesRequired");
            node.metadata = { templateInput: { name: node.title, description: "", required: true }, status: "idle" };
        }
    });
    content.connections = content.connections.filter((edge) => ids.has(edge.fromNodeId) && ids.has(edge.toNodeId) && (includeDependencies || selected.has(edge.toNodeId)));
    return { content, externalCount: external.size, referenceCount: content.nodes.reduce((count, node) => count + (node.metadata?.references?.length || 0), 0) };
}

export function clearTemplateExample(node: CanvasTemplateContent["nodes"][number]) {
    const metadata = node.metadata;
    if (!metadata) return;
    for (const key of ["content", "storageKey", "images", "primaryImageId", "texts", "primaryTextId", "naturalWidth", "naturalHeight", "bytes", "mimeType", "durationMs"] as const) delete metadata[key];
    metadata.status = "idle";
}

export function defineTemplateInputs(source: CanvasTemplateContent, slots: Record<string, NonNullable<CanvasTemplateContent["nodes"][number]["metadata"]>["templateInput"] | null>, referenceSource = source) {
    const content = structuredClone(source);
    const references = new Map<string, string>();
    content.nodes.forEach((node) => {
        const slot = node.id in slots ? slots[node.id] : node.metadata?.templateInput;
        if (!slot) { if (node.metadata) delete node.metadata.templateInput; return; }
        const original = referenceSource.nodes.find((item) => item.id === node.id)?.metadata;
        if (node.type === CanvasNodeType.Image) {
            for (const value of [original?.storageKey, original?.content, ...(original?.images || []).flatMap((image) => [image.storageKey, image.content])]) if (value) references.set(value, `template-input:${node.id}`);
        }
        node.metadata = { ...node.metadata, templateInput: { ...slot, name: slot.name.trim() } };
        clearTemplateExample(node);
    });
    content.nodes.forEach((node) => { if (node.metadata?.references) node.metadata.references = node.metadata.references.map((value) => references.get(value) || value); });
    return content;
}

// Keep connected inputs and explicit reference assets; only terminal generated samples are optional.
export function prepareTemplateContent(source: CanvasTemplateContent, keepExamples: boolean, inputs: Record<string, string | { storageKey: string; content: string; naturalWidth: number; naturalHeight: number; bytes: number; mimeType: string }>, replacements: Record<string, string>) {
    const content = structuredClone(source);
    const inputIds = new Set(content.connections.map((edge) => edge.fromNodeId));
    const mediaReferences = new Set(content.nodes.flatMap((node) => node.metadata?.references || []));
    content.nodes.forEach((node) => {
        const metadata = node.metadata;
        if (!metadata) return;
        const input = metadata.templateInput;
        if (input) {
            const value = inputs[node.id];
            if (input.required && (!value || (typeof value === "string" && !value.trim()))) throw new Error(`templateInputRequired:${input.name}`);
            clearTemplateExample(node);
            if (typeof value === "string") metadata.content = value;
            else if (value) Object.assign(metadata, value);
            metadata.status = value ? "success" : "idle";
            node.title = input.name;
        } else if (!keepExamples && !inputIds.has(node.id) && !mediaReferences.has(metadata.storageKey || metadata.content || "") && (metadata.prompt || metadata.composerContent || metadata.images?.length || metadata.texts?.length) && [CanvasNodeType.Text, CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio].includes(node.type as CanvasNodeType)) clearTemplateExample(node);
        if (metadata.model && replacements[node.id]) metadata.model = replacements[node.id];
    });
    content.nodes.forEach((node) => {
        if (node.metadata?.references) node.metadata.references = node.metadata.references.flatMap((value) => {
            if (!value.startsWith("template-input:")) return [value];
            const input = inputs[value.slice(15)];
            return input && typeof input !== "string" ? [input.storageKey] : [];
        });
    });
    return content;
}

export function positionTemplateContent(content: CanvasTemplateContent, center: { x: number; y: number }) {
    if (!content.nodes.length) return content;
    const bounds = nodeBounds(content.nodes);
    const dx = center.x - (bounds.left + bounds.right) / 2;
    const dy = center.y - (bounds.top + bounds.bottom) / 2;
    return { ...content, nodes: content.nodes.map((node) => ({ ...node, position: { x: node.position.x + dx, y: node.position.y + dy } })) };
}
