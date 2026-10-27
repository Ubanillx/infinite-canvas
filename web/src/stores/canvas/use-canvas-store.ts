import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import i18n from "@/i18n";
import { localForageStorage } from "@/lib/localforage-storage";
import { getActiveWorkspace, workspaceStorageKey } from "@/lib/workspace";
import { loadWorkspaceData, saveWorkspaceData } from "@/services/workspace-data";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";
import type { CanvasTemplateContent } from "@/types/canvas-template";

export type CanvasProject = {
    id: string;
    title: string;
    description?: string;
    folderId: string | null;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
};

export type CanvasFolder = {
    id: string;
    title: string;
    parentId: string | null;
    createdAt: string;
    updatedAt: string;
};

export type CanvasDeletedProject = {
    id: string;
    deletedAt: string;
};

type CanvasStore = {
    hydrated: boolean;
    projects: CanvasProject[];
    folders: CanvasFolder[];
    deletedProjects: CanvasDeletedProject[];
    createProject: (title?: string, folderId?: string | null, description?: string) => string;
    importProject: (project: Partial<CanvasProject>, folderId?: string | null) => string;
    createProjectFromTemplate: (content: CanvasTemplateContent, title: string, description: string, folderId: string | null) => Promise<string>;
    createFolder: (title?: string, parentId?: string | null) => string;
    renameFolder: (id: string, title: string) => void;
    deleteFolders: (ids: string[]) => string[];
    moveProject: (id: string, folderId: string | null) => void;
    moveFolder: (id: string, parentId: string | null) => void;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => void;
    deleteProjects: (ids: string[]) => void;
    replaceProjects: (projects: CanvasProject[], deletedProjects?: CanvasDeletedProject[]) => void;
    replaceCanvasData: (projects: CanvasProject[], folders: CanvasFolder[], deletedProjects?: CanvasDeletedProject[]) => void;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport">>) => void;
};

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
const CANVAS_STORE_KEY = "infinite-canvas:canvas_store";
type PersistedCanvasState = Pick<CanvasStore, "projects" | "folders" | "deletedProjects">;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let queuedPersistState: PersistedCanvasState | null = null;
let canvasWrites: Promise<unknown> = Promise.resolve();

function enqueueCanvasWrite<T>(write: () => Promise<T>) {
    const next = canvasWrites.catch(() => undefined).then(write);
    canvasWrites = next;
    return next;
}

function persistedState(state: CanvasStore): PersistedCanvasState {
    return { projects: state.projects, folders: state.folders, deletedProjects: state.deletedProjects };
}

const canvasStorage: PersistStorage<CanvasStore> = {
    getItem: async (name) => {
        const remote = await loadWorkspaceData<StorageValue<CanvasStore>>("canvas");
        if (remote) {
            const normalized = normalizeCanvasStorageValue(remote);
            if (!normalized) throw new Error("画布工作区数据格式未知或损坏，未覆盖原数据");
            queuedPersistState = normalized.state as PersistedCanvasState;
            return normalized;
        }
        const value = await localForageStorage.getItem(name);
        if (!value) return null;
        let parsed: unknown;
        try {
            parsed = JSON.parse(value);
        } catch {
            throw new Error("画布本地数据格式损坏，未覆盖原数据");
        }
        const normalized = normalizeCanvasStorageValue(parsed);
        if (!normalized) throw new Error("画布本地数据格式未知或损坏，未覆盖原数据");
        await saveWorkspaceData("canvas", normalized);
        await Promise.resolve(localForageStorage.removeItem(name)).catch(() => undefined);
        queuedPersistState = normalized.state as PersistedCanvasState;
        return normalized;
    },
    setItem: (name, value) => {
        const nextState = value.state as PersistedCanvasState;
        if (queuedPersistState && queuedPersistState.projects === nextState.projects && queuedPersistState.folders === nextState.folders && queuedPersistState.deletedProjects === nextState.deletedProjects) return;
        queuedPersistState = nextState;
        if (saveTimer) clearTimeout(saveTimer);
        const workspaceId = getActiveWorkspace()?.id;
        saveTimer = setTimeout(() => {
            saveTimer = null;
            // Read at execution time so an autosave cannot erase an acknowledged template-created project.
            void enqueueCanvasWrite(async () => {
                if (getActiveWorkspace()?.id !== workspaceId || name !== workspaceStorageKey(CANVAS_STORE_KEY)) return;
                await saveWorkspaceData("canvas", { state: persistedState(useCanvasStore.getState()), version: 0 });
                await localForageStorage.removeItem(name);
            }).catch(() => undefined);
        }, 400);
    },
    removeItem: (name) => localForageStorage.removeItem(name),
};

function normalizeCanvasStorageValue(value: unknown): StorageValue<CanvasStore> | null {
    if (!isRecord(value) || (value.version !== undefined && value.version !== 0) || !isRecord(value.state) || !Array.isArray(value.state.projects)) return null;
    const deletedProjects = value.state.deletedProjects ?? [];
    if (!Array.isArray(deletedProjects) || deletedProjects.some((item) => !isRecord(item) || typeof item.id !== "string" || typeof item.deletedAt !== "string")) return null;
    const rawFolders = value.state.folders === undefined ? [] : value.state.folders;
    if (!Array.isArray(rawFolders)) return null;

    const folderIds = new Set<string>();
    const folders = rawFolders.map((item) => {
        if (!isRecord(item) || typeof item.id !== "string" || !item.id || folderIds.has(item.id)) return null;
        folderIds.add(item.id);
        return { ...item, parentId: typeof item.parentId === "string" ? item.parentId : null } as unknown as CanvasFolder;
    });
    if (folders.some((folder) => !folder)) return null;
    const validFolders = folders as CanvasFolder[];
    const parentById = new Map(validFolders.map((folder) => [folder.id, folderIds.has(folder.parentId || "") && folder.parentId !== folder.id ? folder.parentId : null]));
    const normalizedFolders = validFolders.map((folder) => ({ ...folder, parentId: hasFolderCycle(folder.id, parentById) ? null : parentById.get(folder.id) || null }));
    const normalizedProjects = value.state.projects.map((item) => {
        if (!isRecord(item) || typeof item.id !== "string" || !item.id) return null;
        const folderId = typeof item.folderId === "string" && folderIds.has(item.folderId) ? item.folderId : null;
        return { ...item, folderId } as unknown as CanvasProject;
    });
    if (normalizedProjects.some((project) => !project)) return null;
    return { ...value, state: { ...value.state, projects: normalizedProjects as CanvasProject[], folders: normalizedFolders, deletedProjects } } as unknown as StorageValue<CanvasStore>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function hasFolderCycle(startId: string, parentById: Map<string, string | null>) {
    const visited = new Set<string>();
    let current: string | null = startId;
    while (current) {
        if (visited.has(current)) return true;
        visited.add(current);
        current = parentById.get(current) || null;
    }
    return false;
}

export const useCanvasStore = create<CanvasStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            projects: [],
            folders: [],
            deletedProjects: [],
            createProject: (title = i18n.t("canvas.project.untitled"), folderId = null, description = "") => {
                const now = new Date().toISOString();
                const id = nanoid();
                const project: CanvasProject = {
                    id,
                    title,
                    description,
                    folderId,
                    createdAt: now,
                    updatedAt: now,
                    nodes: [],
                    connections: [],
                    chatSessions: [],
                    activeChatId: null,
                    backgroundMode: "lines",
                    showImageInfo: false,
                    viewport: initialViewport,
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                return id;
            },
            importProject: (source, folderId = source.folderId ?? null) => {
                const now = new Date().toISOString();
                const targetFolderId = folderId && get().folders.some((item) => item.id === folderId) ? folderId : null;
                const project: CanvasProject = {
                    id: nanoid(),
                    title: source.title || i18n.t("canvas.project.imported"),
                    description: source.description || "",
                    folderId: targetFolderId,
                    createdAt: source.createdAt || now,
                    updatedAt: now,
                    nodes: source.nodes || [],
                    connections: source.connections || [],
                    chatSessions: source.chatSessions || [],
                    activeChatId: source.activeChatId || null,
                    backgroundMode: source.backgroundMode || "lines",
                    showImageInfo: source.showImageInfo || false,
                    viewport: source.viewport || initialViewport,
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                return project.id;
            },
            createProjectFromTemplate: (content, title, description, folderId) => {
                const workspaceId = getActiveWorkspace()?.id;
                return enqueueCanvasWrite(async () => {
                    if (!workspaceId || getActiveWorkspace()?.id !== workspaceId || useCanvasStore.persist.getOptions().name !== workspaceStorageKey(CANVAS_STORE_KEY)) throw new Error(i18n.t("canvas.templates.workspaceChanged"));
                    if (!get().hydrated) throw new Error(i18n.t("canvas.loading"));
                    const now = new Date().toISOString();
                    const project: CanvasProject = {
                        ...content, id: nanoid(), title, description,
                        folderId: get().folders.some((folder) => folder.id === folderId) ? folderId : null,
                        createdAt: now, updatedAt: now, chatSessions: [], activeChatId: null,
                    };
                    await saveWorkspaceData("canvas", { state: { ...persistedState(get()), projects: [project, ...get().projects] }, version: 0 }, { retryable: false });
                    if (getActiveWorkspace()?.id !== workspaceId) throw new Error(i18n.t("canvas.templates.workspaceChanged"));
                    set((state) => ({ projects: [project, ...state.projects] }));
                    return project.id;
                });
            },
            createFolder: (title = i18n.t("canvas.folder.untitled"), parentId = null) => {
                const now = new Date().toISOString();
                const targetParentId = parentId && get().folders.some((item) => item.id === parentId) ? parentId : null;
                const folder: CanvasFolder = { id: nanoid(), title: title.trim() || i18n.t("canvas.folder.untitled"), parentId: targetParentId, createdAt: now, updatedAt: now };
                set((state) => ({ folders: [folder, ...state.folders] }));
                return folder.id;
            },
            renameFolder: (id, title) =>
                set((state) => ({ folders: state.folders.map((folder) => (folder.id === id ? { ...folder, title: title.trim() || folder.title, updatedAt: new Date().toISOString() } : folder)) })),
            deleteFolders: (ids) => {
                const state = get();
                const removedFolders = new Set(ids);
                let changed = true;
                while (changed) {
                    changed = false;
                    state.folders.forEach((folder) => {
                        if (folder.parentId && removedFolders.has(folder.parentId) && !removedFolders.has(folder.id)) {
                            removedFolders.add(folder.id);
                            changed = true;
                        }
                    });
                }
                const projectIds = state.projects.filter((project) => project.folderId && removedFolders.has(project.folderId)).map((project) => project.id);
                get().deleteProjects(projectIds);
                set({ folders: state.folders.filter((folder) => !removedFolders.has(folder.id)) });
                return projectIds;
            },
            moveProject: (id, folderId) =>
                set((state) => ({ projects: state.projects.map((project) => (project.id === id ? { ...project, folderId: folderId && state.folders.some((folder) => folder.id === folderId) ? folderId : null, updatedAt: new Date().toISOString() } : project)) })),
            moveFolder: (id, parentId) => {
                const state = get();
                if (id === parentId || (parentId && isFolderDescendant(state.folders, id, parentId))) return;
                set((current) => ({ folders: current.folders.map((folder) => (folder.id === id ? { ...folder, parentId: parentId && current.folders.some((item) => item.id === parentId) ? parentId : null, updatedAt: new Date().toISOString() } : folder)) }));
            },
            openProject: (id) => {
                return get().projects.find((item) => item.id === id) || null;
            },
            renameProject: (id, title) =>
                set((state) => ({
                    projects: state.projects.map((project) => (project.id === id ? { ...project, title: title.trim() || project.title, updatedAt: new Date().toISOString() } : project)),
                })),
            deleteProjects: (ids) =>
                set((state) => {
                    const now = new Date().toISOString();
                    const removing = new Set(ids);
                    const projects = state.projects.filter((project) => !removing.has(project.id));
                    const deletedProjects = [...state.deletedProjects.filter((item) => !removing.has(item.id)), ...ids.map((id) => ({ id, deletedAt: now }))];
                    return { projects, deletedProjects };
                }),
            replaceProjects: (projects, deletedProjects = []) => set({ projects: projects.map((project) => ({ ...project, folderId: get().folders.some((folder) => folder.id === project.folderId) ? project.folderId : null })), deletedProjects }),
            replaceCanvasData: (projects, folders, deletedProjects = []) => {
                const normalized = normalizeCanvasStorageValue({ state: { projects, folders, deletedProjects } });
                if (!normalized) throw new Error("Invalid canvas snapshot");
                set(normalized.state);
            },
            updateProject: (id, patch) =>
                set((state) => ({
                    projects: state.projects.map((project) => (project.id === id ? { ...project, ...patch, updatedAt: new Date().toISOString() } : project)),
                })),
        }),
        {
            name: workspaceStorageKey(CANVAS_STORE_KEY),
            storage: canvasStorage,
            partialize: (state) =>
                ({
                    projects: state.projects,
                    folders: state.folders,
                    deletedProjects: state.deletedProjects,
                }) as StorageValue<CanvasStore>["state"],
            onRehydrateStorage: () => () => {
                useCanvasStore.setState({ hydrated: true });
            },
        },
    ),
);

function isFolderDescendant(folders: CanvasFolder[], ancestorId: string, candidateId: string) {
    let current = folders.find((folder) => folder.id === candidateId)?.parentId || null;
    while (current) {
        if (current === ancestorId) return true;
        current = folders.find((folder) => folder.id === current)?.parentId || null;
    }
    return false;
}
