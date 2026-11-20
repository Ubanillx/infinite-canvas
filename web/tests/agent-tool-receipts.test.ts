import { expect, test } from "bun:test";

import { AgentToolOutcomeUnknownError, AgentToolReceipts, type AgentToolResult } from "../src/lib/agent/agent-tool-receipts";

const scope = { endpoint: "http://agent.local", workspaceId: "workspace-a", clientId: "tab-a" };
const request = { requestId: "tool-a", connectionId: "connection-a" };

function fixture() {
    const records = new Map<string, unknown>();
    const storage = {
        getItem: async <T>(key: string) => (records.get(key) as T | undefined) ?? null,
        setItem: async <T>(key: string, value: T) => { records.set(key, value); return value; },
    };
    return { storage, records, receipts: new AgentToolReceipts(storage) };
}

test("lost result response leaves a durable receipt and duplicate never executes again", async () => {
    const { receipts, storage, records } = fixture();
    const sent: AgentToolResult[] = [];
    let executions = 0;
    await receipts.execute(scope, request, async () => { executions++; return { status: "committed", revision: 2 }; }, async (body) => {
        sent.push(body);
        throw new Error("HTTP response lost");
    });
    const reloaded = new AgentToolReceipts(storage);
    await reloaded.execute(scope, request, async () => { executions++; }, async (body) => { sent.push(body); });
    expect(executions).toBe(1);
    expect(sent).toEqual([{ ...request, result: { status: "committed", revision: 2 } }, { ...request, result: { status: "committed", revision: 2 } }]);
    expect([...records.values()]).toEqual([{ status: "acknowledged" }]);
});

test("acknowledged results retain only an identity tombstone and never rerun", async () => {
    const { receipts, storage, records } = fixture();
    let executions = 0;
    let deliveries = 0;
    await receipts.execute(scope, request, async () => { executions++; return { payload: "large result" }; }, async () => { deliveries++; });
    expect([...records.values()]).toEqual([{ status: "acknowledged" }]);
    const reloaded = new AgentToolReceipts(storage);
    await reloaded.execute(scope, request, async () => { executions++; }, async () => { deliveries++; });
    await reloaded.recover(scope, [request], async () => { deliveries++; });
    expect(executions).toBe(1);
    expect(deliveries).toBe(1);
});

test("failed tombstone write keeps the full receipt for safe replay", async () => {
    const { receipts, storage, records } = fixture();
    const write = storage.setItem;
    storage.setItem = async <T>(key: string, value: T) => {
        if ((value as { status?: string }).status === "acknowledged") throw new Error("disk full");
        return write(key, value);
    };
    const sent: AgentToolResult[] = [];
    await receipts.execute(scope, request, async () => "committed", async (body) => { sent.push(body); });
    expect([...records.values()]).toEqual([{ status: "settled", body: { ...request, result: "committed" } }]);
    await new AgentToolReceipts(storage).recover(scope, [request], async (body) => { sent.push(body); });
    expect(sent).toEqual([{ ...request, result: "committed" }, { ...request, result: "committed" }]);
});

test("reload turns an unfinished start into an unknown outcome without redoing the action", async () => {
    const { receipts, storage } = fixture();
    expect(await receipts.begin(scope, request)).toBe(true);
    const reloaded = new AgentToolReceipts(storage);
    const sent: AgentToolResult[] = [];
    await reloaded.recover(scope, [request], async (body) => { sent.push(body); });
    let executions = 0;
    await reloaded.execute(scope, request, async () => { executions++; }, async (body) => { sent.push(body); });
    expect(executions).toBe(0);
    expect(sent).toEqual([{ ...request, outcome: "unknown" }, { ...request, outcome: "unknown" }]);
});

test("pending server request with no local record is unknown and never executed", async () => {
    const { receipts } = fixture();
    const sent: AgentToolResult[] = [];
    await receipts.recover(scope, [request], async (body) => { sent.push(body); });
    let executions = 0;
    await receipts.execute(scope, request, async () => { executions++; }, async (body) => { sent.push(body); });
    expect(executions).toBe(0);
    expect(sent).toEqual([{ ...request, outcome: "unknown" }, { ...request, outcome: "unknown" }]);
});

test("reconnect during active execution neither marks unknown nor executes twice", async () => {
    const { receipts } = fixture();
    let release!: (value: string) => void;
    const action = new Promise<string>((resolve) => { release = resolve; });
    const sent: AgentToolResult[] = [];
    let executions = 0;
    const running = receipts.execute(scope, request, async () => { executions++; return action; }, async (body) => { sent.push(body); });
    while (!executions) await Promise.resolve();
    await receipts.recover(scope, [request], async (body) => { sent.push(body); });
    await receipts.execute(scope, request, async () => { executions++; }, async (body) => { sent.push(body); });
    expect(sent).toEqual([]);
    release("done");
    await running;
    expect(sent).toEqual([{ ...request, result: "done" }]);
    expect(executions).toBe(1);
});

test("reconnect during an action resends its saved receipt after an initial transport failure", async () => {
    const { receipts } = fixture();
    let release!: (value: string) => void;
    const action = new Promise<string>((resolve) => { release = resolve; });
    let executions = 0;
    const sent: AgentToolResult[] = [];
    const running = receipts.execute(scope, request, async () => { executions++; return action; }, async () => { throw new Error("socket disconnected"); });
    while (!executions) await Promise.resolve();
    await receipts.recover(scope, [request], async (body) => { sent.push(body); });
    release("committed");
    await running;
    expect(executions).toBe(1);
    expect(sent).toEqual([{ ...request, result: "committed" }]);
});

test("workspace, endpoint, client and generation each isolate receipts", async () => {
    const { receipts } = fixture();
    await receipts.execute(scope, request, async () => "one", async () => undefined);
    let executions = 0;
    for (const other of [
        [{ ...scope, workspaceId: "workspace-b" }, request],
        [{ ...scope, clientId: "tab-b" }, request],
        [{ ...scope, endpoint: "http://other.local" }, request],
        [scope, { ...request, connectionId: "connection-b" }],
    ] as const) {
        await receipts.execute(other[0], other[1], async () => { executions++; return "other"; }, async () => undefined);
    }
    expect(executions).toBe(4);
});

test("simultaneous duplicate deliveries share one action and one in-flight transport", async () => {
    const { receipts } = fixture();
    let release!: () => void;
    const transport = new Promise<void>((resolve) => { release = resolve; });
    let executions = 0;
    let deliveries = 0;
    const send = async () => { deliveries++; await transport; };
    const first = receipts.execute(scope, request, async () => { executions++; return "done"; }, send);
    await Promise.resolve();
    const second = receipts.execute(scope, request, async () => { executions++; return "duplicate"; }, send);
    release();
    await Promise.all([first, second]);
    expect(executions).toBe(1);
    expect(deliveries).toBe(1);
});

test("persistence failure after the action is not misreported as an action failure", async () => {
    const { storage, receipts } = fixture();
    const write = storage.setItem;
    let writes = 0;
    storage.setItem = async <T>(key: string, value: T) => {
        if (++writes === 2) throw new Error("disk full");
        return write(key, value);
    };
    let executions = 0;
    const sent: AgentToolResult[] = [];
    await expect(receipts.execute(scope, request, async () => { executions++; return "committed"; }, async (body) => { sent.push(body); })).rejects.toThrow("disk full");
    expect(executions).toBe(1);
    expect(sent).toEqual([]);
    const reloaded = new AgentToolReceipts(storage);
    await reloaded.recover(scope, [request], async (body) => { sent.push(body); });
    expect(sent).toEqual([{ ...request, outcome: "unknown" }]);
});

test("failure to persist the start prevents any side effect", async () => {
    const { storage, receipts } = fixture();
    storage.setItem = async () => { throw new Error("storage unavailable"); };
    let executions = 0;
    await expect(receipts.execute(scope, request, async () => { executions++; }, async () => undefined)).rejects.toThrow("storage unavailable");
    expect(executions).toBe(0);
});

test("an uncertain write reports unknown rather than a confirmed failure", async () => {
    const { receipts } = fixture();
    const sent: AgentToolResult[] = [];
    await receipts.execute(scope, request, async () => { throw new AgentToolOutcomeUnknownError("save response lost"); }, async (body) => { sent.push(body); });
    expect(sent).toEqual([{ ...request, outcome: "unknown" }]);
});
