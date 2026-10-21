import { useState } from "react";
import { Tooltip } from "antd";
import { ChevronsLeft } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { navigationGroups } from "@/constant/navigation-tools";
import { cn } from "@/lib/utils";
import { useAgentStore } from "@/stores/use-agent-store";

const SIDEBAR_COLLAPSED_KEY = "infinite-canvas:sidebar-collapsed";

export function AppSidebar() {
    const { pathname } = useLocation();
    const { t } = useTranslation();
    const panelOpen = useAgentStore((state) => state.panelOpen);
    const [collapsed, setCollapsed] = useState(() => typeof window !== "undefined" && window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1");

    const toggleCollapsed = () => {
        const next = !collapsed;
        setCollapsed(next);
        window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
    };

    return (
        <aside className={cn("hidden h-full shrink-0 flex-col overflow-hidden border-r border-border bg-sidebar transition-[width] duration-300 ease-out motion-reduce:transition-none", panelOpen ? "2xl:flex" : "lg:flex", collapsed ? "w-[72px]" : "w-64")}>
            <nav id="app-sidebar-navigation" className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2 py-5" aria-label={t("topNav.navigation")}>
                {navigationGroups.map((group) => (
                    <section key={group.key} className="mb-5" aria-label={t(`navigationGroups.${group.key}`)}>
                        <div className="relative mb-2 h-7 text-xs font-medium text-muted-foreground">
                            <span aria-hidden={collapsed} className={cn("absolute inset-0 flex items-center whitespace-nowrap px-3 transition-opacity duration-200 motion-reduce:transition-none", collapsed ? "opacity-0" : "opacity-100")}>{t(`navigationGroups.${group.key}`)}</span>
                            <span aria-hidden="true" className={cn("absolute inset-0 flex items-center justify-center transition-opacity duration-200 motion-reduce:transition-none", collapsed ? "opacity-100" : "opacity-0")}><span className="w-7 border-t border-border" /></span>
                        </div>
                        <div className="space-y-1">
                            {group.tools.map((tool) => {
                                const Icon = tool.icon;
                                const label = t(`navigation.${tool.slug}`);
                                const active = pathname.split("/").filter(Boolean)[0] === tool.slug;
                                return <Tooltip key={tool.slug} title={collapsed ? label : null} placement="right" mouseEnterDelay={0.15}>
                                    <Link
                                        to={`/${tool.slug}`}
                                        aria-label={label}
                                        aria-current={active ? "page" : undefined}
                                        className={cn("group relative flex h-11 items-center gap-3 rounded-lg text-sm transition-[padding,background-color,color] duration-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground motion-reduce:transition-none", collapsed ? "pl-[19px] pr-0" : "px-3", active ? "bg-foreground/5 font-medium text-foreground dark:bg-foreground/10" : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground")}
                                    >
                                        {active ? <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-foreground" aria-hidden="true" /> : null}
                                        <Icon className="size-[18px] shrink-0 transition-transform duration-300 ease-out group-hover:-translate-y-0.5 group-hover:rotate-[-8deg] group-hover:scale-110 motion-reduce:transform-none motion-reduce:transition-none" strokeWidth={1.8} />
                                        <span aria-hidden={collapsed} className={cn("overflow-hidden whitespace-nowrap transition-[max-width,opacity,transform] duration-200 motion-reduce:transition-none", collapsed ? "max-w-0 -translate-x-2 opacity-0" : "max-w-40 translate-x-0 opacity-100")}>{label}</span>
                                    </Link>
                                </Tooltip>;
                            })}
                        </div>
                    </section>
                ))}
            </nav>
            <div className="shrink-0 border-t border-border p-2">
                <Tooltip title={collapsed ? t("sidebar.expand") : null} placement="right">
                    <button type="button" aria-label={t(collapsed ? "sidebar.expand" : "sidebar.collapse")} aria-expanded={!collapsed} aria-controls="app-sidebar-navigation" onClick={toggleCollapsed} className={cn("group flex h-11 w-full items-center gap-3 rounded-lg text-sm text-muted-foreground transition-[padding,background-color,color] duration-300 hover:bg-foreground/5 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground motion-reduce:transition-none", collapsed ? "pl-[19px] pr-0" : "px-3")}>
                        <ChevronsLeft className={cn("size-[18px] shrink-0 transition-transform duration-300 group-hover:scale-110 motion-reduce:transition-none", collapsed && "rotate-180")} strokeWidth={1.8} />
                        <span aria-hidden={collapsed} className={cn("overflow-hidden whitespace-nowrap transition-[max-width,opacity] duration-200 motion-reduce:transition-none", collapsed ? "max-w-0 opacity-0" : "max-w-40 opacity-100")}>{t("sidebar.collapse")}</span>
                    </button>
                </Tooltip>
            </div>
        </aside>
    );
}
