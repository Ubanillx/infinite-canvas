import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { prepareTestEmailVerification } from "./auth";

test("TOPMAX email conflict guides the user back to local login", async ({ page }) => {
    await page.goto("/canvas?auth_error=keycloak_email_conflict");
    await expect(page.getByRole("heading", { name: "继续登录" })).toBeVisible();
    await expect(page.getByText("该 TOPMAX 账号尚未绑定")).toBeVisible();
    await page.getByRole("button", { name: "用账号密码登录" }).click();
    await expect(page.getByLabel("用户名", { exact: true })).toBeVisible();
});

test("registration, logout and login use real sessions instead of cached workspace identity", async ({ page }, info) => {
    const username = `account-${randomUUID()}`;
    const password = randomUUID();
    const email = `${username}@e2e.test`;
    const verification = await prepareTestEmailVerification(email);
    const bypass = await page.request.post("/api/auth/register", { data: { username, password, email } });
    expect(bypass.status()).toBe(400);
    expect((await (await page.request.get("/api/auth/me")).json()).user).toBeNull();
    expect((await page.request.get("/api/admin/registration")).status()).toBe(401);
    await page.route("**/api/auth/register/code", (route) => route.fulfill({ json: { challengeToken: verification.challengeToken, resendAfter: verification.resendAfter, expiresIn: verification.expiresIn } }));
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
        if (sessionStorage.getItem("account-test-seeded")) return;
        sessionStorage.setItem("account-test-seeded", "1");
        const stale = { id: "not-a-membership", name: "Cached stranger workspace", role: "owner", createdAt: new Date().toISOString() };
        localStorage.setItem("infinite-canvas:active-workspace", JSON.stringify(stale));
        localStorage.setItem("infinite-canvas:known-workspaces", JSON.stringify([stale]));
    });
    await page.goto("/canvas");
    await expect(page.getByRole("heading", { name: "登录无限画布" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Cached stranger workspace/ })).toHaveCount(0);
    await expect(page.locator(".app-loading-overlay")).toBeHidden();
    await page.screenshot({ path: info.outputPath("account-login.png") });
    await page.getByRole("button", { name: "去注册", exact: true }).click();
    await page.getByLabel("用户名", { exact: true }).fill(username);
    await page.getByLabel("密码", { exact: true }).fill(password);
    await page.getByLabel("工作邮箱", { exact: true }).fill(email);
    await page.getByRole("button", { name: "发送验证码", exact: true }).click();
    await page.getByLabel("邮箱验证码", { exact: true }).fill(verification.code);
    await page.getByRole("button", { name: "注册并创建工作区", exact: true }).click();
    const workspace = page.getByRole("button", { name: new RegExp(`^${username}的工作区`) });
    await expect(workspace).toBeVisible();
    await workspace.click();
    await expect(page.getByRole("button", { name: "新建画布", exact: true }).first()).toBeVisible();
    const before = await (await page.request.get("/api/auth/me")).json();
    expect(before.user.username).toBe(username);
    expect(before.user.email).toBe(email);
    expect(before.user.emailVerifiedAt).toBeTruthy();
    const smtpConfig = await page.request.get("/api/admin/registration");
    if (before.user.isAdmin) {
        expect(smtpConfig.status()).toBe(200);
        const saved = await smtpConfig.json();
        expect(saved.smtp.password).toBe("");
        expect(saved.codeTtlMinutes).toBe(10);
        expect((await page.request.put("/api/admin/registration", { data: { ...saved, maxAttempts: 0 } })).status()).toBe(400);
    } else {
        expect(smtpConfig.status()).toBe(403);
        expect((await page.request.put("/api/admin/registration", { data: {} })).status()).toBe(403);
    }
    expect((await page.request.post("/api/auth/logout")).status()).toBe(200);
    await page.reload();
    await expect(page.getByRole("heading", { name: "登录无限画布" })).toBeVisible();
    await page.getByLabel("用户名", { exact: true }).fill(username);
    await page.getByLabel("密码", { exact: true }).fill(password);
    await page.getByRole("button", { name: /^登\s*录$/ }).click();
    await expect(workspace).toBeVisible();
    await workspace.click();
    await expect(page.getByRole("button", { name: "新建画布", exact: true }).first()).toBeVisible();
    expect((await (await page.request.get("/api/auth/me")).json()).user.id).toBe(before.user.id);
    await page.locator("header").getByRole("button", { name: new RegExp(`当前工作区：${username}的工作区`) }).click();
    await page.getByRole("button", { name: "账号设置", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "账号设置" })).toBeVisible();
    await expect(page.getByText("TOPMAX 统一登录")).toBeVisible();
    await page.getByRole("button", { name: /^完\s*成$/ }).click();
    expect(errors).toEqual([]);
});
