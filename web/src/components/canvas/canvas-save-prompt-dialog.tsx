import { App } from "antd";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { PromptEditorDialog } from "@/components/prompts/prompt-editor-dialog";
import { saveWorkspacePrompt, type WorkspacePromptInput } from "@/services/api/workspace-prompts";

export type CanvasPromptDraft = { title: string; prompt: string };

export function CanvasSavePromptDialog({ draft, onClose }: { draft: CanvasPromptDraft | null; onClose: () => void }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const save = async (input: WorkspacePromptInput) => {
        await saveWorkspacePrompt(input);
        onClose();
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: ["prompts"] }),
            queryClient.invalidateQueries({ queryKey: ["side-panel-prompts"] }),
        ]);
        message.success(t("prompts.saved"));
    };

    return <PromptEditorDialog open={Boolean(draft)} prompt={null} draft={draft} onClose={onClose} onSave={save} onError={(error) => message.error(error instanceof Error ? error.message : t("prompts.saveFailed"))} />;
}
