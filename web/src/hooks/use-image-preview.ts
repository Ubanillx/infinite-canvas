import { useCallback, useSyncExternalStore } from "react";

import { previewUrlFor, subscribeImagePreviews } from "@/services/image-storage";

const unsubscribeEmpty = () => {};

export function useImagePreview(storageKey?: string) {
    const subscribe = useCallback((listener: () => void) => storageKey ? subscribeImagePreviews(listener, storageKey) : unsubscribeEmpty, [storageKey]);
    const getSnapshot = useCallback(() => previewUrlFor(storageKey), [storageKey]);
    return useSyncExternalStore(subscribe, getSnapshot);
}
