import { uploadImage } from "@/services/image-storage";
import { readAgentMedia } from "@/services/api/agent-media";
import { waitForWorkspaceDataSave } from "@/services/workspace-data";
import { flushCanvasSave, useCanvasStore, type CanvasFolder } from "@/stores/canvas/use-canvas-store";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";
import { assertAgentWorkspace, requireAgentWorkspace } from "@/lib/agent/agent-tool-context";
import { workspaceStorageKey } from "@/lib/workspace";

export const RESOURCE_TOOL_NAMES = [
    "canvas_list_projects", "canvas_get_project", "canvas_create_project", "canvas_update_project", "canvas_delete_project",
    "canvas_list_folders", "canvas_create_folder", "canvas_update_folder", "canvas_delete_folder",
    "assets_list", "assets_get", "assets_create", "assets_update", "assets_delete",
] as const;

export type ResourceToolName = (typeof RESOURCE_TOOL_NAMES)[number];
export function isResourceTool(name: string): name is ResourceToolName {
    return (RESOURCE_TOOL_NAMES as readonly string[]).includes(name);
}

type Input = Record<string, unknown>;

function required(input: Input, key: string) {
    const value = input[key];
    if (typeof value !== "string" || !value.trim()) throw new Error(`请提供 ${key}`);
    return value.trim();
}

function optionalText(input: Input, key: string) {
    if (!(key in input)) return undefined;
    if (typeof input[key] !== "string") throw new Error(`${key} 必须是文本`);
    return (input[key] as string).trim();
}

function optionalFolder(input: Input, key: string) {
    if (!(key in input)) return undefined;
    if (input[key] === null) return null;
    return required(input, key);
}

function tags(input: Input) {
    if (!("tags" in input)) return undefined;
    if (!Array.isArray(input.tags) || input.tags.some((tag) => typeof tag !== "string")) throw new Error("tags 必须是文本数组");
    return input.tags as string[];
}

function canvas() {
    if (useCanvasStore.persist.getOptions().name !== workspaceStorageKey("infinite-canvas:canvas_store")) throw new Error("画布数据仍属于切换前的工作区，请刷新页面");
    const state = useCanvasStore.getState();
    if (!state.hydrated) throw new Error("画布还在加载中");
    return state;
}

function assets() {
    if (useAssetStore.persist.getOptions().name !== workspaceStorageKey("infinite-canvas:asset_store")) throw new Error("素材数据仍属于切换前的工作区，请刷新页面");
    const state = useAssetStore.getState();
    if (!state.hydrated) throw new Error("素材还在加载中");
    return state;
}

function folderExists(id: string | null | undefined) {
    if (id && !canvas().folders.some((folder) => folder.id === id)) throw new Error("文件夹不存在");
}

function project(id: string) {
    const found = canvas().projects.find((item) => item.id === id);
    if (!found) throw new Error("画布不存在");
    return found;
}

function folder(id: string) {
    const found = canvas().folders.find((item) => item.id === id);
    if (!found) throw new Error("文件夹不存在");
    return found;
}

function asset(id: string) {
    const found = assets().assets.find((item) => item.id === id);
    if (!found) throw new Error("素材不存在");
    return found;
}

function activeProjectId() {
    const match = window.location.pathname.match(/^\/canvas\/([^/]+)/);
    return match ? decodeURIComponent(match[1]) : null;
}

function assertNotOpen(ids: string[]) {
    if (ids.includes(activeProjectId() || "")) throw new Error("当前打开的画布不能删除，请先返回画布库");
}

function page(input: Input, total: number) {
    const pageSize = Math.max(1, Math.min(100, Math.floor(Number(input.pageSize)) || 20));
    const page = Math.min(Math.max(1, Math.ceil(total / pageSize)), Math.max(1, Math.floor(Number(input.page)) || 1));
    return { page, pageSize, start: (page - 1) * pageSize };
}

function projectSummary(item: ReturnType<typeof project>) {
    return { id: item.id, title: item.title, description: item.description, folderId: item.folderId, createdAt: item.createdAt, updatedAt: item.updatedAt, nodeCount: item.nodes.length, connectionCount: item.connections.length };
}

function assetSummary(item: Asset) {
    return { id: item.id, kind: item.kind, title: item.title, tags: item.tags, source: item.source, note: item.note, createdAt: item.createdAt, updatedAt: item.updatedAt, coverUrl: item.coverUrl || undefined, content: item.kind === "text" ? item.data.content : undefined };
}

function descendantIds(folders: CanvasFolder[], id: string) {
    const ids = new Set([id]);
    let size = 0;
    while (size !== ids.size) {
        size = ids.size;
        folders.forEach((item) => { if (item.parentId && ids.has(item.parentId)) ids.add(item.id); });
    }
    return ids;
}

async function committedCanvas(workspaceId: string, id?: string, extra: Record<string, unknown> = {}) {
    const receipt = await flushCanvasSave(workspaceId);
    return { status: "committed" as const, ...receipt, id, ...extra };
}

async function committedAssets(workspaceId: string, id?: string, extra: Record<string, unknown> = {}) {
    const receipt = await waitForWorkspaceDataSave("assets", workspaceId);
    return { status: "committed" as const, ...receipt, id, ...extra };
}

async function importAssetImage(input: Input, workspaceId: string) {
    if (input.storageKey === undefined) return uploadImage(required(input, "imageUrl"));
    if (input.imageUrl !== undefined) throw new Error("imageUrl 和 storageKey 只能提供一个");
    const key = required(input, "storageKey");
    if (!/^image:[A-Za-z0-9_-]+$/.test(key)) throw new Error("请提供当前工作区的图片 storageKey");
    const blob = await readAgentMedia(workspaceId, key);
    assertAgentWorkspace(workspaceId);
    return uploadImage(blob);
}

export async function runResourceTool(name: ResourceToolName, input: Input): Promise<unknown> {
    const write = ["canvas_create_project", "canvas_update_project", "canvas_delete_project", "canvas_create_folder", "canvas_update_folder", "canvas_delete_folder", "assets_create", "assets_update", "assets_delete"].includes(name);
    const { id: workspaceId } = requireAgentWorkspace(input, write);

    switch (name) {
        case "canvas_list_projects": {
            const keyword = optionalText(input, "keyword")?.toLowerCase() || "";
            const matches = canvas().projects.filter((item) => !keyword || `${item.title} ${item.description || ""}`.toLowerCase().includes(keyword));
            const { page: current, pageSize, start } = page(input, matches.length);
            return { workspaceId, total: matches.length, page: current, pageSize, items: matches.slice(start, start + pageSize).map(projectSummary) };
        }
        case "canvas_get_project": {
            const item = project(required(input, "projectId"));
            const { chatSessions: _chatSessions, ...detail } = item;
            return { workspaceId, project: detail };
        }
        case "canvas_create_project": {
            const title = required(input, "title");
            const folderId = optionalFolder(input, "folderId") ?? null;
            folderExists(folderId);
            const id = canvas().createProject(title, folderId, optionalText(input, "description") || "");
            return committedCanvas(workspaceId, id);
        }
        case "canvas_update_project": {
            const id = required(input, "projectId");
            project(id);
            const title = optionalText(input, "title");
            const description = optionalText(input, "description");
            const folderId = optionalFolder(input, "folderId");
            if (title === undefined && description === undefined && folderId === undefined) throw new Error("请提供画布修改内容");
            if (folderId !== undefined) folderExists(folderId);
            if (title !== undefined) {
                if (!title) throw new Error("请提供 title");
                canvas().renameProject(id, title);
            }
            if (folderId !== undefined) canvas().moveProject(id, folderId);
            if (description !== undefined) useCanvasStore.setState((state) => ({ projects: state.projects.map((item) => item.id === id ? { ...item, description, updatedAt: new Date().toISOString() } : item) }));
            return committedCanvas(workspaceId, id);
        }
        case "canvas_delete_project": {
            const id = required(input, "projectId");
            project(id);
            assertNotOpen([id]);
            canvas().deleteProjects([id]);
            return committedCanvas(workspaceId, id, { deletedProjectIds: [id] });
        }
        case "canvas_list_folders": {
            const state = canvas();
            return { workspaceId, total: state.folders.length, items: state.folders };
        }
        case "canvas_create_folder": {
            const title = required(input, "title");
            const parentId = optionalFolder(input, "parentId") ?? null;
            folderExists(parentId);
            const id = canvas().createFolder(title, parentId);
            return committedCanvas(workspaceId, id);
        }
        case "canvas_update_folder": {
            const id = required(input, "folderId");
            folder(id);
            const title = optionalText(input, "title");
            const parentId = optionalFolder(input, "parentId");
            if (title === undefined && parentId === undefined) throw new Error("请提供文件夹修改内容");
            if (parentId !== undefined) {
                folderExists(parentId);
                if (parentId === id || (parentId && descendantIds(canvas().folders, id).has(parentId))) throw new Error("不能把文件夹移入自身或子文件夹");
            }
            if (title !== undefined) {
                if (!title) throw new Error("请提供 title");
                canvas().renameFolder(id, title);
            }
            if (parentId !== undefined) canvas().moveFolder(id, parentId);
            return committedCanvas(workspaceId, id);
        }
        case "canvas_delete_folder": {
            const id = required(input, "folderId");
            folder(id);
            const deletedFolderIds = [...descendantIds(canvas().folders, id)];
            const deletedProjectIds = canvas().projects.filter((item) => item.folderId && deletedFolderIds.includes(item.folderId)).map((item) => item.id);
            assertNotOpen(deletedProjectIds);
            canvas().deleteFolders([id]);
            return committedCanvas(workspaceId, id, { deletedFolderIds, deletedProjectIds });
        }
        case "assets_list": {
            const kind = optionalText(input, "kind") || "all";
            if (!["all", "text", "image", "video"].includes(kind)) throw new Error("素材类型无效");
            const keyword = optionalText(input, "keyword")?.toLowerCase() || "";
            const matches = assets().assets.filter((item) => (kind === "all" || item.kind === kind) && (!keyword || [item.title, item.note, item.source, ...item.tags].filter(Boolean).join(" ").toLowerCase().includes(keyword)));
            const { page: current, pageSize, start } = page(input, matches.length);
            return { workspaceId, total: matches.length, page: current, pageSize, items: matches.slice(start, start + pageSize).map(assetSummary) };
        }
        case "assets_get": return { workspaceId, asset: asset(required(input, "assetId")) };
        case "assets_create": {
            assets();
            const kind = required(input, "kind");
            const title = required(input, "title");
            const base = { title, tags: tags(input) || [], source: optionalText(input, "source") || "Agent", note: optionalText(input, "note"), metadata: { source: "agent" } };
            let id: string;
            if (kind === "text") {
                id = assets().addAsset({ ...base, kind, coverUrl: "", data: { content: required(input, "content") } });
            } else if (kind === "image") {
                const image = await importAssetImage(input, workspaceId);
                assertAgentWorkspace(workspaceId);
                id = assets().addAsset({ ...base, kind, coverUrl: image.url, data: { dataUrl: image.url, storageKey: image.storageKey, width: image.width, height: image.height, bytes: image.bytes, mimeType: image.mimeType } });
            } else throw new Error("新增素材仅支持文本和图片");
            return committedAssets(workspaceId, id);
        }
        case "assets_update": {
            const id = required(input, "assetId");
            const current = asset(id);
            const originalUpdatedAt = current.updatedAt;
            if (current.kind === "video") throw new Error("视频素材不能编辑");
            const title = optionalText(input, "title");
            const nextTags = tags(input);
            const source = optionalText(input, "source");
            const note = optionalText(input, "note");
            const content = optionalText(input, "content");
            const imageUrl = optionalText(input, "imageUrl");
            const storageKey = optionalText(input, "storageKey");
            if (title === undefined && nextTags === undefined && source === undefined && note === undefined && content === undefined && imageUrl === undefined && storageKey === undefined) throw new Error("请提供素材修改内容");
            if (title !== undefined && !title) throw new Error("请提供 title");
            if (content !== undefined && current.kind !== "text" || (imageUrl !== undefined || storageKey !== undefined) && current.kind !== "image") throw new Error("素材类型与内容不匹配");
            if (content !== undefined && !content) throw new Error("请提供 content");
            const patch: Partial<Asset> = { ...(title !== undefined ? { title } : {}), ...(nextTags !== undefined ? { tags: nextTags } : {}), ...(source !== undefined ? { source } : {}), ...(note !== undefined ? { note } : {}) };
            if (content !== undefined) patch.data = { content };
            if (imageUrl !== undefined || storageKey !== undefined) {
                const image = await importAssetImage(input, workspaceId);
                assertAgentWorkspace(workspaceId);
                const latest = assets().assets.find((item) => item.id === id);
                if (!latest || latest !== current || latest.updatedAt !== originalUpdatedAt) throw new Error("素材已被修改或删除，请重新读取后操作");
                patch.coverUrl = image.url;
                patch.data = { dataUrl: image.url, storageKey: image.storageKey, width: image.width, height: image.height, bytes: image.bytes, mimeType: image.mimeType };
            }
            assets().updateAsset(id, patch);
            return committedAssets(workspaceId, id);
        }
        case "assets_delete": {
            const id = required(input, "assetId");
            asset(id);
            assets().removeAsset(id);
            return committedAssets(workspaceId, id, { deletedAssetIds: [id] });
        }
    }
}
