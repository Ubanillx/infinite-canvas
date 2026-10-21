import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Button, Form, Input, Popover } from "antd";
import { ArrowLeft, ArrowUpRight, FolderClosed, LayoutGrid, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { WorkspaceAmbientBackground } from "@/components/layout/workspace-ambient-background";
import { canvasThemes } from "@/lib/canvas-theme";
import { clearActiveWorkspace, getActiveWorkspace, getKnownWorkspaces, migrateLegacyDataToWorkspace, setActiveWorkspace, setKnownWorkspaces, type WorkspaceAccess } from "@/lib/workspace";
import { listWorkspaceCanvasSummaries, type WorkspaceCanvasSummary } from "@/services/api/workspace-summaries";
import { createWorkspace, listWorkspaces } from "@/services/workspace";
import { useThemeStore } from "@/stores/use-theme-store";
import { useAppLoadingStore } from "@/stores/use-app-loading-store";

type GateMode = "select" | "create";
const CREATE_WORKSPACE_KEY = "infinite-canvas:create-workspace";

export function WorkspaceGate({ children }: { children: ReactNode }) {
    const [cachedWorkspace] = useState(getActiveWorkspace);
    const [ready, setReady] = useState(false);
    const [loading, setLoading] = useState(true);
    const [mode, setMode] = useState<GateMode>("select");
    const [workspaces, setWorkspaces] = useState<WorkspaceAccess[]>(getKnownWorkspaces);
    const [summaries, setSummaries] = useState<Record<string, WorkspaceCanvasSummary | null>>({});
    const [error, setError] = useState("");
    const [form] = Form.useForm<Record<string, string>>();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const startAppLoading = useAppLoadingStore((state) => state.start);
    const finishAppLoading = useAppLoadingStore((state) => state.finish);
    const createRequestedRef = useRef<boolean | null>(null);

    useEffect(() => {
        if (!ready && !loading) finishAppLoading();
    }, [finishAppLoading, loading, ready]);

    useEffect(() => {
        let current = true;
        if (createRequestedRef.current === null) {
            createRequestedRef.current = window.sessionStorage.getItem(CREATE_WORKSPACE_KEY) === "1";
            window.sessionStorage.removeItem(CREATE_WORKSPACE_KEY);
        }
        void (async () => {
            try {
                const available = await listWorkspaces();
                if (!current) return;
                setKnownWorkspaces(available);
                setWorkspaces(available);
                const active = getActiveWorkspace();
                const listed = available.find((item) => item.id === active?.id);
                if (listed) {
                    setActiveWorkspace(listed);
                    await migrateLegacyDataToWorkspace(listed);
                    if (current) setReady(true);
                    return;
                }
                if (active) clearActiveWorkspace();
                setMode(createRequestedRef.current || !available.length ? "create" : "select");
                if (available.length) {
                    const items = await listWorkspaceCanvasSummaries().catch(() => ({}));
                    if (current) setSummaries(items);
                }
            } catch (reason) {
                if (!current) return;
                setError(reason instanceof Error ? reason.message : "无法读取工作区列表");
                setMode(cachedWorkspace ? "select" : "create");
            } finally {
                if (current) setLoading(false);
            }
        })();
        return () => { current = false; };
    }, [cachedWorkspace]);

    const enterWorkspace = async (workspace: WorkspaceAccess) => {
        startAppLoading();
        setLoading(true);
        setError("");
        try {
            setActiveWorkspace(workspace);
            await migrateLegacyDataToWorkspace(workspace);
            window.location.reload();
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "工作区操作失败");
            setLoading(false);
        }
    };

    const create = async (values: Record<string, string>) => {
        startAppLoading();
        setLoading(true);
        setError("");
        try {
            await enterWorkspace(await createWorkspace(values.name.trim()));
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "工作区操作失败");
            setLoading(false);
        }
    };

    if (ready) return <>{children}</>;
    if (loading && cachedWorkspace) return null;
    return (
        <div className="relative min-h-dvh w-full overflow-y-auto" style={{ backgroundColor: theme.canvas.background, color: theme.node.text }}>
            <WorkspaceAmbientBackground theme={theme} />
            <main className="relative z-10 mx-auto w-full max-w-[1680px] px-6 py-12 sm:px-10 sm:py-16 lg:px-16 lg:py-20">
                <div className="mb-12 flex items-center gap-3">
                    <span className="block size-9 shrink-0 bg-current" style={{ mask: "url(/logo.svg) center / contain no-repeat", WebkitMask: "url(/logo.svg) center / contain no-repeat" }} />
                    <span className="text-sm font-semibold tracking-[0.18em]">无限画布</span>
                </div>
                {mode === "create" && workspaces.length ? <button type="button" className="mb-8 inline-flex items-center gap-2 text-sm transition-opacity hover:opacity-60" style={{ color: theme.node.muted }} onClick={() => { form.resetFields(); setError(""); setMode("select"); }}><ArrowLeft className="size-4" />返回工作区列表</button> : null}
                <header className="mb-10 sm:mb-14">
                    <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{mode === "create" ? "新建工作区" : "选择工作区"}</h1>
                    <p className="mt-3 text-sm" style={{ color: theme.node.muted }}>数据按工作区独立保存，选择后即可进入。</p>
                </header>
                {error ? <div role="alert" className="mb-6 max-w-xl rounded-md border border-red-400/40 px-4 py-3 text-sm text-red-500">{error}</div> : null}
                {loading ? null : mode === "select" ? (
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-5">
                        {workspaces.map((workspace) => {
                            const summary = summaries[workspace.id];
                            return <button key={workspace.id} type="button" className="group flex min-h-64 flex-col justify-between rounded-lg border p-6 text-left shadow-[var(--shadow-surface)] transition duration-200 hover:-translate-y-1 hover:shadow-[var(--shadow-surface-hover)] focus-visible:outline-2 focus-visible:outline-offset-2" style={{ backgroundColor: theme.node.panel, borderColor: theme.node.stroke, outlineColor: theme.node.activeStroke }} onClick={() => void enterWorkspace(workspace)}>
                            <div className="flex items-start justify-between" style={{ color: theme.node.muted }}><LayoutGrid className="size-6" strokeWidth={1.5} /><ArrowUpRight className="size-5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" /></div>
                            <div className="min-w-0 w-full">
                                <div className="break-words text-xl font-medium leading-snug" style={{ color: theme.node.text }}>{workspace.name}</div>
                                <div className="mt-5 border-t pt-4" style={{ borderColor: theme.node.stroke }}>
                                    <div className="text-xs" style={{ color: theme.node.muted }}>最近活动的画布</div>
                                    <div className="mt-1 truncate text-sm" style={{ color: theme.node.text }}>{summary?.recentCanvasTitle || (summary ? summary.canvasCount ? "暂无活动记录" : "暂无画布" : "信息暂不可用")}</div>
                                    <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs" style={{ color: theme.node.muted }}>
                                        <span className="inline-flex items-center gap-1.5"><LayoutGrid className="size-3.5" />{summary?.canvasCount ?? "—"} 个画布</span>
                                        <span className="inline-flex items-center gap-1.5"><FolderClosed className="size-3.5" />{summary?.folderCount ?? "—"} 个文件夹</span>
                                    </div>
                                </div>
                            </div>
                        </button>})}
                        <button type="button" className="flex min-h-64 flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-6 text-center transition duration-200 hover:-translate-y-1 hover:shadow-[var(--shadow-surface)] focus-visible:outline-2 focus-visible:outline-offset-2" style={{ borderColor: theme.node.stroke, color: theme.node.muted, outlineColor: theme.node.activeStroke }} onClick={() => { form.resetFields(); setError(""); setMode("create"); }}><Plus className="size-7" strokeWidth={1.5} /><span className="text-base font-medium">新建工作区</span></button>
                    </div>
                ) : <Form form={form} layout="vertical" className="max-w-md" onFinish={(values) => void create(values)}>
                    <Form.Item name="name" label="新工作区名称" rules={[{ required: true, whitespace: true, message: "请输入工作区名称" }]}><Input autoFocus maxLength={80} placeholder="例如：产品设计团队" size="large" /></Form.Item>
                    <Button type="primary" htmlType="submit" icon={<Plus className="size-4" />}>创建工作区</Button>
                </Form>}
            </main>
        </div>
    );
}

export function WorkspaceSwitcher() {
    const [open, setOpen] = useState(false);
    const [workspaces, setWorkspaces] = useState<WorkspaceAccess[]>(getKnownWorkspaces);
    const [summaries, setSummaries] = useState<Record<string, WorkspaceCanvasSummary | null>>({});
    const [loadError, setLoadError] = useState(false);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const { t } = useTranslation();
    const startAppLoading = useAppLoadingStore((state) => state.start);
    const workspace = getActiveWorkspace();

    useEffect(() => {
        if (!open) return;
        let current = true;
        const frame = window.requestAnimationFrame(() => panelRef.current?.querySelector("button")?.focus());
        void listWorkspaces().then((items) => {
            if (!current) return;
            setWorkspaces(items);
            setKnownWorkspaces(items);
        }).catch(() => { if (current) setLoadError(true); });
        void listWorkspaceCanvasSummaries().then((items) => { if (current) setSummaries(items); }).catch(() => {});
        return () => { current = false; window.cancelAnimationFrame(frame); };
    }, [open]);

    if (!workspace) return null;
    const orderedWorkspaces = [workspace, ...workspaces.filter((item) => item.id !== workspace.id)];
    const showWorkspaceGate = (create: boolean) => {
        startAppLoading();
        if (create) window.sessionStorage.setItem(CREATE_WORKSPACE_KEY, "1");
        clearActiveWorkspace();
        window.location.reload();
    };

    return <Popover
        trigger="click"
        placement="bottomRight"
        arrow={false}
        open={open}
        onOpenChange={(next) => { setOpen(next); if (next) setLoadError(false); }}
        styles={{ container: { padding: 0, width: 360, maxWidth: "calc(100vw - 24px)" } }}
        content={<div ref={panelRef} role="dialog" aria-label={t("topNav.switchWorkspace")} className="text-foreground" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); triggerRef.current?.focus(); } }}>
            <div className="px-5 pb-3 pt-5">
                <div className="text-base font-semibold">{t("topNav.switchWorkspace")}</div>
                <div className="mt-1 text-xs text-muted-foreground">{t("topNav.workspaceSelectHint")}</div>
            </div>
            {loadError ? <p role="alert" className="mx-3 mb-2 rounded-md bg-foreground/5 px-3 py-2 text-xs text-muted-foreground">{t("topNav.workspaceListError")}</p> : null}
            <div className="max-h-72 space-y-1 overflow-y-auto px-3 pb-3">
                {orderedWorkspaces.map((item) => {
                    const active = item.id === workspace.id;
                    const summary = summaries[item.id];
                    const detail = summary?.recentCanvasTitle
                        ? t("topNav.workspaceRecentCanvas", { name: summary.recentCanvasTitle })
                        : summary ? t("topNav.workspaceCounts", { canvases: summary.canvasCount, folders: summary.folderCount }) : t("topNav.workspaceInfo");
                    return <button key={item.id} type="button" className={`relative flex min-h-16 w-full items-center justify-between gap-3 rounded-lg px-4 py-3 text-left transition-colors hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-foreground ${active ? "bg-foreground/5 dark:bg-foreground/10" : ""}`} onClick={() => { if (active) { setOpen(false); return; } startAppLoading(); setActiveWorkspace(item); window.location.reload(); }}>
                        {active ? <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-foreground" aria-hidden="true" /> : null}
                        <span className="min-w-0"><span className="block truncate text-sm font-medium">{item.name}</span><span className="mt-1 block truncate text-xs text-muted-foreground">{detail}</span></span>
                        {active ? <span className="shrink-0 text-xs font-medium">{t("topNav.workspaceCurrent")}</span> : null}
                    </button>;
                })}
            </div>
            <div className="flex items-center gap-2 border-t border-border px-3 py-3">
                <button type="button" className="min-h-9 min-w-0 flex-1 rounded-md px-3 text-left text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring" onClick={() => showWorkspaceGate(false)}>{t("topNav.allWorkspaces")}</button>
                <button type="button" className="min-h-9 shrink-0 rounded-md border border-border bg-muted px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring dark:hover:bg-foreground/10" onClick={() => showWorkspaceGate(true)}>{t("topNav.newWorkspace")}</button>
            </div>
        </div>}
    >
        <button ref={triggerRef} type="button" title={workspace.name} aria-label={t("topNav.workspaceTrigger", { name: workspace.name })} aria-haspopup="dialog" aria-expanded={open} className="flex h-9 max-w-24 items-center gap-2 rounded-md border border-border bg-background px-2 text-left transition-colors hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground sm:max-w-44 sm:px-3">
            <span className="min-w-0"><span className="block whitespace-nowrap text-[10px] leading-3 text-muted-foreground">{t("topNav.currentWorkspace")}</span><span className="block truncate text-[13px] font-medium leading-4 text-foreground">{workspace.name}</span></span>
            <span className="hidden shrink-0 pl-2 text-xs text-muted-foreground sm:block">{t("topNav.switch")}</span>
        </button>
    </Popover>;
}
