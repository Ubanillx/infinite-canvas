import { afterEach, expect, test } from "bun:test";

import { clearActiveWorkspace, getActiveWorkspace, setActiveWorkspace, workspaceHeaders, workspaceStorageKey } from "../src/lib/workspace";

const first = { id: "workspace-a", name: "A", role: "editor" as const, createdAt: "2026-01-01T00:00:00Z" };
const second = { id: "workspace-b", name: "B", role: "viewer" as const, createdAt: "2026-01-02T00:00:00Z" };
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

function storage(values = new Map<string, string>()) {
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); },
    };
}

function selectTab(localStorage: ReturnType<typeof storage>, sessionStorage?: ReturnType<typeof storage>) {
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage, sessionStorage } });
}

afterEach(() => {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
});

test("each tab pins the workspace independently while sharing the last-used default", () => {
    const shared = storage();
    const tabA = storage();
    const tabB = storage();

    selectTab(shared, tabA);
    setActiveWorkspace(first);
    expect(getActiveWorkspace()?.id).toBe(first.id);

    selectTab(shared, tabB);
    expect(getActiveWorkspace()?.id).toBe(first.id);
    setActiveWorkspace(second);
    expect(getActiveWorkspace()?.id).toBe(second.id);
    expect(workspaceHeaders()).toEqual({ "x-infinite-canvas-workspace": second.id });

    selectTab(shared, tabA);
    expect(getActiveWorkspace()?.id).toBe(first.id);
    expect(workspaceHeaders()).toEqual({ "x-infinite-canvas-workspace": first.id });
    expect(workspaceStorageKey("canvas")).toBe(`workspace:${first.id}:canvas`);

    setActiveWorkspace(second);
    expect(getActiveWorkspace()?.id).toBe(second.id);
    expect(workspaceStorageKey("canvas")).toBe(`workspace:${second.id}:canvas`);
});

test("clearing one tab leaves another tab's pinned workspace intact", () => {
    const shared = storage();
    const tabA = storage();
    const tabB = storage();
    selectTab(shared, tabA);
    setActiveWorkspace(first);
    selectTab(shared, tabB);
    getActiveWorkspace();
    setActiveWorkspace(second);
    clearActiveWorkspace();
    expect(getActiveWorkspace()).toBeNull();

    selectTab(shared, tabA);
    expect(getActiveWorkspace()?.id).toBe(first.id);
    expect(workspaceHeaders()).toEqual({ "x-infinite-canvas-workspace": first.id });
});

test("a window without sessionStorage can still read the shared default", () => {
    const shared = storage();
    shared.setItem("infinite-canvas:active-workspace", JSON.stringify(first));
    selectTab(shared);
    expect(getActiveWorkspace()?.id).toBe(first.id);
    expect(workspaceStorageKey("assets")).toBe(`workspace:${first.id}:assets`);
});
