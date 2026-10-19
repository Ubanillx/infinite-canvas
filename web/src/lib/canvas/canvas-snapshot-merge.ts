import type { CanvasDeletedProject, CanvasFolder, CanvasProject } from "@/stores/canvas/use-canvas-store";

export type CanvasSnapshotData = { projects: CanvasProject[]; folders?: CanvasFolder[]; deleted?: CanvasDeletedProject[] };

export function mergeCanvasSnapshot(local: CanvasSnapshotData, remote: CanvasSnapshotData): CanvasSnapshotData {
    const deleted = new Map<string, string>();
    for (const item of [...(remote.deleted || []), ...(local.deleted || [])]) {
        if (item.id && item.deletedAt > (deleted.get(item.id) || "")) deleted.set(item.id, item.deletedAt);
    }
    // Explicit snapshot imports keep the local version of an existing project.
    const projects = new Map(remote.projects.map((project) => [project.id, project]));
    local.projects.forEach((project) => projects.set(project.id, project));
    const folders = new Map((remote.folders || []).map((folder) => [folder.id, folder]));
    (local.folders || []).forEach((folder) => folders.set(folder.id, folder));
    return {
        folders: [...folders.values()],
        projects: [...projects.values()].filter((project) => {
            const deletedAt = deleted.get(project.id);
            if (!deletedAt) return true;
            if (Date.parse(project.updatedAt) > Date.parse(deletedAt)) {
                deleted.delete(project.id);
                return true;
            }
            return false;
        }),
        deleted: [...deleted].map(([id, deletedAt]) => ({ id, deletedAt })),
    };
}
