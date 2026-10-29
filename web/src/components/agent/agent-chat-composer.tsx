import { useImperativeHandle, useRef, useState, type CSSProperties, type ReactNode, type Ref } from "react";
import { Button, Dropdown, Tooltip } from "antd";
import { ArrowUp, Check, Cpu, FileText, FolderUp, Gauge, Hand, ImagePlus, LayoutGrid, LoaderCircle, RefreshCw, ShieldAlert, ShieldCheck, ShieldOff, Square, X, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { canvasThemes } from "@/lib/canvas-theme";
import { useAgentStore, type AgentModel, type AgentPermissionMode, type AgentReasoningEffort } from "@/stores/use-agent-store";
import type { AgentChatAttachment } from "./agent-chat-message";
import { AgentChatPromptInput, type AgentChatPromptInputRef } from "./agent-chat-prompt-input";

export function AgentChatComposer({
    ref,
    prompt,
    attachments = [],
    disabled,
    sending,
    queueable,
    queuedCount,
    placeholder,
    theme,
    onPromptChange,
    onSubmit,
    onStop,
    onInterruptAndSend,
    onAddFiles,
    onRemoveAttachment,
    fileUploadsEnabled,
    confirmTools,
    onConfirmToolsChange,
    permissionMode,
    onPermissionModeChange,
    models,
    model,
    reasoningEffort,
    onModelChange,
    onReasoningEffortChange,
    left,
}: {
    ref?: Ref<AgentChatPromptInputRef>;
    prompt: string;
    attachments?: AgentChatAttachment[];
    disabled?: boolean;
    sending?: boolean;
    /** 运行中的 turn 允许把新消息加入队列，而不是禁用输入。 */
    queueable?: boolean;
    queuedCount?: number;
    placeholder: string;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    onPromptChange: (value: string) => void;
    onSubmit: () => void;
    onStop?: () => void;
    onInterruptAndSend?: () => void;
    onAddFiles?: (files: FileList | File[] | null) => void | Promise<void>;
    onRemoveAttachment?: (id: string) => void;
    fileUploadsEnabled?: boolean;
    confirmTools?: boolean;
    onConfirmToolsChange?: (confirmTools: boolean) => void;
    permissionMode?: AgentPermissionMode;
    onPermissionModeChange?: (permissionMode: AgentPermissionMode) => void;
    models?: AgentModel[];
    model?: string;
    reasoningEffort?: AgentReasoningEffort | "";
    onModelChange?: (model: string) => void;
    onReasoningEffortChange?: (effort: AgentReasoningEffort) => void;
    left?: ReactNode;
}) {
    const { t } = useTranslation();
    const imageInputRef = useRef<HTMLInputElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const inputRef = useRef<AgentChatPromptInputRef>(null);
    useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus(), openSkills: () => inputRef.current?.openSkills() }), []);
    const canvasReferences = useAgentStore((state) => state.canvasReferences);
    const uploading = attachments.some((item) => item.uploadState === "uploading" || item.uploadState === "failed");
    const canSubmit = !disabled && !uploading && Boolean(prompt.trim() || attachments.length || canvasReferences.length) && (!sending || Boolean(queueable));
    const sendLabel = sending && queueable ? t("agent.composer.queue") : t("agent.composer.send");
    return (
        <div className="shrink-0 px-3 pb-3 pt-2" onWheelCapture={(event) => event.stopPropagation()}>
            <div className="rounded-2xl border border-[var(--composer-border)] px-3 pb-2 pt-3 transition-colors focus-within:border-[var(--composer-focus)]" style={{ background: theme.toolbar.panel, "--composer-border": theme.node.stroke, "--composer-focus": `color-mix(in srgb, ${theme.node.stroke} 75%, ${theme.node.muted})` } as CSSProperties}>
                {attachments.length ? (
                    <div className="thin-scrollbar mb-2 flex gap-2 overflow-x-auto pb-1">
                        {attachments.map((item) => (
                            <div key={item.id} className="group relative shrink-0 overflow-hidden rounded-xl border" style={{ borderColor: theme.node.stroke }} title={item.name}>
                                {item.kind === "image" ? (
                                    <div className="size-14">
                                        <img src={item.url} alt={item.name} className="size-full object-cover" />
                                    </div>
                                ) : (
                                    <div className="flex h-14 w-40 items-center gap-1.5 px-2 text-[11px] leading-4" style={{ color: theme.node.text }}>
                                        <FileText className="size-4 shrink-0 opacity-70" strokeWidth={1.6} />
                                        <span className="min-w-0">
                                            <span className="block truncate">{item.name}</span>
                                            <span className="block truncate text-[10px] opacity-60">
                                                {item.uploadState === "uploading" ? t("agent.composer.uploading", { percent: item.progress ?? 0 }) : item.uploadState === "failed" ? t("agent.composer.uploadFailedShort") : formatSize(item.size || 0)}
                                            </span>
                                        </span>
                                    </div>
                                )}
                                {onRemoveAttachment ? (
                                    <button type="button" className="absolute right-1 top-1 grid size-5 place-items-center rounded-md border transition hover:brightness-95 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2" style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke, color: theme.node.text }} onClick={() => onRemoveAttachment(item.id)} aria-label={t("agent.composer.removeAttachment", { name: item.name })}>
                                        <X className="size-3" strokeWidth={1.6} />
                                    </button>
                                ) : null}
                            </div>
                        ))}
                    </div>
                ) : null}
                <AgentChatPromptInput ref={inputRef} value={prompt} disabled={disabled} placeholder={placeholder} theme={theme} onChange={onPromptChange} onSubmit={() => { if (canSubmit) void onSubmit(); }} onAddFiles={onAddFiles} />
                <div className="@container mt-2" style={{ color: theme.node.muted }}>
                    {models?.length && model && reasoningEffort && onModelChange && onReasoningEffortChange ? <AgentModelControls models={models} model={model} reasoningEffort={reasoningEffort} onModelChange={onModelChange} onReasoningEffortChange={onReasoningEffortChange} /> : null}
                    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-0.5">
                            <Tooltip title={t("agent.composer.mentions.skillShortcut")}>
                                <Button type="text" className="!h-8 !gap-1.5 !px-2" disabled={disabled} style={{ color: theme.node.muted }} icon={<LayoutGrid className="size-4" strokeWidth={1.6} />} onClick={() => inputRef.current?.openSkills()} aria-label={t("agent.composer.mentions.selectSkill")}>
                                    <span className="text-xs">{t("agent.panel.skills")}</span>
                                </Button>
                            </Tooltip>
                            {onAddFiles ? (
                                <>
                                    <input ref={imageInputRef} hidden type="file" accept="image/*" multiple onChange={(event) => {
                                        void onAddFiles(event.target.files);
                                        event.target.value = "";
                                    }} />
                                    <input ref={fileInputRef} hidden type="file" multiple onChange={(event) => {
                                        void onAddFiles(event.target.files);
                                        event.target.value = "";
                                    }} />
                                    <Tooltip title={t("agent.composer.uploadImage")}>
                                        <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" disabled={disabled || sending} style={{ color: theme.node.muted }} icon={<ImagePlus className="size-4" strokeWidth={1.6} />} onClick={() => imageInputRef.current?.click()} aria-label={t("agent.composer.uploadImage")} />
                                    </Tooltip>
                                    {fileUploadsEnabled ? (
                                        <Tooltip title={t("agent.composer.uploadFile")}>
                                            <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" disabled={disabled || sending} style={{ color: theme.node.muted }} icon={<FolderUp className="size-4" strokeWidth={1.6} />} onClick={() => fileInputRef.current?.click()} aria-label={t("agent.composer.uploadFile")} />
                                        </Tooltip>
                                    ) : null}
                                </>
                            ) : null}
                            {onConfirmToolsChange ? <ToolConfirmationMenu confirmTools={Boolean(confirmTools)} theme={theme} onChange={onConfirmToolsChange} /> : null}
                            {permissionMode && onPermissionModeChange ? <PermissionModeMenu permissionMode={permissionMode} theme={theme} onChange={onPermissionModeChange} /> : null}
                            {left}
                        </div>
                        <div className="ml-auto flex shrink-0 items-center gap-1.5">
                            {queuedCount ? (
                                <span className="shrink-0 text-[11px] tabular-nums" style={{ color: theme.node.muted }}>{t("agent.composer.queued", { count: queuedCount })}</span>
                            ) : null}
                            {sending && onStop ? (
                                <Tooltip title={t("agent.composer.stop")} placement="top"><Button danger type="text" shape="circle" className="!h-8 !w-8 !min-w-8" icon={<Square className="size-4" strokeWidth={1.6} />} onClick={() => void onStop()} aria-label={t("agent.composer.stop")} /></Tooltip>
                            ) : null}
                            {sending && onInterruptAndSend && (prompt.trim() || attachments.length || canvasReferences.length) ? (
                                <Tooltip title={t("agent.composer.interruptAndSend")} placement="top"><Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" icon={<Zap className="size-4" strokeWidth={1.6} />} onClick={() => void onInterruptAndSend()} aria-label={t("agent.composer.interruptAndSend")} /></Tooltip>
                            ) : null}
                            <Tooltip title={sendLabel} placement="top"><Button type="primary" shape="circle" className="!h-8 !w-8 !min-w-8" disabled={!canSubmit} icon={sending && !queueable ? <LoaderCircle className="size-4 animate-spin" strokeWidth={1.6} /> : <ArrowUp className="size-4" strokeWidth={1.6} />} onClick={() => void onSubmit()} aria-label={sendLabel} /></Tooltip>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

function formatSize(bytes: number) {
    return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.ceil(bytes / 1024))}KB`;
}

function AgentModelControls({ models, model, reasoningEffort, onModelChange, onReasoningEffortChange }: { models: AgentModel[]; model: string; reasoningEffort: AgentReasoningEffort; onModelChange: (model: string) => void; onReasoningEffortChange: (effort: AgentReasoningEffort) => void }) {
    const { t } = useTranslation();
    const current = models.find((item) => item.model === model) || models[0];
    const modelLabel = (item: AgentModel) => item.model.includes("::") ? item.model.slice(item.model.indexOf("::") + 2) : item.displayName || item.model;
    const effortLabel = (effort: AgentReasoningEffort) => t(`agent.composer.effort.${effort}`);
    const [modelOpen, setModelOpen] = useState(false);
    const [reasoningOpen, setReasoningOpen] = useState(false);
    return (
        <div className="mb-1 flex min-w-0 items-center gap-1">
            <Tooltip title={t("agent.composer.model", { model: current.displayName || current.model })} placement="top" open={modelOpen ? false : undefined}>
                <span className="inline-flex min-w-0 max-w-[65%]">
                    <Select value={model} open={modelOpen} onOpenChange={setModelOpen} onValueChange={onModelChange}>
                        <SelectTrigger className="h-8 min-w-0 max-w-64 justify-start gap-1.5 rounded-md border-0 bg-transparent px-2 text-xs font-medium shadow-none hover:bg-black/5 focus-visible:ring-1 focus-visible:ring-current/20 dark:bg-transparent dark:hover:bg-white/10" aria-label={t("agent.composer.selectModel", { model: current.displayName || current.model })}>
                            <Cpu className="size-3.5 shrink-0 opacity-70" strokeWidth={1.6} />
                            <span className="min-w-0 flex-1 truncate text-left">{modelLabel(current)}</span>
                        </SelectTrigger>
                        <SelectContent data-canvas-no-zoom position="popper" side="top" align="start" sideOffset={6} className="z-[1200] w-64 rounded-xl border border-border/70 bg-popover p-1 shadow-sm">
                            {models.map((item) => <SelectItem key={item.model} value={item.model}>{modelLabel(item)}</SelectItem>)}
                        </SelectContent>
                    </Select>
                </span>
            </Tooltip>
            {current.supportedReasoningEfforts.some((item) => item.reasoningEffort !== "none") && <Tooltip title={t("agent.composer.reasoning", { effort: effortLabel(reasoningEffort) })} placement="top" open={reasoningOpen ? false : undefined}>
                <span className="inline-flex shrink-0">
                    <Select value={reasoningEffort} open={reasoningOpen} onOpenChange={setReasoningOpen} onValueChange={(value) => onReasoningEffortChange(value as AgentReasoningEffort)}>
                        <SelectTrigger className="h-8 min-w-0 max-w-64 justify-start gap-1.5 rounded-md border-0 bg-transparent px-2 text-xs font-medium shadow-none hover:bg-black/5 focus-visible:ring-1 focus-visible:ring-current/20 dark:bg-transparent dark:hover:bg-white/10" aria-label={t("agent.composer.selectReasoning", { effort: effortLabel(reasoningEffort) })}>
                            <Gauge className="size-3.5 opacity-70" strokeWidth={1.6} />
                            <span>{effortLabel(reasoningEffort)}</span>
                        </SelectTrigger>
                        <SelectContent data-canvas-no-zoom position="popper" side="top" align="start" sideOffset={6} className="z-[1200] min-w-32 rounded-xl border border-border/70 bg-popover p-1 shadow-sm">
                            {current.supportedReasoningEfforts.map((item) => <SelectItem key={item.reasoningEffort} value={item.reasoningEffort}>{effortLabel(item.reasoningEffort)}</SelectItem>)}
                        </SelectContent>
                    </Select>
                </span>
            </Tooltip>}
        </div>
    );
}

function PermissionModeMenu({ permissionMode, theme, onChange }: { permissionMode: AgentPermissionMode; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onChange: (permissionMode: AgentPermissionMode) => void }) {
    const { t } = useTranslation();
    const permissionOptions: Array<{ key: AgentPermissionMode; title: string; shortTitle: string; description: string; icon: ReactNode }> = [
        { key: "request", title: t("agent.composer.permission.request"), shortTitle: t("agent.composer.permission.request"), description: t("agent.composer.permission.requestDescription"), icon: <ShieldAlert className="size-3.5" strokeWidth={1.6} /> },
        { key: "automatic", title: t("agent.composer.permission.automatic"), shortTitle: t("agent.composer.permission.automatic"), description: t("agent.composer.permission.automaticDescription"), icon: <ShieldCheck className="size-3.5" strokeWidth={1.6} /> },
        { key: "full", title: t("agent.composer.permission.full"), shortTitle: t("agent.composer.permission.fullShort"), description: t("agent.composer.permission.fullDescription"), icon: <ShieldOff className="size-3.5" strokeWidth={1.6} /> },
    ];
    const current = permissionOptions.find((item) => item.key === permissionMode) || permissionOptions[0];
    const [open, setOpen] = useState(false);
    return (
        <Tooltip title={t("agent.composer.permissionLabel", { mode: current.shortTitle })} placement="top" open={open ? false : undefined}>
            <span className="inline-flex shrink-0">
                <Dropdown
                    trigger={["click"]}
                    placement="topLeft"
                    open={open}
                    onOpenChange={setOpen}
                    menu={{
                        items: permissionOptions.map((item) => ({
                            key: item.key,
                            label: <ConfirmationOption icon={item.icon} title={item.title} description={item.description} selected={permissionMode === item.key} />,
                            onClick: () => onChange(item.key),
                        })),
                    }}
                >
                    <button type="button" className="flex size-8 shrink-0 items-center justify-center rounded-md transition hover:bg-black/5 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 dark:hover:bg-white/10" style={{ color: permissionMode === "full" ? "#ea580c" : theme.node.text }} aria-label={t("agent.composer.selectPermission", { mode: current.title })}>
                        {current.icon}
                    </button>
                </Dropdown>
            </span>
        </Tooltip>
    );
}

function ToolConfirmationMenu({ confirmTools, theme, onChange }: { confirmTools: boolean; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onChange: (confirmTools: boolean) => void }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const mode = t(confirmTools ? "agent.composer.tools.manual" : "agent.composer.tools.automatic");
    return (
        <Tooltip title={t("agent.composer.tools.label", { mode })} placement="top" open={open ? false : undefined}>
            <span className="inline-flex shrink-0">
                <Dropdown
                    trigger={["click"]}
                    placement="topLeft"
                    open={open}
                    onOpenChange={setOpen}
                    menu={{
                        items: [
                            {
                                key: "manual",
                                label: <ConfirmationOption icon={<Hand className="size-4" strokeWidth={1.6} />} title={t("agent.composer.tools.manual")} description={t("agent.composer.tools.manualDescription")} selected={confirmTools} />,
                                onClick: () => onChange(true),
                            },
                            {
                                key: "automatic",
                                label: <ConfirmationOption icon={<RefreshCw className="size-4" strokeWidth={1.6} />} title={t("agent.composer.tools.automatic")} description={t("agent.composer.tools.automaticDescription")} selected={!confirmTools} />,
                                onClick: () => onChange(false),
                            },
                        ],
                    }}
                >
                    <button type="button" className="flex size-8 shrink-0 items-center justify-center rounded-md transition hover:bg-black/5 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 dark:hover:bg-white/10" style={{ color: theme.node.text }} aria-label={t("agent.composer.tools.select", { mode })}>
                        {confirmTools ? <Hand className="size-3.5" strokeWidth={1.6} /> : <RefreshCw className="size-3.5" strokeWidth={1.6} />}
                    </button>
                </Dropdown>
            </span>
        </Tooltip>
    );
}

function ConfirmationOption({ icon, title, description, selected }: { icon: ReactNode; title: string; description: string; selected: boolean }) {
    return (
        <div className="flex min-w-64 items-start gap-3 py-1">
            <span className="mt-0.5 shrink-0">{icon}</span>
            <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{title}</span>
                <span className="mt-0.5 block text-xs leading-5 opacity-60">{description}</span>
            </span>
            {selected ? <Check className="mt-0.5 size-4 shrink-0" strokeWidth={1.6} /> : null}
        </div>
    );
}
