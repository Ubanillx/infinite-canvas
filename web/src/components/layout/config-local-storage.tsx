import { Alert, Button, Spin } from "antd";
import { Cloud, Database, HardDrive, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { getActiveWorkspace } from "@/lib/workspace";
import { readWorkspaceStorageSummary, type WorkspaceStorageSummary } from "@/services/api/workspace-storage";
import { readLocalStorageUsage, type IndexedDbStoreUsage, type LocalStorageUsage } from "@/services/local-storage-usage";
import { getWorkspaceDataError, subscribeWorkspaceDataError } from "@/services/workspace-data";

const domainKeys: Record<string, string> = {
    canvas: "canvas",
    assets: "assets",
    "image-workbench": "imageWorkbench",
    "video-workbench": "videoWorkbench",
    "agent-sessions": "agentSessions",
};
type LocalGroup = "prompt" | "previews" | "workspace" | "other";

export function ConfigLocalStorage({ active }: { active: boolean }) {
    const { i18n, t } = useTranslation();
    const workspace = getActiveWorkspace();
    const workspaceError = useSyncExternalStore(subscribeWorkspaceDataError, getWorkspaceDataError);
    const [server, setServer] = useState<WorkspaceStorageSummary | null>(null);
    const [local, setLocal] = useState<LocalStorageUsage | null>(null);
    const [serverError, setServerError] = useState("");
    const [localError, setLocalError] = useState("");
    const [loading, setLoading] = useState(false);
    const [loaded, setLoaded] = useState(false);

    const refresh = useCallback(async () => {
        setLoading(true);
        setServerError("");
        setLocalError("");
        const [serverResult, localResult] = await Promise.allSettled([readWorkspaceStorageSummary(), readLocalStorageUsage()]);
        if (serverResult.status === "fulfilled") setServer(serverResult.value);
        else { setServer(null); setServerError(serverResult.reason instanceof Error ? serverResult.reason.message : t("config.localStorage.serverReadFailed")); }
        if (localResult.status === "fulfilled") setLocal(localResult.value);
        else { setLocal(null); setLocalError(localResult.reason instanceof Error ? localResult.reason.message : t("config.localStorage.readFailed")); }
        setLoading(false);
        setLoaded(true);
    }, [t]);

    useEffect(() => { if (active && !loaded) void refresh(); }, [active, loaded, refresh]);

    const serverBytes = server ? server.domains.reduce((sum, domain) => sum + domain.bytes, server.media.bytes) : 0;
    const latestSave = server?.domains.reduce((latest, domain) => domain.updatedAt > latest ? domain.updatedAt : latest, server.media.updatedAt || "") || "";
    const stores = local?.databases.flatMap((database) => database.stores) || [];
    const groups = groupLocalStores(stores, workspace?.id || "");
    const quotaPercent = local?.quota ? Math.min(100, (local.usage / local.quota) * 100) : 0;

    return <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{t("config.localStorage.overview")}</p>
            <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void refresh()}>{t("config.localStorage.refresh")}</Button>
        </div>

        <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                    <div className="rounded-lg bg-foreground/5 p-2.5"><Cloud className="size-5" /></div>
                    <div>
                        <h2 className="text-base font-semibold">{t("config.localStorage.serverTitle")}</h2>
                        <p className="mt-1 text-xs text-muted-foreground">{workspace?.name || t("config.localStorage.currentWorkspace")} · {t("config.localStorage.serverHint")}</p>
                    </div>
                </div>
                {server ? <div className="text-right"><div className="text-xl font-semibold tabular-nums">{formatStorageBytes(serverBytes)}</div><div className="text-xs text-muted-foreground">{t("config.localStorage.serverTotal")}</div></div> : null}
            </div>
            {serverError ? <Alert className="mt-4" type="error" showIcon message={t("config.localStorage.serverReadFailed")} description={serverError} /> : null}
            {workspaceError?.key.startsWith(`${workspace?.id}:`) && workspaceError.mode !== "read" ? <Alert className="mt-4" type="error" showIcon message={t("config.localStorage.unsavedChanges")} description={workspaceError.message} /> : null}
            {!server && loading ? <div className="flex min-h-28 items-center justify-center"><Spin /></div> : null}
            {server ? <>
                <div className="mt-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {Object.keys(domainKeys).map((domain) => {
                        const data = server.domains.find((item) => item.domain === domain);
                        return <StorageTile key={domain} label={t(`config.localStorage.domains.${domainKeys[domain]}`)} value={formatStorageBytes(data?.bytes || 0)} detail={data ? t("config.localStorage.revision", { count: data.revision }) : t("config.localStorage.noServerData")} />;
                    })}
                    <StorageTile label={t("config.localStorage.domains.media")} value={formatStorageBytes(server.media.bytes)} detail={t("config.localStorage.files", { count: server.media.files })} />
                </div>
                <p className="mt-4 text-xs text-muted-foreground">{t("config.localStorage.lastSaved")}{latestSave ? new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(new Date(latestSave)) : t("config.localStorage.neverSaved")}</p>
            </> : null}
        </section>

        <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                    <div className="rounded-lg bg-foreground/5 p-2.5"><Database className="size-5" /></div>
                    <div>
                        <h2 className="text-base font-semibold">{t("config.localStorage.browserTitle")}</h2>
                        <p className="mt-1 text-xs text-muted-foreground">{t("config.localStorage.browserHint")}</p>
                    </div>
                </div>
                {local ? <div className="text-right"><div className="text-xl font-semibold tabular-nums">{formatStorageBytes(local.contentBytes)}</div><div className="text-xs text-muted-foreground">{t("config.localStorage.contentEstimate")}</div></div> : null}
            </div>
            {localError ? <Alert className="mt-4" type="error" showIcon message={t("config.localStorage.readFailed")} description={localError} /> : null}
            {!local && loading ? <div className="flex min-h-28 items-center justify-center"><Spin /></div> : null}
            {local ? <>
                <div className="mt-5 grid gap-2 sm:grid-cols-2">
                    {(["prompt", "previews", "workspace", "other"] as LocalGroup[]).map((group) => <StorageTile key={group} label={t(`config.localStorage.groups.${group}`)} value={formatStorageBytes(groups[group].bytes)} detail={t("config.localStorage.records", { count: groups[group].records })} />)}
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-border pt-4 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5"><HardDrive className="size-3.5" />{t("config.localStorage.siteUsage")}: {formatStorageBytes(local.usage)}</span>
                    <span>{t("config.localStorage.quota")}: {local.quota ? formatStorageBytes(local.quota) : t("config.localStorage.quotaUnavailable")}</span>
                    {local.quota ? <span>{t("config.localStorage.quotaProgress")}: {quotaPercent.toFixed(2)}%</span> : null}
                </div>
                <details className="mt-4 border-t border-border pt-4 text-sm">
                    <summary className="cursor-pointer font-medium text-foreground marker:text-muted-foreground">{t("config.localStorage.technicalDetails")}</summary>
                    <div className="mt-3 divide-y divide-border rounded-lg border border-border">
                        {stores.map((store) => <div key={store.name} className="flex items-center justify-between gap-4 px-3 py-2.5">
                            <span className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={store.name}>{store.name}</span>
                            <span className="shrink-0 text-xs tabular-nums">{t("config.localStorage.records", { count: store.records })} · {formatStorageBytes(store.bytes)}</span>
                        </div>)}
                    </div>
                </details>
            </> : null}
        </section>
    </div>;
}

function StorageTile({ label, value, detail }: { label: string; value: string; detail: string }) {
    return <div className="rounded-lg bg-foreground/5 px-3 py-3 dark:bg-foreground/10">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="mt-1 text-base font-semibold tabular-nums">{value}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{detail}</div>
    </div>;
}

function groupLocalStores(stores: IndexedDbStoreUsage[], workspaceId: string) {
    const groups: Record<LocalGroup, { bytes: number; records: number }> = {
        prompt: { bytes: 0, records: 0 }, previews: { bytes: 0, records: 0 }, workspace: { bytes: 0, records: 0 }, other: { bytes: 0, records: 0 },
    };
    for (const store of stores) {
        const current = Boolean(workspaceId) && store.name.startsWith(`workspace_${workspaceId}_`);
        const group: LocalGroup = store.name === "prompt_cache" ? "prompt" : (current && store.name.endsWith("_image_previews")) || store.name === "image_previews" ? "previews" : current ? "workspace" : "other";
        groups[group].bytes += store.bytes;
        groups[group].records += store.records;
    }
    return groups;
}

function formatStorageBytes(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
