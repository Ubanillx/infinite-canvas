import { Settings2 } from "lucide-react";
import { Button } from "antd";

import { VideoSettingsPanel, videoModeLabel, videoResolutionLabel, videoSecondsLabel, videoSizeLabel } from "@/components/video-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { AiConfig } from "@/stores/use-config-store";
import { CanvasSettingsPopoverPanel, useCanvasSettingsPopover, type CanvasSettingsPlacement } from "./canvas-settings-popover";

type CanvasVideoSettingsPopoverProps = {
    config: AiConfig;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    buttonClassName?: string;
    placement?: CanvasSettingsPlacement;
};

export function CanvasVideoSettingsPopover({ config, onConfigChange, buttonClassName, placement = "topLeft" }: CanvasVideoSettingsPopoverProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { buttonRef, panel, toggle } = useCanvasSettingsPopover();

    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0">
                <Button size="small" type="text" className={buttonClassName || "!h-8 !max-w-[220px] !justify-start !rounded-full !px-2.5"} style={{ background: theme.node.fill, color: theme.node.text }} icon={<Settings2 className="size-3.5" />} onClick={toggle}>
                    <span className="truncate">
                        {videoResolutionLabel(config.vquality)} · {videoSizeLabel(config.size)} · {videoSecondsLabel(config.videoSeconds)} · {videoModeLabel(config.videoMode)}
                    </span>
                </Button>
            </span>
            {panel ? (
                <CanvasSettingsPopoverPanel {...panel} placement={placement} className="canvas-image-settings-popover">
                    <VideoSettingsPanel config={config} onConfigChange={(key, value) => onConfigChange(key, value)} theme={theme} className="space-y-4" />
                </CanvasSettingsPopoverPanel>
            ) : null}
        </>
    );
}
