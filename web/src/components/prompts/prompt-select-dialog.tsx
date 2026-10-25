import { Search } from "lucide-react";
import { type UIEvent, useEffect, useState } from "react";
import { App, Empty, Input, Modal, Spin, Tag } from "antd";
import { useTranslation } from "react-i18next";

import { ALL_PROMPTS_OPTION } from "@/services/api/prompts";
import { cn } from "@/lib/utils";
import { PromptCard } from "./prompt-card";
import { usePromptList } from "./use-prompt-list";

export function PromptSelectDialog({ open, onOpenChange, onSelect, flat = false }: { open: boolean; onOpenChange: (open: boolean) => void; onSelect: (prompt: string) => void; flat?: boolean }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const [keyword, setKeyword] = useState("");
    const [selectedTags, setSelectedTags] = useState<string[]>([]);
    const [selectedCategory, setSelectedCategory] = useState(ALL_PROMPTS_OPTION);
    const { query, items, tags: promptTags, categories: promptCategories } = usePromptList({ keyword, tags: selectedTags, category: selectedCategory, enabled: open });
    const showCategories = promptCategories.length > 1;
    const showTags = promptTags.length > 1;
    const toggleTag = (tag: string) => {
        if (tag === ALL_PROMPTS_OPTION) return setSelectedTags([]);
        setSelectedTags((items) => (items.includes(tag) ? items.filter((item) => item !== tag) : [...items, tag]));
    };
    const selectPrompt = (prompt: string) => {
        onSelect(prompt);
        onOpenChange(false);
    };

    useEffect(() => {
        if (query.isError) message.error(query.error instanceof Error ? query.error.message : t("prompts.loadFailed"));
    }, [message, query.error, query.isError, t]);
    useEffect(() => {
        if (query.data && !promptCategories.includes(selectedCategory)) setSelectedCategory(ALL_PROMPTS_OPTION);
    }, [promptCategories, query.data, selectedCategory]);

    const handleListScroll = (event: UIEvent<HTMLDivElement>) => {
        const target = event.currentTarget;
        if (query.hasNextPage && !query.isFetchingNextPage && target.scrollTop + target.clientHeight >= target.scrollHeight - 160) void query.fetchNextPage();
    };

    return (
        <Modal title={t("prompts.library")} open={open} onCancel={() => onOpenChange(false)} footer={null} width={flat ? "min(1360px, calc(100vw - 48px))" : 880} centered classNames={flat ? { root: "image-workbench-overlay", body: "[&_button]:!shadow-none [&_.ant-card]:!shadow-none [&_.ant-card:hover]:!translate-y-0" } : undefined} styles={flat ? { container: { boxShadow: "none", border: "1px solid var(--border)" } } : undefined}>
            <div className={cn("grid min-h-0 gap-5", flat ? "h-[min(76dvh,900px)]" : "h-[62dvh]", (showCategories || showTags) && (flat ? "sm:grid-cols-[220px_minmax(0,1fr)]" : "sm:grid-cols-[200px_minmax(0,1fr)]"))} data-canvas-no-zoom onWheelCapture={(event) => event.stopPropagation()}>
                {showCategories || showTags ? <aside className="thin-scrollbar min-h-0 overflow-y-auto border-r border-stone-200 pr-4 dark:border-stone-800">
                    {showCategories ? <><div className="mb-2 text-xs font-semibold uppercase tracking-widest text-stone-400 dark:text-stone-500">{t("prompts.category")}</div><div className="flex flex-wrap gap-1.5">
                        {promptCategories.map((category) => <Tag.CheckableTag key={category} checked={selectedCategory === category} className={cn("prompt-filter-tag", selectedCategory === category && "is-active")} onChange={() => setSelectedCategory(category)}>{category === ALL_PROMPTS_OPTION ? t("common.all") : category}</Tag.CheckableTag>)}
                    </div></> : null}
                    {showTags ? <><div className={cn("mb-2 text-xs font-semibold uppercase tracking-widest text-stone-400 dark:text-stone-500", showCategories && "mt-5")}>{t("prompts.tags")}</div><div className="flex flex-wrap gap-1.5">
                        {promptTags.map((tag) => {
                            const active = tag === ALL_PROMPTS_OPTION ? selectedTags.length === 0 : selectedTags.includes(tag);
                            return (
                                <Tag.CheckableTag key={tag} checked={active} className={cn("prompt-filter-tag", active && "is-active")} onChange={() => toggleTag(tag)}>
                                    {tag === ALL_PROMPTS_OPTION ? t("common.all") : tag}
                                </Tag.CheckableTag>
                            );
                        })}
                    </div></> : null}
                </aside> : null}
                <section className="flex min-h-0 min-w-0 flex-col">
                    <Input className="app-search-input" size="large" prefix={<Search className="size-4 text-muted-foreground" />} value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder={t("prompts.searchTitle")} />
                    <div className="thin-scrollbar mt-4 min-h-0 flex-1 overflow-y-auto pr-2" data-canvas-no-zoom onScroll={handleListScroll} onWheelCapture={(event) => event.stopPropagation()}>
                        {query.isLoading ? (
                            <div className="flex h-40 items-center justify-center">
                                <Spin />
                            </div>
                        ) : null}
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                            {items.map((item) => (
                                <PromptCard key={item.id} item={item} onOpen={() => selectPrompt(item.prompt)} onCopy={() => selectPrompt(item.prompt)} compact />
                            ))}
                        </div>
                        {!query.isLoading && items.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("prompts.empty")} className="py-8" /> : null}
                        {query.isFetchingNextPage ? (
                            <div className="py-4 text-center">
                                <Spin size="small" />
                            </div>
                        ) : null}
                    </div>
                </section>
            </div>
        </Modal>
    );
}
