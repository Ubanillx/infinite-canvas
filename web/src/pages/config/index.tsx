import { useTranslation } from "react-i18next";
import { Navigate, useParams } from "react-router-dom";

import { AppConfigPanel, SaveConfigButton } from "@/components/layout/app-config-modal";
import { configSections } from "@/constant/navigation-tools";

export default function ConfigPage() {
    const { t } = useTranslation();
    const { tab } = useParams();
    const section = configSections.find((item) => item.slug === (tab || "channels"));
    if (!section) return <Navigate to="/config" replace />;

    return (
        <main className="h-full overflow-y-auto bg-background">
            <div className="mx-auto max-w-6xl px-6 py-6">
                <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
                    <div>
                        <h1 className="text-xl font-semibold text-stone-950 dark:text-stone-100">{t(section.label)}</h1>
                        <p className="mt-1 text-sm text-stone-500">{t(section.slug === "local-storage" ? "config.localStorage.pageDescription" : `config.pageDescriptions.${section.slug}`)}</p>
                    </div>
                    {section.slug !== "local-storage" ? <SaveConfigButton /> : null}
                </div>
                <AppConfigPanel showTabs={false} showSaveButton={false} initialTab={section.slug} />
            </div>
        </main>
    );
}
