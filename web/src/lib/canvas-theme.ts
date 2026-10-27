import { lightPalette } from "@/lib/light-palette";

export type CanvasColorTheme = "light" | "dark";
export type CanvasBackgroundMode = "dots" | "lines" | "blank";

export const canvasThemes = {
    light: {
        canvas: {
            background: lightPalette.background,
            dot: "rgba(70, 71, 65, .2)",
            line: "rgba(70, 71, 65, .09)",
            selectionStroke: lightPalette.primary,
            selectionFill: "rgba(48, 51, 47, .06)",
        },
        node: {
            label: lightPalette.mutedText,
            fill: lightPalette.soft,
            panel: lightPalette.surface,
            stroke: lightPalette.border,
            activeStroke: lightPalette.primary,
            placeholder: lightPalette.faintText,
            text: lightPalette.text,
            muted: lightPalette.mutedText,
            faint: lightPalette.faintText,
        },
        toolbar: {
            panel: "rgba(255, 255, 255, .96)",
            border: lightPalette.border,
            item: lightPalette.mutedText,
            itemHover: lightPalette.hover,
            activeBg: lightPalette.soft,
            activeText: lightPalette.text,
        },
    },
    dark: {
        canvas: {
            background: "#181715",
            dot: "rgba(245,245,244,.24)",
            line: "rgba(245,245,244,.10)",
            selectionStroke: "#fafaf9",
            selectionFill: "rgba(250,250,249,.10)",
        },
        node: {
            label: "#d6d3d1",
            fill: "#292524",
            panel: "#1f1d1a",
            stroke: "#44403c",
            activeStroke: "#fafaf9",
            placeholder: "#a8a29e",
            text: "#f5f5f4",
            muted: "#d6d3d1",
            faint: "#78716c",
        },
        toolbar: {
            panel: "rgba(31,29,26,.96)",
            border: "#44403c",
            item: "#d6d3d1",
            itemHover: "#292524",
            activeBg: "#3a3631",
            activeText: "#f5f5f4",
        },
    },
} as const;

export type CanvasTheme = (typeof canvasThemes)[CanvasColorTheme];
