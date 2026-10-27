import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { projectDir } from "./lib/dev-env.mjs";
import { waitForServer } from "./lib/dev-http.mjs";

/** 日志里看起来像错误的行，供 logs:check 与调试收尾共用。 */
export const SUSPECT = /\b(error|fatal|exception|unhandled)\b|request failed|proxy failed/i;

/**
 * 启动受管的开发服务器：输出同时进入终端和 JSONL 日志。
 * 返回句柄后可以继续做浏览器验证，最后通过 stop() 关闭服务。
 */
export async function startDevServer({ port = 3000, dataDir, logFile, env = {}, quiet = false, readyPath = "/", readyTimeoutMs = 60000 } = {}) {
    const web = projectDir("web");
    if (await portAnswers(port)) throw new Error(`Port ${port} is already in use; stop the other server or pass --port`);
    if (logFile) mkdirSync(dirname(logFile), { recursive: true });
    const runtime = viteRuntime();
    const args = [...runtime.args, "node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(port), "--strictPort"];
    const child = spawn(runtime.executable, args, {
        cwd: web,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, INFINITE_CANVAS_DATA_DIR: dataDir, ...env },
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    const record = (line) => {
        const clean = stripVTControlCharacters(line);
        if (!quiet) process.stdout.write(`${clean}\n`);
        if (logFile) appendFileSync(logFile, `${JSON.stringify({ time: new Date().toISOString(), message: clean })}\n`);
    };
    for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on("line", record);
    const handle = {
        baseUrl,
        port,
        logFile,
        dataDir,
        child,
        stop: () => new Promise((done) => {
            if (child.exitCode !== null) return done();
            child.once("close", () => done());
            child.kill("SIGTERM");
        }),
    };
    try {
        await readyOrExit();
    } catch (error) {
        await handle.stop();
        throw error;
    }
    return handle;

    /** 服务就绪或进程提前退出，二者先到先得，避免端口冲突时一直等待。 */
    function readyOrExit() {
        let onExit;
        const exit = new Promise((_, fail) => {
            onExit = (code) => fail(new Error(`Dev server exited with code ${code} before it was ready`));
            child.once("exit", onExit);
        });
        return Promise.race([waitForServer(baseUrl, { timeoutMs: readyTimeoutMs, healthPath: readyPath }), exit])
            .finally(() => child.off("exit", onExit));
    }
}

/** 端口已被占用时立刻失败，避免复用到别的服务并误报就绪。 */
async function portAnswers(port) {
    try {
        await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
        return true;
    } catch {
        return false;
    }
}

/**
 * 选择启动 Vite 的运行时：默认沿用当前 Node，脚本用 bun 启动时同样走 Bun。
 * 需要显式指定时可设置 BUN_BIN=... 让 Vite 跑在 Bun 上。
 */
export function viteRuntime() {
    if (process.env.BUN_BIN) return { executable: process.env.BUN_BIN, args: [] };
    return { executable: process.execPath, args: process.versions.bun ? ["--bun"] : [] };
}

/** 扫描 JSONL 日志中的可疑行，返回明细而不是直接退出进程。 */
export function scanLog(file) {
    if (!file || !existsSync(file)) return { file, lines: 0, suspect: [] };
    const lines = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
    const suspect = [];
    for (const line of lines) {
        try {
            const entry = JSON.parse(line);
            if (SUSPECT.test(entry.message)) suspect.push(entry.message);
        } catch {
            if (SUSPECT.test(line)) suspect.push(line);
        }
    }
    return { file, lines: lines.length, suspect };
}

/** 打印日志扫描结果，返回应使用的退出码。 */
export function printLogSummary(file, { limit = 200 } = {}) {
    const result = scanLog(file);
    console.log(`Log: ${result.file || "(none)"} (${result.lines} line(s))`);
    if (!result.suspect.length) {
        console.log("No suspect log lines.");
        return 0;
    }
    console.error(`${result.suspect.length} suspect log line(s):`);
    for (const line of result.suspect.slice(0, limit)) console.error(`  ${line}`);
    return 1;
}

/** 作为脚本直接运行：node scripts/dev-run.mjs [--port 3000] [--data dir] [--log file] */
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    const flag = (name, fallback) => {
        const index = process.argv.indexOf(`--${name}`);
        return index > 0 ? process.argv[index + 1] : fallback;
    };
    const root = resolve(import.meta.dirname, "..");
    const logFile = resolve(flag("log", resolve(root, ".local/dev-server.jsonl")));
    let server;
    try {
        server = await startDevServer({
            port: Number(flag("port", 3000)),
            dataDir: resolve(flag("data", resolve(root, ".local/dev-data"))),
            logFile,
            env: flag("agent-url", "") ? { VITE_CANVAS_AGENT_URL: flag("agent-url", "") } : {},
        });
    } catch (error) {
        console.error(error.message);
        printLogSummary(logFile, { limit: 20 });
        process.exit(1);
    }
    console.log(`Ready: ${server.baseUrl}\nData:  ${server.dataDir}\nLog:   ${server.logFile}`);
    let stopping = false;
    const shutdown = async (code) => {
        if (stopping) return;
        stopping = true;
        await server.stop();
        printLogSummary(logFile);
        process.exit(code);
    };
    process.on("SIGINT", () => shutdown(0));
    process.on("SIGTERM", () => shutdown(0));
    server.child.on("close", (code) => shutdown(code ?? 1));
}
