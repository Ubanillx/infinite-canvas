import { create } from "zustand";

type AppLoadingState = {
    loading: boolean;
    start: () => void;
    finish: () => void;
};

export const useAppLoadingStore = create<AppLoadingState>((set) => ({
    loading: true,
    start: () => set({ loading: true }),
    finish: () => set({ loading: false }),
}));
