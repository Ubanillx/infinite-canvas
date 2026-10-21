import { FileText, ImagePlus, Images, Settings2, Shapes, Video } from "lucide-react";

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
