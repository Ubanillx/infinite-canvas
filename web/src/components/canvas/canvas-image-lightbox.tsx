import { useEffect, useState } from "react";
import { Button, Modal, Tooltip } from "antd";
import { RotateCcw, RotateCw, X, ZoomIn, ZoomOut } from "lucide-react";
import { useTranslation } from "react-i18next";

type CanvasImageLightboxProps = {
    open: boolean;
    src: string;
    alt: string;
    onClose: () => void;
};

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;

export function CanvasImageLightbox({ open, src, alt, onClose }: CanvasImageLightboxProps) {
    const { t } = useTranslation();
    const [zoom, setZoom] = useState(1);
    const [rotation, setRotation] = useState(0);

    useEffect(() => {
        if (open) {
            setZoom(1);
            setRotation(0);
        }
    }, [open, src]);

    useEffect(() => {
        if (!open) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "+" || event.key === "=") {
                event.preventDefault();
                setZoom((value) => clampZoom(value + 0.25));
            } else if (event.key === "-" || event.key === "_") {
                event.preventDefault();
                setZoom((value) => clampZoom(value - 0.25));
            } else if (event.key.toLowerCase() === "r") {
                event.preventDefault();
                setRotation((value) => value + 90);
            } else if (event.key === "0") {
                event.preventDefault();
                setZoom(1);
                setRotation(0);
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [open]);

    return (
        <Modal
            title={null}
            open={open}
            centered
            footer={null}
            width="100vw"
            style={{ maxWidth: "none", margin: 0, padding: 0 }}
            destroyOnHidden
            closable={false}
            onCancel={onClose}
            classNames={{ root: "canvas-image-lightbox", body: "[&_button]:!shadow-none" }}
            styles={{
                mask: { background: "rgba(0, 0, 0, 0.12)" },
                wrapper: { padding: 0, overflow: "hidden" },
                header: { display: "none" },
                container: { width: "100%", maxWidth: "100%", height: "100dvh", maxHeight: "100dvh", margin: 0, border: 0, borderRadius: 0, background: "transparent", boxShadow: "none", padding: 0, overflow: "hidden" },
                body: { height: "100dvh", maxHeight: "100dvh", padding: 0, overflow: "hidden" },
            }}
        >
            <div className="relative flex h-dvh min-h-0 flex-col overflow-hidden bg-black/15">
                <button
                    type="button"
                    className="absolute right-5 top-5 z-20 grid size-11 place-items-center rounded-full border border-white/90 bg-white/95 !text-black shadow-[0_4px_18px_rgba(0,0,0,0.32)] ring-2 ring-black/30 backdrop-blur-md transition hover:bg-white focus-visible:outline-2 focus-visible:outline-white"
                    onClick={onClose}
                    aria-label={t("agent.message.close")}
                >
                    <X className="size-5" />
                </button>
                <div
                    className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-6"
                    onWheel={(event) => {
                        event.preventDefault();
                        setZoom((value) => clampZoom(value + (event.deltaY < 0 ? 0.1 : -0.1)));
                    }}
                >
                    <img
                        src={src}
                        alt={alt}
                        draggable={false}
                        className="max-h-[calc(100dvh-48px)] max-w-[calc(100vw-48px)] select-none object-contain"
                        style={{ transform: `rotate(${rotation}deg) scale(${zoom})`, transition: "transform 160ms ease-out" }}
                    />
                    <div className="absolute bottom-5 left-1/2 z-10 flex max-w-[calc(100vw-32px)] -translate-x-1/2 flex-wrap items-center justify-center gap-1 rounded-full border border-white/35 bg-black/65 px-2.5 py-1.5 text-white shadow-[0_8px_28px_rgba(0,0,0,0.28)] backdrop-blur-xl">
                        <Tooltip title={t("canvas.projectPage.imageLightbox.zoomOut")}>
                            <Button type="text" className="!text-white hover:!bg-white/20 hover:!text-white" icon={<ZoomOut className="size-4" />} disabled={zoom <= MIN_ZOOM} onClick={() => setZoom((value) => clampZoom(value - 0.25))} aria-label={t("canvas.projectPage.imageLightbox.zoomOut")} />
                        </Tooltip>
                        <span className="min-w-12 text-center text-xs">{Math.round(zoom * 100)}%</span>
                        <Tooltip title={t("canvas.projectPage.imageLightbox.zoomIn")}>
                            <Button type="text" className="!text-white hover:!bg-white/20 hover:!text-white" icon={<ZoomIn className="size-4" />} disabled={zoom >= MAX_ZOOM} onClick={() => setZoom((value) => clampZoom(value + 0.25))} aria-label={t("canvas.projectPage.imageLightbox.zoomIn")} />
                        </Tooltip>
                        <span className="mx-1 h-4 w-px bg-white/20" aria-hidden="true" />
                        <Tooltip title={t("canvas.projectPage.imageLightbox.rotateLeft")}>
                            <Button type="text" className="!text-white hover:!bg-white/20 hover:!text-white" icon={<RotateCcw className="size-4" />} onClick={() => setRotation((value) => value - 90)} aria-label={t("canvas.projectPage.imageLightbox.rotateLeft")} />
                        </Tooltip>
                        <Tooltip title={t("canvas.projectPage.imageLightbox.rotateRight")}>
                            <Button type="text" className="!text-white hover:!bg-white/20 hover:!text-white" icon={<RotateCw className="size-4" />} onClick={() => setRotation((value) => value + 90)} aria-label={t("canvas.projectPage.imageLightbox.rotateRight")} />
                        </Tooltip>
                        <Tooltip title={t("canvas.projectPage.imageLightbox.reset")}>
                            <Button type="text" className="!text-white hover:!bg-white/20 hover:!text-white" onClick={() => { setZoom(1); setRotation(0); }} aria-label={t("canvas.projectPage.imageLightbox.reset")}>{t("canvas.projectPage.imageLightbox.reset")}</Button>
                        </Tooltip>
                        <span className="ml-1 hidden text-xs text-white/80 sm:inline">{t("canvas.projectPage.imageLightbox.hint")}</span>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

function clampZoom(value: number) {
    return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number(value.toFixed(2))));
}
