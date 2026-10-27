import type { ReactNode } from "react";
import { Tooltip } from "antd";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";

export function AgentPanelTabs<T extends string>({ value, items, theme, leading, right, onChange }: { value: T; items: { value: T; label: string; icon: ReactNode; count?: number }[]; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; leading?: ReactNode; right?: ReactNode; onChange: (value: T) => void }) {
    const { t } = useTranslation();
    return (
        <div className="@container border-b px-2" style={{ borderColor: theme.node.stroke }}>
            <div className="grid h-12 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1">
                {leading ? <div className="col-start-1 row-start-1 flex items-center justify-self-start">{leading}</div> : null}
                <nav className="col-start-2 row-start-1 flex items-center justify-center gap-px @min-[440px]:gap-1.5" role="tablist" aria-label={t("agent.panel.content")}>
                    {items.map((item) => (
                        <Tooltip key={item.value} title={`${item.label}${item.count ? ` ${item.count}` : ""}`} trigger={["hover", "focus"]} placement="bottom">
                            <button type="button" role="tab" aria-label={`${item.label}${item.count ? ` ${item.count}` : ""}`} aria-selected={value === item.value} className="group relative grid h-12 w-[34px] shrink-0 place-items-center focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-4" style={{ color: value === item.value ? theme.node.text : theme.node.muted }} onClick={() => onChange(item.value)}>
                                <span aria-hidden="true" className="grid h-8 w-[34px] place-items-center rounded-md transition-colors group-hover:bg-black/5 dark:group-hover:bg-white/10">{item.icon}</span>
                                {value === item.value ? <span aria-hidden="true" className="absolute bottom-0 h-px w-6 bg-current" /> : null}
                            </button>
                        </Tooltip>
                    ))}
                </nav>
                {right ? <div className="col-start-3 row-start-1 flex items-center justify-self-end gap-1">{right}</div> : null}
            </div>
        </div>
    );
}
