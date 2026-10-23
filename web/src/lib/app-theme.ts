import type { ThemeConfig } from "antd";
import { theme as antdTheme } from "antd";
import { lightPalette } from "@/lib/light-palette";

const neutral = {
    light: {
        primary: lightPalette.primary,
        primaryHover: lightPalette.primaryHover,
        primaryText: lightPalette.primaryText,
        elevatedBg: lightPalette.surface,
        itemHoverBg: "rgba(48, 51, 47, 0.05)",
        itemSelectedBg: "rgba(48, 51, 47, 0.09)",
        itemSelectedHoverBg: "rgba(48, 51, 47, 0.13)",
        itemText: lightPalette.text,
        tableSelectedBg: "rgba(48, 51, 47, 0.04)",
        tableSelectedHoverBg: "rgba(48, 51, 47, 0.07)",
    },
    dark: {
        primary: "#fafafa",
        primaryHover: "#ffffff",
        primaryText: "#171717",
        elevatedBg: "#1c1917",
        itemHoverBg: "rgba(250, 250, 249, 0.08)",
        itemSelectedBg: "rgba(250, 250, 249, 0.12)",
        itemSelectedHoverBg: "rgba(250, 250, 249, 0.16)",
        itemText: "#fafafa",
        tableSelectedBg: "rgba(255, 255, 255, 0.08)",
        tableSelectedHoverBg: "rgba(255, 255, 255, 0.12)",
    },
};

export function getAntThemeConfig(dark: boolean): ThemeConfig {
    const color = dark ? neutral.dark : neutral.light;

    return {
        algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        cssVar: { key: dark ? "infinite-canvas-dark" : "infinite-canvas-light" },
        token: {
            colorPrimary: color.primary,
            colorInfo: color.primary,
            colorLink: color.primary,
            colorLinkHover: color.primaryHover,
            colorLinkActive: color.primary,
            colorTextLightSolid: color.primaryText,
            colorBgElevated: color.elevatedBg,
            ...(!dark && {
                colorBgBase: lightPalette.background,
                colorBgContainer: lightPalette.surface,
                colorBgLayout: lightPalette.background,
                colorBorder: lightPalette.border,
                colorBorderSecondary: lightPalette.border,
                colorText: lightPalette.text,
                colorTextSecondary: lightPalette.mutedText,
                boxShadow: lightPalette.shadow,
                boxShadowSecondary: lightPalette.shadowHover,
            }),
            controlItemBgHover: color.itemHoverBg,
            controlItemBgActive: color.itemSelectedBg,
            controlItemBgActiveHover: color.itemSelectedHoverBg,
        },
        components: {
            Button: {
                defaultShadow: "none",
                primaryShadow: "none",
                dangerShadow: "none",
                defaultHoverBorderColor: dark ? "rgba(255, 255, 255, 0.14)" : lightPalette.border,
                defaultActiveBorderColor: dark ? "rgba(255, 255, 255, 0.14)" : lightPalette.border,
                defaultActiveBg: dark ? "#303030" : lightPalette.soft,
                defaultActiveColor: color.itemText,
            },
            Dropdown: {
                colorBgElevated: color.elevatedBg,
                colorText: color.itemText,
                controlItemBgHover: color.itemHoverBg,
                controlItemBgActive: color.itemSelectedBg,
                controlItemBgActiveHover: color.itemSelectedHoverBg,
            },
            Menu: {
                popupBg: color.elevatedBg,
                itemActiveBg: color.itemSelectedBg,
                itemHoverBg: color.itemHoverBg,
                itemSelectedBg: color.itemSelectedBg,
                itemSelectedColor: color.itemText,
                darkPopupBg: neutral.dark.elevatedBg,
                darkItemHoverBg: neutral.dark.itemHoverBg,
                darkItemSelectedBg: neutral.dark.itemSelectedBg,
                darkItemSelectedColor: neutral.dark.itemText,
            },
            Select: {
                optionActiveBg: color.itemHoverBg,
                optionSelectedBg: color.itemSelectedBg,
                optionSelectedColor: color.itemText,
            },
            Table: {
                rowSelectedBg: color.tableSelectedBg,
                rowSelectedHoverBg: color.tableSelectedHoverBg,
            },
        },
    };
}
