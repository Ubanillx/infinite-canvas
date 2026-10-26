import i18n from "@/i18n";
import { getActiveWorkspace, workspaceHeaders } from "@/lib/workspace";
import type { CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import type { AgentConversationState, AgentReasoningEffort } from "@/stores/use-agent-store";
import { bindAgentTurnAttachments, persistAgentTurnAttachments, releaseAgentThreadAttachments, restoreAgentAttachments, type AgentAttachmentMessage, type AgentAttachmentTurn } from "./agent-attachments";

type AgentConfigResponse = { ok?: boolean; protocolVersion?: number; url?: string; token?: string; hasToken?: boolean };
const AGENT_MESSAGE_ASSET_PATTERN = /^agent-asset:([a-f0-9]{64})\/([a-f0-9]{64}\.(?:gif|jpe?g|png|webp))$/;

// Configuration discovery is only a bootstrap operation. React can mount the
// panel more than once (and several callers may race during startup), so keep
// one request per endpoint in flight and briefly cache the result. Failed
// probes are also cooled down to avoid a tight retry loop when the agent is
// temporarily unavailable.
const AGENT_CONFIG_CACHE_TTL_MS = 30_000;
const AGENT_CONFIG_FAILURE_COOLDOWN_MS = 5_000;
const agentConfigCache = new Map<string, { value: AgentConfigResponse | null; expiresAt: number }>();
const agentConfigInFlight = new Map<string, Promise<AgentConfigResponse | null>>();

export class AgentApiError<T = unknown> extends Error {
    constructor(readonly status: number, readonly response: T & { code?: string; error?: string; msg?: string }) {
        super(response.error || response.msg || i18n.t("agent.state.requestFailed"));
        this.name = "AgentApiError";
    }
}

export type AgentSkillScope = "user" | "repo" | "system" | "admin";
export type AgentSkillInterface = { displayName?: string | null; shortDescription?: string | null; defaultPrompt?: string | null };
export type AgentSkillSummary = {
    name: string;
    description: string;
    shortDescription?: string | null;
    interface?: AgentSkillInterface | null;
    dependencies?: unknown;
    path: string;
    scope: AgentSkillScope;
    enabled: boolean;
    managed: boolean;
};
export type AgentSkillDetail = {
    name: string;
    description: string;
    instructions: string;
    interface?: AgentSkillInterface | null;
    path: string;
    managed: true;
    revision: string;
};
export type AgentSkillInput = { name?: string; description: string; instructions: string; interface?: AgentSkillInterface | null; expectedRevision?: string };
export type AgentSkillDraft = { name: string; displayName: string; description: string; instructions: string; shortDescription: string; defaultPrompt: string };
export type AgentSkillDraftInput = { source: "conversation" | "canvas"; threadId: string; clientId: string; model?: string; effort?: AgentReasoningEffort };
export type AgentSkillsResponse = { ok?: boolean; data?: AgentSkillSummary[]; errors?: unknown[] };
export type AgentSkillResponse = { ok?: boolean; data?: AgentSkillDetail };
export type AgentSkillDraftResponse = { ok?: boolean; data?: AgentSkillDraft };
export type AgentModelsResponse = { ok?: boolean; data?: Array<{ id: string; model: string; displayName: string; defaultReasoningEffort: AgentReasoningEffort; supportedReasoningEfforts: Array<{ reasoningEffort: AgentReasoningEffort; description?: string }>; isDefault?: boolean }> };
export type AgentPiThread = { id: string; preview: string; name: string | null; cwd: string; status: string; createdAt: number; updatedAt: number };
export type AgentPiThreadsResponse = { ok?: boolean; workspace?: { workspacePath: string; activeThreadId?: string }; conversation?: AgentConversationStatePayload; data?: AgentPiThread[]; thread?: AgentPiThread; messages?: unknown[] };
export type AgentPiThreadResponse = { ok?: boolean; workspace?: { workspacePath: string; activeThreadId?: string }; conversation?: AgentConversationStatePayload; thread?: AgentPiThread; messages?: unknown[]; settledTurnIds?: string[] };
type AgentConversationStatePayload = AgentConversationState;

export async function postState(endpoint: string, token: string, clientId: string, snapshot: CanvasAgentSnapshot | null) {
    try {
        const response = await fetch(`${endpoint}/canvas/state?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}${workspaceQuerySuffix()}`, {
            method: "POST",
            headers: { "content-type": "application/json", ...workspaceHeaders() },
            body: JSON.stringify(snapshot ? { ...snapshot, hasCanvas: true } : { hasCanvas: false }),
        });
        return response.ok;
    } catch {
        return false;
    }
}

export async function activateAgentClient(endpoint: string, token: string, clientId: string) {
    try {
        await fetch(`${endpoint}/canvas/activate?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}${workspaceQuerySuffix()}`, { method: "POST", headers: workspaceHeaders() });
    } catch {}
}

export async function postToolResult(endpoint: string, token: string, clientId: string, body: { requestId: string; result?: unknown; error?: string }) {
    await fetchAgentJson(endpoint, token, `/canvas/result?clientId=${encodeURIComponent(clientId)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

export async function postCodexApproval(endpoint: string, token: string, requestId: string, decision: "accept" | "acceptForSession" | "decline") {
    await fetchAgentJson(endpoint, token, "/agent/codex/approval", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId, decision }) });
}

export async function interruptCodexTurn(endpoint: string, token: string, threadId?: string) {
    await fetchAgentJson(endpoint, token, "/agent/codex/interrupt", jsonPost({ threadId }));
}

export async function interruptPiTurn(endpoint: string, token: string) {
    await fetchAgentJson(endpoint, token, "/agent/pi/interrupt", jsonPost({}));
}

export function fetchPiModels(endpoint: string, token: string) {
    return fetchAgentJson<AgentModelsResponse>(endpoint, token, "/agent/pi/models");
}

export function fetchPiThreads(endpoint: string, token: string) {
    return fetchAgentJson<AgentPiThreadsResponse>(endpoint, token, "/agent/pi/threads");
}

export function fetchPiThread(endpoint: string, token: string, threadId: string) {
    return fetchAgentJson<AgentPiThreadResponse>(endpoint, token, `/agent/pi/threads/${encodeURIComponent(threadId)}`);
}

export function createPiThread(endpoint: string, token: string, clientId: string) {
    return fetchAgentJson<AgentPiThreadsResponse>(endpoint, token, "/agent/pi/threads/new", jsonPost({ clientId }));
}

export function resumePiThread(endpoint: string, token: string, threadId: string, clientId: string) {
    return fetchAgentJson<AgentPiThreadResponse>(endpoint, token, `/agent/pi/threads/${encodeURIComponent(threadId)}/resume`, jsonPost({ clientId }));
}

export function deletePiThread(endpoint: string, token: string, threadId: string) {
    return fetchAgentJson<AgentPiThreadsResponse>(endpoint, token, `/agent/pi/threads/${encodeURIComponent(threadId)}/delete`, jsonPost({}));
}

export async function acknowledgeCodexHistory(endpoint: string, token: string, threadId: string, turnIds: string[]) {
    await fetchAgentJson(endpoint, token, "/agent/codex/history/ack", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId, turnIds }) });
}

export async function revealAgentLocalFile(endpoint: string, token: string, path: string) {
    await fetchAgentJson(endpoint, token, "/agent/local-file/reveal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) });
}

export function resolveAgentMessageAssetUrl(endpoint: string, token: string, value: string) {
    const match = AGENT_MESSAGE_ASSET_PATTERN.exec(value);
    if (!match) return value.startsWith("agent-asset:") ? "" : value;
    const baseUrl = endpoint.trim().replace(/\/$/, "");
    const workspace = getActiveWorkspace();
    const workspaceQuery = workspace ? `&workspaceId=${encodeURIComponent(workspace.id)}` : "";
    return baseUrl && token ? `${baseUrl}/agent/message-assets/${match[1]}/${match[2]}?token=${encodeURIComponent(token)}${workspaceQuery}` : "";
}

export function fetchCodexSkills(endpoint: string, token: string, forceReload = false) {
    return fetchAgentJson<AgentSkillsResponse>(endpoint, token, `/agent/codex/skills${forceReload ? "?forceReload=1" : ""}`);
}

/** 按当前引擎读取技能列表；两个引擎返回同一套结构，网页技能页可以共用。 */
export function fetchAgentSkills(endpoint: string, token: string, engine: "codex" | "pi", forceReload = false) {
    return engine === "pi"
        ? fetchAgentJson<AgentSkillsResponse>(endpoint, token, "/agent/pi/skills")
        : fetchCodexSkills(endpoint, token, forceReload);
}

/** Pi 引擎只支持启停，编辑和删除仍由文件系统或 Codex 技能页负责。 */
export function setPiSkillEnabled(endpoint: string, token: string, skill: Pick<AgentSkillSummary, "name">, enabled: boolean) {
    return fetchAgentJson<{ ok?: boolean; data?: AgentSkillSummary[] }>(endpoint, token, `/agent/pi/skills/${encodeURIComponent(skill.name)}/enabled`, jsonPost({ enabled }));
}

export function fetchCodexSkill(endpoint: string, token: string, name: string) {
    return fetchAgentJson<AgentSkillResponse>(endpoint, token, `/agent/codex/skills/${encodeURIComponent(name)}`);
}

export function createCodexSkill(endpoint: string, token: string, input: AgentSkillInput) {
    return fetchAgentJson<AgentSkillResponse>(endpoint, token, "/agent/codex/skills", jsonPost(input));
}

export function createCodexSkillDraft(endpoint: string, token: string, input: AgentSkillDraftInput) {
    return fetchAgentJson<AgentSkillDraftResponse>(endpoint, token, "/agent/codex/skills/draft", jsonPost(input));
}

export function updateCodexSkill(endpoint: string, token: string, name: string, input: AgentSkillInput) {
    return fetchAgentJson<AgentSkillResponse>(endpoint, token, `/agent/codex/skills/${encodeURIComponent(name)}`, jsonPost(input));
}

export function deleteCodexSkill(endpoint: string, token: string, name: string, expectedRevision: string) {
    return fetchAgentJson<{ ok?: boolean }>(endpoint, token, `/agent/codex/skills/${encodeURIComponent(name)}/delete`, jsonPost({ expectedRevision }));
}

export function setCodexSkillEnabled(endpoint: string, token: string, skill: Pick<AgentSkillSummary, "name" | "path">, enabled: boolean) {
    return fetchAgentJson<{ ok?: boolean }>(endpoint, token, `/agent/codex/skills/${encodeURIComponent(skill.name)}/enabled`, jsonPost({ ...skill, enabled }));
}

export async function fetchAgentJson<T>(endpoint: string, token: string, path: string, init?: RequestInit) {
    const workspace = getActiveWorkspace();
    const workspaceId = workspace?.id || "";
    const turn = /^\/agent\/(codex|pi)\/turn$/.exec(path);
    const body: AgentAttachmentTurn | null = turn && typeof init?.body === "string" ? JSON.parse(init.body) : null;
    const persisted = body && await persistAgentTurnAttachments(workspaceId, turn![1], body);
    if (getActiveWorkspace()?.id !== (workspaceId || undefined)) throw new Error("工作区已切换，未继续原 Agent 请求");
    const url = `${endpoint}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}${workspaceQuerySuffix()}`;
    const res = await fetch(url, { ...init, headers: { ...workspaceHeaders(), ...init?.headers } });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string; msg?: string; threadId?: string; messages?: AgentAttachmentMessage[] };
    if (!res.ok) throw new AgentApiError(res.status, data);
    if (persisted && body && typeof data.threadId === "string") {
        // A failed bind must not report an accepted AI turn as unsent. Its pending inventory
        // still protects every original; a later authoritative history read binds it again.
        await bindAgentTurnAttachments(workspaceId, turn![1], body.messageId, data.threadId).catch(() => console.warn("Agent 附件已保存，线程绑定待历史恢复后重试"));
    }
    const thread = /^\/agent\/(codex|pi)\/threads\/([^/?]+)(?:\/(resume|delete))?$/.exec(path);
    if (thread && workspaceId) {
        if (thread[3] === "delete") await releaseAgentThreadAttachments(workspaceId, thread[1], decodeURIComponent(thread[2]));
        else if (Array.isArray(data.messages)) await restoreAgentAttachments(workspaceId, thread[1], decodeURIComponent(thread[2]), data.messages, workspace?.role !== "viewer");
    }
    return data;
}

function workspaceQuerySuffix() {
    const workspace = getActiveWorkspace();
    return workspace ? `&workspaceId=${encodeURIComponent(workspace.id)}` : "";
}

export function discoverAgentConfig(endpoint: string, options: { force?: boolean } = {}) {
    const normalizedEndpoint = endpoint.trim().replace(/\/$/, "");
    if (!normalizedEndpoint) return Promise.resolve(null);
    const now = Date.now();
    const cached = agentConfigCache.get(normalizedEndpoint);
    if (!options.force && cached && cached.expiresAt > now) return Promise.resolve(cached.value);
    const inFlight = agentConfigInFlight.get(normalizedEndpoint);
    if (inFlight) return inFlight;

    const request = (async () => {
        try {
            const res = await fetch(`${normalizedEndpoint}/config`, { headers: { Accept: "application/json" }, cache: "no-store" });
            if (!res.ok) return null;
            const data = (await res.json()) as AgentConfigResponse;
            return data.ok ? data : null;
        } catch {
            return null;
        }
    })();
    agentConfigInFlight.set(normalizedEndpoint, request);
    void request.then((value) => {
        agentConfigCache.set(normalizedEndpoint, {
            value,
            expiresAt: Date.now() + (value ? AGENT_CONFIG_CACHE_TTL_MS : AGENT_CONFIG_FAILURE_COOLDOWN_MS),
        });
    }).finally(() => {
        if (agentConfigInFlight.get(normalizedEndpoint) === request) agentConfigInFlight.delete(normalizedEndpoint);
    });
    return request;
}

function jsonPost(body: unknown): RequestInit {
    return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}
