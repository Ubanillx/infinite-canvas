import { Download, FileUp, FolderPlus, PencilLine, Plus, Search, Trash2 } from "lucide-react";
import { type ReactNode, type UIEvent, useEffect, useRef, useState } from "react";
import { App, Button, Empty, Input, Modal, Spin } from "antd";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { saveAs } from "file-saver";

import { PromptCard } from "@/components/prompts/prompt-card";
import { usePromptList } from "@/components/prompts/use-prompt-list";
import { PromptDetailDialog } from "./components/prompt-detail-dialog";
import { PromptEditorDialog } from "./components/prompt-editor-dialog";
import { useCopyText } from "@/hooks/use-copy-text";
import { useAssetStore } from "@/stores/use-asset-store";
import { ALL_PROMPTS_OPTION, type Prompt } from "@/services/api/prompts";
import { deleteWorkspacePrompt, exportWorkspacePrompts, importWorkspacePrompts, saveWorkspacePrompt, type WorkspacePromptInput } from "@/services/api/workspace-prompts";
import { getActiveWorkspace } from "@/lib/workspace";

export default function PromptsPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const [titleKeyword, setTitleKeyword] = useState("");
    const [selectedTags, setSelectedTags] = useState<string[]>([]);
    const [selectedCategory, setSelectedCategory] = useState(ALL_PROMPTS_OPTION);
    const [selectedPrompt, setSelectedPrompt] = useState<Prompt | null>(null);
    const [editingPrompt, setEditingPrompt] = useState<Prompt | null>(null);
    const [editorOpen, setEditorOpen] = useState(false);
    const [deletingPrompt, setDeletingPrompt] = useState<Prompt | null>(null);
    const [deleting, setDeleting] = useState(false);
    const [importDraft, setImportDraft] = useState<unknown>(null);
    const [importCount, setImportCount] = useState(0);
    const [importing, setImporting] = useState(false);
    const importInput = useRef<HTMLInputElement>(null);
    const addAsset = useAssetStore((state) => state.addAsset);
    const copyText = useCopyText();
    const { query, items: promptItems, tags: promptTags, categories: promptCategoryOptions, total: totalPrompts } = usePromptList({ keyword: titleKeyword, tags: selectedTags, category: selectedCategory });

    useEffect(() => {
        if (query.isError) message.error(query.error instanceof Error ? query.error.message : t("prompts.loadFailed"));
    }, [message, query.error, query.isError, t]);
    useEffect(() => {
        if (query.data && !promptCategoryOptions.includes(selectedCategory)) setSelectedCategory(ALL_PROMPTS_OPTION);
    }, [promptCategoryOptions, query.data, selectedCategory]);

    const toggleTag = (tag: string) => {
        if (tag === ALL_PROMPTS_OPTION) return setSelectedTags([]);
        setSelectedTags((items) => (items.includes(tag) ? items.filter((item) => item !== tag) : [...items, tag]));
    };

    const savePromptAsset = (item: Prompt) => {
        addAsset({ kind: "text", title: item.title, coverUrl: item.coverUrl, tags: item.tags, source: item.category || t("prompts.library"), data: { content: item.prompt }, metadata: { source: "prompt-library", promptId: item.id, githubUrl: item.githubUrl } });
        message.success(t("common.addedToAssets"));
    };

    const reportError = (error: unknown) => message.error(error instanceof Error ? error.message : t("prompts.saveFailed"));
    const savePrompt = async (input: WorkspacePromptInput, id?: string) => {
        await saveWorkspacePrompt(input, id);
        setEditorOpen(false);
        setEditingPrompt(null);
        await queryClient.invalidateQueries({ queryKey: ["prompts"] });
        await queryClient.invalidateQueries({ queryKey: ["side-panel-prompts"] });
        message.success(t("prompts.saved"));
    };
    const removePrompt = async () => {
        if (!deletingPrompt) return;
        setDeleting(true);
        try {
            await deleteWorkspacePrompt(deletingPrompt.id);
            setDeletingPrompt(null);
            setSelectedPrompt(null);
            await queryClient.invalidateQueries({ queryKey: ["prompts"] });
            await queryClient.invalidateQueries({ queryKey: ["side-panel-prompts"] });
            message.success(t("prompts.deleted"));
        } catch (error) {
            reportError(error);
        } finally {
            setDeleting(false);
        }
    };
    const openEdit = (item: Prompt) => { setSelectedPrompt(null); setEditingPrompt(item); setEditorOpen(true); };
    const isOwn = (item: Prompt) => Boolean(item.workspaceId && item.workspaceId === getActiveWorkspace()?.id);

    const exportLibrary = async () => {
        try {
            const data = await exportWorkspacePrompts();
            saveAs(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }), `prompts-${getActiveWorkspace()?.id || "workspace"}.json`);
            message.success(t("prompts.exported", { count: data.prompts.length }));
        } catch (error) { reportError(error); }
    };

    const selectImport = async (file?: File) => {
        if (!file) return;
        try {
            const data = JSON.parse(await file.text()) as unknown;
            const items = Array.isArray(data) ? data : data && typeof data === "object" && "format" in data && data.format === "infinite-canvas-prompts" && "version" in data && data.version === 1 && "prompts" in data && Array.isArray(data.prompts) ? data.prompts : null;
            if (!items) throw new Error(t("prompts.importFormatInvalid"));
            setImportDraft(data);
            setImportCount(items.length);
        } catch (error) { reportError(error); }
    };

    const confirmImport = async () => {
        if (!importDraft) return;
        setImporting(true);
        try {
            const result = await importWorkspacePrompts(importDraft);
            setImportDraft(null);
            await queryClient.invalidateQueries({ queryKey: ["prompts"] });
            message.success(t("prompts.imported", { count: result.imported }));
        } catch (error) { reportError(error); }
        finally { setImporting(false); }
    };

    const handleListScroll = (event: UIEvent<HTMLDivElement>) => {
        const target = event.currentTarget;
        if (query.hasNextPage && !query.isFetchingNextPage && target.scrollTop + target.clientHeight >= target.scrollHeight - 160) void query.fetchNextPage();
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
            <main className="min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-8 lg:px-10" onScroll={handleListScroll}>
                <div className="flex w-full flex-col gap-6">
                    <header className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs text-muted-foreground">{t("prompts.title")}</p><h1 className="mt-1 text-2xl font-semibold">{t("prompts.library")}</h1><p className="mt-1 text-sm text-muted-foreground">{t("prompts.description")}</p></div><div className="flex flex-wrap gap-2"><Button icon={<Download className="size-4" />} onClick={() => void exportLibrary()}>{t("prompts.export")}</Button><Button icon={<FileUp className="size-4" />} onClick={() => importInput.current?.click()}>{t("prompts.import")}</Button><Button icon={<Plus className="size-4" />} onClick={() => { setEditingPrompt(null); setEditorOpen(true); }}>{t("prompts.create")}</Button></div></header>
                    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-border pb-5">
                        {promptCategoryOptions.length > 1 ? <PromptFilter label={t("prompts.category")} options={promptCategoryOptions} selected={selectedCategory} onChange={setSelectedCategory} /> : null}
                        {promptTags.length > 1 ? <PromptFilter label={t("prompts.tags")} options={promptTags} selected={selectedTags} onChange={toggleTag} /> : null}
                        <Input className="app-search-input w-full sm:!ml-auto sm:!w-[min(26rem,100%)]" prefix={<Search className="size-4 text-muted-foreground" />} value={titleKeyword} allowClear placeholder={t("prompts.search")} onChange={(event) => setTitleKeyword(event.target.value)} />
                    </div>
                    <section className="min-w-0">
                        <p className="mb-3 text-sm text-muted-foreground">{t("prompts.total", { count: totalPrompts })}</p>
                        {query.isLoading ? <div className="flex h-60 items-center justify-center"><Spin /></div> : null}
                        {!query.isLoading ? <PromptGrid items={promptItems} onOpen={setSelectedPrompt} renderActions={(item) => <><Button type="text" size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => savePromptAsset(item)}>{t("common.addToAssets")}</Button>{isOwn(item) ? <><Button type="text" size="small" icon={<PencilLine className="size-3.5" />} aria-label={t("prompts.edit")} title={t("prompts.edit")} onClick={() => openEdit(item)} /><Button type="text" size="small" icon={<Trash2 className="size-3.5" />} aria-label={t("prompts.delete")} onClick={() => setDeletingPrompt(item)} /></> : null}</>} onCopy={(item) => copyText(item.prompt, t("common.promptCopied"))} emptyText={t("prompts.empty")} /> : null}
                        <div className="mt-6 text-center text-xs text-muted-foreground">{query.isFetchingNextPage ? t("prompts.loading") : query.hasNextPage ? t("prompts.loadMore") : promptItems.length > 0 ? t("prompts.end") : null}</div>
                    </section>
                </div>
            </main>

            <PromptDetailDialog prompt={selectedPrompt} onClose={() => setSelectedPrompt(null)} onCopy={(prompt) => copyText(prompt, t("common.promptCopied"))} onSaveAsset={savePromptAsset} />
            <PromptEditorDialog open={editorOpen} prompt={editingPrompt} onClose={() => setEditorOpen(false)} onSave={savePrompt} onError={reportError} />
            <input ref={importInput} type="file" accept=".json,application/json" className="hidden" onChange={(event) => { void selectImport(event.target.files?.[0]); event.target.value = ""; }} />
            <Modal title={t("prompts.import")} open={Boolean(importDraft)} onCancel={() => setImportDraft(null)} onOk={() => void confirmImport()} okText={t("prompts.import")} okButtonProps={{ loading: importing }} styles={{ container: { boxShadow: "none", border: "1px solid var(--border)" } }}>
                <p>{t("prompts.importConfirm", { count: importCount })}</p><p className="mt-2 text-xs text-muted-foreground">{t("prompts.importPrivateHint")}</p>
            </Modal>
            <Modal title={t("prompts.delete")} open={Boolean(deletingPrompt)} onCancel={() => setDeletingPrompt(null)} onOk={() => void removePrompt()} okText={t("prompts.delete")} okButtonProps={{ danger: true, loading: deleting }}>
                {t("prompts.deleteConfirm", { title: deletingPrompt?.title })}
            </Modal>
        </div>
    );
}

function PromptFilter({ label, options, selected, onChange }: { label: string; options: string[]; selected: string | string[]; onChange: (value: string) => void }) {
    const { t } = useTranslation();
    return <div className="flex flex-wrap items-center gap-2"><span className="mr-1 text-xs text-muted-foreground">{label}</span>{options.map((option) => { const active = Array.isArray(selected) ? option === ALL_PROMPTS_OPTION ? selected.length === 0 : selected.includes(option) : selected === option; return <button type="button" key={option} aria-pressed={active} className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${active ? "border-border bg-accent text-foreground" : "border-border bg-card text-muted-foreground hover:bg-accent/50"}`} onClick={() => onChange(option)}>{option === ALL_PROMPTS_OPTION ? t("common.all") : option}</button>; })}</div>;
}

function PromptGrid({ items, onOpen, onCopy, renderActions, emptyText }: { items: Prompt[]; onOpen: (item: Prompt) => void; onCopy: (item: Prompt) => void; renderActions: (item: Prompt) => ReactNode; emptyText: string }) {
    return <div><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">{items.map((item) => <PromptCard key={`${item.sourceId}:${item.id}`} item={item} onOpen={() => onOpen(item)} onCopy={() => onCopy(item)} extraAction={renderActions(item)} />)}</div>{items.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} className="py-16" /> : null}</div>;
}
