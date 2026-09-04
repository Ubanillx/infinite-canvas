import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { App, Button, Modal, Result, Spin } from "antd";
import { useTranslation } from "react-i18next";

import { applyServerConfig } from "@/services/config-file";
import { loadServerConfig } from "@/services/server-config";
import { createModelChannel, useConfigStore } from "@/stores/use-config-store";
import { usePromptSourceScheduler } from "@/hooks/use-prompt-source-scheduler";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const { t } = useTranslation();
    const [attempt, setAttempt] = useState(0);
    const { ready, error } = useServerConfigSync(attempt);

    if (error) {
        return <Result status="error" title={t("config.serverStorage.loadFailed")} subTitle={error} extra={<Button type="primary" onClick={() => setAttempt((value) => value + 1)}>{t("common.retry")}</Button>} />;
    }
    if (!ready) {
        return (
            <div className="flex min-h-screen items-center justify-center">
                <div className="flex flex-col items-center gap-3 text-sm text-stone-500">
                    <Spin size="large" />
                    <span>{t("config.serverStorage.loading")}</span>
                </div>
            </div>
        );
    }
    return <ReadyClientRoot>{children}</ReadyClientRoot>;
}

function ReadyClientRoot({ children }: { children: ReactNode }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const handledConfigParams = useRef(false);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const config = useConfigStore((state) => state.config);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const [conflict, setConflict] = useState<string>("");

    usePromptSourceScheduler();

    useEffect(() => {
        const onConflict = (event: Event) => {
            const detail = (event as CustomEvent<{ domain?: string }>).detail;
            const labels: Record<string, string> = { canvas: "画布", assets: "素材库", "image-workbench": "生图记录", "video-workbench": "视频记录", "agent-sessions": "Agent 会话" };
            setConflict(labels[detail?.domain || ""] || "工作区数据");
        };
        window.addEventListener("infinite-canvas:workspace-conflict", onConflict);
        return () => window.removeEventListener("infinite-canvas:workspace-conflict", onConflict);
    }, []);

    useEffect(() => {
        if (handledConfigParams.current) return;
        const searchParams = new URLSearchParams(window.location.search);
        const baseUrl = searchParams.get("baseUrl") || searchParams.get("baseurl");
        const apiKey = searchParams.get("apiKey") || searchParams.get("apikey");
        if (!baseUrl && !apiKey) return;
        handledConfigParams.current = true;
        searchParams.delete("baseUrl");
        searchParams.delete("baseurl");
        searchParams.delete("apiKey");
        searchParams.delete("apikey");
        window.history.replaceState(null, "", `${window.location.pathname}${searchParams.size ? `?${searchParams}` : ""}${window.location.hash}`);
        const firstChannel = config.channels[0];
        updateConfig(
            "channels",
            firstChannel
                ? config.channels.map((channel, index) =>
                      index === 0
                          ? {
                                ...channel,
                                ...(baseUrl ? { baseUrl } : {}),
                                ...(apiKey ? { apiKey } : {}),
                            }
                          : channel,
                  )
                : [createModelChannel({ id: "default", name: t("config.channels.defaultName"), baseUrl: baseUrl || undefined, apiKey: apiKey || "" })],
        );
        if (baseUrl) updateConfig("baseUrl", baseUrl);
        if (apiKey) updateConfig("apiKey", apiKey);
        openConfigDialog(false);
        message.success(t("config.importedDirectConfig"));
    }, [config.channels, message, openConfigDialog, t, updateConfig]);

    return <>{children}<Modal open={Boolean(conflict)} title="检测到多人编辑冲突" okText="刷新并读取服务器版本" cancelText="继续保留本机内容" onOk={() => window.location.reload()} onCancel={() => setConflict("")}>“{conflict}”已被另一位成员更新。系统没有覆盖对方的数据；请刷新读取服务器版本，再决定如何合并本机修改。</Modal></>;
}

function useServerConfigSync(attempt: number) {
    const { t } = useTranslation();
    const [state, setState] = useState<{ ready: boolean; error: string }>({ ready: false, error: "" });
    const translationRef = useRef(t);
    translationRef.current = t;

    useEffect(() => {
        let active = true;

        setState({ ready: false, error: "" });
        clearLegacyClientConfig();

        void (async () => {
            try {
                const serverConfig = await loadServerConfig({ force: attempt > 0 });
                if (!active) return;
                if (serverConfig) applyServerConfig(serverConfig);
                setState({ ready: true, error: "" });
            } catch (reason) {
                if (!active) return;
                setState({ ready: false, error: reason instanceof Error ? reason.message : translationRef.current("config.serverStorage.loadFailed") });
            }
        })();

        return () => {
            active = false;
        };
    }, [attempt]);

    return state;
}

function clearLegacyClientConfig() {
    try {
        window.localStorage.removeItem("infinite-canvas:ai_config_store");
        window.localStorage.removeItem("infinite-canvas:prompt_source_store_v2");
    } catch {
        // Storage may be unavailable in private or restricted browser contexts.
    }
}
