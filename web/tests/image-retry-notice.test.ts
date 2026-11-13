import { expect, test } from "bun:test";

import { notifyImageTaskRetry, subscribeImageRetry } from "../src/lib/image-retry-notice";
import type { GenerationTask } from "../src/types/generation-task";

function task(overrides: Partial<GenerationTask> = {}) {
    return { id: "task", kind: "image", status: "submitting", retryCount: 1, ...overrides } as GenerationTask;
}

test("image retries notify once per observed increment", () => {
    let notices = 0;
    const unsubscribe = subscribeImageRetry(() => { notices += 1; });
    try {
        const seen = new Map<string, number>();
        notifyImageTaskRetry(seen, task());
        notifyImageTaskRetry(seen, task());
        expect(notices).toBe(1);
        notifyImageTaskRetry(seen, task({ retryCount: 2 }));
        expect(notices).toBe(2);
        notifyImageTaskRetry(seen, task({ retryCount: 3, status: "succeeded" }));
        expect(notices).toBe(3);
    } finally {
        unsubscribe();
    }
});

test("non-image tasks never trigger the image retry notice", () => {
    let notices = 0;
    const unsubscribe = subscribeImageRetry(() => { notices += 1; });
    try {
        notifyImageTaskRetry(new Map(), task({ kind: "video", retryCount: 2 }));
        expect(notices).toBe(0);
    } finally {
        unsubscribe();
    }
});
