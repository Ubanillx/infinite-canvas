import { create } from "zustand";

export type SessionUser = { id: string; username: string; displayName: string; isAdmin: boolean; createdAt: string };

type SessionStore = {
    user: SessionUser | null;
    setUser: (user: SessionUser | null) => void;
};

export const useSessionStore = create<SessionStore>()((set) => ({
    user: null,
    setUser: (user) => set({ user }),
}));

export function useIsAdmin() {
    return useSessionStore((state) => Boolean(state.user?.isAdmin));
}
