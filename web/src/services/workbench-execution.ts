import localforage from "localforage";
import { getActiveWorkspace } from "@/lib/workspace";

const intents = localforage.createInstance({ name: "infinite-canvas", storeName: "workbench_execution_intents" });
const pending = new Map<string, Promise<void>>();

/** A request cannot cross between browser scripts and server tasks after it has been accepted. */
export function reserveWorkbenchExecution(workspaceId: string, kind: "image" | "video", requestId: string, execution: "browser" | "server") {
    const key = `${workspaceId}:${requestId}`;
    const reserve = async () => {
        if (getActiveWorkspace()?.id !== workspaceId) throw new Error("工作区已切换，请重新读取生成目标");
        const existing = await intents.getItem<{ execution: string; kind: string }>(key);
        if (existing && (existing.execution !== execution || existing.kind !== kind)) throw new Error("同一 requestId 已用于另一生成类型或执行方式，不能重复生成");
        if (!existing) await intents.setItem(key, { execution, kind });
        if (getActiveWorkspace()?.id !== workspaceId) throw new Error("工作区已切换，请重新读取生成目标");
    };
    const operation = (pending.get(key) || Promise.resolve()).catch(() => undefined).then(() =>
        globalThis.navigator?.locks ? navigator.locks.request(`infinite-canvas:generation:${key}`, reserve) : reserve());
    pending.set(key, operation);
    void operation.finally(() => { if (pending.get(key) === operation) pending.delete(key); }).catch(() => undefined);
    return operation;
}
