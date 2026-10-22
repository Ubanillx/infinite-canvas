import { Bot, Menu } from "lucide-react";
import { Button, Tooltip } from "antd";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { navigationTools, type NavigationToolSlug } from "@/constant/navigation-tools";
import { AppConfigModal } from "@/components/layout/app-config-modal";
import { WorkspaceSwitcher } from "@/components/layout/workspace-gate";
import { MobileNavDrawer } from "@/components/layout/mobile-nav-drawer";
import { UserStatusActions } from "@/components/layout/user-status-actions";
import { useEffect, useRef, useState } from "react";
import { useAgentStore } from "@/stores/use-agent-store";

export function AppTopNav() {
    const { t } = useTranslation();
    const { pathname } = useLocation();
    const [mobileNavOpen, setMobileNavOpen] = useState(false);
    const autoConnectRef = useRef(false);
    const agentToken = useAgentStore((state) => state.token);
    const agentEnabled = useAgentStore((state) => state.enabled);
    const agentConnected = useAgentStore((state) => state.connected);
    const connectAgent = useAgentStore((state) => state.connectAgent);
    const togglePanel = useAgentStore((state) => state.togglePanel);
    const panelOpen = useAgentStore((state) => state.panelOpen);
    const hideHeader = /^\/canvas\/[^/]+/.test(pathname);
    const slug = pathname.split("/").filter(Boolean)[0];
    const activeToolSlug = navigationTools.some((tool) => tool.slug === slug) ? (slug as NavigationToolSlug) : undefined;

    useEffect(() => {
        if (autoConnectRef.current || agentEnabled || agentConnected || !agentToken.trim()) return;
        autoConnectRef.current = true;
        connectAgent({ silent: true });
    }, [agentConnected, agentEnabled, agentToken, connectAgent]);

    return (
        <>
            {!hideHeader ? (
                <header className="relative z-20 h-14 shrink-0 border-b border-border bg-sidebar/90 backdrop-blur-xl">
                    <div className="flex h-full w-full items-center justify-between gap-4 px-4 sm:px-6">
                        <div className="flex min-w-0 items-center">
                            <Link to="/" className="flex shrink-0 items-center gap-2 text-sm font-semibold leading-none tracking-tight text-foreground transition-opacity hover:opacity-60">
                                <span
                                    className="size-5 shrink-0 bg-current"
                                    style={{
                                        mask: "url(/logo.svg) center / contain no-repeat",
                                        WebkitMask: "url(/logo.svg) center / contain no-repeat",
                                    }}
                                />
                                <span className={panelOpen ? "hidden text-base font-medium 2xl:inline" : "text-base font-medium"}>{t("meta.title")}</span>
                            </Link>

                            <button
                                type="button"
                                className={`ml-3 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground ${panelOpen ? "2xl:hidden" : "lg:hidden"}`}
                                onClick={() => setMobileNavOpen(true)}
                                aria-label={t("topNav.openMenu")}
                                title={t("topNav.menu")}
                            >
                                <Menu className="size-5" />
                            </button>
                        </div>

                        <div className="flex h-9 min-w-0 items-center justify-end gap-2 whitespace-nowrap">
                            <Tooltip title={t(panelOpen ? "topNav.closeAgent" : "topNav.openAgent")}>
                                <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" icon={<Bot className="size-4" />} onClick={togglePanel} aria-label={t(panelOpen ? "topNav.closeAgent" : "topNav.openAgent")} />
                            </Tooltip>
                            <div className={panelOpen ? "hidden 2xl:block" : "hidden md:block"}><UserStatusActions showConfig={false} /></div>
                            <WorkspaceSwitcher />
                        </div>
                    </div>
                </header>
            ) : null}

            <MobileNavDrawer open={mobileNavOpen} activeToolSlug={activeToolSlug} onClose={() => setMobileNavOpen(false)} />
            <AppConfigModal />
        </>
    );
}
