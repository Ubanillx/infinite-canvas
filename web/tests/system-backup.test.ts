import { createServer } from "node:http";
import { expect, test } from "bun:test";

import { extractMediaReferences } from "../src/server/media-references";
import { mediaObjectKey } from "../src/server/object-storage";
import { BACKUP_DOMAIN_KEYS, EMPTY_DOMAIN_PAYLOADS } from "../src/server/system-backup";
import { createMediaCompletionReporter, startRestoreTask } from "../src/server/system-restore";
import { webdavExists, webdavPathSegments, type WebdavConfig } from "../src/server/webdav-client";

test("every backup domain has a canonical empty payload that the media parser accepts", () => {
    expect(Object.keys(EMPTY_DOMAIN_PAYLOADS).sort()).toEqual([...BACKUP_DOMAIN_KEYS].sort());
    for (const domain of BACKUP_DOMAIN_KEYS) {
        expect(extractMediaReferences(domain, EMPTY_DOMAIN_PAYLOADS[domain])).toEqual([]);
    }
});

test("restore module can be loaded with the shared backup types", () => {
    expect(typeof startRestoreTask).toBe("function");
});

test("concurrent media completion reports monotonic completed counts", async () => {
    const counts: number[] = [];
    const reportCompletion = createMediaCompletionReporter((count) => counts.push(count));
    await Promise.all([
        new Promise<void>((resolve) => setTimeout(() => { reportCompletion(); resolve(); }, 30)),
        new Promise<void>((resolve) => setTimeout(() => { reportCompletion(); resolve(); }, 5)),
    ]);
    expect(counts).toEqual([1, 2]);
});

test("WebDAV paths reject traversal and empty segments", () => {
    expect(webdavPathSegments("system-backups/snapshots/id")).toEqual(["system-backups", "snapshots", "id"]);
    for (const value of ["../escape", "a/../../b", "a/%2e%2e/b", "a\\b"]) {
        expect(() => webdavPathSegments(value)).toThrow();
    }
});

test("WebDAV existence checks distinguish a missing file from a failed probe", async () => {
    let status = 404;
    const server = createServer((_req, res) => { res.writeHead(status).end(); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Fake WebDAV did not bind");
        const config: WebdavConfig = { target: new URL(`http://127.0.0.1:${address.port}/`), directory: "", authorization: "Basic dXNlcjpwYXNz" };
        expect(await webdavExists(config, "system-backups/snapshots/backup/manifest.json")).toBe(false);
        status = 207;
        expect(await webdavExists(config, "system-backups/snapshots/backup/manifest.json")).toBe(true);
        status = 503;
        await expect(webdavExists(config, "system-backups/snapshots/backup/manifest.json")).rejects.toThrow("HTTP 503");
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

test("media object keys are versioned without changing the legacy fallback", () => {
    const legacy = mediaObjectKey("workspace", "image:asset");
    const first = mediaObjectKey("workspace", "image:asset", "version-1");
    const second = mediaObjectKey("workspace", "image:asset", "version-2");
    expect(first).not.toBe(legacy);
    expect(first).not.toBe(second);
    expect(first).toContain("-version-1");
    expect(second).toContain("-version-2");
    expect(mediaObjectKey("workspace", "image:asset", "")).toBe(legacy);
});
