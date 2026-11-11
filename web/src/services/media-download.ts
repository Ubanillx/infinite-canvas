import { saveAs } from "file-saver";
import i18n from "@/i18n";
import { readRemoteMediaBlob } from "@/services/api/remote-media";
import { loadMediaBlob } from "@/services/workspace-media";

export type MediaDownloadSource = {
    url: string | Blob;
    storageKey?: string;
    kind: "image" | "video" | "audio";
};

export async function downloadMedia(source: MediaDownloadSource, fileName: string) {
    let blob = source.storageKey ? await loadMediaBlob(source.storageKey) : null;
    if (!blob) blob = source.url instanceof Blob ? source.url : source.url ? await readRemoteMediaBlob(source.url) : null;
    if (!blob?.size) throw new Error(i18n.t("assets.downloadFailed"));
    if (source.kind === "image") {
        const { fileTypeFromBlob } = await import("file-type");
        const type = await fileTypeFromBlob(blob);
        const mimeType = type?.mime || blob.type.split(";")[0];
        if (!mimeType.startsWith("image/")) throw new Error(i18n.t("common.imageReadFailed"));
        if (!type) {
            const url = URL.createObjectURL(blob);
            try {
                const image = new Image();
                image.src = url;
                await image.decode();
            } finally {
                URL.revokeObjectURL(url);
            }
        }
        const ext = type?.ext || mimeType.split("/")[1].split("+")[0];
        blob = blob.slice(0, blob.size, mimeType);
        fileName = `${fileName.replace(/\.[^./\\]+$/, "")}.${ext}`;
    }
    // Always pass bytes: file-saver opens cross-origin URL strings in a new tab when CORS is unavailable.
    saveAs(blob, fileName);
}
