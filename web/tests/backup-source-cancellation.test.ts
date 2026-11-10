import { createServer } from "node:http";
import { expect, test } from "bun:test";

// A subprocess keeps the singleton S3 client and fixture credentials out of other tests.
for (const stage of ["headers", "body"]) {
    test(`backup S3 source cancellation interrupts stalled ${stage}`, async () => {
        let received = false;
        const server = createServer((req, res) => {
            received = true;
            req.resume();
            if (stage === "body") { res.writeHead(200, { "content-length": 100 }); res.write("partial"); }
            else { child.stdin.write("cancel\n"); child.stdin.flush(); }
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Fixture did not bind");
        const modulePath = new URL("../src/server/object-storage.ts", import.meta.url).href;
        const child = Bun.spawn([process.execPath, "-e", `
            import { getMediaObject } from ${JSON.stringify(modulePath)};
            const controller = new AbortController();
            process.stdin.once("data", () => controller.abort(new Error("fixture cancellation")));
            const guard = setTimeout(() => { console.error("source remained stuck"); process.exit(2); }, 2000);
            try {
                const object = await getMediaObject("fixture", controller.signal);
                for await (const chunk of object.body) { controller.abort(new Error("fixture cancellation")); }
                process.exit(3);
            } catch {
                clearTimeout(guard);
                process.exit(controller.signal.aborted ? 0 : 4);
            }
        `], { env: { ...process.env, S3_ENDPOINT: `http://127.0.0.1:${address.port}`, S3_BUCKET: "fixture", S3_ACCESS_KEY: "fixture", S3_SECRET_KEY: "fixture" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
        try {
            expect(await child.exited).toBe(0);
            expect(received).toBe(true);
        } finally {
            child.kill();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
}
