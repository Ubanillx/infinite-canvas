import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";

import { AgentPanel } from "@/components/agent/agent-panel";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { AppTopNav } from "@/components/layout/app-top-nav";

export default function UserLayout({ children }: { children: ReactNode }) {
    const { pathname } = useLocation();
    const fullscreenCanvas = /^\/canvas\/[^/]+/.test(pathname);

    return (
        <div className="flex h-dvh overflow-hidden bg-background text-foreground">
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <AppTopNav />
                <div className="flex min-h-0 flex-1 overflow-hidden">
                    {fullscreenCanvas ? null : <AppSidebar />}
                    <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{children}</div>
                </div>
            </div>
            <AgentPanel />
        </div>
    );
}
