import type { AgentTokenUsage } from "@/stores/use-agent-store";

export function contextTokenCount(input: number, cached: number, engine: string, reported?: number) {
    return typeof reported === "number" && Number.isFinite(reported) && reported >= 0 ? reported : engine === "pi" ? input + cached : input;
}

export function contextUsagePercent(usage: AgentTokenUsage | null) {
    return usage?.contextWindow ? Math.min(100, Math.round((usage.contextTokens / usage.contextWindow) * 100)) : null;
}
