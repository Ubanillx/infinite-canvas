import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
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
    const putFailures = new Map<string, number>();
    const deletes: string[] = [];
    const stalled: string[] = [];
    const control: { stall?: (method: string, path: string) => boolean; partialBody?: boolean } = {};
    const server = createServer(async (req, res) => {
        const path = decodeURIComponent(new URL(req.url || "/", "http://localhost").pathname).replace(/\/$/, "") || "/";
        if (control.stall?.(req.method || "", path)) {
            req.resume(); stalled.push(path);
            if (control.partialBody) { res.writeHead(200, { "content-length": 100 }); res.write("partial"); }
            return;
        }
        if (req.method === "MKCOL") { directories.add(path); res.writeHead(201).end(); return; }
        if (req.method === "PUT") {
            const failure = putFailures.get(path);
            if (failure) { putFailures.delete(path); req.resume(); res.writeHead(failure).end(); return; }
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
    return { server, files, directories, propfindFailures, putFailures, deletes, control, stalled };
}

test("backup and restore tasks, historical reference bytes, and post-snapshot idempotency", async ({ request }) => {
    const { server, files, directories, propfindFailures, putFailures, deletes, control, stalled } = fakeWebdav();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Fake WebDAV did not bind");
        const configDir = test.info().outputPath("backup-config");
        await mkdir(configDir, { recursive: true });
        process.env.INFINITE_CANVAS_DATA_DIR = configDir;
        await writeFile(`${configDir}/config.json`, JSON.stringify({ webdav: { url: `http://127.0.0.1:${address.port}/`, username: "fixture", password: "fixture", directory: "dav" } }));
        const { readServerWebdavConfig } = await import("../src/server/webdav-client");
        expect(readServerWebdavConfig().target.origin).toBe(`http://127.0.0.1:${address.port}`);
        expect(readServerWebdavConfig().directory).toBe("dav");
        const { cancelBackupTask, getActiveBackupTask, getBackupStatus, startBackupTask, listBackupRuns, listBackupSnapshots, saveBackupSettings } = await import("../src/server/system-backup");
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

        // Exercise each stalled network phase with real task state and isolated storage.
        for (const stage of ["directory", "upload", "download-headers", "download-body", "prune"]) {
            const protectedFiles = new Map([...files].filter(([path]) => path.startsWith("/dav/system-backups/snapshots/")));
            const deletesBefore = deletes.length;
            const stalledBefore = stalled.length;
            control.partialBody = stage === "download-body";
            control.stall = (verb, path) => stage === "directory" ? verb === "MKCOL"
                : stage === "upload" ? verb === "PUT" && path.endsWith("generation-tasks.json")
                : stage.startsWith("download") ? verb === "GET" && path === archivedObjectPath
                : verb === "PROPFIND" && path === `/dav/system-backups/snapshots/${backupId}/manifest.json`;
            const cancelledRun = await startBackupTask(context.userId);
            try {
                await expect.poll(() => stalled.length).toBeGreaterThan(stalledBefore);
                expect(cancelBackupTask()).toBe(true);
                expect(getActiveBackupTask()?.progress.message).toBe("正在取消任务");
                await expect.poll(async () => (await listBackupRuns()).find((run) => run.id === cancelledRun)?.status).toBe("cancelled");
                expect((await getBackupStatus()).active).toBeNull();
                expect(deletes.slice(deletesBefore)).toEqual([]);
                for (const [path, bytes] of protectedFiles) expect(files.get(path)).toEqual(bytes);
            } finally { control.stall = undefined; }
        }

        const snapshotsBeforePartial = new Map([...files].filter(([path]) => path.startsWith("/dav/system-backups/snapshots/")));
        files.set(archivedObjectPath, Buffer.alloc(currentReference.bytes, 0x58));
        putFailures.set(archivedObjectPath, 503);
        const deletesBeforePartial = deletes.length;
        const partialRun = await startBackupTask(context.userId);
        await expect.poll(async () => (await listBackupRuns()).find((run) => run.id === partialRun)?.status).toBe("partial");
        expect(deletes.slice(deletesBeforePartial)).toEqual([]);
        for (const [path, bytes] of snapshotsBeforePartial) expect(files.get(path)).toEqual(bytes);

        // A missing directory before an uncertain probe must not trigger early deletion.
        const orphan = "/dav/system-backups/snapshots/20990101T000000Z-aaaaaaaa";
        directories.add(orphan);
        const deletesBeforeUncertainProbe = deletes.length;
        propfindFailures.set(`/dav/system-backups/snapshots/${backupId}/manifest.json`, 503);
        const uncertainRun = await startBackupTask(context.userId);
        await expect.poll(async () => (await listBackupRuns()).find((run) => run.id === uncertainRun)?.status).toBe("succeeded");
        expect(deletes.slice(deletesBeforeUncertainProbe)).toEqual([]);
        directories.delete(orphan);
        // An HTTP success with an unreadable manifest is not proof of a usable snapshot.
        const oldManifestPath = `/dav/system-backups/snapshots/${backupId}/manifest.json`;
        const oldManifest = files.get(oldManifestPath)!;
        const deletesBeforeInvalidManifest = deletes.length;
        files.set(oldManifestPath, Buffer.from("invalid manifest"));
        try {
            const invalidManifestRun = await startBackupTask(context.userId);
            await expect.poll(async () => (await listBackupRuns()).find((run) => run.id === invalidManifestRun)?.status).toBe("succeeded");
            expect(deletes.slice(deletesBeforeInvalidManifest)).toEqual([]);
        } finally { files.set(oldManifestPath, oldManifest); }
        const newer = await createGenerationTask(context, { ...payload, requestId: randomUUID(), references: [] }, deps);
        const output = await queryOne<{ object_version: string }>(await getPool(), "SELECT object_version FROM media_files WHERE workspace_id = $1 AND storage_key = $2", context.id, outputKey);
        await execute(await getPool(), "DELETE FROM generation_tasks WHERE id = ANY($1::text[])", [saved.id, inFlight.id, video.id]);
        await execute(await getPool(), "DELETE FROM media_files WHERE workspace_id = $1 AND storage_key = $2", context.id, outputKey);
        await deleteMediaObject(mediaObjectKey(context.id, outputKey, output!.object_version));
        // Cancellation while waiting for the transaction lock must not commit restored data.
        const cancelledPool = new Pool({ connectionString: process.env.DATABASE_URL });
        const cancelledClient = await cancelledPool.connect();
        try {
            await cancelledClient.query("BEGIN");
            await cancelledClient.query("SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", [context.id]);
            const cancelledRestore = await startRestoreTask(context.userId, backupId, context.id, "snapshots");
            await expect.poll(async () => (await getBackupStatus()).active?.progress.phase).toBe("restore-data");
            expect(cancelBackupTask()).toBe(true);
            await cancelledClient.query("ROLLBACK");
            await expect.poll(async () => (await listBackupRuns()).find((run) => run.id === cancelledRestore)?.status).toBe("cancelled");
            expect(await queryOne(await getPool(), "SELECT id FROM generation_tasks WHERE id = $1", saved.id)).toBeNull();
            expect(await queryOne(await getPool(), "SELECT storage_key FROM media_files WHERE workspace_id = $1 AND storage_key = $2", context.id, outputKey)).toBeNull();
        } finally {
            await cancelledClient.query("ROLLBACK").catch(() => undefined);
            cancelledClient.release();
            await cancelledPool.end();
        }
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
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

test("backup cancellation stays visible until the server reports completion", async ({ page, request }) => {
    const { user, workspaces } = await (await request.get("/api/auth/me")).json();
    await execute(await getPool(), "UPDATE users SET is_admin = TRUE WHERE id = $1", user.id);
    await page.addInitScript((workspace) => {
        sessionStorage.setItem("infinite-canvas:active-workspace", JSON.stringify(workspace));
    }, workspaces[0]);
    let cancelling = false;
    let finished = false;
    const startedAt = new Date().toISOString();
    await page.route("**/api/admin/backup/status", (route) => route.fulfill({ json: {
        configured: true,
        settings: { enabled: false, intervalMinutes: 1440, retention: 30, safetyRetention: 5 },
        active: finished ? null : { runId: "ui-fixture", kind: "backup", startedAt, progress: { phase: "backup", current: 0, total: 2, uploadedFiles: 0, uploadedBytes: 0, workspaceName: "隔离测试工作区", message: cancelling ? "正在取消任务" : "传输媒体 1/68" } },
        lastRun: finished ? { id: "ui-fixture", kind: "backup", purpose: "manual", status: "cancelled", startedAt, finishedAt: startedAt, summary: null, error: "任务已取消" } : null,
    } }));
    await page.route("**/api/admin/backup/runs", (route) => route.fulfill({ json: { items: [] } }));
    await page.route("**/api/admin/backup/cancel", (route) => { cancelling = true; return route.fulfill({ json: { cancelled: true } }); });
    await page.goto("/config/webdav");
    await expect(page.getByText("传输媒体 1/68", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "取消任务", exact: true }).click();
    await expect(page.getByText("正在取消任务", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /正在取消$/ })).toHaveClass(/ant-btn-loading/);
    await page.screenshot({ path: test.info().outputPath("backup-cancelling.png"), fullPage: true });
    finished = true;
    await expect(page.getByText("上次备份：已取消", { exact: true })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("button", { name: "立即备份", exact: true })).toBeEnabled();
    await page.screenshot({ path: test.info().outputPath("backup-cancelled.png"), fullPage: true });
});

test("an early successful WebDAV response cannot hide an incomplete upload source", async () => {
    const { putWebdavStream } = await import("../src/server/webdav-client");
    let received!: () => void;
    const waiting = new Promise<void>((resolve) => { received = resolve; });
    const source = new Readable({ read() {} });
    const server = createServer((req, res) => {
        req.resume();
        res.writeHead(201).end();
        if (req.method === "PUT") received();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Fake WebDAV did not bind");
        let completed = false;
        const pending = putWebdavStream({ target: new URL(`http://127.0.0.1:${address.port}`), directory: "", authorization: "Basic fixture" }, "object", source, "application/octet-stream", 100)
            .then(() => { completed = true; return "succeeded"; }, () => "failed");
        source.push("partial");
        await waiting;
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(completed).toBe(false);
        source.destroy(new Error("incomplete source"));
        expect(await pending).toBe("failed");
    } finally {
        source.destroy();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
