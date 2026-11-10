import { test, expect } from "./auth";

test.beforeAll(() => {
    if (!/^\/infinite_canvas_e2e_[a-z0-9_]+$/.test(new URL(process.env.DATABASE_URL || "postgres://invalid/unsafe").pathname)) {
        throw new Error("Prompt write regression requires an isolated E2E database");
    }
});

test("stale prompt revisions cannot overwrite or delete a newer edit", async ({ request }) => {
    const { workspaces } = await (await request.get("/api/auth/me")).json();
    const headers = { "x-infinite-canvas-workspace": workspaces[0].id };
    const initial = { title: "Original", prompt: "First", description: "Keep", tags: ["saved"], shared: true };
    const createdResponse = await request.post("/api/prompts", { headers, data: initial });
    expect(createdResponse.status()).toBe(201);
    const created = (await createdResponse.json()).item;
    expect(typeof created.revision).toBe("string");

    const path = `/api/prompts/${encodeURIComponent(created.id)}`;
    const newerResponse = await request.put(path, { headers, data: { ...initial, prompt: "Second", expectedRevision: created.revision } });
    expect(newerResponse.status()).toBe(200);
    const newer = (await newerResponse.json()).item;
    expect(newer.revision).not.toBe(created.revision);

    const staleUpdate = await request.put(path, { headers, data: { ...initial, title: "Stale", expectedRevision: created.revision } });
    expect(staleUpdate.status()).toBe(409);
    expect((await staleUpdate.json()).error).toContain("已被修改");
    expect((await request.delete(`${path}?expectedRevision=${encodeURIComponent(created.revision)}`, { headers })).status()).toBe(409);
    const listed = (await (await request.get("/api/prompts", { headers })).json()).items;
    expect(listed.find((item: { id: string }) => item.id === created.id)).toMatchObject({ title: "Original", prompt: "Second", revision: newer.revision });
    expect((await request.delete(`${path}?expectedRevision=${encodeURIComponent(newer.revision)}`, { headers })).status()).toBe(200);
});
