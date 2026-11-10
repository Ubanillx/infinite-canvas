import { create } from "zustand";
import { nanoid } from "nanoid";

// The Agent panel dispatches commands through this store to set workbench prompts and optionally start generation.
// The panel writes model, quality, size, count, and other options to use-config-store, which workbench pages read directly.
// Prompt and run are sent here; pages identify new commands by nonce and call clear after consuming them.

export type WorkbenchCommand = {
    nonce: number;
    taskId?: string;
    prompt?: string;
    run: boolean;
    references?: Array<{ kind: "image" | "video" | "audio"; storageKey: string; name?: string; mimeType?: string; width?: number; height?: number; durationMs?: number }>;
};

export type WorkbenchGenerationTask = {
    id: string;
    kind: "image" | "video";
    status: "queued" | "running" | "succeeded" | "failed";
    prompt?: string;
    createdAt: string;
    updatedAt: string;
    successCount?: number;
    failCount?: number;
    error?: string;
    workspaceId?: string;
    requestId?: string;
    execution?: "browser";
};

type WorkbenchAgentStore = {
    imageCommand: WorkbenchCommand | null;
    videoCommand: WorkbenchCommand | null;
    tasks: WorkbenchGenerationTask[];
    dispatchImage: (command: Omit<WorkbenchCommand, "nonce" | "taskId"> & { workspaceId?: string; requestId?: string }) => string | undefined;
    dispatchVideo: (command: Omit<WorkbenchCommand, "nonce" | "taskId"> & { workspaceId?: string; requestId?: string }) => string | undefined;
    updateTask: (id: string, patch: Partial<Pick<WorkbenchGenerationTask, "status" | "successCount" | "failCount" | "error">>) => void;
    clearImageCommand: () => void;
    clearVideoCommand: () => void;
};

let nonce = 0;
const nextNonce = () => (nonce += 1);

export const useWorkbenchAgentStore = create<WorkbenchAgentStore>((set) => ({
    imageCommand: null,
    videoCommand: null,
    tasks: [],
    dispatchImage: (command) => {
        const commandNonce = nextNonce();
        const task = command.run ? createTask("image", command.prompt, command.workspaceId, command.requestId) : undefined;
        set((state) => ({ imageCommand: { ...command, nonce: commandNonce, taskId: task?.id }, tasks: task ? [task, ...state.tasks].slice(0, 30) : state.tasks }));
        return task?.id;
    },
    dispatchVideo: (command) => {
        const commandNonce = nextNonce();
        const task = command.run ? createTask("video", command.prompt, command.workspaceId, command.requestId) : undefined;
        set((state) => ({ videoCommand: { ...command, nonce: commandNonce, taskId: task?.id }, tasks: task ? [task, ...state.tasks].slice(0, 30) : state.tasks }));
        return task?.id;
    },
    updateTask: (id, patch) => set((state) => ({ tasks: state.tasks.map((task) => (task.id === id ? { ...task, ...patch, updatedAt: new Date().toISOString() } : task)) })),
    clearImageCommand: () => set({ imageCommand: null }),
    clearVideoCommand: () => set({ videoCommand: null }),
}));

function createTask(kind: "image" | "video", prompt?: string, workspaceId?: string, requestId?: string): WorkbenchGenerationTask {
    const now = new Date().toISOString();
    return { id: `${kind}-${nanoid()}`, kind, status: "queued", prompt, createdAt: now, updatedAt: now, workspaceId, requestId, execution: "browser" };
}
