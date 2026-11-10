import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { test, expect } from "./auth";
import { execute, getPool, queryOne } from "../src/server/db";
import { createGenerationTask, hideGenerationTask, readGenerationTask, resumeGenerationTask } from "../src/server/generation-tasks";
import { projectCanvasTask } from "../src/lib/canvas/canvas-generation-tasks";
import { CanvasNodeType, type CanvasGenerationTaskBinding, type CanvasNodeData } from "../src/types/canvas";

test.skip(({ isMobile }) => isMobile, "Canvas backup fixture runs once in the desktop project");
test.beforeAll(() => {
    if (!/^\/infinite_canvas_e2e_[a-z0-9_]+$/.test(new URL(process.env.DATABASE_URL || "postgres://invalid/unsafe").pathname)
        || !process.env.S3_BUCKET?.startsWith("infinite-canvas-e2e-")
        || process.env.INFINITE_CANVAS_GENERATION_WORKER !== "off") throw new Error("Canvas backup requires isolated E2E storage and disabled app worker");
});

function fakeWebdav() {
    const files = new Map<string, Buffer>();
    const directories = new Set(["/"]);
    const server = createServer(async (request, response) => {
        const path = decodeURIComponent(new URL(request.url || "/", "http://localhost").pathname).replace(/\/$/, "") || "/";
        if (request.method === "MKCOL") { directories.add(path); response.writeHead(201).end(); return; }
        if (request.method === "PUT") {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            files.set(path, Buffer.concat(chunks)); response.writeHead(201).end(); return;
        }
        if (request.method === "DELETE") {
            for (const key of files.keys()) if (key === path || key.startsWith(`${path}/`)) files.delete(key);
            for (const key of directories) if (key === path || key.startsWith(`${path}/`)) directories.delete(key);
            response.writeHead(204).end(); return;
        }
        if (request.method === "PROPFIND") {
            if (!directories.has(path) && !files.has(path)) { response.writeHead(404).end(); return; }
            const children = [...directories, ...files.keys()].filter((key) => key === path || request.headers.depth === "1" && key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes("/"));
            response.writeHead(207, { "content-type": "application/xml" });
            response.end(`<d:multistatus xmlns:d="DAV:">${children.map((key) => `<d:response><d:href>${key}</d:href><d:propstat><d:prop><d:getcontentlength>${files.get(key)?.length || 0}</d:getcontentlength></d:prop></d:propstat></d:response>`).join("")}</d:multistatus>`);
            return;
        }
        const file = files.get(path);
        if (!file) { response.writeHead(404).end(); return; }
        response.writeHead(200, { "content-length": file.length, "content-type": "application/octet-stream" });
        response.end(request.method === "HEAD" ? undefined : file);
    });
    return { server, files };
}

test("canvas backup restores a hidden paid image into its original sparse slot without resubmission", async ({ request }) => {
    const { server, files } = fakeWebdav();
    const previousDataDir = process.env.INFINITE_CANVAS_DATA_DIR;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Fake WebDAV did not bind");
        const configDir = test.info().outputPath("canvas-backup-config");
        await mkdir(configDir, { recursive: true });
        process.env.INFINITE_CANVAS_DATA_DIR = configDir;
        await writeFile(`${configDir}/config.json`, JSON.stringify({ webdav: { url: `http://127.0.0.1:${address.port}/`, username: "fixture", password: "fixture", directory: "dav" } }));
        const { startBackupTask, listBackupRuns } = await import("../src/server/system-backup");
        const { startRestoreTask } = await import("../src/server/system-restore");
        const { workspaces, user } = await (await request.get("/api/auth/me")).json();
        const context = { id: workspaces[0].id as string, userId: user.id as string, role: "owner" as const };
        const headers = { "x-infinite-canvas-workspace": context.id };
        const canvasTarget = { projectId: "canvas-backup", nodeId: "batch-node" };
        const requestId = randomUUID();
        const binding: CanvasGenerationTaskBinding = { ...canvasTarget, workspaceId: context.id, requestId, kind: "image", slotIds: ["uncertain-slot", "paid-slot"], status: "queued" };
        const originalNode: CanvasNodeData = {
            id: canvasTarget.nodeId, type: CanvasNodeType.Image, title: "Paid batch", position: { x: 100, y: 100 }, width: 240, height: 180,
            metadata: { generationTask: binding, status: "loading", prompt: "Preserve this request", images: binding.slotIds.map((id) => ({ id, status: "loading", content: "", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "" })) },
        };
        const now = new Date().toISOString();
        const canvasPayload = { version: 0, state: { projects: [{ id: canvasTarget.projectId, title: "Canvas backup", folderId: null, createdAt: now, updatedAt: now, nodes: [originalNode], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } }], folders: [], deletedProjects: [] } };
        const beforeCanvas = await (await request.get("/api/data/canvas", { headers })).json();
        expect((await request.put("/api/data/canvas", { headers, data: { revision: beforeCanvas.revision, payload: canvasPayload } })).ok()).toBe(true);
        let channelResolutions = 0;
        const deps = { resolveChannel: async () => { channelResolutions++; return { id: "backup-fixture", baseUrl: "https://fixture.invalid/v1", apiKey: "NEVER-IN-CANVAS-BACKUP", apiFormat: "openai" as const, model: "image-model" }; } };
        const input = { requestId, kind: "image" as const, canvasTarget, prompt: "Preserve this request", model: "backup-fixture::image-model", settings: { count: 2 }, references: [] };
        const created = await createGenerationTask(context, input, deps);
        const paidBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
        const inline = `data:image/png;base64,${paidBytes.toString("base64")}`;
        // Model a provider response received for slot 1 before archival; slot 0 is uncertain and must never be replayed.
        await execute(await getPool(), "UPDATE generation_tasks SET status = 'needs_attention', error_code = 'submission_uncertain', submissions = $2::jsonb, revision = revision + 1 WHERE id = $1", created.id,
            JSON.stringify([{ status: "uncertain" }, { status: "completed", outputs: [{ kind: "inline", dataUrl: inline }] }]));
        await hideGenerationTask(context, created.id);
        expect((await readGenerationTask(context.id, created.id)).outputs).toEqual([]);

        const backupRun = await startBackupTask(context.userId);
        await expect.poll(async () => (await listBackupRuns()).find((run) => run.id === backupRun)?.status).toBe("succeeded");
        const backupId = (await listBackupRuns()).find((run) => run.id === backupRun)!.backupId!;
        const snapshotPath = `/dav/system-backups/snapshots/${backupId}`;
        const exported = JSON.parse(files.get(`${snapshotPath}/workspaces/${context.id}/generation-tasks.json`)!.toString());
        expect(exported).toHaveLength(1);
        expect(exported[0]).toMatchObject({ id: created.id, request_id: requestId, hidden: true, request_snapshot: { canvasTarget }, outputs: [{ slotIndex: 1 }] });
        expect(JSON.stringify(exported)).not.toMatch(/NEVER-IN-CANVAS-BACKUP|base64|data:image|apiKey/);
        const outputKey = exported[0].outputs[0].storageKey;
        const media = JSON.parse(files.get(`${snapshotPath}/workspaces/${context.id}/media.json`)!.toString());
        const savedOutput = media.find((item: { storageKey: string }) => item.storageKey === outputKey);
        expect(savedOutput).toBeTruthy();
        expect(files.get(`/dav/system-backups/${savedOutput.objectPath}`)).toEqual(paidBytes);
        // Backup archived the paid response directly into WebDAV, not the source task or media index.
        expect(await queryOne(await getPool(), "SELECT storage_key FROM media_files WHERE workspace_id = $1 AND storage_key = $2", context.id, outputKey)).toBeNull();

        await execute(await getPool(), "DELETE FROM generation_tasks WHERE workspace_id = $1 AND id = $2", context.id, created.id);
        const currentCanvas = await (await request.get("/api/data/canvas", { headers })).json();
        expect((await request.put("/api/data/canvas", { headers, data: { revision: currentCanvas.revision, payload: { version: 0, state: { projects: [], folders: [], deletedProjects: [] } } } })).ok()).toBe(true);
        const restoreRun = await startRestoreTask(context.userId, backupId, context.id, "snapshots");
        await expect.poll(async () => {
            const run = (await listBackupRuns()).find((item) => item.id === restoreRun);
            if (run?.status === "failed") throw new Error(run.error || "Canvas restore failed");
            return run?.status;
        }).toBe("succeeded");

        const restored = await readGenerationTask(context.id, created.id);
        expect(restored).toMatchObject({ id: created.id, requestId, canvasTarget, status: "needs_attention", errorCode: "submission_uncertain", outputs: [{ slotIndex: 1, storageKey: outputKey }] });
        expect(restored.outputs).toHaveLength(1);
        const restoredCanvas = (await (await request.get("/api/data/canvas", { headers })).json()).payload;
        const restoredNode: CanvasNodeData = restoredCanvas.state.projects[0].nodes[0];
        expect(restoredNode.metadata!.generationTask).toEqual(binding);
        const projected = projectCanvasTask(restoredNode, restoredNode.metadata!.generationTask!, restored);
        expect(projected.metadata!.images!.map(({ id, status, storageKey }) => ({ id, status, storageKey }))).toEqual([
            { id: "uncertain-slot", status: "error", storageKey: undefined },
            { id: "paid-slot", status: "success", storageKey: outputKey },
        ]);
        expect(projected.metadata!.primaryImageId).toBe("paid-slot");
        expect(projected.metadata!.generationTask).toMatchObject({ requestId, taskId: created.id, ...canvasTarget });
        const blob = await request.get(`/api/media/blob/${encodeURIComponent(outputKey)}`, { headers });
        expect(blob.status()).toBe(200);
        expect(await blob.body()).toEqual(paidBytes);
        const normalList = await request.get(`/api/generation-tasks?source=canvas&projectId=${canvasTarget.projectId}`, { headers });
        expect((await normalList.json()).items).toEqual([]);
        const receiptList = await request.get(`/api/generation-tasks?source=canvas&projectId=${canvasTarget.projectId}&requestId=${requestId}`, { headers });
        expect((await receiptList.json()).items.map((item: { id: string }) => item.id)).toEqual([created.id]);
        expect((await createGenerationTask(context, input, deps)).id).toBe(created.id);
        const repeated = await request.post("/api/generation-tasks", { headers, data: input });
        expect(repeated.status()).toBe(202);
        expect((await repeated.json()).task.id).toBe(created.id);
        expect(channelResolutions).toBe(1);
        await expect(resumeGenerationTask(context, created.id)).rejects.toMatchObject({ status: 409 });
        expect((await readGenerationTask(context.id, created.id)).outputs).toEqual(restored.outputs);
    } finally {
        if (previousDataDir === undefined) delete process.env.INFINITE_CANVAS_DATA_DIR;
        else process.env.INFINITE_CANVAS_DATA_DIR = previousDataDir;
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
