import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("generation task client preserves idempotency and workspace scope", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/generation-task-client.fixture.ts", import.meta.url));
    const child = Bun.spawn([process.execPath, "test", fixture], {
        cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(`${stdout}\n${stderr}`).toMatch(/\b13 pass\b/);
});
