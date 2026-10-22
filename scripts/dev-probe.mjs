import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { capture, launchBrowser, openPage } from "./lib/dev-browser.mjs";
import { runDataDir, timestampDir } from "./lib/dev-env.mjs";
import { printLogSummary, startDevServer } from "./dev-run.mjs";

/**
 * 浏览器冒烟探针：真实 Chromium 打开页面，收集控制台/网络错误并截图。
 * 用 --url 复用已经在跑的开发服务器，不给定时会自己起一个隔离服务。
 */
const flag = (name, fallback) => {
    const index = process.argv.indexOf(`--${name}`);
    return index > 0 ? process.argv[index + 1] : fallback;
};
const has = (name) => process.argv.includes(`--${name}`);

const routes = (flag("routes", "/,/canvas") || "").split(",").filter(Boolean);
const mobile = has("mobile");
const runDir = timestampDir("probe");
let server = null;
let baseUrl = flag("url", "");
if (!baseUrl) {
    server = await startDevServer({ port: Number(flag("port", 3103)), dataDir: runDataDir(runDir), logFile: resolve(runDir, "server.jsonl"), quiet: true });
    baseUrl = server.baseUrl;
}

const browser = await launchBrowser({ headless: !has("headed") });
const report = [];
try {
    for (const route of routes) {
        const { context, page, diagnostics } = await openPage(browser, { baseURL: baseUrl, viewport: mobile ? { width: 390, height: 844 } : undefined });
        try {
            const response = await page.goto(route, { waitUntil: "domcontentloaded" });
            await page.waitForSelector("#root", { timeout: 15000 });
            await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
            const title = await page.title();
            const name = route.replace(/[^\w]+/g, "_").replace(/^_|_$/g, "") || "root";
            const screenshot = await capture(page, runDir, name);
            const entry = { route, status: response?.status(), title, screenshot, failures: diagnostics.failures, events: diagnostics.events.length };
            report.push(entry);
            console.log(`${diagnostics.failures.length ? "FAIL" : "ok  "} ${route} (${entry.status}) ${title} → ${screenshot}`);
            diagnostics.print();
        } finally {
            await context.close();
        }
    }
} finally {
    await browser.close();
    if (server) await server.stop();
}

const failures = report.filter((entry) => entry.failures.length);
const reportFile = resolve(runDir, "report.json");
writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
if (server?.logFile) printLogSummary(server.logFile);
console.log(`\n${failures.length ? `Browser probe failed on ${failures.length} route(s)` : "Browser probe passed"}; report: ${reportFile}`);
process.exitCode = failures.length ? 1 : 0;
