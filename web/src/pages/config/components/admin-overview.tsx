import { App, Alert, Button, Input, Space, Table, Tag, Tooltip } from "antd";
import type { TableProps } from "antd";
import { LogIn, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { formatCompactBytes } from "@/lib/format";
import { setActiveWorkspace } from "@/lib/workspace";
import { getAdminOverview, setUserAdmin, type AdminOverview as AdminOverviewData, type AdminUser, type AdminWorkspace } from "@/services/api/admin";
import { useAppLoadingStore } from "@/stores/use-app-loading-store";
import { useSessionStore } from "@/stores/use-session-store";

type ColumnsType<T> = NonNullable<TableProps<T>["columns"]>;

export function AdminOverview() {
    const { t, i18n } = useTranslation();
    const { message } = App.useApp();
    const [data, setData] = useState<AdminOverviewData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [query, setQuery] = useState("");
    const [updatingUserId, setUpdatingUserId] = useState("");
    const startAppLoading = useAppLoadingStore((state) => state.start);

    const load = useCallback(async () => {
        setLoading(true);
        setError("");
        try {
            setData(await getAdminOverview());
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : t("config.admin.loadFailed"));
        } finally {
            setLoading(false);
        }
    }, [t]);

    useEffect(() => { void load(); }, [load]);

    const toggleAdmin = async (user: AdminUser) => {
        setUpdatingUserId(user.id);
        try {
            await setUserAdmin(user.id, !user.isAdmin);
            message.success(t("config.admin.adminUpdated"));
            const currentUser = useSessionStore.getState().user;
            if (currentUser?.id === user.id && user.isAdmin) {
                window.location.reload();
                return;
            }
            await load();
        } catch (reason) {
            message.error(reason instanceof Error ? reason.message : t("config.admin.adminUpdateFailed"));
        } finally {
            setUpdatingUserId("");
        }
    };

    const enterWorkspace = (workspace: AdminWorkspace) => {
        startAppLoading();
        setActiveWorkspace({ id: workspace.id, name: workspace.name, role: workspace.role, createdAt: workspace.createdAt });
        window.location.assign("/canvas");
    };

    const normalizedQuery = query.trim().toLowerCase();
    const filteredUsers = useMemo(() => (data?.users || []).filter((user) => !normalizedQuery || `${user.username} ${user.displayName}`.toLowerCase().includes(normalizedQuery)), [data, normalizedQuery]);
    const filteredWorkspaces = useMemo(() => (data?.workspaces || []).filter((workspace) => !normalizedQuery || `${workspace.name} ${workspace.owner?.username || ""} ${workspace.owner?.displayName || ""} ${workspace.recentCanvasTitle || ""}`.toLowerCase().includes(normalizedQuery)), [data, normalizedQuery]);

    const formatTime = (value: string) => new Date(value).toLocaleString(i18n.resolvedLanguage);

    const userColumns: ColumnsType<AdminUser> = [
        {
            title: t("config.admin.user"),
            key: "user",
            render: (_, user) => <div className="min-w-0">
                <div className="flex items-center gap-2 font-medium text-foreground">
                    <span className="truncate">{user.displayName}</span>
                    {user.isAdmin ? <Tag icon={<ShieldCheck className="size-3" />} color="blue">{t("config.admin.administrator")}</Tag> : null}
                    {user.envAdmin ? <Tag>{t("config.admin.envAdmin")}</Tag> : null}
                </div>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">@{user.username}</div>
            </div>,
        },
        { title: t("config.admin.workspaceCount"), dataIndex: "workspaceCount", key: "workspaceCount", width: 110, align: "right" },
        { title: t("config.admin.createdAt"), dataIndex: "createdAt", key: "createdAt", width: 190, render: (value: string) => <span className="text-muted-foreground">{formatTime(value)}</span> },
        {
            title: "",
            key: "actions",
            width: 140,
            align: "right",
            render: (_, user) => user.isAdmin ? (
                <Tooltip title={user.envAdmin ? t("config.admin.envAdminHint") : data && data.totals.admins <= 1 ? t("config.admin.lastAdminHint") : null}>
                    <Button size="small" loading={updatingUserId === user.id} disabled={user.envAdmin || Boolean(data && data.totals.admins <= 1)} onClick={() => void toggleAdmin(user)}>{t("config.admin.unsetAdmin")}</Button>
                </Tooltip>
            ) : (
                <Button size="small" loading={updatingUserId === user.id} onClick={() => void toggleAdmin(user)}>{t("config.admin.setAdmin")}</Button>
            ),
        },
    ];

    const workspaceColumns: ColumnsType<AdminWorkspace> = [
        {
            title: t("config.admin.workspace"),
            key: "workspace",
            render: (_, workspace) => <div className="min-w-0">
                <div className="truncate font-medium text-foreground">{workspace.name}</div>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">{workspace.recentCanvasTitle ? t("config.admin.recentCanvas", { name: workspace.recentCanvasTitle }) : t("config.admin.noCanvas")}</div>
            </div>,
        },
        {
            title: t("config.admin.owner"),
            key: "owner",
            width: 160,
            render: (_, workspace) => workspace.owner ? <div className="min-w-0">
                <div className="truncate">{workspace.owner.displayName}</div>
                <div className="truncate text-xs text-muted-foreground">@{workspace.owner.username}</div>
            </div> : <span className="text-muted-foreground">{t("config.admin.noOwner")}</span>,
        },
        { title: t("config.admin.members"), dataIndex: "memberCount", key: "memberCount", width: 80, align: "right" },
        {
            title: t("config.admin.content"),
            key: "content",
            width: 150,
            render: (_, workspace) => <span className="text-muted-foreground">{t("config.admin.canvasFolders", { canvases: workspace.canvasCount, folders: workspace.folderCount })}</span>,
        },
        {
            title: t("config.admin.storage"),
            key: "storage",
            width: 120,
            align: "right",
            render: (_, workspace) => formatCompactBytes(workspace.dataBytes + workspace.mediaBytes),
        },
        { title: t("config.admin.updatedAt"), dataIndex: "updatedAt", key: "updatedAt", width: 190, render: (value: string) => <span className="text-muted-foreground">{formatTime(value)}</span> },
        {
            title: "",
            key: "actions",
            width: 150,
            align: "right",
            render: (_, workspace) => <Space size={6}>
                {workspace.role === "viewer" ? <Tag>{t("config.admin.readOnly")}</Tag> : null}
                <Button size="small" type="text" icon={<LogIn className="size-3.5" />} onClick={() => enterWorkspace(workspace)}>{t("config.admin.enter")}</Button>
            </Space>,
        },
    ];

    if (error && !data) {
        return <Alert type="error" showIcon message={t("config.admin.loadFailed")} description={error} action={<Button onClick={() => void load()}>{t("common.retry")}</Button>} />;
    }

    return <div className="space-y-6 pb-10">
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
            {[
                { label: t("config.admin.totals.users"), value: data?.totals.users ?? "—" },
                { label: t("config.admin.totals.admins"), value: data?.totals.admins ?? "—" },
                { label: t("config.admin.totals.workspaces"), value: data?.totals.workspaces ?? "—" },
                { label: t("config.admin.totals.canvases"), value: data?.totals.canvases ?? "—" },
                { label: t("config.admin.totals.storage"), value: data ? formatCompactBytes(data.totals.dataBytes + data.totals.mediaBytes) : "—" },
            ].map((item) => <div key={item.label} className="rounded-lg border border-border px-4 py-3">
                <div className="text-xs text-muted-foreground">{item.label}</div>
                <div className="mt-1 text-xl font-semibold tabular-nums text-foreground">{item.value}</div>
            </div>)}
        </div>

        <div className="flex flex-wrap items-center gap-3">
            <Input allowClear className="max-w-xs" prefix={<Search className="size-4 text-muted-foreground" />} placeholder={t("config.admin.searchPlaceholder")} value={query} onChange={(event) => setQuery(event.target.value)} />
            <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void load()}>{t("config.admin.refresh")}</Button>
        </div>

        {error ? <Alert type="error" showIcon message={error} /> : null}

        <section aria-labelledby="admin-users-title">
            <div className="mb-3">
                <h2 id="admin-users-title" className="text-sm font-semibold text-foreground">{t("config.admin.users")}</h2>
                <p className="mt-1 text-xs text-muted-foreground">{t("config.admin.usersHint")}</p>
            </div>
            <Table<AdminUser> rowKey="id" size="small" loading={loading && !data} columns={userColumns} dataSource={filteredUsers} pagination={{ pageSize: 10, hideOnSinglePage: true }} scroll={{ x: 760 }} locale={{ emptyText: t("config.admin.noUsers") }} />
        </section>

        <section aria-labelledby="admin-workspaces-title">
            <div className="mb-3">
                <h2 id="admin-workspaces-title" className="text-sm font-semibold text-foreground">{t("config.admin.workspaces")}</h2>
                <p className="mt-1 text-xs text-muted-foreground">{t("config.admin.workspacesHint")}</p>
            </div>
            <Table<AdminWorkspace> rowKey="id" size="small" loading={loading && !data} columns={workspaceColumns} dataSource={filteredWorkspaces} pagination={{ pageSize: 10, hideOnSinglePage: true }} scroll={{ x: 1080 }} locale={{ emptyText: t("config.admin.noWorkspaces") }} />
        </section>
    </div>;
}
