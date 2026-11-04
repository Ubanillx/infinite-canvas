import { useTranslation } from "react-i18next";
import { Navigate, useParams } from "react-router-dom";

import { AppConfigPanel, SaveConfigButton } from "@/components/layout/app-config-modal";
import { adminConfigSection, configSections } from "@/constant/navigation-tools";
import { AdminOverview } from "@/pages/config/components/admin-overview";
import { useIsAdmin } from "@/stores/use-session-store";

export default function ConfigPage() {
    const { t } = useTranslation();
    const { tab } = useParams();
    const isAdmin = useIsAdmin();
    const adminTab = tab === adminConfigSection.slug;
    const configSection = adminTab ? null : configSections.find((item) => item.slug === (tab || "channels"));
    if (!isAdmin) return <Navigate to="/" replace />;
    if (!adminTab && !configSection) return <Navigate to="/config" replace />;
    const section = adminTab ? adminConfigSection : configSection!;

    return (
        <main className="h-full overflow-y-auto bg-background">
            <div className="mx-auto max-w-6xl px-6 py-6">
                <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
                    <div>
                        <h1 className="text-xl font-semibold text-foreground">{t(section.label)}</h1>
                        <p className="mt-1 text-sm text-muted-foreground">{t(adminTab ? "config.pageDescriptions.admin" : section.slug === "local-storage" ? "config.localStorage.pageDescription" : `config.pageDescriptions.${section.slug}`)}</p>
                    </div>
                    {!adminTab && section.slug !== "local-storage" ? <SaveConfigButton /> : null}
                </div>
                {adminTab ? <AdminOverview /> : <AppConfigPanel showTabs={false} showSaveButton={false} initialTab={configSection!.slug} />}
            </div>
        </main>
    );
}
