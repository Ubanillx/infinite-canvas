import { describe, expect, test } from "bun:test";
import { taskReferencesToWorkbench } from "../src/pages/generation-task-references";

describe("durable workbench references", () => {
    test("restores ordered image, video and audio descriptors without temporary URLs", () => {
        const refs = taskReferencesToWorkbench("workspace-a", [
            { kind: "image", storageKey: "image:one", name: "one.png", mimeType: "image/png" },
            { kind: "video", storageKey: "video:two", name: "two.mp4", mimeType: "video/mp4", width: 720, height: 1280, durationMs: 4000 },
            { kind: "audio", storageKey: "audio:three", name: "three.mp3", mimeType: "audio/mpeg", durationMs: 3000 },
        ]);
        expect(refs.images.map((item) => item.storageKey)).toEqual(["image:one"]);
        expect(refs.videos[0]).toMatchObject({ name: "two.mp4", width: 720, height: 1280, durationMs: 4000 });
        expect(refs.audios[0]).toMatchObject({ name: "three.mp3", durationMs: 3000 });
        expect(refs.images[0].dataUrl).toContain("workspaceId=workspace-a");
        expect(refs.videos[0].url).toContain("workspaceId=workspace-a");
        expect(JSON.stringify(refs)).not.toContain("blob:");
    });
});
