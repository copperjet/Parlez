/**
 * Reactive auth state for the optional account sync (spec §8.2).
 *
 * Supabase persists the session in AsyncStorage, but nothing in the UI was
 * subscribed to it — so screens like Settings showed a stale "Sign in to sync"
 * forever. This store seeds from the current session and then tracks
 * `onAuthStateChange` so every screen reacts to sign-in / sign-out live.
 *
 * Null-safe: when `supabase` is not configured the store stays signed-out and
 * `init()` is a no-op.
 */
import { create } from 'zustand';

import { supabase } from '@/lib/supabase';

interface AuthStore {
  isSignedIn: boolean;
  email: string | null;
  userId: string | null;
  /** Wire the Supabase auth listener once and seed from the current session. */
  init: () => void;
}

let listenerRegistered = false;

export const useAuthStore = create<AuthStore>((set) => ({
  isSignedIn: false,
  email: null,
  userId: null,

  init: () => {
    if (!supabase || listenerRegistered) return;
    listenerRegistered = true;

    // Seed from the persisted session so a returning user is "signed in" on launch.
    void supabase.auth.getSession().then(({ data }) => {
      const user = data.session?.user ?? null;
      set({
        isSignedIn: user != null,
        email: user?.email ?? null,
        userId: user?.id ?? null,
      });
    });

    supabase.auth.onAuthStateChange((_event, session) => {
      const user = session?.user ?? null;
      set({
        isSignedIn: user != null,
        email: user?.email ?? null,
        userId: user?.id ?? null,
      });
    });
  },
}));
