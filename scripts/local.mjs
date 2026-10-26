import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, appendFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { stripVTControlCharacters } from "node:util";
import { homedir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = resolve(root, ".local");
const command = process.argv[2];
mkdirSync(artifacts, { recursive: true });

function run(executable, args, cwd, env = {}, logFile, signal) {
    return new Promise((done) => {
        const child = spawn(executable, args, { cwd: resolve(root, cwd), env: { ...process.env, ...env }, stdio: ["inherit", "pipe", "pipe"], signal });
        for (const [stream, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
            createInterface({ input: stream }).on("line", (line) => {
                if (cwd === "canvas-agent") line = line.replace(/(Connect token:)\s*\S+/i, "$1 [REDACTED]");
                output.write(`${line}\n`);
                if (logFile) appendFileSync(logFile, `${JSON.stringify({ time: new Date().toISOString(), message: stripVTControlCharacters(line) })}\n`);
            });
        }
        const stop = () => child.kill("SIGTERM");
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
        child.on("error", (error) => { if (error.name !== "AbortError") console.error(error.message); });
        child.on("close", (code) => {
            process.off("SIGINT", stop);
            process.off("SIGTERM", stop);
            done(code ?? 1);
        });
    });
}

function checkLogs(files) {
    let errors = 0;
    for (const file of files) {
        for (const line of readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean)) {
            const entry = JSON.parse(line);
            if (/\b(error|fatal|exception|unhandled)\b|request failed|proxy failed/i.test(entry.message)) {
                console.error(`${file}: ${entry.message}`);
                errors++;
            }
        }
    }
    console.log(`Checked ${files.length} log file(s); ${errors} suspect line(s).`);
    return errors ? 1 : 0;
}

let code = 0;
const agentEnv = { INFINITE_CANVAS_DATA_DIR: process.env.INFINITE_CANVAS_DATA_DIR || resolve(homedir(), ".infinite-canvas/data") };
const agentArgs = ["--import", "tsx", "src/index.ts"];
async function agentRunning() {
    try {
        const config = JSON.parse(readFileSync(resolve(homedir(), ".infinite-canvas/canvas-agent.json"), "utf8"));
        const response = await fetch(`${config.url}/health`);
        if (!response.ok) return false;
        if ((await response.json()).protocolVersion !== 7) throw new Error("Canvas Agent 协议已更新，请停止旧 Agent 后重新启动 npm run dev");
        return true;
    } catch (error) {
        if (error instanceof Error && error.message.includes("协议已更新")) throw error;
        return false;
    }
}
if (command === "agent") {
    code = await run("node", [...agentArgs, "--debug"], "canvas-agent", agentEnv, resolve(artifacts, "dev-agent.jsonl"));
} else
if (command === "dev" || command === "e2e-server") {
    const testing = command === "e2e-server";
    const log = process.env.LOCAL_SERVER_LOG || resolve(artifacts, "dev-server.jsonl");
    // E2E 必须指向独立的 database 与 bucket；缺少时拒绝启动，避免污染开发数据。
    const env = { ...agentEnv };
    if (testing) {
        if (!process.env.DATABASE_URL || !process.env.S3_BUCKET) throw new Error("E2E requires DATABASE_URL and S3_BUCKET for an isolated database and bucket");
        env.DATABASE_URL = process.env.DATABASE_URL;
        env.S3_BUCKET = process.env.S3_BUCKET;
        console.log(`Database: ${process.env.DATABASE_URL}\nBucket:   ${process.env.S3_BUCKET}\nLog:      ${log}`);
    } else {
        console.log(`Log: ${log}`);
    }
    const stopAgent = new AbortController();
    const agent = !testing && !await agentRunning() ? run("node", agentArgs, "canvas-agent", agentEnv, resolve(artifacts, "dev-agent.jsonl"), stopAgent.signal) : null;
    try {
        code = await run(process.execPath, ["--bun", "node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", testing ? "3100" : "3000", "--strictPort"], "web", env, log);
    } finally {
        stopAgent.abort();
        await agent;
    }
} else if (command === "test") {
    for (const [exe, args, cwd] of [
        [process.execPath, ["test", "tests", "src/server/ai-response.test.mjs"], "web"],
        ["node", ["node_modules/tsx/dist/cli.mjs", "--test", ...readdirSync(resolve(root, "canvas-agent/src"), { recursive: true }).filter((file) => String(file).endsWith(".test.ts")).map((file) => `src/${file}`)], "canvas-agent"],
        ["node", ["--test", "deploy/tests/healthcheck.test.mjs"], "."],
        ["python", ["deploy/tests/test_deployment.py", "-v"], "."],
    ]) {
        const result = await run(exe, args, cwd);
        if (result) code = result;
    }
} else if (command === "e2e") {
    const runDir = resolve(artifacts, `e2e-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    mkdirSync(runDir, { recursive: true });
    const log = resolve(runDir, "server.jsonl");
    const runId = `${Date.now().toString(36)}_${process.pid}`;
    const middleware = JSON.parse(execFileSync("node", ["scripts/e2e-middleware.mjs", "up", runId], { encoding: "utf8" }).trim());
    console.log(`E2E database: ${middleware.database}\nE2E bucket:   ${middleware.bucket}`);
    try {
        code = await run("node", ["node_modules/@playwright/test/cli.js", "test", ...process.argv.slice(3)], "web", {
            DATABASE_URL: middleware.databaseUrl, S3_BUCKET: middleware.bucket, LOCAL_SERVER_LOG: log,
            PLAYWRIGHT_OUTPUT_DIR: resolve(runDir, "test-results"), PLAYWRIGHT_HTML_REPORT: resolve(runDir, "report"),
        }, resolve(runDir, "tests.jsonl"));
    } finally {
        try {
            execFileSync("node", ["scripts/e2e-middleware.mjs", "down", runId], { stdio: "inherit" });
        } catch {
            console.error(`E2E cleanup failed for run ${runId}; remove database ${middleware.database} manually`);
        }
    }
    if (existsSync(log)) code = checkLogs([log]) || code;
    console.log(`E2E artifacts: ${runDir}`);
} else if (command === "logs") {
    const files = process.argv.slice(3).map((file) => resolve(file));
    if (!files.length && existsSync(resolve(artifacts, "dev-server.jsonl"))) files.push(resolve(artifacts, "dev-server.jsonl"));
    if (!files.length) { console.error("No logs found; start npm run dev first, or pass a JSONL log path."); code = 1; }
    else code = checkLogs(files);
} else if (command === "report") {
    code = await run("node", ["node_modules/@playwright/test/cli.js", "show-report", "playwright-report"], "web");
} else if (command === "doctor") {
    console.log(`Bun: ${process.versions.bun}; expected 1.3.13 (Docker baseline)`);
    for (const dir of ["web/node_modules", "canvas-agent/node_modules"]) {
        console.log(`${dir}: ${existsSync(resolve(root, dir)) ? "OK" : "MISSING"}`);
        if (!existsSync(resolve(root, dir))) code = 1;
    }
    console.log(`web/node_modules/@playwright/test/cli.js: ${existsSync(resolve(root, "web/node_modules/@playwright/test/cli.js")) ? "OK" : "MISSING"}`);
    for (const [exe, args] of [["node", ["--version"]], ["python", ["--version"]]]) code = await run(exe, args, ".") || code;
} else {
    console.error("Expected dev, e2e-server, test, e2e, logs or doctor");
    code = 1;
}
process.exitCode = code;
