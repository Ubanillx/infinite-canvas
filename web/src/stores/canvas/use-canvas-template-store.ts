import { nanoid } from "nanoid";
import { create } from "zustand";

import i18n from "@/i18n";
import { createCanvasTemplateThumbnail } from "@/lib/canvas/canvas-template-thumbnail";
import { getActiveWorkspace } from "@/lib/workspace";
import { copyCanvasTemplateContent, requireTemplateWorkspace, templateMediaError } from "@/services/canvas-templates";
import { loadWorkspaceData, saveWorkspaceData, type WorkspaceDataCommit } from "@/services/workspace-data";
import { saveMediaBlob } from "@/services/workspace-media";
import type { CanvasTemplate, CanvasTemplateContent, CanvasTemplateData } from "@/types/canvas-template";

type CanvasTemplateStore = {
    templates: CanvasTemplate[];
    workspaceId: string | null;
    loaded: boolean;
    loading: boolean;
    error: string;
    load: () => Promise<void>;
    save: (source: CanvasTemplateContent, title: string, description: string) => Promise<{ id: string; commit: WorkspaceDataCommit }>;
    update: (id: string, title?: string, description?: string) => Promise<WorkspaceDataCommit>;
    replace: (id: string, source: CanvasTemplateContent, title?: string, description?: string) => Promise<WorkspaceDataCommit>;
    remove: (id: string) => Promise<WorkspaceDataCommit>;
    addImportedTemplate: (template: CanvasTemplate) => Promise<WorkspaceDataCommit>;
};

let loading: Promise<void> | null = null;
let mutations: Promise<unknown> = Promise.resolve();

function mutate(update: (templates: CanvasTemplate[], workspaceId: string) => Promise<CanvasTemplate[]>) {
    const workspaceId = getActiveWorkspace()?.id;
    const operation = mutations.catch(() => undefined).then(async () => {
        requireTemplateWorkspace(workspaceId);
        await useCanvasTemplateStore.getState().load();
        requireTemplateWorkspace(workspaceId);
        const templates = await update(useCanvasTemplateStore.getState().templates, workspaceId);
        requireTemplateWorkspace(workspaceId);
        const commit = await saveWorkspaceData("canvas-templates", { version: 1, templates } satisfies CanvasTemplateData, { retryable: false });
        if (getActiveWorkspace()?.id === workspaceId && useCanvasTemplateStore.getState().workspaceId === workspaceId) useCanvasTemplateStore.setState({ templates });
        return commit;
    });
    mutations = operation;
    return operation;
}

export const useCanvasTemplateStore = create<CanvasTemplateStore>((set, get) => ({
    templates: [], workspaceId: null, loaded: false, loading: false, error: "",
    load: () => {
        const workspaceId = getActiveWorkspace()?.id;
        if (get().loaded && get().workspaceId === workspaceId) return Promise.resolve();
        if (loading) return loading;
        set({ templates: [], loaded: false, loading: true, error: "" });
        loading = (async () => {
            try {
                const data = await loadWorkspaceData<CanvasTemplateData>("canvas-templates", { reportError: false });
                requireTemplateWorkspace(workspaceId);
                if (data && (data.version !== 1 || !Array.isArray(data.templates) || data.templates.some((template) => !template.id || !template.title?.trim() || !template.cover?.storageKey || !Array.isArray(template.content?.nodes) || !Array.isArray(template.content?.connections)))) throw new Error(i18n.t("canvas.templates.invalidData"));
                set({ templates: data?.templates || [], workspaceId, loaded: true });
            } catch (error) {
                set({ error: error instanceof Error ? error.message : i18n.t("canvas.templates.loadFailed") });
                throw error;
            } finally {
                set({ loading: false });
                loading = null;
            }
        })();
        return loading;
    },
    save: async (source, title, description) => {
        let id = "";
        const copiedKeys = new Set<string>();
        try {
            const commit = await mutate(async (templates, workspaceId) => {
                if (!title.trim()) throw new Error(i18n.t("canvas.templates.nameRequired"));
                const content = await copyCanvasTemplateContent(source, workspaceId, copiedKeys);
                const thumbnail = await createCanvasTemplateThumbnail(content);
                requireTemplateWorkspace(workspaceId);
                const storageKey = `image:${nanoid()}`;
                await saveMediaBlob(storageKey, thumbnail);
                copiedKeys.add(storageKey);
                const now = new Date().toISOString();
                id = nanoid();
                return [{ id, title: title.trim(), description: description.trim(), cover: { storageKey }, content, createdAt: now, updatedAt: now }, ...templates];
            });
            return { id, commit };
        } catch (error) { throw templateMediaError(error, copiedKeys); }
    },
    update: (id, title, description) => mutate(async (templates) => {
        const previous = templates.find((template) => template.id === id);
        if (!previous) throw new Error(i18n.t("canvas.templates.missing"));
        if (title !== undefined && !title.trim()) throw new Error(i18n.t("canvas.templates.nameRequired"));
        return templates.map((template) => template.id === id ? { ...template, title: title === undefined ? template.title : title.trim(), description: description === undefined ? template.description : description.trim(), updatedAt: new Date().toISOString() } : template);
    }),
    replace: async (id, source, title, description) => {
        const copiedKeys = new Set<string>();
        try { return await mutate(async (templates, workspaceId) => {
            const previous = templates.find((template) => template.id === id);
            if (!previous) throw new Error(i18n.t("canvas.templates.missing"));
            if (title !== undefined && !title.trim()) throw new Error(i18n.t("canvas.templates.nameRequired"));
            const content = await copyCanvasTemplateContent(source, workspaceId, copiedKeys);
            const thumbnail = await createCanvasTemplateThumbnail(content);
            requireTemplateWorkspace(workspaceId);
            const storageKey = `image:${nanoid()}`;
            await saveMediaBlob(storageKey, thumbnail);
            copiedKeys.add(storageKey);
            return templates.map((template) => template.id === id ? { ...previous, title: title === undefined ? previous.title : title.trim(), description: description === undefined ? previous.description : description.trim(), content, cover: { storageKey }, updatedAt: new Date().toISOString() } : template);
        }); } catch (error) { throw templateMediaError(error, copiedKeys); }
    },
    remove: (id) => mutate(async (templates) => {
        if (!templates.some((template) => template.id === id)) throw new Error(i18n.t("canvas.templates.missing"));
        return templates.filter((template) => template.id !== id);
    }),
    addImportedTemplate: (template) => mutate(async (templates) => {
        if (!template.id || templates.some((item) => item.id === template.id)) throw new Error("模板 ID 已存在或无效");
        if (!template.title?.trim() || !template.cover?.storageKey || !Array.isArray(template.content?.nodes) || !Array.isArray(template.content?.connections)) throw new Error(i18n.t("canvas.templates.invalidData"));
        return [template, ...templates];
    }),
}));
