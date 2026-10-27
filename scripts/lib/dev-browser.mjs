import { createRequire } from "node:module";
import { resolve } from "node:path";

import { projectDir } from "./dev-env.mjs";

/** 复用 web 项目已安装的 Playwright，避免脚本各自安装浏览器依赖。 */
export function loadPlaywright() {
    const load = createRequire(resolve(projectDir("web"), "package.json"));
    try {
        return load("playwright");
    } catch (error) {
        throw new Error(`Playwright is not installed. Run: cd web && npm ci --legacy-peer-deps && npx playwright install chromium\n${error.message}`);
    }
}

/** 启动 Chromium；PLAYWRIGHT_CHANNEL 可指定本机已安装的浏览器渠道，缺浏览器时提示安装命令。 */
export async function launchBrowser({ headless = true, slowMo = 0, args = [] } = {}) {
    const channel = process.env.PLAYWRIGHT_CHANNEL;
    try {
        return await loadPlaywright().chromium.launch({ headless, slowMo, channel: channel || undefined, args: ["--no-sandbox", ...args] });
    } catch (error) {
        if (!/Executable doesn't exist/i.test(error.message)) throw error;
        throw new Error(`Chromium is not installed for Playwright. Run: npx --prefix web playwright install chromium\n${error.message.split("\n")[0]}`);
    }
}

/** 新建页面并默认收集控制台、未捕获异常和失败请求。 */
export async function openPage(browser, { baseURL = "http://127.0.0.1:3000", viewport, recordConsole = true } = {}) {
    const context = await browser.newContext({ baseURL, viewport: viewport || { width: 1440, height: 900 } });
    const page = await context.newPage();
    const diagnostics = recordConsole ? attachDiagnostics(page) : null;
    return { context, page, diagnostics };
}

/**
 * 收集浏览器侧问题，默认只记录不抛错，由调用方决定何时断言。
 * ignoredUrls 过滤已知的外部依赖，例如测试环境里的第三方提示词源。
 */
export function attachDiagnostics(page, { ignoredUrls = [/^https:\/\/raw\.githubusercontent\.com\//] } = {}) {
    const events = [];
    const failures = [];
    const shortPath = (url) => {
        try {
            const value = new URL(url);
            return `${value.origin}${value.pathname}`;
        } catch {
            return url;
        }
    };
    const ignored = (url) => ignoredUrls.some((pattern) => pattern.test(url));
    const record = (type, message, fatal = false) => {
        events.push({ type, message });
        if (fatal) failures.push(`${type}: ${message}`);
    };
    page.on("console", (message) => record(`console.${message.type()}`, message.text(), message.type() === "error"));
    page.on("pageerror", (error) => record("pageerror", error.message, true));
    page.on("requestfailed", (request) => {
        const reason = request.failure()?.errorText;
        if (reason === "net::ERR_ABORTED" || ignored(request.url())) return;
        record("requestfailed", `${request.method()} ${shortPath(request.url())}: ${reason}`, true);
    });
    page.on("response", (response) => {
        if (response.status() < 400 || ignored(response.url())) return;
        record("http", `${response.status()} ${shortPath(response.url())}`, true);
    });
    return {
        events,
        failures,
        /** 没有浏览器侧错误时通过，否则抛出带明细的错误。 */
        assertClean(hint = "Browser errors / failed requests") {
            if (failures.length) throw new Error(`${hint}\n${failures.join("\n")}`);
        },
        /** 打印诊断摘要，供冒烟脚本收尾使用。 */
        print() {
            const counts = events.reduce((total, item) => ({ ...total, [item.type]: (total[item.type] || 0) + 1 }), {});
            console.log(`Browser diagnostics: ${events.length} event(s)`, counts);
            for (const failure of failures) console.error(`  ${failure}`);
        },
    };
}

/** 截取当前视口截图并返回文件路径。 */
export async function capture(page, dir, name) {
    const file = resolve(dir, `${name}.png`);
    await page.screenshot({ path: file });
    return file;
}
