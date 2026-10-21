import { InputNumber, Button } from "antd";
import { Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { reasoningEffortLabel, TextSettingsPanel } from "@/components/text-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { AiConfig, ReasoningEffort } from "@/stores/use-config-store";
import { CanvasSettingsPopoverPanel, useCanvasSettingsPopover, type CanvasSettingsPlacement } from "./canvas-settings-popover";

type CanvasTextSettingsPopoverProps = {
    config: AiConfig;
    onConfigChange: (key: "reasoningEffort", value: ReasoningEffort) => void;
    count?: number;
    onCountChange?: (count: number) => void;
    buttonClassName?: string;
    placement?: CanvasSettingsPlacement;
};

export function CanvasTextSettingsPopover({ config, onConfigChange, count, onCountChange, buttonClassName, placement = "topLeft" }: CanvasTextSettingsPopoverProps) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { buttonRef, panel, toggle } = useCanvasSettingsPopover();

    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0">
                <Button size="small" type="text" className={buttonClassName || "!h-8 !max-w-[170px] !justify-start !rounded-full !px-2.5"} style={{ background: theme.node.fill, color: theme.node.text }} icon={<Settings2 className="size-3.5" />} onClick={toggle}>
                    <span className="truncate">{t("canvas.controls.reasoning")} · {reasoningEffortLabel(config.reasoningEffort)}{onCountChange ? ` · ${t("canvas.controls.generations", { count })}` : ""}</span>
                </Button>
            </span>
            {panel ? (
                <CanvasSettingsPopoverPanel {...panel} placement={placement} maxHeight={false}>
                    <TextSettingsPanel config={config} onConfigChange={onConfigChange} theme={theme} />
                    {onCountChange ? (
                        <div className="mt-4 space-y-2.5">
                            <div className="text-sm font-medium" style={{ color: theme.node.muted }}>{t("settingsPanels.text.count")}</div>
                            <InputNumber className="w-full" min={1} max={15} precision={0} value={count} onChange={(value) => onCountChange(value || 1)} />
                        </div>
                    ) : null}
                </CanvasSettingsPopoverPanel>
            ) : null}
        </>
    );
}
