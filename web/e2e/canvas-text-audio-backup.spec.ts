import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { test, expect } from "./auth";
import { execute, getPool } from "../src/server/db";
import { createGenerationTask, readGenerationTask, resumeGenerationTask } from "../src/server/generation-tasks";
import { projectCanvasTask } from "../src/lib/canvas/canvas-generation-tasks";
import type { CanvasGenerationTaskBinding, CanvasNodeData } from "../src/types/canvas";

test.skip(({ isMobile }) => isMobile, "Isolated backup fixture runs once in the desktop project");
test.beforeAll(() => {
    if (!/^\/infinite_canvas_e2e_[a-z0-9_]+$/.test(new URL(process.env.DATABASE_URL || "postgres://invalid/unsafe").pathname)
        || !process.env.S3_BUCKET?.startsWith("infinite-canvas-e2e-") || process.env.INFINITE_CANVAS_GENERATION_WORKER !== "off") {
        throw new Error("P5 backup requires isolated E2E storage and disabled app worker");
    }
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

test("backup restores partial text slots and archived audio without replaying requests", async ({ request }) => {
    const { server, files } = fakeWebdav();
    const previousDataDir = process.env.INFINITE_CANVAS_DATA_DIR;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Fake WebDAV did not bind");
        const configDir = test.info().outputPath("text-audio-backup-config");
        await mkdir(configDir, { recursive: true });
        process.env.INFINITE_CANVAS_DATA_DIR = configDir;
        await writeFile(`${configDir}/config.json`, JSON.stringify({ webdav: { url: `http://127.0.0.1:${address.port}/`, username: "fixture", password: "fixture", directory: "dav" } }));
        const { startBackupTask, listBackupRuns } = await import("../src/server/system-backup");
        const { startRestoreTask } = await import("../src/server/system-restore");
        const { workspaces, user } = await (await request.get("/api/auth/me")).json();
        const context = { id: workspaces[0].id as string, userId: user.id as string, role: "owner" as const };
        const headers = { "x-infinite-canvas-workspace": context.id };
        const projectId = "p5-backup-canvas";
        const textRequest = randomUUID(); const audioRequest = randomUUID();
        const textBinding: CanvasGenerationTaskBinding = { workspaceId: context.id, projectId, nodeId: "text", requestId: textRequest, kind: "text", slotIds: ["complete-slot", "partial-slot", "queued-slot"], status: "queued" };
        const audioBinding: CanvasGenerationTaskBinding = { workspaceId: context.id, projectId, nodeId: "audio", requestId: audioRequest, kind: "audio", slotIds: [], status: "queued" };
        const nodes = [
            { id: "text", type: "text", title: "Text", position: { x: 0, y: 0 }, width: 280, height: 180, metadata: { generationTask: textBinding, primaryTextId: "partial-slot", texts: textBinding.slotIds.map((id) => ({ id, content: "", status: "loading" })) } },
            { id: "audio", type: "audio", title: "Audio", position: { x: 300, y: 0 }, width: 280, height: 180, metadata: { generationTask: audioBinding } },
        ] as CanvasNodeData[];
        const now = new Date().toISOString();
        const canvasPayload = { version: 0, state: { projects: [{ id: projectId, title: "P5 backup", folderId: null, createdAt: now, updatedAt: now, nodes, connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } }], folders: [], deletedProjects: [] } };
        const before = await (await request.get("/api/data/canvas", { headers })).json();
        expect((await request.put("/api/data/canvas", { headers, data: { revision: before.revision, payload: canvasPayload } })).ok()).toBe(true);
        let resolutions = 0;
        const deps = { resolveChannel: async (model: string) => { resolutions++; return { id: "p5-backup", baseUrl: "https://fixture.invalid/v1", apiKey: "NEVER-IN-P5-BACKUP", apiFormat: "openai" as const, model }; } };
        const textInput = { requestId: textRequest, kind: "text" as const, canvasTarget: { projectId, nodeId: "text" }, prompt: "Partial text", model: "text-model", settings: { count: 3 }, references: [] };
        const audioInput = { requestId: audioRequest, kind: "audio" as const, canvasTarget: { projectId, nodeId: "audio" }, prompt: "Speak", model: "audio-model", settings: { format: "wav" }, references: [] };
        const text = await createGenerationTask(context, textInput, deps);
        const audio = await createGenerationTask(context, audioInput, deps);
        const wav = Buffer.alloc(44 + 4000);
        wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
        wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
        wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
        wav.write("data", 36); wav.writeUInt32LE(4000, 40);
        await execute(await getPool(), "UPDATE generation_tasks SET status = 'submitting', submissions = $2::jsonb, revision = revision + 1 WHERE id = $1", text.id,
            JSON.stringify([{ status: "completed", content: "Finished candidate" }, { status: "submitting", content: "Partial checkpoint" }, { status: "queued" }]));
        await execute(await getPool(), "UPDATE generation_tasks SET status = 'archiving', raw_result = $2::jsonb, revision = revision + 1 WHERE id = $1", audio.id,
            JSON.stringify([{ kind: "inline", dataUrl: `data:audio/wav;base64,${wav.toString("base64")}` }]));
        const backupRun = await startBackupTask(context.userId);
        await expect.poll(async () => {
            const run = (await listBackupRuns()).find((item) => item.id === backupRun);
            if (run?.status === "failed") throw new Error(run.error || "Backup failed");
            return run?.status;
        }).toBe("succeeded");
        const backupId = (await listBackupRuns()).find((run) => run.id === backupRun)!.backupId!;
        const snapshot = `/dav/system-backups/snapshots/${backupId}/workspaces/${context.id}`;
        const taskFile = files.get(`${snapshot}/generation-tasks.json`)!.toString();
        expect(taskFile).not.toMatch(/NEVER-IN-P5-BACKUP|base64|data:audio|apiKey/);
        const tasks = JSON.parse(taskFile);
        expect(tasks.find((item: { id: string }) => item.id === text.id)).toMatchObject({ status: "needs_attention", submissions: [{ status: "completed", content: "Finished candidate" }, { status: "uncertain", content: "Partial checkpoint" }, { status: "queued" }] });
        const audioExport = tasks.find((item: { id: string }) => item.id === audio.id);
        expect(audioExport).toMatchObject({ status: "succeeded", outputs: [{ mimeType: "audio/wav", bytes: wav.length }] });
        const outputKey = audioExport.outputs[0].storageKey;
        const media = JSON.parse(files.get(`${snapshot}/media.json`)!.toString());
        const savedAudio = media.find((item: { storageKey: string }) => item.storageKey === outputKey);
        expect(files.get(`/dav/system-backups/${savedAudio.objectPath}`)).toEqual(wav);
        await execute(await getPool(), "DELETE FROM generation_tasks WHERE id = ANY($1::text[])", [text.id, audio.id]);
        const current = await (await request.get("/api/data/canvas", { headers })).json();
        expect((await request.put("/api/data/canvas", { headers, data: { revision: current.revision, payload: { version: 0, state: { projects: [], folders: [], deletedProjects: [] } } } })).ok()).toBe(true);
        const restoreRun = await startRestoreTask(context.userId, backupId, context.id, "snapshots");
        await expect.poll(async () => {
            const run = (await listBackupRuns()).find((item) => item.id === restoreRun);
            if (run?.status === "failed") throw new Error(run.error || "Restore failed");
            return run?.status;
        }).toBe("succeeded");
        const restoredText = await readGenerationTask(context.id, text.id);
        expect(restoredText).toMatchObject({ status: "needs_attention", errorCode: "submission_uncertain", textOutputs: [
            { slotIndex: 0, status: "succeeded", content: "Finished candidate" },
            { slotIndex: 1, status: "needs_attention", content: "Partial checkpoint" },
            { slotIndex: 2, status: "needs_attention", content: "" },
        ] });
        const restoredAudio = await readGenerationTask(context.id, audio.id);
        expect(restoredAudio).toMatchObject({ status: "succeeded", outputs: [{ storageKey: outputKey, mimeType: "audio/wav", bytes: wav.length }] });
        expect(await (await request.get(`/api/media/blob/${encodeURIComponent(outputKey)}`, { headers })).body()).toEqual(wav);
        const restoredNodes: CanvasNodeData[] = (await (await request.get("/api/data/canvas", { headers })).json()).payload.state.projects[0].nodes;
        const restoredNode = restoredNodes.find((item) => item.id === "text")!;
        expect(restoredNode.metadata!.generationTask).toEqual(textBinding);
        expect(restoredNodes.find((item) => item.id === "audio")!.metadata!.generationTask).toEqual(audioBinding);
        const projected = projectCanvasTask(restoredNode, restoredNode.metadata!.generationTask!, restoredText);
        expect(projected.metadata!.texts!.map(({ id, content }) => ({ id, content }))).toEqual([
            { id: "complete-slot", content: "Finished candidate" }, { id: "partial-slot", content: "Partial checkpoint" }, { id: "queued-slot", content: "" },
        ]);
        expect(projected.metadata!.primaryTextId).toBe("partial-slot");
        expect((await createGenerationTask(context, textInput, deps)).id).toBe(text.id);
        expect((await createGenerationTask(context, audioInput, deps)).id).toBe(audio.id);
        expect(resolutions).toBe(2);
        await expect(resumeGenerationTask(context, text.id)).rejects.toMatchObject({ status: 409 });
    } finally {
        if (previousDataDir === undefined) delete process.env.INFINITE_CANVAS_DATA_DIR;
        else process.env.INFINITE_CANVAS_DATA_DIR = previousDataDir;
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
