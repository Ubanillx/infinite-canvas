import type localforage from "localforage";

import { loadWorkspaceData, saveWorkspaceData, type WorkspaceDomain } from "@/services/workspace-data";

type LogStore = ReturnType<typeof localforage.createInstance>;

export async function readWorkspaceLogs<T extends { id: string }>(domain: WorkspaceDomain, store: LogStore) {
    const remote = await loadWorkspaceData<{ logs: T[] }>(domain);
    if (remote?.logs) {
        await store.clear();
        await Promise.all(remote.logs.map((log) => store.setItem(log.id, log)));
        return remote.logs;
    }
    const local: T[] = [];
    await store.iterate<T, void>((log) => { local.push(log); });
    if (local.length) await saveWorkspaceData(domain, { logs: local });
    return local;
}
