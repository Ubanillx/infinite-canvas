import { useTranslation } from "react-i18next";

import { getActiveWorkspace } from "@/lib/workspace";
import { useAppLoadingStore } from "@/stores/use-app-loading-store";

export function AppLoadingOverlay() {
    const { t } = useTranslation();
    const loading = useAppLoadingStore((state) => state.loading);
    const workspace = getActiveWorkspace();

    return <div
        role="status"
        aria-live="polite"
        aria-hidden={!loading}
        className={`app-loading-overlay fixed inset-0 z-[10000] flex items-center justify-center overflow-hidden bg-background text-foreground transition-[opacity,visibility] duration-500 ease-in-out ${loading ? "visible opacity-100" : "invisible opacity-0"}`}
    >
        <div className="app-loading-grid pointer-events-none absolute inset-0" aria-hidden="true" />
        <div className="app-loading-halo pointer-events-none absolute left-1/2 top-1/2 size-[min(90vw,680px)] -translate-x-1/2 -translate-y-1/2 rounded-full" aria-hidden="true" />
        <div className="app-loading-content relative flex flex-col items-center px-8 text-center">
            <div className="relative mb-10 flex size-32 items-center justify-center" aria-hidden="true">
                <div className="absolute inset-0 rounded-full border border-foreground/10" />
                <div className="app-loading-orbit absolute inset-0 rounded-full border-2 border-transparent border-t-foreground border-r-foreground/25" />
                <div className="app-loading-orbit-reverse absolute inset-[13px] rounded-full border border-dashed border-foreground/25" />
                <div className="absolute inset-[30px] flex items-center justify-center rounded-full border border-foreground/10 bg-background/80">
                    <span className="size-8 bg-current" style={{ mask: "url(/logo.svg) center / contain no-repeat", WebkitMask: "url(/logo.svg) center / contain no-repeat" }} />
                </div>
                <span className="app-loading-satellite absolute inset-0"><span className="absolute left-1/2 top-[-3px] size-1.5 -translate-x-1/2 rounded-full bg-foreground" /></span>
                <span className="absolute -left-5 top-1/2 h-px w-4 bg-foreground/15" />
                <span className="absolute -right-5 top-1/2 h-px w-4 bg-foreground/15" />
                <span className="absolute -top-5 left-1/2 h-4 w-px bg-foreground/15" />
                <span className="absolute -bottom-5 left-1/2 h-4 w-px bg-foreground/15" />
            </div>
            <p className="text-[11px] font-medium tracking-[0.32em] text-muted-foreground">{t("meta.title")}</p>
            <h1 className="mt-4 max-w-[85vw] break-words text-xl font-medium tracking-tight sm:text-2xl">{workspace ? t("boot.restoring", { name: workspace.name }) : t("boot.opening")}</h1>
            <p className="mt-3 text-sm text-muted-foreground">{workspace ? t("boot.preparing") : t("boot.finding")}</p>
        </div>
    </div>;
}
