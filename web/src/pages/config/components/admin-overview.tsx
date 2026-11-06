import { App, Alert, Button, Dropdown, Input, Pagination, Table, Tag, Tooltip } from "antd";
import type { MenuProps, TableProps } from "antd";
import { ChevronDown, Folder, LogIn, RefreshCw, Search, ShieldCheck, ShieldOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { formatCompactBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { setActiveWorkspace } from "@/lib/workspace";
import { getAdminOverview, setUserAdmin, type AdminOverview as AdminOverviewData, type AdminUser, type AdminWorkspace } from "@/services/api/admin";
import { useAppLoadingStore } from "@/stores/use-app-loading-store";
import { useSessionStore } from "@/stores/use-session-store";

type ColumnsType<T> = NonNullable<TableProps<T>["columns"]>;
type AdminTab = "users" | "workspaces";
type UserFilter = "all" | "admins" | "members";

const PAGE_SIZE = 10;
const tableClassName = "[&_.ant-table-thead>tr>th]:!bg-transparent [&_.ant-table-thead>tr>th]:!text-xs [&_.ant-table-thead>tr>th]:!font-medium [&_.ant-table-thead>tr>th]:!text-muted-foreground [&_.ant-table-tbody>tr>td]:!py-1.5";

function avatarLabel(user: AdminUser) {
    return Array.from(user.displayName.trim() || user.username)[0]?.toUpperCase() || "?";
}

function pageRange(total: number, page: number) {
    return { from: (page - 1) * PAGE_SIZE + 1, to: Math.min(page * PAGE_SIZE, total) };
}

export function AdminOverview() {
    const { t, i18n } = useTranslation();
    const { message } = App.useApp();
    const currentUserId = useSessionStore((state) => state.user?.id);
    const [data, setData] = useState<AdminOverviewData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [query, setQuery] = useState("");
    const [activeTab, setActiveTab] = useState<AdminTab>("users");
    const [userFilter, setUserFilter] = useState<UserFilter>("all");
    const [page, setPage] = useState(1);
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
    const filteredUsers = useMemo(() => (data?.users || []).filter((user) => {
        const matchesQuery = !normalizedQuery || `${user.username} ${user.displayName} ${user.email || ""}`.toLowerCase().includes(normalizedQuery);
        const matchesRole = userFilter === "all" || (userFilter === "admins" ? user.isAdmin : !user.isAdmin);
        return matchesQuery && matchesRole;
    }), [data, normalizedQuery, userFilter]);
    const filteredWorkspaces = useMemo(() => (data?.workspaces || []).filter((workspace) => !normalizedQuery || `${workspace.name} ${workspace.owner?.username || ""} ${workspace.owner?.displayName || ""} ${workspace.recentCanvasTitle || ""}`.toLowerCase().includes(normalizedQuery)), [data, normalizedQuery]);
    const activeTotal = activeTab === "users" ? filteredUsers.length : filteredWorkspaces.length;
    const pageCount = Math.max(1, Math.ceil(activeTotal / PAGE_SIZE));
    const currentPage = Math.min(page, pageCount);
    const range = pageRange(activeTotal, currentPage);
    const pagedUsers = filteredUsers.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
    const pagedWorkspaces = filteredWorkspaces.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

    useEffect(() => {
        setPage(1);
    }, [activeTab, query, userFilter]);

    useEffect(() => {
        if (page > pageCount) setPage(pageCount);
    }, [page, pageCount]);

    const formatTime = (value: string) => new Date(value).toLocaleString(i18n.resolvedLanguage);

    const filterItems: MenuProps["items"] = [
        { key: "all", label: t("config.admin.allUsers") },
        { key: "admins", label: t("config.admin.administrator") },
        { key: "members", label: t("config.admin.member") },
    ];
    const filterLabel = userFilter === "all" ? t("config.admin.allUsers") : userFilter === "admins" ? t("config.admin.administrator") : t("config.admin.member");

    const userColumns: ColumnsType<AdminUser> = [
        {
            title: t("config.admin.user"),
            key: "user",
            render: (_, user) => <div className="flex min-w-0 items-center gap-2.5">
                <span aria-hidden="true" className="flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-secondary text-xs font-medium text-muted-foreground">{avatarLabel(user)}</span>
                <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-1.5 font-medium text-foreground">
                        <span className="truncate" title={user.displayName}>{user.displayName}</span>
                        {user.id === currentUserId ? <span className="shrink-0 rounded border border-border px-1 text-[10px] leading-4 text-muted-foreground">{t("config.admin.you")}</span> : null}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-muted-foreground" title={[`@${user.username}`, user.email].filter(Boolean).join(" · ")}>
                        @{user.username}{user.email ? ` · ${user.email}` : ""}
                    </div>
                </div>
            </div>,
        },
        {
            title: t("config.admin.permission"),
            key: "permission",
            width: 170,
            render: (_, user) => user.isAdmin ? <div className="flex flex-wrap items-center gap-1.5">
                <span className="inline-flex items-center gap-1 rounded bg-foreground/[0.06] px-1.5 py-0.5 text-xs font-medium text-foreground"><ShieldCheck className="size-3" strokeWidth={2} />{t("config.admin.administrator")}</span>
                {user.envAdmin ? <span className="rounded border border-border px-1 py-0.5 text-[10px] leading-none text-muted-foreground">{t("config.admin.envAdmin")}</span> : null}
            </div> : <span className="text-xs text-muted-foreground">{t("config.admin.member")}</span>,
        },
        { title: t("config.admin.workspaceCount"), dataIndex: "workspaceCount", key: "workspaceCount", width: 90, align: "right" },
        { title: <span className="pl-4">{t("config.admin.createdAt")}</span>, dataIndex: "createdAt", key: "createdAt", width: 170, render: (value: string) => <span className="whitespace-nowrap pl-4 text-xs text-muted-foreground tabular-nums">{formatTime(value)}</span> },
        {
            title: <span className="sr-only">{t("config.admin.actions")}</span>,
            key: "actions",
            width: 180,
            align: "right",
            render: (_, user) => {
                const lastAdmin = Boolean(data && data.totals.admins <= 1);
                const disabled = user.envAdmin || (user.isAdmin && lastAdmin);
                const hint = user.envAdmin ? t("config.admin.envAdminHint") : user.isAdmin && lastAdmin ? t("config.admin.lastAdminHint") : null;
                return <Tooltip title={hint}>
                    <span className="inline-flex">
                        <Button size="small" type="text" className="!h-7 !px-2 !text-xs !text-muted-foreground hover:!text-foreground" loading={updatingUserId === user.id} disabled={disabled} onClick={() => void toggleAdmin(user)} icon={user.isAdmin ? <ShieldOff className="size-3.5" /> : <ShieldCheck className="size-3.5" />}>{user.isAdmin ? t("config.admin.unsetAdmin") : t("config.admin.setAdmin")}</Button>
                    </span>
                </Tooltip>;
            },
        },
    ];

    const workspaceColumns: ColumnsType<AdminWorkspace> = [
        {
            title: t("config.admin.workspace"),
            key: "workspace",
            render: (_, workspace) => <div className="flex min-w-0 items-center gap-2.5">
                <span aria-hidden="true" className="flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground"><Folder className="size-3.5" strokeWidth={1.8} /></span>
                <div className="min-w-0">
                    <div className="truncate font-medium text-foreground" title={workspace.name}>{workspace.name}</div>
                    <div className="mt-0.5 truncate text-xs text-muted-foreground">{workspace.recentCanvasTitle ? t("config.admin.recentCanvas", { name: workspace.recentCanvasTitle }) : t("config.admin.noCanvas")}</div>
                </div>
            </div>,
        },
        {
            title: t("config.admin.owner"),
            key: "owner",
            width: 150,
            render: (_, workspace) => workspace.owner ? <div className="min-w-0" title={`${workspace.owner.displayName} @${workspace.owner.username}`}>
                <div className="truncate">{workspace.owner.displayName}</div>
                <div className="truncate text-xs text-muted-foreground">@{workspace.owner.username}</div>
            </div> : <span className="text-xs text-muted-foreground">{t("config.admin.noOwner")}</span>,
        },
        { title: t("config.admin.members"), dataIndex: "memberCount", key: "memberCount", width: 70, align: "right" },
        { title: t("config.admin.content"), key: "content", width: 140, render: (_, workspace) => <span className="text-xs text-muted-foreground">{t("config.admin.canvasFolders", { canvases: workspace.canvasCount, folders: workspace.folderCount })}</span> },
        { title: t("config.admin.storage"), key: "storage", width: 100, align: "right", render: (_, workspace) => <span className="whitespace-nowrap tabular-nums">{formatCompactBytes(workspace.dataBytes + workspace.mediaBytes)}</span> },
        { title: <span className="pl-4">{t("config.admin.updatedAt")}</span>, dataIndex: "updatedAt", key: "updatedAt", width: 170, render: (value: string) => <span className="whitespace-nowrap pl-4 text-xs text-muted-foreground tabular-nums">{formatTime(value)}</span> },
        {
            title: <span className="sr-only">{t("config.admin.actions")}</span>,
            key: "actions",
            width: 150,
            align: "right",
            render: (_, workspace) => <div className="flex items-center justify-end gap-2">
                {workspace.role === "viewer" ? <Tag className="m-0">{t("config.admin.readOnly")}</Tag> : null}
                <Button size="small" type="text" className="!h-7 !px-2 !text-xs !text-muted-foreground hover:!text-foreground" icon={<LogIn className="size-3.5" />} onClick={() => enterWorkspace(workspace)}>{t("config.admin.enter")}</Button>
            </div>,
        },
    ];

    const totals = data?.totals;
    const stats = [
        { label: t("config.admin.totals.users"), value: totals?.users ?? "—" },
        { label: t("config.admin.totals.admins"), value: totals?.admins ?? "—" },
        { label: t("config.admin.totals.workspaces"), value: totals?.workspaces ?? "—" },
        { label: t("config.admin.totals.canvases"), value: totals?.canvases ?? "—" },
        { label: t("config.admin.totals.storage"), value: totals ? formatCompactBytes(totals.dataBytes + totals.mediaBytes) : "—" },
    ];
    const tabs: Array<{ key: AdminTab; label: string; count?: number }> = [
        { key: "users", label: t("config.admin.users"), count: totals?.users },
        { key: "workspaces", label: t("config.admin.workspaces"), count: totals?.workspaces },
    ];

    if (error && !data) {
        return <Alert type="error" showIcon message={t("config.admin.loadFailed")} description={error} action={<Button onClick={() => void load()}>{t("common.retry")}</Button>} />;
    }

    return <div className="pb-10">
        <dl className="mt-5 grid grid-cols-2 gap-x-8 gap-y-4 border-y border-border py-2.5 md:grid-cols-3 xl:grid-cols-5 xl:gap-x-0 xl:divide-x xl:divide-border">
            {stats.map((item, index) => <div key={item.label} className={cn("min-w-0 xl:px-5", index === 0 && "xl:pl-0", index === stats.length - 1 && "xl:pr-0")}>
                <dt className="text-xs text-muted-foreground">{item.label}</dt>
                <dd className="mt-1 text-2xl font-semibold leading-none tracking-tight text-foreground tabular-nums">{item.value}</dd>
            </div>)}
        </dl>

        {error ? <Alert className="mt-4" type="error" showIcon message={error} /> : null}

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-end gap-5" role="tablist" aria-label={t("config.admin.users")}>
                {tabs.map((tab) => <button key={tab.key} id={`admin-tab-${tab.key}`} type="button" role="tab" aria-selected={activeTab === tab.key} aria-controls={`admin-panel-${tab.key}`} onClick={() => setActiveTab(tab.key)} className={cn("flex h-11 items-center gap-2 border-b-2 px-0.5 text-sm font-medium transition-colors", activeTab === tab.key ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
                    {tab.label}
                    {tab.count !== undefined ? <span className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-medium tabular-nums", activeTab === tab.key ? "bg-foreground/[0.07]" : "bg-foreground/[0.05] text-muted-foreground")}>{tab.count}</span> : null}
                </button>)}
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <div className="w-[260px] max-w-full shrink-0">
                    <Input allowClear className="w-full" variant="filled" prefix={<Search className="size-4 text-muted-foreground" />} placeholder={t("config.admin.searchPlaceholder")} aria-label={t("config.admin.searchPlaceholder")} value={query} onChange={(event) => setQuery(event.target.value)} />
                </div>
                {activeTab === "users" ? <Dropdown trigger={["click"]} menu={{ items: filterItems, selectable: true, selectedKeys: [userFilter], onClick: ({ key }) => setUserFilter(key as UserFilter) }}>
                    <Button type="text" size="small" className="!h-8 !px-2 !text-xs !text-muted-foreground hover:!text-foreground"><span className="inline-flex items-center gap-1">{filterLabel}<ChevronDown className="size-3.5" /></span></Button>
                </Dropdown> : null}
                <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void load()}>{t("config.admin.refresh")}</Button>
            </div>
        </div>

        <div id={`admin-panel-${activeTab}`} role="tabpanel" aria-labelledby={`admin-tab-${activeTab}`} className="mt-1">
            {activeTab === "users" ? <Table<AdminUser> className={tableClassName} tableLayout="fixed" rowKey="id" size="small" loading={loading} columns={userColumns} dataSource={pagedUsers} pagination={false} scroll={{ x: 860 }} locale={{ emptyText: t("config.admin.noUsers") }} /> : <Table<AdminWorkspace> className={tableClassName} tableLayout="fixed" rowKey="id" size="small" loading={loading} columns={workspaceColumns} dataSource={pagedWorkspaces} pagination={false} scroll={{ x: 980 }} locale={{ emptyText: t("config.admin.noWorkspaces") }} />}
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-5 text-muted-foreground">
                {activeTotal > 0 ? <><span className="tabular-nums">{t(activeTab === "users" ? "config.admin.userRange" : "config.admin.workspaceRange", { from: range.from, to: range.to, total: activeTotal })}</span><span aria-hidden="true">·</span></> : null}
                <span>{t(activeTab === "users" ? "config.admin.usersHint" : "config.admin.workspacesHint")}</span>
            </div>
            <Pagination size="small" current={currentPage} pageSize={PAGE_SIZE} total={activeTotal} showSizeChanger={false} hideOnSinglePage onChange={(nextPage) => setPage(nextPage)} />
        </div>
    </div>;
}
