import { readFileSync, readdirSync, statSync, watch } from "node:fs";
import { resolve } from "node:path";

import { localDir } from "./lib/dev-env.mjs";
import { printLogSummary, scanLog } from "./dev-run.mjs";

/**
 * 日志工具：列出、扫描、跟踪 .local 下的 JSONL 运行日志。
 * node scripts/dev-logs.mjs                扫描 .local 下全部日志
 * node scripts/dev-logs.mjs <file...>      只扫描指定日志
 * node scripts/dev-logs.mjs --list         只列出日志文件
 * node scripts/dev-logs.mjs --tail <file>  跟踪某个日志的新增行（可加 --from-start）
 */
const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const values = new Set(args.filter((value, index) => index > 0 && args[index - 1].startsWith("--")));
const files = args.filter((value) => !value.startsWith("--") && !values.has(value)).map((value) => resolve(value));

function findLogs(dir, depth = 2) {
    if (!statSafe(dir)) return [];
    const found = [];
    for (const name of readdirSync(dir)) {
        const full = resolve(dir, name);
        const stat = statSafe(full);
        if (!stat) continue;
        if (stat.isDirectory()) {
            if (depth > 0) found.push(...findLogs(full, depth - 1));
        } else if (name.endsWith(".jsonl")) {
            found.push(full);
        }
    }
    return found;
}

function statSafe(path) {
    try {
        return statSync(path);
    } catch {
        return null;
    }
}

const targets = files.length ? files : findLogs(localDir);
if (!targets.length) {
    console.error(`No JSONL logs under ${localDir}. Run "npm run dev" or an E2E/smoke script first, or pass a log path.`);
    process.exit(1);
}

if (has("list")) {
    for (const file of targets) {
        const result = scanLog(file);
        console.log(`${file} — ${result.lines} line(s), ${result.suspect.length} suspect`);
    }
} else if (has("tail")) {
    const file = targets[0];
    let offset = has("from-start") ? 0 : readFileSync(file, "utf8").length;
    console.log(`Following ${file} (Ctrl+C to stop)`);
    watch(file, () => {
        const text = readFileSync(file, "utf8");
        if (text.length <= offset) return;
        for (const line of text.slice(offset).split("\n").filter(Boolean)) console.log(line);
        offset = text.length;
    });
} else {
    let code = 0;
    for (const file of targets) code = printLogSummary(file) || code;
    console.log(`\nChecked ${targets.length} log file(s).`);
    process.exitCode = code;
}
