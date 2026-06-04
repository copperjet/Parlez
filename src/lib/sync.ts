/**
 * Cross-device sync of the learning intelligence (spec §5.4, §11.2 P1).
 *
 * Opt-in: only runs for a signed-in user. Syncs Marie's internal level estimate
 * and the condensed learning-profile summary — the data that makes Parlez more
 * useful over time. Conflict resolution is last-write-wins, keyed to the user's
 * auth id with row-level security (see supabase/migrations).
 */
import { saveLevel, saveProfileSummary } from '@/lib/db/sessions';
import { supabase } from '@/lib/supabase';
import type { Level } from '@/lib/types';
import { useAppStore } from '@/stores/appStore';

interface SyncState {
  level: Level;
  profileSummary: string;
}

async function currentUserId(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

/** Push the local learning profile up to the user's account. */
export async function pushState(): Promise<boolean> {
  const userId = await currentUserId();
  if (!supabase || !userId) return false;
  const s = useAppStore.getState();
  const state: SyncState = { level: s.level, profileSummary: s.profileSummary };
  const { error } = await supabase
    .from('user_state')
    .upsert({ user_id: userId, state, updated_at: new Date().toISOString() });
  return !error;
}

/** Pull the learning profile from the account and apply it locally. */
export async function pullState(): Promise<boolean> {
  const userId = await currentUserId();
  if (!supabase || !userId) return false;
  const { data, error } = await supabase
    .from('user_state')
    .select('state')
    .eq('user_id', userId)
    .maybeSingle();
  if (error || !data?.state) return false;

  const remote = data.state as Partial<SyncState>;
  const store = useAppStore.getState();
  const level = remote.level ?? store.level;
  const profileSummary = remote.profileSummary ?? store.profileSummary;

  store.hydrate({
    hasOnboarded: store.hasOnboarded,
    onboardingChoice: store.onboardingChoice,
    level,
    settings: store.settings,
    profileSummary,
    gapSinceLastSession: store.gapSinceLastSession,
    priorHistory: store.priorHistory,
  });
  void saveLevel(level);
  void saveProfileSummary(profileSummary);
  return true;
}

/**
 * Called right after sign-in: pull the account's profile if it has one,
 * otherwise seed the account with the current local profile.
 */
export async function syncOnSignIn(): Promise<void> {
  const pulled = await pullState();
  if (!pulled) await pushState();
}
