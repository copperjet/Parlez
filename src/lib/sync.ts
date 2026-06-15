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
import { clearProfile } from '@/lib/db/profile';
import {
  clearActivity,
  clearDailyActivity,
  clearMessages,
  clearStreak,
  clearStructuredProfile,
  loadActiveAccountUid,
  saveActiveAccountUid,
  saveLevel,
  saveProfileSummary,
  saveStreak,
  saveStructuredProfile,
} from '@/lib/db/sessions';
import { aliasToSupabase } from '@/lib/revenuecat';
import { supabase } from '@/lib/supabase';
import type { Level } from '@/lib/types';
import { useAppStore } from '@/stores/appStore';
import { useSubscriptionStore } from '@/stores/subscriptionStore';

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

/**
 * Pull the learning profile from the account and apply it locally.
 *
 * Three-state on purpose: a transient transport failure (offline, slow getUser,
 * query error) MUST be distinguishable from a genuinely empty account. The caller
 * seeds a new account from local on `'absent'` only — never on `'error'`, which
 * would otherwise overwrite a real cloud profile with the just-wiped local state.
 */
export async function pullState(): Promise<'applied' | 'absent' | 'error'> {
  const userId = await currentUserId();
  // No id resolved (sync off, or getUser() failed on a flaky network) — can't tell
  // empty from unreachable, so treat as error and don't let the caller push.
  if (!supabase || !userId) return 'error';
  const { data, error } = await supabase
    .from('user_state')
    .select('state')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) return 'error';
  if (!data?.state) return 'absent';

  const remote = data.state as Partial<SyncState>;
  const store = useAppStore.getState();
  const level = remote.level ?? store.level;
  const profileSummary = remote.profileSummary ?? store.profileSummary;
  const learnerName =
    remote.learnerName !== undefined ? remote.learnerName : store.learnerName;
  const interests = Array.isArray(remote.interests)
    ? remote.interests
    : store.interests;

  // Streak reconciliation — never lose a streak unjustifiably, never resurrect a
  // dead one. Last-write-wins would let an old account clobber a higher local
  // streak (or vice-versa). Instead the record whose practice is more RECENT
  // (later lastSessionDate) wins, since that reflects the true current run; a tie
  // keeps the larger count. The streak engine (refreshStreakFromHistory) then
  // validates/lapses the winner against the local ledger on the next launch/turn.
  const remoteCount =
    typeof remote.streakCount === 'number' && remote.streakCount >= 0
      ? Math.floor(remote.streakCount)
      : 0;
  const remoteDate =
    typeof remote.lastSessionDate === 'string' && remote.lastSessionDate
      ? remote.lastSessionDate
      : null;
  const localCount = store.streakCount;
  const localDate = store.lastSessionDate;

  let streakCount: number;
  let lastSessionDate: string | null;
  if (remoteDate && localDate) {
    if (remoteDate > localDate) {
      streakCount = remoteCount;
      lastSessionDate = remoteDate;
    } else if (localDate > remoteDate) {
      streakCount = localCount;
      lastSessionDate = localDate;
    } else {
      streakCount = Math.max(remoteCount, localCount);
      lastSessionDate = localDate;
    }
  } else if (remoteDate) {
    streakCount = remoteCount;
    lastSessionDate = remoteDate;
  } else if (localDate) {
    streakCount = localCount;
    lastSessionDate = localDate;
  } else {
    streakCount = Math.max(remoteCount, localCount);
    lastSessionDate = null;
  }

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
    firstLaunchDate: store.firstLaunchDate,
    isFirstTimeUser: store.isFirstTimeUser,
    turnsSinceConsolidation: store.turnsSinceConsolidation,
  });
  void saveLevel(level);
  void saveProfileSummary(profileSummary);
  void saveStructuredProfile({ learnerName, interests });
  void saveStreak(streakCount, lastSessionDate);
  return 'applied';
}

/**
 * Wipe all ACCOUNT-scoped local data — the conversation transcript, the learning
 * profile, the structured slots, the streak + activity ledger, and the level. The
 * in-memory store and the local DB are both reset. Device-scoped prefs (onboarding,
 * settings, firstLaunchDate, sign-in-nudge dismissal, activeAccountUid) are kept.
 *
 * Used when a different account takes over the device (sign-in guard below) and by
 * the delete-account flow.
 */
export async function wipeLocalAccountData(): Promise<void> {
  useAppStore.getState().resetAll(); // in-memory: messages, profile, streak, level
  // The free-taste meter is per-identity too: a different account taking over must
  // start from its own server truth, not inherit the previous user's spent meter.
  useSubscriptionStore.getState().resetFreeUsage();
  await Promise.allSettled([
    clearMessages(),
    clearProfile(),
    clearStructuredProfile(),
    clearStreak(),
    clearDailyActivity(),
    clearActivity(),
    saveProfileSummary(''),
  ]);
}

/**
 * Called right after sign-in. If a DIFFERENT account previously owned the local
 * data, wipe it first so no transcript/profile leaks across accounts on a shared
 * device. Then pull the account's profile if it has one, otherwise seed the account
 * with the current local profile. Finally record the new owner.
 *
 * A null prior owner (anonymous device) or the same uid re-signing in keeps local
 * data — only a genuine account switch trips the wipe.
 */
export async function syncOnSignIn(userId: string): Promise<void> {
  const prior = await loadActiveAccountUid();
  // Anonymous device (prior == null) or the same uid re-signing in: NEVER wipe —
  // the in-progress anonymous conversation + progress is adopted onto this account.
  // Only a genuine switch (a different prior owner) wipes, so account B never
  // inherits account A's transcript, profile, streak, or free-taste meter.
  if (prior && prior !== userId) {
    await wipeLocalAccountData();
  }
  // Seed a brand-new account from the adopted local state, but ONLY when the pull
  // confirmed the account is genuinely empty — never on a transport error, which
  // would clobber B's real cloud profile with the (possibly just-wiped) local one.
  const pulled = await pullState();
  if (pulled === 'absent') await pushState();
  await saveActiveAccountUid(userId);
}

/**
 * On launch, stamp the already-signed-in session as the local data's owner when no
 * owner is recorded yet — migration for installs predating this guard, and for any
 * session restored from storage without a fresh sign-in (which never runs
 * `syncOnSignIn`). NEVER wipes; only records ownership so a LATER account switch is
 * detected. No-op when signed out or when an owner is already recorded.
 */
export async function backfillAccountOwner(): Promise<void> {
  if (!supabase) return;
  // Local persisted session (no network) — instant and offline-safe, so ownership
  // is stamped before the user can navigate to Account and switch.
  const { data } = await supabase.auth.getSession();
  const userId = data.session?.user?.id ?? null;
  if (!userId) return;
  const prior = await loadActiveAccountUid();
  if (!prior) await saveActiveAccountUid(userId);
}

/**
 * Wire this from any future sign-in success handler. Aliases the anonymous
 * RevenueCat user onto the Supabase identity so prior purchases transfer, then
 * runs the standard sign-in sync. No sign-in UI exists today — call site is
 * a stub for the iOS/Apple Sign-In path in Phase 3.
 */
export async function onSignIn(supabaseUserId: string): Promise<void> {
  await aliasToSupabase(supabaseUserId);
  await syncOnSignIn(supabaseUserId);
}
