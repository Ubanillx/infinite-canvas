import { create } from "zustand";
import i18n from "@/i18n";

import { CANVAS_AGENT_URL } from "@/constant/runtime-config";
import type { CanvasAgentOp, CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";

export type AgentChatRole = "user" | "assistant" | "system" | "tool" | "error";
export type AgentImageAttachment = { kind: "image"; id: string; name: string; type: string; size: number; width: number; height: number; url: string; dataUrl: string };
export type AgentFileAttachment = { kind: "file"; id: string; name: string; type: string; size: number; fileId: string; uploadState: "uploading" | "ready" | "failed"; progress?: number };
export type AgentAttachment = AgentImageAttachment | AgentFileAttachment;
export type AgentMessageAttachment = { id: string; name: string; kind?: "image" | "file"; url?: string; fileId?: string } & Partial<Pick<AgentImageAttachment, "type" | "size" | "width" | "height" | "dataUrl">>;
export type AgentCanvasReference = Pick<CanvasResourceReference, "nodeId" | "label" | "title" | "kind" | "previewUrl" | "text">;
export type AgentSkillReference = { name: string; path: string; displayName?: string };
/** 排队等待发送的一条消息，保存发送瞬间的输入、附件和画布引用。 */
export type AgentQueuedMessage = {
    id: string;
    /** 发给 Agent 的完整提示词，已拼接附件清单和画布引用说明。 */
    promptText: string;
    /** 输入框里的原始文本，发送失败时回填用。 */
    draftText: string;
    text: string;
    attachments: AgentAttachment[];
    /** 输入框里选择的实时引用，失败回填时需要。 */
    canvasReferences: CanvasResourceReference[];
    /** 消息气泡里展示的引用元数据。 */
    messageReferences: AgentCanvasReference[];
    skill?: AgentSkillReference;
    /** 入队时的 Skill 选择版本，只有它仍然有效时才清除选中状态。 */
    skillRevision?: number;
};
export type AgentChatItem = { id: string; itemId?: string; clientMessageId?: string; threadId?: string; turnId?: string; engine?: AgentEngine; role: AgentChatRole; title?: string; text: string; meta?: string; detail?: unknown; attachments?: AgentMessageAttachment[]; canvasReferences?: AgentCanvasReference[]; skill?: AgentSkillReference; streamId?: string; activityItems?: Record<string, string> };
export type AgentEventLog = { id: string; time: string; title: string; text: string; raw?: unknown };
export type AgentPendingToolCall = { requestId: string; name: string; input?: { ops?: CanvasAgentOp[]; path?: string } & Record<string, unknown> };
export type AgentPermissionMode = "request" | "automatic" | "full";
export type AgentReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type AgentModel = {
    id: string;
    model: string;
    displayName: string;
    defaultReasoningEffort: AgentReasoningEffort;
    supportedReasoningEfforts: Array<{ reasoningEffort: AgentReasoningEffort; description?: string }>;
    isDefault?: boolean;
};
export type AgentApprovalDecision = "accept" | "acceptForSession" | "decline";
export type AgentPendingApproval = { requestId: string; method: string; threadId?: string; turnId?: string; itemId?: string; reason?: string; command?: unknown; cwd?: string; grantRoot?: string; networkApprovalContext?: unknown; permissions?: unknown; deciding?: AgentApprovalDecision };
export type AgentCanvasContext = { snapshot: CanvasAgentSnapshot; applyOps: (ops?: CanvasAgentOp[]) => CanvasAgentSnapshot; undoOps: () => CanvasAgentSnapshot | null; canUndo: boolean };
export type AgentThreadSummary = { id: string; preview: string; name?: string | null; cwd?: string; status?: string; source?: unknown; createdAt?: number; updatedAt?: number };
export type AgentTokenUsage = { input: number; cached: number; output: number };
export type AgentBootstrapStatus = { key: string; text: string; detail: string; status: "running" | "ready" | "error" };
export type AgentConversationState = {
    engine: "codex" | "pi";
    revision: number;
    conversationId: string;
    threadId: string;
    status: "idle" | "preparing" | "ready" | "warning" | "running" | "failed";
    mcpStatuses: Record<string, { status: "starting" | "ready" | "failed" | "cancelled"; error?: string | null; failureReason?: string | null }>;
    sourceClientId?: string;
    error?: string;
};
export type AgentPanelTab = "chat" | "setup" | "history" | "skills" | "log";
export type AgentEngine = "codex" | "pi";

const CONNECT_TIMEOUT_MS = 6000;
const SERVER_MANAGED_AGENT_TOKEN = "server-managed";
let agentSource: EventSource | null = null;
let connectTimer: ReturnType<typeof setTimeout> | null = null;

type AgentStore = {
    width: number;
    panelOpen: boolean;
    panelMounted: boolean;
    panelClosing: boolean;
    canvasContext: AgentCanvasContext | null;
    url: string;
    token: string;
    connected: boolean;
    enabled: boolean;
    silentConnect: boolean;
    fragmentBootstrap: boolean;
    prompt: string;
    attachments: AgentAttachment[];
    canvasReferences: CanvasResourceReference[];
    sending: boolean;
    waiting: boolean;
    /** 待发送队列，仅在当前 turn 运行时累积，完成后按顺序自动发出。 */
    queue: AgentQueuedMessage[];
    messages: AgentChatItem[];
    tokenUsage: AgentTokenUsage | null;
    eventLogs: AgentEventLog[];
    threads: AgentThreadSummary[];
    activeThreadId: string;
    activeTurnId: string;
    workspacePath: string;
    loadingThreads: boolean;
    activeTab: AgentPanelTab;
    engine: AgentEngine;
    confirmTools: boolean;
    permissionMode: AgentPermissionMode;
    models: AgentModel[];
    model: string;
    reasoningEffort: AgentReasoningEffort | "";
    activity: string;
    conversation: AgentConversationState;
    bootstrapStatus: AgentBootstrapStatus | null;
    mcpStartupStatuses: Record<string, AgentBootstrapStatus>;
    connectError: string;
    pendingTool: AgentPendingToolCall | null;
    pendingApprovals: AgentPendingApproval[];
    setAgentState: (patch: Partial<Omit<AgentStore, "setAgentState" | "connectAgent" | "disconnectAgent" | "addMessage" | "addEventLog" | "clearEventLogs" | "openPanel" | "closePanel" | "togglePanel" | "setCanvasContext">>) => void;
    openPanel: () => void;
    closePanel: () => void;
    togglePanel: () => void;
    setCanvasContext: (context: AgentCanvasContext | null) => void;
    connectAgent: (options?: { silent?: boolean }) => void;
    disconnectAgent: (patch?: Partial<Omit<AgentStore, "setAgentState" | "connectAgent" | "disconnectAgent" | "addMessage" | "addEventLog" | "clearEventLogs" | "openPanel" | "closePanel" | "togglePanel" | "setCanvasContext">>) => void;
    addMessage: (item: AgentChatItem) => void;
    addEventLog: (item: AgentEventLog) => void;
    clearEventLogs: () => void;
};

export const CANVAS_AGENT_PANEL_MOTION_MS = 500;

function runtimeAgentUrl() {
    if (typeof window === "undefined" || !CANVAS_AGENT_URL) return "";
    try {
        return new URL(CANVAS_AGENT_URL, window.location.origin).toString().replace(/\/$/, "");
    } catch {
        return "";
    }
}

function defaultAgentUrl() {
    const configured = runtimeAgentUrl();
    if (configured) return configured;
    if (typeof window === "undefined") return "";
    return new URL("/api/canvas-agent", window.location.origin).toString().replace(/\/$/, "");
}

function usesServerManagedAgent() {
    const configured = runtimeAgentUrl();
    return !configured || new URL(configured).origin === window.location.origin;
}

export const useAgentStore = create<AgentStore>((set, get) => ({
    width: typeof window === "undefined" ? 440 : Number(localStorage.getItem("canvas-agent-panel-width")) || 440,
    panelOpen: false,
    panelMounted: true,
    panelClosing: false,
    canvasContext: null,
    url: runtimeAgentUrl() || defaultAgentUrl(),
    token: typeof window === "undefined" ? "" : usesServerManagedAgent() ? SERVER_MANAGED_AGENT_TOKEN : localStorage.getItem("canvas-agent-token") || "",
    connected: false,
    enabled: false,
    silentConnect: false,
    fragmentBootstrap: false,
    prompt: "",
    attachments: [],
    canvasReferences: [],
    sending: false,
    waiting: false,
    queue: [],
    messages: [],
    tokenUsage: null,
    eventLogs: [],
    threads: [],
    activeThreadId: "",
    activeTurnId: "",
    workspacePath: "",
    loadingThreads: false,
    activeTab: "chat",
    engine: typeof window === "undefined" ? "codex" : (localStorage.getItem("canvas-agent-engine") as AgentEngine) || "codex",
    confirmTools: false,
    permissionMode: typeof window === "undefined" ? "request" : (localStorage.getItem("canvas-agent-permission-mode") as AgentPermissionMode) || "request",
    models: [],
    model: typeof window === "undefined" ? "" : localStorage.getItem("canvas-agent-model") || "",
    reasoningEffort: typeof window === "undefined" ? "" : (localStorage.getItem("canvas-agent-reasoning-effort") as AgentReasoningEffort) || "",
    activity: i18n.t("agent.state.ready"),
    conversation: { engine: "codex", revision: 0, conversationId: "", threadId: "", status: "idle", mcpStatuses: {} },
    bootstrapStatus: null,
    mcpStartupStatuses: {},
    connectError: "",
    pendingTool: null,
    pendingApprovals: [],
    setAgentState: (patch) => set((state) => patch.engine && patch.engine !== state.engine ? {
        ...patch,
        messages: [], threads: [], activeThreadId: "", activeTurnId: "", tokenUsage: null,
        models: [], model: "", reasoningEffort: "", loadingThreads: false,
        queue: [],
        pendingTool: null, pendingApprovals: [], bootstrapStatus: null, mcpStartupStatuses: {},
        conversation: { engine: patch.engine, revision: 0, conversationId: "", threadId: "", status: state.connected ? "preparing" : "idle", mcpStatuses: {} },
    } : patch),
    openPanel: () => set({ panelOpen: true, panelMounted: true, panelClosing: false, activeTab: "chat" }),
    closePanel: () => {
        if (!get().panelMounted || get().panelClosing) return;
        set({ panelOpen: false, panelClosing: true });
        setTimeout(() => {
            if (get().panelClosing) set({ panelClosing: false });
        }, CANVAS_AGENT_PANEL_MOTION_MS);
    },
    togglePanel: () => (get().panelOpen ? get().closePanel() : get().openPanel()),
    setCanvasContext: (canvasContext) => set({ canvasContext }),
    connectAgent: (options) => {
        const silent = options?.silent ?? false;
        // Multiple layout effects (and React StrictMode's development
        // remount) can request auto-connect at the same time. Once a
        // connection has been enabled, the panel's SSE effect owns the
        // actual socket; do not rewrite state or start another bootstrap.
        if (get().enabled || get().connected) return;
        const endpoint = get().url.trim().replace(/\/$/, "");
        const token = get().token.trim();
        if (!endpoint || !token) return set({ connectError: silent ? "" : i18n.t("agent.state.connectionRequired") });
        try {
            const parsed = new URL(endpoint);
            if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
        } catch {
            return set({ connectError: silent ? "" : i18n.t("agent.state.invalidUrl") });
        }
        localStorage.setItem("canvas-agent-url", endpoint);
        localStorage.setItem("canvas-agent-token", token);
        // Only set enabled here; LocalAgentPanel's effect owns SSE initialization.
        set({ url: endpoint, token, enabled: true, silentConnect: silent, fragmentBootstrap: false, activity: i18n.t("agent.status.connecting"), connectError: "" });
    },
    disconnectAgent: (patch = {}) => {
        agentSource?.close();
        agentSource = null;
        if (connectTimer) clearTimeout(connectTimer);
        connectTimer = null;
        set({ enabled: false, connected: false, silentConnect: false, fragmentBootstrap: false, activity: i18n.t("agent.state.offline"), conversation: { engine: get().engine, revision: 0, conversationId: "", threadId: "", status: "idle", mcpStatuses: {} }, bootstrapStatus: null, mcpStartupStatuses: {}, ...patch });
    },
    addMessage: (item) => set((state) => ({ messages: [...state.messages, item] })),
    addEventLog: (item) => set((state) => ({ eventLogs: [...state.eventLogs.slice(-160), item] })),
    clearEventLogs: () => set({ eventLogs: [] }),
}));
