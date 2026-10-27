import { randomUUID } from "node:crypto";
import { test as base, expect, type APIRequestContext, type BrowserContext } from "@playwright/test";

export async function registerTestAccount(request: APIRequestContext, context?: BrowserContext) {
    const username = `e2e-${randomUUID()}`;
    const response = await request.post("/api/auth/register", { data: { username, password: randomUUID() } });
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
