import { createHmac, randomInt, randomUUID } from "node:crypto";
import { test as base, expect, type APIRequestContext, type BrowserContext } from "@playwright/test";
import { defaultRegistrationConfig } from "../src/lib/registration";
import { execute, getPool, hashToken, newSessionToken } from "../src/server/db";
import { saveRegistrationConfig } from "../src/server/registration";

/** 仅在 E2E 专用数据库放入已投递的邮件夹具；注册仍通过真实接口消费验证码。 */
export async function prepareTestEmailVerification(email: string) {
    if (!process.env.DATABASE_URL || !/^\/infinite_canvas_e2e_[a-z0-9_]+$/.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error("Email fixtures require an isolated E2E database");
    await saveRegistrationConfig({ ...defaultRegistrationConfig, smtp: { ...defaultRegistrationConfig.smtp, host: "smtp.e2e.test", from: "sender@e2e.test" } });
    const challengeToken = newSessionToken();
    const code = String(randomInt(1_000_000)).padStart(6, "0");
    const codeHash = createHmac("sha256", challengeToken).update(`${email}:${code}`).digest("hex");
    await execute(await getPool(), "INSERT INTO registration_email_codes (id, email, code_hash, expires_at, sent_at) VALUES ($1, $2, $3, now() + interval '10 minutes', now())", await hashToken(challengeToken), email, codeHash);
    return { email, code, challengeToken, resendAfter: 60, expiresIn: 600 };
}

export async function registerTestAccount(request: APIRequestContext, context?: BrowserContext) {
    const username = `e2e-${randomUUID()}`;
    const verification = await prepareTestEmailVerification(`${username}@e2e.test`);
    const response = await request.post("/api/auth/register", { data: { username, password: randomUUID(), email: verification.email, code: verification.code, challengeToken: verification.challengeToken } });
    expect(response.status()).toBe(201);
    if (context) await context.addCookies((await request.storageState()).cookies);
    return response.json();
}

export const test = base.extend<{ account: void }>({
    account: [async ({ request, context }, use) => {
        await registerTestAccount(request, context);
        await use();
    }, { auto: true }],
});
export { expect };
