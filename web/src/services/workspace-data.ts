import { getActiveWorkspace, workspaceHeaders } from "@/lib/workspace";

export type WorkspaceDomain = "canvas" | "assets" | "image-workbench" | "video-workbench" | "agent-sessions";
type StoredDomain<T> = { payload: T | null; revision: number; updatedAt: string | null; updatedBy: string | null };
type ConflictDetail = { domain: WorkspaceDomain; payload: unknown; revision: number };

const revisions = new Map<string, number>();
const writes = new Map<string, Promise<void>>();

function revisionKey(domain: WorkspaceDomain) {
    return `${getActiveWorkspace()?.id || "unselected"}:${domain}`;
}

export async function loadWorkspaceData<T>(domain: WorkspaceDomain): Promise<T | null> {
    const workspace = getActiveWorkspace();
    if (!workspace) return null;
    const response = await fetch(`/api/data/${encodeURIComponent(domain)}`, { headers: workspaceHeaders() });
    if (!response.ok) throw new Error((await response.json().catch(() => ({})) as { error?: string }).error || "无法读取工作区数据");
    const data = await response.json() as StoredDomain<T>;
    revisions.set(revisionKey(domain), data.revision);
    return data.payload;
}

export function saveWorkspaceData(domain: WorkspaceDomain, payload: unknown) {
    const key = revisionKey(domain);
    const previous = writes.get(key) || Promise.resolve();
    const write = previous.catch(() => undefined).then(async () => {
        if (!getActiveWorkspace()) return;
        if (!revisions.has(key)) await loadWorkspaceData(domain);
        const response = await fetch(`/api/data/${encodeURIComponent(domain)}`, {
            method: "PUT",
            headers: { "content-type": "application/json", ...workspaceHeaders() },
            body: JSON.stringify({ revision: revisions.get(key) || 0, payload }),
        });
        const data = await response.json().catch(() => ({})) as StoredDomain<unknown> & { error?: string };
        if (response.status === 409) {
            revisions.set(key, data.revision);
            window.dispatchEvent(new CustomEvent<ConflictDetail>("infinite-canvas:workspace-conflict", { detail: { domain, payload: data.payload, revision: data.revision } }));
            throw new Error(data.error || "工作区数据发生冲突");
        }
        if (!response.ok) throw new Error(data.error || "工作区数据保存失败");
        revisions.set(key, data.revision);
    });
    writes.set(key, write.then(() => undefined, () => undefined));
    return write;
}

export function resetWorkspaceDataRevision(domain: WorkspaceDomain) {
    revisions.delete(revisionKey(domain));
}
