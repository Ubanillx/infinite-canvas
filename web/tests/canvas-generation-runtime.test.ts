import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("canvas runtime keeps pre-submit stops retryable and decodes archived dimensions", async () => {
    const child = Bun.spawn([process.execPath, "test", fileURLToPath(new URL("./fixtures/canvas-generation-runtime.fixture.ts", import.meta.url))], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
    expect(`${stdout}\n${stderr}`).toMatch(/\b7 pass\b/);
});
