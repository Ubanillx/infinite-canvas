import { expect, test } from "bun:test";
import { mergeCanvasSnapshot } from "../src/lib/canvas/canvas-snapshot-merge";
import type { CanvasProject } from "../src/stores/canvas/use-canvas-store";

const project = (id: string, updatedAt: string, title = id) => ({ id, updatedAt, title }) as CanvasProject;
const before = "2026-01-01T00:00:00.000Z";
const after = "2026-01-02T00:00:00.000Z";

test("importing an old snapshot does not resurrect a locally deleted canvas", () => {
    const result = mergeCanvasSnapshot({ projects: [], deleted: [{ id: "removed", deletedAt: after }] }, { projects: [project("removed", before), project("new", before)] });
    expect(result.projects.map((item) => item.id)).toEqual(["new"]);
    expect(result.deleted).toEqual([{ id: "removed", deletedAt: after }]);
});

test("snapshot import keeps the local record even when the remote copy is newer", () => {
    const result = mergeCanvasSnapshot({ projects: [project("same", before, "local")] }, { projects: [project("same", after, "remote")] });
    expect(result.projects[0].title).toBe("local");
});

test("deletion markers survive snapshot import and newer explicit edits can restore a canvas", () => {
    const result = mergeCanvasSnapshot({ projects: [project("restored", after)] }, { projects: [], deleted: [{ id: "restored", deletedAt: before }, { id: "deleted", deletedAt: after }] });
    expect(result.projects.map((item) => item.id)).toEqual(["restored"]);
    expect(result.deleted).toEqual([{ id: "deleted", deletedAt: after }]);
});
