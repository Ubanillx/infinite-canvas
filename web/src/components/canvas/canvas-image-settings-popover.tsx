import { Settings2 } from "lucide-react";
import { Button } from "antd";
import { useTranslation } from "react-i18next";

import { ImageSettingsPanel, imageQualityLabel, imageSizeLabel } from "@/components/image-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { AiConfig } from "@/stores/use-config-store";
import { CanvasSettingsPopoverPanel, useCanvasSettingsPopover, type CanvasSettingsPlacement } from "./canvas-settings-popover";

type CanvasImageSettingsPopoverProps = {
    config: AiConfig;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    onMissingConfig?: () => void;
    onOpenChange?: (open: boolean) => void;
    buttonClassName?: string;
    getPopupContainer?: (triggerNode: HTMLElement) => HTMLElement;
    placement?: CanvasSettingsPlacement;
    autoAdjustOverflow?: boolean;
};

export function CanvasImageSettingsPopover({ config, onConfigChange, onOpenChange, buttonClassName, placement = "topLeft" }: CanvasImageSettingsPopoverProps) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { buttonRef, panel, toggle } = useCanvasSettingsPopover({ onOpenChange, blurPanelOnOutside: true });
    const quality = config.quality || "auto";
    const count = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const activeSize = config.size || "auto";

    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0">
                <Button size="small" type="text" className={buttonClassName || "!h-8 !max-w-[180px] !justify-start !rounded-full !px-2.5"} style={{ background: theme.node.fill, color: theme.node.text }} icon={<Settings2 className="size-3.5" />} onClick={toggle}>
                    <span className="truncate">
                        {imageQualityLabel(quality)} · {imageSizeLabel(activeSize)} · {t("canvas.controls.images", { count })}
                    </span>
                </Button>
            </span>
            {panel ? (
                <CanvasSettingsPopoverPanel {...panel} placement={placement} className="canvas-image-settings-popover">
                    <ImageSettingsPanel config={config} onConfigChange={(key, value) => onConfigChange(key, value)} theme={theme} className="space-y-4" />
                </CanvasSettingsPopoverPanel>
            ) : null}
        </>
    );
}
