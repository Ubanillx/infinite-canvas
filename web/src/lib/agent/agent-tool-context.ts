import { getActiveWorkspace, type WorkspaceAccess } from "@/lib/workspace";

/** 固定工具目标，避免异步操作期间切换工作区后写入另一份数据。服务端仍执行最终授权。 */
export function requireAgentWorkspace(input: Record<string, unknown>, write = false): WorkspaceAccess {
    const workspace = getActiveWorkspace();
    if (!workspace) throw new Error("请先选择工作区");
    if (typeof input.workspaceId !== "string" || input.workspaceId !== workspace.id) throw new Error("工具目标工作区与当前网页不一致，请先读取 platform_get_context");
    if (write && workspace.role === "viewer") throw new Error("当前工作区为只读，不能修改数据");
    return workspace;
}

export function assertAgentWorkspace(workspaceId: string) {
    if (getActiveWorkspace()?.id !== workspaceId) throw new Error("工作区已切换，请在目标工作区重新读取数据后操作");
}
