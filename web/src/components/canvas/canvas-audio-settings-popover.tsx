import { Settings2 } from "lucide-react";
import { Button } from "antd";

import { AudioSettingsPanel } from "@/components/audio-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { AiConfig } from "@/stores/use-config-store";
import { audioFormatLabel, audioSpeedLabel, audioVoiceLabel } from "@/lib/audio-generation";
import { CanvasSettingsPopoverPanel, useCanvasSettingsPopover, type CanvasSettingsPlacement } from "./canvas-settings-popover";

export type CanvasAudioSettingKey = "audioVoice" | "audioFormat" | "audioSpeed" | "audioInstructions";

type CanvasAudioSettingsPopoverProps = {
    config: AiConfig;
    onConfigChange: (key: CanvasAudioSettingKey, value: string) => void;
    buttonClassName?: string;
    placement?: CanvasSettingsPlacement;
};

export function CanvasAudioSettingsPopover({ config, onConfigChange, buttonClassName, placement = "topLeft" }: CanvasAudioSettingsPopoverProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { buttonRef, panel, toggle } = useCanvasSettingsPopover();

    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0">
                <Button size="small" type="text" className={buttonClassName || "!h-8 !max-w-[170px] !justify-start !rounded-full !px-2.5"} style={{ background: theme.node.fill, color: theme.node.text }} icon={<Settings2 className="size-3.5" />} onClick={toggle}>
                    <span className="truncate">
                        {audioVoiceLabel(config.audioVoice)} · {audioFormatLabel(config.audioFormat)} · {audioSpeedLabel(config.audioSpeed)}
                    </span>
                </Button>
            </span>
            {panel ? (
                <CanvasSettingsPopoverPanel {...panel} placement={placement} className="canvas-image-settings-popover">
                    <AudioSettingsPanel config={config} onConfigChange={(key, value) => onConfigChange(key, value)} theme={theme} className="space-y-4" />
                </CanvasSettingsPopoverPanel>
            ) : null}
        </>
    );
}
