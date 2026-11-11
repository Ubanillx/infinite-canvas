import { App } from "antd";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { downloadMedia, type MediaDownloadSource } from "@/services/media-download";

export function useMediaDownload() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    return useCallback(async (source: MediaDownloadSource, fileName: string) => {
        try {
            await downloadMedia(source, fileName);
        } catch {
            message.error(t("assets.downloadFailed"));
        }
    }, [message, t]);
}
