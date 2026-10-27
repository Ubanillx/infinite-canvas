import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Empty, Image, Input, Modal, Pagination, Tag } from "antd";
import { Search } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { getImagePreviewRevision, subscribeImagePreviews } from "@/services/image-storage";
import { assetCoverUrl, useAssetStore, type Asset } from "@/stores/use-asset-store";

export type InsertAssetPayload = { kind: "text"; content: string; title: string } | { kind: "image"; dataUrl: string; title: string; storageKey?: string } | { kind: "video"; url: string; title: string; storageKey?: string; width?: number; height?: number };

type Props = {
    open: boolean;
    defaultTab?: string;
    flat?: boolean;
    onInsert: (payload: InsertAssetPayload) => void;
    onClose: () => void;
};

export function AssetPickerModal({ open, onInsert, onClose, flat = false }: Props) {
    const { t } = useTranslation();
    return (
        <Modal title={t("canvas.assetPicker.title")} open={open} onCancel={onClose} footer={null} width={flat ? "min(1360px, calc(100vw - 48px))" : 860} centered={flat} destroyOnHidden classNames={flat ? { root: "image-workbench-overlay", body: "[&_button]:!shadow-none" } : undefined} styles={{ body: { padding: flat ? 0 : "0 24px 24px", minHeight: 480, ...(flat ? { height: "min(76dvh, 900px)" } : {}) }, ...(flat ? { container: { boxShadow: "none", border: "1px solid var(--border)" } } : {}) }}>
            <MyAssetsTab onInsert={onInsert} flat={flat} />
        </Modal>
    );
}

const PAGE_SIZE = 8;

const kindOptions = ["all", "text", "image", "video"];

function PickerCard({ asset, cover, onPreview, onInsert }: { asset: Asset; cover: string; onPreview: () => void; onInsert: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="group overflow-hidden rounded-lg border border-border bg-card">
            <button type="button" className="block w-full text-left transition hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none" onClick={onPreview} aria-label={`${t("canvas.sidePanel.preview")}：${asset.title}`}>
                {cover ? (
                    <img src={cover} alt={asset.title} className="aspect-[4/3] w-full object-cover" />
                ) : (
                    <div className="flex aspect-[4/3] items-center justify-center bg-muted p-3 text-center text-xs leading-5 text-muted-foreground">{asset.title}</div>
                )}
                <div className="flex items-center justify-between gap-2 p-2.5">
                    <span className="line-clamp-1 text-xs font-medium text-foreground">{asset.title}</span>
                    <Tag className="m-0 shrink-0 text-[10px]">{t(`assets.kinds.${asset.kind}`)}</Tag>
                </div>
            </button>
            <div className="border-t border-border p-2">
                <button type="button" onClick={onInsert} className="h-8 w-full rounded-md border border-border bg-card text-xs font-medium text-foreground transition hover:bg-muted focus-visible:bg-muted focus-visible:outline-none">{t("canvas.assetPicker.insert")}</button>
            </div>
        </div>
    );
}

function MyAssetsTab({ onInsert, flat }: { onInsert: (payload: InsertAssetPayload) => void; flat: boolean }) {
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const assets = useAssetStore((state) => state.assets);
    const [keyword, setKeyword] = useState("");
    const [kindFilter, setKindFilter] = useState("all");
    const [page, setPage] = useState(1);
    const [previewAsset, setPreviewAsset] = useState<Asset | null>(null);

    const filtered = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        return assets
            .filter((a) => a.kind === "text" || a.kind === "image" || a.kind === "video")
            .filter((a) => kindFilter === "all" || a.kind === kindFilter)
            .filter((a) => !query || [a.title, ...(a.tags || [])].join(" ").toLowerCase().includes(query));
    }, [assets, keyword, kindFilter]);

    const visible = useMemo(() => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [filtered, page]);

    useEffect(() => {
        const maxPage = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
        setPage((v) => Math.min(v, maxPage));
    }, [filtered.length]);

    const handleInsert = (asset: Asset) => {
        if (asset.kind === "text") {
            onInsert({ kind: "text", content: asset.data.content, title: asset.title });
        } else {
            onInsert(asset.kind === "video" ? { kind: "video", url: asset.data.url, storageKey: asset.data.storageKey, title: asset.title, width: asset.data.width, height: asset.data.height } : { kind: "image", dataUrl: asset.data.dataUrl, storageKey: asset.data.storageKey, title: asset.title });
        }
    };

    return (
        <div className={flat ? "flex h-full min-h-0 flex-col gap-4" : "space-y-4"}>
            <div className="flex flex-col items-stretch gap-3">
                <Input
                    className="app-search-input !h-10 !w-full !rounded-lg"
                    size="large"
                    prefix={<Search className="size-4 text-muted-foreground" />}
                    placeholder={t("canvas.assetPicker.search")}
                    value={keyword}
                    allowClear
                    onChange={(e) => {
                        setPage(1);
                        setKeyword(e.target.value);
                    }}
                />
                <div className="flex flex-wrap gap-1.5">
                    {kindOptions.map((option) => (
                        <Tag.CheckableTag
                            key={option}
                            checked={kindFilter === option}
                            className={cn("prompt-filter-tag", kindFilter === option && "is-active")}
                            onChange={() => {
                                setPage(1);
                                setKindFilter(option);
                            }}
                        >
                            {option === "all" ? t("common.all") : t(`assets.kinds.${option}`)}
                        </Tag.CheckableTag>
                    ))}
                </div>
            </div>

            <div className={flat ? "thin-scrollbar min-h-0 flex-1 overflow-y-auto pr-2" : undefined}>
                {visible.length ? (
                    <div className="grid grid-cols-4 gap-3">
                        {visible.map((asset) => (
                            <PickerCard key={asset.id} asset={asset} cover={assetCoverUrl(asset)} onPreview={() => setPreviewAsset(asset)} onInsert={() => handleInsert(asset)} />
                        ))}
                    </div>
                ) : (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("canvas.assetPicker.empty")} className="py-12" />
                )}
            </div>

            {filtered.length > PAGE_SIZE && (
                <div className="flex justify-center">
                    <Pagination size="small" current={page} pageSize={PAGE_SIZE} total={filtered.length} onChange={setPage} showSizeChanger={false} />
                </div>
            )}
            {previewAsset?.kind === "image" ? <Image src={previewAsset.data.dataUrl} alt={previewAsset.title} style={{ display: "none" }} preview={{ visible: true, src: previewAsset.data.dataUrl, onVisibleChange: (visible) => !visible && setPreviewAsset(null) }} /> : null}
            <Modal title={previewAsset?.title} open={!!previewAsset && previewAsset.kind !== "image"} onCancel={() => setPreviewAsset(null)} footer={null} width={720} centered destroyOnHidden classNames={flat ? { root: "image-workbench-overlay" } : undefined} styles={flat ? { container: { boxShadow: "none", border: "1px solid var(--border)" } } : undefined}>
                {previewAsset?.kind === "video" ? <video src={previewAsset.data.url} controls className="max-h-[70dvh] w-full rounded-md" /> : null}
                {previewAsset?.kind === "text" ? <div className="thin-scrollbar max-h-[70dvh] overflow-y-auto whitespace-pre-wrap break-words text-sm leading-6">{previewAsset.data.content}</div> : null}
            </Modal>
        </div>
    );
}
