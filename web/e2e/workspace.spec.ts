import { randomUUID } from "node:crypto";
import { test, expect } from "./fixtures";

test("create workspace and canvas, persist across reload", async ({ page }) => {
    await page.goto("/canvas");
    const newWorkspace = page.getByRole("button", { name: "新建工作区", exact: true });
    await expect(page.getByLabel("新工作区名称").or(newWorkspace)).toBeVisible();
    if (await newWorkspace.isVisible()) await newWorkspace.click();
    const name = `e2e-${randomUUID()}`;
    await page.getByLabel("新工作区名称").fill(name);
    await page.getByRole("button", { name: "创建工作区", exact: true }).click();
    // 工作区切换到下拉面板后，当前工作区由 aria-label「当前工作区：<名称>，点击切换」标识。
    const workspaceTrigger = page.getByRole("button", { name: `当前工作区：${name}，点击切换`, exact: true });
    await expect(workspaceTrigger).toBeVisible();
    await page.getByRole("button", { name: "新建画布", exact: true }).first().click();
    // 「新建画布」先打开弹窗；画布名称必填，确认后才创建并跳转。
    const createDialog = page.getByRole("dialog", { name: "新建画布" });
    await expect(createDialog).toBeVisible();
    // 标签文本含必填星号，用 textbox 的可访问名匹配更稳定。
    await createDialog.getByRole("textbox", { name: "* 画布名称", exact: true }).fill(`e2e-canvas-${randomUUID()}`);
    await createDialog.getByRole("button", { name: "新建画布", exact: true }).click();
    await expect(page).toHaveURL(/\/canvas\/[^/?]+$/);
    const url = page.url();
    await page.reload();
    await expect(page).toHaveURL(url);
    await expect(workspaceTrigger).toBeVisible();
});

test("workspace API isolates data and requires a selected workspace", async ({ request }) => {
    const makeWorkspace = async () => {
        const response = await request.post("/api/workspaces", { data: { name: `e2e-${randomUUID()}` } });
        expect(response.ok()).toBeTruthy();
        const { workspace } = await response.json();
        return { "x-infinite-canvas-workspace": workspace.id };
    };
    const first = await makeWorkspace();
    const second = await makeWorkspace();
    const denied = await request.get("/api/data/canvas");
    expect(denied.status()).toBe(403);
    const payload = { version: 0, state: { projects: [], folders: [], marker: "first" } };
    const write = await request.put("/api/data/canvas", { headers: first, data: { revision: 0, payload } });
    expect(write.ok()).toBeTruthy();
    const own = await request.get("/api/data/canvas", { headers: first });
    expect((await own.json()).payload).toEqual(payload);
    const other = await request.get("/api/data/canvas", { headers: second });
    expect((await other.json()).payload).toBeNull();
});
