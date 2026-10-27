export function remoteMediaUrl(url: string) {
    if (!/^https?:\/\//i.test(url)) return url;
    const target = new URL(url);
    if (typeof window !== "undefined" && target.origin === window.location.origin) return `${target.pathname}${target.search}`;
    return `/api/remote-media?url=${encodeURIComponent(url)}`;
}
