import { parseAgentAttachmentManifest, type AgentStoredAttachment, type AgentAttachmentManifest } from "@/lib/agent/agent-attachment-contract";
import { randomId } from "@/lib/utils";

export type AgentAttachmentTurn = {
    messageId: string; threadId?: string;
    attachments?: Array<{ id: string; name: string; dataUrl?: string; fileId?: string; width?: number; height?: number }>;
    messageMetadata?: { attachments?: Array<{ id: string }> };
};
export type AgentAttachmentMessage = { role?: string; threadId?: string; turnId?: string; itemId?: string; clientMessageId?: string; attachments?: unknown[] };

async function inventory(workspaceId: string, method = "GET", body?: unknown): Promise<AgentAttachmentManifest> {
    const response = await fetch("/api/media/agent-attachments", {
        method, headers: { "content-type": "application/json", "x-infinite-canvas-workspace": workspaceId },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error("Agent 附件清单未保存或无法读取，请重试");
    return parseAgentAttachmentManifest(await response.json());
}

export async function persistAgentTurnAttachments(workspaceId: string, engine: string, body: AgentAttachmentTurn) {
    // 本机文件附件不进入服务器媒体清单，只持久化图片原图。
    const files = body.attachments?.filter((file) => !file.fileId) || [];
    if (!files.length) return false;
    if (!workspaceId || !body.messageId) throw new Error("未选择工作区或缺少 Agent 消息标识，附件未保存");
    const visible = new Set((body.messageMetadata?.attachments ?? []).map((item: { id: string }) => item.id));
    const attachments: AgentStoredAttachment[] = [];
    for (const file of files) {
        if (typeof file.dataUrl !== "string" || !file.dataUrl.startsWith("data:image/")) throw new Error("Agent 附件缺少可持久化的原图");
        const blob = await (await fetch(file.dataUrl)).blob();
        const storageKey = `image:agent_${randomId()}`;
        const response = await fetch(`/api/media/blob/${encodeURIComponent(storageKey)}`, { method: "PUT", headers: { "x-infinite-canvas-workspace": workspaceId, "content-type": blob.type }, body: blob });
        if (!response.ok) throw new Error("Agent 附件原图未保存，任务未发送");
        attachments.push({ id: file.id, name: file.name, type: blob.type, size: blob.size, width: file.width ?? 0, height: file.height ?? 0, storageKey, purpose: visible.has(file.id) ? "attachment" : "reference" });
    }
    await inventory(workspaceId, "POST", { engine, threadId: body.threadId || "", clientMessageId: body.messageId, attachments });
    return true;
}

export async function bindAgentTurnAttachments(workspaceId: string, engine: string, clientMessageId: string, threadId: string, turnId?: string, itemId?: string) {
    await inventory(workspaceId, "PATCH", { engine, clientMessageId, threadId, ...(turnId ? { turnId } : {}), ...(itemId ? { itemId } : {}) });
}

export async function restoreAgentAttachments(workspaceId: string, engine: string, threadId: string, messages: AgentAttachmentMessage[], canBind = true) {
    const manifest = await inventory(workspaceId);
    const sessions = manifest.sessions.filter((session) => session.engine === engine);
    for (const message of messages) {
        if (message.role !== "user" || message.threadId !== threadId || !message.clientMessageId) continue;
        const session = sessions.find((session) => (!session.threadId || session.threadId === threadId) && session.messages.some((entry) => entry.clientMessageId === message.clientMessageId));
        const stored = session?.messages.find((entry) => entry.clientMessageId === message.clientMessageId);
        if (!stored) continue;
        if ((stored.turnId && stored.turnId !== message.turnId) || (stored.itemId && stored.itemId !== message.itemId)) throw new Error("Agent 附件消息归属冲突，未回填到其他轮次");
        if (canBind && message.turnId && message.itemId && (!stored.turnId || !stored.itemId || !session!.threadId)) {
            await bindAgentTurnAttachments(workspaceId, engine, stored.clientMessageId, threadId, message.turnId, message.itemId);
        }
        // 服务器清单只有图片原图；本机文件附件保留原顺序，图片按 id 补回规范媒体地址。
        const images = new Map(stored.attachments.filter((item) => item.purpose === "attachment").map((item) => [item.id, item]));
        const current = (message.attachments as Array<{ id: string; name: string; kind?: string; type?: string; size?: number }> | undefined) || [];
        const merged = current.map((item) => {
            const image = images.get(item.id);
            return image
                ? { ...item, kind: "image" as const, url: `/api/media/blob/${encodeURIComponent(image.storageKey)}?workspaceId=${encodeURIComponent(workspaceId)}` }
                : { ...item, kind: "file" as const };
        });
        message.attachments = merged.length ? merged : [...images.values()].map((item) => ({ id: item.id, name: item.name, kind: "image" as const, url: `/api/media/blob/${encodeURIComponent(item.storageKey)}?workspaceId=${encodeURIComponent(workspaceId)}` }));
    }
}

export async function releaseAgentThreadAttachments(workspaceId: string, engine: string, threadId: string) {
    await inventory(workspaceId, "DELETE", { engine, threadId, clientMessageId: "" });
}
