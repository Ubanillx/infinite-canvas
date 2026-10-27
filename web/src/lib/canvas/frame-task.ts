// Keep the latest input in a frame; flush before ending a gesture so its last position is never lost.
export function createFrameTask<T>(run: (value: T) => void) {
    let frame: number | null = null;
    let pending: [T] | null = null;
    const cancel = () => {
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
        pending = null;
    };
    const flush = () => {
        const value = pending;
        cancel();
        if (value) run(value[0]);
    };
    return {
        schedule(value: T) {
            pending = [value];
            if (frame === null) frame = requestAnimationFrame(flush);
        },
        flush,
        cancel,
    };
}
