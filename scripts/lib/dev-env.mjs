import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
export const localDir = resolve(root, ".local");

/** 定位某个子项目的工作目录，例如 web 或 canvas-agent。 */
export function projectDir(name) {
    const dir = resolve(root, name);
    if (!existsSync(dir)) throw new Error(`Missing project directory: ${name}`);
    return dir;
}

/** 创建本次运行独立的产物目录，避免不同调试运行互相覆盖。 */
export function timestampDir(prefix) {
    const dir = resolve(localDir, `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    mkdirSync(dir, { recursive: true });
    return dir;
}

/** 在本次运行目录下准备隔离的数据目录，避免回落到 .local/dev-data。 */
export function runDataDir(runDir) {
    const dir = resolve(runDir, "data");
    mkdirSync(dir, { recursive: true });
    return dir;
}
