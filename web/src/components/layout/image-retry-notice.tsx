import { useEffect } from "react";
import { App } from "antd";
import { useTranslation } from "react-i18next";

import { subscribeImageRetry } from "@/lib/image-retry-notice";

export function ImageRetryNotice() {
    const { message } = App.useApp();
    const { t } = useTranslation();

    useEffect(
        () =>
            subscribeImageRetry(() => {
                message.open({ key: "image-generation-retry", type: "info", content: t("generation.retryingImage"), duration: 3 });
            }),
        [message, t],
    );

    return null;
}
