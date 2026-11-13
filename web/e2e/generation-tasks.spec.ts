import { randomUUID } from "node:crypto";
import { test, expect, registerTestAccount } from "./auth";
import { execute, getPool, queryOne } from "../src/server/db";
import { createGenerationTask, createGenerationWorker, hideGenerationTask, readGenerationTask, resumeGenerationTask, type GenerationTaskOptions } from "../src/server/generation-tasks";
import { ProviderRequestError } from "../src/server/generation-provider";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
const imageOutput = { kind: "inline" as const, dataUrl: `data:image/png;base64,${png.toString("base64")}` };
const channel = { id: "mock", baseUrl: "http://127.0.0.1:1", apiKey: "SECRET-NOT-PUBLIC", apiFormat: "openai" as const, model: "mock-image" };

test.describe.configure({ mode: "serial" });
test.skip(({ isMobile }) => isMobile, "A single database leader runs injected provider fixtures in the desktop project");

test.beforeAll(() => {
    const database = new URL(process.env.DATABASE_URL || "postgres://invalid/unsafe").pathname;
    if (!/^\/infinite_canvas_e2e_[a-z0-9_]+$/.test(database) || !process.env.S3_BUCKET?.startsWith("infinite-canvas-e2e-") || process.env.INFINITE_CANVAS_GENERATION_WORKER !== "off") {
        throw new Error("Generation task tests require an isolated database/bucket and disabled app worker");
    }
});

function options(implementation: Partial<NonNullable<GenerationTaskOptions["provider"]>> = {}): GenerationTaskOptions {
    const fail = async () => { throw new Error("Unexpected provider call"); };
    return {
        resolveChannel: async (model) => ({ ...channel, model }),
        provider: {
            submitImage: fail,
            submitVideo: fail,
            pollVideo: fail,
            downloadOutput: async (_channel, output) => {
                if (output.kind !== "inline") throw new Error("Unexpected non-inline output");
                const match = /^data:([^;]+);base64,(.+)$/.exec(output.dataUrl);
                if (!match) throw new Error("Malformed inline fixture");
                return { bytes: Buffer.from(match[2], "base64"), mimeType: match[1] };
            },
            ...implementation,
        },
    };
}

async function contextFor(request: Parameters<typeof registerTestAccount>[0]) {
    const { workspaces, user } = await (await request.get("/api/auth/me")).json();
    return { id: workspaces[0].id as string, userId: user.id as string, role: "owner" as const };
}

function payload(kind: "image" | "video", requestId = randomUUID()) {
    return { requestId, kind, prompt: "Isolated simulated generation", model: "mock-image", settings: kind === "image" ? { count: 1 } : { seconds: "6" }, references: [] };
}

test("same request ID submits once; changed parameters conflict; public task excludes credentials", async ({ request }) => {
    const context = await contextFor(request);
    let submits = 0;
    const deps = options({ submitImage: async () => { submits++; return [imageOutput]; } });
    const input = payload("image");
    const first = await createGenerationTask(context, input, deps);
    const repeated = await createGenerationTask(context, structuredClone(input), deps);
    expect(repeated.id).toBe(first.id);
    await expect(createGenerationTask(context, { ...input, prompt: "Different prompt" }, deps)).rejects.toMatchObject({ status: 409 });
    const worker = createGenerationWorker(deps);
    try {
        await worker.tick();
        await expect.poll(async () => (await readGenerationTask(context.id, first.id)).status).toBe("succeeded");
    } finally { await worker.stop(); }
    expect(submits).toBe(1);
    const persisted = await readGenerationTask(context.id, first.id);
    expect(persisted.outputs).toHaveLength(1);
    expect(persisted.outputs[0].storageKey).toMatch(/^image:/);
    expect(JSON.stringify(persisted)).not.toMatch(/SECRET-NOT-PUBLIC|data:image\/png;base64|127\.0\.0\.1/);
    const media = await request.get(`/api/media/blob/${encodeURIComponent(persisted.outputs[0].storageKey)}`, { headers: { "x-infinite-canvas-workspace": context.id } });
    expect(media.ok()).toBe(true);
    expect(await media.body()).toEqual(png);
    const scan = await request.post("/api/media/gc/dry-run", { headers: { "x-infinite-canvas-workspace": context.id } });
    expect(scan.status()).toBe(200);
    const gc = await scan.json();
    expect(gc.status).toBe("succeeded");
    expect(gc.domainRevisions["generation-tasks"]).toBeGreaterThan(0);
    expect(JSON.stringify(gc.candidates || [])).not.toContain(persisted.outputs[0].storageKey);
    const reference = await queryOne<{ owner_id: string }>(await getPool(), "SELECT owner_id FROM media_references WHERE workspace_id = $1 AND source_domain = 'generation-tasks' AND storage_key = $2", context.id, persisted.outputs[0].storageKey);
    expect(reference?.owner_id).toBe(first.id);
    await hideGenerationTask(context, first.id);
    const direct = await request.get(`/api/generation-tasks/${first.id}`, { headers: { "x-infinite-canvas-workspace": context.id } });
    expect(direct.status()).toBe(200);
    expect((await direct.json()).task.outputs[0].storageKey).toBe(persisted.outputs[0].storageKey);
    const listed = await request.get("/api/generation-tasks?kind=image", { headers: { "x-infinite-canvas-workspace": context.id } });
    expect((await listed.json()).items.some((item: { id: string }) => item.id === first.id)).toBe(false);
    const second = await request.post("/api/workspaces", { data: { name: "Other generation workspace" } });
    expect(second.ok()).toBe(true);
    const otherId = (await second.json()).workspace.id;
    expect((await request.get(`/api/media/blob/${encodeURIComponent(persisted.outputs[0].storageKey)}`, { headers: { "x-infinite-canvas-workspace": otherId } })).status()).toBe(404);
    await expect(readGenerationTask(otherId, first.id)).rejects.toMatchObject({ status: 404 });
});

test("uncertain image submission remains inspectable and never resubmits after restart", async ({ request }) => {
    const context = await contextFor(request);
    let submits = 0;
    const deps = options({ submitImage: async () => { submits++; throw new Error("Response lost after charge"); } });
    const created = await createGenerationTask(context, payload("image"), deps);
    const first = createGenerationWorker(deps);
    try {
        await first.tick();
        await expect.poll(async () => (await readGenerationTask(context.id, created.id)).errorCode).toBe("submission_uncertain");
    } finally { await first.stop(); }
    await expect(resumeGenerationTask(context, created.id)).rejects.toMatchObject({ status: 409 });
    const restarted = createGenerationWorker(deps);
    try { await restarted.tick(); } finally { await restarted.stop(); }
    expect(submits).toBe(1);
    expect((await readGenerationTask(context.id, created.id)).status).toBe("needs_attention");
});

test("retryable image failure switches channels and exposes the retry count", async ({ request }) => {
    const context = await contextFor(request);
    const channels = ["primary", "backup"].map((id) => ({ ...channel, id }));
    const attempts: string[] = [];
    const deps = {
        ...options({
            submitImage: async (resolved) => {
                attempts.push(resolved.id);
                if (resolved.id === "primary") throw new ProviderRequestError("provider busy", 503, "retryable");
                return [imageOutput];
            },
        }),
        resolveChannels: async () => channels,
        retryDelaysMs: [0, 0],
    };
    const created = await createGenerationTask(context, payload("image"), deps);
    const worker = createGenerationWorker(deps);
    try {
        await worker.tick();
        await expect.poll(async () => (await readGenerationTask(context.id, created.id)).status).toBe("succeeded");
    } finally { await worker.stop(); }
    const task = await readGenerationTask(context.id, created.id);
    expect(attempts).toEqual(["primary", "backup"]);
    expect(task.retryCount).toBe(1);
});

test("definitive image rejection fails without repeating the request", async ({ request }) => {
    const context = await contextFor(request);
    let submits = 0;
    const deps = options({
        submitImage: async () => {
            submits += 1;
            throw new ProviderRequestError("invalid request", 400, "definitive");
        },
    });
    const created = await createGenerationTask(context, payload("image"), deps);
    const worker = createGenerationWorker(deps);
    try {
        await worker.tick();
        await expect.poll(async () => (await readGenerationTask(context.id, created.id)).status).toBe("failed");
    } finally { await worker.stop(); }
    expect(submits).toBe(1);
    expect((await readGenerationTask(context.id, created.id)).retryCount).toBe(0);
});

test("two workers elect a single submitter for one idempotent request", async ({ request }) => {
    const context = await contextFor(request);
    let submits = 0;
    const deps = options({ submitImage: async () => { submits++; return [imageOutput]; } });
    const created = await createGenerationTask(context, payload("image"), deps);
    const first = createGenerationWorker(deps);
    const second = createGenerationWorker(deps);
    try {
        await Promise.all([first.tick(), second.tick()]);
        await expect.poll(async () => (await readGenerationTask(context.id, created.id)).status).toBe("succeeded");
    } finally { await Promise.all([first.stop(), second.stop()]); }
    expect(submits).toBe(1);
});

test("leader connection loss leaves an in-flight submission uncertain without replay", async ({ request }) => {
    const context = await contextFor(request);
    let submits = 0;
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const deps = options({ submitImage: async () => { submits++; started(); await hold; return [imageOutput]; } });
    const created = await createGenerationTask(context, payload("image"), deps);
    const first = createGenerationWorker(deps);
    const second = createGenerationWorker(deps);
    try {
        await first.tick();
        await entered;
        const lock = await queryOne<{ pid: number }>(await getPool(), `SELECT l.pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
            WHERE l.locktype = 'advisory' AND l.granted AND l.mode = 'ExclusiveLock' AND a.datname = current_database()`);
        expect(lock?.pid).toBeTruthy();
        const killed = await queryOne<{ terminated: boolean }>(await getPool(), "SELECT pg_terminate_backend($1) AS terminated", lock!.pid);
        expect(killed?.terminated).toBe(true);
        await expect.poll(async () => {
            await second.tick();
            return (await readGenerationTask(context.id, created.id)).errorCode;
        }).toBe("submission_uncertain");
        release();
        await expect.poll(async () => (await readGenerationTask(context.id, created.id)).status).toBe("needs_attention");
    } finally { release(); await Promise.all([first.stop(), second.stop()]); }
    expect(submits).toBe(1);
    expect((await readGenerationTask(context.id, created.id)).outputs).toHaveLength(0);
});

test("recovered video submitting state never posts another charge", async ({ request }) => {
    const context = await contextFor(request);
    let submits = 0;
    const deps = options({ submitVideo: async () => { submits++; throw new Error("Unexpected duplicate submit"); } });
    const created = await createGenerationTask(context, payload("video"), deps);
    await execute(await getPool(), "UPDATE generation_tasks SET status = 'submitting' WHERE id = $1", created.id);
    const restarted = createGenerationWorker(deps);
    try {
        await restarted.tick();
        await expect.poll(async () => (await readGenerationTask(context.id, created.id)).errorCode).toBe("submission_uncertain");
    } finally { await restarted.stop(); }
    expect(submits).toBe(0);
    await expect(resumeGenerationTask(context, created.id)).rejects.toMatchObject({ status: 409 });
});

test("image child slots preserve one result while an uncertain slot never resubmits", async ({ request }) => {
    const context = await contextFor(request);
    let submits = 0;
    const deps = options({ submitImage: async () => {
        if (++submits === 1) return [imageOutput];
        throw new Error("Second image response lost");
    } });
    const created = await createGenerationTask(context, { ...payload("image"), settings: { count: 2 } }, deps);
    const worker = createGenerationWorker(deps);
    try {
        await worker.tick();
        await expect.poll(async () => (await readGenerationTask(context.id, created.id)).status).toBe("needs_attention");
    } finally { await worker.stop(); }
    const first = await readGenerationTask(context.id, created.id);
    expect(first.errorCode).toBe("submission_uncertain");
    expect(first.outputs).toHaveLength(1);
    expect(first.outputs[0].storageKey).toMatch(/^image:/);
    const restarted = createGenerationWorker(deps);
    try { await restarted.tick(); } finally { await restarted.stop(); }
    expect(submits).toBe(2);
    expect((await readGenerationTask(context.id, created.id)).outputs).toEqual(first.outputs);
});

test("completed image checkpoint survives missing channel and resumes only its queued sibling", async ({ request }) => {
    const context = await contextFor(request);
    let available = false;
    let submits = 0;
    const deps = options({ submitImage: async () => { submits++; return [imageOutput]; } });
    deps.resolveChannel = async (model) => {
        if (!available) throw new Error("Channel temporarily unavailable");
        return { ...channel, model };
    };
    const created = await createGenerationTask(context, { ...payload("image"), settings: { count: 2 } }, { ...deps, resolveChannel: async (model) => ({ ...channel, model }) });
    await execute(await getPool(), "UPDATE generation_tasks SET submissions = $2::jsonb WHERE id = $1", created.id, JSON.stringify([{ status: "completed", outputs: [imageOutput] }, { status: "queued" }]));
    const missing = createGenerationWorker(deps);
    try {
        await missing.tick();
        await expect.poll(async () => (await readGenerationTask(context.id, created.id)).errorCode).toBe("configuration_changed");
    } finally { await missing.stop(); }
    expect(submits).toBe(0);
    available = true;
    const resumed = await resumeGenerationTask(context, created.id);
    expect(resumed.status).toBe("queued");
    const recovered = createGenerationWorker(deps);
    try {
        await recovered.tick();
        await expect.poll(async () => (await readGenerationTask(context.id, created.id)).status).toBe("succeeded");
    } finally { await recovered.stop(); }
    expect(submits).toBe(1);
    const task = await readGenerationTask(context.id, created.id);
    expect(task.outputs).toHaveLength(2);
    expect(new Set(task.outputs.map((output) => output.storageKey)).size).toBe(2);
});

test("known video ID resumes polling after worker restart without another submit", async ({ request }) => {
    const context = await contextFor(request);
    let submits = 0;
    let polls = 0;
    const deps = options({
        submitVideo: async () => { submits++; return { id: "mock-upstream-id", provider: "openai", model: "mock-image", channelId: "mock" }; },
        pollVideo: async () => ++polls === 1 ? { status: "pending" } : { status: "completed", output: { kind: "provider", path: "videos/mock-upstream-id/content" } },
        downloadOutput: async () => ({ bytes: Buffer.from("simulated video bytes"), mimeType: "video/mp4" }),
    });
    const created = await createGenerationTask(context, payload("video"), deps);
    const first = createGenerationWorker(deps);
    try {
        await first.tick();
        await expect.poll(async () => (await queryOne<{ poll_count: number }>(await getPool(), "SELECT poll_count FROM generation_tasks WHERE id = $1", created.id))?.poll_count).toBe(1);
    } finally { await first.stop(); }
    await execute(await getPool(), "UPDATE generation_tasks SET next_poll_at = now() WHERE id = $1", created.id);
    const restarted = createGenerationWorker(deps);
    try {
        await restarted.tick();
        await expect.poll(async () => (await readGenerationTask(context.id, created.id)).status).toBe("succeeded");
    } finally { await restarted.stop(); }
    expect(submits).toBe(1);
    expect(polls).toBe(2);
    const task = await readGenerationTask(context.id, created.id);
    expect(task.outputs[0].storageKey).toMatch(/^video:/);
    expect(JSON.stringify(task)).not.toContain("mock-upstream-id/content");
});

test("archive failure replays saved result without charging provider again", async ({ request }) => {
    const context = await contextFor(request);
    let submits = 0;
    let downloads = 0;
    const deps = options({
        submitImage: async () => { submits++; return [imageOutput]; },
        downloadOutput: async () => { if (++downloads === 1) throw new Error("Object store unavailable"); return { bytes: png, mimeType: "image/png" }; },
    });
    const created = await createGenerationTask(context, payload("image"), deps);
    const first = createGenerationWorker(deps);
    try {
        await first.tick();
        await expect.poll(async () => (await readGenerationTask(context.id, created.id)).errorCode).toBe("archive_failed");
    } finally { await first.stop(); }
    const resumed = await resumeGenerationTask(context, created.id);
    expect(resumed.status).toBe("archiving");
    const restarted = createGenerationWorker(deps);
    try {
        await restarted.tick();
        await expect.poll(async () => (await readGenerationTask(context.id, created.id)).status).toBe("succeeded");
    } finally { await restarted.stop(); }
    expect(submits).toBe(1);
    expect(downloads).toBe(2);
    expect((await readGenerationTask(context.id, created.id)).outputs).toHaveLength(1);
});

test("task API checks membership and viewer writes before provider submission", async ({ request, playwright, baseURL }) => {
    const owner = await contextFor(request);
    const other = await playwright.request.newContext({ baseURL });
    try {
        const account = await registerTestAccount(other);
        const headers = { "x-infinite-canvas-workspace": owner.id };
        const input = payload("image");
        expect((await other.get("/api/generation-tasks", { headers })).status()).toBe(403);
        expect((await other.post("/api/generation-tasks", { headers, data: input })).status()).toBe(403);
        await execute(await getPool(), "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'viewer', now())", owner.id, account.user.id);
        expect((await other.get("/api/generation-tasks", { headers })).status()).toBe(200);
        expect((await other.post("/api/generation-tasks", { headers, data: input })).status()).toBe(403);
        expect((await other.post("/api/generation-tasks/missing/resume", { headers })).status()).toBe(403);
        expect((await other.delete("/api/generation-tasks/missing", { headers })).status()).toBe(403);
        const task = await createGenerationTask(owner, input, options());
        const repeated = await request.post("/api/generation-tasks", { headers, data: input });
        expect(repeated.status()).toBe(202);
        expect((await repeated.json()).task.id).toBe(task.id);
        expect((await request.post("/api/generation-tasks", { headers, data: { ...input, prompt: "Changed prompt" } })).status()).toBe(409);
        const listed = await request.get("/api/generation-tasks", { headers });
        expect(listed.status()).toBe(200);
        expect((await listed.json()).items.some((item: { id: string }) => item.id === task.id)).toBe(true);
        expect((await other.get(`/api/generation-tasks/${task.id}`, { headers })).status()).toBe(200);
        expect((await other.get(`/api/generation-tasks/${task.id}`, { headers: { "x-infinite-canvas-workspace": account.workspaces[0].id } })).status()).toBe(404);
    } finally { await other.dispose(); }
});
