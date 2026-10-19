import { expect, test } from "bun:test";
import { mergeCanvasSnapshot } from "../src/lib/canvas/canvas-snapshot-merge";
import type { CanvasFolder, CanvasProject } from "../src/stores/canvas/use-canvas-store";

const project = (id: string, updatedAt: string, title = id) => ({ id, updatedAt, title }) as CanvasProject;
const before = "2026-01-01T00:00:00.000Z";
const after = "2026-01-02T00:00:00.000Z";

test("snapshot import preserves nested folders and keeps local folder edits", () => {
    const folder = (id: string, parentId: string | null, title = id) => ({ id, parentId, title, createdAt: before, updatedAt: before }) as CanvasFolder;
    const canvas = { ...project("nested", before), folderId: "child" };
    const result = mergeCanvasSnapshot(
        { projects: [], folders: [folder("root", null, "local")] },
        { projects: [canvas], folders: [folder("root", null, "remote"), folder("child", "root")] },
    );
    expect(result.folders?.map(({ id, parentId, title }) => ({ id, parentId, title }))).toEqual([
        { id: "root", parentId: null, title: "local" },
        { id: "child", parentId: "root", title: "child" },
    ]);
    expect(result.projects[0].folderId).toBe("child");
});

test("snapshots without folders retain current folders and canvas deletion markers", () => {
    const folder = { id: "local", parentId: null, title: "Local", createdAt: before, updatedAt: before } as CanvasFolder;
    const result = mergeCanvasSnapshot(
        { projects: [], folders: [folder], deleted: [{ id: "removed-child", deletedAt: after }] },
        { projects: [project("removed-child", before), project("root-canvas", before)] },
    );
    expect(result.folders).toEqual([folder]);
    expect(result.projects.map(({ id }) => id)).toEqual(["root-canvas"]);
    expect(result.deleted).toEqual([{ id: "removed-child", deletedAt: after }]);
});

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
