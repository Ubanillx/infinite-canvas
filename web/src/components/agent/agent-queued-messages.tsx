import { Button, Tooltip } from "antd";
import { Play, X, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { useAgentStore, type AgentQueuedMessage } from "@/stores/use-agent-store";

export function AgentQueuedMessages({
    theme,
    jumpingId,
    disabled,
    onSendNow,
    onRemove,
    onResume,
}: {
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    jumpingId: string;
    disabled: boolean;
    onSendNow: (item: AgentQueuedMessage) => void;
    onRemove: (id: string) => void;
    onResume: () => void;
}) {
    const { t } = useTranslation();
    const queue = useAgentStore((state) => state.queue);
    const paused = useAgentStore((state) => state.queuePaused);
    if (!queue.length) return null;
    return (
        <div className="shrink-0 px-3 pt-2">
            <div className="rounded-xl border px-2 py-1.5" style={{ borderColor: theme.node.stroke, background: theme.toolbar.panel }}>
                <div className="flex items-center justify-between gap-2 px-1 pb-1 text-[10px]" style={{ color: theme.node.muted }}>
                    <span>{t("agent.queue.title", { count: queue.length })}</span>
                    {paused ? (
                        <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition hover:bg-black/5 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 dark:hover:bg-white/10"
                            style={{ color: theme.node.text }}
                            onClick={onResume}
                        >
                            <Play className="size-3" strokeWidth={1.6} />
                            {t("agent.queue.resume")}
                        </button>
                    ) : null}
                </div>
                <div className="thin-scrollbar max-h-32 space-y-0.5 overflow-y-auto">
                    {queue.map((item) => (
                        <QueueRow key={item.id} item={item} theme={theme} disabled={disabled || Boolean(jumpingId)} jumping={jumpingId === item.id} onSendNow={onSendNow} onRemove={onRemove} />
                    ))}
                </div>
            </div>
        </div>
    );
}

function QueueRow({ item, theme, disabled, jumping, onSendNow, onRemove }: { item: AgentQueuedMessage; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; disabled: boolean; jumping: boolean; onSendNow: (item: AgentQueuedMessage) => void; onRemove: (id: string) => void }) {
    const { t } = useTranslation();
    const preview = item.draftText.trim() || item.text;
    const meta = [
        item.attachments.length ? t("agent.queue.attachments", { count: item.attachments.length }) : "",
        item.messageReferences.length ? t("agent.queue.references", { count: item.messageReferences.length }) : "",
        item.skill ? t("agent.queue.skill", { name: item.skill.displayName || item.skill.name }) : "",
    ].filter(Boolean).join(" · ");
    return (
        <div className="flex items-center gap-1.5 rounded-lg px-1 py-1 transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.06]">
            <div className="min-w-0 flex-1">
                <div className="truncate text-xs" style={{ color: theme.node.text }} title={preview}>{preview}</div>
                {meta ? <div className="truncate text-[10px]" style={{ color: theme.node.muted }}>{meta}</div> : null}
            </div>
            <Tooltip title={t("agent.queue.sendNowHint")} placement="top">
                <Button type="text" size="small" className="!h-7 !w-7 !min-w-7" disabled={disabled} loading={jumping} style={{ color: theme.node.muted }} icon={<Zap className="size-3.5" strokeWidth={1.6} />} onClick={() => onSendNow(item)} aria-label={t("agent.queue.sendNow")} />
            </Tooltip>
            <Tooltip title={t("agent.queue.remove")} placement="top">
                <Button type="text" size="small" className="!h-7 !w-7 !min-w-7" disabled={disabled} style={{ color: theme.node.muted }} icon={<X className="size-3.5" strokeWidth={1.6} />} onClick={() => onRemove(item.id)} aria-label={t("agent.queue.remove")} />
            </Tooltip>
        </div>
    );
}
