import i18n from "@/i18n";

export function remoteMediaUrl(url: string) {
    if (!/^https?:\/\//i.test(url)) return url;
    const target = new URL(url);
    if (typeof window !== "undefined" && target.origin === window.location.origin) return `${target.pathname}${target.search}`;
    return `/api/remote-media?url=${encodeURIComponent(url)}`;
}

export async function readRemoteMediaBlob(url: string) {
    const response = await fetch(remoteMediaUrl(url));
    if (!response.ok) throw new Error(i18n.t("common.imageDownloadFailed", { status: response.status }));
    return response.blob();
}
