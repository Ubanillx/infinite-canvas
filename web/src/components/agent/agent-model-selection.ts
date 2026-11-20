type ModelChoice = { model: string; isDefault?: boolean };

export function selectAgentModel(models: readonly ModelChoice[], defaultModel: string, currentModel: string, preferDefault: boolean) {
    const preferred = models.find((item) => item.model === defaultModel);
    const current = models.find((item) => item.model === currentModel);
    return (preferDefault ? preferred || current : current || preferred)?.model || models.find((item) => item.isDefault)?.model || models[0]?.model || "";
}
