import { useCallback, useEffect, useLayoutEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { flushSync } from "react-dom";
import { nanoid } from "nanoid";
import { getActiveWorkspace } from "@/lib/workspace";
import { hydrateCanvasTaskOutputDimensions, matchesCanvasTask, projectCanvasTask } from "@/lib/canvas/canvas-generation-tasks";
import { avoidCanvasNodeOverlap } from "@/lib/canvas/canvas-node-placement";
import { uploadImage } from "@/services/image-storage";
import { uploadMediaFile } from "@/services/file-storage";
import { getGenerationTask, getGenerationTaskByRequestId, listCanvasGenerationTasks, submitGenerationTask } from "@/services/api/generation-tasks";
import { flushCanvasSave, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import type { AiConfig } from "@/stores/use-config-store";
import type { CanvasConnection, CanvasGenerationTaskBinding, CanvasNodeData } from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import { isGenerationTaskActive, type GenerationTask, type GenerationTaskReference } from "@/types/generation-task";
import { notifyImageTaskRetry } from "@/lib/image-retry-notice";

type Options = { projectId: string; loaded: boolean; nodes: CanvasNodeData[]; nodesRef: MutableRefObject<CanvasNodeData[]>; connectionsRef: MutableRefObject<CanvasConnection[]>; setNodes: Dispatch<SetStateAction<CanvasNodeData[]>> };
type RunInput = { requestId?: string; requestFingerprint?: string; nodeId: string; kind: CanvasGenerationTaskBinding["kind"]; config: AiConfig; prompt: string; images?: ReferenceImage[]; videos?: ReferenceVideo[]; audios?: ReferenceAudio[]; slotIds?: string[]; preservePrimary?: boolean; signal: AbortSignal; originNodeId?: string };

export function useCanvasGenerationTasks({ projectId, loaded, nodes, nodesRef, connectionsRef, setNodes }: Options) {
    const workspaceId = useRef(getActiveWorkspace()?.id).current;
    const active = useRef(true);
    const watches = useRef(new Map<string, { stop: () => void; binding: CanvasGenerationTaskBinding; originNodeId: string }>());
    const taskRetryCounts = useRef(new Map<string, number>());
    const submissions = useRef(new Map<string, CanvasGenerationTaskBinding>());
    const invalidated = useRef(new Set<string>());
    const current = useCallback(() => active.current && Boolean(workspaceId) && getActiveWorkspace()?.id === workspaceId, [workspaceId]);
    const owns = useCallback((binding: CanvasGenerationTaskBinding) => current() && !invalidated.current.has(binding.requestId) && binding.workspaceId === workspaceId && binding.projectId === projectId && nodesRef.current.some((node) => matchesCanvasTask(node, binding)), [current, nodesRef, projectId, workspaceId]);
    const update = useCallback((binding: CanvasGenerationTaskBinding, transform: (node: CanvasNodeData) => CanvasNodeData) => {
        if (owns(binding)) setNodes((items) => {
            if (!current() || invalidated.current.has(binding.requestId)) return items;
            const resized = new Set<string>();
            const next = items.map((node) => {
                if (!matchesCanvasTask(node, binding)) return node;
                const updated = transform(node);
                if (updated.width !== node.width || updated.height !== node.height) resized.add(node.id);
                return updated;
            });
            return resized.size ? avoidCanvasNodeOverlap(next, resized) : next;
        });
    }, [current, owns, setNodes]);
    const interrupted = useCallback((binding: CanvasGenerationTaskBinding, details: string) => {
        update(binding, (node) => {
            const texts = binding.kind === "text" ? node.metadata?.texts?.map((text) => binding.slotIds.includes(text.id) && text.status === "loading" ? { ...text, status: "error" as const, errorDetails: details } : text) : node.metadata?.texts;
            const hasResult = binding.kind === "text" ? texts?.some((text) => text.status === "success") : Boolean(node.metadata?.content);
            return { ...node, metadata: { ...node.metadata, texts, status: hasResult ? "success" : "error", errorDetails: details } };
        });
        if (owns(binding)) setNodes((items) => current() && items.some((node) => matchesCanvasTask(node, binding)) ? items.map((node) => node.id === binding.originNodeId && node.id !== binding.nodeId && node.type === "config" && node.metadata?.status === "loading" ? { ...node, metadata: { ...node.metadata, status: "error" as const, errorDetails: details } } : node) : items);
    }, [current, owns, setNodes, update]);

    const watch = useCallback((binding: CanvasGenerationTaskBinding, initial: GenerationTask, signal?: AbortSignal, originNodeId = binding.originNodeId || binding.nodeId): Promise<void> => {
        watches.current.get(binding.nodeId)?.stop();
        return new Promise((resolve) => {
            let busy = false;
            let stopped = false;
            let timer: ReturnType<typeof setInterval> | undefined;
            const mediaController = new AbortController();
            const stop = () => {
                if (stopped) return;
                stopped = true;
                mediaController.abort();
                if (timer) clearInterval(timer);
                signal?.removeEventListener("abort", stop);
                if (watches.current.get(binding.nodeId)?.stop === stop) watches.current.delete(binding.nodeId);
                resolve();
            };
            watches.current.set(binding.nodeId, { stop, binding, originNodeId });
            signal?.addEventListener("abort", stop, { once: true });
            let latest = initial;
            let firstApply = true;
            const dimensions = new Map<string, { width?: number; height?: number; durationMs?: number }>();
            const decoding = new Set<string>();
            const decoded = new Set<string>();
            const publish = () => {
                if (stopped || signal?.aborted || !owns(binding)) return stop();
                const task = { ...latest, outputs: latest.outputs.map((output) => ({ ...output, ...dimensions.get(output.storageKey) })) };
                update(binding, (node) => projectCanvasTask(node, binding, task));
            };
            const apply = (task: GenerationTask) => {
                if (stopped || signal?.aborted || !owns(binding)) return stop();
                if (!nodesRef.current.some((node) => matchesCanvasTask(node, binding, task))) return stop();
                if (task.revision < latest.revision) return;
                latest = task;
                if (firstApply) {
                    firstApply = false;
                    taskRetryCounts.current.set(task.id, task.retryCount || 0);
                } else notifyImageTaskRetry(taskRetryCounts.current, task);
                // Metadata decoding must not occupy the GET polling slot or hide a stable result.
                publish();
                for (const output of task.outputs) {
                    if (task.kind === "text" || (task.kind === "audio" ? output.durationMs !== undefined : output.width && output.height) || decoded.has(output.storageKey) || decoding.has(output.storageKey)) continue;
                    decoding.add(output.storageKey);
                    void hydrateCanvasTaskOutputDimensions({ ...task, outputs: [output] }, mediaController.signal).then((hydrated) => {
                        const meta = hydrated.outputs[0];
                        if (stopped || signal?.aborted || !owns(binding)) return;
                        if ((meta.width && meta.height) || meta.durationMs !== undefined) dimensions.set(output.storageKey, { width: meta.width, height: meta.height, durationMs: meta.durationMs });
                        publish(); // Always use the newest task revision, never the decoded snapshot's status or output list.
                    }).catch(() => undefined).finally(() => {
                        decoding.delete(output.storageKey);
                        decoded.add(output.storageKey);
                        if (!stopped && !isGenerationTaskActive(latest) && !decoding.size) stop();
                    });
                }
                if (!isGenerationTaskActive(task)) {
                    setNodes((items) => current() && items.some((node) => matchesCanvasTask(node, binding, task)) ? items.map((node) => node.id === binding.originNodeId && node.id !== binding.nodeId && node.type === "config" && !node.metadata?.generationTask ? { ...node, metadata: { ...node.metadata, status: task.outputs.length || task.textOutputs?.some((output) => output.status === "succeeded") ? "success" as const : "error" as const, errorDetails: task.error } } : node) : items);
                    if (timer) clearInterval(timer);
                    resolve(); // The task is readable now; optional metadata can finish under the same cleanup/owner guard.
                    if (!decoding.size) stop();
                }
            };
            apply(initial);
            if (stopped || !isGenerationTaskActive(latest)) return;
            // Same refresh cadence as both generation workbenches; no submission retries or polling limit.
            timer = setInterval(() => {
                if (busy || stopped) return;
                if (!owns(binding)) return stop();
                busy = true;
                void getGenerationTask(binding.workspaceId, initial.id).then(apply).catch(() => {
                    if (!stopped) interrupted(binding, "连接中断，任务可能仍在服务端执行；重新打开画布或重试以核对原任务");
                    stop();
                }).finally(() => { busy = false; });
            }, 2500);
        });
    }, [current, interrupted, nodesRef, owns, setNodes, update]);

    const recover = useCallback(async (node: CanvasNodeData) => {
        const binding = node.metadata?.generationTask;
        if (!binding || !owns(binding) || binding.submissionState === "not_submitted") return;
        submissions.current.set(binding.requestId, binding);
        try {
            const task = await getGenerationTaskByRequestId(binding.workspaceId, binding.requestId, { projectId, nodeId: binding.nodeId });
            if (!owns(binding)) return;
            if (!task) { interrupted(binding, "未找到原请求回执，未自动重新提交；请核对生成记录后明确重新生成"); return; }
            await watch(binding, task);
        } catch { interrupted(binding, "原任务核对失败，未重新提交；请恢复连接后重试"); }
    }, [interrupted, owns, projectId, watch]);

    useEffect(() => {
        active.current = true;
        return () => { active.current = false; watches.current.forEach((watch) => watch.stop()); };
    }, []);
    useLayoutEffect(() => {
        submissions.current.forEach((binding) => { if (!nodes.some((node) => matchesCanvasTask(node, binding))) invalidated.current.add(binding.requestId); });
        watches.current.forEach((watch) => { if (!nodes.some((node) => matchesCanvasTask(node, watch.binding))) watch.stop(); });
    }, [nodes]);
    useEffect(() => {
        if (!loaded || !workspaceId) return;
        let valid = true;
        nodesRef.current.forEach((node) => { if (node.metadata?.generationTask) submissions.current.set(node.metadata.generationTask.requestId, node.metadata.generationTask); });
        void listCanvasGenerationTasks(workspaceId, projectId).then((tasks) => {
            if (!valid || !current()) return;
            nodesRef.current.forEach((node) => {
                const binding = node.metadata?.generationTask;
                if (!binding || !owns(binding) || binding.submissionState === "not_submitted") return;
                const task = tasks.find((task) => matchesCanvasTask(node, binding, task));
                if (task) void watch(binding, task);
                else void recover(node);
            });
        }).catch(() => {
            if (valid) nodesRef.current.forEach((node) => { if (node.metadata?.generationTask) interrupted(node.metadata.generationTask, "任务恢复读取失败，请恢复连接后重试核对原任务"); });
        });
        return () => { valid = false; };
    }, [current, interrupted, loaded, nodesRef, owns, projectId, recover, watch, workspaceId]);

    const run = useCallback(async (input: RunInput) => {
        if (!current() || !workspaceId || input.signal.aborted) throw new DOMException("生成已停止", "AbortError");
        const references: GenerationTaskReference[] = [];
        for (const image of input.images || []) {
            const stored = image.storageKey ? image : { ...image, ...(await uploadImage(image.dataUrl)) };
            references.push({ kind: "image", storageKey: stored.storageKey!, name: image.name, mimeType: image.type });
        }
        for (const [kind, items] of [["video", input.videos || []], ["audio", input.audios || []]] as const) {
            for (const item of items) {
                const stored = item.storageKey ? item : await uploadMediaFile(item.url, kind);
                references.push({ kind, storageKey: stored.storageKey!, name: item.name, mimeType: item.type, durationMs: item.durationMs });
            }
        }
        if (!current() || input.signal.aborted) throw new DOMException("生成已停止", "AbortError");
        const binding: CanvasGenerationTaskBinding = { requestId: input.requestId || nanoid(), workspaceId, projectId, nodeId: input.nodeId, originNodeId: input.originNodeId, requestFingerprint: input.requestFingerprint, kind: input.kind, slotIds: input.slotIds || [nanoid()], preservePrimary: input.preservePrimary, references, status: "queued", ...((input.kind === "text" || input.kind === "audio") ? { retryInput: { prompt: input.prompt, model: input.config.model, systemPrompt: input.config.systemPrompt, reasoningEffort: input.config.reasoningEffort, audioVoice: input.config.audioVoice, audioFormat: input.config.audioFormat, audioSpeed: input.config.audioSpeed, audioInstructions: input.config.audioInstructions } } : {}) };
        // Flush pending node/connection creation before saving the request marker. The POST is forbidden until its save is acknowledged.
        flushSync(() => setNodes((items) => items.map((node) => node.id === input.nodeId ? { ...node, metadata: { ...node.metadata, generationTask: binding, images: binding.kind === "image" ? [...(node.metadata?.images || []).map((image) => binding.slotIds.includes(image.id) ? { ...image, status: "loading" as const, errorDetails: undefined } : image), ...binding.slotIds.filter((id) => !node.metadata?.images?.some((image) => image.id === id)).map((id) => ({ id, status: "loading" as const, content: "", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "" }))] : node.metadata?.images, texts: binding.kind === "text" ? [...(node.metadata?.texts || []).map((text) => binding.slotIds.includes(text.id) ? { ...text, status: "loading" as const, content: "", errorDetails: undefined } : text), ...binding.slotIds.filter((id) => !node.metadata?.texts?.some((text) => text.id === id)).map((id) => ({ id, status: "loading" as const, content: "" }))] : node.metadata?.texts } } : node)));
        submissions.current.set(binding.requestId, binding);
        if (!owns(binding)) throw new DOMException("生成目标已变化", "AbortError");
        const markNotSubmitted = async (details: string) => {
            if (!owns(binding)) return;
            flushSync(() => {
                update(binding, (node) => ({ ...node, metadata: { ...node.metadata, generationTask: { ...binding, status: "failed", submissionState: "not_submitted" }, status: node.metadata?.content ? "success" : "error", errorDetails: details, images: node.metadata?.images?.map((image) => binding.slotIds.includes(image.id) ? { ...image, status: "error", errorDetails: details } : image), texts: node.metadata?.texts?.map((text) => binding.slotIds.includes(text.id) ? { ...text, status: "error", errorDetails: details } : text) } }));
                interrupted(binding, details);
            });
            if (!owns(binding)) return;
            useCanvasStore.getState().updateProject(projectId, { nodes: nodesRef.current, connections: connectionsRef.current });
            await flushCanvasSave(workspaceId).catch(() => undefined);
        };
        useCanvasStore.getState().updateProject(projectId, { nodes: nodesRef.current, connections: connectionsRef.current });
        try { await flushCanvasSave(workspaceId); }
        catch (error) {
            await markNotSubmitted("画布保存失败，未提交生成任务；可重新生成");
            throw error;
        }
        if (!owns(binding) || input.signal.aborted) {
            await markNotSubmitted("已在提交前停止，未创建服务端任务；可重新生成");
            throw new DOMException("生成目标已变化", "AbortError");
        }
        const config = input.config;
        const settings = input.kind === "text"
            ? { count: binding.slotIds.length, systemPrompt: config.systemPrompt, reasoningEffort: config.reasoningEffort }
            : input.kind === "audio"
            ? { voice: config.audioVoice, format: config.audioFormat, speed: config.audioSpeed, instructions: config.audioInstructions }
            : input.kind === "image"
            ? { quality: config.quality, size: config.size, count: binding.slotIds.length, background: config.background, systemPrompt: config.systemPrompt }
            : { size: config.size, resolution: config.vquality, seconds: config.videoSeconds, generateAudio: config.videoGenerateAudio === "true", watermark: config.videoWatermark === "true", mode: config.videoMode, systemPrompt: config.systemPrompt };
        try {
            const task = await submitGenerationTask(workspaceId, { requestId: binding.requestId, kind: input.kind, prompt: input.prompt, model: config.model, settings, references, canvasTarget: { projectId, nodeId: input.nodeId } });
            if (!owns(binding) || input.signal.aborted) return;
            await watch(binding, task, input.signal, input.originNodeId);
        } catch (error) {
            if ((error as { status?: number }).status === 400) {
                await markNotSubmitted(error instanceof Error ? error.message : "生成参数未通过校验，未提交任务");
            } else interrupted(binding, "提交回执未确认，原请求 ID 已保留；重试仅核对原任务，不会再次提交");
        }
    }, [connectionsRef, current, interrupted, nodesRef, owns, projectId, setNodes, update, watch, workspaceId]);

    const stop = useCallback((nodeId: string) => {
        watches.current.forEach((watch) => {
            if (watch.binding.nodeId === nodeId || watch.originNodeId === nodeId) {
                watch.stop();
                interrupted(watch.binding, "已停止本页等待，服务端任务仍可能继续执行和计费；重试可读取原任务结果");
            }
        });
    }, [interrupted]);
    return { run, recover, stop };
}
