import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { App, Button, Modal } from "antd";
import { ChevronRight, Download, FileUp, FolderPlus, Home, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { readZip } from "@/lib/zip";
import { setMediaBlob } from "@/services/file-storage";
import { setImageBlob } from "@/services/image-storage";
import { CanvasDeleteProjectsDialog } from "@/components/canvas/canvas-delete-projects-dialog";
import { CanvasProjectCard } from "@/components/canvas/canvas-project-card";
import { CanvasFolderCard } from "@/components/canvas/canvas-folder-card";
import type { CanvasExportFile } from "@/types/canvas-export";
import { useCanvasStore, type CanvasFolder } from "@/stores/canvas/use-canvas-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";
import { hasAgentUrlBootstrap } from "@/lib/agent/agent-url-bootstrap";

const CANVAS_DRAG_TYPE = "application/x-infinite-canvas-item";
type CanvasDragItem = { type: "project" | "folder"; id: string };

export default function CanvasPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const inputRef = useRef<HTMLInputElement>(null);
    const autoOpenRef = useRef(false);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const projects = useCanvasStore((state) => state.projects);
    const folders = useCanvasStore((state) => state.folders);
    const createProject = useCanvasStore((state) => state.createProject);
    const importProject = useCanvasStore((state) => state.importProject);
    const createFolder = useCanvasStore((state) => state.createFolder);
    const renameFolder = useCanvasStore((state) => state.renameFolder);
    const deleteFolders = useCanvasStore((state) => state.deleteFolders);
    const moveProject = useCanvasStore((state) => state.moveProject);
    const moveFolder = useCanvasStore((state) => state.moveFolder);
    const cleanupImages = useAssetStore((state) => state.cleanupImages);
    const selectedIds = useCanvasUiStore((state) => state.selectedProjectIds);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
    const removeSelectedIds = useCanvasUiStore((state) => state.removeSelectedProjectIds);
    const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
    const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
    const [draggedItem, setDraggedItem] = useState<CanvasDragItem | null>(null);
    const [dropTargetId, setDropTargetId] = useState<string | null>(null);
    const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
    const [editingFolderTitle, setEditingFolderTitle] = useState("");

    const mode = searchParams.get("mode");
    const agentMode = mode === "new" || mode === "recent" || mode === "choose";
    const agentQuery = agentMode ? `?${searchParams.toString()}` : "";
    const enterProject = (id: string) => {
        const agentHash = hasAgentUrlBootstrap(window.location.hash) ? window.location.hash : "";
        navigate(`/canvas/${id}${agentQuery}${agentHash}`, { replace: Boolean(agentHash) });
    };
    const currentFolder = folders.find((folder) => folder.id === currentFolderId) || null;
    const visibleFolders = useMemo(() => folders.filter((folder) => folder.parentId === currentFolderId), [currentFolderId, folders]);
    const visibleProjects = useMemo(() => projects.filter((project) => (project.folderId ?? null) === currentFolderId), [currentFolderId, projects]);
    const visibleSelectedIds = useMemo(() => selectedIds.filter((id) => visibleProjects.some((project) => project.id === id)), [selectedIds, visibleProjects]);
    const folderPath = useMemo(() => buildFolderPath(folders, currentFolderId), [currentFolderId, folders]);
    const createAndEnter = () => enterProject(createProject(t("canvas.defaultTitle", { count: projects.length + 1 }), currentFolderId));
    const createFolderAndEdit = () => {
        const id = createFolder(t("canvas.folder.untitled"), currentFolderId);
        setSelectedFolderId(id);
        setEditingFolderId(id);
        setEditingFolderTitle(t("canvas.folder.untitled"));
    };
    const startFolderDrag = (event: DragEvent<HTMLElement>, item: CanvasDragItem) => {
        const payload = JSON.stringify(item);
        event.dataTransfer.setData(CANVAS_DRAG_TYPE, payload);
        event.dataTransfer.setData("text/plain", payload);
        event.dataTransfer.effectAllowed = "move";
        setDraggedItem(item);
        setDropTargetId(null);
    };
    const readDraggedItem = (event: DragEvent<HTMLElement>) => {
        const value = event.dataTransfer.getData(CANVAS_DRAG_TYPE) || event.dataTransfer.getData("text/plain");
        if (!value) return draggedItem;
        try {
            const item = JSON.parse(value) as CanvasDragItem;
            return item.type && item.id ? item : null;
        } catch {
            return null;
        }
    };
    const moveDraggedItem = (event: DragEvent<HTMLElement>, targetFolderId: string | null) => {
        event.preventDefault();
        const item = readDraggedItem(event);
        if (!item) return;
        if (item.type === "project") moveProject(item.id, targetFolderId);
        else moveFolder(item.id, targetFolderId);
        setDraggedItem(null);
        setDropTargetId(null);
    };
    const deleteFolder = (folder: CanvasFolder) => {
        Modal.confirm({
            title: t("canvas.folder.deleteTitle"),
            content: t("canvas.folder.deleteDescription", { name: folder.title }),
            okText: t("common.delete"),
            cancelText: t("common.cancel"),
            okButtonProps: { danger: true },
            onOk: () => {
                const removedProjectIds = deleteFolders([folder.id]);
                cleanupImages();
                removeSelectedIds(removedProjectIds);
                if (currentFolderId === folder.id || (currentFolderId && isFolderDescendant(folders, folder.id, currentFolderId))) setCurrentFolderId(folder.parentId);
                setSelectedFolderId(null);
            },
        });
    };
    const saveFolderTitle = () => {
        if (editingFolderId) renameFolder(editingFolderId, editingFolderTitle);
        setEditingFolderId(null);
    };
    const importCanvas = async (file?: File) => {
        if (!file) return;
        try {
            const zip = await readZip(file);
            const projectFile = zip.get("projects.json");
            if (!projectFile) throw new Error("missing projects.json");
            const data = JSON.parse(await projectFile.text()) as CanvasExportFile;
            await Promise.all(
                data.projects.flatMap((project) =>
                    project.files.map(async (item) => {
                        const blob = zip.get(item.path);
                        if (!blob) return;
                        const typedBlob = blob.type ? blob : blob.slice(0, blob.size, item.mimeType);
                        await (item.storageKey.startsWith("image:") ? setImageBlob(item.storageKey, typedBlob) : setMediaBlob(item.storageKey, typedBlob));
                    }),
                ),
            );
            data.projects.forEach((item) => importProject(item.project, currentFolderId));
            message.success(t("canvas.imported", { count: data.projects.length }));
        } catch {
            message.error(t("canvas.importFailed"));
        } finally {
            if (inputRef.current) inputRef.current.value = "";
        }
    };

    useEffect(() => {
        if (!hydrated || autoOpenRef.current || (mode !== "new" && mode !== "recent")) return;
        autoOpenRef.current = true;
        enterProject(mode === "new" ? createProject(t("canvas.defaultTitle", { count: projects.length + 1 })) : projects[0]?.id || createProject(t("canvas.defaultTitle", { count: projects.length + 1 })));
    }, [createProject, hydrated, mode, projects, t]);

    useEffect(() => {
        if (currentFolderId && !currentFolder) setCurrentFolderId(null);
    }, [currentFolder, currentFolderId]);

    if (hydrated && (mode === "new" || mode === "recent")) return <main className="flex h-full items-center justify-center bg-background text-sm text-stone-500">{t("canvas.opening")}</main>;

    return (
        <main className="h-full overflow-auto bg-background text-stone-950 dark:text-stone-100">
            <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10">
                <header className="flex flex-wrap items-end justify-between gap-4 border-b border-stone-200 pb-6 dark:border-stone-800">
                    <div>
                        <p className="text-xs text-stone-500">{t("canvas.library")}</p>
                        <h1 className="mt-3 text-3xl font-semibold">{currentFolder?.title || t("canvas.title")}</h1>
                        <nav className="mt-4 flex items-center gap-1 text-sm text-stone-500" aria-label={t("canvas.folder.breadcrumb")}>
                            <button type="button" className={`inline-flex items-center gap-1 rounded px-1.5 py-1 transition hover:bg-black/5 dark:hover:bg-white/10 ${dropTargetId === "root" ? "bg-sky-500/10 text-sky-600 dark:text-sky-400" : ""}`} onClick={() => setCurrentFolderId(null)} onDragOver={(event) => { if (draggedItem) { event.preventDefault(); setDropTargetId("root"); } }} onDrop={(event) => moveDraggedItem(event, null)}>
                                <Home className="size-3.5" />
                                {t("canvas.folder.root")}
                            </button>
                            {folderPath.map((folder) => (
                                <span key={folder.id} className="inline-flex items-center gap-1">
                                    <ChevronRight className="size-3.5" />
                                    <button type="button" className={`rounded px-1.5 py-1 transition hover:bg-black/5 dark:hover:bg-white/10 ${dropTargetId === folder.id ? "bg-sky-500/10 text-sky-600 dark:text-sky-400" : ""}`} onClick={() => setCurrentFolderId(folder.id)} onDragOver={(event) => { if (draggedItem) { event.preventDefault(); setDropTargetId(folder.id); } }} onDrop={(event) => moveDraggedItem(event, folder.id)}>{folder.title}</button>
                                </span>
                            ))}
                        </nav>
                    </div>
                    <div className="flex items-center gap-2">
                        {visibleSelectedIds.length ? (
                            <>
                                <Button disabled={!hydrated} icon={<Download className="size-4" />} onClick={() => void exportCanvasProjects(visibleProjects.filter((project) => visibleSelectedIds.includes(project.id)), `${t("canvas.title")}-${visibleSelectedIds.length}`)}>
                                    {t("canvas.exportSelected")}
                                </Button>
                                <Button disabled={!hydrated} onClick={() => setDeleteIds(visibleSelectedIds)}>
                                    {t("canvas.deleteSelected")}
                                </Button>
                            </>
                        ) : null}
                        {visibleProjects.length ? (
                            <Button disabled={!hydrated} onClick={() => setDeleteIds(visibleProjects.map((project) => project.id))}>
                                {t("canvas.deleteAll")}
                            </Button>
                        ) : null}
                        <Button disabled={!hydrated} icon={<FolderPlus className="size-4" />} onClick={createFolderAndEdit}>
                            {t("canvas.folder.create")}
                        </Button>
                        <Button disabled={!hydrated} icon={<FileUp className="size-4" />} onClick={() => inputRef.current?.click()}>
                            {t("canvas.import")}
                        </Button>
                        <Button disabled={!hydrated} type="primary" icon={<Plus className="size-4" />} onClick={createAndEnter}>
                            {t("canvas.create")}
                        </Button>
                    </div>
                </header>

                {!hydrated ? (
                    <section className="flex min-h-[360px] items-center justify-center border-y border-stone-200 text-sm text-stone-500 dark:border-stone-800">{t("canvas.loading")}</section>
                ) : visibleFolders.length || visibleProjects.length ? (
                    <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3" onDragOver={(event) => { if (event.target === event.currentTarget && draggedItem) { event.preventDefault(); setDropTargetId(currentFolderId || "root"); } }} onDrop={(event) => moveDraggedItem(event, currentFolderId)}>
                        {visibleFolders.map((folder) => (
                            <CanvasFolderCard
                                key={folder.id}
                                folder={folder}
                                itemCount={folders.filter((item) => item.parentId === folder.id).length + projects.filter((project) => (project.folderId ?? null) === folder.id).length}
                                selected={selectedFolderId === folder.id}
                                dropTarget={dropTargetId === folder.id}
                                onSelect={() => setSelectedFolderId(folder.id)}
                                onOpen={() => setCurrentFolderId(folder.id)}
                                onDragOver={(event) => { if (draggedItem) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropTargetId(folder.id); } }}
                                onDrop={(event) => moveDraggedItem(event, folder.id)}
                                onDragStart={(event) => startFolderDrag(event, { type: "folder", id: folder.id })}
                                onDragEnd={() => { setDraggedItem(null); setDropTargetId(null); }}
                                editing={editingFolderId === folder.id}
                                editingTitle={editingFolderTitle}
                                onStartEditing={() => { setEditingFolderId(folder.id); setEditingFolderTitle(folder.title); }}
                                onEditingTitleChange={setEditingFolderTitle}
                                onSave={saveFolderTitle}
                                onCancel={() => setEditingFolderId(null)}
                                onDelete={() => deleteFolder(folder)}
                            />
                        ))}
                        {visibleProjects.map((project) => (
                            <CanvasProjectCard key={project.id} project={project} onDragStart={(event, item) => startFolderDrag(event, { type: "project", id: item.id })} onDragEnd={() => { setDraggedItem(null); setDropTargetId(null); }} />
                        ))}
                    </div>
                ) : (
                    <section className="flex min-h-[360px] flex-col items-center justify-center border-y border-stone-200 text-center dark:border-stone-800">
                        <h2 className="text-xl font-medium">{t("canvas.empty")}</h2>
                        <p className="mt-3 text-sm text-stone-500">{t("canvas.emptyDescription")}</p>
                        <Button type="primary" className="mt-6" icon={<Plus className="size-4" />} onClick={createAndEnter}>
                            {t("canvas.create")}
                        </Button>
                    </section>
                )}
            </div>

            <input ref={inputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importCanvas(event.target.files?.[0])} />
            <CanvasDeleteProjectsDialog />
        </main>
    );
}

function buildFolderPath(folders: CanvasFolder[], currentFolderId: string | null) {
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    const path: CanvasFolder[] = [];
    const visited = new Set<string>();
    let id = currentFolderId;
    while (id && !visited.has(id)) {
        visited.add(id);
        const folder = byId.get(id);
        if (!folder) break;
        path.unshift(folder);
        id = folder.parentId;
    }
    return path;
}

function isFolderDescendant(folders: CanvasFolder[], ancestorId: string, candidateId: string) {
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    let current = byId.get(candidateId)?.parentId || null;
    while (current) {
        if (current === ancestorId) return true;
        current = byId.get(current)?.parentId || null;
    }
    return false;
}
