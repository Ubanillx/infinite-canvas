import { BookOpen, CheckSquare, ClipboardPaste, Download, FolderPlus, History, ImagePlus, LoaderCircle, PenLine, Plus, SlidersHorizontal, Sparkles, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { App, Button, Checkbox, ConfigProvider, Drawer, Image, Input, Modal, Tag, Tooltip, Typography } from "antd";
import localforage from "localforage";
import { saveAs } from "file-saver";
import { useTranslation } from "react-i18next";

import { ReferenceOrderButtons } from "@/components/workbench/reference-order-buttons";
import { moveListItem } from "@/lib/utils";
import { ImageSettingsPanel, imageQualityLabel, imageSizeLabel } from "@/components/image-settings-panel";
import { ModelPicker } from "@/components/model-picker";
import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { canvasThemes } from "@/lib/canvas-theme";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { modelOptionLabel, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { nanoid } from "nanoid";
import { formatDuration } from "@/lib/image-utils";
import { requestEdit, requestGeneration } from "@/services/api/image";
import { deleteStoredImages, getImageBlob, ensureImagePreview, getImagePreviewRevision, previewUrlFor, resolveImageUrl, subscribeImagePreviews, uploadImage } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
import type { ReferenceImage } from "@/types/image";
import i18n from "@/i18n";
import { workspaceStoreName } from "@/lib/workspace";
import { saveWorkspaceData } from "@/services/workspace-data";
import { readWorkspaceLogs } from "@/services/workspace-logs";

type GeneratedImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    durationMs: number;
    width: number;
    height: number;
    bytes: number;
    mimeType?: string;
};

type GenerationResult = {
    id: string;
    status: "pending" | "success" | "failed";
    image?: GeneratedImage;
    error?: string;
};

type GenerationLog = {
    id: string;
    createdAt: number;
    title: string;
    prompt: string;
    time: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    imageCount: number;
    size: string;
    quality: string;
    status: "success" | "failed";
    images: GeneratedImage[];
};

type GenerationLogConfig = Pick<AiConfig, "model" | "imageModel" | "quality" | "size" | "count">;

type UpdateAiConfig = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;

const LOG_STORE_KEY = "infinite-canvas:image_generation_logs";
const logStore = localforage.createInstance({ name: "infinite-canvas", storeName: workspaceStoreName("image_generation_logs") });

export default function ImagePage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const dragDepthRef = useRef(0);
    const composerRef = useRef<HTMLElement>(null);
    const composerDragRef = useRef<{ y: number; height: number } | null>(null);
    const composerMinHeightRef = useRef<number | null>(null);
    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const addAsset = useAssetStore((state) => state.addAsset);
    const [prompt, setPrompt] = useState("");
    const [references, setReferences] = useState<ReferenceImage[]>([]);
    const [results, setResults] = useState<GenerationResult[]>([]);
    const [logs, setLogs] = useState<GenerationLog[]>([]);
    const [running, setRunning] = useState(false);
    const [logsOpen, setLogsOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [selectedResultIndex, setSelectedResultIndex] = useState(0);
    const [promptDialogOpen, setPromptDialogOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [startedAt, setStartedAt] = useState(0);
    const [elapsedMs, setElapsedMs] = useState(0);
    const [selectedLogIds, setSelectedLogIds] = useState<string[]>([]);
    const [previewLog, setPreviewLog] = useState<GenerationLog | null>(null);
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [isReferenceDragActive, setIsReferenceDragActive] = useState(false);
    const [composerHeight, setComposerHeight] = useState<number | null>(null);
    const [autoRunToken, setAutoRunToken] = useState(0);
    const imageCommand = useWorkbenchAgentStore((state) => state.imageCommand);
    const clearImageCommand = useWorkbenchAgentStore((state) => state.clearImageCommand);
    const updateAgentTask = useWorkbenchAgentStore((state) => state.updateTask);
    const processedCommandRef = useRef(0);
    const agentTaskIdRef = useRef<string | undefined>(undefined);

    const model = effectiveConfig.imageModel || effectiveConfig.model;
    const canGenerate = Boolean(prompt.trim());
    const generationCount = Math.max(1, Math.min(10, Number(config.count) || 1));
    const configSummary = `${modelOptionLabel(effectiveConfig, model)} · ${imageSizeLabel(effectiveConfig.size)} · ${imageQualityLabel(effectiveConfig.quality)} · ${generationCount}`;

    useEffect(() => {
        if (!running || !startedAt) return;
        const timer = window.setInterval(() => setElapsedMs(performance.now() - startedAt), 1000);
        return () => window.clearInterval(timer);
    }, [running, startedAt]);

    useEffect(() => {
        void refreshLogs();
    }, []);

    const addReferences = async (files?: FileList | null) => {
        try {
            const imageFiles = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
            const nextReferences = await Promise.all(
                imageFiles.map(async (file) => {
                    const image = await uploadImage(file);
                    return { id: nanoid(), name: file.name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
                }),
            );
            setReferences((value) => [...value, ...nextReferences]);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "媒体保存失败");
        }
    };

    const addReferencesFromClipboard = async () => {
        try {
            const items = await navigator.clipboard.read();
            const blobs = await Promise.all(items.flatMap((item) => item.types.filter((type) => type.startsWith("image/")).map((type) => item.getType(type))));
            if (!blobs.length) {
                message.error(t("imageWorkbench.clipboardEmpty"));
                return;
            }
            const nextReferences = await Promise.all(
                blobs.map(async (blob, index) => {
                    const image = await uploadImage(blob);
                    return { id: nanoid(), name: `clipboard-${index + 1}.png`, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
                }),
            );
            setReferences((value) => [...value, ...nextReferences]);
            message.success(t("imageWorkbench.clipboardAdded", { count: nextReferences.length }));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("imageWorkbench.clipboardEmpty"));
        }
    };

    const generate = async () => {
        const agentTaskId = agentTaskIdRef.current;
        agentTaskIdRef.current = undefined;
        const text = prompt.trim();
        if (!text) {
            message.error(t("imageWorkbench.promptRequired"));
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t("imageWorkbench.promptRequired") });
            return;
        }
        if (!isAiConfigReady(effectiveConfig, model)) {
            message.warning(t("workbench.configFirst"));
            openConfigDialog(true);
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t("imageWorkbench.configIncomplete") });
            return;
        }

        const snapshot = buildRequestSnapshot();
        if (!snapshot) {
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t("imageWorkbench.invalidParams") });
            return;
        }

        setElapsedMs(0);
        setRunning(true);
        if (agentTaskId) updateAgentTask(agentTaskId, { status: "running", error: undefined });
        setPreviewLog(null);
        setResults(Array.from({ length: generationCount }, () => ({ id: nanoid(), status: "pending" })));
        setSelectedResultIndex(0);
        const batchStartedAt = performance.now();
        setStartedAt(batchStartedAt);

        const tasks = Array.from({ length: generationCount }, (_, index) => runGenerationSlot(index, snapshot));

        const result = await Promise.allSettled(tasks);
        const successImages = result.filter((item): item is PromiseFulfilledResult<GeneratedImage> => item.status === "fulfilled").map((item) => item.value);
        const successCount = successImages.length;
        const failCount = generationCount - successCount;
        const failed = result.find((item): item is PromiseRejectedResult => item.status === "rejected");
        const error = failed?.reason instanceof Error ? failed.reason.message : failCount ? t("workbench.generationFailed") : undefined;
        if (agentTaskId) updateAgentTask(agentTaskId, { status: successCount ? "succeeded" : "failed", successCount, failCount, error: successCount ? undefined : error });

        try {
            saveLog(
                buildLog({
                    prompt: text,
                    model,
                    config: { ...snapshot.config, count: String(generationCount) },
                    references: snapshot.references,
                    durationMs: performance.now() - batchStartedAt,
                    successCount,
                    failCount,
                    status: successCount ? "success" : "failed",
                    images: successImages,
                }),
            );
            successCount ? message.success(t("imageWorkbench.generated")) : message.error(failed?.reason instanceof Error ? failed.reason.message : t("workbench.generationFailed"));
        } finally {
            setRunning(false);
        }
    };

    // Handle image-generation commands from the Agent panel by setting the prompt and optionally starting generation.
    useEffect(() => {
        if (!imageCommand || imageCommand.nonce === processedCommandRef.current) return;
        processedCommandRef.current = imageCommand.nonce;
        clearImageCommand();
        if (typeof imageCommand.prompt === "string") setPrompt(imageCommand.prompt);
        if (imageCommand.run && running) {
            if (imageCommand.taskId) updateAgentTask(imageCommand.taskId, { status: "failed", error: t("imageWorkbench.busy") });
            return;
        }
        if (imageCommand.run) {
            agentTaskIdRef.current = imageCommand.taskId;
            setAutoRunToken((value) => value + 1);
        }
    }, [imageCommand, clearImageCommand, running, updateAgentTask]);

    useEffect(() => {
        if (!autoRunToken) return;
        void generate();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoRunToken]);

    const downloadImage = (image: GeneratedImage, index: number) => {
        saveAs(image.dataUrl, `image-${index + 1}.png`);
    };

    const addResultToReferences = async (image: GeneratedImage, index: number) => {
        const stored = await uploadImage(image.dataUrl);
        setReferences((value) => [...value, { id: nanoid(), name: `result-${index + 1}.png`, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }]);
        message.success(t("imageWorkbench.addedReference"));
    };

    const saveResultToAssets = async (image: GeneratedImage, index: number) => {
        try {
            const blob = image.storageKey ? await getImageBlob(image.storageKey) : null;
            const stored = blob && image.storageKey
                ? { url: await resolveImageUrl(image.storageKey, image.dataUrl), storageKey: image.storageKey, width: image.width, height: image.height, bytes: blob.size, mimeType: image.mimeType || blob.type || "image/png" }
                : await uploadImage(image.dataUrl);
            addAsset({
                kind: "image",
                title: t("imageWorkbench.resultTitle", { count: index + 1 }),
                coverUrl: stored.url,
                tags: [],
                source: t("imageWorkbench.source"),
                data: { dataUrl: stored.url, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType },
                metadata: { source: "image-page", prompt },
            });
            message.success(t("common.addedToAssets"));
        } catch {
            message.error(t("assets.addFailed"));
        }
    };

    const insertPickedAsset = async (payload: InsertAssetPayload) => {
        if (payload.kind === "text") {
            setPrompt(payload.content);
        } else if (payload.kind === "image") {
            const stored = await uploadImage(payload.dataUrl);
            setReferences((value) => [...value, { id: nanoid(), name: payload.title, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }]);
        } else {
            message.warning(t("imageWorkbench.unsupportedAsset"));
        }
        setAssetPickerOpen(false);
    };

    const createSession = () => {
        setLogsOpen(false);
        setPrompt("");
        setReferences([]);
        setResults([]);
        setSelectedResultIndex(0);
        setElapsedMs(0);
        setStartedAt(0);
        setSelectedLogIds([]);
        setPreviewLog(null);
    };

    const deleteSelectedLogs = () => {
        const imageKeys = logs.filter((log) => selectedLogIds.includes(log.id)).flatMap((log) => log.images.map((image) => image.storageKey).filter((key): key is string => Boolean(key)));
        void Promise.all([deleteStoredImages(imageKeys), ...selectedLogIds.map((id) => logStore.removeItem(id))]).then(async () => { const next = await refreshLogs(false); await saveWorkspaceData("image-workbench", { logs: next.map(serializeLog) }).catch(() => undefined); });
        if (previewLog && selectedLogIds.includes(previewLog.id)) {
            setPreviewLog(null);
            setResults([]);
        }
        setSelectedLogIds([]);
        setDeleteConfirmOpen(false);
    };

    const saveLog = (log: GenerationLog) => {
        void logStore.setItem(log.id, serializeLog(log)).then(async () => { const next = await refreshLogs(false); await saveWorkspaceData("image-workbench", { logs: next.map(serializeLog) }).catch(() => undefined); });
    };

    const refreshLogs = async (preferRemote = true) => {
        const next = await readStoredLogs(preferRemote);
        setLogs(next);
        return next;
    };

    const previewGenerationLog = async (log: GenerationLog) => {
        setPreviewLog(log);
        setLogsOpen(false);
        setPrompt(log.prompt);
        setReferences(log.references || []);
        if (log.config.imageModel || log.model) updateConfig("imageModel", log.config.imageModel || log.model);
        if (log.config.quality) updateConfig("quality", log.config.quality);
        if (log.config.size) updateConfig("size", log.config.size);
        if (log.config.count) updateConfig("count", log.config.count);
        setResults(log.images.map((image) => ({ id: image.id, status: "success", image })));
        setSelectedResultIndex(0);
    };

    const buildRequestSnapshot = () => {
        const text = prompt.trim();
        if (!text) {
            message.error(t("imageWorkbench.promptRequired"));
            return null;
        }
        if (!isAiConfigReady(effectiveConfig, model)) {
            message.warning(t("workbench.configFirst"));
            openConfigDialog(true);
            return null;
        }
        return { text, config: { ...effectiveConfig, model, count: "1" }, references: [...references] };
    };

    const runGenerationSlot = async (index: number, snapshot: { text: string; config: AiConfig; references: ReferenceImage[] }) => {
        const itemStartedAt = performance.now();
        try {
            const result = snapshot.references.length ? await requestEdit(snapshot.config, snapshot.text, snapshot.references) : await requestGeneration(snapshot.config, snapshot.text);
            const image = result[0];
            if (!image) throw new Error(t("imageWorkbench.missingResult"));
            const stored = await uploadImage(image.dataUrl);
            const nextImage: GeneratedImage = { id: image.id, dataUrl: stored.url, ...(stored.storageKey ? { storageKey: stored.storageKey } : {}), durationMs: performance.now() - itemStartedAt, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType };
            setResults((value) => updateResultAt(value, index, { status: "success", image: nextImage }));
            return nextImage;
        } catch (error) {
            setResults((value) => updateResultAt(value, index, { status: "failed", error: error instanceof Error ? error.message : t("workbench.generationFailed") }));
            throw error;
        }
    };

    const retryResult = async (index: number) => {
        const snapshot = buildRequestSnapshot();
        if (!snapshot) return;
        setPreviewLog(null);
        setResults((value) => updateResultAt(value, index, { status: "pending", error: undefined, image: undefined }));
        const retryStartedAt = performance.now();
        try {
            const image = await runGenerationSlot(index, snapshot);
            saveLog(
                buildLog({
                    prompt: snapshot.text,
                    model,
                    config: { ...snapshot.config, count: "1" },
                    references: snapshot.references,
                    durationMs: performance.now() - retryStartedAt,
                    successCount: 1,
                    failCount: 0,
                    status: "success",
                    images: [image],
                }),
            );
            message.success(t("workbench.retrySuccess"));
        } catch {
            // runGenerationSlot has already marked the result as failed.
        }
    };

    const selectedResult = results[selectedResultIndex] || results[0];

    const resizeComposer = (height: number) => {
        const minimum = composerMinHeightRef.current ?? composerRef.current?.getBoundingClientRect().height ?? 0;
        const maximum = composerRef.current?.parentElement?.clientHeight ?? window.innerHeight;
        setComposerHeight(Math.max(minimum, Math.min(maximum, height)));
    };

    return (
        <ConfigProvider wave={{ disabled: true }} theme={{ components: { Button: { defaultShadow: "none", primaryShadow: "none", dangerShadow: "none" } } }}>
            <div className={`flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground transition-[margin-right] duration-300 [&_.ant-btn]:!shadow-none ${settingsOpen || logsOpen ? "lg:mr-[420px]" : ""}`}>
                <main className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-3 lg:px-6">
                    <div className="flex min-h-full w-full flex-col gap-3">
                        <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                            <h1 className="text-xl font-semibold">{t("imageWorkbench.title")}</h1>
                            <p className="text-xs text-muted-foreground">{t("imageWorkbench.galleryHint")}</p>
                        </header>

                        <section aria-label={t("workbench.logs")}>
                            <div className="mb-1 flex items-center justify-between gap-3">
                                <h2 className="text-base font-semibold">{t("workbench.logs")} <span className="ml-1 font-normal text-muted-foreground">{logs.length}</span></h2>
                                <Button type="text" icon={<History className="size-4" />} onClick={() => { setSettingsOpen(false); setLogsOpen(true); }}>{t("imageWorkbench.manageLogs")}</Button>
                            </div>
                            <div className="thin-scrollbar flex gap-2.5 overflow-x-auto pb-1">
                                <Button icon={<Plus className="size-4" />} onClick={createSession} className="!h-9 !shrink-0 !gap-2 !rounded-lg !border-border !px-3 !text-sm !font-medium !text-foreground hover:!border-input hover:!bg-muted/40">{t("imageWorkbench.newCreation")}</Button>
                                {logs.map((log) => (
                                    <button key={log.id} type="button" onClick={() => void previewGenerationLog(log)} className={`flex h-16 w-56 shrink-0 items-center gap-2.5 rounded-lg border p-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring ${previewLog?.id === log.id ? "border-border bg-muted/70" : "border-border bg-card hover:bg-muted/40"}`}>
                                        {log.images[0] ? <img src={previewUrlFor(log.images[0].storageKey) || log.images[0].dataUrl} alt="" className="h-full w-16 shrink-0 rounded-md object-cover" /> : <div className="flex h-full w-16 shrink-0 items-center justify-center rounded-md bg-muted"><ImagePlus className="size-5 text-muted-foreground" /></div>}
                                        <span className="min-w-0"><span className="line-clamp-2 block text-sm font-medium">{log.title}</span><span className="mt-1 block truncate text-xs text-muted-foreground">{log.time} · {t("workbench.itemCount", { count: log.imageCount })}</span></span>
                                    </button>
                                ))}
                                {!logs.length ? <div className="flex h-9 items-center px-2 text-sm text-muted-foreground">{t("workbench.noLogs")}</div> : null}
                            </div>
                        </section>

                        <div className={`grid min-h-[280px] min-w-0 flex-1 gap-4 ${settingsOpen || logsOpen ? "lg:grid-cols-[280px_minmax(0,1fr)]" : "lg:grid-cols-[340px_minmax(0,1fr)]"}`}>
                        <section className="flex min-w-0 flex-col" aria-label={t("imageWorkbench.references")}>
                            <div className="mb-2 flex h-8 items-center justify-between gap-1"><h2 className="text-base font-semibold">{t("imageWorkbench.references")}</h2><Tooltip title={t("workbench.clipboard")}><Button type="text" icon={<ClipboardPaste className="size-4" />} aria-label={t("workbench.clipboard")} onClick={() => void addReferencesFromClipboard()} /></Tooltip></div>
                            <div className={`flex min-h-[280px] flex-1 flex-wrap content-start gap-2 rounded-lg border p-2 transition-colors ${isReferenceDragActive ? "border-input bg-muted/40" : "border-border bg-card"}`} onDragEnter={(event) => { event.preventDefault(); dragDepthRef.current += 1; if (event.dataTransfer.types.includes("Files")) setIsReferenceDragActive(true); }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }} onDragLeave={(event) => { event.preventDefault(); dragDepthRef.current = Math.max(0, dragDepthRef.current - 1); if (!dragDepthRef.current) setIsReferenceDragActive(false); }} onDrop={(event) => { event.preventDefault(); dragDepthRef.current = 0; setIsReferenceDragActive(false); void addReferences(event.dataTransfer.files); }}>
                                <button type="button" onClick={() => fileInputRef.current?.click()} className="flex h-10 w-full items-center justify-center gap-2 rounded-md border border-border bg-muted/30 text-sm transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring"><Upload className="size-4" />{t("workbench.upload")}</button>
                                {references.map((item, index) => <div key={item.id} className="group relative size-20 shrink-0 overflow-hidden rounded-md"><Image src={previewUrlFor(item.storageKey) || item.dataUrl} preview={{ src: item.dataUrl }} alt={item.name} width={80} height={80} style={{ objectFit: "cover" }} /><span className="pointer-events-none absolute left-1 top-1 rounded border border-border bg-card/90 px-1 text-[10px] text-foreground">{imageReferenceLabel(index)}</span><ReferenceOrderButtons index={index} total={references.length} flat onMove={(offset) => setReferences((value) => moveListItem(value, index, offset))} /><button type="button" aria-label={t("imageWorkbench.removeReference")} onClick={() => setReferences((value) => value.filter((ref) => ref.id !== item.id))} className="absolute right-1 top-1 flex size-6 items-center justify-center rounded border border-border bg-card/90 text-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"><Trash2 className="size-3.5" /></button></div>)}
                                {isReferenceDragActive ? <span className="w-full text-center text-xs text-muted-foreground">{t("imageWorkbench.dropReferences")}</span> : null}
                            </div>
                        </section>
                        <section className="flex min-w-0 flex-col" aria-label={t("workbench.results")}>
                            <div className="mb-2 flex h-8 items-center justify-between gap-3">
                                <h2 className="text-base font-semibold">{t("workbench.results")}</h2>
                                {running ? <Tag className="m-0">{t("workbench.waiting", { time: formatDuration(elapsedMs) })}</Tag> : null}
                            </div>
                            {selectedResult ? (
                                <>
                                    <div className={`grid min-h-[280px] flex-1 gap-3 ${results.length > 1 && !settingsOpen && !logsOpen ? "lg:grid-cols-[minmax(0,1fr)_180px] xl:grid-cols-[minmax(0,1fr)_220px]" : ""}`}>
                                        <div className="flex h-full min-h-[280px] items-center justify-center overflow-hidden rounded-lg border border-border bg-card">
                                            {selectedResult.status === "success" && selectedResult.image ? (
                                                <Image src={previewUrlFor(selectedResult.image.storageKey) || selectedResult.image.dataUrl} preview={{ src: selectedResult.image.dataUrl }} alt={t("imageWorkbench.resultAlt", { count: selectedResultIndex + 1 })} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
                                            ) : selectedResult.status === "failed" ? (
                                                <div className="flex max-w-sm flex-col items-center gap-3 px-5 text-center"><span className="font-medium">{t("workbench.failed")}</span><Typography.Paragraph ellipsis={{ rows: 4 }} className="!mb-0 !text-muted-foreground">{selectedResult.error}</Typography.Paragraph><Button onClick={() => void retryResult(selectedResultIndex)}>{t("workbench.retry")}</Button></div>
                                            ) : (
                                                <div className="flex flex-col items-center gap-3 text-muted-foreground"><LoaderCircle className="size-8 animate-spin" />{t("workbench.generating")}</div>
                                            )}
                                        </div>
                                        {results.length > 1 ? <div className={`thin-scrollbar flex gap-2 overflow-x-auto ${settingsOpen || logsOpen ? "" : "lg:max-h-[min(40vh,480px)] lg:flex-col lg:overflow-y-auto lg:overflow-x-hidden"}`}>
                                            {results.map((result, index) => index === selectedResultIndex ? null : <button key={result.id} type="button" onClick={() => setSelectedResultIndex(index)} className={`flex h-28 w-36 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-card transition-colors hover:border-input focus-visible:outline-2 focus-visible:outline-ring ${settingsOpen || logsOpen ? "" : "lg:h-36 lg:w-full"}`} aria-label={t("imageWorkbench.resultAlt", { count: index + 1 })}>
                                                {result.status === "success" && result.image ? <img src={previewUrlFor(result.image.storageKey) || result.image.dataUrl} alt="" className="size-full object-cover" /> : result.status === "failed" ? <span className="px-3 text-sm text-muted-foreground">{t("workbench.failed")}</span> : <LoaderCircle className="size-5 animate-spin text-muted-foreground" />}
                                            </button>)}
                                        </div> : null}
                                    </div>
                                    {selectedResult.status === "success" && selectedResult.image ? <div className="mt-3 flex flex-wrap gap-2">
                                        <Button size="large" icon={<Download className="size-4" />} onClick={() => downloadImage(selectedResult.image!, selectedResultIndex)}>{t("imageWorkbench.downloadOriginal")}</Button>
                                        <Button size="large" icon={<FolderPlus className="size-4" />} onClick={() => void saveResultToAssets(selectedResult.image!, selectedResultIndex)}>{t("common.addToAssets")}</Button>
                                        <Button size="large" icon={<PenLine className="size-4" />} onClick={() => void addResultToReferences(selectedResult.image!, selectedResultIndex)}>{t("imageWorkbench.addReference")}</Button>
                                        <Button size="large" type="primary" icon={<Sparkles className="size-4" />} loading={running} disabled={!canGenerate || running} onClick={() => void generate()}>{t("imageWorkbench.regenerate")}</Button>
                                    </div> : null}
                                </>
                            ) : (
                                <div className="flex min-h-[280px] flex-1 flex-col items-center justify-center rounded-lg border border-border bg-card px-6 text-center">
                                    <ImagePlus className="mb-3 size-10 text-muted-foreground" />
                                    <h3 className="text-base font-medium">{t("imageWorkbench.empty")}</h3>
                                    <p className="mt-1 text-sm text-muted-foreground">{t("imageWorkbench.emptyHint")}</p>
                                </div>
                            )}
                        </section>
                        </div>
                    </div>
                </main>
                <section ref={composerRef} style={{ height: composerHeight ?? undefined }} className="thin-scrollbar relative shrink-0 overflow-y-auto border-t border-border bg-card px-4 py-3 lg:px-6" aria-label={t("imageWorkbench.creationArea")}>
                    <div role="separator" tabIndex={0} aria-orientation="horizontal" aria-label={t("imageWorkbench.resizePrompt")} title={t("imageWorkbench.resizePrompt")} className="absolute inset-x-0 top-0 z-10 h-2 cursor-ns-resize touch-none focus-visible:outline-2 focus-visible:outline-ring" onPointerDown={(event) => { const height = composerRef.current?.getBoundingClientRect().height ?? 0; composerMinHeightRef.current ??= height; composerDragRef.current = { y: event.clientY, height }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => { if (composerDragRef.current) resizeComposer(composerDragRef.current.height + composerDragRef.current.y - event.clientY); }} onPointerUp={(event) => { composerDragRef.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { composerDragRef.current = null; }} onKeyDown={(event) => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); composerMinHeightRef.current ??= composerRef.current?.getBoundingClientRect().height ?? 0; resizeComposer((composerRef.current?.getBoundingClientRect().height ?? 0) + (event.key === "ArrowUp" ? 24 : -24)); } }} />
                    <div className="flex h-full min-h-[128px] w-full flex-col">
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                            <div className="flex min-w-0 items-center gap-3">
                                <label htmlFor="image-prompt" className="text-sm font-semibold">{t("imageWorkbench.describe")}</label>
                                <div className="flex items-center gap-1 border-l border-border pl-2">
                                    <Tooltip title={t("workbench.viewPrompts")}><Button type="text" className="!size-8 !rounded-md !text-muted-foreground hover:!bg-muted/50 hover:!text-foreground" icon={<BookOpen className="size-4" />} aria-label={t("workbench.viewPrompts")} onClick={() => setPromptDialogOpen(true)} /></Tooltip>
                                    <Tooltip title={t("workbench.viewAssets")}><Button type="text" className="!size-8 !rounded-md !text-muted-foreground hover:!bg-muted/50 hover:!text-foreground" icon={<FolderPlus className="size-4" />} aria-label={t("workbench.viewAssets")} onClick={() => setAssetPickerOpen(true)} /></Tooltip>
                                </div>
                            </div>
                            <div className="flex min-w-0 items-center gap-2">
                                <span className="mr-1 hidden min-w-0 max-w-80 truncate text-xs text-muted-foreground sm:block">{configSummary}</span>
                                <Button type="text" aria-pressed={settingsOpen} className={`!h-9 !gap-2 !rounded-lg !px-3 !text-sm !text-muted-foreground hover:!bg-muted/50 hover:!text-foreground ${settingsOpen ? "!bg-muted/50" : ""}`} icon={<SlidersHorizontal className="size-4" />} onClick={() => { setLogsOpen(false); setSettingsOpen(true); }}>{t("workbench.settings")}</Button>
                                <Button type="primary" className="!h-9 !min-w-28 !gap-2 !rounded-lg !px-4 !text-sm !font-medium disabled:!border-transparent disabled:!bg-muted/60 disabled:!text-muted-foreground/50" icon={<Sparkles className="size-4" />} loading={running} disabled={!canGenerate || running} onClick={() => void generate()}>{t("workbench.generate")}{generationCount > 1 ? ` (${generationCount})` : ""}</Button>
                            </div>
                        </div>
                        <Input.TextArea id="image-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={4} placeholder={t("imageWorkbench.promptPlaceholder")} className="!min-h-[96px] !flex-1 !resize-none !rounded-lg !border-border !bg-muted/20 !shadow-none hover:!border-input hover:!bg-muted/30 hover:!shadow-none focus:!border-input focus:!bg-muted/40 focus:!shadow-none" />
                    </div>
                </section>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={(event) => {
                        void addReferences(event.target.files);
                        event.target.value = "";
                    }}
                />
                <Drawer title={t("workbench.logs")} extra={<span className="text-sm text-muted-foreground">{logs.length}</span>} placement="right" size="min(420px, 100vw)" mask={false} open={logsOpen} onClose={() => setLogsOpen(false)} classNames={{ body: "thin-scrollbar [&_.ant-btn]:!shadow-none" }} styles={{ wrapper: { boxShadow: "none" }, section: { borderLeft: "1px solid var(--border)" } }}>
                    <LogPanel
                        logs={logs}
                        selectedLogIds={selectedLogIds}
                        activeLogId={previewLog?.id}
                        onSelectedLogIdsChange={setSelectedLogIds}
                        onCreateSession={createSession}
                        onDeleteSelected={() => setDeleteConfirmOpen(true)}
                        onPreviewLog={(log) => void previewGenerationLog(log)}
                    />
                </Drawer>
                <Drawer title={t("imageWorkbench.generationSettings")} placement="right" size="min(420px, 100vw)" mask={false} open={settingsOpen} onClose={() => setSettingsOpen(false)} classNames={{ body: "[&_.ant-btn]:!shadow-none" }} styles={{ wrapper: { boxShadow: "none" }, section: { borderLeft: "1px solid var(--border)" } }}>
                    <GenerationSettings config={effectiveConfig} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} onClose={() => setSettingsOpen(false)} />
                </Drawer>
                <PromptSelectDialog open={promptDialogOpen} onOpenChange={setPromptDialogOpen} onSelect={setPrompt} flat />
                <AssetPickerModal open={assetPickerOpen} defaultTab="my-assets" onInsert={(payload) => void insertPickedAsset(payload)} onClose={() => setAssetPickerOpen(false)} flat />
                <Modal title={t("workbench.deleteLogs")} open={deleteConfirmOpen} onCancel={() => setDeleteConfirmOpen(false)} onOk={deleteSelectedLogs} okText={t("common.delete")} okButtonProps={{ danger: true }} cancelText={t("common.cancel")} classNames={{ footer: "[&_.ant-btn]:!shadow-none" }} styles={{ container: { boxShadow: "none", border: "1px solid var(--border)" } }}>
                    {t("workbench.deleteLogsConfirm", { count: selectedLogIds.length })}
                </Modal>
            </div>
        </ConfigProvider>
    );
}

function GenerationSettings({ config, model, updateConfig, openConfigDialog, onClose }: { config: AiConfig; model: string; updateConfig: UpdateAiConfig; openConfigDialog: (shouldPromptContinue?: boolean) => void; onClose: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();

    return (
        <div className="space-y-6 pb-4">
            <div>
                <div className="mb-2 text-sm font-semibold">{t("workbench.model")}</div>
                <ModelPicker config={config} value={model} onChange={(value) => updateConfig("imageModel", value)} capability="image" fullWidth flat onMissingConfig={() => openConfigDialog(false)} />
            </div>
            <ImageSettingsPanel config={config} onConfigChange={(key, value) => updateConfig(key, value)} theme={theme} showTitle={false} className="space-y-4" maxCount={10} subtleSelection />
            <Button block size="large" onClick={onClose}>{t("imageWorkbench.finishSettings")}</Button>
        </div>
    );
}

function updateResultAt(results: GenerationResult[], index: number, next: Partial<GenerationResult>) {
    return results.map((item, itemIndex) => (itemIndex === index ? { ...item, ...next } : item));
}

function LogPanel({
    logs,
    selectedLogIds,
    activeLogId,
    onSelectedLogIdsChange,
    onCreateSession,
    onDeleteSelected,
    onPreviewLog,
}: {
    logs: GenerationLog[];
    selectedLogIds: string[];
    activeLogId?: string;
    onSelectedLogIdsChange: (ids: string[]) => void;
    onCreateSession: () => void;
    onDeleteSelected: () => void;
    onPreviewLog: (log: GenerationLog) => void;
}) {
    const { t } = useTranslation();
    const allSelected = Boolean(logs.length) && selectedLogIds.length === logs.length;
    const toggleAll = () => onSelectedLogIdsChange(allSelected ? [] : logs.map((log) => log.id));

    return (
        <>
            <div className="mb-4 flex flex-wrap gap-2">
                <Button className="!h-9 !rounded-lg !border-border !px-3 hover:!bg-muted/40" icon={<Plus className="size-4" />} onClick={onCreateSession}>
                    {t("workbench.new")}
                </Button>
                <Button className="!h-9 !rounded-lg !border-border !px-3 hover:!bg-muted/40" icon={<CheckSquare className="size-4" />} disabled={!logs.length} onClick={toggleAll}>
                    {allSelected ? t("common.cancel") : t("workbench.selectAll")}
                </Button>
                <Button className="!h-9 !rounded-lg !px-3" danger icon={<Trash2 className="size-4" />} disabled={!selectedLogIds.length} onClick={onDeleteSelected}>
                    {t("common.delete")}
                </Button>
            </div>
            <div className="space-y-2">
                {logs.map((log) => (
                    <LogCard
                        key={log.id}
                        log={log}
                        selected={selectedLogIds.includes(log.id)}
                        active={activeLogId === log.id}
                        onSelectedChange={(checked) => onSelectedLogIdsChange(checked ? [...selectedLogIds, log.id] : selectedLogIds.filter((id) => id !== log.id))}
                        onClick={() => onPreviewLog(log)}
                    />
                ))}
                {!logs.length ? <div className="flex min-h-48 items-center justify-center rounded-lg border border-border bg-card text-center text-sm text-muted-foreground">{t("workbench.noLogs")}</div> : null}
            </div>
        </>
    );
}

function LogCard({ log, selected, active, onSelectedChange, onClick }: { log: GenerationLog; selected: boolean; active: boolean; onSelectedChange: (checked: boolean) => void; onClick: () => void }) {
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const thumbnails = log.images.filter((image) => image.dataUrl).slice(0, 4);

    return (
        <div className={`flex items-start gap-3 rounded-lg border border-border p-3 transition-colors ${active ? "bg-muted/60" : "bg-card hover:bg-muted/30"}`}>
            <Checkbox className="mt-0.5" checked={selected} onChange={(event) => onSelectedChange(event.target.checked)} />
            <button type="button" className="min-w-0 flex-1 text-left focus-visible:rounded-md focus-visible:bg-muted/40 focus-visible:outline-none" onClick={onClick}>
                <span className="block truncate text-sm font-medium">{log.title}</span>
                {thumbnails.length ? (
                    <span className="mt-2 flex gap-1 overflow-hidden">
                        {thumbnails.map((image) => (
                            <img key={image.id} src={previewUrlFor(image.storageKey) || image.dataUrl} alt="" className="size-9 shrink-0 rounded-md object-cover" />
                        ))}
                    </span>
                ) : null}
                <span className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span>{log.time}</span>
                    <span>{t("workbench.itemCount", { count: log.imageCount })}</span>
                    <span>{t("workbench.successCount", { count: log.successCount ?? log.imageCount })}</span>
                    {log.failCount ? <span>{t("workbench.failCount", { count: log.failCount })}</span> : null}
                    <span>{formatDuration(log.durationMs)}</span>
                </span>
            </button>
        </div>
    );
}

async function readStoredLogs(preferRemote = true) {
    if (typeof window === "undefined") return [];
    const values = preferRemote ? await readWorkspaceLogs<GenerationLog>("image-workbench", logStore) : await readLocalLogs();
    return (await Promise.all(values.map(normalizeLog))).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

async function readLocalLogs() {
    const logs: GenerationLog[] = [];
    await logStore.iterate<GenerationLog, void>((log) => { logs.push(log); });
    return logs;
}

async function normalizeLog(log: Partial<GenerationLog>): Promise<GenerationLog> {
    const references = await Promise.all(
        (log.references || []).map(async (item) => {
            void ensureImagePreview(item.storageKey);
            return { ...item, dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl) };
        }),
    );
    const images = await Promise.all(
        (log.images || []).map(async (item) => {
            void ensureImagePreview(item.storageKey);
            return { ...item, dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl) };
        }),
    );
    const config = normalizeLogConfig(log);
    return {
        id: log.id || nanoid(),
        createdAt: log.createdAt || Date.now(),
        title: log.title || log.model || i18n.t("workbench.untitled"),
        prompt: log.prompt || log.title || "",
        time: log.time || new Date().toLocaleString(i18n.resolvedLanguage, { hour12: false }),
        model: log.model || config.imageModel || "",
        config,
        references,
        durationMs: log.durationMs || 0,
        successCount: log.successCount ?? log.imageCount ?? 0,
        failCount: log.failCount || 0,
        imageCount: log.imageCount || log.successCount || 0,
        size: log.size || config.size || "",
        quality: log.quality || config.quality || "",
        status: log.status || "success",
        images,
    };
}

function serializeLog(log: GenerationLog): GenerationLog {
    return {
        ...log,
        references: log.references.map((item) => ({ ...item, dataUrl: item.storageKey ? "" : item.dataUrl })),
        images: log.images.map((image) => ({ ...image, dataUrl: image.storageKey ? "" : image.dataUrl })),
    };
}

function normalizeLogConfig(log: Partial<GenerationLog>): GenerationLogConfig {
    return {
        model: log.config?.model || log.model || "",
        imageModel: log.config?.imageModel || log.model || "",
        quality: log.config?.quality || log.quality || "",
        size: log.config?.size || log.size || "",
        count: log.config?.count || String(log.imageCount || log.successCount || 1),
    };
}

function buildLog({
    prompt,
    model,
    config,
    references,
    durationMs,
    successCount,
    failCount,
    status,
    images,
}: {
    prompt: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    status: GenerationLog["status"];
    images: GeneratedImage[];
}): GenerationLog {
    const logConfig = {
        model: config.model,
        imageModel: config.imageModel,
        quality: config.quality,
        size: config.size,
        count: config.count,
    };
    return {
        id: nanoid(),
        createdAt: Date.now(),
        title: prompt.slice(0, 12) || i18n.t("workbench.untitled"),
        prompt,
        time: new Date().toLocaleString(i18n.resolvedLanguage, { hour12: false }),
        model,
        config: logConfig,
        references,
        durationMs,
        successCount,
        failCount,
        imageCount: Number(logConfig.count) || successCount,
        size: logConfig.size,
        quality: logConfig.quality,
        status,
        images,
    };
}
