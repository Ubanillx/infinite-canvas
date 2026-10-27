import { useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Collapse, Dropdown, Form, Input, Modal, Select, Switch, Tooltip } from "antd";
import type { MenuProps } from "antd";
import { ArrowUpRight, Check, ChevronDown, CircleAlert, FilePenLine, LayoutGrid, LoaderCircle, LockKeyhole, MessageSquareText, Plus, RefreshCw, Search, Trash2, Unplug, Workflow } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { createCodexSkill, createCodexSkillDraft, deleteCodexSkill, fetchCodexSkill, postState, setCodexSkillEnabled, setPiSkillEnabled, updateCodexSkill, type AgentSkillDetail, type AgentSkillDraft, type AgentSkillInterface, type AgentSkillScope, type AgentSkillSummary } from "@/services/api/canvas-agent";
import { useAgentSkillStore } from "@/stores/use-agent-skill-store";
import { useAgentStore, type AgentChatItem } from "@/stores/use-agent-store";
import { useThemeStore } from "@/stores/use-theme-store";

type ScopeFilter = "all" | AgentSkillScope;
type SkillDraftSource = "conversation" | "canvas";
type SkillEditor = { mode: "create"; values?: SkillFormValues } | { mode: "edit"; detail: AgentSkillDetail };
type SkillFormValues = { name: string; description: string; instructions: string; displayName?: string; shortDescription?: string; defaultPrompt?: string };

const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function AgentSkillsView({ clientId }: { clientId: string }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { message, modal } = App.useApp();
    const connected = useAgentStore((state) => state.connected);
    const engine = useAgentStore((state) => state.engine);
    const piEngine = engine === "pi";
    const url = useAgentStore((state) => state.url);
    const token = useAgentStore((state) => state.token);
    const activeThreadId = useAgentStore((state) => state.activeThreadId);
    const hasConversation = useAgentStore((state) => hasSettledConversation(state.messages, state.activeThreadId));
    const hasCanvas = useAgentStore((state) => Boolean(state.canvasContext));
    const sending = useAgentStore((state) => state.sending);
    const waiting = useAgentStore((state) => state.waiting);
    const setAgentState = useAgentStore((state) => state.setAgentState);
    const skills = useAgentSkillStore((state) => state.skills);
    const selectedSkill = useAgentSkillStore((state) => state.selectedSkill);
    const loading = useAgentSkillStore((state) => state.loading);
    const loaded = useAgentSkillStore((state) => state.loaded);
    const errors = useAgentSkillStore((state) => state.errors);
    const draft = useAgentSkillStore((state) => state.draft);
    const generatingSource = useAgentSkillStore((state) => state.generatingSource);
    const loadSkills = useAgentSkillStore((state) => state.loadSkills);
    const selectSkill = useAgentSkillStore((state) => state.selectSkill);
    const clearSelection = useAgentSkillStore((state) => state.clearSelection);
    const setDraft = useAgentSkillStore((state) => state.setDraft);
    const setGeneratingSource = useAgentSkillStore((state) => state.setGeneratingSource);
    const [query, setQuery] = useState("");
    const [scope, setScope] = useState<ScopeFilter>("all");
    const [editor, setEditor] = useState<SkillEditor | null>(null);
    const [saving, setSaving] = useState(false);
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const [createMenuOpen, setCreateMenuOpen] = useState(false);
    const [busySkill, setBusySkill] = useState("");
    const [errorsOpen, setErrorsOpen] = useState(false);
    const confirmRef = useRef<{ destroy: () => void } | null>(null);
    const [form] = Form.useForm<SkillFormValues>();
    const endpoint = url.trim().replace(/\/$/, "");
    const filteredSkills = useMemo(() => {
        const keyword = query.trim().toLowerCase();
        return skills.filter((skill) => {
            if (scope !== "all" && skill.scope !== scope) return false;
            return !keyword || [skill.name, skill.description, skill.interface?.displayName, skill.interface?.shortDescription, skill.shortDescription].some((value) => value?.toLowerCase().includes(keyword));
        });
    }, [query, scope, skills]);

    const editorValues = editor?.mode === "edit" ? skillFormValues(editor.detail) : editor?.values;

    const refresh = (forceReload = true) => loadSkills(endpoint, token, piEngine ? false : forceReload);
    const connectionIsCurrent = (revision: number) => {
        const agent = useAgentStore.getState();
        const skillsState = useAgentSkillStore.getState();
        return skillsState.connectionRevision === revision && agent.connected && agent.url.trim().replace(/\/$/, "") === endpoint && agent.token === token;
    };
    useEffect(() => {
        if (draft) setEditor((current) => current || { mode: "create", values: draftFormValues(draft) });
    }, [draft]);
    useEffect(() => {
        if (connected) return;
        confirmRef.current?.destroy();
        confirmRef.current = null;
        setEditor(null);
        setSaving(false);
        setAdvancedOpen(false);
        setCreateMenuOpen(false);
        setBusySkill("");
        setErrorsOpen(false);
        if (editor) form.resetFields();
    }, [connected, editor, form]);
    const useSkill = (skill: AgentSkillSummary) => {
        selectSkill(skill);
        setAgentState({ activeTab: "chat" });
    };
    const generateDraft = async (source: SkillDraftSource) => {
        const agent = useAgentStore.getState();
        if (agent.sending || agent.waiting) return message.warning(t("agent.skillManager.codexBusy"));
        if (source === "conversation" && !hasSettledConversation(agent.messages, agent.activeThreadId)) return message.warning(t("agent.skillManager.noConversation"));
        if (source === "canvas" && !agent.canvasContext) return message.warning(t("agent.skillManager.noCanvas"));
        if (!clientId) return message.warning(t("agent.skillManager.connecting"));
        const connectionRevision = useAgentSkillStore.getState().connectionRevision;
        setGeneratingSource(source);
        try {
            if (source === "canvas") {
                const synced = await postState(endpoint, token, clientId, agent.canvasContext?.snapshot || null);
                if (!synced) throw new Error(t("agent.skillManager.syncFailed"));
            }
            if (!connectionIsCurrent(connectionRevision)) return;
            const response = await createCodexSkillDraft(endpoint, token, {
                source,
                threadId: agent.activeThreadId,
                clientId,
                ...(agent.model ? { model: agent.model } : {}),
                ...(agent.reasoningEffort ? { effort: agent.reasoningEffort } : {}),
            });
            if (!connectionIsCurrent(connectionRevision)) return;
            if (!response.data) throw new Error(t("agent.skillManager.noDraft"));
            setDraft(response.data);
            message.success(t("agent.skillManager.draftCreated"));
        } catch (error) {
            if (connectionIsCurrent(connectionRevision)) message.error(error instanceof Error ? error.message : t("agent.skillManager.draftFailed"));
        } finally {
            if (connectionIsCurrent(connectionRevision)) setGeneratingSource(null);
        }
    };
    const openEdit = async (skill: AgentSkillSummary) => {
        if (!skill.managed || busySkill || useAgentSkillStore.getState().generatingSource) return;
        const connectionRevision = useAgentSkillStore.getState().connectionRevision;
        setBusySkill(skill.path);
        try {
            const response = await fetchCodexSkill(endpoint, token, skill.name);
            if (!connectionIsCurrent(connectionRevision)) return;
            if (!response.data) throw new Error(t("agent.skillManager.contentMissing"));
            setEditor({ mode: "edit", detail: response.data });
        } catch (error) {
            if (connectionIsCurrent(connectionRevision)) message.error(error instanceof Error ? error.message : t("agent.skillManager.readFailed"));
        } finally {
            if (connectionIsCurrent(connectionRevision)) setBusySkill("");
        }
    };
    const saveSkill = async () => {
        if (!editor) return;
        let values: SkillFormValues;
        try {
            values = await form.validateFields();
        } catch {
            const firstError = form.getFieldsError().find((field) => field.errors.length);
            if (firstError?.name.some((name) => name === "shortDescription" || name === "defaultPrompt")) setAdvancedOpen(true);
            if (firstError) requestAnimationFrame(() => form.scrollToField(firstError.name, { block: "center" }));
            return;
        }
        const name = editor.mode === "edit" ? editor.detail.name : values.name.trim();
        const skillInterface = compactInterface(values);
        if (skillInterface?.defaultPrompt && !mentionsSkill(skillInterface.defaultPrompt, name)) {
            form.setFields([{ name: "defaultPrompt", errors: [t("agent.skillManager.defaultPromptMention", { name })] }]);
            setAdvancedOpen(true);
            requestAnimationFrame(() => form.scrollToField("defaultPrompt", { block: "center" }));
            return;
        }
        const connectionRevision = useAgentSkillStore.getState().connectionRevision;
        if (!connectionIsCurrent(connectionRevision)) return;
        setSaving(true);
        try {
            const input = { description: values.description.trim(), instructions: values.instructions.trim(), interface: skillInterface || null };
            if (editor.mode === "create") await createCodexSkill(endpoint, token, { name, ...input });
            else await updateCodexSkill(endpoint, token, name, { ...input, expectedRevision: editor.detail.revision });
            if (!connectionIsCurrent(connectionRevision)) return;
            setDraft(null);
            setEditor(null);
            setAdvancedOpen(false);
            await refresh();
            if (!connectionIsCurrent(connectionRevision)) return;
            message.success(t(editor.mode === "create" ? "agent.skillManager.created" : "agent.skillManager.updated"));
        } catch (error) {
            if (connectionIsCurrent(connectionRevision)) message.error(error instanceof Error ? error.message : t("agent.skillManager.saveFailed"));
        } finally {
            if (connectionIsCurrent(connectionRevision)) setSaving(false);
        }
    };
    const confirmDelete = (skill: AgentSkillSummary) => {
        const connectionRevision = useAgentSkillStore.getState().connectionRevision;
        confirmRef.current = modal.confirm({
            title: t("agent.skillManager.deleteTitle", { name: skill.interface?.displayName || skill.name }),
            content: t("agent.skillManager.deleteDescription"),
            okText: t("agent.skillManager.delete"),
            okType: "danger",
            cancelText: t("common.cancel"),
            onOk: async () => {
                if (!connectionIsCurrent(connectionRevision)) return;
                setBusySkill(skill.path);
                try {
                    const response = await fetchCodexSkill(endpoint, token, skill.name);
                    if (!connectionIsCurrent(connectionRevision)) return;
                    if (!response.data) throw new Error(t("agent.skillManager.contentMissing"));
                    await deleteCodexSkill(endpoint, token, skill.name, response.data.revision);
                    if (!connectionIsCurrent(connectionRevision)) return;
                    if (selectedSkill?.name === skill.name && selectedSkill.path === skill.path) clearSelection();
                    await refresh();
                    if (!connectionIsCurrent(connectionRevision)) return;
                    message.success(t("agent.skillManager.deleted"));
                } catch (error) {
                    if (!connectionIsCurrent(connectionRevision)) return;
                    message.error(error instanceof Error ? error.message : t("agent.skillManager.deleteFailed"));
                    throw error;
                } finally {
                    if (connectionIsCurrent(connectionRevision)) setBusySkill("");
                }
            },
            afterClose: () => {
                confirmRef.current = null;
            },
        });
    };
    const toggleEnabled = async (skill: AgentSkillSummary, enabled: boolean) => {
        const connectionRevision = useAgentSkillStore.getState().connectionRevision;
        if (!connectionIsCurrent(connectionRevision)) return;
        setBusySkill(skill.path);
        try {
            if (piEngine) await setPiSkillEnabled(endpoint, token, skill, enabled);
            else await setCodexSkillEnabled(endpoint, token, skill, enabled);
            if (!connectionIsCurrent(connectionRevision)) return;
            if (!enabled && selectedSkill?.name === skill.name && selectedSkill.path === skill.path) clearSelection();
            await refresh();
        } catch (error) {
            if (connectionIsCurrent(connectionRevision)) message.error(error instanceof Error ? error.message : t("agent.skillManager.statusFailed"));
        } finally {
            if (connectionIsCurrent(connectionRevision)) setBusySkill("");
        }
    };
    const codexBusy = sending || waiting;
    const createMenu: MenuProps = {
        items: [
            {
                key: "conversation",
                icon: <MessageSquareText className="size-4" strokeWidth={1.6} />,
                disabled: codexBusy || !hasConversation,
                label: (
                    <div className="py-0.5">
                        <div className="text-sm">{t("agent.skillManager.fromConversation")}</div>
                        <div className="mt-0.5 text-xs" style={{ color: theme.node.muted }}>{t(codexBusy ? "agent.skillManager.availableAfterRun" : hasConversation ? "agent.skillManager.conversationDescription" : activeThreadId ? "agent.skillManager.noCompletedContent" : "agent.skillManager.startConversation")}</div>
                    </div>
                ),
            },
            {
                key: "canvas",
                icon: <Workflow className="size-4" strokeWidth={1.6} />,
                disabled: codexBusy || !hasCanvas,
                label: (
                    <div className="py-0.5">
                        <div className="text-sm">{t("agent.skillManager.fromCanvas")}</div>
                        <div className="mt-0.5 text-xs" style={{ color: theme.node.muted }}>{t(codexBusy ? "agent.skillManager.availableAfterRun" : hasCanvas ? "agent.skillManager.canvasDescription" : "agent.skillManager.canvasUnavailable")}</div>
                    </div>
                ),
            },
            { type: "divider" as const },
            {
                key: "manual",
                icon: <FilePenLine className="size-4" strokeWidth={1.6} />,
                label: (
                    <div className="py-0.5">
                        <div className="text-sm">{t("agent.skillManager.blankCreate")}</div>
                        <div className="mt-0.5 text-xs" style={{ color: theme.node.muted }}>{t("agent.skillManager.blankDescription")}</div>
                    </div>
                ),
            },
        ],
        onClick: ({ key }) => {
            if (key === "manual") {
                setDraft(null);
                setEditor({ mode: "create" });
            }
            else void generateDraft(key as SkillDraftSource);
        },
    };

    return (
        <div className="flex min-h-0 flex-1 flex-col" style={{ color: theme.node.text }}>
            <header className="shrink-0 px-6 pb-5 pt-6">
                <div className="flex items-center justify-between gap-3">
                    <h2 className="!m-0 text-base font-medium tracking-tight">{t("agent.panel.skills")}</h2>
                    <div className="flex shrink-0 items-center gap-1">
                        <Tooltip title={t("agent.skillManager.reload")} trigger={["hover", "focus"]}>
                            <Button type="text" className="!h-8 !w-8 !min-w-8" style={{ color: theme.node.muted }} aria-label={t("agent.skillManager.reloadSkill")} disabled={!connected || loading} icon={<RefreshCw className={`size-4 ${loading ? "motion-safe:animate-spin" : ""}`} strokeWidth={1.6} />} onClick={() => void refresh()} />
                        </Tooltip>
                        {piEngine ? null : (
                            <Dropdown trigger={["click"]} placement="bottomRight" open={createMenuOpen} onOpenChange={setCreateMenuOpen} disabled={!connected || !clientId || Boolean(generatingSource)} menu={createMenu}>
                                <Button type="text" className="!h-8 !gap-1.5 !px-2 !text-xs" aria-haspopup="menu" aria-expanded={createMenuOpen} disabled={!connected || !clientId} loading={Boolean(generatingSource)} icon={<Plus className="size-4" strokeWidth={1.6} />}>
                                    {t("agent.skillManager.createSkill")} <ChevronDown className="size-3.5 opacity-60" strokeWidth={1.6} />
                                </Button>
                            </Dropdown>
                        )}
                    </div>
                </div>
                <p className="!mb-0 !mt-1.5 text-xs leading-5" style={{ color: theme.node.muted }}>{t(piEngine ? "agent.panel.piSkillsHint" : "agent.skillManager.localDescription")}</p>
                <div className="mt-5 flex items-center gap-2">
                    <Input aria-label={t("agent.skills.search")} className="app-search-input !h-9 min-w-0 flex-1 !text-xs" allowClear disabled={!connected} value={query} onChange={(event) => setQuery(event.target.value)} prefix={<Search className="size-3.5" strokeWidth={1.6} style={{ color: theme.node.muted }} />} placeholder={t("agent.skills.search")} />
                    <Select<ScopeFilter>
                        variant="borderless"
                        aria-label={t("agent.skillManager.filterBySource")}
                        className="!h-9 w-28 shrink-0 !text-xs"
                        disabled={!connected}
                        value={scope}
                        onChange={setScope}
                        options={[{ value: "all", label: t("agent.skillManager.scopes.all") }, ...((piEngine ? ["repo"] : ["repo", "user", "system", "admin"]) as AgentSkillScope[]).map((value) => ({ value, label: t(`agent.skillManager.scopes.${value}`) }))]}
                    />
                </div>
                {errors.length ? (
                    <Button danger type="text" size="small" className="!mt-2 !h-8 !max-w-full !px-1 !text-xs" icon={<CircleAlert className="size-3.5" strokeWidth={1.6} />} onClick={() => setErrorsOpen(true)}>{t("agent.skillManager.loadErrors", { count: errors.length })}</Button>
                ) : null}
            </header>
            <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-3 pb-4" aria-busy={loading}>
                {loading && !loaded ? (
                    <div className="flex flex-col items-center px-3 pt-[clamp(48px,12vh,120px)] text-center" role="status">
                        <LoaderCircle className="size-8 motion-safe:animate-spin" strokeWidth={1.3} style={{ color: theme.node.faint }} />
                        <div className="mt-5 text-sm font-medium">{t("agent.skills.loading")}</div>
                    </div>
                ) : filteredSkills.length ? (
                    <div className="space-y-1">
                        {filteredSkills.map((skill) => {
                            const selected = selectedSkill?.name === skill.name && selectedSkill.path === skill.path;
                            const busy = busySkill === skill.path;
                            return (
                                <div key={`${skill.name}:${skill.path}`} className={`rounded-lg px-3 py-3 transition-colors hover:bg-black/5 dark:hover:bg-white/10 ${skill.enabled ? "" : "opacity-60"}`} style={{ backgroundColor: selected ? theme.toolbar.activeBg : undefined }}>
                                    <div className="flex items-start gap-3">
                                        <LayoutGrid className="mt-0.5 size-4 shrink-0" strokeWidth={1.6} style={{ color: theme.node.muted }} />
                                        <div className="min-w-0 flex-1">
                                            <div className="flex min-w-0 items-center gap-2">
                                                <span className="truncate text-[13px] font-medium leading-5" title={skill.interface?.displayName || skill.name}>{skill.interface?.displayName || skill.name}</span>
                                                {!skill.managed ? <Tooltip title={t("agent.skillManager.externalReadonly")} trigger={["hover", "focus"]}><span tabIndex={0} aria-label={t("agent.skillManager.externalReadonly")} className="shrink-0 rounded-sm focus-visible:outline focus-visible:outline-1"><LockKeyhole className="size-3.5" strokeWidth={1.6} style={{ color: theme.node.muted }} /></span></Tooltip> : null}
                                            </div>
                                            <div className="mt-1 line-clamp-2 text-xs leading-5" style={{ color: theme.node.muted }}>{skill.interface?.shortDescription || skill.shortDescription || skill.description || t("agent.skillManager.noDescription")}</div>
                                            <Tooltip title={<span className="break-all">{skill.path}</span>} trigger={["hover", "focus"]}>
                                                <div tabIndex={0} aria-label={skill.path} className="mt-1.5 truncate rounded-sm text-[11px] leading-4 focus-visible:outline focus-visible:outline-1" style={{ color: theme.node.muted }}>{t(`agent.skillManager.scopes.${skill.scope}`)} · {skill.name}</div>
                                            </Tooltip>
                                        </div>
                                    </div>
                                    <div className="mt-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 pl-7">
                                        <label className="inline-flex items-center gap-2 text-[11px]" style={{ color: theme.node.muted }}>
                                            <Switch size="small" aria-label={t("agent.skillManager.toggleNamed", { name: skill.interface?.displayName || skill.name })} checked={skill.enabled} loading={busy} disabled={!connected || Boolean(busySkill) || Boolean(generatingSource)} onChange={(enabled) => void toggleEnabled(skill, enabled)} />
                                            {t(skill.enabled ? "agent.skillManager.enabled" : "agent.skillManager.disabled")}
                                        </label>
                                        <div className="flex items-center gap-0.5">
                                            <Button type="text" size="small" className="!h-8 !px-2 !text-xs" disabled={!connected || !skill.enabled || Boolean(busySkill)} icon={selected ? <Check className="size-3.5" strokeWidth={1.6} /> : <ArrowUpRight className="size-3.5" strokeWidth={1.6} />} onClick={() => useSkill(skill)}>{t(selected ? "agent.skillManager.selected" : "agent.skillManager.use")}</Button>
                                            {skill.managed && !piEngine ? (
                                                <>
                                                    <Tooltip title={t("common.edit")} trigger={["hover", "focus"]}><Button type="text" className="!h-8 !w-8 !min-w-8" style={{ color: theme.node.muted }} aria-label={t("agent.skillManager.editNamed", { name: skill.interface?.displayName || skill.name })} disabled={!connected || Boolean(busySkill) || Boolean(generatingSource)} icon={<FilePenLine className="size-3.5" strokeWidth={1.6} />} onClick={() => void openEdit(skill)} /></Tooltip>
                                                    <Tooltip title={t("common.delete")} trigger={["hover", "focus"]}><Button danger type="text" className="!h-8 !w-8 !min-w-8" aria-label={t("agent.skillManager.deleteNamed", { name: skill.interface?.displayName || skill.name })} disabled={!connected || Boolean(busySkill) || Boolean(generatingSource)} icon={<Trash2 className="size-3.5" strokeWidth={1.6} />} onClick={() => confirmDelete(skill)} /></Tooltip>
                                                </>
                                            ) : null}
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <div className="mx-auto flex max-w-64 flex-col items-center px-3 pt-[clamp(48px,12vh,120px)] text-center" role="status">
                        {!connected ? <Unplug className="size-8" strokeWidth={1.3} style={{ color: theme.node.faint }} /> : skills.length ? <Search className="size-8" strokeWidth={1.3} style={{ color: theme.node.faint }} /> : <LayoutGrid className="size-8" strokeWidth={1.3} style={{ color: theme.node.faint }} />}
                        <div className="mt-5 text-sm font-medium">{t(!connected ? "agent.skillManager.connectToView" : skills.length ? "agent.skillManager.noMatch" : "agent.skillManager.none")}</div>
                        <div className="mt-2 text-xs leading-6" style={{ color: theme.node.muted }}>{t(!connected ? "agent.skillManager.connectDescription" : skills.length ? "agent.skillManager.tryAnotherFilter" : piEngine ? "agent.skillManager.installAndReload" : "agent.skillManager.createOrInstall")}</div>
                    </div>
                )}
            </div>

            <Modal title={t("agent.skillManager.loadErrors", { count: errors.length })} open={errorsOpen} footer={null} width={720} onCancel={() => setErrorsOpen(false)}>
                <div className="thin-scrollbar mt-4 max-h-[60vh] overflow-y-auto rounded-md border px-3 py-2 text-xs leading-5" style={{ borderColor: theme.node.stroke }}>
                    {errors.map((error, index) => <div key={`${index}:${error}`} className="break-all py-1" style={{ color: theme.node.muted }}>{error}</div>)}
                </div>
            </Modal>

            <Modal
                title={editor?.mode === "edit" ? t("agent.skillManager.editNamed", { name: editor.detail.interface?.displayName || editor.detail.name }) : t("agent.skillManager.createSkill")}
                open={Boolean(editor)}
                okText={t(editor?.mode === "edit" ? "agent.skillManager.saveChanges" : "agent.skillManager.createSkill")}
                cancelText={t("common.cancel")}
                confirmLoading={saving}
                width={680}
                centered
                destroyOnHidden
                styles={{ body: { maxHeight: "calc(100vh - 220px)", overflowY: "auto" } }}
                onCancel={() => {
                    if (saving) return;
                    setDraft(null);
                    setEditor(null);
                    setAdvancedOpen(false);
                }}
                onOk={() => void saveSkill()}
            >
                <div className="mb-5 text-xs" style={{ color: theme.node.muted }}>{t("agent.skillManager.saveLocation")} · <span className="font-mono">.agents/skills</span></div>
                <Form key={editor?.mode === "edit" ? editor.detail.revision : `create:${editor?.values?.name || "blank"}`} form={form} initialValues={editorValues} layout="vertical" requiredMark="optional" preserve={false}>
                    <div className="mb-3 text-xs font-medium" style={{ color: theme.node.muted }}>{t("agent.skillManager.basicInfo")}</div>
                    <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
                        <Form.Item name="name" label={t("agent.skillManager.identifier")} extra={t("agent.skillManager.identifierExtra")} rules={[{ required: true, message: t("agent.skillManager.identifierRequired") }, { max: 64, message: t("agent.skillManager.identifierMax") }, { pattern: skillNamePattern, message: t("agent.skillManager.identifierPattern") }]}>
                            <Input maxLength={64} disabled={editor?.mode === "edit"} placeholder={t("agent.skillManager.identifierPlaceholder")} />
                        </Form.Item>
                        <Form.Item name="displayName" label={t("agent.skillManager.displayName")} rules={[{ max: 64, message: t("agent.skillManager.displayNameMax") }]}><Input maxLength={64} placeholder={t("agent.skillManager.displayNamePlaceholder")} /></Form.Item>
                    </div>
                    <Form.Item name="description" label={t("agent.skillManager.whenToUse")} extra={t("agent.skillManager.whenToUseExtra")} rules={[{ required: true, message: t("agent.skillManager.whenToUseRequired") }, { max: 1024, message: t("agent.skillManager.whenToUseMax") }, { validator: (_, value) => typeof value === "string" && /[<>]/.test(value) ? Promise.reject(new Error(t("agent.skillManager.noAngleBrackets"))) : Promise.resolve() }]}><Input.TextArea maxLength={1024} autoSize={{ minRows: 2, maxRows: 4 }} placeholder={t("agent.skillManager.whenToUsePlaceholder")} /></Form.Item>
                    <Form.Item name="instructions" label={t("agent.skillManager.instructions")} extra={t("agent.skillManager.instructionsExtra")} rules={[{ required: true, message: t("agent.skillManager.instructionsRequired") }]}><Input.TextArea className="!leading-6" autoSize={{ minRows: 6, maxRows: 10 }} placeholder={t("agent.skillManager.instructionsPlaceholder")} /></Form.Item>
                    <Collapse
                        ghost
                        size="small"
                        activeKey={advancedOpen ? ["advanced"] : []}
                        expandIconPlacement="end"
                        onChange={(keys) => setAdvancedOpen((Array.isArray(keys) ? keys : [keys]).includes("advanced"))}
                        items={[{
                            key: "advanced",
                            forceRender: true,
                            label: <span className="text-sm font-medium">{t("agent.skillManager.advanced")}</span>,
                            children: (
                                <>
                                    <Form.Item name="shortDescription" label={t("agent.skillManager.shortDescription")} extra={t("agent.skillManager.shortDescriptionExtra")} rules={[{ min: 25, message: t("agent.skillManager.shortDescriptionMin") }, { max: 64, message: t("agent.skillManager.shortDescriptionMax") }]}><Input maxLength={64} showCount placeholder={t("agent.skillManager.shortDescriptionPlaceholder")} /></Form.Item>
                                    <Form.Item name="defaultPrompt" label={t("agent.skillManager.defaultPrompt")} extra={t("agent.skillManager.defaultPromptExtra")} rules={[{ max: 1024, message: t("agent.skillManager.defaultPromptMax") }]}><Input.TextArea maxLength={1024} autoSize={{ minRows: 2, maxRows: 4 }} placeholder={t("agent.skillManager.defaultPromptPlaceholder")} /></Form.Item>
                                </>
                            ),
                        }]}
                    />
                </Form>
            </Modal>
        </div>
    );
}

function skillFormValues(detail: AgentSkillDetail): SkillFormValues {
    return {
        name: detail.name,
        description: detail.description,
        instructions: detail.instructions,
        displayName: detail.interface?.displayName || undefined,
        shortDescription: detail.interface?.shortDescription || undefined,
        defaultPrompt: detail.interface?.defaultPrompt || undefined,
    };
}

function draftFormValues(draft: AgentSkillDraft): SkillFormValues {
    return {
        name: draft.name,
        description: draft.description,
        instructions: draft.instructions,
        displayName: draft.displayName || undefined,
        shortDescription: draft.shortDescription || undefined,
        defaultPrompt: draft.defaultPrompt || undefined,
    };
}

function hasSettledConversation(messages: AgentChatItem[], threadId: string) {
    return Boolean(threadId && messages.some((item) => item.role === "user" && item.threadId === threadId && item.turnId));
}

function compactInterface(values: SkillFormValues): AgentSkillInterface | undefined {
    const skillInterface = {
        displayName: values.displayName?.trim() || undefined,
        shortDescription: values.shortDescription?.trim() || undefined,
        defaultPrompt: values.defaultPrompt?.trim() || undefined,
    };
    return Object.values(skillInterface).some(Boolean) ? skillInterface : undefined;
}

function mentionsSkill(prompt: string, name: string) {
    return new RegExp(`\\$${name}(?![A-Za-z0-9_-]|:[A-Za-z0-9_-])`).test(prompt);
}
