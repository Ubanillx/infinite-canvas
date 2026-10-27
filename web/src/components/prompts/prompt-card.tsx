import { Copy, FileText } from "lucide-react";
import type { ReactNode } from "react";
import { Button, Card, Tag } from "antd";
import { useTranslation } from "react-i18next";

import { formatPromptDate, type Prompt } from "@/services/api/prompts";

export function PromptCard({
    item,
    onOpen,
    onCopy,
    actionLabel,
    actionIcon = <Copy className="size-3.5" />,
    actionType = "text",
    extraAction,
    compact = false,
}: {
    item: Prompt;
    onOpen: () => void;
    onCopy: () => void;
    actionLabel?: string;
    actionIcon?: ReactNode;
    actionType?: "text" | "primary";
    extraAction?: ReactNode;
    compact?: boolean;
}) {
    const { i18n, t } = useTranslation();
    return (
        <Card
            hoverable
            className={compact ? "group cursor-pointer overflow-hidden transition-transform duration-200 hover:-translate-y-1" : "flex h-full flex-col overflow-hidden !rounded-lg !border-border !shadow-none hover:!shadow-none"}
            styles={{ body: compact ? { padding: 0 } : { display: "flex", flex: 1, flexDirection: "column", padding: 0 } }}
            cover={
                <button type="button" className="block w-full cursor-pointer text-left" onClick={onOpen}>
                    {item.coverUrl ? <img src={item.coverUrl} alt={item.title} className={compact ? "aspect-square w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" : "aspect-[4/3] w-full object-cover"} loading="lazy" /> : <span className={compact ? "grid aspect-square w-full place-items-center bg-stone-100 text-stone-400 dark:bg-stone-900 dark:text-stone-600" : "grid aspect-[4/3] w-full place-items-center bg-accent/40 text-muted-foreground"}><FileText className="size-6" /></span>}
                </button>
            }
        >
            <button type="button" className={compact ? "block w-full cursor-pointer text-left" : "block w-full flex-1 cursor-pointer text-left"} onClick={onOpen}>
                <div className={compact ? "px-3 py-2.5" : "p-4"}>
                    <div className="flex items-start justify-between gap-3">
                        <h2 className="line-clamp-1 text-sm font-semibold text-stone-950 dark:text-stone-100">{item.title}</h2>
                        {!compact ? <span className="shrink-0 text-xs text-stone-400 dark:text-stone-500">{formatPromptDate(item.updatedAt, i18n.resolvedLanguage)}</span> : null}
                    </div>
                    {!compact ? <>{item.category || (item.workspaceId && item.shared) ? <div className="mt-2 flex flex-wrap gap-1">{item.category ? <Tag bordered={false} className="!m-0 !bg-accent/60 !text-xs !text-muted-foreground">{item.category}</Tag> : null}{item.workspaceId && item.shared ? <Tag bordered={false} className="!m-0 !bg-accent/60 !text-xs !text-muted-foreground">{t("prompts.public")}</Tag> : null}</div> : null}<p className="mt-2 line-clamp-3 text-xs leading-5 text-muted-foreground">{item.description || item.prompt}</p><div className="mt-3 flex flex-wrap gap-1.5">{item.tags.map((tag) => <Tag key={tag} className="m-0 text-[11px]">{tag}</Tag>)}</div></> : null}
                </div>
            </button>
            {!compact ? <div className="mt-auto flex flex-wrap items-center gap-1 px-3 pb-3"><Button block={actionType === "primary"} type={actionType} size="small" icon={actionIcon} onClick={onCopy}>{actionLabel || t("common.copyPrompt")}</Button>{extraAction}</div> : null}
        </Card>
    );
}
