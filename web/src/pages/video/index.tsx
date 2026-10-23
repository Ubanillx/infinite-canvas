import { BookOpen, CheckSquare, ClipboardPaste, Download, FolderPlus, History, LoaderCircle, Music2, Plus, SlidersHorizontal, Sparkles, Trash2, Upload, VideoIcon } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type DragEvent } from "react";
import { App, Button, Checkbox, ConfigProvider, Drawer, Image, Input, Modal, Tag, Tooltip, Typography } from "antd";
import localforage from "localforage";
import { nanoid } from "nanoid";
import { saveAs } from "file-saver";
import { useTranslation } from "react-i18next";
import { workspaceStoreName } from "@/lib/workspace";

import { ReferenceOrderButtons } from "@/components/workbench/reference-order-buttons";
import { moveListItem } from "@/lib/utils";
import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { ModelPicker } from "@/components/model-picker";
import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { VideoSettingsPanel, normalizeVideoResolutionValue, normalizeVideoSizeValue, videoModeLabel, videoSecondsLabel, videoSizeLabel } from "@/components/video-settings-panel";
import { clampVideoSeconds } from "@/lib/media-size";
import { canvasThemes } from "@/lib/canvas-theme";
import { formatBytes, formatDuration } from "@/lib/image-utils";
import { boolConfig, isSeedanceVideoConfig, normalizeSeedanceRatio, seedanceReferenceLabel, seedanceVideoReferenceError, seedanceVideoReferenceHint, SEEDANCE_REFERENCE_LIMITS, SEEDANCE_VIDEO_MIME_TYPES } from "@/lib/seedance-video";
import { deleteStoredMedia, resolveMediaUrl, uploadMediaFile } from "@/services/file-storage";
import { resolveImageUrl, ensureImagePreview, getImagePreviewRevision, previewUrlFor, subscribeImagePreviews, uploadImage } from "@/services/image-storage";
import { createVideoGenerationTask, pollVideoGenerationTask, storeGeneratedVideo, type VideoGenerationTask } from "@/services/api/video";
import { useAssetStore } from "@/stores/use-asset-store";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
import { modelOptionLabel, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import i18n from "@/i18n";
import { saveWorkspaceData } from "@/services/workspace-data";
import { readWorkspaceLogs } from "@/services/workspace-logs";

type GeneratedVideo = {
    id: string;
    url: string;
    storageKey: string;
    durationMs: number;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

type GenerationResult = {
    id: string;
    status: "pending" | "success" | "failed";
    video?: GeneratedVideo;
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
    videoReferences: ReferenceVideo[];
    audioReferences: ReferenceAudio[];
    durationMs: number;
    size: string;
    resolution: string;
    seconds: string;
    status: "pending" | "success" | "failed";
    task?: VideoGenerationTask;
    video?: GeneratedVideo;
    error?: string;
};

type GenerationLogConfig = Pick<AiConfig, "model" | "videoModel" | "size" | "vquality" | "videoSeconds" | "videoGenerateAudio" | "videoWatermark" | "videoMode">;

type UpdateAiConfig = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;

const LOG_STORE_KEY = "infinite-canvas:video_generation_logs";
const logStore = localforage.createInstance({ name: "infinite-canvas", storeName: workspaceStoreName("video_generation_logs") });

export default function VideoPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const dragDepthRef = useRef(0);
    const composerRef = useRef<HTMLElement>(null);
    const composerDragRef = useRef<{ y: number; height: number } | null>(null);
    const composerMinHeightRef = useRef<number | null>(null);
    const activeLogIdsRef = useRef<Set<string>>(new Set());
    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const addAsset = useAssetStore((state) => state.addAsset);
    const [prompt, setPrompt] = useState("");
    const [references, setReferences] = useState<ReferenceImage[]>([]);
    const [videoReferences, setVideoReferences] = useState<ReferenceVideo[]>([]);
    const [audioReferences, setAudioReferences] = useState<ReferenceAudio[]>([]);
    const [results, setResults] = useState<GenerationResult[]>([]);
    const [logs, setLogs] = useState<GenerationLog[]>([]);
    const [running, setRunning] = useState(false);
    const [logsOpen, setLogsOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [promptDialogOpen, setPromptDialogOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [startedAt, setStartedAt] = useState(0);
    const [elapsedMs, setElapsedMs] = useState(0);
    const [selectedLogIds, setSelectedLogIds] = useState<string[]>([]);
    const [previewLog, setPreviewLog] = useState<GenerationLog | null>(null);
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [referenceDragTarget, setReferenceDragTarget] = useState<"image" | "video" | "audio" | null>(null);
    const [composerHeight, setComposerHeight] = useState<number | null>(null);
    const [autoRunToken, setAutoRunToken] = useState(0);
    const videoCommand = useWorkbenchAgentStore((state) => state.videoCommand);
    const clearVideoCommand = useWorkbenchAgentStore((state) => state.clearVideoCommand);
    const updateAgentTask = useWorkbenchAgentStore((state) => state.updateTask);
    const processedCommandRef = useRef(0);
    const agentTaskIdRef = useRef<string | undefined>(undefined);

    const model = effectiveConfig.videoModel || effectiveConfig.model;
    const canGenerate = Boolean(prompt.trim());
    const configSummary = `${modelOptionLabel(effectiveConfig, model)} · ${normalizeResolution(effectiveConfig.vquality)}p · ${videoSizeLabel(effectiveConfig.size)} · ${videoSecondsLabel(effectiveConfig.videoSeconds)} · ${videoModeLabel(effectiveConfig.videoMode)}`;

    useEffect(() => {
        if (!running || !startedAt) return;
        const timer = window.setInterval(() => setElapsedMs(performance.now() - startedAt), 1000);
        return () => window.clearInterval(timer);
    }, [running, startedAt]);

    useEffect(() => {
        void refreshLogs();
    }, []);

    const addReferences = async (files?: FileList | null) => {
        const selectedFiles = Array.from(files || []);
        const unsupported = selectedFiles.filter((file) => !file.type.startsWith("image/") && !SEEDANCE_VIDEO_MIME_TYPES.includes(file.type) && !isSupportedAudioFile(file));
        if (unsupported.length) message.warning(t("videoWorkbench.unsupportedFiles"));
        const imageFiles = selectedFiles.filter((file) => file.type.startsWith("image/") && file.size <= SEEDANCE_REFERENCE_LIMITS.imageMaxBytes).slice(0, SEEDANCE_REFERENCE_LIMITS.images - references.length);
        const videoFiles = selectedFiles.filter((file) => SEEDANCE_VIDEO_MIME_TYPES.includes(file.type) && file.size <= SEEDANCE_REFERENCE_LIMITS.videoMaxBytes).slice(0, SEEDANCE_REFERENCE_LIMITS.videos - videoReferences.length);
        const audioFiles = selectedFiles.filter((file) => isSupportedAudioFile(file) && file.size <= SEEDANCE_REFERENCE_LIMITS.audioMaxBytes).slice(0, SEEDANCE_REFERENCE_LIMITS.audios - audioReferences.length);
        if (selectedFiles.some((file) => file.type.startsWith("image/") && file.size > SEEDANCE_REFERENCE_LIMITS.imageMaxBytes)) message.warning(t("videoWorkbench.imageTooLarge"));
        if (selectedFiles.some((file) => SEEDANCE_VIDEO_MIME_TYPES.includes(file.type) && file.size > SEEDANCE_REFERENCE_LIMITS.videoMaxBytes)) message.warning(t("videoWorkbench.videoTooLarge"));
        if (selectedFiles.some((file) => isSupportedAudioFile(file) && file.size > SEEDANCE_REFERENCE_LIMITS.audioMaxBytes)) message.warning(t("videoWorkbench.audioTooLarge"));
        try {
            const nextReferences = await Promise.all(
                imageFiles.map(async (file) => {
                    const image = await uploadImage(file);
                    return { id: nanoid(), name: file.name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
                }),
            );
            const nextVideoReferences = await Promise.all(
                videoFiles.map(async (file) => {
                    const video = await uploadMediaFile(file, "video-reference");
                    return { id: nanoid(), name: file.name, type: video.mimeType, url: video.url, storageKey: video.storageKey, bytes: video.bytes, width: video.width, height: video.height, durationMs: video.durationMs };
                }),
            );
            const nextAudioReferences = filterAudioReferencesByDuration(
                audioReferences,
                await Promise.all(
                    audioFiles.map(async (file) => {
                        const audio = await uploadMediaFile(file, "audio-reference");
                        return { id: nanoid(), name: file.name, type: audio.mimeType, url: audio.url, storageKey: audio.storageKey, durationMs: audio.durationMs };
                    }),
                ),
                message.warning,
            );
            setReferences((value) => [...value, ...nextReferences].slice(0, SEEDANCE_REFERENCE_LIMITS.images));
            setVideoReferences((value) => [...value, ...nextVideoReferences].slice(0, SEEDANCE_REFERENCE_LIMITS.videos));
            setAudioReferences((value) => [...value, ...nextAudioReferences].slice(0, SEEDANCE_REFERENCE_LIMITS.audios));
        } catch (error) {
            message.error(error instanceof Error ? error.message : "媒体保存失败");
        }
    };

    const handleReferenceDragEnter = (event: DragEvent<HTMLDivElement>, target: "image" | "video" | "audio") => {
        event.preventDefault();
        dragDepthRef.current += 1;
        if (event.dataTransfer.types.includes("Files")) setReferenceDragTarget(target);
    };

    const handleReferenceDragLeave = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (!dragDepthRef.current) setReferenceDragTarget(null);
    };

    const handleReferenceDrop = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        dragDepthRef.current = 0;
        setReferenceDragTarget(null);
        void addReferences(event.dataTransfer.files);
    };

    const addReferencesFromClipboard = async () => {
        try {
            const items = await navigator.clipboard.read();
            const blobs = await Promise.all(items.flatMap((item) => item.types.filter((type) => type.startsWith("image/")).map((type) => item.getType(type))));
            if (!blobs.length) {
                message.error(t("videoWorkbench.clipboardEmpty"));
                return;
            }
            const nextReferences = await Promise.all(
                blobs.slice(0, SEEDANCE_REFERENCE_LIMITS.images - references.length).map(async (blob, index) => {
                    const image = await uploadImage(blob);
                    return { id: nanoid(), name: `clipboard-${index + 1}.png`, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
                }),
            );
            setReferences((value) => [...value, ...nextReferences].slice(0, SEEDANCE_REFERENCE_LIMITS.images));
            message.success(t("videoWorkbench.clipboardAdded", { count: nextReferences.length }));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("videoWorkbench.clipboardEmpty"));
        }
    };
    const generate = async () => {
        const agentTaskId = agentTaskIdRef.current;
        agentTaskIdRef.current = undefined;
        const snapshot = buildRequestSnapshot();
        if (!snapshot) {
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t("videoWorkbench.invalidParams") });
            return;
        }
        setElapsedMs(0);
        setRunning(true);
        if (agentTaskId) updateAgentTask(agentTaskId, { status: "running", error: undefined });
        setPreviewLog(null);
        setResults([{ id: nanoid(), status: "pending" }]);
        const batchStartedAt = performance.now();
        setStartedAt(batchStartedAt);
        try {
            const task = await createVideoGenerationTask(snapshot.config, snapshot.text, snapshot.references, { videos: snapshot.videoReferences, audios: snapshot.audioReferences });
            const log = buildLog({ prompt: snapshot.text, model, config: snapshot.config, references: snapshot.references, videoReferences: snapshot.videoReferences, audioReferences: snapshot.audioReferences, durationMs: 0, status: "pending", task });
            await saveLog(log, false);
            void pollGenerationLog(log, snapshot.config, agentTaskId);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : t("workbench.generationFailed");
            setResults([{ id: nanoid(), status: "failed", error: errorMessage }]);
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", successCount: 0, failCount: 1, error: errorMessage });
            await saveLog(buildLog({ prompt: snapshot.text, model, config: snapshot.config, references: snapshot.references, videoReferences: snapshot.videoReferences, audioReferences: snapshot.audioReferences, durationMs: performance.now() - batchStartedAt, status: "failed", error: errorMessage }));
            message.error(errorMessage);
            setRunning(false);
        }
    };

    // Handle video-generation commands from the Agent panel by setting the prompt and optionally starting generation.
    useEffect(() => {
        if (!videoCommand || videoCommand.nonce === processedCommandRef.current) return;
        processedCommandRef.current = videoCommand.nonce;
        clearVideoCommand();
        if (typeof videoCommand.prompt === "string") setPrompt(videoCommand.prompt);
        if (videoCommand.run && running) {
            if (videoCommand.taskId) updateAgentTask(videoCommand.taskId, { status: "failed", error: t("videoWorkbench.busy") });
            return;
        }
        if (videoCommand.run) {
            agentTaskIdRef.current = videoCommand.taskId;
            setAutoRunToken((value) => value + 1);
        }
    }, [videoCommand, clearVideoCommand, running, updateAgentTask]);

    useEffect(() => {
        if (!autoRunToken) return;
        void generate();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoRunToken]);

    const buildRequestSnapshot = () => {
        const text = prompt.trim();
        if (!text) {
            message.error(t("videoWorkbench.promptRequired"));
            return null;
        }
        if (!isAiConfigReady(effectiveConfig, model)) {
            message.warning(t("workbench.configFirst"));
            openConfigDialog(true);
            return null;
        }
        const videoReferenceError = seedanceVideoReferenceError(videoReferences);
        if (videoReferenceError) {
            message.error(t("videoWorkbench.referenceError", { error: videoReferenceError, hint: seedanceVideoReferenceHint() }));
            return null;
        }
        return { text, config: buildVideoConfig(effectiveConfig, model), references: [...references], videoReferences: [...videoReferences], audioReferences: [...audioReferences] };
    };

    const retryResult = () => {
        void generate();
    };

    const downloadVideo = (video: GeneratedVideo) => {
        saveAs(video.url, "video.mp4");
    };

    const saveResultToAssets = (video: GeneratedVideo) => {
        addAsset({
            kind: "video",
            title: t("videoWorkbench.resultTitle"),
            coverUrl: "",
            tags: [],
            source: t("videoWorkbench.source"),
            data: { url: video.url, storageKey: video.storageKey, width: video.width, height: video.height, bytes: video.bytes, mimeType: video.mimeType },
            metadata: { source: "video-page", prompt },
        });
        message.success(t("common.addedToAssets"));
    };

    const insertPickedAsset = async (payload: InsertAssetPayload) => {
        if (payload.kind === "text") {
            setPrompt(payload.content);
        } else if (payload.kind === "image") {
            const stored = await uploadImage(payload.dataUrl);
            setReferences((value) => [...value, { id: nanoid(), name: payload.title, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }].slice(0, SEEDANCE_REFERENCE_LIMITS.images));
        } else if (payload.kind === "video") {
            setVideoReferences((value) => [...value, { id: nanoid(), name: payload.title, type: "video/mp4", url: payload.url, storageKey: payload.storageKey, width: payload.width, height: payload.height }].slice(0, SEEDANCE_REFERENCE_LIMITS.videos));
        }
        setAssetPickerOpen(false);
    };

    const createSession = () => {
        setLogsOpen(false);
        setPrompt("");
        setReferences([]);
        setVideoReferences([]);
        setAudioReferences([]);
        setResults([]);
        setElapsedMs(0);
        setStartedAt(0);
        setSelectedLogIds([]);
        setPreviewLog(null);
    };

    const deleteSelectedLogs = () => {
        const mediaKeys = logs
            .filter((log) => selectedLogIds.includes(log.id))
            .map((log) => log.video?.storageKey)
            .filter((key): key is string => Boolean(key));
        void Promise.all([deleteStoredMedia(mediaKeys), ...selectedLogIds.map((id) => logStore.removeItem(id))]).then(async () => { const next = await refreshLogs(true, false); await saveWorkspaceData("video-workbench", { logs: next.map(serializeLog) }).catch(() => undefined); });
        if (previewLog && selectedLogIds.includes(previewLog.id)) {
            setPreviewLog(null);
            setResults([]);
        }
        setSelectedLogIds([]);
        setDeleteConfirmOpen(false);
    };

    const saveLog = async (log: GenerationLog, resumePending = true) => {
        await logStore.setItem(log.id, serializeLog(log));
        const next = await refreshLogs(resumePending, false);
        await saveWorkspaceData("video-workbench", { logs: next.map(serializeLog) }).catch(() => undefined);
    };

    const refreshLogs = async (resumePending = true, preferRemote = true) => {
        const nextLogs = await readStoredLogs(preferRemote);
        setLogs(nextLogs);
        if (resumePending) resumePendingLogs(nextLogs);
        return nextLogs;
    };

    const resumePendingLogs = (items: GenerationLog[]) => {
        for (const log of items) {
            if (log.status === "pending" && log.task) void pollGenerationLog(log);
        }
    };

    const pollGenerationLog = async (log: GenerationLog, configOverride?: AiConfig, agentTaskId?: string) => {
        if (!log.task || activeLogIdsRef.current.has(log.id)) return;
        activeLogIdsRef.current.add(log.id);
        setRunning(true);
        setStartedAt((value) => value || performance.now());
        setResults((value) => (value.length ? value : [{ id: log.id, status: "pending" }]));
        const taskConfig = buildVideoConfig({ ...effectiveConfig, ...log.config }, log.task.model || log.model);
        try {
            for (let attempt = 0; attempt < 120; attempt += 1) {
                const state = await pollVideoGenerationTask(configOverride || taskConfig, log.task);
                if (state.status === "completed") {
                    const stored = await storeGeneratedVideo(state.result);
                    const nextVideo: GeneratedVideo = {
                        id: nanoid(),
                        url: stored.url,
                        storageKey: stored.storageKey,
                        durationMs: Date.now() - log.createdAt,
                        width: stored.width || 1280,
                        height: stored.height || 720,
                        bytes: stored.bytes,
                        mimeType: stored.mimeType,
                    };
                    setResults([{ id: nextVideo.id, status: "success", video: nextVideo }]);
                    if (agentTaskId) updateAgentTask(agentTaskId, { status: "succeeded", successCount: 1, failCount: 0, error: undefined });
                    await saveLog({ ...log, status: "success", durationMs: nextVideo.durationMs, video: nextVideo, error: undefined });
                    message.success(t("videoWorkbench.generated"));
                    return;
                }
                if (state.status === "failed") throw new Error(state.error);
                if (attempt === 119) throw new Error(t("videoWorkbench.timeout"));
                await delay(log.task.provider === "seedance" ? 5000 : 2500);
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : t("workbench.generationFailed");
            setResults([{ id: log.id, status: "failed", error: errorMessage }]);
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", successCount: 0, failCount: 1, error: errorMessage });
            await saveLog({ ...log, status: "failed", durationMs: Date.now() - log.createdAt, error: errorMessage });
            message.error(errorMessage);
        } finally {
            activeLogIdsRef.current.delete(log.id);
            if (!activeLogIdsRef.current.size) {
                setRunning(false);
                setStartedAt(0);
            }
        }
    };

    const previewGenerationLog = (log: GenerationLog) => {
        setPreviewLog(log);
        setLogsOpen(false);
        setPrompt(log.prompt);
        setReferences(log.references || []);
        setVideoReferences(log.videoReferences || []);
        setAudioReferences(log.audioReferences || []);
        if (log.config.videoModel || log.model) updateConfig("videoModel", log.config.videoModel || log.model);
        if (log.config.size) updateConfig("size", log.config.size);
        if (log.config.vquality) updateConfig("vquality", log.config.vquality);
        if (log.config.videoSeconds) updateConfig("videoSeconds", log.config.videoSeconds);
        if (log.config.videoGenerateAudio) updateConfig("videoGenerateAudio", log.config.videoGenerateAudio);
        if (log.config.videoWatermark) updateConfig("videoWatermark", log.config.videoWatermark);
        if (log.config.videoMode) updateConfig("videoMode", log.config.videoMode);
        setResults(log.status === "pending" ? [{ id: log.id, status: "pending" }] : log.video ? [{ id: log.video.id, status: "success", video: log.video }] : [{ id: log.id, status: "failed", error: log.error || t("workbench.generationFailed") }]);
    };

    const resizeComposer = (height: number) => {
        const minimum = composerMinHeightRef.current ?? composerRef.current?.getBoundingClientRect().height ?? 0;
        const maximum = composerRef.current?.parentElement?.clientHeight ?? window.innerHeight;
        setComposerHeight(Math.max(minimum, Math.min(maximum, height)));
    };

    return (
        <ConfigProvider wave={{ disabled: true }} theme={{ components: { Button: { defaultShadow: "none", primaryShadow: "none", dangerShadow: "none" } } }}>
            <div className={`flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground transition-[margin-right] duration-300 [&_.ant-btn]:!shadow-none ${settingsOpen || logsOpen ? "lg:mr-[420px]" : ""}`}>
                <main className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-3 lg:px-6">
                    <div className="flex h-full min-h-0 w-full flex-col gap-3">
                        <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                            <h1 className="text-xl font-semibold">{t("videoWorkbench.title")}</h1>
                            <p className="text-xs text-muted-foreground">{t("videoWorkbench.galleryHint")}</p>
                        </header>
                        <section aria-label={t("workbench.logs")}>
                            <div className="mb-1 flex items-center justify-between gap-3">
                                <h2 className="text-base font-semibold">{t("workbench.logs")} <span className="ml-1 font-normal text-muted-foreground">{logs.length}</span></h2>
                                <Button type="text" icon={<History className="size-4" />} onClick={() => { setSettingsOpen(false); setLogsOpen(true); }}>{t("videoWorkbench.manageLogs")}</Button>
                            </div>
                            <div className="thin-scrollbar flex gap-2.5 overflow-x-auto pb-1">
                                <Button icon={<Plus className="size-4" />} onClick={createSession} className="!h-9 !shrink-0 !gap-2 !rounded-lg !border-border !px-3 !text-sm !font-medium !text-foreground hover:!border-input hover:!bg-muted/40">{t("videoWorkbench.newCreation")}</Button>
                                {logs.map((log) => (
                                    <button key={log.id} type="button" onClick={() => previewGenerationLog(log)} className={`flex h-16 w-56 shrink-0 items-center gap-2.5 rounded-lg border p-2 text-left transition-colors focus-visible:bg-muted/40 focus-visible:outline-none ${previewLog?.id === log.id ? "border-border bg-muted/60" : "border-border bg-card hover:bg-muted/40"}`}>
                                        <span className="flex size-12 shrink-0 items-center justify-center rounded-md bg-muted/50"><VideoIcon className="size-5 text-muted-foreground" /></span>
                                        <span className="min-w-0"><span className="line-clamp-2 block text-sm font-medium">{log.title}</span><span className="mt-1 block truncate text-xs text-muted-foreground">{log.time} · {t(`workbench.${log.status === "success" ? "success" : log.status === "pending" ? "generating" : "failed"}`)}</span></span>
                                    </button>
                                ))}
                                {!logs.length ? <div className="flex h-9 items-center px-2 text-sm text-muted-foreground">{t("workbench.noLogs")}</div> : null}
                            </div>
                        </section>
                        <div className={`grid min-h-[280px] min-w-0 flex-1 gap-4 lg:min-h-0 lg:grid-rows-[minmax(0,1fr)] ${settingsOpen || logsOpen ? "lg:grid-cols-[280px_minmax(0,1fr)]" : "lg:grid-cols-[340px_minmax(0,1fr)]"}`}>
                            <section className="flex min-h-0 min-w-0 flex-col" aria-label={t("videoWorkbench.referenceAssets")}>
                                <div className="mb-2 flex h-8 items-center justify-between gap-2">
                                    <h2 className="text-base font-semibold">{t("videoWorkbench.referenceAssets")}</h2>
                                    <div className="flex items-center gap-1">
                                        <Tooltip title={t("workbench.clipboard")}><Button type="text" icon={<ClipboardPaste className="size-4" />} aria-label={t("workbench.clipboard")} onClick={() => void addReferencesFromClipboard()} /></Tooltip>
                                        <Button type="text" icon={<Upload className="size-4" />} onClick={() => fileInputRef.current?.click()}>{t("workbench.upload")}</Button>
                                    </div>
                                </div>
                                <div className="thin-scrollbar flex min-h-[280px] flex-1 flex-col gap-4 overflow-y-auto rounded-lg border border-border bg-card p-3">
                                    <div className="min-w-0">
                                        <h3 className="mb-2 text-sm font-medium">{t("videoWorkbench.references")} <span className="font-normal text-muted-foreground">{references.length}</span></h3>
                                        <div className={`flex min-h-24 min-w-0 flex-wrap content-start gap-2 rounded-md border p-2 transition-colors ${referenceDragTarget === "image" ? "border-input bg-muted/40" : "border-border bg-muted/10"}`} onDragEnter={(event) => handleReferenceDragEnter(event, "image")} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }} onDragLeave={handleReferenceDragLeave} onDrop={handleReferenceDrop}>
                                            {references.map((item, index) => <div key={item.id} className="group relative size-20 shrink-0 overflow-hidden rounded-md"><Image src={previewUrlFor(item.storageKey) || item.dataUrl} preview={{ src: item.dataUrl }} alt={item.name} width={80} height={80} style={{ objectFit: "cover" }} /><span className="pointer-events-none absolute left-1 top-1 rounded border border-border bg-card/90 px-1 text-[10px] text-foreground">{seedanceReferenceLabel("image", index)}</span><ReferenceOrderButtons index={index} total={references.length} flat onMove={(offset) => setReferences((value) => moveListItem(value, index, offset))} /><button type="button" className="absolute right-1 top-1 flex size-6 items-center justify-center rounded border border-border bg-card/90 text-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100" onClick={() => setReferences((value) => value.filter((ref) => ref.id !== item.id))} aria-label={t("videoWorkbench.removeImage")}><Trash2 className="size-3.5" /></button></div>)}
                                            {!references.length ? <div className="flex min-h-16 w-full items-center justify-center px-2 text-center text-xs text-muted-foreground">{referenceDragTarget === "image" ? t("videoWorkbench.dropReferences") : t("videoWorkbench.noImages")}</div> : null}
                                        </div>
                                    </div>
                                    <div className="min-w-0">
                                        <h3 className="mb-2 text-sm font-medium">{t("videoWorkbench.videoReferences")} <span className="font-normal text-muted-foreground">{videoReferences.length}</span></h3>
                                        <div className={`flex min-h-24 min-w-0 flex-wrap content-start gap-2 rounded-md border p-2 transition-colors ${referenceDragTarget === "video" ? "border-input bg-muted/40" : "border-border bg-muted/10"}`} onDragEnter={(event) => handleReferenceDragEnter(event, "video")} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }} onDragLeave={handleReferenceDragLeave} onDrop={handleReferenceDrop}>
                                            {videoReferences.map((item, index) => <div key={item.id} className="group relative h-20 w-32 shrink-0 overflow-hidden rounded-md bg-black"><video src={item.url} className="size-full object-cover" muted preload="metadata" /><span className="pointer-events-none absolute left-1 top-1 rounded border border-border bg-card/90 px-1 text-[10px] text-foreground">{seedanceReferenceLabel("video", index)}</span><ReferenceOrderButtons index={index} total={videoReferences.length} flat onMove={(offset) => setVideoReferences((value) => moveListItem(value, index, offset))} /><button type="button" className="absolute right-1 top-1 flex size-6 items-center justify-center rounded border border-border bg-card/90 text-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100" onClick={() => setVideoReferences((value) => value.filter((ref) => ref.id !== item.id))} aria-label={t("videoWorkbench.removeVideo")}><Trash2 className="size-3.5" /></button></div>)}
                                            {!videoReferences.length ? <div className="flex min-h-16 w-full items-center justify-center px-2 text-center text-xs text-muted-foreground">{referenceDragTarget === "video" ? t("videoWorkbench.dropReferences") : t("videoWorkbench.noVideos")}</div> : null}
                                        </div>
                                    </div>
                                    <div className="min-w-0">
                                        <h3 className="mb-2 text-sm font-medium">{t("videoWorkbench.audioReferences")} <span className="font-normal text-muted-foreground">{audioReferences.length}</span></h3>
                                        <div className={`flex min-h-24 min-w-0 flex-wrap content-start gap-2 rounded-md border p-2 transition-colors ${referenceDragTarget === "audio" ? "border-input bg-muted/40" : "border-border bg-muted/10"}`} onDragEnter={(event) => handleReferenceDragEnter(event, "audio")} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }} onDragLeave={handleReferenceDragLeave} onDrop={handleReferenceDrop}>
                                            {audioReferences.map((item, index) => <div key={item.id} className={`group relative flex w-48 shrink-0 flex-col justify-center gap-2 rounded-md border border-border bg-card px-2 ${audioReferences.length > 1 ? "h-28 pb-7" : "h-20"}`}><div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"><Music2 className="size-4 shrink-0" /><span className="shrink-0 rounded bg-muted px-1 text-[10px] text-foreground">{seedanceReferenceLabel("audio", index)}</span><span className="truncate">{item.name}</span></div><audio src={item.url} controls className="h-8 w-full" preload="metadata" /><ReferenceOrderButtons index={index} total={audioReferences.length} flat onMove={(offset) => setAudioReferences((value) => moveListItem(value, index, offset))} /><button type="button" className="absolute right-1 top-1 flex size-6 items-center justify-center rounded border border-border bg-card/90 text-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100" onClick={() => setAudioReferences((value) => value.filter((ref) => ref.id !== item.id))} aria-label={t("videoWorkbench.removeAudio")}><Trash2 className="size-3.5" /></button></div>)}
                                            {!audioReferences.length ? <div className="flex min-h-16 w-full items-center justify-center px-2 text-center text-xs text-muted-foreground">{referenceDragTarget === "audio" ? t("videoWorkbench.dropReferences") : t("videoWorkbench.noAudio")}</div> : null}
                                        </div>
                                    </div>
                                </div>
                            </section>
                            <section className="flex min-h-0 min-w-0 flex-col" aria-label={t("workbench.results")}>
                                <div className="mb-2 flex h-8 items-center justify-between gap-3"><h2 className="text-base font-semibold">{t("workbench.results")}</h2>{running ? <Tag className="m-0">{t("workbench.waiting", { time: formatDuration(elapsedMs) })}</Tag> : null}</div>
                                {results.length ? <div className="thin-scrollbar flex min-h-[280px] flex-1 flex-col gap-3 overflow-y-auto">{results.map((result) => result.status === "success" && result.video ? <ResultVideoCard key={result.id} video={result.video} onDownload={downloadVideo} onSaveAsset={saveResultToAssets} /> : result.status === "failed" ? <FailedVideoCard key={result.id} error={result.error || t("workbench.generationFailed")} onRetry={retryResult} /> : <PendingVideoCard key={result.id} />)}</div> : <div className="flex min-h-[280px] flex-1 flex-col items-center justify-center rounded-lg border border-border bg-card px-6 text-center"><VideoIcon className="mb-3 size-10 text-muted-foreground" /><h3 className="text-base font-medium">{t("videoWorkbench.empty")}</h3><p className="mt-1 text-sm text-muted-foreground">{t("videoWorkbench.emptyHint")}</p></div>}
                            </section>
                        </div>
                    </div>
                </main>
                <section ref={composerRef} style={{ height: composerHeight ?? undefined }} className="thin-scrollbar relative shrink-0 overflow-y-auto border-t border-border bg-card px-4 py-3 lg:px-6" aria-label={t("videoWorkbench.creationArea")}>
                    <div role="separator" tabIndex={0} aria-orientation="horizontal" aria-label={t("videoWorkbench.resizePrompt")} title={t("videoWorkbench.resizePrompt")} className="absolute inset-x-0 top-0 z-10 h-2 cursor-ns-resize touch-none focus-visible:outline-2 focus-visible:outline-ring" onPointerDown={(event) => { const height = composerRef.current?.getBoundingClientRect().height ?? 0; composerMinHeightRef.current ??= height; composerDragRef.current = { y: event.clientY, height }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => { if (composerDragRef.current) resizeComposer(composerDragRef.current.height + composerDragRef.current.y - event.clientY); }} onPointerUp={(event) => { composerDragRef.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { composerDragRef.current = null; }} onKeyDown={(event) => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); composerMinHeightRef.current ??= composerRef.current?.getBoundingClientRect().height ?? 0; resizeComposer((composerRef.current?.getBoundingClientRect().height ?? 0) + (event.key === "ArrowUp" ? 24 : -24)); } }} />
                    <div className="flex h-full min-h-[128px] w-full flex-col">
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 sm:flex-nowrap">
                            <div className="flex min-w-0 items-center gap-3"><label htmlFor="video-prompt" className="text-sm font-semibold">{t("videoWorkbench.describe")}</label><div className="flex items-center gap-1 border-l border-border pl-2"><Tooltip title={t("workbench.viewPrompts")}><Button type="text" className="!size-8 !rounded-md !text-muted-foreground hover:!bg-muted/50 hover:!text-foreground" icon={<BookOpen className="size-4" />} aria-label={t("workbench.viewPrompts")} onClick={() => setPromptDialogOpen(true)} /></Tooltip><Tooltip title={t("workbench.viewAssets")}><Button type="text" className="!size-8 !rounded-md !text-muted-foreground hover:!bg-muted/50 hover:!text-foreground" icon={<FolderPlus className="size-4" />} aria-label={t("workbench.viewAssets")} onClick={() => setAssetPickerOpen(true)} /></Tooltip></div></div>
                            <div className="flex min-w-0 flex-1 items-center justify-end gap-2"><span className="mr-1 hidden min-w-0 max-w-80 flex-1 truncate text-xs text-muted-foreground sm:block">{configSummary}</span><Button type="text" aria-pressed={settingsOpen} className={`!h-9 !shrink-0 !gap-2 !rounded-lg !px-3 !text-sm !text-muted-foreground hover:!bg-muted/50 hover:!text-foreground ${settingsOpen ? "!bg-muted/50" : ""}`} icon={<SlidersHorizontal className="size-4" />} onClick={() => { setLogsOpen(false); setSettingsOpen(true); }}>{t("workbench.settings")}</Button><Button type="primary" className="!h-9 !min-w-28 !shrink-0 !gap-2 !rounded-lg !px-4 !text-sm !font-medium disabled:!border-transparent disabled:!bg-muted/60 disabled:!text-muted-foreground/50" icon={<Sparkles className="size-4" />} loading={running} disabled={!canGenerate || running} onClick={() => void generate()}>{t("workbench.generate")}</Button></div>
                        </div>
                        <Input.TextArea id="video-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={4} placeholder={t("videoWorkbench.promptPlaceholder")} className="!min-h-[96px] !flex-1 !resize-none !rounded-lg !border-border !bg-muted/20 !shadow-none hover:!border-input hover:!bg-muted/30 hover:!shadow-none focus:!border-input focus:!bg-muted/40 focus:!shadow-none" />
                    </div>
                </section>
                <input ref={fileInputRef} type="file" accept="image/*,video/mp4,video/quicktime,audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav" multiple className="hidden" onChange={(event) => { void addReferences(event.target.files); event.target.value = ""; }} />
                <Drawer title={t("workbench.logs")} extra={<span className="text-sm text-muted-foreground">{logs.length}</span>} placement="right" size="min(420px, 100vw)" mask={false} open={logsOpen} onClose={() => setLogsOpen(false)} classNames={{ body: "thin-scrollbar [&_.ant-btn]:!shadow-none" }} styles={{ wrapper: { boxShadow: "none" }, section: { borderLeft: "1px solid var(--border)" } }}><LogPanel logs={logs} selectedLogIds={selectedLogIds} activeLogId={previewLog?.id} onSelectedLogIdsChange={setSelectedLogIds} onCreateSession={createSession} onDeleteSelected={() => setDeleteConfirmOpen(true)} onPreviewLog={previewGenerationLog} /></Drawer>
                <Drawer title={t("videoWorkbench.generationSettings")} placement="right" size="min(420px, 100vw)" mask={false} open={settingsOpen} onClose={() => setSettingsOpen(false)} classNames={{ body: "thin-scrollbar [&_.ant-btn]:!shadow-none" }} styles={{ wrapper: { boxShadow: "none" }, section: { borderLeft: "1px solid var(--border)" } }}><GenerationSettings config={effectiveConfig} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} onClose={() => setSettingsOpen(false)} /></Drawer>
                <PromptSelectDialog open={promptDialogOpen} onOpenChange={setPromptDialogOpen} onSelect={setPrompt} flat />
                <AssetPickerModal open={assetPickerOpen} defaultTab="my-assets" onInsert={(payload) => void insertPickedAsset(payload)} onClose={() => setAssetPickerOpen(false)} flat />
                <Modal title={t("workbench.deleteLogs")} open={deleteConfirmOpen} onCancel={() => setDeleteConfirmOpen(false)} onOk={deleteSelectedLogs} okText={t("common.delete")} okButtonProps={{ danger: true }} cancelText={t("common.cancel")} classNames={{ footer: "[&_.ant-btn]:!shadow-none" }} styles={{ container: { boxShadow: "none", border: "1px solid var(--border)" } }}>{t("workbench.deleteLogsConfirm", { count: selectedLogIds.length })}</Modal>
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
                <ModelPicker config={config} value={model} onChange={(value) => updateConfig("videoModel", value)} capability="video" fullWidth flat onMissingConfig={() => openConfigDialog(false)} />
            </div>
            <VideoSettingsPanel config={config} onConfigChange={(key, value) => updateConfig(key, value)} theme={theme} showTitle={false} className="space-y-4" subtleSelection />
            <Button block size="large" onClick={onClose}>{t("videoWorkbench.finishSettings")}</Button>
        </div>
    );
}

function ResultVideoCard({ video, onDownload, onSaveAsset }: { video: GeneratedVideo; onDownload: (video: GeneratedVideo) => void; onSaveAsset: (video: GeneratedVideo) => void }) {
    const { t } = useTranslation();
    return (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
            <video src={video.url} controls className="aspect-video w-full bg-black object-contain" />
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-border px-3 py-2.5">
                <div className="flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span>
                        {video.width}x{video.height}
                    </span>
                    <span>{formatBytes(video.bytes)}</span>
                    <span>{formatDuration(video.durationMs)}</span>
                </div>
                <div className="flex shrink-0 gap-1">
                    <Button icon={<FolderPlus className="size-4" />} onClick={() => onSaveAsset(video)}>
                        {t("common.addToAssets")}
                    </Button>
                    <Button icon={<Download className="size-4" />} onClick={() => onDownload(video)}>
                        {t("common.download")}
                    </Button>
                </div>
            </div>
        </div>
    );
}

function PendingVideoCard() {
    const { t } = useTranslation();
    return (
        <div className="relative aspect-video overflow-hidden rounded-lg border border-border bg-card">
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle className="size-6 animate-spin" />
                <span>{t("workbench.generating")}</span>
            </div>
        </div>
    );
}

function FailedVideoCard({ error, onRetry }: { error: string; onRetry: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
            <div className="flex aspect-video flex-col items-center justify-center gap-3 p-5 text-center">
                <div className="text-sm font-medium text-destructive">{t("workbench.failed")}</div>
                <Typography.Paragraph ellipsis={{ rows: 4 }} className="!mb-0 !text-xs !text-muted-foreground">
                    {error}
                </Typography.Paragraph>
            </div>
            <div className="flex justify-end border-t border-border p-3">
                <Button onClick={onRetry}>
                    {t("workbench.retry")}
                </Button>
            </div>
        </div>
    );
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
                    <LogCard key={log.id} log={log} selected={selectedLogIds.includes(log.id)} active={activeLogId === log.id} onSelectedChange={(checked) => onSelectedLogIdsChange(checked ? [...selectedLogIds, log.id] : selectedLogIds.filter((id) => id !== log.id))} onClick={() => onPreviewLog(log)} />
                ))}
                {!logs.length ? <div className="flex min-h-48 items-center justify-center rounded-lg border border-border bg-card text-center text-sm text-muted-foreground">{t("workbench.noLogs")}</div> : null}
            </div>
        </>
    );
}

function LogCard({ log, selected, active, onSelectedChange, onClick }: { log: GenerationLog; selected: boolean; active: boolean; onSelectedChange: (checked: boolean) => void; onClick: () => void }) {
    const { t } = useTranslation();
    return (
        <div className={`flex items-start gap-3 rounded-lg border border-border p-3 transition-colors ${active ? "bg-muted/60" : "bg-card hover:bg-muted/30"}`}>
            <Checkbox className="mt-0.5" checked={selected} onChange={(event) => onSelectedChange(event.target.checked)} />
            <button type="button" className="min-w-0 flex-1 text-left focus-visible:rounded-md focus-visible:bg-muted/40 focus-visible:outline-none" onClick={onClick}>
                <span className="block truncate text-sm font-medium">{log.title}</span>
                <span className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span>{log.time}</span><span>{log.size}</span><span>{log.resolution}p</span><span>{log.seconds}s</span>
                    <span>{t(`workbench.${log.status === "success" ? "success" : log.status === "pending" ? "generating" : "failed"}`)}</span><span>{formatDuration(log.durationMs)}</span>
                </span>
            </button>
        </div>
    );
}

async function readStoredLogs(preferRemote = true) {
    if (typeof window === "undefined") return [];
    const logs = preferRemote ? await readWorkspaceLogs<GenerationLog>("video-workbench", logStore) : await readLocalLogs();
    return (await Promise.all(logs.map(normalizeLog))).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

async function readLocalLogs() {
    const logs: GenerationLog[] = [];
    await logStore.iterate<GenerationLog, void>((log) => { logs.push(log); });
    return logs;
}

async function normalizeLog(log: Partial<GenerationLog>): Promise<GenerationLog> {
    const video = log.video?.storageKey ? { ...log.video, url: await resolveMediaUrl(log.video.storageKey, log.video.url) } : log.video;
    const videoReferences = await Promise.all(
        (log.videoReferences || []).map(async (item) => ({
            ...item,
            url: item.storageKey ? await resolveMediaUrl(item.storageKey, item.url) : item.url,
        })),
    );
    const audioReferences = await Promise.all(
        (log.audioReferences || []).map(async (item) => ({
            ...item,
            url: item.storageKey ? await resolveMediaUrl(item.storageKey, item.url) : item.url,
        })),
    );
    const references = await Promise.all(
        (log.references || []).map(async (item) => {
            void ensureImagePreview(item.storageKey);
            return { ...item, dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl) };
        }),
    );
    const config = normalizeLogConfig(log);
    return {
        id: log.id || nanoid(),
        createdAt: log.createdAt || Date.now(),
        title: log.title || log.model || i18n.t("workbench.untitled"),
        prompt: log.prompt || "",
        time: log.time || new Date().toLocaleString(i18n.resolvedLanguage, { hour12: false }),
        model: log.model || config.videoModel || "",
        config,
        references,
        videoReferences,
        audioReferences,
        durationMs: log.durationMs || 0,
        size: log.size || config.size || "",
        resolution: normalizeResolution(log.resolution || config.vquality || ""),
        seconds: log.seconds || config.videoSeconds || "",
        status: log.status || "success",
        task: log.task,
        video,
        error: log.error,
    };
}

function serializeLog(log: GenerationLog): GenerationLog {
    return {
        ...log,
        references: log.references.map((item) => ({ ...item, dataUrl: item.storageKey ? "" : item.dataUrl })),
        videoReferences: log.videoReferences.map((item) => (item.storageKey ? { ...item, url: "" } : item)),
        audioReferences: log.audioReferences.map((item) => (item.storageKey ? { ...item, url: "" } : item)),
        video: log.video?.storageKey ? { ...log.video, url: "" } : log.video,
    };
}

function isSupportedAudioFile(file: File) {
    return file.type === "audio/mpeg" || file.type === "audio/mp3" || file.type === "audio/wav" || file.type === "audio/x-wav" || /\.(mp3|wav)$/i.test(file.name);
}

function filterAudioReferencesByDuration(existing: ReferenceAudio[], next: ReferenceAudio[], warn: (content: string) => void) {
    let total = existing.reduce((sum, item) => sum + (item.durationMs || 0), 0);
    const accepted: ReferenceAudio[] = [];
    let skipped = false;
    for (const item of next) {
        if (item.durationMs && (item.durationMs < 2000 || item.durationMs > 15000)) {
            skipped = true;
            continue;
        }
        if (item.durationMs && total + item.durationMs > 15000) {
            skipped = true;
            continue;
        }
        total += item.durationMs || 0;
        accepted.push(item);
    }
    if (skipped) warn(i18n.t("videoWorkbench.audioDurationInvalid"));
    return accepted;
}

function normalizeLogConfig(log: Partial<GenerationLog>): GenerationLogConfig {
    return {
        model: log.config?.model || log.model || "",
        videoModel: log.config?.videoModel || log.model || "",
        size: log.config?.size || log.size || "",
        vquality: normalizeResolution(log.config?.vquality || log.resolution || ""),
        videoSeconds: log.config?.videoSeconds || log.seconds || "",
        videoGenerateAudio: log.config?.videoGenerateAudio || "true",
        videoWatermark: log.config?.videoWatermark || "false",
        videoMode: log.config?.videoMode === "reference" ? "reference" : "frames",
    };
}

function buildLog({ prompt, model, config, references, videoReferences, audioReferences, durationMs, status, task, video, error }: { prompt: string; model: string; config: AiConfig; references: ReferenceImage[]; videoReferences: ReferenceVideo[]; audioReferences: ReferenceAudio[]; durationMs: number; status: GenerationLog["status"]; task?: VideoGenerationTask; video?: GeneratedVideo; error?: string }): GenerationLog {
    const logConfig = {
        model: config.model,
        videoModel: config.videoModel,
        size: config.size,
        vquality: normalizeResolution(config.vquality),
        videoSeconds: config.videoSeconds,
        videoGenerateAudio: config.videoGenerateAudio,
        videoWatermark: config.videoWatermark,
        videoMode: config.videoMode === "reference" ? "reference" : "frames",
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
        videoReferences,
        audioReferences,
        durationMs,
        size: logConfig.size,
        resolution: logConfig.vquality,
        seconds: logConfig.videoSeconds,
        status,
        task,
        video,
        error,
    };
}

function buildVideoConfig(config: AiConfig, model: string): AiConfig {
    const seedance = isSeedanceVideoConfig({ ...config, model });
    return {
        ...config,
        model,
        videoModel: model,
        size: seedance ? normalizeSeedanceRatio(config.size) : normalizeVideoSizeValue(config.size, config.vquality),
        videoSeconds: seedance ? normalizeVideoSeconds(config.videoSeconds) : clampVideoSeconds(config.videoSeconds),
        vquality: normalizeResolution(config.vquality),
        videoGenerateAudio: String(boolConfig(config.videoGenerateAudio, true)),
        videoWatermark: String(boolConfig(config.videoWatermark, false)),
        videoMode: config.videoMode === "reference" ? "reference" : "frames",
    };
}

function normalizeVideoSeconds(value: string) {
    if (String(value).trim() === "-1") return "-1";
    const seconds = Math.floor(Number(value) || 6);
    return String(Math.max(4, Math.min(30, seconds)));
}

function normalizeResolution(value: string) {
    return normalizeVideoResolutionValue(value);
}

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
