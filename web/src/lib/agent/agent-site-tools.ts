import type { NavigateFunction } from "react-router-dom";
import localforage from "localforage";

import i18n from "@/i18n";
import { fetchPrompts } from "@/services/api/prompts";
import { imageAspectOptions, imageQualityOptions, imageScaleOptions } from "@/components/image-settings-panel";
import { videoResolutionOptions, videoSecondsRange, videoSizeOptions } from "@/components/video-settings-panel";
import type { CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { clampVideoSeconds } from "@/lib/media-size";
import { isSeedanceVideoConfig, normalizeSeedanceDuration, seedanceDurationOptions, seedanceRatioOptions, seedanceResolutionOptions } from "@/lib/seedance-video";
import { getActiveWorkspace } from "@/lib/workspace";
import { requireAgentWorkspace } from "@/lib/agent/agent-tool-context";
import { getGenerationTask, listGenerationTasks, resumeGenerationTask, submitGenerationTask } from "@/services/api/generation-tasks";
import type { GenerationTaskReference } from "@/types/generation-task";
import { PROMPT_TOOL_NAMES, isPromptTool, runPromptTool } from "@/lib/agent/agent-prompt-tools";
import { RESOURCE_TOOL_NAMES, isResourceTool, runResourceTool } from "@/lib/agent/agent-resource-tools";
import { TEMPLATE_TOOL_NAMES, isTemplateTool, runTemplateTool, type TemplateCanvasContext } from "@/lib/agent/agent-template-tools";
import { MEDIA_TOOL_NAMES, isMediaTool, runMediaTool } from "@/lib/agent/agent-media-tools";
import { GENERATION_RESULT_TOOL_NAMES, isGenerationResultTool, runGenerationResultTool } from "@/lib/agent/agent-generation-results";
import { modelOptionLabel, modelOptionName, normalizeModelOptionValue, resolveModelScript, selectableModelsByCapability, useConfigStore } from "@/stores/use-config-store";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
import { reserveWorkbenchExecution } from "@/services/workbench-execution";

// 平台工具复用工作区服务和 store；资源写入等待服务端确认，工作台生成提交服务端持久任务。

export const SITE_TOOL_NAMES = [
    "platform_get_context",
    ...RESOURCE_TOOL_NAMES,
    ...PROMPT_TOOL_NAMES,
    ...TEMPLATE_TOOL_NAMES,
    ...MEDIA_TOOL_NAMES,
    ...GENERATION_RESULT_TOOL_NAMES,
    "generation_get_status",
    "generation_resume_task",
    "workbench_image_get_config",
    "workbench_image_generate",
    "workbench_video_get_config",
    "workbench_video_generate",
    "prompts_search",
    "assets_add",
] as const;

export type SiteToolName = (typeof SITE_TOOL_NAMES)[number];

export function isSiteTool(name: string): name is SiteToolName {
    return (SITE_TOOL_NAMES as readonly string[]).includes(name);
}

function siteText(key: string, options?: Record<string, unknown>) {
    return i18n.t(`agent.siteTools.${key}`, options);
}

export const SITE_TOOL_LABELS: Record<SiteToolName, string> = {
    get platform_get_context() { return siteText("platformContext"); },
    get canvas_list_projects() { return siteText("canvasList"); },
    get canvas_get_project() { return siteText("canvasGet"); },
    get canvas_create_project() { return siteText("canvasCreate"); },
    get canvas_update_project() { return siteText("canvasUpdate"); },
    get canvas_delete_project() { return siteText("canvasDelete"); },
    get canvas_list_folders() { return siteText("folderList"); },
    get canvas_create_folder() { return siteText("folderCreate"); },
    get canvas_update_folder() { return siteText("folderUpdate"); },
    get canvas_delete_folder() { return siteText("folderDelete"); },
    get generation_get_status() { return siteText("generationStatus"); },
    get generation_resume_task() { return siteText("generationResume"); },
    get workbench_image_get_config() { return siteText("imageConfig"); },
    get workbench_image_generate() { return siteText("imageGenerate"); },
    get workbench_video_get_config() { return siteText("videoConfig"); },
    get workbench_video_generate() { return siteText("videoGenerate"); },
    get prompts_search() { return siteText("promptSearch"); },
    get prompts_list() { return siteText("promptList"); },
    get prompts_get() { return siteText("promptGet"); },
    get prompts_create() { return siteText("promptCreate"); },
    get prompts_update() { return siteText("promptUpdate"); },
    get prompts_delete() { return siteText("promptDelete"); },
    get assets_list() { return siteText("assetList"); },
    get assets_add() { return siteText("assetAdd"); },
    get assets_get() { return siteText("assetGet"); },
    get assets_create() { return siteText("assetAdd"); },
    get assets_update() { return siteText("assetUpdate"); },
    get assets_delete() { return siteText("assetDelete"); },
    get templates_list() { return siteText("templateList"); },
    get templates_get() { return siteText("templateGet"); },
    get templates_create() { return siteText("templateCreate"); },
    get templates_update() { return siteText("templateUpdate"); },
    get templates_delete() { return siteText("templateDelete"); },
    get templates_instantiate() { return siteText("templateInstantiate"); },
    get templates_insert() { return siteText("templateInsert"); },
    get templates_export() { return siteText("templateExport"); },
    get templates_import() { return siteText("templateImport"); },
    get media_get() { return siteText("mediaGet"); },
    get media_import() { return siteText("mediaImport"); },
    get generation_list_results() { return siteText("generationListResults"); },
    get generation_get_result() { return siteText("generationGetResult"); },
};

type SiteToolInput = Record<string, unknown>;
type SiteToolContext = { canvasSnapshot?: CanvasAgentSnapshot | null; templateCanvas?: TemplateCanvasContext };
type GenerationStatus = "idle" | "queued" | "submitting" | "running" | "archiving" | "succeeded" | "partial" | "failed" | "needs_attention";
type GenerationStatusItem = { id: string; source: "canvas" | "image" | "video" | "text" | "audio"; status: GenerationStatus; kind?: string; title?: string; prompt?: string; projectId?: string; createdAt?: string; updatedAt?: string; successCount?: number; failCount?: number; error?: string };
type ScriptIntent = { fingerprint: string; taskId?: string };
const scriptIntents = localforage.createInstance({ name: "infinite-canvas", storeName: "workbench_script_intents" });
const scriptDispatches = new Map<string, { fingerprint: string; operation: Promise<unknown> }>();

export async function runSiteTool(name: SiteToolName, input: SiteToolInput, navigate: NavigateFunction, context: SiteToolContext = {}): Promise<unknown> {
    if (isResourceTool(name)) return runResourceTool(name, input);
    if (isPromptTool(name)) return runPromptTool(name, input);
    if (isTemplateTool(name)) return runTemplateTool(name, input, context.templateCanvas);
    if (isMediaTool(name)) return runMediaTool(name, input);
    if (isGenerationResultTool(name)) return runGenerationResultTool(name, input);
    switch (name) {
        case "platform_get_context": {
            const workspace = getActiveWorkspace();
            if (!workspace) throw new Error("请先选择工作区");
            return { workspace, route: window.location.pathname, siteTools: SITE_TOOL_NAMES, requiresConnectedBrowser: true };
        }
        case "generation_get_status":
            return getGenerationStatus(input, context.canvasSnapshot);
        case "generation_resume_task": {
            const workspaceId = requireAgentWorkspace(input, true).id;
            if (typeof input.taskId !== "string" || !input.taskId) throw new Error("请提供 taskId");
            let scriptTask = useWorkbenchAgentStore.getState().tasks.some((item) => item.id === input.taskId && item.workspaceId === workspaceId);
            if (!scriptTask) await scriptIntents.iterate<ScriptIntent, void>((intent, key) => { if (intent.taskId === input.taskId && key.startsWith(`${workspaceId}:`)) scriptTask = true; });
            if (scriptTask) throw new Error("浏览器脚本任务不支持服务端恢复；请查询状态并核对供应商");
            return { task: await resumeGenerationTask(workspaceId, input.taskId) };
        }
        case "workbench_image_get_config":
            return getImageConfig();
        case "workbench_image_generate":
            return runImageWorkbench(input, navigate);
        case "workbench_video_get_config":
            return getVideoConfig();
        case "workbench_video_generate":
            return runVideoWorkbench(input, navigate);
        case "prompts_search":
            return searchPrompts(input);
        case "assets_add":
            return runResourceTool("assets_create", input);
        default:
            throw new Error(siteText("unknownTool", { name }));
    }
}

async function getGenerationStatus(input: SiteToolInput, canvasSnapshot?: CanvasAgentSnapshot | null) {
    const workspaceId = requireAgentWorkspace(input).id;
    const scope = input.scope === "canvas" || input.scope === "image" || input.scope === "video" || input.scope === "text" || input.scope === "audio" ? input.scope : "all";
    const mediaScope = scope === "image" || scope === "video" || scope === "text" || scope === "audio";
    const taskId = typeof input.taskId === "string" ? input.taskId : "";
    const nodeIds = new Set(Array.isArray(input.nodeIds) ? input.nodeIds.filter((id): id is string => typeof id === "string") : []);
    const limit = Math.max(1, Math.min(100, Math.floor(Number(input.limit)) || 20));
    const tasks: GenerationStatusItem[] = [];
    const requestId = typeof input.requestId === "string" ? input.requestId : "";
    const projectId = typeof input.projectId === "string" ? input.projectId : "";
    const canvasOnly = scope === "canvas" || Boolean(projectId) || nodeIds.size > 0;
    const browserTask = useWorkbenchAgentStore.getState().tasks.find((item) => item.id === taskId && item.workspaceId === workspaceId);
    let browserIntentKind: "image" | "video" | undefined;
    if (taskId && !browserTask) await scriptIntents.iterate<ScriptIntent, void>((intent, key) => {
        if (intent.taskId === taskId && (key.startsWith(`${workspaceId}:image:`) || key.startsWith(`${workspaceId}:video:`))) browserIntentKind = key.startsWith(`${workspaceId}:image:`) ? "image" : "video";
    });
    const kinds = mediaScope ? [scope] : ["image", "video", "text", "audio"] as const;
    const saved = taskId ? browserTask || browserIntentKind ? [] : [await getGenerationTask(workspaceId, taskId)] : (await Promise.all(kinds.map((kind) => listGenerationTasks(workspaceId, kind, { source: canvasOnly ? "canvas" : "all", projectId, requestId })))).flat();
    const matches = (task: (typeof saved)[number]) => (!taskId || task.id === taskId) && (!requestId || task.requestId === requestId)
        && (!mediaScope || task.kind === scope)
        && (!canvasOnly || Boolean(task.canvasTarget)) && (!projectId || task.canvasTarget?.projectId === projectId)
        && (!nodeIds.size || Boolean(task.canvasTarget && nodeIds.has(task.canvasTarget.nodeId)));
    saved.filter(matches).forEach((task) => {
        tasks.push({ ...task, source: task.canvasTarget ? "canvas" : task.kind, projectId: task.canvasTarget?.projectId, prompt: compactPrompt(task.prompt), durable: true } as GenerationStatusItem);
    });

    if (canvasSnapshot && (!projectId || canvasSnapshot.projectId === projectId)) {
        canvasSnapshot.nodes.forEach((node) => {
            if (nodeIds.size && !nodeIds.has(node.id)) return;
            const metadata = node.metadata || {};
            const binding = metadata.generationTask;
            if (binding) {
                if (mediaScope && binding.kind !== scope) return;
                if (binding.workspaceId !== workspaceId || binding.projectId !== canvasSnapshot.projectId || binding.nodeId !== node.id || taskId && binding.taskId !== taskId || requestId && binding.requestId !== requestId) return;
                if (saved.some((task) => matches(task) && task.requestId === binding.requestId)) return;
                tasks.push({ id: binding.taskId || binding.requestId, requestId: binding.requestId, source: "canvas", kind: binding.kind, projectId: binding.projectId, canvasTarget: { projectId: binding.projectId, nodeId: node.id }, status: binding.submissionState === "not_submitted" ? "failed" : "needs_attention", submissionState: binding.submissionState, title: node.title, error: binding.submissionState === "not_submitted" ? "请求确定未受理，可明确发起新生成" : "节点已保存请求绑定，尚未读取到任务；请用原requestId核对，未重新生成", durable: false } as GenerationStatusItem);
                return;
            }
            if (taskId || requestId || mediaScope && (metadata.generationMode || node.type) !== scope) return;
            const status = normalizeCanvasGenerationStatus(metadata.status);
            if (!status) return;
            if (!nodeIds.size && node.type !== "config" && status !== "running" && status !== "failed" && !metadata.generationMode && !metadata.generationType && !metadata.model) return;
            tasks.push({ id: node.id, source: "canvas", status, kind: metadata.generationMode || node.type, title: node.title, prompt: compactPrompt(metadata.prompt || metadata.composerContent), projectId: canvasSnapshot.projectId, error: metadata.errorDetails, durable: false } as GenerationStatusItem);
        });
    }
    if (!canvasOnly && !requestId) {
        useWorkbenchAgentStore.getState().tasks.forEach((task) => {
            if (task.workspaceId !== workspaceId || taskId && task.id !== taskId || scope !== "all" && scope !== task.kind) return;
            tasks.push({ ...task, source: task.kind });
        });
        if (browserIntentKind && (scope === "all" || scope === browserIntentKind)) tasks.push({ id: taskId, source: browserIntentKind, status: "needs_attention", error: "浏览器会话已结束；请核对供应商，不自动重试", execution: "browser", durable: false } as GenerationStatusItem);
    }

    tasks.sort((a, b) => generationStatusOrder(a.status) - generationStatusOrder(b.status) || (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    const summary: Record<GenerationStatus, number> = { idle: 0, queued: 0, submitting: 0, running: 0, archiving: 0, succeeded: 0, partial: 0, failed: 0, needs_attention: 0 };
    tasks.forEach((task) => (summary[task.status] += 1));
    const dispatchErrors = !taskId && canvasSnapshot && (!projectId || canvasSnapshot.projectId === projectId) ? canvasSnapshot.nodes.flatMap((node) => {
        const error = node.metadata?.generationDispatchError;
        return error && (scope === "all" || scope === "canvas" || scope === error.kind) && (!nodeIds.size || nodeIds.has(node.id)) && (!requestId || error.requestId === requestId) ? [{ ...error, projectId: canvasSnapshot.projectId, nodeId: node.id }] : [];
    }) : [];
    return { workspaceId, total: tasks.length, summary, tasks: tasks.slice(0, limit), dispatchErrors };
}

function generationStatusOrder(status: GenerationStatus) {
    return ["submitting", "running", "archiving"].includes(status) ? 0 : status === "queued" ? 1 : 2;
}

function normalizeCanvasGenerationStatus(status: unknown): GenerationStatus | null {
    if (status === "idle") return "idle";
    if (status === "loading") return "running";
    if (status === "success") return "succeeded";
    if (status === "error") return "failed";
    return null;
}

function compactPrompt(prompt: unknown) {
    const value = typeof prompt === "string" ? prompt.trim() : "";
    return value ? `${value.slice(0, 200)}${value.length > 200 ? "..." : ""}` : undefined;
}

function getImageConfig() {
    const { config } = useConfigStore.getState();
    const model = config.imageModel || config.model;
    return {
        current: { model, modelName: modelOptionName(model), execution: resolveModelScript(config, model) ? "browser" : "server", durable: !resolveModelScript(config, model), quality: config.quality || "auto", size: config.size || "1:1", count: config.count || "1" },
        models: selectableModelsByCapability(config, "image").map((value) => ({ value, label: modelOptionLabel(config, value), execution: resolveModelScript(config, value) ? "browser" : "server", durable: !resolveModelScript(config, value) })),
        qualityOptions: imageQualityOptions,
        scaleOptions: imageScaleOptions,
        sizeOptions: imageAspectOptions,
        countRange: { min: 1, max: 15 },
    };
}

async function runImageWorkbench(input: SiteToolInput, navigate: NavigateFunction) {
    const workspaceId = requireAgentWorkspace(input, true).id;
    const configStore = useConfigStore.getState();
    const applied: Record<string, unknown> = {};
    if (typeof input.model === "string" && input.model.trim()) {
        const value = normalizeModelOptionValue(input.model, configStore.config.channels) || input.model;
        configStore.updateConfig("imageModel", value);
        applied.model = value;
    }
    if (typeof input.quality === "string" && input.quality.trim()) {
        configStore.updateConfig("quality", input.quality);
        applied.quality = input.quality;
    }
    if (typeof input.size === "string" && input.size.trim()) {
        configStore.updateConfig("size", input.size);
        applied.size = input.size;
    }
    if (input.count != null) {
        const count = String(Math.max(1, Math.min(15, Math.floor(Number(input.count)) || 1)));
        configStore.updateConfig("count", count);
        applied.count = count;
    }
    const prompt = typeof input.prompt === "string" ? input.prompt : undefined;
    const run = input.run !== false;
    if (!run) { navigate("/image"); useWorkbenchAgentStore.getState().dispatchImage({ prompt, run: false, references: Array.isArray(input.references) ? input.references as GenerationTaskReference[] : undefined }); return { ok: true, navigated: "/image", applied, note: siteText("imageConfigApplied") }; }
    if (typeof input.requestId !== "string" || !input.requestId.trim()) throw new Error("持久化生成必须提供 requestId；未知响应后复用原 ID 核对，不能另建请求");
    const config = useConfigStore.getState().config;
    const selectedModel = config.imageModel || config.model;
    if (!configStore.isAiConfigReady(config, selectedModel)) throw new Error("模型配置尚未就绪或不可用，请读取工作台配置后重试");
    await reserveWorkbenchExecution(workspaceId, "image", input.requestId, resolveModelScript(config, selectedModel) ? "browser" : "server");
    if (resolveModelScript(config, selectedModel)) return dispatchScriptWorkbench("image", workspaceId, input, prompt || "", selectedModel, { quality: config.quality, size: config.size, count: config.count, background: config.background, systemPrompt: config.systemPrompt, script: resolveModelScript(config, selectedModel) }, navigate);
    const task = await submitGenerationTask(workspaceId, { requestId: input.requestId, kind: "image", prompt: prompt || "", model: config.imageModel || config.model, settings: { quality: config.quality, size: config.size, count: config.count, background: config.background, systemPrompt: config.systemPrompt }, references: Array.isArray(input.references) ? input.references as GenerationTaskReference[] : [] });
    navigate("/image");
    return { status: "accepted", workspaceId, taskId: task.id, task, note: "任务已持久化，可断线后按 taskId 继续读取；尚不表示结果已生成" };
}

function getVideoConfig() {
    const { config } = useConfigStore.getState();
    const model = config.videoModel || config.model;
    const seedance = isSeedanceVideoConfig({ ...config, model });
    return {
        current: {
            model,
            modelName: modelOptionName(model),
            execution: resolveModelScript(config, model) ? "browser" : "server",
            durable: !resolveModelScript(config, model),
            size: config.size || "1280x720",
            seconds: config.videoSeconds || "6",
            resolution: config.vquality || "720",
            generateAudio: config.videoGenerateAudio !== "false",
            watermark: config.videoWatermark === "true",
            mode: config.videoMode === "reference" ? "reference" : "frames",
        },
        models: selectableModelsByCapability(config, "video").map((value) => ({ value, label: modelOptionLabel(config, value), execution: resolveModelScript(config, value) ? "browser" : "server", durable: !resolveModelScript(config, value) })),
        sizeOptions: seedance ? seedanceRatioOptions : videoSizeOptions,
        secondsRange: seedance ? { min: 4, max: 15, automatic: -1, options: seedanceDurationOptions } : videoSecondsRange,
        resolutionOptions: seedance ? seedanceResolutionOptions : videoResolutionOptions,
        modeOptions: [
            { value: "frames", label: i18n.t("settingsPanels.video.modes.frames") },
            { value: "reference", label: i18n.t("settingsPanels.video.modes.reference") },
        ],
    };
}

async function runVideoWorkbench(input: SiteToolInput, navigate: NavigateFunction) {
    const workspaceId = requireAgentWorkspace(input, true).id;
    const configStore = useConfigStore.getState();
    const applied: Record<string, unknown> = {};
    if (typeof input.model === "string" && input.model.trim()) {
        const value = normalizeModelOptionValue(input.model, configStore.config.channels) || input.model;
        configStore.updateConfig("videoModel", value);
        applied.model = value;
    }
    if (typeof input.size === "string" && input.size.trim()) {
        configStore.updateConfig("size", input.size);
        applied.size = input.size;
    }
    if (input.seconds != null && String(input.seconds).trim()) {
        const seconds = isSeedanceVideoConfig({ ...configStore.config, model: configStore.config.videoModel })
            ? String(normalizeSeedanceDuration(String(input.seconds)))
            : clampVideoSeconds(String(input.seconds));
        configStore.updateConfig("videoSeconds", seconds);
        applied.seconds = seconds;
    }
    if (typeof input.resolution === "string" && input.resolution.trim()) {
        configStore.updateConfig("vquality", input.resolution);
        applied.resolution = input.resolution;
    }
    if (typeof input.generateAudio === "boolean") {
        configStore.updateConfig("videoGenerateAudio", String(input.generateAudio));
        applied.generateAudio = input.generateAudio;
    }
    if (typeof input.watermark === "boolean") {
        configStore.updateConfig("videoWatermark", String(input.watermark));
        applied.watermark = input.watermark;
    }
    if (input.mode === "frames" || input.mode === "reference") {
        configStore.updateConfig("videoMode", input.mode);
        applied.mode = input.mode;
    }
    const prompt = typeof input.prompt === "string" ? input.prompt : undefined;
    const run = input.run !== false;
    if (!run) { navigate("/video"); useWorkbenchAgentStore.getState().dispatchVideo({ prompt, run: false, references: Array.isArray(input.references) ? input.references as GenerationTaskReference[] : undefined }); return { ok: true, navigated: "/video", applied, note: siteText("videoConfigApplied") }; }
    if (typeof input.requestId !== "string" || !input.requestId.trim()) throw new Error("持久化生成必须提供 requestId；未知响应后复用原 ID 核对，不能另建请求");
    const config = useConfigStore.getState().config;
    const selectedModel = config.videoModel || config.model;
    if (!configStore.isAiConfigReady(config, selectedModel)) throw new Error("模型配置尚未就绪或不可用，请读取工作台配置后重试");
    await reserveWorkbenchExecution(workspaceId, "video", input.requestId, resolveModelScript(config, selectedModel) ? "browser" : "server");
    if (resolveModelScript(config, selectedModel)) return dispatchScriptWorkbench("video", workspaceId, input, prompt || "", selectedModel, { size: config.size, seconds: config.videoSeconds, resolution: config.vquality, generateAudio: config.videoGenerateAudio, watermark: config.videoWatermark, mode: config.videoMode, systemPrompt: config.systemPrompt, script: resolveModelScript(config, selectedModel) }, navigate);
    const task = await submitGenerationTask(workspaceId, { requestId: input.requestId, kind: "video", prompt: prompt || "", model: config.videoModel || config.model, settings: { size: config.size, seconds: config.videoSeconds, resolution: config.vquality, generateAudio: config.videoGenerateAudio !== "false", watermark: config.videoWatermark === "true", mode: config.videoMode, systemPrompt: config.systemPrompt }, references: Array.isArray(input.references) ? input.references as GenerationTaskReference[] : [] });
    navigate("/video");
    return { status: "accepted", workspaceId, taskId: task.id, task, note: "任务已持久化，可断线后按 taskId 继续读取；尚不表示结果已生成" };
}

function dispatchScriptWorkbench(kind: "image" | "video", workspaceId: string, input: SiteToolInput, prompt: string, model: string, settings: Record<string, unknown>, navigate: NavigateFunction) {
    const requestId = String(input.requestId);
    const references = Array.isArray(input.references) ? input.references as GenerationTaskReference[] : [];
    const fingerprint = JSON.stringify({ prompt, model, settings, references });
    const key = `${workspaceId}:${kind}:${requestId}`;
    const pending = scriptDispatches.get(key);
    if (pending) {
        if (pending.fingerprint !== fingerprint) throw new Error("同一 requestId 的脚本生成参数已变化，未再次执行");
        return pending.operation;
    }
    const operation = (async () => {
        const existing = await scriptIntents.getItem<ScriptIntent>(key);
        if (existing) {
            if (existing.fingerprint !== fingerprint) throw new Error("同一 requestId 的脚本生成参数已变化，未再次执行");
            const task = useWorkbenchAgentStore.getState().tasks.find((item) => item.id === existing.taskId && item.workspaceId === workspaceId);
            return { status: task?.status || "needs_attention", execution: "browser", durable: false, workspaceId, requestId, taskId: existing.taskId, note: task ? "浏览器脚本任务已受理；状态仅在当前网页会话可查询" : "浏览器会话已结束，脚本提交状态不明；请核对供应商，不能自动重试" };
        }
        await scriptIntents.setItem(key, { fingerprint });
        navigate(kind === "image" ? "/image" : "/video");
        const store = useWorkbenchAgentStore.getState();
        const command = { prompt, run: true, workspaceId, requestId, references };
        const taskId = kind === "image" ? store.dispatchImage(command) : store.dispatchVideo(command);
        await scriptIntents.setItem(key, { fingerprint, taskId });
        return { status: "accepted", execution: "browser", durable: false, workspaceId, requestId, taskId, note: "脚本生成已交给当前浏览器工作台；关闭页面后不自动恢复或再次计费" };
    })();
    scriptDispatches.set(key, { fingerprint, operation });
    void operation.finally(() => { if (scriptDispatches.get(key)?.operation === operation) scriptDispatches.delete(key); }).catch(() => undefined);
    return operation;
}

async function searchPrompts(input: SiteToolInput) {
    const page = Math.max(1, Math.floor(Number(input.page)) || 1);
    const pageSize = Math.max(1, Math.min(50, Math.floor(Number(input.pageSize)) || 20));
    const tags = Array.isArray(input.tags) ? input.tags.filter((tag): tag is string => typeof tag === "string") : [];
    const result = await fetchPrompts({ keyword: String(input.keyword || ""), category: String(input.category || i18n.t("common.all")), tag: tags, page, pageSize });
    return {
        total: result.total,
        page,
        pageSize,
        categories: result.categories,
        tags: result.tags.slice(0, 60),
        items: result.items.map((prompt) => ({ id: prompt.id, title: prompt.title, prompt: prompt.prompt, category: prompt.category, tags: prompt.tags, coverUrl: prompt.coverUrl, githubUrl: prompt.githubUrl })),
    };
}
