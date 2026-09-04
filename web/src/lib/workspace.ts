import localforage from "localforage";

export type WorkspaceRole = "owner" | "editor" | "viewer";
export type WorkspaceAccess = { id: string; name: string; role: WorkspaceRole; createdAt: string; accessKey?: string };

const ACTIVE_WORKSPACE_KEY = "infinite-canvas:active-workspace";
const KNOWN_WORKSPACES_KEY = "infinite-canvas:known-workspaces";

export function getActiveWorkspace() {
    if (typeof window === "undefined") return null;
    return readWorkspace(window.localStorage.getItem(ACTIVE_WORKSPACE_KEY));
}

export function getKnownWorkspaces() {
    if (typeof window === "undefined") return [];
    try {
        const entries = JSON.parse(window.localStorage.getItem(KNOWN_WORKSPACES_KEY) || "[]") as unknown[];
        return entries.map(readWorkspace).filter((item): item is WorkspaceAccess => Boolean(item));
    } catch {
        return [];
    }
}

export function setKnownWorkspaces(workspaces: WorkspaceAccess[]) {
    const previous = new Map(getKnownWorkspaces().map((item) => [item.id, item]));
    window.localStorage.setItem(KNOWN_WORKSPACES_KEY, JSON.stringify(workspaces.map((item) => ({ ...item, accessKey: item.accessKey || previous.get(item.id)?.accessKey }))));
}

export function setActiveWorkspace(workspace: WorkspaceAccess) {
    const known = getKnownWorkspaces().filter((item) => item.id !== workspace.id);
    setKnownWorkspaces([workspace, ...known]);
    window.localStorage.setItem(ACTIVE_WORKSPACE_KEY, JSON.stringify(workspace));
}

export function clearActiveWorkspace() {
    window.localStorage.removeItem(ACTIVE_WORKSPACE_KEY);
}

export function workspaceHeaders(): Record<string, string> {
    const workspace = getActiveWorkspace();
    return workspace ? { "x-infinite-canvas-workspace": workspace.id, ...(workspace.accessKey ? { "x-infinite-canvas-workspace-token": workspace.accessKey } : {}) } : {};
}

export function workspaceStorageKey(key: string) {
    const workspace = getActiveWorkspace();
    return `workspace:${workspace?.id || "unselected"}:${key}`;
}

export function workspaceStoreName(name: string) {
    const workspace = getActiveWorkspace();
    return workspaceStoreNameFor(workspace?.id || "unselected", name);
}

export async function migrateLegacyDataToWorkspace(workspace: WorkspaceAccess) {
    const marker = `infinite-canvas:legacy-data-migrated:${workspace.id}`;
    if (window.localStorage.getItem(marker)) return false;
    const stateStore = localforage.createInstance({ name: "infinite-canvas", storeName: "app_state" });
    let migrated = false;
    for (const key of ["infinite-canvas:canvas_store", "infinite-canvas:asset_store"]) {
        const value = await stateStore.getItem<string>(key);
        if (value) {
            await stateStore.setItem(`workspace:${workspace.id}:${key}`, value);
            migrated = true;
        }
    }
    for (const name of ["image_files", "media_files", "image_generation_logs", "video_generation_logs"]) {
        const source = localforage.createInstance({ name: "infinite-canvas", storeName: name });
        const target = localforage.createInstance({ name: "infinite-canvas", storeName: workspaceStoreNameFor(workspace.id, name) });
        const entries: Array<{ key: string; value: unknown }> = [];
        await source.iterate((value, key) => { entries.push({ key, value }); });
        for (const entry of entries) await target.setItem(entry.key, entry.value);
        migrated ||= entries.length > 0;
    }
    window.localStorage.setItem(marker, "1");
    return migrated;
}

function workspaceStoreNameFor(id: string, name: string) {
    return `workspace_${id}_${name}`;
}

function readWorkspace(value: unknown): WorkspaceAccess | null {
    try {
        const item = typeof value === "string" ? JSON.parse(value) : value;
        if (!item || typeof item !== "object") return null;
        const workspace = item as Partial<WorkspaceAccess>;
        if (!workspace.id || !workspace.name) return null;
        const role = ["owner", "editor", "viewer"].includes(String(workspace.role)) ? workspace.role as WorkspaceRole : "owner";
        return { id: workspace.id, name: workspace.name, role, createdAt: workspace.createdAt || new Date(0).toISOString(), accessKey: typeof workspace.accessKey === "string" ? workspace.accessKey : undefined };
    } catch {
        return null;
    }
}
