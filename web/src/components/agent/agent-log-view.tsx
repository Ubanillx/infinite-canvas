import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Tooltip } from "antd";
import copyToClipboard from "copy-to-clipboard";
import { CheckCircle2, ChevronDown, CircleAlert, CircleDot, Copy, FileText, Search, Trash2, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { canvasThemes } from "@/lib/canvas-theme";
import type { AgentEventLog } from "@/stores/use-agent-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { formatLogJson, formatLogText, type AgentLogContext } from "./agent-event-formatters";
import { AgentScrollToBottom } from "./agent-scroll-to-bottom";

type LogFilter = "all" | "error" | "warning" | "info";
type DisplayLog = AgentEventLog & { count: number; detail: string; displayText: string; level: Exclude<LogFilter, "all">; signature: string; success: boolean };
const SCROLL_BOTTOM_THRESHOLD = 48;

export function AgentLogView({
    logs,
    theme,
    context,
    onClear,
    onCopied,
    onCopyBlocked,
}: {
    logs: AgentEventLog[];
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    context: AgentLogContext;
    onClear: () => void;
    onCopied: (text: string) => void;
    onCopyBlocked: (text: string) => void;
}) {
    const { t } = useTranslation();
    const [mode, setMode] = useState<"text" | "json">("text");
    const [filter, setFilter] = useState<LogFilter>("all");
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const followLogsRef = useRef(true);
    const [showScrollToBottom, setShowScrollToBottom] = useState(false);
    const [newLogCount, setNewLogCount] = useState(0);
    const content = mode === "text" ? formatLogText(logs, context) : formatLogJson(logs, context);
    const displayLogs = useMemo(() => prepareLogs(logs), [logs]);
    const counts = useMemo(
        () => ({
            all: displayLogs.reduce((sum, item) => sum + item.count, 0),
            error: displayLogs.filter((item) => item.level === "error").reduce((sum, item) => sum + item.count, 0),
            warning: displayLogs.filter((item) => item.level === "warning").reduce((sum, item) => sum + item.count, 0),
            info: displayLogs.filter((item) => item.level === "info").reduce((sum, item) => sum + item.count, 0),
        }),
        [displayLogs],
    );
    const visibleLogs = filter === "all" ? displayLogs : displayLogs.filter((item) => item.level === filter);
    const visibleLogCount = visibleLogs.reduce((sum, item) => sum + item.count, 0);
    const previousVisibleCountRef = useRef(visibleLogCount);
    const lastError = [...logs].reverse().find((item) => logLevel(item) === "error");
    const updateScrollState = useCallback(() => {
        const list = listRef.current;
        if (!list) return;
        const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight <= SCROLL_BOTTOM_THRESHOLD;
        followLogsRef.current = atBottom;
        setShowScrollToBottom(!atBottom);
        if (atBottom) setNewLogCount(0);
    }, []);
    const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
        const list = listRef.current;
        if (!list) return;
        followLogsRef.current = true;
        list.scrollTo({ top: list.scrollHeight, behavior });
        setShowScrollToBottom(false);
        setNewLogCount(0);
    }, []);
    const handleLastLogToggle = useCallback((open: boolean) => {
        if (!open) {
            requestAnimationFrame(updateScrollState);
            return;
        }
        if (!followLogsRef.current) return;
        requestAnimationFrame(() => requestAnimationFrame(() => scrollToBottom("auto")));
    }, [scrollToBottom, updateScrollState]);
    useEffect(() => {
        if (mode !== "text") return;
        const frame = requestAnimationFrame(() => scrollToBottom("auto"));
        return () => cancelAnimationFrame(frame);
    }, [filter, mode, scrollToBottom]);
    useEffect(() => {
        const previousCount = previousVisibleCountRef.current;
        const addedCount = Math.max(0, visibleLogCount - previousCount);
        previousVisibleCountRef.current = visibleLogCount;
        if (mode !== "text") return;
        if (visibleLogCount < previousCount) setNewLogCount(0);
        const frame = requestAnimationFrame(() => {
            if (followLogsRef.current) scrollToBottom("auto");
            else {
                if (addedCount) setNewLogCount((count) => count + addedCount);
                updateScrollState();
            }
        });
        return () => cancelAnimationFrame(frame);
    }, [mode, scrollToBottom, updateScrollState, visibleLogCount]);
    const copy = async (value = content, tip = t("agent.logs.copied")) => {
        if (await copyToClipboard(value)) {
            onCopied(tip);
            return;
        }
        textareaRef.current?.focus();
        textareaRef.current?.select();
        onCopyBlocked(t(mode === "json" ? "agent.logs.selectedManual" : "agent.logs.copyFailed"));
    };
    const connectionLabel = t(context.connected ? "agent.events.online" : context.enabled ? "agent.events.connecting" : "agent.events.disabled");
    return (
        <div className="flex min-h-0 flex-1 flex-col" style={{ color: theme.node.text }}>
            <header className="shrink-0 px-6 pb-5 pt-6">
                <div className="flex items-center justify-between gap-3">
                    <h2 className="!m-0 text-base font-medium tracking-tight">{t("agent.logs.title")}</h2>
                    <LogActions logs={logs} lastError={lastError} onClear={onClear} onCopy={(value, tip) => void copy(value, tip)} context={context} />
                </div>
                <p className="!mb-0 !mt-1.5 text-xs leading-5" style={{ color: theme.node.muted }}>{t("agent.logs.description")}</p>
            </header>
            <div className="mx-6 shrink-0 border-t" style={{ borderColor: theme.node.stroke }}>
                <details className="group py-3 text-xs" style={{ color: theme.node.muted }}>
                    <summary className="!flex cursor-pointer list-none items-center gap-2 rounded-sm leading-5 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 [&::-webkit-details-marker]:hidden">
                        <span className={`size-1.5 shrink-0 rounded-full ${context.connected ? "bg-emerald-500" : context.enabled ? "bg-amber-500" : "bg-current opacity-40"}`} />
                        <span className="shrink-0">{connectionLabel}</span>
                        <span className="min-w-0 flex-1 truncate" title={context.activity}>{context.activity}</span>
                        <ChevronDown className="size-3.5 shrink-0 transition-transform group-open:rotate-180" strokeWidth={1.6} />
                    </summary>
                    <div className="mt-3 space-y-1.5 pl-3.5 text-[11px] leading-5">
                        <div className="break-all font-mono">{context.endpoint}</div>
                        <div>{t("agent.logs.messages", { count: context.messages })}</div>
                        <div className="break-words">{context.pendingTool ? t("agent.logs.tool", { tool: context.pendingTool }) : t("agent.logs.noPendingTool")}</div>
                    </div>
                </details>
                <div className="flex items-center gap-4 border-b" style={{ borderColor: theme.node.stroke }} role="group" aria-label={t("agent.logs.displayMode")}>
                    {(["text", "json"] as const).map((value) => (
                        <button key={value} type="button" aria-pressed={mode === value} className="relative h-9 text-xs focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-2" style={{ color: mode === value ? theme.node.text : theme.node.muted }} onClick={() => setMode(value)}>
                            {t(value === "text" ? "agent.logs.diagnostics" : "agent.logs.rawJson")}
                            {mode === value ? <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-px bg-current" /> : null}
                        </button>
                    ))}
                </div>
            </div>
            {mode === "text" ? (
                <>
                    <div className="mx-6 flex shrink-0 flex-wrap items-center gap-1 py-3" role="group" aria-label={t("agent.logs.filter")}>
                        {(["all", "error", "warning", "info"] as const).map((value) => (
                            <button key={value} type="button" aria-pressed={filter === value} className="h-8 rounded-md px-2 text-[11px] tabular-nums transition-colors hover:bg-black/5 focus-visible:outline focus-visible:outline-1 dark:hover:bg-white/10" style={{ backgroundColor: filter === value ? theme.toolbar.activeBg : undefined, color: filter === value ? theme.node.text : theme.node.muted }} onClick={() => setFilter(value)}>
                                {t(`agent.logs.${value === "error" ? "errors" : value === "warning" ? "warnings" : value}`, { count: counts[value] })}
                            </button>
                        ))}
                    </div>
                    <div className="relative min-h-0 flex-1">
                        <div ref={listRef} tabIndex={0} aria-label={t("agent.logs.list")} className="thin-scrollbar h-full space-y-1 overflow-y-auto px-3 pb-4 focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1" onScroll={updateScrollState}>
                            {visibleLogs.map((item, index) => <LogRow key={item.id} item={item} theme={theme} onToggle={index === visibleLogs.length - 1 ? handleLastLogToggle : undefined} />)}
                            {!visibleLogs.length ? (
                                <div className="mx-auto flex max-w-64 flex-col items-center px-3 pt-[clamp(48px,12vh,120px)] text-center" role="status">
                                    {logs.length ? <Search className="size-8" strokeWidth={1.3} style={{ color: theme.node.faint }} /> : <FileText className="size-8" strokeWidth={1.3} style={{ color: theme.node.faint }} />}
                                    <div className="mt-5 text-sm font-medium">{t(logs.length ? "agent.logs.noFiltered" : "agent.logs.empty")}</div>
                                    <div className="mt-2 text-xs leading-6" style={{ color: theme.node.muted }}>{t(logs.length ? "agent.logs.filterHint" : "agent.logs.emptyHint")}</div>
                                </div>
                            ) : null}
                        </div>
                        {showScrollToBottom ? <AgentScrollToBottom theme={theme} title={newLogCount ? t("agent.logs.new", { count: newLogCount }) : t("agent.logs.latest")} ariaLabel={newLogCount ? t("agent.logs.newLabel", { count: newLogCount }) : t("agent.logs.latest")} onClick={() => scrollToBottom()} /> : null}
                    </div>
                </>
            ) : (
                <div className="flex min-h-0 flex-1 flex-col px-6 pb-4">
                    <div className="py-3 text-[11px]" style={{ color: theme.node.muted }}>{t("agent.logs.fullData", { count: logs.length })}</div>
                    <textarea ref={textareaRef} aria-label={t("agent.logs.rawJson")} readOnly value={content} className="thin-scrollbar min-h-0 flex-1 resize-none rounded-md border bg-transparent p-3 font-mono text-[11px] leading-5 focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1" style={{ borderColor: theme.node.stroke, color: theme.node.text }} onFocus={(event) => event.currentTarget.select()} />
                </div>
            )}
        </div>
    );
}

function LogActions({ logs, lastError, context, onClear, onCopy }: { logs: AgentEventLog[]; lastError?: AgentEventLog; context: AgentLogContext; onClear: () => void; onCopy: (value?: string, tip?: string) => void }) {
    const { t } = useTranslation();
    return (
        <div className="flex shrink-0 items-center gap-0.5">
            <Tooltip title={t("agent.logs.copyAll")} trigger={["hover", "focus"]}>
                <Button type="text" className="!h-8 !w-8 !min-w-8" aria-label={t("agent.logs.copyAll")} icon={<Copy className="size-4" strokeWidth={1.6} />} onClick={() => onCopy()} />
            </Tooltip>
            <Tooltip title={t("agent.logs.copyLastError")} trigger={["hover", "focus"]}>
                <Button type="text" className="!h-8 !w-8 !min-w-8" aria-label={t("agent.logs.copyLastError")} disabled={!lastError} icon={<CircleAlert className="size-4" strokeWidth={1.6} />} onClick={() => lastError && onCopy(formatLogText([lastError], context), t("agent.logs.lastErrorCopied"))} />
            </Tooltip>
            <Tooltip title={t("agent.logs.clear")} trigger={["hover", "focus"]}>
                <Button danger type="text" className="!h-8 !w-8 !min-w-8" aria-label={t("agent.logs.clear")} disabled={!logs.length} icon={<Trash2 className="size-4" strokeWidth={1.6} />} onClick={onClear} />
            </Tooltip>
        </div>
    );
}

function LogRow({ item, theme, onToggle }: { item: DisplayLog; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onToggle?: (open: boolean) => void }) {
    const { t } = useTranslation();
    const tone = item.level === "error" ? "text-red-600 dark:text-red-400" : item.level === "warning" ? "text-amber-600 dark:text-amber-400" : item.success ? "text-emerald-600 dark:text-emerald-400" : "";
    const Icon = item.level === "error" ? CircleAlert : item.level === "warning" ? TriangleAlert : item.success ? CheckCircle2 : CircleDot;
    return (
        <details className="group" onToggle={(event) => onToggle?.(event.currentTarget.open)}>
            <summary className="cursor-pointer list-none rounded-lg px-3 py-3 transition-colors hover:bg-black/5 focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 dark:hover:bg-white/10 [&::-webkit-details-marker]:hidden">
                <div className="flex items-start gap-3">
                    <Icon className={`mt-0.5 size-4 shrink-0 ${tone}`} strokeWidth={1.6} style={tone ? undefined : { color: theme.node.muted }} />
                    <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                            <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-5" title={item.title}>{item.title}</span>
                            {item.count > 1 ? (
                                <span className="shrink-0 text-[10px] leading-4" style={{ color: theme.node.muted }}>
                                    {t("agent.logs.repeated", { count: item.count })}
                                </span>
                            ) : null}
                        </div>
                        {item.displayText !== item.title ? (
                            <div className="line-clamp-2 whitespace-pre-wrap break-words text-xs leading-5" style={{ color: theme.node.muted }}>
                                {item.displayText}
                            </div>
                        ) : null}
                        <div className="mt-1 text-[10px] leading-4 tabular-nums" style={{ color: theme.node.muted }}>{item.time}</div>
                    </div>
                    <ChevronDown className="mt-1 size-3.5 shrink-0 transition-transform group-open:rotate-180" strokeWidth={1.6} style={{ color: theme.node.muted }} />
                </div>
            </summary>
            <div className="pb-3 pl-10 pr-3">
                <div className="mb-1 text-[10px] font-medium" style={{ color: theme.node.faint }}>
                    {t("agent.logs.details")}
                </div>
                <pre className="thin-scrollbar max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border p-2.5 font-mono text-[11px] leading-5" style={{ borderColor: theme.node.stroke, background: theme.node.panel, color: theme.node.text }}>
                    {item.detail}
                </pre>
            </div>
        </details>
    );
}

function prepareLogs(logs: AgentEventLog[]) {
    return logs.flatMap(expandLog).reduce<DisplayLog[]>((result, item) => {
        const previous = result.at(-1);
        if (previous && previous.signature === item.signature) {
            previous.count += 1;
            previous.time = item.time;
            previous.detail = item.detail;
            return result;
        }
        result.push(item);
        return result;
    }, []);
}

function expandLog(item: AgentEventLog): DisplayLog[] {
    const entries = parseJsonEntries(item.raw ?? item.text);
    return (entries.length ? entries : [undefined]).map((entry, index) => {
        const displayText = compactLogText(entry === undefined ? item.text : logSummary(entry)) || item.title;
        const level = logLevel(item, entry);
        const title = entry === undefined ? item.title : logTitle(item.title, entry);
        return {
            ...item,
            id: entries.length > 1 ? `${item.id}-${index}` : item.id,
            time: logTime(item.time, entry),
            title,
            text: displayText,
            raw: entry ?? item.raw,
            count: 1,
            detail: entry === undefined ? stripAnsi(safeString(item.raw ?? item.text)) || item.text : safeJson(entry),
            displayText,
            level,
            signature: `${level}\n${title}\n${logSignature(displayText)}`,
            success: level === "info" && /完成|成功|已连接|已就绪|收到回复/.test(`${title}\n${displayText}`),
        };
    });
}

function logLevel(item: AgentEventLog, entry?: unknown): DisplayLog["level"] {
    const entries = entry === undefined ? parseJsonEntries(item.raw ?? item.text) : [entry];
    const structured = entries.find((value) => value && typeof value === "object" && !Array.isArray(value)) as Record<string, unknown> | undefined;
    if (structured?.type === "mcp.startup") {
        if (structured.status === "failed") return "error";
        if (structured.status === "cancelled") return "warning";
        return "info";
    }
    const declared = entries.map(declaredLogLevel).filter(Boolean);
    if (declared.includes("error")) return "error";
    if (declared.includes("warning")) return "warning";
    if (declared.includes("info")) return "info";
    const text = `${item.title}\n${item.text}\n${safeString(item.raw)}`;
    if (/错误|失败|异常|中断|断开|拒绝|\berror\b|\bfailed\b|\bfatal\b|exception/i.test(text)) return "error";
    if (/警告|重试|未找到|不可用|\bwarn(?:ing)?\b|deprecated|missing|unavailable/i.test(text)) return "warning";
    return "info";
}

function declaredLogLevel(value: unknown): DisplayLog["level"] | "" {
    if (!value || typeof value !== "object" || Array.isArray(value)) return "";
    const level = String((value as Record<string, unknown>).level || "").toLowerCase();
    if (["error", "fatal"].includes(level)) return "error";
    if (["warn", "warning"].includes(level)) return "warning";
    if (["info", "debug", "trace"].includes(level)) return "info";
    return "";
}

function logTitle(fallback: string, value: unknown) {
    if (fallback !== "日志" && fallback !== "Log" || !value || typeof value !== "object" || Array.isArray(value)) return fallback;
    const target = String((value as Record<string, unknown>).target || "").toLowerCase();
    if (target.includes("skill")) return i18n.t("agent.logs.skillLoading");
    if (target.includes("plugin")) return i18n.t("agent.logs.plugin");
    if (target.includes("mcp") || target.includes("rmcp")) return "MCP";
    if (target.includes("shell")) return i18n.t("agent.logs.terminal");
    if (target.includes("state_db")) return i18n.t("agent.logs.conversationStorage");
    return i18n.t(useAgentStore.getState().engine === "pi" ? "agent.panel.enginePi" : "agent.panel.engineCodex");
}

function logTime(fallback: string, value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
    const timestamp = (value as Record<string, unknown>).timestamp;
    if (typeof timestamp !== "string") return fallback;
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? fallback : date.toLocaleTimeString();
}

function parseJsonEntries(value: unknown): unknown[] {
    if (value && typeof value === "object") return [value];
    if (typeof value !== "string") return [];
    const text = stripAnsi(value).trim();
    if (!text) return [];
    try {
        return [JSON.parse(text)];
    } catch {
        const entries: unknown[] = [];
        let start = -1;
        let depth = 0;
        let quoted = false;
        let escaped = false;
        for (let index = 0; index < text.length; index += 1) {
            const character = text[index];
            if (start < 0) {
                if (character !== "{" && character !== "[") continue;
                start = index;
                depth = 1;
                continue;
            }
            if (quoted) {
                if (escaped) escaped = false;
                else if (character === "\\") escaped = true;
                else if (character === '"') quoted = false;
                continue;
            }
            if (character === '"') quoted = true;
            else if (character === "{" || character === "[") depth += 1;
            else if (character === "}" || character === "]") depth -= 1;
            if (depth !== 0) continue;
            try {
                entries.push(JSON.parse(text.slice(start, index + 1)));
            } catch {
                // Ignore non-JSON fragments and continue scanning the stderr chunk.
            }
            start = -1;
        }
        return entries;
    }
}

function logSummary(value: unknown): string {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(logSummary).filter(Boolean).slice(0, 3).join(" · ");
    if (!value || typeof value !== "object") return String(value ?? "");
    const record = value as Record<string, unknown>;
    const fields = record.fields && typeof record.fields === "object" && !Array.isArray(record.fields) ? (record.fields as Record<string, unknown>) : null;
    if (fields) {
        for (const key of ["message", "msg", "reason", "summary", "text", "error"]) {
            if (fields[key] === undefined) continue;
            const summary = logSummary(fields[key]);
            if (summary) return summary;
        }
    }
    for (const key of ["message", "msg", "reason", "summary", "text", "error"]) {
        if (record[key] === undefined) continue;
        const summary = logSummary(record[key]);
        if (summary) return summary;
    }
    return [record.method, record.type, record.tool, record.path, record.url].filter((item) => typeof item === "string" && item).join(" · ") || safeJson(value);
}

function compactLogText(value: string) {
    return stripAnsi(value).replace(/\s+/g, " ").trim();
}

function logSignature(value: string) {
    return value
        .replace(/[a-z]:\\[^\r\n]*?skill\.md/gi, "<SKILL.md>")
        .replace(/file:\/\/\/[^\s"']+/gi, "<路径>")
        .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<ID>");
}

function stripAnsi(value: string) {
    return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function safeString(value: unknown) {
    if (typeof value === "string") return value;
    if (value === undefined || value === null) return "";
    return safeJson(value);
}

function safeJson(value: unknown) {
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}
