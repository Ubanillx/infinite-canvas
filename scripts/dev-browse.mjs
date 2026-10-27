import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { attachDiagnostics, launchBrowser } from "./lib/dev-browser.mjs";

/**
 * 浏览器调试 REPL：打开页面后执行任意步骤，保留真实浏览器方便观察。
 * 示例：
 *   node scripts/dev-browse.mjs http://127.0.0.1:3000/canvas --wait 1000 --shot canvas.png
 *   node scripts/dev-browse.mjs http://127.0.0.1:3000/canvas --step "getByRole('button', name: '新建画布').click()"
 * 步骤用 page 的定位 API 书写，多个 --step 按顺序执行，执行失败会截图后退出。
 */
const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : fallback;
};
const all = (name) => args.reduce((values, value, index) => (value === `--${name}` ? [...values, args[index + 1]] : values), []);
const has = (name) => args.includes(`--${name}`);

const url = args[0];
if (!url || url.startsWith("--")) {
    console.error("Usage: node scripts/dev-browse.mjs <url> [--step \"page.getByRole(...).click()\"] [--wait 500] [--shot file.png] [--full] [--headed] [--width 1440] [--height 900] [--theme dark] [--keep-open]");
    process.exit(1);
}

const browser = await launchBrowser({ headless: !has("headed") });
const context = await browser.newContext({
    viewport: { width: Number(flag("width", 1440)), height: Number(flag("height", 900)) },
    colorScheme: flag("theme", "") === "dark" ? "dark" : "light",
    storageState: flag("state", "") || undefined,
});
const page = await context.newPage();
const diagnostics = attachDiagnostics(page);

/** 在 page 作用域内执行一步操作，例如 page.getByRole("button", { name: "新建画布" }).click()。 */
async function runStep(step) {
    const run = new Function("page", `return (async () => { await (${step}); })();`);
    return run(page);
}
let failure = null;

try {
    const response = await page.goto(url, { waitUntil: "networkidle" });
    console.log(`Opened ${url} → ${response?.status()} (${await page.title()})`);
    const wait = Number(flag("wait", 0));
    if (wait) await page.waitForTimeout(wait);
    for (const step of all("step")) {
        console.log(`Step: ${step}`);
        await runStep(step);
        await page.waitForTimeout(Number(flag("step-wait", 300)));
    }
    if (flag("shot", "")) {
        await page.screenshot({ path: flag("shot", ""), fullPage: has("full") });
        console.log(`Screenshot: ${flag("shot", "")}`);
    }
    diagnostics.print();
    if (has("assert-clean")) diagnostics.assertClean();
    if (has("html")) writeFileSync(resolve(flag("html", ".local/page.html")), await page.content());
    if (has("keep-open")) {
        console.log("Browser kept open; press Ctrl+C to close.");
        await page.waitForEvent("close", { timeout: 0 });
    }
} catch (error) {
    failure = error;
    await page.screenshot({ path: flag("fail-shot", ".local/browse-failure.png") }).catch(() => undefined);
    console.error(`Failed: ${error.message}`);
    diagnostics.print();
} finally {
    await context.close();
    await browser.close();
}
process.exitCode = failure ? 1 : 0;
