import { useId } from "react";
import { App, Button, Input, Tooltip } from "antd";
import copyToClipboard from "copy-to-clipboard";
import { ChevronDown, CircleAlert, Copy, KeyRound, Link2, PlugZap, Terminal, Unplug } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { useAgentStore } from "@/stores/use-agent-store";

const AGENT_PLUGIN_REMOVE_COMMAND = "codex plugin remove infinite-canvas";
const AGENT_MCP_REMOVE_COMMAND = "codex mcp remove infinite-canvas";

export function AgentConnectView({
    theme,
    url,
    token,
    enabled,
    connected,
    activity,
    connectError,
    onUrlChange,
    onTokenChange,
    onToggleEnabled,
}: {
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    url: string;
    token: string;
    enabled: boolean;
    connected: boolean;
    activity: string;
    connectError: string;
    onUrlChange: (value: string) => void;
    onTokenChange: (value: string) => void;
    onToggleEnabled: () => void;
}) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const engine = useAgentStore((state) => state.engine);
    const fieldId = useId();
    const piEngine = engine === "pi";
    const statusText = connectError ? t("agent.status.failed") : connected ? activity || t("agent.status.connected") : enabled ? t("agent.status.connecting") : t("agent.status.disconnected");
    const copyCommand = (command: string) => {
        copyToClipboard(command);
        message.success(t("agent.connect.commandCopied"));
    };
    return (
        <div className="flex min-h-0 flex-1 flex-col" style={{ color: theme.node.text }}>
            <header className="shrink-0 px-6 pb-5 pt-6">
                <h2 className="!m-0 text-base font-medium leading-8 tracking-tight">{t("agent.panel.setup")}</h2>
                <p className="!mb-0 !mt-1.5 text-xs leading-5" style={{ color: theme.node.muted }}>{t("agent.connect.description")}</p>
            </header>
            <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-6 pb-6">
                <section className="border-t pt-4" style={{ borderColor: theme.node.stroke }} aria-label={t("agent.connect.webConnection")}>
                    <div className="flex items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2 text-xs leading-5" role="status">
                            <span className={`size-1.5 shrink-0 rounded-full ${connectError ? "bg-red-500" : connected ? "bg-emerald-500" : enabled ? "bg-amber-500" : "bg-current opacity-40"}`} />
                            <span className="truncate" title={statusText}>{statusText}</span>
                        </div>
                        <Button className="!h-8 shrink-0 !gap-1.5 !px-2 !text-xs" type="text" icon={enabled ? <Unplug className="size-4" strokeWidth={1.6} /> : <PlugZap className="size-4" strokeWidth={1.6} />} onClick={onToggleEnabled}>
                            {t(enabled ? "agent.connect.disconnect" : "agent.connect.connect")}
                        </Button>
                    </div>
                    <p className="!mb-0 !mt-2 text-xs leading-6" style={{ color: theme.node.muted }}>{t("agent.connect.autoDiscover")}</p>
                    <div className="mt-5 grid gap-4">
                        <div className="grid gap-2">
                            <label htmlFor={`${fieldId}-url`} className="text-xs font-medium">{t("agent.connect.localAddress")}</label>
                            <Input id={`${fieldId}-url`} className="!h-9 !text-xs" prefix={<Link2 className="mr-1 size-3.5" strokeWidth={1.6} style={{ color: theme.node.muted }} />} value={url} onChange={(event) => onUrlChange(event.target.value)} placeholder={t("agent.connect.urlPlaceholder")} />
                        </div>
                        <div className="grid gap-2">
                            <label htmlFor={`${fieldId}-token`} className="text-xs font-medium">{t("agent.connect.token")}</label>
                            <Input.Password
                                id={`${fieldId}-token`}
                                className="!h-9 !text-xs"
                                prefix={<KeyRound className="mr-1 size-3.5" strokeWidth={1.6} style={{ color: theme.node.muted }} />}
                                value={token}
                                onChange={(event) => onTokenChange(event.target.value)}
                                placeholder={t("agent.connect.tokenPlaceholder")}
                            />
                        </div>
                        {connectError ? (
                            <div className="flex items-start gap-2 text-xs leading-5 text-red-600 dark:text-red-400" role="alert">
                                <CircleAlert className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.6} />
                                <span className="min-w-0 break-words">{connectError}</span>
                            </div>
                        ) : null}
                    </div>
                </section>
                <details className="group mt-6 border-t pt-4" style={{ borderColor: theme.node.stroke }} open={!connected}>
                    <summary className="!flex cursor-pointer list-none items-center gap-2 rounded-sm py-1 text-xs font-medium focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 [&::-webkit-details-marker]:hidden">
                        <Terminal className="size-3.5" strokeWidth={1.6} style={{ color: theme.node.muted }} />
                        <span className="flex-1">{t("agent.connect.startGuide")}</span>
                        <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" strokeWidth={1.6} style={{ color: theme.node.muted }} />
                    </summary>
                    <div className="mt-4 space-y-5 text-xs leading-6">
                        {!piEngine ? (
                            <div>
                                <div className="font-medium">{t("agent.connect.pluginTitle")}</div>
                                <div className="mt-1.5" style={{ color: theme.node.muted }}>{t("agent.connect.pluginText")}</div>
                            </div>
                        ) : null}
                        <div>
                            <div className="font-medium">{t(piEngine ? "agent.connect.startAgent" : "agent.connect.directTitle")}</div>
                            <div className="mt-1.5" style={{ color: theme.node.muted }}>{t(piEngine ? "agent.connect.piStartText" : "agent.connect.directText")}</div>
                            <div className="mt-2 flex items-center gap-2">
                                <code className="min-w-0 flex-1 break-all text-[11px] leading-5">npx -y @basketikun/canvas-agent@latest</code>
                                <Tooltip title={t("agent.connect.copyCommand")} trigger={["hover", "focus"]}>
                                    <Button type="text" className="!h-8 !w-8 !min-w-8 shrink-0" aria-label={t("agent.connect.copyCommand")} icon={<Copy className="size-3.5" strokeWidth={1.6} />} onClick={() => copyCommand("npx -y @basketikun/canvas-agent@latest")} />
                                </Tooltip>
                            </div>
                        </div>
                        {piEngine ? <p className="!m-0" style={{ color: theme.node.muted }}>{t("agent.connect.piDetail")}</p> : (
                            <details className="group/reminder" style={{ color: theme.node.muted }}>
                                <summary className="!flex cursor-pointer list-none items-center gap-2 rounded-sm py-1 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 [&::-webkit-details-marker]:hidden">
                                    <span className="flex-1">{t("agent.connect.pluginReminder")}</span>
                                    <ChevronDown className="size-3.5 transition-transform group-open/reminder:rotate-180" strokeWidth={1.6} />
                                </summary>
                                <div className="mt-2">{t("agent.connect.pluginReminderText")}</div>
                                <div className="mt-3 space-y-3">
                                    {[[t("agent.connect.removePlugin"), AGENT_PLUGIN_REMOVE_COMMAND], [t("agent.connect.removeMcp"), AGENT_MCP_REMOVE_COMMAND]].map(([label, command]) => (
                                        <div key={command}>
                                            <div className="text-[11px]">{label}</div>
                                            <div className="flex items-center gap-2">
                                                <code className="min-w-0 flex-1 break-all text-[11px]" style={{ color: theme.node.text }}>{command}</code>
                                                <Tooltip title={t("agent.connect.copyCommand")} trigger={["hover", "focus"]}>
                                                    <Button type="text" className="!h-8 !w-8 !min-w-8 shrink-0" aria-label={`${t("agent.connect.copyCommand")}: ${label}`} icon={<Copy className="size-3.5" strokeWidth={1.6} />} onClick={() => copyCommand(command)} />
                                                </Tooltip>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </details>
                        )}
                    </div>
                </details>
            </div>
        </div>
    );
}
