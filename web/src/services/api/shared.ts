import i18n from "@/i18n";
import type { AiConfig } from "@/stores/use-config-store";

/** Translate an `apiErrors.*` message key shared by the AI service modules. */
export function apiMessage(key: string, options?: Record<string, unknown>) {
    return i18n.t(`apiErrors.${key}`, options);
}

export function aiHeaders(config: AiConfig, contentType?: string) {
    return {
        ...(config.channelId ? {} : { Authorization: `Bearer ${config.apiKey}` }),
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

export function readApiErrorMessage(value: unknown): string {
    if (!value) return "";
    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value);
            const inner = readApiErrorMessage(parsed) || value;
            if (inner === value && typeof parsed === "object" && Object.keys(parsed).length === 0) return "";
            return inner;
        } catch {
            if (/<[a-z][\s\S]*>/i.test(value)) return apiMessage("htmlError", { preview: `${value.slice(0, 80)}...` });
            return value;
        }
    }
    if (typeof value !== "object") return "";
    const payload = value as { msg?: unknown; message?: unknown; error?: unknown; detail?: unknown };
    const errorMsg =
        typeof payload.error === "string"
            ? payload.error
            : (payload.error as { message?: unknown })?.message;
    return (
        readApiErrorMessage(payload.msg) ||
        readApiErrorMessage(payload.message) ||
        readApiErrorMessage(errorMsg) ||
        readApiErrorMessage(payload.detail) ||
        ""
    );
}

export function readStatusError(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return apiMessage("authenticationFailed");
    if (status === 429) return apiMessage("rateLimited");
    if (status === 404) return apiMessage("notFound");
    if (status === 502) return apiMessage("badGateway");
    if (status === 503) return apiMessage("serviceBusy");
    return status ? apiMessage("httpFailed", { status }) : fallback;
}

export function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
