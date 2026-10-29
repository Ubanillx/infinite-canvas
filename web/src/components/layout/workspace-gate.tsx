import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Button, Form, Input, Popover } from "antd";
import { ArrowLeft, ArrowUpRight, Check, FolderClosed, LayoutGrid, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { WorkspaceAmbientBackground } from "@/components/layout/workspace-ambient-background";
import { WorkspaceAccountForm } from "@/components/layout/workspace-account-form";
import { getWorkspaceSession } from "@/services/api/workspace-auth";
import { canvasThemes } from "@/lib/canvas-theme";
import { clearActiveWorkspace, getActiveWorkspace, getKnownWorkspaces, migrateLegacyDataToWorkspace, setActiveWorkspace, setKnownWorkspaces, type WorkspaceAccess } from "@/lib/workspace";
import { migrateWorkspaceMedia } from "@/services/workspace-media";
import { listWorkspaceCanvasSummaries, type WorkspaceCanvasSummary } from "@/services/api/workspace-summaries";
import { createWorkspace, listWorkspaces } from "@/services/workspace";
import { useThemeStore } from "@/stores/use-theme-store";
import { useAppLoadingStore } from "@/stores/use-app-loading-store";

type GateMode = "select" | "create" | "account";
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
                const session = await getWorkspaceSession();
                if (!current) return;
                if (!session.user) { setMode("account"); return; }
                const available = await listWorkspaces();
                if (!current) return;
                setKnownWorkspaces(available);
                setWorkspaces(available);
                const active = getActiveWorkspace();
                const listed = available.find((item) => item.id === active?.id);
                if (listed) {
                    setActiveWorkspace(listed);
                    await migrateLegacyDataToWorkspace(listed);
                    await migrateWorkspaceMedia();
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
            await migrateWorkspaceMedia();
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
                    <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{mode === "account" ? "登录工作区" : mode === "create" ? "新建工作区" : "选择工作区"}</h1>
                    <p className="mt-3 text-sm" style={{ color: theme.node.muted }}>数据按工作区独立保存，选择后即可进入。</p>
                </header>
                {error ? <div role="alert" className="mb-6 max-w-xl rounded-md border border-red-400/40 px-4 py-3 text-sm text-red-500">{error}</div> : null}
                {loading ? null : mode === "account" ? <WorkspaceAccountForm /> : mode === "select" ? (
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
        styles={{ container: { padding: 0, width: 300, maxWidth: "calc(100vw - 24px)" } }}
        content={<div ref={panelRef} role="dialog" aria-label={t("topNav.switchWorkspace")} className="text-foreground" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); triggerRef.current?.focus(); } }}>
            <div className="px-4 pb-2 pt-4 text-sm font-medium">{t("topNav.switchWorkspace")}</div>
            {loadError ? <p role="alert" className="mx-2 mb-2 rounded-md bg-foreground/5 px-3 py-2 text-xs text-muted-foreground">{t("topNav.workspaceListError")}</p> : null}
            <div className="max-h-64 space-y-0.5 overflow-y-auto px-2">
                {orderedWorkspaces.map((item) => {
                    const active = item.id === workspace.id;
                    const summary = summaries[item.id];
                    const detail = summary?.recentCanvasTitle
                        ? t("topNav.workspaceRecentCanvas", { name: summary.recentCanvasTitle })
                        : summary ? t("topNav.workspaceCounts", { canvases: summary.canvasCount, folders: summary.folderCount }) : t("topNav.workspaceInfo");
                    return <button key={item.id} type="button" aria-current={active ? "true" : undefined} className={`flex min-h-14 w-full items-center justify-between gap-3 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-foreground ${active ? "bg-foreground/5 dark:bg-foreground/10" : ""}`} onClick={() => { if (active) { setOpen(false); return; } startAppLoading(); setActiveWorkspace(item); window.location.reload(); }}>
                        <span className="min-w-0"><span className="block truncate text-sm font-medium">{item.name}</span><span className="mt-1 block truncate text-xs text-muted-foreground">{detail}</span></span>
                        {active ? <><Check className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /><span className="sr-only">{t("topNav.workspaceCurrent")}</span></> : null}
                    </button>;
                })}
            </div>
            <div className="flex items-center gap-1 px-2 pb-2 pt-2">
                <button type="button" className="min-h-9 min-w-0 flex-1 rounded-md px-3 text-left text-xs text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-foreground" onClick={() => showWorkspaceGate(false)}>{t("topNav.allWorkspaces")}</button>
                <button type="button" className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-md bg-foreground/5 px-3 text-xs font-medium text-foreground transition-colors hover:bg-foreground/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground" onClick={() => showWorkspaceGate(true)}><Plus className="size-3.5" />{t("topNav.newWorkspace")}</button>
            </div>
        </div>}
    >
        <button ref={triggerRef} type="button" title={workspace.name} aria-label={t("topNav.workspaceTrigger", { name: workspace.name })} aria-haspopup="dialog" aria-expanded={open} className="inline-flex h-8 max-w-28 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-foreground transition-colors hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground sm:max-w-40">
            <span className="truncate">{workspace.name}</span>
        </button>
    </Popover>;
}
