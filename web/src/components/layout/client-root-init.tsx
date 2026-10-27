import type { ReactNode } from "react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Alert, App, Button, Modal, Result } from "antd";
import { useTranslation } from "react-i18next";

import { applyServerConfig, createAppConfigSnapshot } from "@/services/config-file";
import { getServerConfigSaveStatus, loadServerConfig, retryServerConfigSave, saveServerConfig, startServerConfigAutoSave, subscribeServerConfigSaveStatus } from "@/services/server-config";
import { getWorkspaceDataError, retryWorkspaceData, subscribeWorkspaceDataError } from "@/services/workspace-data";
import { useConfigStore } from "@/stores/use-config-store";
import { usePromptSourceScheduler } from "@/hooks/use-prompt-source-scheduler";
import { useAppLoadingStore } from "@/stores/use-app-loading-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const { t } = useTranslation();
    const [attempt, setAttempt] = useState(0);
    const { ready, error } = useServerConfigSync(attempt);
    const finishAppLoading = useAppLoadingStore((state) => state.finish);
    const startAppLoading = useAppLoadingStore((state) => state.start);
    const canvasHydrated = useCanvasStore((state) => state.hydrated);
    const assetsHydrated = useAssetStore((state) => state.hydrated);
    const pathname = window.location.pathname;
    const routeHydrated = (!pathname.startsWith("/canvas") || canvasHydrated) && (pathname !== "/assets" || assetsHydrated);

    useEffect(() => {
        if (error || (ready && routeHydrated)) finishAppLoading();
    }, [error, finishAppLoading, ready, routeHydrated]);

    if (error) {
        return <Result status="error" title={t("config.serverStorage.loadFailed")} subTitle={error} extra={<Button type="primary" onClick={() => { startAppLoading(); setAttempt((value) => value + 1); }}>{t("common.retry")}</Button>} />;
    }
    if (!ready) return null;
    return <ReadyClientRoot>{children}</ReadyClientRoot>;
}

function ReadyClientRoot({ children }: { children: ReactNode }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const handledConfigParams = useRef(false);
    const importChannelCredentials = useConfigStore((state) => state.importChannelCredentials);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const saveError = useSyncExternalStore(subscribeServerConfigSaveStatus, getServerConfigSaveStatus).error;
    const workspaceError = useSyncExternalStore(subscribeWorkspaceDataError, getWorkspaceDataError);
    const [conflict, setConflict] = useState<string>("");

    usePromptSourceScheduler();

    useEffect(() => {
        const onConflict = (event: Event) => {
            const detail = (event as CustomEvent<{ domain?: string }>).detail;
            const labels: Record<string, string> = { canvas: "画布", "canvas-templates": "画布模板", assets: "素材库", "image-workbench": "生图记录", "video-workbench": "视频记录", "agent-sessions": "Agent 会话" };
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
        const result = importChannelCredentials({ baseUrl, apiKey });
        openConfigDialog(false, "channels");
        if (result.status === "created") message.success(t("config.importedChannelCreated", { name: result.channelName }));
        else if (result.status === "updated") message.success(t("config.importedChannelUpdated", { name: result.channelName }));
        else if (result.status === "missing-base-url") message.error(t("config.importedChannelBaseUrlRequired"));
        else message.error(t("config.importedChannelBaseUrlInvalid"));
    }, [importChannelCredentials, message, openConfigDialog, t]);

    if (workspaceError?.mode === "read") return <Result status="error" title="无法读取服务器工作区数据" subTitle={workspaceError.message} extra={<Button type="primary" onClick={retryWorkspaceData}>{t("common.retry")}</Button>} />;

    return <>
        {children}
        {saveError || workspaceError ? <div className="fixed left-4 right-4 top-4 z-[1100] flex flex-col gap-2 sm:left-auto sm:max-w-md">
            {saveError ? <Alert type="error" showIcon message={t("config.serverStorage.saveFailed")} description={saveError} action={<Button size="small" onClick={retryServerConfigSave}>{t("common.retry")}</Button>} /> : null}
            {workspaceError ? <Alert type="error" showIcon message={workspaceError.mode === "conflict" ? "工作区数据发生冲突" : "工作区数据未保存"} description={workspaceError.message} action={<Button size="small" onClick={retryWorkspaceData}>{workspaceError.mode === "conflict" ? "刷新" : t("common.retry")}</Button>} /> : null}
        </div> : null}
        <Modal open={Boolean(conflict)} title="检测到多人编辑冲突" okText="刷新并读取服务器版本" cancelText="继续保留本机内容" onOk={() => window.location.reload()} onCancel={() => setConflict("")}>“{conflict}”已被另一位成员更新。系统没有覆盖对方的数据；请刷新读取服务器版本，再决定如何合并本机修改。</Modal>
    </>;
}

function useServerConfigSync(attempt: number) {
    const { t } = useTranslation();
    const [state, setState] = useState<{ ready: boolean; error: string }>({ ready: false, error: "" });
    const translationRef = useRef(t);
    translationRef.current = t;

    useEffect(() => {
        let active = true;
        let stopAutoSave: (() => void) | undefined;

        setState({ ready: false, error: "" });
        clearLegacyClientConfig();

        void (async () => {
            try {
                const serverConfig = await loadServerConfig({ force: attempt > 0 });
                if (!active) return;
                if (serverConfig) applyServerConfig(serverConfig);
                if (!serverConfig || serverConfig.promptSources.sources.some((source) => source.builtIn)) await saveServerConfig(createAppConfigSnapshot());
                if (!active) return;
                stopAutoSave = startServerConfigAutoSave();
                setState({ ready: true, error: "" });
            } catch (reason) {
                if (!active) return;
                setState({ ready: false, error: reason instanceof Error ? reason.message : translationRef.current("config.serverStorage.loadFailed") });
            }
        })();

        return () => {
            active = false;
            stopAutoSave?.();
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
