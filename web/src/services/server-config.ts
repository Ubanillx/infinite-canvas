import i18n from "@/i18n";
import { isAppConfigFile, markServerConfigSaved, type AppConfigFile } from "@/services/config-file";

const serverConfigUrl = "/api/config";

export async function loadServerConfig() {
    const response = await fetch(serverConfigUrl, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (response.status === 204) return null;
    if (!response.ok) throw requestError(response.status);

    let data: unknown;
    try {
        data = await response.json();
    } catch {
        throw new Error(i18n.t("config.serverStorage.invalidResponse"));
    }
    if (!isAppConfigFile(data)) throw new Error(i18n.t("config.serverStorage.invalidResponse"));
    return data;
}

export async function saveServerConfig(config: AppConfigFile) {
    const response = await fetch(serverConfigUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
    });
    if (!response.ok) throw requestError(response.status);
    markServerConfigSaved(config);
}

function requestError(status: number) {
    return new Error(i18n.t("config.serverStorage.requestFailed", { status }));
}
