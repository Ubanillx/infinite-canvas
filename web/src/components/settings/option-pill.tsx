import type { ReactNode } from "react";

import type { CanvasTheme } from "@/lib/canvas-theme";

export function OptionPill({ selected, theme, onClick, children, subtle = false }: { selected: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode; subtle?: boolean }) {
    return (
        <button type="button" aria-pressed={selected} className="h-9 cursor-pointer rounded-full border px-2 text-sm transition-colors hover:opacity-80" style={{ background: selected && subtle ? theme.toolbar.activeBg : "transparent", borderColor: selected && !subtle ? theme.node.text : theme.node.stroke, color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()} onClick={onClick}>
            {children}
        </button>
    );
}
