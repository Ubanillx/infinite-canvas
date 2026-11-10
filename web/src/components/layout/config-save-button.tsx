import { App, Button } from "antd";
import { Save } from "lucide-react";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { getServerConfigSaveStatus, saveServerConfigNow, subscribeServerConfigSaveStatus } from "@/services/server-config";

export function SaveConfigButton({ label, automatic = false }: { label?: string; automatic?: boolean }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const serverSave = useSyncExternalStore(subscribeServerConfigSaveStatus, getServerConfigSaveStatus);

    const save = async () => {
        try {
            await saveServerConfigNow();
            message.success(t("config.serverStorage.saved"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("config.serverStorage.saveFailed"));
        }
    };

    if (automatic && !serverSave.error) return <span role="status" className="inline-flex min-h-8 items-center text-sm text-muted-foreground">{t(serverSave.saving ? "config.serverStorage.saving" : "config.webdav.connectionAutoSave")}</span>;
    return <Button icon={<Save className="size-4" />} loading={serverSave.saving} onClick={() => void save()}>{label || t("config.serverStorage.save")}</Button>;
}
