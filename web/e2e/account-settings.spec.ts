import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { Pool } from "pg";

import { expect, test } from "./auth";

async function enterWorkspace(page: Page) {
    const session = await (await page.request.get("/api/auth/me")).json();
    const name = session.workspaces[0].name;
    await page.goto("/canvas");
    await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
    await expect(page.getByRole("button", { name: "新建画布", exact: true }).first()).toBeVisible();
    return session;
}

function linkedSession(session: Awaited<ReturnType<typeof enterWorkspace>>, localLogin = true, hasPassword = true) {
    return {
        ...session,
        user: { ...session.user, hasPassword },
        identities: [{ provider: "keycloak", email: session.user.email, displayName: session.user.displayName, createdAt: new Date().toISOString(), lastLoginAt: new Date().toISOString() }],
        keycloak: { enabled: true, localLogin },
    };
}

test("account settings unlinks a linked TOPMAX identity", async ({ page }, info) => {
    const session = await enterWorkspace(page);
    let linked = true;
    await page.route("**/api/auth/me", (route) => route.fulfill({ json: linked ? linkedSession(session) : { ...linkedSession(session), identities: [] } }));
    await page.route("**/api/auth/identities/keycloak/unbind", (route) => {
        linked = false;
        return route.fulfill({ json: { ok: true } });
    });
    await page.locator("header").getByRole("button", { name: /当前工作区：/ }).click();
    await page.getByRole("button", { name: "账号设置", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "账号设置" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("已绑定")).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: info.outputPath("account-settings-linked.png") });
    await dialog.getByRole("button", { name: "解除绑定" }).click();
    const confirm = page.getByRole("dialog", { name: "解除 TOPMAX 绑定？" });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "解除绑定" }).click();
    await expect(page.getByText("TOPMAX 绑定已解除")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "绑定账号" })).toBeVisible();
    await dialog.getByRole("button", { name: "绑定账号" }).click();
    const bindConfirm = page.getByRole("dialog", { name: "绑定 TOPMAX 账号" });
    await expect(bindConfirm).toBeVisible();
    await expect(bindConfirm.getByText("TOPMAX 邮箱需要与当前账户已验证邮箱一致")).toBeVisible();
    await bindConfirm.getByRole("button", { name: /^取\s*消$/ }).click();
    await expect(bindConfirm).toBeHidden();
    await page.waitForTimeout(300);
    await page.screenshot({ path: info.outputPath("account-settings-unlinked.png") });
});

test("account settings unlinks a real identity through the API", async ({ page }) => {
    const session = await enterWorkspace(page);
    const database = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
        await database.query("INSERT INTO user_identities (provider, subject, user_id, created_at, email, display_name, last_login_at) VALUES ('keycloak',$1,$2,now(),$3,$4,now())", [`e2e-${randomUUID()}`, session.user.id, session.user.email, session.user.displayName]);
    } finally {
        await database.end();
    }
    await page.locator("header").getByRole("button", { name: /当前工作区：/ }).click();
    await page.getByRole("button", { name: "账号设置", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "账号设置" });
    await expect(dialog.getByText("已绑定")).toBeVisible();
    await dialog.getByRole("button", { name: "解除绑定" }).click();
    const confirm = page.getByRole("dialog", { name: "解除 TOPMAX 绑定？" });
    await confirm.getByRole("button", { name: "解除绑定" }).click();
    await expect(page.getByText("TOPMAX 绑定已解除")).toBeVisible();
    await expect(dialog.getByText("已绑定")).toHaveCount(0);
    expect((await (await page.request.get("/api/auth/me")).json()).identities).toHaveLength(0);
});

test("account settings explains why an SSO-only account cannot unlink", async ({ page }, info) => {
    const session = await enterWorkspace(page);
    await page.route("**/api/auth/me", (route) => route.fulfill({ json: linkedSession(session, false, false) }));
    await page.locator("header").getByRole("button", { name: /当前工作区：/ }).click();
    await page.getByRole("button", { name: "账号设置", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "账号设置" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/当前仅允许 TOPMAX 登录，不能解除绑定/)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "解除绑定" })).toBeDisabled();
    await page.waitForTimeout(300);
    await page.screenshot({ path: info.outputPath("account-settings-sso-only.png") });
});
