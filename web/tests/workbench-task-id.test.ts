import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("fresh browser runtimes cannot reuse a persisted script task identity", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/workbench-task-id.fixture.ts", import.meta.url));
    const run = async () => {
        const child = Bun.spawn([process.execPath, "run", fixture], { stdout: "pipe", stderr: "pipe" });
        const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect(code, error).toBe(0);
        return output.trim();
    };
    const [first, reloaded] = await Promise.all([run(), run()]);
    expect(first).toStartWith("image-");
    expect(reloaded).not.toBe(first);
});
