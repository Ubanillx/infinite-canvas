import { App, Button, Select, Switch, Tag } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { PromptSourceEditorDrawer } from "./prompt-source-editor-drawer";
import { PromptSourceContentModal } from "./prompt-source-content-modal";
import { fetchPromptSourceStatuses, refreshAllSources, refreshSource } from "@/services/api/prompts";
import { PROMPT_SOURCE_INTERVALS, usePromptSourceStore } from "@/stores/use-prompt-source-store";
import type { PromptSource } from "@/services/api/prompt-source-presets";

const STATUS_QUERY_KEY = ["prompt-source-statuses"];

export function ConfigPromptSources() {
    const { message, modal } = App.useApp();
    const { i18n, t } = useTranslation();
    const queryClient = useQueryClient();
    const sources = usePromptSourceStore((state) => state.sources);
    const schedule = usePromptSourceStore((state) => state.schedule);
    const addSource = usePromptSourceStore((state) => state.addSource);
    const saveSource = usePromptSourceStore((state) => state.saveSource);
    const removeSource = usePromptSourceStore((state) => state.removeSource);
    const toggleSource = usePromptSourceStore((state) => state.toggleSource);
    const updateSchedule = usePromptSourceStore((state) => state.updateSchedule);
    const statusQuery = useQuery({ queryKey: STATUS_QUERY_KEY, queryFn: fetchPromptSourceStatuses });

    const [editingSource, setEditingSource] = useState<PromptSource | null>(null);
    const [viewingId, setViewingId] = useState("");
    const [refreshingId, setRefreshingId] = useState("");
    const [refreshingAll, setRefreshingAll] = useState(false);
    const viewingSource = sources.find((item) => item.id === viewingId) || null;
    const intervalOptions = PROMPT_SOURCE_INTERVALS.map((value) => ({ value, label: t(`config.promptSources.intervals.${intervalKey(value)}`) }));

    const invalidatePrompts = async () => {
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: ["prompts"] }),
            queryClient.invalidateQueries({ queryKey: ["side-panel-prompts"] }),
            queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY }),
        ]);
    };

    const handleSave = (source: PromptSource) => {
        saveSource(source);
        void invalidatePrompts();
    };

    const handleDelete = (source: PromptSource) => {
        modal.confirm({
            title: t("config.promptSources.deleteTitle", { name: source.name }),
            content: t("config.promptSources.deleteDescription"),
            okText: t("common.delete"),
            okButtonProps: { danger: true },
            cancelText: t("common.cancel"),
            onOk: async () => {
                removeSource(source.id);
                await invalidatePrompts();
            },
        });
    };

    const handleRefreshOne = async (source: PromptSource) => {
        setRefreshingId(source.id);
        try {
            const result = await refreshSource(source.id);
            await invalidatePrompts();
            message.success(t("config.promptSources.refreshed", { name: source.name, count: result.count }));
        } catch (error) {
            await queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY });
            message.error(error instanceof Error ? error.message : t("config.promptSources.refreshFailedCached"));
        } finally {
            setRefreshingId("");
        }
    };

    const handleRefreshAll = async () => {
        setRefreshingAll(true);
        try {
            const result = await refreshAllSources();
            updateSchedule("lastFetchedAt", new Date().toISOString());
            await invalidatePrompts();
            if (result.failureCount) message.warning(t("config.promptSources.refreshPartial", { success: result.successCount, failed: result.failureCount }));
            else message.success(t("config.promptSources.refreshAllSuccess", { sources: result.successCount, total: result.total }));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("config.promptSources.refreshFailed"));
        } finally {
            setRefreshingAll(false);
        }
    };

    return (
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_260px]">
            <section className="min-w-0 overflow-hidden rounded-xl border border-stone-200 dark:border-stone-800">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-200 px-5 py-4 dark:border-stone-800">
                    <div>
                        <h2 className="text-sm font-semibold">{t("config.promptSources.listTitle")}</h2>
                        <p className="mt-1 text-xs text-stone-500">{t("config.promptSources.sourceCount", { count: sources.length })}</p>
                    </div>
                    <Button type="primary" icon={<Plus className="size-4" />} onClick={() => setEditingSource(addSource())}>
                        {t("config.promptSources.add")}
                    </Button>
                </div>
                {sources.length === 0 ? <div className="px-5 py-12 text-center text-sm text-stone-500">{t("config.promptSources.empty")}</div> : null}
                <div className="divide-y divide-stone-200 dark:divide-stone-800">
                    {sources.map((source) => {
                        const status = statusQuery.data?.[source.id];
                        return (
                            <div key={source.id} className="px-5 py-4">
                            <div className="flex items-start justify-between gap-4">
                                <div className="min-w-0">
                                    <div className="flex min-w-0 items-center gap-2">
                                        <span className="truncate text-sm font-semibold">{source.name}</span>
                                        {source.builtIn ? <Tag className="m-0 shrink-0 text-[10px]">{t("config.promptSources.builtIn")}</Tag> : null}
                                    </div>
                                    <a className="mt-1 block max-w-full truncate text-xs text-stone-500 hover:underline" href={source.homepage || source.url} target="_blank" rel="noreferrer">
                                        {source.homepage || source.url}
                                    </a>
                                </div>
                                <Switch size="small" checked={source.enabled} aria-label={t("config.promptSources.toggle", { name: source.name })} onChange={(checked) => { toggleSource(source.id, checked); void invalidatePrompts(); }} />
                            </div>
                            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone-500">
                                <span className="tabular-nums">{t("config.promptSources.itemCount", { count: status?.count ?? 0 })}</span>
                                {status?.lastError ? <Tag color="error" className="m-0 text-[10px]" title={status.lastError}>{t("config.promptSources.failed")}</Tag> : status?.lastSuccessAt ? <Tag color="success" className="m-0 text-[10px]">{t("config.promptSources.healthy")}</Tag> : <Tag className="m-0 text-[10px]">{t("config.promptSources.unsynced")}</Tag>}
                                <span>{status?.lastSuccessAt ? t("config.promptSources.lastSuccess", { time: formatTime(status.lastSuccessAt, i18n.resolvedLanguage) }) : t("config.promptSources.neverFetched")}</span>
                            </div>
                            <div className="mt-3 flex flex-wrap gap-1 border-t border-stone-100 pt-3 dark:border-stone-800">
                                <Button type="text" size="small" icon={<Eye className="size-3.5" />} onClick={() => setViewingId(source.id)}>
                                    {t("config.promptSources.view")}
                                </Button>
                                <Button type="text" size="small" icon={<RefreshCw className="size-3.5" />} loading={refreshingId === source.id} onClick={() => void handleRefreshOne(source)}>
                                    {t("config.promptSources.refresh")}
                                </Button>
                                {!source.builtIn ? <Button type="text" size="small" icon={<Pencil className="size-3.5" />} onClick={() => setEditingSource(source)}>{t("config.promptSources.edit")}</Button> : null}
                                {!source.builtIn ? <Button type="text" size="small" danger icon={<Trash2 className="size-3.5" />} onClick={() => handleDelete(source)}>{t("common.delete")}</Button> : null}
                            </div>
                            </div>
                        );
                    })}
                </div>
            </section>

            <section className="rounded-xl border border-stone-200 p-5 dark:border-stone-800">
                <h2 className="text-sm font-semibold">{t("config.promptSources.schedule")}</h2>
                <p className="mt-1 text-xs leading-5 text-stone-500">{t("config.promptSources.scheduleDescription")}</p>
                <label className="mt-5 block text-xs text-stone-500" htmlFor="prompt-source-interval">{t("config.promptSources.interval")}</label>
                <Select id="prompt-source-interval" className="mt-2 w-full" value={schedule.intervalMinutes} options={intervalOptions} onChange={(value) => updateSchedule("intervalMinutes", value)} />
                <Button className="!mt-4 w-full" icon={<RefreshCw className="size-4" />} loading={refreshingAll} onClick={() => void handleRefreshAll()}>
                    {t("config.promptSources.refreshAll")}
                </Button>
                <p className="!mb-0 !mt-3 text-xs text-stone-500">{schedule.lastFetchedAt ? t("config.promptSources.lastFetched", { time: formatTime(schedule.lastFetchedAt, i18n.resolvedLanguage) }) : t("config.promptSources.neverScheduled")}</p>
            </section>

            <PromptSourceEditorDrawer open={Boolean(editingSource)} source={editingSource} onSave={handleSave} onClose={() => setEditingSource(null)} />
            <PromptSourceContentModal source={viewingSource} onClose={() => setViewingId("")} />
        </div>
    );
}

function formatTime(value: string, locale?: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString(locale, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function intervalKey(value: number) {
    if (value === 30) return "minutes30";
    if (value === 60) return "hour1";
    if (value === 360) return "hours6";
    if (value === 1440) return "hours24";
    return "disabled";
}
