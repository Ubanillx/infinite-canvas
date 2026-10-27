import { Drawer } from "antd";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { UserStatusActions } from "@/components/layout/user-status-actions";
import { configSections, navigationGroups, type NavigationToolSlug } from "@/constant/navigation-tools";
import { cn } from "@/lib/utils";
import { useAgentStore } from "@/stores/use-agent-store";

type MobileNavDrawerProps = {
    open: boolean;
    activeToolSlug?: NavigationToolSlug;
    onClose: () => void;
};

export function MobileNavDrawer({ open, activeToolSlug, onClose }: MobileNavDrawerProps) {
    const { t } = useTranslation();
    const { pathname } = useLocation();
    const panelOpen = useAgentStore((state) => state.panelOpen);

    return (
        <Drawer title={t("topNav.navigation")} placement="left" size={280} open={open} onClose={onClose} className={panelOpen ? "2xl:hidden" : "lg:hidden"}>
            <div className="space-y-6">
                {navigationGroups.map((group) => <section key={group.key} aria-label={t(`navigationGroups.${group.key}`)}>
                    <div className="mb-2 px-3 text-xs font-medium text-muted-foreground">{t(`navigationGroups.${group.key}`)}</div>
                    <div className="space-y-1">{group.tools.map((tool) => {
                        const Icon = tool.icon;
                        const active = tool.slug === activeToolSlug;
                        return <div key={tool.slug}>
                            <Link to={`/${tool.slug}`} onClick={onClose} aria-current={active && pathname === `/${tool.slug}` ? "page" : undefined} className={cn("group flex h-11 items-center gap-3 rounded-lg px-3 text-sm transition-colors", active ? "bg-foreground/5 font-medium text-foreground dark:bg-foreground/10" : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground")}>
                                <Icon className="size-[18px] transition-transform duration-300 group-hover:-translate-y-0.5 group-hover:rotate-[-8deg] group-hover:scale-110 motion-reduce:transform-none" strokeWidth={1.8} />
                                <span>{t(`navigation.${tool.slug}`)}</span>
                            </Link>
                            {tool.slug === "config" && active ? <div className="ml-5 mt-1 space-y-0.5 border-l border-border pl-2">
                                {configSections.map((section) => {
                                    const SectionIcon = section.icon;
                                    const selected = (pathname.split("/")[2] || "channels") === section.slug;
                                    return <Link key={section.slug} to={`/config/${section.slug}`} onClick={onClose} aria-current={pathname === `/config/${section.slug}` ? "page" : undefined} className={cn("flex h-10 items-center gap-2 rounded-md px-2 text-sm", selected ? "bg-foreground/5 font-medium text-foreground dark:bg-foreground/10" : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground")}>
                                        <SectionIcon className="size-4 shrink-0" strokeWidth={1.8} />
                                        <span>{t(section.label)}</span>
                                    </Link>;
                                })}
                            </div> : null}
                        </div>;
                    })}</div>
                </section>)}
                <div className={cn("border-t border-border pt-4", !panelOpen && "md:hidden")}><UserStatusActions showConfig={false} /></div>
            </div>
        </Drawer>
    );
}
