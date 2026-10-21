import { Drawer } from "antd";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { UserStatusActions } from "@/components/layout/user-status-actions";
import { navigationGroups, type NavigationToolSlug } from "@/constant/navigation-tools";
import { cn } from "@/lib/utils";
import { useAgentStore } from "@/stores/use-agent-store";

type MobileNavDrawerProps = {
    open: boolean;
    activeToolSlug?: NavigationToolSlug;
    onClose: () => void;
};

export function MobileNavDrawer({ open, activeToolSlug, onClose }: MobileNavDrawerProps) {
    const { t } = useTranslation();
    const panelOpen = useAgentStore((state) => state.panelOpen);

    return (
        <Drawer title={t("topNav.navigation")} placement="left" size={280} open={open} onClose={onClose} className={panelOpen ? "2xl:hidden" : "lg:hidden"}>
            <div className="space-y-6">
                {navigationGroups.map((group) => <section key={group.key} aria-label={t(`navigationGroups.${group.key}`)}>
                    <div className="mb-2 px-3 text-xs font-medium text-muted-foreground">{t(`navigationGroups.${group.key}`)}</div>
                    <div className="space-y-1">{group.tools.map((tool) => {
                        const Icon = tool.icon;
                        const active = tool.slug === activeToolSlug;
                        return <Link key={tool.slug} to={`/${tool.slug}`} onClick={onClose} aria-current={active ? "page" : undefined} className={cn("group flex h-11 items-center gap-3 rounded-lg px-3 text-sm transition-colors", active ? "bg-foreground/5 font-medium text-foreground dark:bg-foreground/10" : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground")}>
                            <Icon className="size-[18px] transition-transform duration-300 group-hover:-translate-y-0.5 group-hover:rotate-[-8deg] group-hover:scale-110 motion-reduce:transform-none" strokeWidth={1.8} />
                            <span>{t(`navigation.${tool.slug}`)}</span>
                        </Link>;
                    })}</div>
                </section>)}
                <div className={cn("border-t border-border pt-4", !panelOpen && "md:hidden")}><UserStatusActions showConfig={false} /></div>
            </div>
        </Drawer>
    );
}
