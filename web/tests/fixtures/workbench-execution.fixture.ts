import { expect, mock, test } from "bun:test";
const records = new Map<string, unknown>();
mock.module("localforage", () => ({ default: { createInstance: () => ({ getItem: async (key: string) => records.get(key), setItem: async (key: string, value: unknown) => { records.set(key, value); } }) } }));
Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: { getItem: () => JSON.stringify({ id: "workspace", name: "fixture", role: "owner" }) } } });
const { reserveWorkbenchExecution } = await import("../../src/services/workbench-execution");

test("script to server and server to script both reject the same request ID", async () => {
    await reserveWorkbenchExecution("workspace", "image", "script", "browser");
    await expect(reserveWorkbenchExecution("workspace", "image", "script", "server")).rejects.toThrow("requestId");
    await reserveWorkbenchExecution("workspace", "video", "server", "server");
    await expect(reserveWorkbenchExecution("workspace", "video", "server", "browser")).rejects.toThrow("requestId");
    await reserveWorkbenchExecution("workspace", "image", "script", "browser");
});

test("concurrent conflicting routes reserve only one execution type", async () => {
    const results = await Promise.allSettled([reserveWorkbenchExecution("workspace", "image", "concurrent", "browser"), reserveWorkbenchExecution("workspace", "image", "concurrent", "server")]);
    expect(results.map((item) => item.status)).toEqual(["fulfilled", "rejected"]);
});

test("workspace request ID scope also rejects cross-kind execution changes", async () => {
    await reserveWorkbenchExecution("workspace", "image", "cross-kind", "browser");
    await expect(reserveWorkbenchExecution("workspace", "video", "cross-kind", "server")).rejects.toThrow("requestId");
    await expect(reserveWorkbenchExecution("workspace", "video", "cross-kind", "browser")).rejects.toThrow("requestId");
});
