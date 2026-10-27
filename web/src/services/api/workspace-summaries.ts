export type WorkspaceCanvasSummary = { canvasCount: number; folderCount: number; recentCanvasTitle: string | null };

export async function listWorkspaceCanvasSummaries() {
    const response = await fetch("/api/workspaces/summaries");
    const data = await response.json() as { summaries?: Record<string, WorkspaceCanvasSummary | null>; error?: string };
    if (!response.ok) throw new Error(data.error || "无法读取工作区信息");
    return data.summaries || {};
}
