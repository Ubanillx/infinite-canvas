import { useEffect, useState } from "react";
import { Input } from "antd";
import { useTranslation } from "react-i18next";

import { getNodeDefinition, isBuiltinNodeType, useNodeRegistryVersion } from "@/lib/canvas/node-registry";
import { prepareTemplateContent } from "@/lib/canvas/canvas-template";
import { getActiveWorkspace } from "@/lib/workspace";
import { requireTemplateWorkspace } from "@/services/canvas-templates";
import { uploadImage } from "@/services/image-storage";
import { modelCapabilityOf, selectableModelsByCapability, useConfigStore } from "@/stores/use-config-store";
import { CanvasNodeType } from "@/types/canvas";
import type { CanvasTemplateContent } from "@/types/canvas-template";

export function useCanvasTemplateOptions(source?: CanvasTemplateContent) {
    const { t } = useTranslation();
    const config = useConfigStore((state) => state.config);
    useNodeRegistryVersion((state) => state.version);
    const [keepExamples, setKeepExamples] = useState(true);
    const [inputs, setInputs] = useState<Record<string, string | File>>({});
    const [replacements, setReplacements] = useState<Record<string, string>>({});
    useEffect(() => { setKeepExamples(true); setInputs({}); setReplacements({}); }, [source]);
    const nodes = source?.nodes || [];
    const missingPlugins = nodes.filter((node) => !isBuiltinNodeType(node.type) && !getNodeDefinition(node.type));
    const capability = (node: typeof nodes[number]) => node.metadata?.generationMode || (node.type === CanvasNodeType.Config ? "image" : node.type === CanvasNodeType.Image ? "image" : node.type === CanvasNodeType.Video ? "video" : node.type === CanvasNodeType.Audio ? "audio" : node.type === CanvasNodeType.Text ? "text" : undefined);
    const missingModels = nodes.filter((node) => node.metadata?.model && (!modelCapabilityOf(config, node.metadata.model) || (capability(node) && modelCapabilityOf(config, node.metadata.model) !== capability(node))));
    const blocked = missingPlugins.length > 0 || missingModels.some((node) => !selectableModelsByCapability(config, capability(node)).includes(replacements[node.id]));
    const prepare = async () => {
        if (!source || blocked) throw new Error(t("canvas.templates.v2.resolveDependencies"));
        const workspaceId = getActiveWorkspace()?.id;
        requireTemplateWorkspace(workspaceId);
        // Validate every required slot before uploading anything.
        nodes.forEach((node) => { const value = inputs[node.id]; if (node.metadata?.templateInput?.required && (!value || (typeof value === "string" && !value.trim()))) throw new Error(t("canvas.templates.v2.fillRequired", { name: node.metadata.templateInput.name })); });
        const values: Parameters<typeof prepareTemplateContent>[2] = {};
        for (const [id, value] of Object.entries(inputs)) {
            requireTemplateWorkspace(workspaceId);
            if (typeof value === "string") values[id] = value;
            else {
                const image = await uploadImage(value);
                requireTemplateWorkspace(workspaceId);
                values[id] = { storageKey: image.storageKey!, content: image.storageKey!, naturalWidth: image.width, naturalHeight: image.height, bytes: image.bytes, mimeType: image.mimeType };
            }
        }
        return prepareTemplateContent(source, keepExamples, values, replacements);
    };
    return { nodes, config, capability, missingModels, missingPlugins, blocked, keepExamples, setKeepExamples, inputs, setInputs, replacements, setReplacements, prepare };
}

export function CanvasTemplateUseFields({ options, disabled }: { options: ReturnType<typeof useCanvasTemplateOptions>; disabled: boolean }) {
    const { t } = useTranslation();
    const slots = options.nodes.filter((node) => node.metadata?.templateInput);
    return <fieldset disabled={disabled} className="mb-5 space-y-4 text-sm">
        <legend className="mb-3 font-medium">{t("canvas.templates.v2.useOptions")}</legend>
        <label className="flex gap-2"><input type="checkbox" checked={options.keepExamples} onChange={(event) => options.setKeepExamples(event.target.checked)} />{t("canvas.templates.v2.keepExamples")}</label>
        <p className="text-xs leading-5 text-muted-foreground">{t("canvas.templates.v2.examplesHint")}</p>
        {slots.map((node) => <label key={node.id} className="block space-y-2"><span>{node.metadata!.templateInput!.name}{node.metadata!.templateInput!.required ? " *" : ""}</span><span className="block text-xs text-muted-foreground">{node.metadata!.templateInput!.description}</span>{node.type === CanvasNodeType.Image ? <input type="file" accept="image/*" aria-label={node.metadata!.templateInput!.name} className="block w-full text-xs" onChange={(event) => options.setInputs((previous) => ({ ...previous, [node.id]: event.target.files?.[0] || "" }))} /> : <Input.TextArea aria-label={node.metadata!.templateInput!.name} rows={2} value={typeof options.inputs[node.id] === "string" ? options.inputs[node.id] as string : ""} onChange={(event) => options.setInputs((previous) => ({ ...previous, [node.id]: event.target.value }))} />}</label>)}
        {options.missingPlugins.length ? <p role="alert">{t("canvas.templates.v2.missingPlugins", { names: [...new Set(options.missingPlugins.map((node) => node.type))].join(", ") })}</p> : null}
        {options.missingModels.map((node) => <label key={node.id} className="block space-y-2"><span>{node.title} · {t("canvas.templates.v2.missingModel", { name: node.metadata!.model })}</span><select aria-label={t("canvas.templates.v2.replaceModel", { name: node.metadata!.model })} className="w-full rounded border border-border bg-background p-2" value={options.replacements[node.id] || ""} onChange={(event) => options.setReplacements((previous) => ({ ...previous, [node.id]: event.target.value }))}><option value="">{t("canvas.templates.v2.chooseReplacement")}</option>{selectableModelsByCapability(options.config, options.capability(node)).map((model) => <option key={model} value={model}>{model}</option>)}</select></label>)}
        <p className="text-xs text-muted-foreground">{t("canvas.templates.v2.noAutoRun")}</p>
    </fieldset>;
}
