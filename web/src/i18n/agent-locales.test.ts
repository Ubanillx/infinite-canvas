import { expect, test } from "bun:test";

import enUS from "./locales/en-US";
import zhCN from "./locales/zh-CN";

test("压缩上下文的进行中状态在中英文均有文案", () => {
    expect(zhCN.agent.composer.compactingContext).toBe("正在压缩上下文");
    expect(enUS.agent.composer.compactingContext).toBe("Compacting context");
});
