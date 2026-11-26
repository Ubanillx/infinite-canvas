import { expect, test } from "bun:test";

import enUS from "./locales/en-US";
import zhCN from "./locales/zh-CN";

test("压缩上下文的进行中状态在中英文均有文案", () => {
    expect(zhCN.agent.composer.compactingContext).toBe("正在压缩上下文");
    expect(enUS.agent.composer.compactingContext).toBe("Compacting context");
});

const STATUS_KEYS = [
    "common.mediaTooLarge",
    "prompts.saved",
    "prompts.exported",
    "canvas.templates.saved",
    "config.serverStorage.saved",
    "config.serverStorage.saving",
    "config.serverStorage.loadFailed",
    "config.serverStorage.saveFailed",
    "config.saved",
    "config.savedContinue",
    "config.imported",
    "config.webdav.connectionDescription",
    "config.webdav.connectionAutoSave",
    "config.webdav.autoSyncDescription",
];

function read(source: unknown, path: string) {
    return path.split(".").reduce<unknown>((value, part) => (value as Record<string, unknown>)?.[part], source);
}

test("保存类状态提示只说明状态，不带存储位置", () => {
    for (const key of STATUS_KEYS) {
        const zh = read(zhCN, key);
        const en = read(enUS, key);
        expect(typeof zh).toBe("string");
        expect(typeof en).toBe("string");
        expect(zh as string).not.toMatch(/服务器|工作区|本地/);
        expect(en as string).not.toMatch(/\bserver\b|\bworkspace\b|\blocal\b/i);
    }
});
