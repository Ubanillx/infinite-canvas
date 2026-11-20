import { expect, test } from "bun:test";

import { contextTokenCount, contextUsagePercent } from "./agent-usage";

test("Pi 的上下文 token 数包含单独统计的缓存输入", () => {
    expect(contextTokenCount(1200, 2800, "pi")).toBe(4000);
});

test("Codex 保留服务端提供的上下文 token 数", () => {
    expect(contextTokenCount(1200, 2800, "codex", 4000)).toBe(4000);
});

test("Pi 上下文占比包含缓存读取 token", () => {
    expect(contextUsagePercent({ input: 1200, cached: 2800, output: 200, contextTokens: 4000, contextWindow: 10000 })).toBe(40);
});

test("没有上下文窗口大小时不估算占比", () => {
    expect(contextUsagePercent({ input: 1200, cached: 2800, output: 200, contextTokens: 4000 })).toBeNull();
});
