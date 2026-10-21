import { spawn } from "node:child_process";
import { mkdirSync, appendFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { stripVTControlCharacters } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = resolve(root, ".local");
const command = process.argv[2];
mkdirSync(artifacts, { recursive: true });

function run(executable, args, cwd, env = {}, logFile) {
    return new Promise((done) => {
        const child = spawn(executable, args, { cwd: resolve(root, cwd), env: { ...process.env, ...env }, stdio: ["inherit", "pipe", "pipe"] });
        for (const [stream, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
            createInterface({ input: stream }).on("line", (line) => {
                output.write(`${line}\n`);
                if (logFile) appendFileSync(logFile, `${JSON.stringify({ time: new Date().toISOString(), message: stripVTControlCharacters(line) })}\n`);
            });
        }
        const stop = () => child.kill("SIGTERM");
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
        child.on("error", (error) => { console.error(error.message); });
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
if (command === "dev" || command === "e2e-server") {
    const testing = command === "e2e-server";
    const data = process.env.INFINITE_CANVAS_DATA_DIR || resolve(artifacts, "dev-data");
    if (testing && !process.env.INFINITE_CANVAS_DATA_DIR) throw new Error("E2E requires an isolated data directory");
    const log = process.env.LOCAL_SERVER_LOG || resolve(artifacts, "dev-server.jsonl");
    console.log(`Data: ${data}\nLog: ${log}`);
    code = await run(process.execPath, ["--bun", "node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", testing ? "3100" : "3000", "--strictPort"], "web", { INFINITE_CANVAS_DATA_DIR: data }, log);
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
    code = await run("node", ["node_modules/@playwright/test/cli.js", "test", ...process.argv.slice(3)], "web", {
        INFINITE_CANVAS_DATA_DIR: resolve(runDir, "data"), LOCAL_SERVER_LOG: log,
    });
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
