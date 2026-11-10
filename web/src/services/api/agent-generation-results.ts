import { assertAgentWorkspace } from "@/lib/agent/agent-tool-context";

/** 读取已提交历史，不改动正在编辑的工作台 revision 或本地缓存。 */
export async function readAgentGenerationLogs(workspaceId: string, source: "image" | "video") {
    assertAgentWorkspace(workspaceId);
    const response = await fetch(`/api/data/${source}-workbench`, { headers: { "x-infinite-canvas-workspace": workspaceId } });
    if (!response.ok) throw new Error(`生成历史读取失败（${response.status}）`);
    const data = await response.json();
    assertAgentWorkspace(workspaceId);
    if (data.payload === null) return [];
    if (!data.payload || !Array.isArray(data.payload.logs)) throw new Error("生成历史格式无效，未返回未核实数据");
    return data.payload.logs as unknown[];
}
