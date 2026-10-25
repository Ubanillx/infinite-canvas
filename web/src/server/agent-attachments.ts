import { AgentAttachmentError, parseAgentAttachmentManifest, type AgentAttachmentManifest, type AgentStoredMessage } from "../lib/agent/agent-attachment-contract";
import { execute, queryOne, type SqlExecutor } from "./db";
import { extractMediaReferences, replaceDomainMediaReferences } from "./media-references";

export async function readAgentAttachments(db: SqlExecutor, workspaceId: string) {
    const row = await queryOne<{ payload: string }>(db, "SELECT payload FROM workspace_data WHERE workspace_id = $1 AND domain = 'agent-sessions'", workspaceId);
    return row ? parseAgentAttachmentManifest(JSON.parse(row.payload)) : { version: 1, sessions: [] } as AgentAttachmentManifest;
}

export function updateAgentAttachments(manifest: AgentAttachmentManifest, action: string, body: Record<string, unknown>) {
    if (!["codex", "pi"].includes(String(body.engine)) || typeof body.threadId !== "string" || typeof body.clientMessageId !== "string") throw new AgentAttachmentError("Agent 附件归属无效");
    const { engine, threadId, clientMessageId } = body as { engine: "codex" | "pi"; threadId: string; clientMessageId: string };
    if (action === "DELETE") {
        if (!threadId) throw new AgentAttachmentError("删除附件引用须指定线程");
        manifest.sessions = manifest.sessions.filter((session) => session.engine !== engine || session.threadId !== threadId);
        return parseAgentAttachmentManifest(manifest);
    }
    if (!clientMessageId.trim()) throw new AgentAttachmentError("Agent 消息标识不能为空");
    const previous = manifest.sessions.find((session) => session.engine === engine && session.messages.some((message) => message.clientMessageId === clientMessageId));
    const message = previous?.messages.find((entry) => entry.clientMessageId === clientMessageId);
    if (action === "POST" && message) throw new AgentAttachmentError("Agent 消息附件已登记，不允许覆盖");
    if (previous?.threadId && previous.threadId !== threadId) throw new AgentAttachmentError("Agent 消息不能绑定到另一线程");
    let next: AgentStoredMessage;
    if (action === "PATCH") {
        if (!message || !threadId) throw new AgentAttachmentError("Agent 待绑定消息不存在");
        const turnId = body.turnId ?? message.turnId;
        const itemId = body.itemId ?? message.itemId;
        if ((message.turnId && message.turnId !== turnId) || (message.itemId && message.itemId !== itemId)) throw new AgentAttachmentError("Agent 消息轮次或条目标识冲突");
        next = { ...message, turnId, itemId } as AgentStoredMessage;
        previous!.messages = previous!.messages.filter((entry) => entry !== message);
    } else {
        next = { id: clientMessageId, clientMessageId, turnId: "", itemId: "", attachments: body.attachments } as AgentStoredMessage;
    }
    const id = JSON.stringify([engine, threadId || `pending:${clientMessageId}`]);
    let target = manifest.sessions.find((session) => session.id === id);
    if (!target) { target = { id, engine, threadId, messages: [] }; manifest.sessions.push(target); }
    target.messages.push(next);
    manifest.sessions = manifest.sessions.filter((session) => session.messages.length);
    return parseAgentAttachmentManifest(manifest);
}

// Caller holds the same workspace lock used by generic domain CAS writes.
export async function saveAgentAttachments(tx: SqlExecutor, workspaceId: string, actorId: string, manifest: AgentAttachmentManifest) {
    const refs = extractMediaReferences("agent-sessions", manifest);
    for (const attachment of manifest.sessions.flatMap((session) => session.messages.flatMap((message) => message.attachments))) {
        if (!await queryOne(tx, "SELECT 1 FROM media_files WHERE workspace_id = $1 AND storage_key = $2 AND remote_path = '' AND bytes = $3 AND mime_type = $4", workspaceId, attachment.storageKey, attachment.size, attachment.type)) throw new AgentAttachmentError("Agent 附件未持久化到当前工作区或元数据不匹配");
    }
    const row = await queryOne<{ revision: number }>(tx, `INSERT INTO workspace_data (workspace_id, domain, payload, revision, updated_at, updated_by)
        VALUES ($1, 'agent-sessions', $2, 1, now(), $3) ON CONFLICT (workspace_id, domain) DO UPDATE
        SET payload = excluded.payload, revision = workspace_data.revision + 1, updated_at = now(), updated_by = excluded.updated_by RETURNING revision`, workspaceId, JSON.stringify(manifest), actorId);
    await replaceDomainMediaReferences(tx, workspaceId, "agent-sessions", refs, row!.revision);
    await execute(tx, "UPDATE workspaces SET updated_at = now() WHERE id = $1", workspaceId);
}
