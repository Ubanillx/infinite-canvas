import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("workbench request IDs cannot switch execution paths", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/workbench-execution.fixture.ts", import.meta.url));
    const child = Bun.spawn([process.execPath, "test", fixture], { stdout: "pipe", stderr: "pipe" });
    const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, `${output}\n${error}`).toBe(0);
});
