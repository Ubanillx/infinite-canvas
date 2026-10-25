import { createHash } from "node:crypto";
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client, type ListObjectsV2CommandInput } from "@aws-sdk/client-s3";

let client: S3Client | undefined;

function s3() {
    if (!client) {
        client = new S3Client({
            endpoint: process.env.S3_ENDPOINT || "http://127.0.0.1:9010",
            region: process.env.S3_REGION || "us-east-1",
            // MinIO 默认使用 path-style 寻址。
            forcePathStyle: true,
            // RustFS needs a fixed-length body, not the SDK's optional aws-chunked checksum trailer.
            requestChecksumCalculation: "WHEN_REQUIRED",
            credentials: {
                accessKeyId: process.env.S3_ACCESS_KEY || "infinite",
                secretAccessKey: process.env.S3_SECRET_KEY || "infinite_canvas_dev",
            },
        });
    }
    return client;
}

function bucket() {
    return process.env.S3_BUCKET || "infinite-canvas";
}

/** 对象键沿用原有按 workspace + storageKey 哈希的布局，避免把 image: 这类前缀写进 S3 语义。 */
export function mediaObjectKey(workspaceId: string, storageKey: string) {
    return `media/${workspaceId}/${createHash("sha256").update(storageKey).digest("hex")}`;
}

export async function putMediaStream(key: string, body: NodeJS.ReadableStream, contentType: string, contentLength?: number) {
    await s3().send(new PutObjectCommand({
        Bucket: bucket(),
        Key: key,
        Body: body as never,
        ContentType: contentType,
        ContentLength: contentLength,
    }));
}

export async function putMediaBuffer(key: string, body: Buffer, contentType: string) {
    await s3().send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType, ContentLength: body.length }));
}

export async function getMediaObject(key: string) {
    const result = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
    return { body: result.Body as NodeJS.ReadableStream, contentLength: result.ContentLength, contentType: result.ContentType };
}

export async function headMediaObject(key: string) {
    const result = await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return { contentLength: result.ContentLength, contentType: result.ContentType, eTag: result.ETag };
}

export type ListedMediaObject = { objectKey: string; bytes: number; eTag: string; lastModified: string | null };

export async function listWorkspaceMediaObjects(workspaceId: string, readPage = (input: ListObjectsV2CommandInput) => s3().send(new ListObjectsV2Command(input))): Promise<ListedMediaObject[]> {
    const prefix = `media/${workspaceId}/`;
    const objects: ListedMediaObject[] = [];
    const tokens = new Set<string>();
    let token: string | undefined;
    do {
        const page = await readPage({ Bucket: bucket(), Prefix: prefix, ContinuationToken: token });
        for (const object of page.Contents ?? []) {
            if (!object.Key?.startsWith(prefix) || object.Size === undefined) throw new Error("对象对账返回了未知工作区或不完整对象");
            objects.push({ objectKey: object.Key, bytes: object.Size, eTag: object.ETag ?? "", lastModified: object.LastModified?.toISOString() ?? null });
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
        if (page.IsTruncated && (!token || tokens.has(token))) throw new Error("对象对账分页不完整，扫描已阻断");
        if (token) tokens.add(token);
    } while (token);
    return objects.sort((a, b) => a.objectKey.localeCompare(b.objectKey));
}

export async function deleteMediaObject(key: string) {
    await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

export async function copyMediaObject(sourceKey: string, targetKey: string) {
    const copySource = [bucket(), ...sourceKey.split("/")].map(encodeURIComponent).join("/");
    await s3().send(new CopyObjectCommand({ Bucket: bucket(), Key: targetKey, CopySource: copySource }));
}

export function isMissingObject(error: unknown) {
    const name = (error as { name?: string })?.name;
    const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    return name === "NoSuchKey" || name === "NotFound" || status === 404;
}

export function isStorageConfigured() {
    return Boolean(bucket());
}
