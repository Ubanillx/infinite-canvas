export const AGENT_ATTACHMENT_VERSION = 1;
export const MEDIA_STORAGE_KEY = /^[a-z][a-z0-9-]*:[A-Za-z0-9_-]+$/;
export type AgentStoredAttachment = { id: string; name: string; storageKey: string; type: string; size: number; width: number; height: number; purpose: "attachment" | "reference" };
export type AgentStoredMessage = { id: string; clientMessageId: string; turnId: string; itemId: string; attachments: AgentStoredAttachment[] };
export type AgentStoredSession = { id: string; engine: "codex" | "pi"; threadId: string; messages: AgentStoredMessage[] };
export type AgentAttachmentManifest = { version: 1; sessions: AgentStoredSession[] };
export class AgentAttachmentError extends Error {}

function shape(valid: unknown): asserts valid {
    if (!valid) throw new AgentAttachmentError("Agent 附件清单格式未知或损坏");
}
function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
    shape(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)));
}
const text = (value: unknown) => typeof value === "string" && Boolean(value.trim());
function unique(values: string[]) { shape(new Set(values).size === values.length); }

// This is the workspace attachment inventory, not the Agent engine's history/protocol version.
export function parseAgentAttachmentManifest(value: unknown): AgentAttachmentManifest {
    object(value, ["version", "sessions"]);
    shape(value.version === AGENT_ATTACHMENT_VERSION && Array.isArray(value.sessions));
    const messageKeys: string[] = [];
    const turnKeys: string[] = [];
    for (const session of value.sessions) {
        object(session, ["id", "engine", "threadId", "messages"]);
        shape(text(session.id) && ["codex", "pi"].includes(String(session.engine)) && typeof session.threadId === "string" && Array.isArray(session.messages));
        for (const message of session.messages) {
            object(message, ["id", "clientMessageId", "turnId", "itemId", "attachments"]);
            shape(text(message.id) && message.id === message.clientMessageId && typeof message.turnId === "string" && typeof message.itemId === "string" && Array.isArray(message.attachments));
            shape(!message.turnId || Boolean(session.threadId));
            messageKeys.push(JSON.stringify([session.engine, message.clientMessageId]));
            if (message.turnId && message.itemId) turnKeys.push(JSON.stringify([session.engine, session.threadId, message.turnId, message.itemId]));
            for (const attachment of message.attachments) {
                object(attachment, ["id", "name", "storageKey", "type", "size", "width", "height", "purpose"]);
                shape(text(attachment.id) && text(attachment.name) && typeof attachment.storageKey === "string" && MEDIA_STORAGE_KEY.test(attachment.storageKey) && typeof attachment.type === "string" && ["attachment", "reference"].includes(String(attachment.purpose)));
                shape([attachment.size, attachment.width, attachment.height].every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0));
            }
            unique(message.attachments.map((attachment: AgentStoredAttachment) => attachment.id));
        }
    }
    unique(value.sessions.map((session: AgentStoredSession) => session.id));
    unique(messageKeys); unique(turnKeys);
    return structuredClone(value) as AgentAttachmentManifest;
}
