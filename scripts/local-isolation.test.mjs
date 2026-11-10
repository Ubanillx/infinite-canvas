import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

for (const directory of [undefined, resolve(homedir(), ".infinite-canvas/data")]) {
    test(`standalone E2E server rejects ${directory ? "default" : "missing"} configuration directory before starting services`, () => {
        const env = { ...process.env, DATABASE_URL: "postgres://fixture/fixture", S3_BUCKET: "fixture" };
        if (directory) env.INFINITE_CANVAS_DATA_DIR = directory;
        else delete env.INFINITE_CANVAS_DATA_DIR;
        const result = spawnSync(process.execPath, ["scripts/local.mjs", "e2e-server"], {
            cwd: fileURLToPath(new URL("..", import.meta.url)), env, encoding: "utf8",
        });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /E2E requires an explicit isolated INFINITE_CANVAS_DATA_DIR/);
    });
}
