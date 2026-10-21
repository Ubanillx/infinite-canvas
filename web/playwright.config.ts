import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
    testDir: "./e2e",
    outputDir: "./test-results",
    reporter: [["list"], ["html", { open: "never" }]],
    use: {
        baseURL: "http://127.0.0.1:3100",
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
    },
    projects: [
        { name: "chromium", use: { ...devices["Desktop Chrome"] } },
        { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
    ],
    webServer: {
        command: "bun ../scripts/local.mjs e2e-server",
        url: "http://127.0.0.1:3100/api/workspaces",
        reuseExistingServer: false,
    },
});
