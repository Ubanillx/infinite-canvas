import { z } from "zod";

import type { CanvasSnapshot } from "../canvas/types.js";
import type { JsonRecord } from "../utils/value.js";

export type SkillDraftSource = { source: "conversation"; threadId: string } | { source: "canvas"; snapshot: CanvasSnapshot };

const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const skillDraftSchema = z.object({
    name: z.string().trim().min(1).max(64).regex(skillNamePattern),
    displayName: z.string().trim().max(64),
    description: z.string().trim().min(1).max(1024).refine((value) => !/[<>]/.test(value)),
    instructions: z.string().trim().min(1).max(20000),
    shortDescription: z.string().trim().max(64).refine((value) => !value || value.length >= 25),
    defaultPrompt: z.string().trim().max(1024),
}).strict().superRefine((draft, context) => {
    if (draft.defaultPrompt && !mentionsSkill(draft.defaultPrompt, draft.name)) context.addIssue({ code: "custom", path: ["defaultPrompt"], message: `默认提示词必须包含 $${draft.name}` });
});

export const SKILL_DRAFT_OUTPUT_SCHEMA: JsonRecord = {
    type: "object",
    additionalProperties: false,
    required: ["name", "displayName", "description", "instructions", "shortDescription", "defaultPrompt"],
    properties: {
        name: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", minLength: 1, maxLength: 64 },
        displayName: { type: "string", maxLength: 64 },
        description: { type: "string", pattern: "^[^<>]+$", minLength: 1, maxLength: 1024 },
        instructions: { type: "string", minLength: 1, maxLength: 20000 },
        shortDescription: { anyOf: [{ type: "string", maxLength: 0 }, { type: "string", minLength: 25, maxLength: 64 }] },
        defaultPrompt: { type: "string", maxLength: 1024 },
    },
};

export type AgentSkillDraft = z.infer<typeof skillDraftSchema>;

export function skillDraftPrompt(input: SkillDraftSource) {
    const source = input.source === "conversation"
        ? "从当前完整对话中，识别已经实际完成且值得复用的稳定流程。不要总结本条提炼请求，也不要保留一次性的结论、错误排查过程或工具日志。"
        : `从下面经过清理的画布快照中，识别节点、连线和生成步骤所表达的可复用流程。不要把画布节点 ID 写进执行说明。\n\n画布快照：\n${JSON.stringify(canvasSkillSource(input.snapshot))}`;
    return [
        "请生成一个可编辑的 Agent Skill 草稿。",
        source,
        "要求：",
        "- name 使用不超过 64 个字符的小写字母、数字和连字符，优先使用简短的动词短语。",
        "- description 同时说明能力和触发场景；所有何时使用的信息都写在这里。",
        "- instructions 只写另一个智能体真正需要的、可复用的命令式步骤、约束和输出要求，不写 YAML frontmatter。",
        "- shortDescription 写 25–64 个字符的人类可读短说明；没有合适内容时返回空字符串。",
        "- defaultPrompt 必须包含与 name 完全一致的 $skill-name 调用标记；没有合适内容时返回空字符串。",
        "- displayName 使用简洁的人类可读名称。",
        "- 不得输出 Token、API Key、密码、凭证、本地路径、媒体 URL、敏感 URL、临时错误、调试日志或一次性结果。",
        "只按 outputSchema 返回对象。",
    ].join("\n");
}

const MAX_CANVAS_SKILL_NODES = 300;
const MAX_CANVAS_SKILL_CONNECTIONS = 600;
const MAX_CANVAS_SKILL_NODE_CHARS = 100_000;
const MAX_CANVAS_SKILL_SOURCE_CHARS = 120_000;

/** 只保留理解画布流程所需的信息，避免把媒体、外部地址、坐标和本地凭证送入草稿线程。 */
export function canvasSkillSource(snapshot: CanvasSnapshot): JsonRecord {
    const allNodes = prioritizedCanvasNodes(snapshot);
    const nodes = allNodes.slice(0, MAX_CANVAS_SKILL_NODES);
    const nodeRefs = new Map(allNodes.map((node, index) => [node.id, `node-${index + 1}`]));
    const title = cleanCanvasString(snapshot.title, nodeRefs);
    const source: JsonRecord & { nodes: JsonRecord[]; connections: Array<{ from: string; to: string }> } = {
        ...(title ? { title } : {}),
        nodes: [],
        connections: [],
    };
    let truncated = nodes.length < allNodes.length;
    nodes.forEach((node, index) => {
        const metadata = { ...(node.metadata || {}) };
        if (node.type !== "text") delete metadata.content;
        const cleanMetadata = sanitizeCanvasValue(metadata, nodeRefs);
        const nodeTitle = cleanCanvasString(node.title, nodeRefs);
        const summary = { ref: `node-${index + 1}`, type: node.type, ...(nodeTitle ? { title: nodeTitle } : {}) };
        const candidate = { ...summary, ...(cleanMetadata && Object.keys(cleanMetadata as JsonRecord).length ? { metadata: cleanMetadata } : {}) };
        if (canvasSourceFits({ ...source, nodes: [...source.nodes, candidate] }, MAX_CANVAS_SKILL_NODE_CHARS)) source.nodes.push(candidate);
        else if (canvasSourceFits({ ...source, nodes: [...source.nodes, summary] }, MAX_CANVAS_SKILL_NODE_CHARS)) (source.nodes.push(summary), truncated = true);
        else truncated = true;
    });
    const includedRefs = new Set(source.nodes.map((node) => String(node.ref || "")));
    const selectedNodeRefs = (snapshot.selectedNodeIds || []).flatMap((id) => nodeRefs.get(id) || []).filter((ref) => includedRefs.has(ref));
    if (selectedNodeRefs.length) source.selectedNodeRefs = selectedNodeRefs;
    const connections = (snapshot.connections || []).flatMap(({ fromNodeId, toNodeId }) => {
        const from = nodeRefs.get(fromNodeId);
        const to = nodeRefs.get(toNodeId);
        return from && to && includedRefs.has(from) && includedRefs.has(to) ? [{ from, to }] : [];
    });
    if (connections.length > MAX_CANVAS_SKILL_CONNECTIONS) truncated = true;
    connections.slice(0, MAX_CANVAS_SKILL_CONNECTIONS).forEach((connection) => {
        if (canvasSourceFits({ ...source, connections: [...source.connections, connection] }, MAX_CANVAS_SKILL_SOURCE_CHARS - 32)) source.connections.push(connection);
        else truncated = true;
    });
    if (truncated) source.truncated = true;
    return source;
}

const sensitiveCanvasKey = /api.?key|token|secret|password|authorization|credential|storage.?key|(?:local|file).?path/i;
const transientCanvasKey = /^(?:status|progress|errorDetails|taskId|createdAt|updatedAt|startedAt|completedAt)$/i;
const canvasNodeReferenceKey = /^.*(?:Node|Group|Parent|Child|Root|Source|Target|PrimaryImage)Ids?$/i;
const directLocalPath = /^(?:file:(?:\/\/)?|[a-z]:[\\/]|\\\\|\/(?!\/)(?=[^\s`'"“”<>]+\/))/i;
const fileUrl = /\bfile:(?:\/\/)?[^\s`'"“”<>]+/gi;
const inlineLocalPath = /(?<![A-Za-z0-9/:])(?:[a-z]:[\\/]|\\\\)[^\s`'"“”<>]+|(?<![\p{L}\p{N}/:])\/(?!\/)(?=[^\s`'"“”<>]+\/)[^\s`'"“”<>]+/giu;
const credentialAssignment = /(?:api[_ -]?key|access[_ -]?(?:key|token)|connect[_ -]?token|token|secret|password|authorization|credential)\s*(?:[:=：]|为|是)\s*(?:bearer\s+)?[`'"“]?[A-Za-z0-9_./+\-=]{8,}/gi;
const bearerToken = /\bbearer\s+[A-Za-z0-9._~+/=\-]{8,}/gi;
const jwtToken = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const knownApiToken = /\b(?:sk-[A-Za-z0-9_-]{12,}|(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g;
const transientIdentifier = /\b(?:task|job|request|generation|node)[_-](?:\d{4,}|[A-Fa-f0-9]{8,}|(?=[A-Za-z0-9_-]{12,}\b)(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+)\b/gi;
const webUrl = /\bhttps?:\/\/[^\s<>{}\[\]`'"“”]+/gi;

function sanitizeCanvasValue(value: unknown, nodeRefs: Map<string, string>, depth = 0): unknown {
    if (value === null || typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value === "string") return cleanCanvasString(value, nodeRefs);
    if (depth >= 6) return undefined;
    if (Array.isArray(value)) return value.slice(0, 300).map((item) => sanitizeCanvasValue(item, nodeRefs, depth + 1)).filter((item) => item !== undefined);
    if (!value || typeof value !== "object") return undefined;
    const result: JsonRecord = {};
    Object.entries(value as JsonRecord).forEach(([key, item]) => {
        if (sensitiveCanvasKey.test(key) || transientCanvasKey.test(key)) return;
        if (canvasNodeReferenceKey.test(key)) {
            const refs = (Array.isArray(item) ? item : [item]).flatMap((id) => typeof id === "string" ? nodeRefs.get(id) || [] : []);
            if (refs.length) result[key.replace(/Ids$/i, "Refs").replace(/Id$/i, "Ref")] = Array.isArray(item) ? [...new Set(refs)] : refs[0];
            return;
        }
        const clean = sanitizeCanvasValue(item, nodeRefs, depth + 1);
        if (clean !== undefined) result[replaceCanvasNodeRefs(key, nodeRefs)] = clean;
    });
    return result;
}

function cleanCanvasString(value: unknown, nodeRefs: Map<string, string>) {
    const valueText = typeof value === "string" ? value.trim() : "";
    if (!valueText || /^(?:data:|blob:|https?:\/\/|file:)/i.test(valueText) || directLocalPath.test(valueText)) return undefined;
    const text = replaceCanvasNodeRefs(valueText, nodeRefs)
        .replace(/\b(?:data:|blob:)[^\s`'"“”<>]+/gi, "[媒体地址已移除]")
        .replace(fileUrl, "[本地路径已移除]")
        .replace(webUrl, "[外部地址已移除]")
        .replace(inlineLocalPath, "[本地路径已移除]")
        .replace(credentialAssignment, "[敏感凭证已移除]")
        .replace(bearerToken, "[敏感凭证已移除]")
        .replace(jwtToken, "[敏感凭证已移除]")
        .replace(knownApiToken, "[敏感凭证已移除]")
        .trim();
    return text.length > 12000 ? `${text.slice(0, 12000)}\n[内容已截断]` : text || undefined;
}

function replaceCanvasNodeRefs(value: string, nodeRefs: Map<string, string>) {
    const nodeIds = [...nodeRefs.keys()].filter(Boolean).sort((left, right) => right.length - left.length);
    const nodeIdPattern = nodeIds.length ? new RegExp(nodeIds.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g") : undefined;
    return nodeIdPattern ? value.replace(nodeIdPattern, (id) => nodeRefs.get(id) || id) : value;
}

function prioritizedCanvasNodes(snapshot: CanvasSnapshot) {
    const nodes = snapshot.nodes || [];
    const selectedIds = new Set(snapshot.selectedNodeIds || []);
    const relatedIds = new Set<string>();
    (snapshot.connections || []).forEach(({ fromNodeId, toNodeId }) => {
        if (selectedIds.has(fromNodeId)) relatedIds.add(toNodeId);
        if (selectedIds.has(toNodeId)) relatedIds.add(fromNodeId);
    });
    return [
        ...nodes.filter((node) => selectedIds.has(node.id)),
        ...nodes.filter((node) => !selectedIds.has(node.id) && relatedIds.has(node.id)),
        ...nodes.filter((node) => !selectedIds.has(node.id) && !relatedIds.has(node.id)),
    ];
}

function canvasSourceFits(source: JsonRecord, limit: number) {
    return JSON.stringify(source).length <= limit;
}

export function canvasPrivateValues(snapshot: CanvasSnapshot) {
    return [snapshot.projectId, snapshot.clientId, ...(snapshot.nodes || []).map((node) => node.id), ...(snapshot.connections || []).map((connection) => connection.id)]
        .filter((value): value is string => typeof value === "string" && value.length >= 6);
}

function patternMatches(pattern: RegExp, text: string) {
    pattern.lastIndex = 0;
    return pattern.test(text);
}

function mentionsSkill(prompt: string, name: string) {
    return new RegExp(`\\$${name}(?![A-Za-z0-9_-]|:[A-Za-z0-9_-])`).test(prompt);
}

export function assertDraftHasNoSensitiveValues(draft: AgentSkillDraft, privateValues: string[]) {
    const text = Object.values(draft).join("\n");
    const localPath = /(?:^|[\s`'"“”（(\[{,:;：])(?:file:(?:\/\/)?|[a-z]:[\\/]|\\\\|\/(?!\/))/im;
    const externalUrl = (text.match(webUrl) || []).length > 0;
    const hasPrivateValue = privateValues.some((value) => text.includes(value));
    if (localPath.test(text) || /\b(?:data:|blob:)/i.test(text) || patternMatches(credentialAssignment, text) || patternMatches(bearerToken, text) || patternMatches(jwtToken, text) || patternMatches(knownApiToken, text) || patternMatches(transientIdentifier, text) || externalUrl || hasPrivateValue) {
        throw new Error("生成的 Skill 草稿包含外部地址、本地路径、敏感凭证或一次性标识，已拒绝返回");
    }
}

export function parseSkillDraft(value: unknown, engine: string, privateValues: string[] = []): AgentSkillDraft {
    const parsed = skillDraftSchema.safeParse(value);
    if (!parsed.success) throw new Error(`${engine} 返回的 Skill 草稿格式不正确`);
    assertDraftHasNoSensitiveValues(parsed.data, privateValues);
    return parsed.data;
}
