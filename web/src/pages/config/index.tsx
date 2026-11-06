import { useTranslation } from "react-i18next";
import { Navigate, useParams } from "react-router-dom";

import { AppConfigPanel, SaveConfigButton } from "@/components/layout/app-config-modal";
import { ConfigPreferencesForm } from "@/components/layout/config-preferences";
import { adminConfigSection, configSections } from "@/constant/navigation-tools";
import { AdminOverview } from "@/pages/config/components/admin-overview";
import { RegistrationSettings } from "@/pages/config/components/registration-settings";
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
    const headerAction = preferencesTab ? (isAdmin ? <SaveConfigButton /> : <SaveUserPreferencesButton />) : adminTab || section.slug === "local-storage" ? null : section.slug === "registration" ? <div id="config-registration-actions" /> : <SaveConfigButton />;

    return (
        <main className="h-full overflow-y-auto bg-background">
            <div className="mx-auto max-w-6xl px-6 py-6">
                <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                        <h1 className="text-xl font-semibold text-foreground">{title}</h1>
                        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
                    </div>
                    {headerAction ? <div className="flex shrink-0 flex-wrap gap-2 self-end sm:self-start">{headerAction}</div> : null}
                </div>
                {adminTab ? <AdminOverview /> : preferencesTab ? <ConfigPreferencesForm mode={isAdmin ? "defaults" : "personal"} /> : section.slug === "registration" ? <RegistrationSettings headerActionsId="config-registration-actions" /> : <AppConfigPanel showTabs={false} showSaveButton={false} initialTab={configSection!.slug} />}
            </div>
        </main>
    );
}
