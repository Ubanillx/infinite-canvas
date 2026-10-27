import { test as base, expect } from "./auth";

export const test = base.extend<{ diagnostics: void }>({
    diagnostics: [async ({ page }, use, info) => {
        const events: { type: string; message: string }[] = [];
        const failures: string[] = [];
        const record = (type: string, message: string, fatal = false) => {
            events.push({ type, message });
            if (fatal) failures.push(`${type}: ${message}`);
        };
        const path = (url: string) => { const value = new URL(url); return `${value.origin}${value.pathname}`; };
        page.on("console", (message) => record(`console.${message.type()}`, message.text(), message.type() === "error"));
        page.on("pageerror", (error) => record("pageerror", error.message, true));
        page.on("requestfailed", (request) => record("requestfailed", `${request.method()} ${path(request.url())}: ${request.failure()?.errorText}`, request.failure()?.errorText !== "net::ERR_ABORTED"));
        page.on("response", (response) => {
            if (response.status() >= 400) record("http", `${response.status()} ${path(response.url())}`, true);
        });
        // External prompt catalogs are fixtures; workspace and persistence APIs remain real.
        await page.route("https://raw.githubusercontent.com/yukkcat/image-prompts/main/dist/sources/**", (route) => route.fulfill({ json: [] }));
        await use();
        await info.attach("browser-diagnostics", { body: JSON.stringify(events, null, 2), contentType: "application/json" });
        expect(failures, "Browser errors / failed requests").toEqual([]);
    }, { auto: true }],
});
export { expect };
