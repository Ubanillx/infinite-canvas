import { Cloud, Database, FileText, ImagePlus, Images, KeyRound, Settings2, Shapes, SlidersHorizontal, Video, Waypoints } from "lucide-react";
import type { ConfigTabKey } from "@/stores/use-config-store";

export const configSections = [
    { slug: "channels", label: "config.tabs.channels", icon: KeyRound },
    { slug: "preferences", label: "config.tabs.preferences", icon: SlidersHorizontal },
    { slug: "prompt-sources", label: "config.tabs.promptSources", icon: Waypoints },
    { slug: "webdav", label: "config.tabs.webdav", icon: Cloud },
    { slug: "local-storage", label: "config.tabs.localStorage", icon: Database },
] as const satisfies ReadonlyArray<{ slug: ConfigTabKey; label: string; icon: typeof Settings2 }>;

export const navigationTools = [
    {
        slug: "canvas",
        icon: Shapes,
    },
    {
        slug: "image",
        icon: ImagePlus,
    },
    {
        slug: "video",
        icon: Video,
    },
    {
        slug: "prompts",
        icon: FileText,
    },
    {
        slug: "assets",
        icon: Images,
    },
    {
        slug: "config",
        icon: Settings2,
    },
] as const;

export type NavigationToolSlug = (typeof navigationTools)[number]["slug"];

export const navigationGroups = [
    { key: "create", tools: navigationTools.slice(0, 3) },
    { key: "resources", tools: navigationTools.slice(3, 5) },
    { key: "settings", tools: navigationTools.slice(5) },
] as const;
