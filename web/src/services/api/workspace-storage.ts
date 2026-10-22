import i18n from "@/i18n";
import { workspaceHeaders } from "@/lib/workspace";

export type WorkspaceStorageSummary = {
    workspaceId: string;
    domains: { domain: string; bytes: number; revision: number; updatedAt: string }[];
    media: { files: number; bytes: number; updatedAt: string | null };
};

export async function readWorkspaceStorageSummary(): Promise<WorkspaceStorageSummary> {
    const response = await fetch("/api/data/summary", { headers: workspaceHeaders(), cache: "no-store" });
    if (!response.ok) throw new Error(i18n.t("config.localStorage.serverRequestFailed", { status: response.status }));
    return response.json() as Promise<WorkspaceStorageSummary>;
}
