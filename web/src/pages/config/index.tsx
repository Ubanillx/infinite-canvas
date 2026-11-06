import { useTranslation } from "react-i18next";
import { Navigate, useParams } from "react-router-dom";

import { AppConfigPanel, SaveConfigButton } from "@/components/layout/app-config-modal";
import { ConfigPreferencesForm } from "@/components/layout/config-preferences";
import { adminConfigSection, configSections } from "@/constant/navigation-tools";
import { AdminOverview } from "@/pages/config/components/admin-overview";
import { SaveUserPreferencesButton } from "@/pages/config/components/personal-preferences";
import { useIsAdmin } from "@/stores/use-session-store";

export default function ConfigPage() {
    const { t } = useTranslation();
    const { tab } = useParams();
    const isAdmin = useIsAdmin();
    const defaultTab = isAdmin ? "channels" : "preferences";
    const requestedTab = tab || defaultTab;
    const adminTab = isAdmin && requestedTab === adminConfigSection.slug;
    const configSection = adminTab ? null : configSections.find((item) => item.slug === requestedTab);
    if (!isAdmin && configSection?.slug !== "preferences") return <Navigate to="/config/preferences" replace />;
    if (isAdmin && !adminTab && !configSection) return <Navigate to="/config" replace />;
    const section = adminTab ? adminConfigSection : configSection!;
    const preferencesTab = !adminTab && section.slug === "preferences";
    const title = preferencesTab ? t(isAdmin ? "config.tabs.defaultPreferences" : "config.tabs.preferences") : t(section.label);
    const description = t(adminTab ? "config.pageDescriptions.admin" : section.slug === "local-storage" ? "config.localStorage.pageDescription" : preferencesTab ? (isAdmin ? "config.pageDescriptions.defaultPreferences" : "config.pageDescriptions.personalPreferences") : `config.pageDescriptions.${section.slug}`);

    return (
        <main className="h-full overflow-y-auto bg-background">
            <div className="mx-auto max-w-6xl px-6 py-6">
                <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
                    <div>
                        <h1 className="text-xl font-semibold text-foreground">{title}</h1>
                        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
                    </div>
                    {preferencesTab ? (isAdmin ? <SaveConfigButton /> : <SaveUserPreferencesButton />) : !adminTab && section.slug !== "local-storage" && section.slug !== "registration" ? <SaveConfigButton /> : null}
                </div>
                {adminTab ? <AdminOverview /> : preferencesTab ? <ConfigPreferencesForm mode={isAdmin ? "defaults" : "personal"} /> : <AppConfigPanel showTabs={false} showSaveButton={false} initialTab={configSection!.slug} />}
            </div>
        </main>
    );
}
