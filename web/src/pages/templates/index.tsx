import { useState } from "react";
import { Button } from "antd";
import { Images } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";

import { CanvasCreateProjectDialog } from "@/components/canvas/canvas-create-project-dialog";
import { CanvasTemplateGallery } from "@/components/canvas/canvas-template-library";
import { hasAgentUrlBootstrap } from "@/lib/agent/agent-url-bootstrap";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

export default function TemplatesPage() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const [selectedTemplateId, setSelectedTemplateId] = useState<string>();
    const hydrated = useCanvasStore((state) => state.hydrated);
    const folders = useCanvasStore((state) => state.folders);
    const folderId = folders.some((folder) => folder.id === searchParams.get("folder")) ? searchParams.get("folder") : null;
    const mode = searchParams.get("mode");
    const agentParams = new URLSearchParams(searchParams);
    agentParams.delete("folder");
    const agentQuery = mode === "new" || mode === "recent" || mode === "choose" ? `?${agentParams.toString()}` : "";
    const enterProject = (id: string) => {
        const agentHash = hasAgentUrlBootstrap(window.location.hash) ? window.location.hash : "";
        navigate(`/canvas/${id}${agentQuery}${agentHash}`, { replace: Boolean(agentHash) });
    };

    return <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
        <main className="min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-8 lg:px-10">
            <div className="flex w-full flex-col gap-6">
                <header className="flex flex-wrap items-end justify-between gap-3">
                    <div>
                        <p className="text-xs text-muted-foreground">{t("navigationGroups.resources")}</p>
                        <h1 className="mt-1 text-2xl font-semibold">{t("canvas.templates.library")}</h1>
                        <p className="mt-1 text-sm text-muted-foreground">{t("canvas.templates.libraryHint")}</p>
                    </div>
                    <Button icon={<Images className="size-4" />} onClick={() => navigate({ pathname: "/canvas", search: searchParams.toString(), hash: window.location.hash })}>{t("navigation.canvas")}</Button>
                </header>
                <section aria-label={t("canvas.templates.library")}>
                    <CanvasTemplateGallery fullPage manage disabled={!hydrated} onSelect={(template) => setSelectedTemplateId(template.id)} />
                </section>
            </div>
        </main>
        <CanvasCreateProjectDialog open={Boolean(selectedTemplateId)} folderId={folderId} initialTemplateId={selectedTemplateId} onCancel={() => setSelectedTemplateId(undefined)} onCreated={enterProject} />
    </div>;
}
