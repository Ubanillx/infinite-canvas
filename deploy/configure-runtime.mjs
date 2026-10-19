import { writeFile } from "node:fs/promises";

const config = {
    CANVAS_AGENT_URL: "/api/canvas-agent",
    ANALYTICS_GA4_ID: process.env.ANALYTICS_GA4_ID || "",
    ANALYTICS_BAIDU_ID: process.env.ANALYTICS_BAIDU_ID || "",
};
await writeFile("/app/web/dist/config.js", `window.__RUNTIME_CONFIG__ = ${JSON.stringify(config)};\n`, { mode: 0o644 });
