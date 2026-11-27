import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

import "./canvas-refresh-shell.css";

export function CanvasRefreshShell() {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const dockStyle = { background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.item };

    return (
        <main className="relative grid h-full min-h-0 place-items-center overflow-hidden" style={{ background: theme.canvas.background }}>
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 opacity-40"
                style={{
                    backgroundImage: `radial-gradient(circle, ${theme.canvas.dot} 1.15px, transparent 1.35px)`,
                    backgroundSize: "48px 48px",
                }}
            />

            <div role="status" className="relative flex flex-col items-center gap-4 px-6 text-center" style={{ color: theme.node.muted }}>
                <div aria-hidden="true" className="canvas-refresh-mosaic grid size-11 grid-cols-2 grid-rows-2 gap-1">
                    <span className="row-span-2 rounded-md bg-current" />
                    <span className="rounded-md bg-current" />
                    <span className="rounded-md bg-current" />
                </div>
                <p className="text-sm font-medium">{t("canvas.projectPage.loading")}</p>
            </div>

            <div aria-hidden="true" className="pointer-events-none absolute inset-x-3 bottom-[88px] flex justify-center md:bottom-5 md:left-[300px] md:right-4">
                <div className="flex h-14 max-w-full items-center gap-4 overflow-hidden rounded-xl border px-4" style={dockStyle}>
                    {Array.from({ length: 8 }, (_, index) => <span key={index} className="size-4 shrink-0 rounded-sm bg-current opacity-15" />)}
                </div>
            </div>

            <div aria-hidden="true" className="pointer-events-none absolute bottom-5 left-5 flex h-14 w-64 max-w-[calc(100%-40px)] items-center gap-4 rounded-xl border px-4" style={dockStyle}>
                <span className="size-4 shrink-0 rounded-sm bg-current opacity-15" />
                <span className="size-4 shrink-0 rounded-sm bg-current opacity-15" />
                <span className="h-1 flex-1 rounded-full bg-current opacity-15" />
                <span className="h-3 w-7 shrink-0 rounded-sm bg-current opacity-15" />
            </div>
        </main>
    );
}
