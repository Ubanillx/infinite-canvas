import { useState } from "react";
import { Button, Checkbox, Tooltip } from "antd";
import { FolderOpen, History, ListChecks, MessageSquare, RefreshCw, SquarePen, Trash2, Unplug } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import type { AgentThreadSummary } from "@/stores/use-agent-store";

export function AgentHistoryView({
    theme,
    threads,
    activeThreadId,
    workspacePath,
    loading,
    busy,
    connected,
    onRefresh,
    onNewThread,
    onResumeThread,
    onDeleteThreads,
}: {
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    threads: AgentThreadSummary[];
    activeThreadId: string;
    workspacePath: string;
    loading: boolean;
    busy: boolean;
    connected: boolean;
    onRefresh: () => void;
    onNewThread: () => void;
    onResumeThread: (threadId: string) => void;
    onDeleteThreads: (threadIds: string[]) => void;
}) {
    const { i18n, t } = useTranslation();
    const [selecting, setSelecting] = useState(false);
    const [selectedIds, setSelectedIds] = useState(() => new Set<string>());
    const selectedThreads = threads.filter((thread) => selectedIds.has(thread.id));
    const allSelected = Boolean(threads.length) && selectedThreads.length === threads.length;
    const canResume = connected && !loading && !busy;
    const newThreadHint = !connected ? t("agent.history.newThreadDisconnected") : loading ? t("agent.history.newThreadLoading") : busy ? t("agent.history.newThreadBusy") : t("agent.history.newThreadHint");
    const toggleThread = (threadId: string) => {
        setSelectedIds((current) => {
            const next = new Set(current);
            next.has(threadId) ? next.delete(threadId) : next.add(threadId);
            return next;
        });
    };
    return (
        <div className="flex min-h-0 flex-1 flex-col" style={{ color: theme.node.text }}>
            <header className="shrink-0 px-6 pb-5 pt-6">
                <div className="flex items-center justify-between gap-3">
                    <h2 className="!m-0 text-base font-medium tracking-tight">{t("agent.history.title")}</h2>
                    <Tooltip title={t(loading ? "agent.history.loading" : "agent.history.refresh")} trigger={["hover", "focus"]}>
                        <span className="inline-flex">
                            <Button type="text" className="!h-8 !w-8 !min-w-8" aria-label={t("agent.history.refresh")} disabled={!connected || loading} style={{ color: theme.node.muted }} icon={<RefreshCw className={`size-4 ${loading ? "motion-safe:animate-spin" : ""}`} strokeWidth={1.6} />} onClick={onRefresh} />
                        </span>
                    </Tooltip>
                </div>
                <Tooltip title={<span className="break-all">{workspacePath || t("agent.history.defaultWorkspace")}</span>} trigger={["hover", "focus"]} placement="bottomLeft">
                    <span tabIndex={0} className="mt-1.5 inline-flex max-w-full cursor-help items-center gap-1.5 rounded-sm text-xs leading-5 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2" style={{ color: theme.node.muted }} aria-label={`${t("agent.history.workspace")}: ${workspacePath || t("agent.history.defaultWorkspace")}`}>
                        <FolderOpen className="size-3.5 shrink-0" strokeWidth={1.6} />
                        <span className="truncate">{t("agent.history.workspaceScope")}</span>
                    </span>
                </Tooltip>
            </header>
            {threads.length ? (
                <>
                    <div className="mx-6 flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 border-t py-1 text-xs" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                        {selecting ? (
                            <Checkbox checked={allSelected} indeterminate={Boolean(selectedThreads.length) && !allSelected} disabled={loading || busy} aria-label={t("agent.history.selectAll")} onChange={() => setSelectedIds(allSelected ? new Set() : new Set(threads.map((thread) => thread.id)))}>
                                <span className="text-xs" style={{ color: theme.node.muted }}>{t("agent.history.selected", { count: selectedThreads.length })}</span>
                            </Checkbox>
                        ) : <span>{t("agent.history.count", { count: threads.length })}</span>}
                        <div className="ml-auto flex items-center gap-1">
                            {selectedThreads.length ? <Button size="small" danger type="text" className="!h-8 !px-2 !text-xs" icon={<Trash2 className="size-3.5" strokeWidth={1.6} />} disabled={loading || busy} onClick={() => onDeleteThreads(selectedThreads.map((thread) => thread.id))}>{t("agent.history.deleteCount", { count: selectedThreads.length })}</Button> : null}
                            <Button size="small" type="text" className="!h-8 !px-2 !text-xs" style={{ color: theme.node.muted }} icon={selecting ? undefined : <ListChecks className="size-3.5" strokeWidth={1.6} />} disabled={loading || busy} onClick={() => { setSelecting(!selecting); setSelectedIds(new Set()); }}>
                                {t(selecting ? "common.cancel" : "agent.history.select")}
                            </Button>
                        </div>
                    </div>
                    <ul className="thin-scrollbar !m-0 min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-4" aria-label={t("agent.history.title")} aria-busy={loading}>
                        {threads.map((thread) => {
                            const active = thread.id === activeThreadId;
                            const name = thread.name || thread.preview || t("agent.history.untitled");
                            const updatedAt = thread.updatedAt || thread.createdAt;
                            return (
                                <li key={thread.id} className="flex items-center rounded-lg transition-colors hover:bg-black/5 dark:hover:bg-white/10" style={{ backgroundColor: active ? theme.toolbar.activeBg : undefined }}>
                                    {selecting ? <Checkbox className="!ml-3" checked={selectedIds.has(thread.id)} disabled={loading || busy} aria-label={t("agent.history.selectThread", { name })} onChange={() => toggleThread(thread.id)} /> : null}
                                    <button type="button" className="flex min-w-0 flex-1 items-start gap-3 rounded-lg px-3 py-3 text-left focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 disabled:cursor-default disabled:opacity-60" disabled={!canResume} aria-current={active ? "true" : undefined} onClick={() => onResumeThread(thread.id)}>
                                        {!selecting ? <MessageSquare className="mt-0.5 size-4 shrink-0" strokeWidth={1.6} style={{ color: theme.node.muted }} /> : null}
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-3">
                                                <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-5" title={name}>{name}</span>
                                                {active ? <span className="shrink-0 text-[10px]" style={{ color: theme.node.muted }}>{t("agent.history.current")}</span> : null}
                                            </div>
                                            <div className="mt-1 flex items-center gap-3 text-[11px] leading-4" style={{ color: theme.node.muted }}>
                                                <span className="min-w-0 flex-1 truncate">{thread.name && thread.preview !== thread.name ? thread.preview : ""}</span>
                                                {updatedAt ? <time className="shrink-0 tabular-nums" dateTime={new Date(updatedAt * 1000).toISOString()} title={new Date(updatedAt * 1000).toLocaleString(i18n.language)}>{formatThreadTime(updatedAt, i18n.language)}</time> : null}
                                            </div>
                                        </div>
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                </>
            ) : (
                <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-6 pb-12 pt-[clamp(48px,12vh,120px)]">
                    <div className="mx-auto flex max-w-64 flex-col items-center text-center" role="status" aria-live="polite">
                        {loading ? <RefreshCw className="size-8 motion-safe:animate-spin" strokeWidth={1.3} style={{ color: theme.node.faint }} /> : connected ? <History className="size-8" strokeWidth={1.3} style={{ color: theme.node.faint }} /> : <Unplug className="size-8" strokeWidth={1.3} style={{ color: theme.node.faint }} />}
                        <h3 className="!mb-0 !mt-5 text-sm font-medium">{t(loading ? "agent.history.loading" : connected ? "agent.history.emptyTitle" : "agent.history.disconnectedTitle")}</h3>
                        <p className="!mb-0 !mt-2 text-xs leading-6" style={{ color: theme.node.muted }}>{t(loading ? "agent.history.loadingDescription" : connected ? "agent.history.emptyDescription" : "agent.history.connectHint")}</p>
                        {connected && !loading ? (
                            <Tooltip title={newThreadHint} trigger={["hover", "focus"]}>
                                <span className="mt-5 inline-flex rounded-md focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2" tabIndex={busy ? 0 : undefined} aria-label={busy ? newThreadHint : undefined}>
                                    <Button type="text" className="!h-9 !gap-2 !px-3 !text-xs" icon={<SquarePen className="size-3.5" strokeWidth={1.6} />} disabled={busy} onClick={onNewThread}>{t("agent.history.newThread")}</Button>
                                </span>
                            </Tooltip>
                        ) : null}
                    </div>
                </div>
            )}
        </div>
    );
}

function formatThreadTime(value: number | undefined, locale: string) {
    if (!value) return "";
    return new Date(value * 1000).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
