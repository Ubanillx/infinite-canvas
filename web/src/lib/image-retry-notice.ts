import type { GenerationTask } from "@/types/generation-task";

type Listener = () => void;

const listeners = new Set<Listener>();

export function notifyImageRetry() {
    listeners.forEach((listener) => listener());
}

export function subscribeImageRetry(listener: Listener) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** Callers seed already-known tasks first; every later increment happened during this session. */
export function notifyImageTaskRetry(seen: Map<string, number>, task: GenerationTask) {
    if (task.kind !== "image") return;
    const count = task.retryCount || 0;
    const previous = seen.get(task.id) || 0;
    if (count <= previous) return;
    seen.set(task.id, count);
    notifyImageRetry();
}
