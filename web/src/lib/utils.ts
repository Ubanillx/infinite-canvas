import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { nanoid } from "nanoid";

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

/**
 * Generate a unique id.
 *
 * Avoid `crypto.randomUUID`, which is only exposed in secure contexts (HTTPS or
 * localhost) — over plain HTTP it is undefined and throws. `nanoid` works in any
 * context.
 */
export function randomId(): string {
    return nanoid();
}

export function safeFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "_");
}

export function moveListItem<T>(items: T[], index: number, offset: number) {
    const targetIndex = index + offset;
    if (targetIndex < 0 || targetIndex >= items.length) return items;
    const next = [...items];
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    return next;
}
