/**
 * Cross-device sync of the learning intelligence (spec §5.4, §11.2 P1).
 *
 * Opt-in: only runs for a signed-in user. Syncs Marie's internal level
 * estimate, the condensed learning-profile summary, the typed structured
 * profile slots (name + interests), and the practice streak — the data that
 * makes Parlez more useful over time and motivates returning users. Raw
 * profile_notes and per-message transcripts stay local (privacy posture).
 *
 * Conflict resolution is last-write-wins, keyed to the user's auth id with
 * row-level security (see supabase/migrations).
 */
import {
  saveLevel,
  saveProfileSummary,
  saveStreak,
  saveStructuredProfile,
} from '@/lib/db/sessions';
import { aliasToSupabase } from '@/lib/revenuecat';
import { supabase } from '@/lib/supabase';
import type { Level } from '@/lib/types';
import { useAppStore } from '@/stores/appStore';

interface SyncState {
  level: Level;
  profileSummary: string;
  /** Typed profile slots — extension for cross-device continuity. */
  learnerName: string | null;
  interests: string[];
  /** Engagement state — survives reinstall so the streak isn't "punished". */
  streakCount: number;
  lastSessionDate: string | null;
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
  const state: SyncState = {
    level: s.level,
    profileSummary: s.profileSummary,
    learnerName: s.learnerName,
    interests: s.interests,
    streakCount: s.streakCount,
    lastSessionDate: s.lastSessionDate,
  };
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
  const learnerName =
    remote.learnerName !== undefined ? remote.learnerName : store.learnerName;
  const interests = Array.isArray(remote.interests)
    ? remote.interests
    : store.interests;
  const streakCount =
    typeof remote.streakCount === 'number' && remote.streakCount >= 0
      ? Math.floor(remote.streakCount)
      : store.streakCount;
  const lastSessionDate =
    remote.lastSessionDate !== undefined
      ? remote.lastSessionDate
      : store.lastSessionDate;

  store.hydrate({
    hasOnboarded: store.hasOnboarded,
    onboardingChoice: store.onboardingChoice,
    level,
    settings: store.settings,
    profileSummary,
    gapSinceLastSession: store.gapSinceLastSession,
    priorHistory: store.priorHistory,
    learnerName,
    interests,
    streakCount,
    lastSessionDate,
    turnsSinceConsolidation: store.turnsSinceConsolidation,
  });
  void saveLevel(level);
  void saveProfileSummary(profileSummary);
  void saveStructuredProfile({ learnerName, interests });
  void saveStreak(streakCount, lastSessionDate);
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

/**
 * Wire this from any future sign-in success handler. Aliases the anonymous
 * RevenueCat user onto the Supabase identity so prior purchases transfer, then
 * runs the standard sign-in sync. No sign-in UI exists today — call site is
 * a stub for the iOS/Apple Sign-In path in Phase 3.
 */
export async function onSignIn(supabaseUserId: string): Promise<void> {
  await aliasToSupabase(supabaseUserId);
  await syncOnSignIn();
}
