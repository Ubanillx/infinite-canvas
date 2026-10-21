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
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
    await page.getByRole("button", { name: "新建画布", exact: true }).click();
    await expect(page).toHaveURL(/\/canvas\/[^/?]+$/);
    const url = page.url();
    await page.reload();
    await expect(page).toHaveURL(url);
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
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
    const write = await request.put("/api/data/canvas", { headers: first, data: { revision: 0, payload: { marker: "first" } } });
    expect(write.ok()).toBeTruthy();
    const own = await request.get("/api/data/canvas", { headers: first });
    expect((await own.json()).payload).toEqual({ marker: "first" });
    const other = await request.get("/api/data/canvas", { headers: second });
    expect((await other.json()).payload).toBeNull();
});
