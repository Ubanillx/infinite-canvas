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
    // 未登录会话返回 200 与空用户；数据库不可用时接口走 500 错误分支。
    if (auth.status !== 200 || body.user !== null || !Array.isArray(body.workspaces)) throw new Error("Authentication database unavailable");
    const agent = await fetch(`${base}/api/canvas-agent/health`);
    if (!agent.ok || (await agent.json()).ok !== true) throw new Error("Agent proxy unavailable");
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
