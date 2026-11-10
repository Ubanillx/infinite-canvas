export type GenerationTaskKind = "image" | "video" | "text" | "audio";
export type GenerationTaskCanvasTarget = { projectId: string; nodeId: string };
export type GenerationTaskFilter = { source?: "all" | "workbench" | "canvas"; projectId?: string; nodeId?: string; requestId?: string };
export type GenerationTaskStatus = "queued" | "submitting" | "running" | "archiving" | "succeeded" | "partial" | "failed" | "needs_attention";

export type GenerationTaskReference = {
    kind: "image" | "video" | "audio";
    storageKey: string;
    name?: string;
    mimeType?: string;
    width?: number;
    height?: number;
    durationMs?: number;
};

export type GenerationTaskOutput = {
    id: string;
    slotIndex?: number;
    storageKey: string;
    mimeType: string;
    bytes: number;
    width?: number;
    height?: number;
    durationMs?: number;
};

export type GenerationTaskTextOutput = { id: string; slotIndex: number; content: string; status: "running" | "succeeded" | "needs_attention" };

export type GenerationTask = {
    id: string;
    requestId: string;
    workspaceId: string;
    kind: GenerationTaskKind;
    prompt: string;
    model: string;
    settings: Record<string, unknown>;
    references: GenerationTaskReference[];
    canvasTarget?: GenerationTaskCanvasTarget;
    status: GenerationTaskStatus;
    phase?: string;
    outputs: GenerationTaskOutput[];
    textOutputs?: GenerationTaskTextOutput[];
    successCount: number;
    failCount: number;
    error?: string;
    errorCode?: string;
    createdAt: string;
    updatedAt: string;
    revision: number;
};

export type CreateGenerationTask = Pick<GenerationTask, "requestId" | "kind" | "prompt" | "model" | "settings" | "canvasTarget"> & { references: GenerationTaskReference[] };

export function isGenerationTaskActive(task: GenerationTask) {
    return ["queued", "submitting", "running", "archiving"].includes(task.status);
}
