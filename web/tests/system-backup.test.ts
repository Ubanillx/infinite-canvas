import { expect, test } from "bun:test";

import { extractMediaReferences } from "../src/server/media-references";
import { mediaObjectKey } from "../src/server/object-storage";
import { BACKUP_DOMAIN_KEYS, EMPTY_DOMAIN_PAYLOADS } from "../src/server/system-backup";
import { startRestoreTask } from "../src/server/system-restore";
import { webdavPathSegments } from "../src/server/webdav-client";

test("every backup domain has a canonical empty payload that the media parser accepts", () => {
    expect(Object.keys(EMPTY_DOMAIN_PAYLOADS).sort()).toEqual([...BACKUP_DOMAIN_KEYS].sort());
    for (const domain of BACKUP_DOMAIN_KEYS) {
        expect(extractMediaReferences(domain, EMPTY_DOMAIN_PAYLOADS[domain])).toEqual([]);
    }
});

test("restore module can be loaded with the shared backup types", () => {
    expect(typeof startRestoreTask).toBe("function");
});

test("WebDAV paths reject traversal and empty segments", () => {
    expect(webdavPathSegments("system-backups/snapshots/id")).toEqual(["system-backups", "snapshots", "id"]);
    for (const value of ["../escape", "a/../../b", "a/%2e%2e/b", "a\\b"]) {
        expect(() => webdavPathSegments(value)).toThrow();
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
