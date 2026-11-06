import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Form, Input, InputNumber, Select, Switch, Tag } from "antd";
import type { TFunction } from "i18next";
import { CloudUpload, Download, RefreshCw, Square, Wifi } from "lucide-react";
import { useTranslation } from "react-i18next";

import { formatCompactBytes } from "@/lib/format";
import { cancelBackup, getBackupSnapshot, getBackupStatus, getWorkspaceBackupBlockers, listBackupRuns, listBackupSnapshots, releaseWorkspaceBackupIntents, saveBackupSettings, startBackup, startBackupRestore, testBackupConnection, type BackupManifest, type BackupRun, type BackupSettings, type BackupStatus, type SnapshotSummary, type WorkspaceBlocker } from "@/services/api/admin-backup";
import { saveServerConfigNow } from "@/services/server-config";
import { useConfigStore } from "@/stores/use-config-store";

export function ConfigBackup({ visible = true }: { visible?: boolean }) {
    const { t, i18n } = useTranslation();
    const { message, modal } = App.useApp();
    const webdav = useConfigStore((state) => state.webdav);
    const updateWebdavConfig = useConfigStore((state) => state.updateWebdavConfig);
    const [status, setStatus] = useState<BackupStatus | null>(null);
    const [statusError, setStatusError] = useState("");
    const [settingsDraft, setSettingsDraft] = useState<BackupSettings | null>(null);
    const [passwordDraft, setPasswordDraft] = useState("");
    const [testing, setTesting] = useState(false);
    const [busy, setBusy] = useState(false);
    const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
    const [snapshotError, setSnapshotError] = useState("");
    const [selectedSource, setSelectedSource] = useState<"snapshots" | "safety">("snapshots");
    const [selectedSnapshot, setSelectedSnapshot] = useState("");
    const [manifest, setManifest] = useState<BackupManifest | null>(null);
    const [selectedWorkspace, setSelectedWorkspace] = useState("");
    const [blockers, setBlockers] = useState<WorkspaceBlocker[]>([]);
    const [blockersError, setBlockersError] = useState("");
    const [blockersLoaded, setBlockersLoaded] = useState(false);
    const [runs, setRuns] = useState<BackupRun[]>([]);
    const [runsLoaded, setRunsLoaded] = useState(false);
    const [loadingSnapshots, setLoadingSnapshots] = useState(false);
    const [snapshotsLoaded, setSnapshotsLoaded] = useState(false);
    const [savingSettings, setSavingSettings] = useState(false);
    const [cancelling, setCancelling] = useState(false);
    const [restoring, setRestoring] = useState(false);
    const snapshotRequest = useRef(0);
    const blockerRequest = useRef(0);
    const lastActiveRun = useRef<string | null>(null);
    const locale = i18n.resolvedLanguage === "en-US" ? "en-US" : "zh-CN";

    useEffect(() => {
        if (!visible) return;
        let mounted = true;
        const load = async () => {
            try {
                const next = await getBackupStatus();
                if (!mounted) return;
                setStatus(next);
                setStatusError("");
                setSettingsDraft((current) => current || next.settings);
            } catch (error) {
                if (mounted) setStatusError(error instanceof Error ? error.message : t("config.webdav.backup.taskFailed"));
            }
        };
        void load();
        void listBackupRuns().then((result) => { if (mounted) { setRuns(result.items); setRunsLoaded(true); } }).catch(() => undefined);
        const timer = window.setInterval(() => void load(), 3000);
        return () => { mounted = false; window.clearInterval(timer); };
    }, [t, visible]);

    useEffect(() => {
        const runId = status?.active?.runId || null;
        if (lastActiveRun.current && !runId) void listBackupRuns().then((result) => { setRuns(result.items); setRunsLoaded(true); }).catch(() => undefined);
        lastActiveRun.current = runId;
    }, [status?.active?.runId]);

    const refreshStatus = async () => {
        try { setStatus(await getBackupStatus()); } catch (error) { setStatusError(error instanceof Error ? error.message : t("config.webdav.backup.taskFailed")); }
    };
    const refreshRuns = async () => {
        try { setRuns((await listBackupRuns()).items); setRunsLoaded(true); } catch { /* 运行记录失败不阻断 */ }
    };
    const webdavReady = Boolean(webdav.url.trim() && webdav.username.trim() && (webdav.hasPassword || webdav.password || passwordDraft));

    const testConnection = async () => {
        setTesting(true);
        try {
            await saveServerConfigNow();
            await testBackupConnection();
            message.success(t("config.webdav.available"));
            await refreshStatus();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("config.webdav.testFailed"));
        } finally {
            setTesting(false);
        }
    };

    const runBackup = async () => {
        setBusy(true);
        try {
            await saveServerConfigNow();
            const latest = await getBackupStatus();
            setStatus(latest);
            if (!latest.configured) { message.warning(t("config.webdav.backup.connectFirst")); return; }
            await startBackup();
            message.success(t("config.webdav.backup.taskStarted"));
            await refreshStatus();
            await refreshRuns();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("config.webdav.backup.taskFailed"));
        } finally {
            setBusy(false);
        }
    };

    const cancelTask = async () => {
        setCancelling(true);
        try {
            await cancelBackup();
            message.info(t("config.webdav.backup.cancelling"));
            await refreshStatus();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("config.webdav.backup.taskFailed"));
        } finally {
            setCancelling(false);
        }
    };

    const saveSettings = async () => {
        if (!settingsDraft) return;
        setSavingSettings(true);
        try {
            const next = await saveBackupSettings(settingsDraft);
            setSettingsDraft(next);
            message.success(t("config.webdav.backup.settingsSaved"));
            await refreshStatus();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("config.webdav.backup.taskFailed"));
        } finally {
            setSavingSettings(false);
        }
    };

    const loadSnapshots = async () => {
        setLoadingSnapshots(true);
        setSnapshotError("");
        try {
            snapshotRequest.current += 1;
            blockerRequest.current += 1;
            const result = await listBackupSnapshots();
            setSnapshots(result.items);
            setSnapshotsLoaded(true);
            setSelectedSnapshot("");
            setSelectedSource("snapshots");
            setManifest(null);
            setSelectedWorkspace("");
            setBlockers([]);
            setBlockersLoaded(false);
            setBlockersError("");
        } catch (error) {
            setSnapshotError(error instanceof Error ? error.message : t("config.webdav.backup.restoreFailed"));
        } finally {
            setLoadingSnapshots(false);
        }
    };

    const selectSnapshot = async (value: string) => {
        const item = snapshots.find((snapshot) => `${snapshot.source}:${snapshot.id}` === value);
        if (!item) return;
        const requestId = ++snapshotRequest.current;
        blockerRequest.current += 1;
        setSelectedSnapshot(item.id);
        setSelectedSource(item.source);
        setManifest(null);
        setSelectedWorkspace("");
        setBlockers([]);
        setBlockersLoaded(false);
        setBlockersError("");
        try {
            const next = await getBackupSnapshot(item.source, item.id);
            if (requestId === snapshotRequest.current) setManifest(next);
        } catch (error) {
            if (requestId !== snapshotRequest.current) return;
            setSelectedSnapshot("");
            setManifest(null);
            message.error(error instanceof Error ? error.message : t("config.webdav.backup.restoreFailed"));
        }
    };

    const selectWorkspace = async (workspaceId: string) => {
        const requestId = ++blockerRequest.current;
        setSelectedWorkspace(workspaceId);
        setBlockers([]);
        setBlockersLoaded(false);
        setBlockersError("");
        if (!workspaceId) return;
        try {
            const result = await getWorkspaceBackupBlockers(workspaceId);
            if (requestId !== blockerRequest.current) return;
            setBlockers(result.items);
            setBlockersLoaded(true);
        } catch (error) {
            if (requestId !== blockerRequest.current) return;
            setBlockersError(error instanceof Error ? error.message : t("config.webdav.backup.blockersError"));
        }
    };

    const confirmRestore = () => {
        const workspace = manifest?.workspaces.find((item) => item.id === selectedWorkspace);
        if (!manifest || !workspace || !selectedSnapshot || status?.active) return;
        modal.confirm({
            title: t("config.webdav.backup.restoreConfirmTitle"),
            content: t("config.webdav.backup.restoreConfirmText", { name: workspace.name }),
            okText: t("config.webdav.backup.confirm"),
            cancelText: t("common.cancel"),
            okButtonProps: { danger: true },
            onOk: async () => {
                setRestoring(true);
                try {
                    await startBackupRestore(selectedSnapshot, workspace.id, selectedSource);
                    message.success(t("config.webdav.backup.restoreStarted"));
                    await refreshStatus();
                    await refreshRuns();
                } catch (error) {
                    message.error(error instanceof Error ? error.message : t("config.webdav.backup.restoreFailed"));
                    throw error;
                } finally {
                    setRestoring(false);
                }
            },
        });
    };

    const releaseIntents = () => {
        if (!selectedWorkspace || !blockers.length) return;
        modal.confirm({
            title: t("config.webdav.backup.releaseIntents"),
            content: t("config.webdav.backup.releaseConfirm"),
            okText: t("config.webdav.backup.releaseIntents"),
            cancelText: t("common.cancel"),
            okButtonProps: { danger: true },
            onOk: async () => {
                try {
                    const result = await releaseWorkspaceBackupIntents(selectedWorkspace, blockers.map((item) => item.intentId));
                    message.success(t("config.webdav.backup.released", { count: result.released }));
                    setBlockers([]);
                } catch (error) {
                    message.error(error instanceof Error ? error.message : t("config.webdav.backup.taskFailed"));
                    throw error;
                }
            },
        });
    };

    const active = status?.active;
    const progressText = active ? `${active.progress.current}/${active.progress.total}` : "";
    const snapshotOptions = snapshots.map((snapshot) => ({ value: `${snapshot.source}:${snapshot.id}`, label: t("config.webdav.backup.snapshotLabel", { time: formatTime(snapshot.createdAt, locale), source: t(snapshot.source === "safety" ? "config.webdav.backup.sourceSafety" : "config.webdav.backup.sourceRegular"), status: t(snapshot.status === "complete" ? "config.webdav.backup.statusComplete" : "config.webdav.backup.statusPartial") }) }));
    const workspaceOptions = manifest?.workspaces.map((workspace) => ({ value: workspace.id, disabled: workspace.status !== "complete", label: `${workspace.name}${workspace.status === "incomplete" ? ` · ${t("config.webdav.backup.workspaceIncomplete")}` : ""}` })) || [];
    const selectedWorkspaceManifest = manifest?.workspaces.find((workspace) => workspace.id === selectedWorkspace);

    return (
        <div className="space-y-5">
            <section className="rounded-xl border border-border p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <h2 className="text-sm font-semibold">{t("config.webdav.connectionTitle")}</h2>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("config.webdav.connectionDescription")}</p>
                    </div>
                    <Tag color={status?.configured ? "green" : "default"}>{t(status?.configured ? "config.webdav.backup.connectionReady" : "config.webdav.backup.connectionMissing")}</Tag>
                </div>
                <Form layout="vertical" requiredMark={false} className="mt-5 grid gap-x-5 gap-y-3 sm:grid-cols-2">
                    <Form.Item label={t("config.webdav.url")} className="mb-0 sm:col-span-2">
                        <Input value={webdav.url} placeholder={t("config.webdav.urlPlaceholder")} onChange={(event) => updateWebdavConfig("url", event.target.value)} />
                    </Form.Item>
                    <Form.Item label={t("config.webdav.directory")} className="mb-0 sm:col-span-2">
                        <Input value={webdav.directory} placeholder={t("config.webdav.directoryPlaceholder")} onChange={(event) => updateWebdavConfig("directory", event.target.value)} />
                    </Form.Item>
                    <Form.Item label={t("config.webdav.username")} className="mb-0">
                        <Input value={webdav.username} autoComplete="username" placeholder={t("config.webdav.usernamePlaceholder")} onChange={(event) => updateWebdavConfig("username", event.target.value)} />
                    </Form.Item>
                    <Form.Item label={t("config.webdav.password")} className="mb-0">
                        <Input.Password value={passwordDraft} autoComplete="new-password" placeholder={webdav.hasPassword ? t("config.webdav.passwordConfigured") : t("config.webdav.passwordPlaceholder")} onChange={(event) => setPasswordDraft(event.target.value)} onBlur={() => { if (passwordDraft) updateWebdavConfig("password", passwordDraft); setPasswordDraft(""); }} />
                    </Form.Item>
                </Form>
                <p className="mt-3 text-xs leading-5 text-muted-foreground">{t("config.webdav.passwordWriteOnly")}</p>
                <div className="mt-4 flex flex-wrap gap-2">
                    <Button icon={<Wifi className="size-4" />} loading={testing} disabled={!webdavReady || testing} onClick={() => void testConnection()}>{t("config.webdav.test")}</Button>
                </div>
            </section>

            <div className="grid items-start gap-5 lg:grid-cols-2">
                <section className="rounded-xl border border-border p-5">
                    <h2 className="text-sm font-semibold">{t("config.webdav.backup.title")}</h2>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("config.webdav.backup.description")}</p>
                    <p className="mt-3 rounded-md bg-foreground/[0.04] px-3 py-2 text-xs leading-5 text-muted-foreground">{t("config.webdav.backup.scopeNotice")}</p>
                    <p className="mt-4 text-xs text-muted-foreground">{status?.lastRun ? t("config.webdav.backup.lastRun", { status: runStatusLabel(status.lastRun.status, t), time: formatTime(status.lastRun.finishedAt || status.lastRun.startedAt, locale) }) : t("config.webdav.backup.neverRun")}</p>
                    {statusError ? <Alert className="mt-3" type="error" showIcon message={statusError} /> : null}
                    {active ? (
                        <div className="mt-4 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
                            <div className="flex items-center justify-between gap-3"><span>{active.kind === "restore" ? t("config.webdav.backup.runRestore") : t("config.webdav.backup.running")}</span><span className="tabular-nums">{progressText}</span></div>
                            <div className="mt-1 tabular-nums">{t("config.webdav.backup.files", { count: active.progress.uploadedFiles })} · {formatCompactBytes(active.progress.uploadedBytes)}</div>
                        </div>
                    ) : null}
                    <div className="mt-4 flex flex-wrap gap-2">
                        <Button type="primary" icon={<CloudUpload className="size-4" />} disabled={Boolean(active) || !status?.configured} loading={busy} onClick={() => void runBackup()}>{t("config.webdav.backup.runNow")}</Button>
                        {active ? <Button icon={<Square className="size-3.5" />} loading={cancelling} onClick={() => void cancelTask()}>{t("config.webdav.backup.cancel")}</Button> : null}
                    </div>
                    <h3 className="mt-6 text-xs font-semibold">{t("config.webdav.backup.settingsTitle")}</h3>
                    {settingsDraft ? <div className="mt-3 space-y-3">
                        <label className="flex items-center justify-between gap-4 text-sm"><span>{t("config.webdav.backup.enabled")}</span><Switch checked={settingsDraft.enabled} onChange={(enabled) => setSettingsDraft({ ...settingsDraft, enabled })} /></label>
                        <label className="flex items-center justify-between gap-4 text-sm"><span>{t("config.webdav.backup.interval")}</span><InputNumber className="w-28" min={60} max={10080} value={settingsDraft.intervalMinutes} onChange={(value) => setSettingsDraft({ ...settingsDraft, intervalMinutes: Number(value || 60) })} /></label>
                        <label className="flex items-center justify-between gap-4 text-sm"><span>{t("config.webdav.backup.retention")}</span><InputNumber className="w-28" min={1} max={100} value={settingsDraft.retention} onChange={(value) => setSettingsDraft({ ...settingsDraft, retention: Number(value || 1) })} /></label>
                        <label className="flex items-center justify-between gap-4 text-sm"><span>{t("config.webdav.backup.safetyRetention")}</span><InputNumber className="w-28" min={1} max={20} value={settingsDraft.safetyRetention} onChange={(value) => setSettingsDraft({ ...settingsDraft, safetyRetention: Number(value || 1) })} /></label>
                        <Button icon={<RefreshCw className="size-4" />} loading={savingSettings} onClick={() => void saveSettings()}>{t("config.webdav.backup.saveSettings")}</Button>
                    </div> : null}
                </section>

                <section className="rounded-xl border border-border p-5">
                    <h2 className="text-sm font-semibold">{t("config.webdav.backup.snapshotsTitle")}</h2>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("config.webdav.backup.snapshotsDescription")}</p>
                    <Button className="mt-4" icon={<Download className="size-4" />} disabled={!status?.configured || loadingSnapshots} loading={loadingSnapshots} onClick={() => void loadSnapshots()}>{t("config.webdav.backup.loadSnapshots")}</Button>
                    {snapshotError ? <Alert className="mt-3" type="error" showIcon message={snapshotError} /> : null}
                    {snapshots.length ? <Select className="mt-3 w-full" value={selectedSnapshot ? `${selectedSource}:${selectedSnapshot}` : undefined} options={snapshotOptions} onChange={(value) => void selectSnapshot(value)} placeholder={t("config.webdav.backup.snapshotsTitle")} /> : null}
                    {!snapshots.length && !loadingSnapshots ? <p className="mt-3 text-xs text-muted-foreground">{t(snapshotsLoaded ? "config.webdav.backup.noSnapshots" : "config.webdav.backup.snapshotsNotLoaded")}</p> : null}
                    {manifest ? <div className="mt-4 space-y-3">
                        <Select className="w-full" value={selectedWorkspace || undefined} options={workspaceOptions} onChange={(value) => void selectWorkspace(value)} placeholder={t("config.webdav.backup.workspaceTitle")} />
                        {selectedWorkspaceManifest ? <div className="rounded-md border border-border px-3 py-2 text-xs leading-5 text-muted-foreground">
                            <div>{t("config.webdav.backup.workspaceLabel", { name: selectedWorkspaceManifest.name })}</div>
                            {selectedWorkspaceManifest.errors.length ? <div className="mt-1 break-words text-destructive">{t("config.webdav.backup.workspaceErrors", { errors: selectedWorkspaceManifest.errors.join("; ") })}</div> : null}
                            {selectedWorkspaceManifest.media.externalMedia ? <div className="mt-1">{t("config.webdav.backup.externalMedia", { count: selectedWorkspaceManifest.media.externalMedia })}</div> : null}
                            <div className="mt-1 break-words tabular-nums">{t("config.webdav.backup.workspaceSummary", { media: selectedWorkspaceManifest.media.count, bytes: formatCompactBytes(selectedWorkspaceManifest.media.bytes), prompts: selectedWorkspaceManifest.prompts.count })}</div>
                        </div> : null}
                        <div className="flex flex-wrap gap-2">
                            <Button danger icon={<Download className="size-4" />} disabled={!selectedWorkspace || selectedWorkspaceManifest?.status !== "complete" || blockers.length > 0 || Boolean(blockersError) || Boolean(status?.active) || restoring} loading={restoring} onClick={confirmRestore}>{t("config.webdav.backup.restore")}</Button>
                            <Button disabled={!selectedWorkspace} onClick={() => void selectWorkspace(selectedWorkspace)}>{t("config.webdav.backup.checkBlockers")}</Button>
                        </div>
                        {selectedWorkspace ? <div className="rounded-md border border-border px-3 py-2 text-xs leading-5 text-muted-foreground">
                            <div className="font-medium">{t("config.webdav.backup.blockersTitle")}</div>
                            {blockersError ? <div className="mt-1 text-destructive">{blockersError}</div> : !blockersLoaded ? <div className="mt-1">{t("config.webdav.backup.blockersLoading")}</div> : blockers.length ? <>
                                <div className="mt-1 space-y-1">{blockers.map((blocker) => <div key={blocker.intentId} className="min-w-0 break-all">{blocker.storageKey} · {blocker.operation} · {formatTime(blocker.createdAt, locale)}</div>)}</div>
                                <Button className="mt-2" size="small" danger icon={<Square className="size-3.5" />} onClick={releaseIntents}>{t("config.webdav.backup.releaseIntents")}</Button>
                            </> : <div className="mt-1">{t("config.webdav.backup.noBlockers")}</div>}
                        </div> : null}
                    </div> : null}
                    {manifest && !manifest.workspaces.some((workspace) => workspace.status === "complete") ? <p className="mt-3 text-xs text-muted-foreground">{t("config.webdav.backup.noWorkspace")}</p> : null}
                </section>
            </div>

            <section className="rounded-xl border border-border p-5">
                <h2 className="text-sm font-semibold">{t("config.webdav.backup.runsTitle")}</h2>
                <div className="mt-3 space-y-2">
                    {runs.slice(0, 8).map((run) => <div key={run.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-xs">
                        <span className="flex items-center gap-2">
                            <Tag color={run.status === "succeeded" ? "green" : run.status === "failed" ? "red" : run.status === "partial" ? "orange" : run.status === "cancelled" ? "default" : "blue"}>{runStatusLabel(run.status, t)}</Tag>
                            <span>{run.kind === "restore" ? t("config.webdav.backup.runRestore") : t("config.webdav.backup.runBackup")}</span>
                            <span className="min-w-0 break-all text-muted-foreground">{run.backupId || run.workspaceId || ""}</span>
                        </span>
                        <span className="min-w-0 break-words text-muted-foreground">{formatTime(run.finishedAt || run.startedAt, locale)}{run.error ? ` · ${run.error}` : ""}</span>
                    </div>)}
                    {runsLoaded && !runs.length ? <p className="text-xs text-muted-foreground">{t("config.webdav.backup.neverRun")}</p> : null}
                </div>
            </section>
        </div>
    );
}

function runStatusLabel(status: BackupRun["status"], t: TFunction) {
    if (status === "succeeded") return t("config.webdav.backup.statusSucceeded");
    if (status === "partial") return t("config.webdav.backup.statusPartialRun");
    if (status === "failed") return t("config.webdav.backup.statusFailed");
    if (status === "cancelled") return t("config.webdav.backup.statusCancelled");
    return t("config.webdav.backup.statusRunning");
}

function formatTime(value: string, locale: string) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return value;
    return new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(date);
}
