import { useRef } from "react";
import { CornerUpLeft, LockKeyhole } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { clearActiveWorkspace, getActiveWorkspace, setActiveWorkspace } from "@/lib/workspace";
import { listWorkspaces } from "@/services/workspace";
import { useAppLoadingStore } from "@/stores/use-app-loading-store";
import { useThemeStore } from "@/stores/use-theme-store";

export function ReadOnlyWorkspaceActions({ variant = "default" }: { variant?: "default" | "canvas" }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const startAppLoading = useAppLoadingStore((state) => state.start);
    const leavingRef = useRef(false);
    const workspace = getActiveWorkspace();
    if (!workspace || workspace.role !== "viewer") return null;
    const leave = async () => {
        if (leavingRef.current) return;
        leavingRef.current = true;
        startAppLoading();
        const available = await listWorkspaces().catch(() => []);
        const target = available.find((item) => item.id !== workspace.id && item.role !== "viewer");
        if (target) setActiveWorkspace(target);
        else clearActiveWorkspace();
        window.location.reload();
    };
    return (
        <button
            type="button"
            onClick={() => void leave()}
            aria-label={t("topNav.returnToOwnWorkspace")}
            title={t("topNav.returnToOwnWorkspace")}
            className={`inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 ${variant === "canvas" ? "hover:bg-black/5 focus-visible:outline-current dark:hover:bg-white/10" : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground focus-visible:outline-foreground"}`}
            style={variant === "canvas" ? { color: theme.node.muted } : undefined}
        >
            <LockKeyhole className="hidden size-3.5 sm:block" aria-hidden="true" />
            <CornerUpLeft className="size-4 sm:hidden" aria-hidden="true" />
            <span className="hidden md:inline">{t("topNav.readOnlyWorkspace")}</span>
            <span className="hidden opacity-40 md:inline" aria-hidden="true">·</span>
            <span className="hidden sm:inline">{t("topNav.returnToOwnWorkspace")}</span>
        </button>
    );
}
