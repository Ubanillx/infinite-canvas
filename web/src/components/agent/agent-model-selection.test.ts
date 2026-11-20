import { expect, test } from "bun:test";

import { selectAgentModel } from "./agent-model-selection";

const models = [{ model: "model-a" }, { model: "model-b" }];

test("刷新模型列表时保留当前会话的手动选择", () => {
    expect(selectAgentModel(models, "model-a", "model-b", false)).toBe("model-b");
});

test("新连接时优先采用用户设置的默认模型", () => {
    expect(selectAgentModel(models, "model-a", "model-b", true)).toBe("model-a");
});

test("当前选择已不可用时回退到默认模型", () => {
    expect(selectAgentModel(models, "model-a", "removed-model", false)).toBe("model-a");
});
