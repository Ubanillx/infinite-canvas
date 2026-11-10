// Reuse the existing media, image-count and AI request boundaries; no independent response-size setting.
export const GENERATION_MEDIA_LIMIT_BYTES = 100 * 1024 * 1024;
export const GENERATION_IMAGE_LIMIT = 10;
export const GENERATION_REQUEST_LIMIT_BYTES = 64 * 1024 * 1024;
export const GENERATION_JSON_LIMIT_BYTES = Math.ceil(GENERATION_MEDIA_LIMIT_BYTES / 3) * 4 * GENERATION_IMAGE_LIMIT + GENERATION_REQUEST_LIMIT_BYTES;

/** Stop at the read boundary, including chunked/decompressed responses with no reliable Content-Length. */
export async function readGenerationBytes(source: AsyncIterable<Uint8Array>, limit: number, contentLength?: string | number) {
    const iterator = source[Symbol.asyncIterator]();
    let complete = false;
    try {
        const declared = Number(contentLength);
        if (Number.isFinite(declared) && declared > limit) throw new Error("生成响应大小超过现有媒体边界");
        const chunks: Buffer[] = [];
        let bytes = 0;
        while (true) {
            const item = await iterator.next();
            if (item.done) { complete = true; return Buffer.concat(chunks, bytes); }
            bytes += item.value.byteLength;
            if (bytes > limit) throw new Error("生成响应大小超过现有媒体边界");
            chunks.push(Buffer.from(item.value));
        }
    } finally {
        if (!complete) await iterator.return?.().catch(() => undefined);
    }
}
