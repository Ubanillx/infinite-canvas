import { assertAgentWorkspace } from "@/lib/agent/agent-tool-context";

/** 只读取目标工作区已保存的媒体，不走浏览器缓存或旧数据迁移。 */
export async function readAgentMedia(workspaceId: string, storageKey: string): Promise<Blob> {
    assertAgentWorkspace(workspaceId);
    const response = await fetch(`/api/media/blob/${encodeURIComponent(storageKey)}`, { headers: { "x-infinite-canvas-workspace": workspaceId } });
    assertAgentWorkspace(workspaceId);
    if (!response.ok) throw new Error(`当前工作区媒体读取失败（${response.status}）`);
    const blob = await response.blob();
    assertAgentWorkspace(workspaceId);
    return blob;
}
