import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";

export type CanvasTemplateContent = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
};

export type CanvasTemplate = {
    id: string;
    title: string;
    description: string;
    createdAt: string;
    updatedAt: string;
    cover: { storageKey: string };
    content: CanvasTemplateContent;
};

export type CanvasTemplateData = { version: 1; templates: CanvasTemplate[] };
