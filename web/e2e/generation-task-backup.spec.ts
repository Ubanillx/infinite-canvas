import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { test, expect } from "./auth";
import { execute, getPool, queryOne } from "../src/server/db";
import { createGenerationTask, readGenerationTask } from "../src/server/generation-tasks";
import { deleteMediaObject, getMediaObject, mediaObjectKey } from "../src/server/object-storage";

test.skip(({ isMobile }) => isMobile, "Isolated backup transaction runs once in the desktop project");
test.beforeAll(() => {
    if (!/^\/infinite_canvas_e2e_[a-z0-9_]+$/.test(new URL(process.env.DATABASE_URL || "postgres://invalid/unsafe").pathname)
        || !process.env.S3_BUCKET?.startsWith("infinite-canvas-e2e-") || process.env.INFINITE_CANVAS_GENERATION_WORKER !== "off") {
        throw new Error("Backup E2E requires an isolated database/bucket and disabled app worker");
    }
});

function fakeWebdav() {
    const files = new Map<string, Buffer>();
    const directories = new Set<string>(["/"]);
    const propfindFailures = new Map<string, number>();
    const deletes: string[] = [];
    const server = createServer(async (req, res) => {
        const path = decodeURIComponent(new URL(req.url || "/", "http://localhost").pathname).replace(/\/$/, "") || "/";
        if (req.method === "MKCOL") { directories.add(path); res.writeHead(201).end(); return; }
        if (req.method === "PUT") {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(Buffer.from(chunk));
            files.set(path, Buffer.concat(chunks)); res.writeHead(201).end(); return;
        }
        if (req.method === "DELETE") {
            deletes.push(path);
            for (const key of files.keys()) if (key === path || key.startsWith(`${path}/`)) files.delete(key);
            for (const key of directories) if (key === path || key.startsWith(`${path}/`)) directories.delete(key);
            res.writeHead(204).end(); return;
        }
        if (req.method === "PROPFIND") {
            const failure = propfindFailures.get(path);
            if (failure) { propfindFailures.delete(path); res.writeHead(failure).end(); return; }
            if (!directories.has(path) && !files.has(path)) { res.writeHead(404).end(); return; }
            const children = [...directories, ...files.keys()].filter((key) => key === path || req.headers.depth === "1" && key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes("/"));
            res.writeHead(207, { "content-type": "application/xml" });
            res.end(`<d:multistatus xmlns:d="DAV:">${children.map((key) => `<d:response><d:href>${key}</d:href><d:propstat><d:prop><d:getcontentlength>${files.get(key)?.length || 0}</d:getcontentlength></d:prop></d:propstat></d:response>`).join("")}</d:multistatus>`);
            return;
        }
        const file = files.get(path);
        if (!file) { res.writeHead(404).end(); return; }
        res.writeHead(200, { "content-length": file.length, "content-type": "application/octet-stream" });
        res.end(req.method === "HEAD" ? undefined : file);
    });
    return { server, files, propfindFailures, deletes };
}

test("backup and restore tasks, historical reference bytes, and post-snapshot idempotency", async ({ request }) => {
    const { server, files, propfindFailures, deletes } = fakeWebdav();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Fake WebDAV did not bind");
        const configDir = test.info().outputPath("backup-config");
        await mkdir(configDir, { recursive: true });
        process.env.INFINITE_CANVAS_DATA_DIR = configDir;
        await writeFile(`${configDir}/config.json`, JSON.stringify({ webdav: { url: `http://127.0.0.1:${address.port}/`, username: "fixture", password: "fixture", directory: "dav" } }));
        const { getBackupStatus, startBackupTask, listBackupRuns, listBackupSnapshots, saveBackupSettings } = await import("../src/server/system-backup");
        const { startRestoreTask } = await import("../src/server/system-restore");
        const { workspaces, user } = await (await request.get("/api/auth/me")).json();
        const context = { id: workspaces[0].id as string, userId: user.id as string, role: "owner" as const };
        const headers = { "x-infinite-canvas-workspace": context.id, "content-type": "image/png" };
        const inputKey = `image:${randomUUID().replace(/-/g, "")}`;
        const outputKey = `image:${randomUUID().replace(/-/g, "")}`;
        const original = Buffer.from("original historical reference");
        const generated = Buffer.from("saved generated result");
        expect((await request.put(`/api/media/blob/${inputKey}`, { headers, data: original })).ok()).toBe(true);
        const deps = { resolveChannel: async () => ({ id: "fake", baseUrl: "https://provider.test/v1", apiKey: "NEVER-IN-BACKUP", apiFormat: "openai" as const, model: "fake" }) };
        const payload = { requestId: randomUUID(), kind: "image" as const, prompt: "Backup fixture", model: "fake", settings: { count: 1 }, references: [{ kind: "image" as const, storageKey: inputKey }] };
        const canvasTarget = { projectId: "backup-canvas", nodeId: "backup-node" };
        const canvasBefore = await (await request.get("/api/data/canvas", { headers })).json();
        const canvasPut = await request.put("/api/data/canvas", { headers: { ...headers, "content-type": "application/json" }, data: { revision: canvasBefore.revision, payload: { state: { projects: [{ id: canvasTarget.projectId, connections: [], nodes: [{ id: canvasTarget.nodeId, metadata: { generationTask: { requestId: payload.requestId } } }] }] } } } });
        expect(canvasPut.ok(), await canvasPut.text()).toBe(true);
        const saved = await createGenerationTask(context, { ...payload, canvasTarget }, deps);
        const before = await queryOne<{ request_snapshot: { references: Array<{ objectVersion: string }> } }>(await getPool(), "SELECT request_snapshot FROM generation_tasks WHERE id = $1", saved.id);
        const oldVersion = before!.request_snapshot.references[0].objectVersion;
        expect((await request.put(`/api/media/blob/${inputKey}`, { headers, data: Buffer.from("newer reference") })).ok()).toBe(true);
        expect((await request.put(`/api/media/blob/${outputKey}`, { headers, data: generated })).ok()).toBe(true);
        await execute(await getPool(), "UPDATE generation_tasks SET status = 'succeeded', outputs = $2::jsonb, hidden = true, revision = revision + 1 WHERE id = $1", saved.id,
            JSON.stringify([{ id: `${saved.id}-0-0`, slotIndex: 0, storageKey: outputKey, mimeType: "image/png", bytes: generated.length }]));
        const inFlight = await createGenerationTask(context, { ...payload, requestId: randomUUID(), references: [], settings: { count: 2 } }, deps);
        const paid = Buffer.from("known paid image");
        const inline = `data:image/png;base64,${paid.toString("base64")}`;
        await execute(await getPool(), "UPDATE generation_tasks SET status = 'submitting', submissions = $2::jsonb, revision = revision + 1 WHERE id = $1", inFlight.id,
            JSON.stringify([{ status: "submitting" }, { status: "completed", outputs: [{ kind: "inline", dataUrl: inline }] }]));
        const video = await createGenerationTask(context, { ...payload, requestId: randomUUID(), kind: "video", settings: { seconds: "6" }, references: [] }, deps);
        await execute(await getPool(), "UPDATE generation_tasks SET status = 'running', upstream = $2::jsonb, revision = revision + 1 WHERE id = $1", video.id,
            JSON.stringify({ id: "video_opaque_123", provider: "openai", model: "fake", channelId: "fake" }));
        const backupRun = await startBackupTask(context.userId);
        await expect.poll(async () => (await listBackupRuns()).find((run) => run.id === backupRun)?.status).toBe("succeeded");
        const backupId = (await listBackupRuns()).find((run) => run.id === backupRun)!.backupId!;
        const manifest = JSON.parse(files.get(`/dav/system-backups/snapshots/${backupId}/manifest.json`)!.toString());
        expect(manifest.status).toBe("complete");
        expect(JSON.stringify(manifest)).not.toMatch(/NEVER-IN-BACKUP|base64|apiKey|provider\.test/);
        const taskFile = files.get(`/dav/system-backups/snapshots/${backupId}/workspaces/${context.id}/generation-tasks.json`)!.toString();
        expect(taskFile).not.toMatch(/NEVER-IN-BACKUP|base64|data:image|apiKey/);
        expect(JSON.parse(taskFile)).toHaveLength(3);
        propfindFailures.set("/dav/system-backups/snapshots", 503);
        await expect(listBackupSnapshots()).rejects.toThrow();
        expect(propfindFailures.has("/dav/system-backups/snapshots")).toBe(false);
        const savedMedia = JSON.parse(files.get(`/dav/system-backups/snapshots/${backupId}/workspaces/${context.id}/media.json`)!.toString());
        const currentReference = savedMedia.find((item: { storageKey: string; objectVersion: string }) => item.storageKey === inputKey && item.objectVersion !== oldVersion)!;
        const archivedObjectPath = `/dav/system-backups/${currentReference.objectPath}`;
        files.set(archivedObjectPath, Buffer.alloc(currentReference.bytes, 0x58));
        await saveBackupSettings({ enabled: false, intervalMinutes: 1440, retention: 1, safetyRetention: 5 });
        propfindFailures.set(`/dav/system-backups/snapshots/${backupId}/manifest.json`, 503);
        const probeRun = await startBackupTask(context.userId);
        await expect.poll(async () => (await listBackupRuns()).find((run) => run.id === probeRun)?.status).toBe("succeeded");
        expect(files.get(archivedObjectPath)).toEqual(Buffer.from("newer reference"));
        expect(deletes).not.toContain(`/dav/system-backups/snapshots/${backupId}`);
        expect(propfindFailures.has(`/dav/system-backups/snapshots/${backupId}/manifest.json`)).toBe(false);
        const newer = await createGenerationTask(context, { ...payload, requestId: randomUUID(), references: [] }, deps);
        const output = await queryOne<{ object_version: string }>(await getPool(), "SELECT object_version FROM media_files WHERE workspace_id = $1 AND storage_key = $2", context.id, outputKey);
        await execute(await getPool(), "DELETE FROM generation_tasks WHERE id = ANY($1::text[])", [saved.id, inFlight.id, video.id]);
        await execute(await getPool(), "DELETE FROM media_files WHERE workspace_id = $1 AND storage_key = $2", context.id, outputKey);
        await deleteMediaObject(mediaObjectKey(context.id, outputKey, output!.object_version));
        const progressPool = new Pool({ connectionString: process.env.DATABASE_URL });
        const lockClient = await progressPool.connect();
        let lockActive = false;
        let lockClientReleased = false;
        let restoreRun = "";
        try {
            await lockClient.query("BEGIN");
            lockActive = true;
            await lockClient.query("SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", [context.id]);
            restoreRun = await startRestoreTask(context.userId, backupId, context.id, "snapshots");
            await expect.poll(async () => {
                const active = (await getBackupStatus()).active;
                return active?.runId === restoreRun ? active.progress : null;
            }, { timeout: 10000 }).toMatchObject({ phase: "restore-data", current: 0, total: 1 });
            await lockClient.query("ROLLBACK");
            lockActive = false;
            lockClient.release();
            lockClientReleased = true;
            await expect.poll(async () => {
                const run = (await listBackupRuns()).find((item) => item.id === restoreRun);
                if (run?.status === "failed") throw new Error(run.error || "Restore failed without a reason");
                return run?.status;
            }).toBe("succeeded");
        } finally {
            if (lockActive) {
                await lockClient.query("ROLLBACK").catch(() => undefined);
            }
            if (!lockClientReleased) lockClient.release();
            await progressPool.end().catch(() => undefined);
        }
        const restored = await readGenerationTask(context.id, saved.id);
        expect(restored.status).toBe("succeeded");
        expect(restored.outputs[0].storageKey).toBe(outputKey);
        expect(restored.canvasTarget).toEqual(canvasTarget);
        expect(restored.outputs[0].slotIndex).toBe(0);
        expect(await (await request.get(`/api/media/blob/${outputKey}`, { headers })).body()).toEqual(generated);
        const restoredFlight = await readGenerationTask(context.id, inFlight.id);
        expect(restoredFlight.status).toBe("needs_attention");
        expect(restoredFlight.errorCode).toBe("submission_uncertain");
        expect(restoredFlight.outputs).toHaveLength(1);
        expect(restoredFlight.outputs[0].slotIndex).toBe(1);
        expect(await (await request.get(`/api/media/blob/${restoredFlight.outputs[0].storageKey}`, { headers })).body()).toEqual(paid);
        const restoredVideo = await queryOne<{ status: string; upstream: { id: string }; worker_id: string | null }>(await getPool(), "SELECT status, upstream, worker_id FROM generation_tasks WHERE id = $1", video.id);
        expect(restoredVideo).toMatchObject({ status: "running", upstream: { id: "video_opaque_123" }, worker_id: null });
        const ref = await queryOne<{ request_snapshot: { references: Array<{ objectVersion: string }> } }>(await getPool(), "SELECT request_snapshot FROM generation_tasks WHERE id = $1", saved.id);
        expect(ref!.request_snapshot.references[0].objectVersion).not.toBe(oldVersion);
        const historical = await getMediaObject(mediaObjectKey(context.id, inputKey, ref!.request_snapshot.references[0].objectVersion));
        const chunks: Buffer[] = [];
        for await (const chunk of historical.body) chunks.push(Buffer.from(chunk));
        expect(Buffer.concat(chunks)).toEqual(original);
        expect((await createGenerationTask(context, { ...payload, requestId: newer.requestId, references: [] }, deps)).id).toBe(newer.id);
        expect((await readGenerationTask(context.id, newer.id)).status).toBe("needs_attention");

        const initialAssets = await (await request.get("/api/data/assets", { headers })).json();
        expect((await request.put("/api/data/assets", { headers, data: { revision: initialAssets.revision, payload: { version: 0, state: { assets: [{ id: "result-asset", storageKey: outputKey }] } } } })).ok()).toBe(true);
        const conflictBackup = await startBackupTask(context.userId);
        await expect.poll(async () => (await listBackupRuns()).find((run) => run.id === conflictBackup)?.status).toBe("succeeded");
        const conflictSnapshotId = (await listBackupRuns()).find((run) => run.id === conflictBackup)!.backupId!;
        expect(files.get(archivedObjectPath)).toEqual(Buffer.from("newer reference"));
        const currentAssets = await (await request.get("/api/data/assets", { headers })).json();
        expect((await request.put("/api/data/assets", { headers, data: { revision: currentAssets.revision, payload: { version: 0, state: { assets: [] } } } })).ok()).toBe(true);
        const newerBytes = Buffer.from("post-snapshot result bytes");
        expect((await request.put(`/api/media/blob/${outputKey}`, { headers, data: newerBytes })).ok()).toBe(true);
        const protectedTask = await createGenerationTask(context, { ...payload, requestId: randomUUID(), references: [{ kind: "image", storageKey: outputKey }] }, deps);
        const rejectedRun = await startRestoreTask(context.userId, conflictSnapshotId, context.id, "snapshots");
        await expect.poll(async () => (await listBackupRuns()).find((run) => run.id === rejectedRun)?.status).toBe("failed");
        expect((await listBackupRuns()).find((run) => run.id === rejectedRun)?.error).toContain(outputKey);
        expect((await (await request.get("/api/data/assets", { headers })).json()).payload.state.assets).toEqual([]);
        expect(await (await request.get(`/api/media/blob/${outputKey}`, { headers })).body()).toEqual(newerBytes);
        expect((await createGenerationTask(context, { ...payload, requestId: protectedTask.requestId, references: [{ kind: "image", storageKey: outputKey }] }, deps)).id).toBe(protectedTask.id);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
