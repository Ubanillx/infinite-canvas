import i18n from "@/i18n";
import { nodeBounds } from "@/lib/canvas/canvas-node-geometry";
import { canvasThemes } from "@/lib/canvas-theme";
import { CANVAS_IMAGE_PREVIEW_MAX_EDGE } from "@/lib/image-thumbnail";
import { loadMediaBlob } from "@/services/workspace-media";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { CanvasTemplateContent } from "@/types/canvas-template";

export async function createCanvasTemplateThumbnail(content: CanvasTemplateContent): Promise<Blob> {
    const theme = canvasThemes[useThemeStore.getState().theme];
    const fontFamily = getComputedStyle(document.body).fontFamily;
    const canvas = document.createElement("canvas");
    canvas.width = CANVAS_IMAGE_PREVIEW_MAX_EDGE;
    canvas.height = canvas.width * 3 / 4;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error(i18n.t("canvas.templates.coverFailed"));
    ctx.fillStyle = theme.canvas.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (content.nodes.length) {
        const bounds = nodeBounds(content.nodes);
        const padding = 32;
        const width = Math.max(1, bounds.right - bounds.left);
        const height = Math.max(1, bounds.bottom - bounds.top);
        const scale = Math.min((canvas.width - padding * 2) / width, (canvas.height - padding * 2) / height);
        ctx.translate((canvas.width - width * scale) / 2 - bounds.left * scale, (canvas.height - height * scale) / 2 - bounds.top * scale);
        ctx.scale(scale, scale);
        const drawFrame = (node: CanvasNodeData) => {
            ctx.fillStyle = node.type === CanvasNodeType.Group ? theme.canvas.background : theme.node.panel;
            ctx.strokeStyle = theme.node.stroke;
            ctx.lineWidth = 1 / scale;
            ctx.beginPath();
            ctx.roundRect(node.position.x, node.position.y, node.width, node.height, 8);
            ctx.fill();
            ctx.stroke();
        };
        content.nodes.filter((node) => node.type === CanvasNodeType.Group).forEach(drawFrame);
        const byId = new Map(content.nodes.map((node) => [node.id, node]));
        ctx.strokeStyle = theme.node.muted;
        ctx.lineWidth = 1.5 / scale;
        content.connections.forEach((connection) => {
            const from = byId.get(connection.fromNodeId);
            const to = byId.get(connection.toNodeId);
            if (!from || !to) return;
            const x1 = from.position.x + from.width;
            const y1 = from.position.y + from.height / 2;
            const x2 = to.position.x;
            const y2 = to.position.y + to.height / 2;
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.bezierCurveTo((x1 + x2) / 2, y1, (x1 + x2) / 2, y2, x2, y2);
            ctx.stroke();
        });
        for (const node of content.nodes) {
            if (node.type !== CanvasNodeType.Group) drawFrame(node);
            const { x, y } = node.position;
            ctx.save();
            ctx.beginPath();
            ctx.rect(x, y, node.width, node.height);
            ctx.clip();
            ctx.fillStyle = theme.node.text;
            ctx.font = `600 14px ${fontFamily}`;
            ctx.fillText(node.title || node.type, x + 12, y + 24, Math.max(1, node.width - 24));
            if (node.metadata?.storageKey?.startsWith("image:")) {
                const blob = await loadMediaBlob(node.metadata.storageKey);
                if (!blob) throw new Error(i18n.t("canvas.templates.mediaMissing"));
                const image = await createImageBitmap(blob);
                const imageScale = Math.min(node.width / image.width, Math.max(1, node.height - 36) / image.height);
                ctx.drawImage(image, x + (node.width - image.width * imageScale) / 2, y + 36 + (node.height - 36 - image.height * imageScale) / 2, image.width * imageScale, image.height * imageScale);
                image.close();
            } else if (node.type !== CanvasNodeType.Group) {
                ctx.fillStyle = theme.node.muted;
                ctx.font = `13px ${fontFamily}`;
                const text = node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio ? node.type.toUpperCase() : node.metadata?.composerContent || node.metadata?.prompt || node.metadata?.content || node.type;
                text.split("\n").slice(0, 8).forEach((line, index) => ctx.fillText(line, x + 12, y + 48 + index * 19, Math.max(1, node.width - 24)));
            }
            ctx.restore();
        }
    }
    return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error(i18n.t("canvas.templates.coverFailed"))), "image/webp"));
}
