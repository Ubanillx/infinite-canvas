import { App, Button } from "antd";
import { Save } from "lucide-react";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { getUserPreferencesSaveStatus, saveUserPreferencesNow, subscribeUserPreferencesSaveStatus } from "@/services/user-preferences";

export function SaveUserPreferencesButton() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const saveStatus = useSyncExternalStore(subscribeUserPreferencesSaveStatus, getUserPreferencesSaveStatus);

    const save = async () => {
        try {
            await saveUserPreferencesNow();
            message.success(t("config.personalPreferences.saved"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("config.personalPreferences.saveFailed"));
        }
    };

    return <Button icon={<Save className="size-4" />} loading={saveStatus.saving} onClick={() => void save()}>{t("config.personalPreferences.save")}</Button>;
}
