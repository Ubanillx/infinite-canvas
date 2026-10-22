import { launchBrowser } from "./lib/dev-browser.mjs";

/** 命令行截图：可设视口、主题、等待和整页，用于快速查看 UI 效果。 */
const flag = (name, fallback) => {
    const index = process.argv.indexOf(`--${name}`);
    return index > 0 ? process.argv[index + 1] : fallback;
};
const has = (name) => process.argv.includes(`--${name}`);

const url = process.argv[2];
if (!url || url.startsWith("--")) {
    console.error("Usage: node scripts/dev-shot.mjs <url> [--out file.png] [--width 1440] [--height 900] [--full] [--wait 500] [--headed] [--theme dark]");
    process.exit(1);
}

const out = flag("out", ".local/screenshot.png");
const browser = await launchBrowser({ headless: !has("headed") });
try {
    const context = await browser.newContext({
        viewport: { width: Number(flag("width", 1440)), height: Number(flag("height", 900)) },
        colorScheme: flag("theme", "") === "dark" ? "dark" : "light",
        storageState: flag("state", "") || undefined,
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "networkidle" });
    const wait = Number(flag("wait", 0));
    if (wait) await page.waitForTimeout(wait);
    if (has("selector")) await page.waitForSelector(flag("selector", ""), { timeout: 15000 });
    await page.screenshot({ path: out, fullPage: has("full") });
    console.log(`Screenshot: ${out} (${await page.title()})`);
    await context.close();
} finally {
    await browser.close();
}
