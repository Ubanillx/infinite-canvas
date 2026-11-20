import localforage from "localforage";

export type AgentToolReceiptScope = { endpoint: string; workspaceId: string; clientId: string };
export type AgentToolRequest = { requestId: string; connectionId: string };
export type AgentToolResult = AgentToolRequest & { result?: unknown; error?: string; outcome?: "unknown" };
type StoredReceipt = { status: "started" | "settled" | "acknowledged"; body?: AgentToolResult };
type ReceiptStorage = Pick<typeof localforage, "getItem" | "setItem">;
type SendResult = (body: AgentToolResult) => Promise<unknown>;

/** Use when the operation may already have changed data but its result is unverified. */
export class AgentToolOutcomeUnknownError extends Error {}

/** A receipt is stored before transport, so a lost HTTP response never reexecutes a tool. */
export class AgentToolReceipts {
    private running = new Set<string>();
    private sending = new Map<string, Promise<boolean>>();
    private recoverAfterRun = new Map<string, SendResult>();

    constructor(private storage: ReceiptStorage) {}

    private key(scope: AgentToolReceiptScope, request: AgentToolRequest) {
        return JSON.stringify([scope.endpoint, scope.workspaceId, scope.clientId, request.requestId, request.connectionId]);
    }

    /** Returns false for a duplicate or a persisted start from a previous page load. */
    async begin(scope: AgentToolReceiptScope, request: AgentToolRequest) {
        const key = this.key(scope, request);
        if (this.running.has(key)) return false;
        this.running.add(key);
        try {
            if (await this.storage.getItem<StoredReceipt>(key)) {
                this.running.delete(key);
                return false;
            }
            await this.storage.setItem(key, { status: "started" } satisfies StoredReceipt);
            return true;
        } catch (error) {
            this.running.delete(key);
            throw error;
        }
    }

    /** Save the outcome first. Transport failure leaves the receipt for recovery. */
    async finish(scope: AgentToolReceiptScope, body: AgentToolResult, send: SendResult) {
        const key = this.key(scope, body);
        const existing = await this.storage.getItem<StoredReceipt>(key);
        if (!existing) throw new Error("工具执行记录不存在，结果无法确认");
        if (existing.status === "acknowledged") return true;
        if (existing.status === "settled") {
            if (JSON.stringify(existing.body) !== JSON.stringify(body)) throw new Error("工具执行结果与已保存回执冲突");
        } else {
            await this.storage.setItem(key, { status: "settled", body } satisfies StoredReceipt);
        }
        return this.deliver(key, body, send);
    }

    /** Execute at most once for this page and persisted request identity. */
    async execute(scope: AgentToolReceiptScope, request: AgentToolRequest, action: () => Promise<unknown>, send: SendResult) {
        const key = this.key(scope, request);
        if (!await this.begin(scope, request)) {
            const existing = await this.storage.getItem<StoredReceipt>(key);
            if (existing?.body) await this.deliver(key, existing.body, send);
            return;
        }
        let body: AgentToolResult;
        try {
            body = { ...request, result: await action() };
        } catch (error) {
            body = error instanceof AgentToolOutcomeUnknownError
                ? { ...request, outcome: "unknown" }
                : { ...request, error: error instanceof Error ? error.message : String(error) };
        }
        let delivered = false;
        try {
            delivered = await this.finish(scope, body, send);
        } finally {
            this.running.delete(key);
            const pendingRecovery = this.recoverAfterRun.get(key);
            this.recoverAfterRun.delete(key);
            if (!delivered && pendingRecovery) await this.recover(scope, [request], pendingRecovery);
        }
    }

    /** Only resend receipts. An interrupted start has an unknown outcome and must not rerun. */
    async recover(scope: AgentToolReceiptScope, pending: AgentToolRequest[], send: SendResult) {
        for (const request of pending) {
            const key = this.key(scope, request);
            if (this.running.has(key)) {
                this.recoverAfterRun.set(key, send);
                continue;
            }
            const receipt = await this.storage.getItem<StoredReceipt>(key);
            if (receipt?.status === "acknowledged") continue;
            if (receipt?.body) {
                await this.deliver(key, receipt.body, send);
            } else {
                const body: AgentToolResult = { ...request, outcome: "unknown" };
                await this.storage.setItem(key, { status: "settled", body } satisfies StoredReceipt);
                await this.deliver(key, body, send);
            }
        }
    }

    private deliver(key: string, body: AgentToolResult, send: SendResult): Promise<boolean> {
        const active = this.sending.get(key);
        if (active) return active;
        const sending = Promise.resolve().then(() => send(body)).then(async () => {
            // Keep the identity tombstone to prevent reexecution, but release large results.
            // Failure to save this cleanup is safe: the full receipt can be resent.
            if (body.outcome !== "unknown") await this.storage.setItem(key, { status: "acknowledged" } satisfies StoredReceipt).catch(() => undefined);
            return true;
        }, () => false).finally(() => {
            this.sending.delete(key);
        });
        this.sending.set(key, sending);
        return sending;
    }
}

export const agentToolReceipts = new AgentToolReceipts(localforage.createInstance({ name: "infinite-canvas", storeName: "agent_tool_receipts" }));
