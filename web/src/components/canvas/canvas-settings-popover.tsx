import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

export type CanvasSettingsPlacement = "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";

/** Open state, viewport tracking and outside-click dismissal shared by the canvas node settings popovers. */
export function useCanvasSettingsPopover({ onOpenChange, blurPanelOnOutside = false }: { onOpenChange?: (open: boolean) => void; blurPanelOnOutside?: boolean } = {}) {
    const buttonRef = useRef<HTMLSpanElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);

    useEffect(() => {
        if (!open) return;
        const syncPosition = () => setButtonRect(buttonRef.current?.getBoundingClientRect() || null);
        const closeOnOutsidePointer = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node) || buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
            if (blurPanelOnOutside && document.activeElement instanceof HTMLElement && panelRef.current?.contains(document.activeElement)) document.activeElement.blur();
            setOpen(false);
            onOpenChange?.(false);
        };

        syncPosition();
        window.addEventListener("resize", syncPosition);
        window.addEventListener("scroll", syncPosition, true);
        window.addEventListener("pointerdown", closeOnOutsidePointer, true);
        return () => {
            window.removeEventListener("resize", syncPosition);
            window.removeEventListener("scroll", syncPosition, true);
            window.removeEventListener("pointerdown", closeOnOutsidePointer, true);
        };
    }, [blurPanelOnOutside, onOpenChange, open]);

    return {
        buttonRef,
        toggle: () => {
            const next = !open;
            setOpen(next);
            onOpenChange?.(next);
        },
        panel: open && buttonRect ? { buttonRect, panelRef } : null,
    };
}

export function CanvasSettingsPopoverPanel({
    buttonRect,
    panelRef,
    placement,
    className,
    maxHeight = true,
    children,
}: {
    buttonRect: DOMRect;
    panelRef: RefObject<HTMLDivElement | null>;
    placement: CanvasSettingsPlacement;
    className?: string;
    maxHeight?: boolean;
    children: ReactNode;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const width = 356;
    const gap = 8;
    const margin = 12;
    const alignRight = placement.endsWith("Right");
    const alignCenter = placement === "top" || placement === "bottom";
    const left = alignCenter ? buttonRect.left + buttonRect.width / 2 - width / 2 : alignRight ? buttonRect.right - width : buttonRect.left;
    const topPlacement = placement.startsWith("top");
    const style: CSSProperties = {
        position: "fixed",
        zIndex: 1200,
        width,
        left: Math.max(margin, Math.min(window.innerWidth - width - margin, left)),
        ...(topPlacement
            ? { bottom: window.innerHeight - buttonRect.top + gap, ...(maxHeight ? { maxHeight: Math.max(260, buttonRect.top - margin * 2) } : {}) }
            : { top: buttonRect.bottom + gap, ...(maxHeight ? { maxHeight: Math.max(260, window.innerHeight - buttonRect.bottom - margin * 2) } : {}) }),
        ...(maxHeight ? { overflowY: "auto" as const } : {}),
        background: theme.toolbar.panel,
        borderRadius: 18,
        boxShadow: "0 18px 54px rgba(28, 25, 23, 0.16)",
        padding: 18,
        color: theme.node.text,
    };

    return createPortal(
        <div
            ref={panelRef}
            className={className}
            style={style}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
        >
            {children}
        </div>,
        document.body,
    );
}