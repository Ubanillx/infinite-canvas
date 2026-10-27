const base = `http://127.0.0.1:${process.env.PORT || "3000"}`;
try {
    const page = await fetch(`${base}/`);
    const html = await page.text();
    if (!page.ok || !html.includes('id="root"')) throw new Error("Web page unavailable");
    const entry = html.match(/<script\b[^>]*\bsrc="([^"]*\/assets\/[^"]+\.js)"/)?.[1];
    if (!entry || !entry.startsWith("/")) throw new Error("Built asset entry unavailable");
    const asset = await fetch(`${base}${entry}`);
    if (!asset.ok || !/javascript/.test(asset.headers.get("content-type") || "")) throw new Error("Built asset unavailable");
    const auth = await fetch(`${base}/api/auth/me`);
    const body = await auth.json();
    if (auth.status !== 401 || typeof body.error !== "string") throw new Error("Authentication database unavailable");
    const agent = await fetch(`${base}/api/canvas-agent/health`);
    if (!agent.ok || (await agent.json()).ok !== true) throw new Error("Agent proxy unavailable");
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
