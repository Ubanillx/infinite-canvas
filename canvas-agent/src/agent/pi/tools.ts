import { Type } from "typebox";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { CanvasSession } from "../../canvas/session.js";
import { toolDescriptions, toolInputSchemas, toolNames } from "../../canvas/schemas.js";
import { logger } from "../../utils/logger.js";
import { errorMessage } from "../../utils/value.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const schemaCache = new Map<string, Record<string, unknown>>();

/** 把画布工具的 zod 入参转成 pi 需要的纯 JSON Schema。 */
export function piToolSchema(name: (typeof toolNames)[number]) {
    const cached = schemaCache.get(name);
    if (cached) return cached;
    const json = zodToJsonSchema(toolInputSchemas[name], { target: "jsonSchema7", $refStrategy: "none" }) as Record<string, unknown>;
    delete json.$schema;
    schemaCache.set(name, json);
    return json;
}

/**
 * 把现有 34 个画布工具平移到 pi：同一份 zod 入参、同一份描述，
 * execute 直接复用 CanvasSession.callTool，因此浏览器侧确认、超时和多标签页归属全部继承。
 */
export function buildPiTools(session: CanvasSession): AgentTool[] {
    return toolNames.map((name) => ({
        name,
        label: toolLabel(name),
        description: toolDescriptions[name],
        parameters: Type.Unsafe(piToolSchema(name)),
        execute: async (_toolCallId, params) => {
            logger.debug("Pi tool called", { name });
            try {
                const result = await session.callTool(name, params);
                return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: { name } };
            } catch (error) {
                const message = errorMessage(error);
                logger.warn("Pi tool failed", { name, message });
                return { content: [{ type: "text" as const, text: message }], details: { name }, isError: true };
            }
        },
    }));
}

/** 取工具描述首句作为面板展示用的短标签。 */
function toolLabel(name: (typeof toolNames)[number]) {
    return toolDescriptions[name].split(/[。.]/)[0].slice(0, 40) || name;
}
