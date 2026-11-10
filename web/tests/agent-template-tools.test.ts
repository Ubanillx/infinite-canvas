import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("template tools preserve workspace scope and committed insertion", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/agent-template-tools.fixture.ts", import.meta.url));
    const child = Bun.spawn([process.execPath, "test", fixture], {
        cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(`${stdout}\n${stderr}`).toMatch(/\b[1-9]\d* pass\b/);
});

test("template media errors wait for all started copies and expose created keys", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/canvas-template-media.fixture.ts", import.meta.url));
    const child = Bun.spawn([process.execPath, "test", fixture], {
        cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(`${stdout}\n${stderr}`).toMatch(/\b[1-9]\d* pass\b/);
});

test("queued template metadata patches retain both writers' changes", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/canvas-template-store.fixture.ts", import.meta.url));
    const child = Bun.spawn([process.execPath, "test", fixture], {
        cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(`${stdout}\n${stderr}`).toMatch(/\b[1-9]\d* pass\b/);
});
