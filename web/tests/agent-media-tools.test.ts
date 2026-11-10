import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("media tools keep package and workspace boundaries", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/agent-media-tools.fixture.ts", import.meta.url));
    const child = Bun.spawn([process.execPath, "test", fixture], {
        cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(`${stdout}\n${stderr}`).toMatch(/\b[1-9]\d* pass\b/);
});
