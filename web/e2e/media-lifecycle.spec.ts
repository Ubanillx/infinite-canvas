import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { test, expect, registerTestAccount } from "./auth";
import { execute, getPool, queryMany, queryOne, withTransaction } from "../src/server/db";
import { headMediaObject, listWorkspaceMediaObjects, mediaObjectKey, putMediaBuffer } from "../src/server/object-storage";
import { runMediaGcDryRun } from "../src/server/media-references";
import { createMediaIntent, failMediaIntent } from "../src/server/media-intents";

// Direct SQL is only for deliberately corrupt/concurrent fixtures in a disposable environment.
test.beforeAll(() => {
    if (!new URL(process.env.DATABASE_URL || "postgres://invalid/unsafe").pathname.startsWith("/infinite_canvas_e2e_") || !process.env.S3_BUCKET?.startsWith("infinite-canvas-e2e-")) throw new Error("Media regression requires an isolated E2E database and bucket");
});

const bytes = Buffer.from("independent media bytes");
const graph = (id: string, key?: string) => ({ id, nodes: key ? [{ id: "node", type: "image", metadata: { storageKey: key, content: key } }] : [], connections: [], chatSessions: [] });
const canvas = (id: string, key?: string) => ({ version: 0, state: { projects: [graph(id, key)], folders: [], deletedProjects: [] } });
const emptyTemplates = { version: 1, templates: [] };

async function fixture(request: Parameters<typeof registerTestAccount>[0]) {
    const { workspaces, user } = await (await request.get("/api/auth/me")).json();
    const workspace = workspaces[0];
    const headers = { "x-infinite-canvas-workspace": workspace.id };
    const put = (key: string, body = bytes) => request.put(`/api/media/blob/${encodeURIComponent(key)}`, { headers: { ...headers, "content-type": "application/octet-stream" }, data: body });
    const save = async (domain: string, payload: unknown, revision?: number) => {
        const current = revision ?? (await (await request.get(`/api/data/${domain}`, { headers })).json()).revision;
        return request.put(`/api/data/${domain}`, { headers, data: { revision: current, payload } });
    };
    const scan = async () => {
        const response = await request.post("/api/media/gc/dry-run", { headers });
        expect(response.status()).toBe(200);
        return response.json();
    };
    return { workspace, user, headers, put, save, scan };
}

test("membership scopes lists, private media and writes; only owners can scan", async ({ request, playwright, baseURL }) => {
    const f = await fixture(request);
    expect((await f.put("image:private")).status()).toBe(200);
    expect((await f.save("canvas", canvas("private", "image:private"))).status()).toBe(200);
    const anonymous = await playwright.request.newContext({ baseURL });
    try {
        expect((await anonymous.get("/api/workspaces")).status()).toBe(401);
        expect((await anonymous.post("/api/workspaces", { data: { name: "forbidden" } })).status()).toBe(401);
        expect((await anonymous.get("/api/data/canvas", { headers: f.headers })).status()).toBe(403);
        expect((await anonymous.get("/api/media/blob/image%3Aprivate", { headers: f.headers })).status()).toBe(403);
        expect((await anonymous.post("/api/media/gc/dry-run", { headers: f.headers })).status()).toBe(403);
    } finally { await anonymous.dispose(); }
    for (const role of ["outsider", "viewer", "editor"] as const) {
        const member = await playwright.request.newContext({ baseURL });
        try {
            const account = await registerTestAccount(member);
            if (role !== "outsider") await execute(await getPool(), "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, $3, now())", f.workspace.id, account.user.id, role);
            const list = (await (await member.get("/api/workspaces")).json()).workspaces;
            expect(list.some((item: { id: string }) => item.id === f.workspace.id)).toBe(role !== "outsider");
            const summaries = (await (await member.get("/api/workspaces/summaries")).json()).summaries;
            expect(f.workspace.id in summaries).toBe(role !== "outsider");
            expect((await member.get("/api/data/canvas", { headers: f.headers })).status()).toBe(role === "outsider" ? 403 : 200);
            expect((await member.get("/api/media/blob/image%3Aprivate", { headers: f.headers })).status()).toBe(role === "outsider" ? 403 : 200);
            expect((await member.put("/api/data/canvas-templates", { headers: f.headers, data: { revision: 0, payload: emptyTemplates } })).status()).toBe(role === "editor" ? 200 : 403);
            expect((await member.put("/api/media/blob/image%3Arole", { headers: f.headers, data: bytes })).status()).toBe(role === "editor" ? 200 : 403);
            expect((await member.post("/api/media/blob/image%3Aprivate/copy", { headers: f.headers })).status()).toBe(role === "editor" ? 200 : 403);
            expect((await member.post("/api/media/gc/dry-run", { headers: f.headers })).status()).toBe(403);
            expect((await member.get("/api/media/agent-attachments", { headers: f.headers })).status()).toBe(role === "outsider" ? 403 : 200);
            expect((await member.post("/api/media/agent-attachments", { headers: f.headers, data: { engine: "codex", threadId: "role-thread", clientMessageId: "role-message", attachments: [{ id: "file", name: "file", storageKey: "image:private", type: "application/octet-stream", size: bytes.length, width: 0, height: 0, purpose: "attachment" }] } })).status()).toBe(role === "editor" ? 200 : 403);
            expect((await member.post("/api/media", { headers: f.headers, data: { files: [] } })).status()).toBe(role === "editor" ? 200 : 403);
            if (role === "viewer") expect((await member.put("/api/webdav/workspaces/any/file", { headers: { ...f.headers, "x-infinite-canvas-sync-mode": "manual" }, data: bytes })).status()).toBe(403);
        } finally { await member.dispose(); }
    }
    const row = await queryOne<{ updated_by: string }>(await getPool(), "SELECT updated_by FROM workspace_data WHERE workspace_id = $1 AND domain = 'canvas'", f.workspace.id);
    expect(row?.updated_by).toBe(f.user.id);
    expect((await f.scan()).deletionEnabled).toBe(false);
});

test("CAS and reference updates commit together; unsupported writes preserve prior payload and references", async ({ request }) => {
    const f = await fixture(request);
    for (const key of ["image:one", "image:two"]) expect((await f.put(key)).ok()).toBe(true);
    expect((await f.save("canvas", canvas("one", "image:one"), 3)).status()).toBe(409);
    expect((await f.save("canvas", canvas("one", "image:one"), 0)).status()).toBe(200);
    expect((await f.save("canvas", canvas("two", "image:two"), 0)).status()).toBe(409);
    expect((await f.save("canvas", { version: 99, state: { projects: [] } }, 1)).status()).toBe(422);
    const refs = await queryMany<{ storage_key: string; source_revision: number; owner_id: string }>(await getPool(), "SELECT storage_key, source_revision, owner_id FROM media_references WHERE workspace_id = $1", f.workspace.id);
    expect(refs).toHaveLength(2);
    expect(refs.every((ref) => ref.storage_key === "image:one" && ref.source_revision === 1 && ref.owner_id === "one")).toBe(true);
    const stored = (await (await request.get("/api/data/canvas", { headers: f.headers })).json());
    expect(stored.revision).toBe(1);
    expect(stored.payload.state.projects[0].id).toBe("one");
});

test("ownerless IDs, removed memberships and expired sessions cannot grant workspace access", async ({ request }) => {
    const f = await fixture(request);
    const db = await getPool();
    const unowned = randomUUID();
    await execute(db, "INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ($1, 'unowned', now(), now())", unowned);
    const headers = { "x-infinite-canvas-workspace": unowned };
    expect((await request.get("/api/data/canvas", { headers })).status()).toBe(403);
    expect((await request.post("/api/media/gc/dry-run", { headers })).status()).toBe(403);
    expect((await (await request.get("/api/workspaces")).json()).workspaces.some((item: { id: string }) => item.id === unowned)).toBe(false);
    await execute(db, "DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", f.workspace.id, f.user.id);
    expect((await request.get("/api/data/canvas", { headers: f.headers })).status()).toBe(403);
    expect((await f.put("image:revoked")).status()).toBe(403);
    expect((await request.get("/api/prompts", { headers: f.headers })).status()).toBe(403);
    await execute(db, "UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1", f.user.id);
    expect((await (await request.get("/api/auth/me")).json()).user).toBeNull();
    expect((await request.get("/api/workspaces")).status()).toBe(401);
    expect((await request.get("/api/data/canvas", { headers: f.headers })).status()).toBe(403);
});

test("private prompt images require membership, while explicit sharing remains readable", async ({ request, playwright, baseURL }) => {
    const f = await fixture(request);
    const image = Buffer.from("prompt image");
    const data = { title: "Private", prompt: "Private prompt", shared: false, coverDataUrl: `data:image/png;base64,${image.toString("base64")}` };
    const created = await request.post("/api/prompts", { headers: f.headers, data });
    expect(created.status()).toBe(201);
    const { item } = await created.json();
    const member = await playwright.request.newContext({ baseURL });
    try {
        const account = await registerTestAccount(member);
        expect((await member.get("/api/prompts", { headers: f.headers })).status()).toBe(403);
        expect((await member.get(item.coverUrl)).status()).toBe(403);
        await execute(await getPool(), "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'viewer', now())", f.workspace.id, account.user.id);
        expect((await member.get("/api/prompts", { headers: f.headers })).status()).toBe(200);
        expect(await (await member.get(item.coverUrl)).body()).toEqual(image);
        expect((await member.post("/api/prompts", { headers: f.headers, data })).status()).toBe(403);
        expect((await member.put(`/api/prompts/${item.id}`, { headers: f.headers, data })).status()).toBe(403);
        expect((await member.delete(`/api/prompts/${item.id}`, { headers: f.headers })).status()).toBe(403);
        await execute(await getPool(), "DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", f.workspace.id, account.user.id);
        expect((await member.get(item.coverUrl)).status()).toBe(403);
        expect((await request.put(`/api/prompts/${item.id}`, { headers: f.headers, data: { ...data, shared: true } })).status()).toBe(200);
        expect(await (await member.get(item.coverUrl)).body()).toEqual(image);
        expect((await member.put(`/api/prompts/${item.id}`, { headers: f.headers, data })).status()).toBe(403);
    } finally { await member.dispose(); }
});

test("dry-run reports unreferenced registered copies without deleting objects or changing source/template/derived independence", async ({ request }) => {
    const f = await fixture(request);
    for (const key of ["image:source", "image:cover", "image:orphan"]) expect((await f.put(key)).ok()).toBe(true);
    const copy = async (key: string) => (await (await request.post(`/api/media/blob/${encodeURIComponent(key)}/copy`, { headers: f.headers })).json()).storageKey as string;
    const templateKey = await copy("image:source");
    const derivedKey = await copy(templateKey);
    const template = { id: "template", cover: { storageKey: "image:cover" }, content: graph("template", templateKey) };
    expect((await f.save("canvas", { version: 0, state: { projects: [graph("source", "image:source"), graph("derived", derivedKey)], folders: [] } })).ok()).toBe(true);
    expect((await f.save("canvas-templates", { version: 1, templates: [template] })).ok()).toBe(true);
    const first = await f.scan();
    expect(first.status).toBe("succeeded");
    expect(first.referencedObjectCount).toBe(4);
    expect(first.candidates.map((item: { storageKey: string }) => item.storageKey)).toEqual(["image:orphan"]);
    expect((await f.save("canvas-templates", emptyTemplates)).ok()).toBe(true);
    expect((await f.save("canvas", canvas("derived", derivedKey))).ok()).toBe(true);
    const second = await f.scan();
    expect(second.status).toBe("succeeded");
    expect(second.candidates).toHaveLength(4);
    expect(second.candidates.every((item: { eligibleForDeletion: boolean }) => !item.eligibleForDeletion)).toBe(true);
    expect(second.candidates.some((item: { storageKey: string }) => item.storageKey === derivedKey)).toBe(false);
    for (const key of ["image:source", "image:cover", "image:orphan", templateKey, derivedKey]) {
        const media = await request.get(`/api/media/blob/${encodeURIComponent(key)}`, { headers: f.headers });
        expect(await media.body()).toEqual(bytes);
    }
    const saved = await queryOne<{ report: unknown }>(await getPool(), "SELECT report FROM media_reference_scans WHERE scan_id = $1 AND workspace_id = $2", second.scanId, f.workspace.id);
    expect(saved?.report).toEqual(second);
    expect(second.scope).toBe("workspace-prefix-reconciliation");
});

test("unknown versions, corrupt JSON, unknown domains and missing objects block scans without replacing the last inventory", async ({ request }) => {
    const f = await fixture(request);
    expect((await f.put("image:keep")).ok()).toBe(true);
    expect((await f.save("canvas", canvas("keep", "image:keep"))).ok()).toBe(true);
    const db = await getPool();
    const original = await queryMany(db, "SELECT * FROM media_references WHERE workspace_id = $1 ORDER BY json_path", f.workspace.id);
    for (const payload of ["{", JSON.stringify({ version: 999, state: { projects: [] } }), JSON.stringify({ state: {} })]) {
        await execute(db, "UPDATE workspace_data SET payload = $1 WHERE workspace_id = $2 AND domain = 'canvas'", payload, f.workspace.id);
        const report = await f.scan();
        expect(report.status).toBe("blocked"); expect(report.candidates).toEqual([]);
        expect(await queryMany(db, "SELECT * FROM media_references WHERE workspace_id = $1 ORDER BY json_path", f.workspace.id)).toEqual(original);
    }
    await execute(db, "UPDATE workspace_data SET payload = $1 WHERE workspace_id = $2 AND domain = 'canvas'", JSON.stringify(canvas("keep", "image:keep")), f.workspace.id);
    await execute(db, "INSERT INTO workspace_data (workspace_id, domain, payload, revision, updated_at, updated_by) VALUES ($1, 'future-domain', '{}', 1, now(), $2)", f.workspace.id, f.user.id);
    expect((await f.scan()).status).toBe("blocked");
    await execute(db, "DELETE FROM workspace_data WHERE workspace_id = $1 AND domain = 'future-domain'", f.workspace.id);
    await execute(db, "INSERT INTO media_files (workspace_id, storage_key, remote_path, mime_type, bytes, created_at, updated_at) VALUES ($1, 'image:absent', '', 'image/png', 1, now(), now())", f.workspace.id);
    const missing = await f.scan();
    expect(missing.status).toBe("blocked"); expect(missing.candidates).toEqual([]);
    expect(missing.diagnostics[0].storageKey).toBe("image:absent");
    expect(await queryMany(db, "SELECT * FROM media_references WHERE workspace_id = $1 ORDER BY json_path", f.workspace.id)).toEqual(original);
});

test("a concurrent save during HEAD checks blocks stale results and keeps new references", async ({ request }) => {
    const f = await fixture(request);
    for (const key of ["image:old", "image:new"]) expect((await f.put(key)).ok()).toBe(true);
    expect((await f.save("canvas", canvas("old", "image:old"))).ok()).toBe(true);
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const running = runMediaGcDryRun(f.workspace.id, async (key) => { entered(); await gate; return headMediaObject(key); });
    await waiting;
    try { expect((await f.save("canvas", canvas("new", "image:new"))).ok()).toBe(true); }
    finally { release(); }
    const report = await running;
    expect(report.status).toBe("blocked"); expect(report.candidates).toEqual([]);
    const refs = await queryMany<{ storage_key: string }>(await getPool(), "SELECT storage_key FROM media_references WHERE workspace_id = $1", f.workspace.id);
    expect(refs.every((ref) => ref.storage_key === "image:new")).toBe(true);
    const failedHead = await runMediaGcDryRun(f.workspace.id, async () => { throw new Error("simulated unavailable storage"); });
    expect(failedHead.status).toBe("blocked"); expect(failedHead.candidates).toEqual([]);
});

test("media-index changes during HEAD checks invalidate the scan without changing the last inventory", async ({ request }) => {
    const f = await fixture(request);
    expect((await f.put("image:keep")).ok()).toBe(true);
    expect((await f.save("canvas", canvas("keep", "image:keep"))).ok()).toBe(true);
    const db = await getPool();
    const original = await queryMany(db, "SELECT * FROM media_references WHERE workspace_id = $1 ORDER BY json_path", f.workspace.id);
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const running = runMediaGcDryRun(f.workspace.id, async (key) => { entered(); await gate; return headMediaObject(key); });
    await waiting;
    try { expect((await f.put("image:concurrent")).ok()).toBe(true); }
    finally { release(); }
    const report = await running;
    expect(report.status).toBe("blocked");
    expect(report.candidates).toEqual([]);
    expect(await queryMany(db, "SELECT * FROM media_references WHERE workspace_id = $1 ORDER BY json_path", f.workspace.id)).toEqual(original);
    expect((await request.get("/api/media/blob/image%3Aconcurrent", { headers: f.headers })).ok()).toBe(true);
});

test("external snapshot indexes are excluded and an unindexed reference blocks the workspace only", async ({ request, playwright, baseURL }) => {
    const f = await fixture(request);
    expect((await f.put("image:known")).ok()).toBe(true);
    expect((await request.post("/api/media", { headers: f.headers, data: { files: [{ storageKey: "image:remote", remotePath: "snapshots/remote.png", mimeType: "image/png", bytes: 10 }] } })).ok()).toBe(true);
    expect((await f.scan()).candidates.map((item: { storageKey: string }) => item.storageKey)).toEqual(["image:known"]);
    expect((await f.save("canvas", canvas("missing", "image:no_index"))).ok()).toBe(true);
    const blocked = await f.scan();
    expect(blocked.status).toBe("blocked"); expect(blocked.candidates).toEqual([]);
    const other = await playwright.request.newContext({ baseURL });
    try {
        const account = await registerTestAccount(other);
        const report = await (await other.post("/api/media/gc/dry-run", { headers: { "x-infinite-canvas-workspace": account.workspaces[0].id } })).json();
        expect(report.status).toBe("succeeded"); expect(report.candidates).toEqual([]);
    } finally { await other.dispose(); }
});

test("an upload intent precedes object completion, blocks same-key writes and completes atomically with its index", async ({ request, baseURL }) => {
    const f = await fixture(request);
    const key = "image:streamed";
    expect((await f.put(key)).ok()).toBe(true);
    const cookies = (await request.storageState()).cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
    let upload!: ReturnType<typeof httpRequest>;
    const pending = new Promise<number>((resolve, reject) => {
        upload = httpRequest(`${baseURL}/api/media/blob/${encodeURIComponent(key)}`, { method: "PUT", headers: { ...f.headers, cookie: cookies, "content-type": "application/octet-stream", "content-length": bytes.length } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
        upload.on("error", reject);
        upload.write(bytes.subarray(0, 1));
        upload.flushHeaders();
    }).then((status) => ({ status }), (error) => ({ status: 0, error }));
    try {
        await expect.poll(async () => (await queryOne<{ count: string }>(await getPool(), "SELECT COUNT(*) AS count FROM media_write_intents WHERE workspace_id = $1 AND storage_key = $2 AND state = 'active'", f.workspace.id, key))?.count).toBe("1");
        const report = await f.scan();
        expect(report.status).toBe("blocked"); expect(report.candidates).toEqual([]);
        expect(report.reconciliation.writeIntents.some((intent: { state: string }) => intent.state === "active")).toBe(true);
        expect((await f.put(key)).status()).toBe(409);
        expect((await request.post(`/api/media/blob/${encodeURIComponent(key)}/copy`, { headers: f.headers })).status()).toBe(409);
    } finally { upload.end(bytes.subarray(1)); }
    expect((await pending).status).toBe(200);
    const rows = await queryMany<{ state: string; expected_bytes: string; created_by: string }>(await getPool(), "SELECT state, expected_bytes, created_by FROM media_write_intents WHERE workspace_id = $1", f.workspace.id);
    expect(rows.every((row) => row.state === "completed" && Number(row.expected_bytes) === bytes.length && row.created_by === f.user.id)).toBe(true);
    expect((await f.scan()).status).toBe("succeeded");
    const copy = await request.post(`/api/media/blob/${encodeURIComponent(key)}/copy`, { headers: f.headers });
    expect(copy.ok()).toBe(true);
    const copied = (await copy.json()).storageKey;
    expect((await queryOne<{ state: string }>(await getPool(), "SELECT state FROM media_write_intents WHERE workspace_id = $1 AND storage_key = $2 AND operation = 'copy' AND source_key = $3", f.workspace.id, copied, key))?.state).toBe("completed");
});

test("failed index commits retain the intent and objects, and reconciliation reports known and unknown unindexed orphans only in this workspace", async ({ request }) => {
    const f = await fixture(request);
    const key = "image:failed_index";
    const id = await withTransaction(async (tx) => {
        await execute(tx, "SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", f.workspace.id);
        return createMediaIntent(tx, f.workspace.id, f.user.id, key, { operation: "upload", expectedBytes: bytes.length });
    });
    expect(id).toBeTruthy();
    await putMediaBuffer(mediaObjectKey(f.workspace.id, key), bytes, "application/octet-stream");
    await expect(withTransaction(async (tx) => {
        await execute(tx, "INSERT INTO media_files (workspace_id, storage_key, remote_path, mime_type, bytes, created_at, updated_at) VALUES ($1, $2, '', 'application/octet-stream', $3, now(), now())", f.workspace.id, key, bytes.length);
        throw new Error("simulated index transaction failure");
    })).rejects.toThrow();
    await failMediaIntent(f.workspace.id, id!);
    await putMediaBuffer(`media/${f.workspace.id}/unknown-hash`, bytes, "application/octet-stream");
    await putMediaBuffer(`media/other-workspace/${randomUUID()}`, bytes, "application/octet-stream");
    const report = await f.scan();
    expect(report.status).toBe("succeeded"); expect(report.candidates).toEqual([]);
    expect(report.reconciliation.unindexedObjects).toHaveLength(2);
    const known = report.reconciliation.unindexedObjects.find((entry: { storageKey: string }) => entry.storageKey === key);
    expect(known.intentId).toBe(id); expect(known.intentState).toBe("failed"); expect(known.eligibleForDeletion).toBe(false);
    expect(report.reconciliation.unindexedObjects.every((entry: { objectKey: string }) => entry.objectKey.startsWith(`media/${f.workspace.id}/`))).toBe(true);
    expect((await headMediaObject(mediaObjectKey(f.workspace.id, key))).contentLength).toBe(bytes.length);
    expect((await request.get(`/api/media/blob/${encodeURIComponent(key)}`, { headers: f.headers })).status()).toBe(404);
});

test("list failures, object mutations and new write intents invalidate dry-run without replacing prior references", async ({ request }) => {
    const f = await fixture(request);
    expect((await f.put("image:keep")).ok()).toBe(true);
    expect((await f.save("canvas", canvas("keep", "image:keep"))).ok()).toBe(true);
    const db = await getPool();
    const original = await queryMany(db, "SELECT * FROM media_references WHERE workspace_id = $1 ORDER BY json_path", f.workspace.id);
    const unavailable = await runMediaGcDryRun(f.workspace.id, headMediaObject, async () => { throw new Error("list unavailable"); });
    expect(unavailable.status).toBe("blocked"); expect(unavailable.candidates).toEqual([]);
    let calls = 0;
    const changing = await runMediaGcDryRun(f.workspace.id, headMediaObject, async (workspace) => {
        const listed = await listWorkspaceMediaObjects(workspace);
        return ++calls === 1 ? listed : listed.map((object) => ({ ...object, eTag: "changed" }));
    });
    expect(changing.status).toBe("blocked"); expect(changing.candidates).toEqual([]);
    const running = await runMediaGcDryRun(f.workspace.id, async (key) => {
        await withTransaction(async (tx) => {
            await execute(tx, "SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", f.workspace.id);
            await createMediaIntent(tx, f.workspace.id, f.user.id, "image:crashed", { operation: "upload", expectedBytes: 1 });
        });
        return headMediaObject(key);
    });
    expect(running.status).toBe("blocked"); expect(running.candidates).toEqual([]);
    expect(await queryMany(db, "SELECT * FROM media_references WHERE workspace_id = $1 ORDER BY json_path", f.workspace.id)).toEqual(original);
    expect((await f.scan()).status).toBe("blocked");
    expect((await request.get("/api/media/blob/image%3Akeep", { headers: f.headers })).ok()).toBe(true);
});
