export type BackupSettings = { enabled: boolean; intervalMinutes: number; retention: number; safetyRetention: number };
export type BackupProgress = { phase: string; workspaceId?: string; workspaceName?: string; current: number; total: number; uploadedFiles: number; uploadedBytes: number; message?: string };
export type BackupRun = { id: string; kind: "backup" | "restore"; purpose: string; status: "running" | "succeeded" | "partial" | "failed" | "cancelled"; backupId: string | null; workspaceId: string | null; startedAt: string; finishedAt: string | null; summary: Record<string, unknown> | null; error: string | null };
export type BackupStatus = { configured: boolean; settings: BackupSettings; active: { runId: string; kind: "backup" | "restore"; startedAt: string; progress: BackupProgress } | null; lastRun: BackupRun | null };
export type SnapshotSummary = { id: string; source: "snapshots" | "safety"; purpose: string; createdAt: string; status: "complete" | "partial"; workspaces: number; complete: number; mediaBytes: number };
export type BackupWorkspaceManifest = { id: string; name: string; status: "complete" | "incomplete"; errors: string[]; domains: Record<string, { present: boolean; revision: number }>; prompts: { count: number }; media: { count: number; bytes: number; externalMedia: number }; promptImages: { count: number; bytes: number } };
export type BackupManifest = { app: "infinite-canvas"; version: 1; kind: "system-backup"; purpose: string; backupId: string; createdAt: string; completedAt: string; status: "complete" | "partial"; totals: { workspaces: number; complete: number; media: number; mediaBytes: number; promptImages: number; promptImageBytes: number }; workspaces: BackupWorkspaceManifest[] };
export type WorkspaceBlocker = { intentId: string; storageKey: string; objectKey: string; operation: string; expectedBytes: string | null; createdAt: string };

export function getBackupStatus() {
    return request<BackupStatus>("/api/admin/backup/status", { method: "GET" });
}

export function saveBackupSettings(settings: BackupSettings) {
    return request<BackupSettings>("/api/admin/backup/settings", { method: "PUT", body: JSON.stringify(settings) });
}

export function testBackupConnection() {
    return request<{ ok: boolean }>("/api/admin/backup/test", { method: "POST" });
}

export function startBackup() {
    return request<{ runId: string }>("/api/admin/backup/run", { method: "POST" });
}

export function cancelBackup() {
    return request<{ cancelled: boolean }>("/api/admin/backup/cancel", { method: "POST" });
}

export function listBackupSnapshots() {
    return request<{ items: SnapshotSummary[] }>("/api/admin/backup/snapshots", { method: "GET" });
}

export function getBackupSnapshot(source: "snapshots" | "safety", id: string) {
    return request<BackupManifest>(`/api/admin/backup/snapshots/${source}/${encodeURIComponent(id)}`, { method: "GET" });
}

export function startBackupRestore(snapshotId: string, workspaceId: string, source: "snapshots" | "safety") {
    return request<{ runId: string }>("/api/admin/backup/restore", { method: "POST", body: JSON.stringify({ snapshotId, workspaceId, source }) });
}

export function listBackupRuns() {
    return request<{ items: BackupRun[] }>("/api/admin/backup/runs", { method: "GET" });
}

export function getWorkspaceBackupBlockers(workspaceId: string) {
    return request<{ items: WorkspaceBlocker[] }>(`/api/admin/backup/workspaces/${encodeURIComponent(workspaceId)}/blockers`, { method: "GET" });
}

export function releaseWorkspaceBackupIntents(workspaceId: string, intentIds: string[]) {
    return request<{ released: number }>(`/api/admin/backup/workspaces/${encodeURIComponent(workspaceId)}/release-intents`, { method: "POST", body: JSON.stringify({ intentIds }) });
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(path, {
        ...init,
        headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
    });
    const data = await response.json().catch(() => ({})) as T & { error?: string };
    if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
    return data;
}
