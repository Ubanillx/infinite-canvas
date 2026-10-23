import { Check, Folder, Pencil, Trash2, X } from "lucide-react";
import type { DragEvent } from "react";
import { Button, Input } from "antd";
import { useTranslation } from "react-i18next";

import type { CanvasFolder } from "@/stores/canvas/use-canvas-store";

export function CanvasFolderCard({
    folder,
    itemCount,
    selected,
    dropTarget,
    onSelect,
    onOpen,
    onDragOver,
    onDrop,
    onDragStart,
    onDragEnd,
    editing,
    editingTitle,
    onStartEditing,
    onEditingTitleChange,
    onSave,
    onCancel,
    onDelete,
}: {
    folder: CanvasFolder;
    itemCount: number;
    selected: boolean;
    dropTarget: boolean;
    onSelect: () => void;
    onOpen: () => void;
    onDragOver: (event: DragEvent<HTMLElement>) => void;
    onDrop: (event: DragEvent<HTMLElement>) => void;
    onDragStart: (event: DragEvent<HTMLElement>) => void;
    onDragEnd: () => void;
    editing: boolean;
    editingTitle: string;
    onStartEditing: () => void;
    onEditingTitleChange: (value: string) => void;
    onSave: () => void;
    onCancel: () => void;
    onDelete: () => void;
}) {
    const { t } = useTranslation();
    return (
        <article
            className={`group flex min-h-40 cursor-grab flex-col justify-between rounded-lg border p-4 transition-colors active:cursor-grabbing ${dropTarget || selected ? "border-border bg-accent" : "border-border bg-card hover:bg-accent/40 dark:border-white/10 dark:bg-white/5 dark:hover:bg-white/10"}`}
            draggable={!editing}
            onClick={onSelect}
            onDoubleClick={(event) => {
                event.stopPropagation();
                if (!editing) onOpen();
            }}
            onDragStart={(event) => {
                if ((event.target as HTMLElement).closest("button,input")) {
                    event.preventDefault();
                    return;
                }
                onDragStart(event);
            }}
            onDragEnd={onDragEnd}
            onDragOver={onDragOver}
            onDrop={(event) => {
                event.stopPropagation();
                onDrop(event);
            }}
        >
            <div className="flex items-start gap-3">
                <Folder className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                {editing ? (
                    <Input className="min-w-0" value={editingTitle} onClick={(event) => event.stopPropagation()} onChange={(event) => onEditingTitleChange(event.target.value)} onKeyDown={(event) => event.key === "Enter" && onSave()} autoFocus />
                ) : (
                    <button type="button" className="min-w-0 cursor-pointer text-left" onClick={(event) => { event.stopPropagation(); onSelect(); }} onDoubleClick={(event) => { event.stopPropagation(); onOpen(); }}>
                        <h2 className="truncate text-base font-semibold">{folder.title}</h2>
                        <p className="mt-2 text-xs text-muted-foreground">{t("canvas.folder.itemCount", { count: itemCount })}</p>
                    </button>
                )}
            </div>
            <div className="mt-4 flex items-end justify-end gap-1" onClick={(event) => event.stopPropagation()}>
                {editing ? (
                    <>
                        <Button type="text" size="small" shape="circle" icon={<Check className="size-4" />} onClick={onSave} aria-label={t("canvas.folder.saveName")} />
                        <Button type="text" size="small" shape="circle" icon={<X className="size-4" />} onClick={onCancel} aria-label={t("canvas.folder.cancelRename")} />
                    </>
                ) : (
                    <>
                        <Button type="text" size="small" shape="circle" icon={<Pencil className="size-4" />} onClick={onStartEditing} aria-label={t("canvas.folder.rename")} />
                        <Button type="text" size="small" shape="circle" icon={<Trash2 className="size-4" />} onClick={onDelete} aria-label={t("canvas.folder.delete")} />
                    </>
                )}
            </div>
        </article>
    );
}
