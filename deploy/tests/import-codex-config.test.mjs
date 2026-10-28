import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../import-codex-config.sh");
const oldConfig = 'model_provider = "original"\n';
const fakeDocker = `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "ps" || args[0] === "inspect") { console.log("app-id"); process.exit(0); }
if (args[0] === "restart") { fs.writeFileSync(process.env.RESTART_LOG, "restarted"); process.exit(0); }
if (args[0] !== "exec") process.exit(2);
const env = { ...process.env, CODEX_HOME: process.env.IMPORT_TARGET };
let index = 1;
while (args[index].startsWith("-")) {
  if (args[index++] === "-e") {
    const entry = args[index++];
    const separator = entry.indexOf("=");
    env[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
}
index++;
const result = spawnSync(args[index], args.slice(index + 1), { env, stdio: "inherit" });
process.exit(result.status ?? 1);
`;
const fakeCodex = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(process.env.PREFLIGHT_LOG, JSON.stringify({ args: process.argv.slice(2), home: process.env.CODEX_HOME }));
fs.mkdirSync(path.join(process.env.CODEX_HOME, "tmp"));
fs.writeFileSync(path.join(process.env.CODEX_HOME, "tmp", "state"), "temporary CLI state");
process.exit(Number(process.env.PREFLIGHT_FAILURE || 0));
`;

function fixture(t, reference = "models.json") {
    const root = mkdtempSync(join(tmpdir(), "canvas-codex-import-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const source = join(root, "host codex");
    const target = join(root, "container codex");
    const bin = join(root, "bin");
    for (const dir of [source, target, bin]) mkdirSync(dir);
    writeFileSync(join(bin, "docker"), fakeDocker, { mode: 0o755 });
    writeFileSync(join(bin, "codex"), fakeCodex, { mode: 0o755 });
    writeFileSync(join(target, "config.toml"), oldConfig);
    writeFileSync(join(target, "imported-model-catalog.json"), "original catalog");
    const config = `model_provider = "magpie"\nmodel_catalog_json = ${JSON.stringify(reference)}\n\n[model_providers.magpie]\nname = "Magpie"\nbase_url = "https://example.invalid/v1"\nexperimental_bearer_token = "fixture-not-a-real-key"\n`;
    writeFileSync(join(source, "config.toml"), config);
    const catalog = JSON.stringify({ models: [{ slug: "fixture" }] });
    const sourceCatalog = resolve(source, reference);
    const preflightLog = join(root, "preflight.json");
    const restartLog = join(root, "restart");
    const run = (env = {}, options = []) => spawnSync("bash", [script, "--source", source, "--restart", ...options], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, IMPORT_TARGET: target, PREFLIGHT_LOG: preflightLog, RESTART_LOG: restartLog, ...env },
    });
    return { root, source, target, config, catalog, sourceCatalog, preflightLog, restartLog, run };
}

for (const absolute of [false, true]) {
    test(`imports the ${absolute ? "absolute" : "relative"} model catalog without changing provider settings`, t => {
        const reference = absolute ? join(tmpdir(), `canvas-catalog-${process.pid}-${Date.now()}.json`) : 'model "catalog".json';
        const f = fixture(t, reference);
        if (absolute) t.after(() => rmSync(reference, { force: true }));
        writeFileSync(f.sourceCatalog, f.catalog);
        const result = f.run();
        assert.equal(result.status, 0, result.stderr);
        const importedPath = join(f.target, "imported-model-catalog.json");
        assert.equal(readFileSync(importedPath, "utf8"), f.catalog);
        assert.equal(readFileSync(join(f.target, "config.toml"), "utf8"), f.config.replace(/^model_catalog_json = .*$/m, `model_catalog_json = ${JSON.stringify(importedPath)}`));
        assert.equal(readFileSync(join(f.source, "config.toml"), "utf8"), f.config);
        assert.equal(readFileSync(f.sourceCatalog, "utf8"), f.catalog);
        const backup = join(f.target, readdirSync(f.target).find(name => name.startsWith("config-backup-")));
        assert.equal(readFileSync(join(backup, "config.toml"), "utf8"), oldConfig);
        assert.equal(readFileSync(join(backup, "imported-model-catalog.json"), "utf8"), "original catalog");
        assert.equal(statSync(importedPath).mode & 0o777, 0o600);
        const validation = JSON.parse(readFileSync(f.preflightLog, "utf8"));
        assert.deepEqual(validation.args, ["app-server", "--print-startup-config", "-c", `model_catalog_json=${JSON.stringify(join(validation.home, "imported-model-catalog.json"))}`]);
        assert.equal(existsSync(f.restartLog), true);
        assert.equal(readdirSync(f.target).some(name => name.startsWith(".config-import.")), false);
        assert.equal((result.stdout + result.stderr).includes("fixture-not-a-real-key"), false);
    });
}

test("missing host catalog leaves live config/catalog untouched and does not restart", t => {
    const f = fixture(t);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /host model_catalog_json file is missing or unreadable/);
    assert.equal(readFileSync(join(f.target, "config.toml"), "utf8"), oldConfig);
    assert.equal(readFileSync(join(f.target, "imported-model-catalog.json"), "utf8"), "original catalog");
    assert.equal(existsSync(f.preflightLog), false);
    assert.equal(existsSync(f.restartLog), false);
    assert.equal(readdirSync(f.target).some(name => name.startsWith(".config-import.")), false);
});

test("container CLI rejection leaves live files untouched and cleans staged CLI state", t => {
    const f = fixture(t);
    writeFileSync(f.sourceCatalog, f.catalog);
    const result = f.run({ PREFLIGHT_FAILURE: "1" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Container Codex could not load the staged configuration/);
    assert.equal(readFileSync(join(f.target, "config.toml"), "utf8"), oldConfig);
    assert.equal(readFileSync(join(f.target, "imported-model-catalog.json"), "utf8"), "original catalog");
    assert.equal(existsSync(f.restartLog), false);
    assert.equal(readdirSync(f.target).some(name => name.startsWith(".config-import.") || name.startsWith("config-backup-")), false);
});

// Only the host service transport is fake; staging, TOML edits and native-CLI invocation use the real script/Bun.
function gatewayFixture(t) {
    const f = fixture(t);
    f.config = f.config.replace("https://example.invalid/v1", "http://127.0.0.1:3425/backend-api/codex");
    writeFileSync(join(f.source, "config.toml"), f.config);
    writeFileSync(f.sourceCatalog, f.catalog);
    writeFileSync(join(f.source, "auth.json"), '{"OPENAI_API_KEY":"host-auth-must-not-be-copied"}');
    writeFileSync(join(f.target, "auth.json"), '{"OPENAI_API_KEY":"existing-container-auth"}');
    const log = join(f.root, "magpie-actions.json");
    writeFileSync(join(f.root, "bin", "python3"), `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const [action, container, stage] = process.argv.slice(3);
const root = process.env.MAGPIE_TEST_ROOT;
const log = path.join(root, "magpie-actions.json");
const actions = fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, "utf8")) : [];
actions.push(action);
fs.writeFileSync(log, JSON.stringify(actions));
if (action === "lock") {
  const lock = path.join(root, "magpie.lock"); fs.writeFileSync(lock, ""); console.log(lock);
} else if (action === "begin") {
  const backup = path.join(root, "magpie-backup"); fs.mkdirSync(backup, { recursive: true }); console.log(backup);
} else if (action === "prepare") {
  fs.writeFileSync(path.join(stage, "magpie-gateway.json"), JSON.stringify({ base_url: "http://172.18.0.1:3425/v1", key: "fixture-private-gateway-key" }), { mode: 0o600 });
} else if (action === "activate" && process.env.MAGPIE_ACTIVATION_FAILURE) {
  console.error("Gateway allowlist verification failed"); process.exit(1);
}
`, { mode: 0o755 });
    return { ...f, actions: () => JSON.parse(readFileSync(log, "utf8")), runGateway: (env = {}) => f.run({ MAGPIE_TEST_ROOT: f.root, ...env }, ["--magpie-gateway"]) };
}

test("Magpie opt-in stages a private HTTP provider without importing host auth or changing host config", t => {
    const f = gatewayFixture(t);
    const result = f.runGateway();
    assert.equal(result.status, 0, result.stderr);
    const config = readFileSync(join(f.target, "config.toml"), "utf8");
    assert.match(config, /^model_provider = "infinite_canvas_magpie"/);
    assert.match(config, /base_url = "http:\/\/172\.18\.0\.1:3425\/v1"/);
    assert.match(config, /supports_websockets = false/);
    assert.match(config, /requires_openai_auth = false/);
    assert.match(config, /experimental_bearer_token = "fixture-private-gateway-key"/);
    assert.match(config, /base_url = "http:\/\/127\.0\.0\.1:3425\/backend-api\/codex"/);
    assert.equal(statSync(join(f.target, "config.toml")).mode & 0o777, 0o600);
    assert.equal(readFileSync(join(f.source, "config.toml"), "utf8"), f.config);
    assert.equal(readFileSync(join(f.target, "auth.json"), "utf8"), '{"OPENAI_API_KEY":"existing-container-auth"}');
    assert.deepEqual(f.actions(), ["lock", "begin", "prepare", "activate", "commit"]);
    assert.equal(existsSync(f.restartLog), true);
    assert.equal(readdirSync(f.target).some(name => name.startsWith(".config-import.")), false);
    assert.doesNotMatch(result.stdout + result.stderr, /fixture-private-gateway-key|fixture-not-a-real-key|host-auth-must-not-be-copied/);
});

for (const [name, env, expected] of [
    ["container config preflight", { PREFLIGHT_FAILURE: "1" }, ["lock", "begin", "prepare", "rollback"]],
    ["host gateway activation", { MAGPIE_ACTIVATION_FAILURE: "1" }, ["lock", "begin", "prepare", "activate", "rollback"]],
]) {
    test(`Magpie ${name} failure restores host setup without replacing container config or restarting it`, t => {
        const f = gatewayFixture(t);
        const result = f.runGateway(env);
        assert.notEqual(result.status, 0);
        assert.deepEqual(f.actions(), expected);
        assert.equal(readFileSync(join(f.target, "config.toml"), "utf8"), oldConfig);
        assert.equal(readFileSync(join(f.target, "imported-model-catalog.json"), "utf8"), "original catalog");
        assert.equal(existsSync(f.restartLog), false);
        assert.equal(readdirSync(f.target).some(name => name.startsWith(".config-import.") || name.startsWith("config-backup-")), false);
        assert.doesNotMatch(result.stdout + result.stderr, /fixture-private-gateway-key/);
    });
}

test("container installation refusal rolls Magpie back even after its managed key state was committed", t => {
    const f = gatewayFixture(t);
    rmSync(join(f.target, "imported-model-catalog.json"));
    mkdirSync(join(f.target, "imported-model-catalog.json"));
    const result = f.runGateway();
    assert.notEqual(result.status, 0);
    assert.deepEqual(f.actions(), ["lock", "begin", "prepare", "activate", "commit", "rollback"]);
    assert.equal(readFileSync(join(f.target, "config.toml"), "utf8"), oldConfig);
    assert.equal(existsSync(f.restartLog), false);
});

test("embedded Magpie Bun probe reads its private payload and sends authentication only when requested", async t => {
    const code = readFileSync(script, "utf8").split("    code = '''", 2)[1].split("'''", 1)[0];
    const root = mkdtempSync(join(tmpdir(), "canvas-magpie-probe-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const server = createServer((request, response) => {
        response.writeHead(request.url === "/v1/models" && request.headers.authorization === "Bearer fixture-http-key" ? 200 : 401);
        response.end("{}");
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    writeFileSync(join(root, "magpie-gateway.json"), JSON.stringify({ base_url: `http://127.0.0.1:${server.address().port}/v1`, key: "fixture-http-key" }), { mode: 0o600 });
    for (const [authenticated, expected] of [["yes", 200], ["no", 401]]) {
        const child = spawn("bun", ["-e", code, root, String(expected), authenticated]);
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", chunk => { stdout += chunk; });
        child.stderr.on("data", chunk => { stderr += chunk; });
        const status = await new Promise((resolve, reject) => {
            child.once("error", reject);
            child.once("close", resolve);
        });
        assert.equal(status, 0, stderr);
        assert.equal(stdout, String(expected));
        assert.doesNotMatch(stdout + stderr, /fixture-http-key/);
    }
});
