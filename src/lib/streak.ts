/**
 * Practice streak + money-back guarantee maths.
 *
 * A day counts as "complete" once the user has practised {@link DAILY_GOAL_SECONDS}
 * (10 minutes) that day. Per-day practice seconds live in the `daily_activity`
 * table; the streak is the run of consecutive complete days ending today (or
 * yesterday, so a streak survives until the day actually lapses).
 *
 * Pure helpers + `refreshStreakFromHistory()` which recomputes from the table and
 * mirrors the result into the store. Best-effort — never blocks Marie's reply.
 */
import {
  DAILY_GOAL_SECONDS,
  GUARANTEE_CLAIM_GRACE_DAYS,
  GUARANTEE_DAYS,
  GUARANTEE_WINDOW_DAYS,
} from '@/lib/constants';
import { addDailyActivity, loadDailyActivity, saveStreak } from '@/lib/db/sessions';
import { useAppStore } from '@/stores/appStore';
import type { ImageSourcePropType } from 'react-native';

/**
 * Today's date as `YYYY-MM-DD` in the device's local timezone.
 *
 * Note: a device timezone change mid-streak can produce a same-day false reset
 * or increment. Accepted tradeoff — the user picked "calendar day, local".
 */
export function todayLocal(now: Date = new Date()): string {
  return now.toLocaleDateString('en-CA');
}

/** ISO `YYYY-MM-DD` date arithmetic without pulling in a date library. */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Whole days from `a` to `b` (b - a). Negative if b is before a. */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  if (!ay || !by) return 0;
  const da = Date.UTC(ay, am - 1, ad);
  const db = Date.UTC(by, bm - 1, bd);
  return Math.round((db - da) / 86_400_000);
}

/**
 * Streak lengths that warrant a one-time, value-anchored sign-in nudge for
 * anonymous users — "back up your N-day streak". Mirrors the server's
 * STREAK_MILESTONES (supabase/functions/_shared/prompt.ts) so the prompt the
 * user sees lines up with the streak Marie may acknowledge.
 */
export const STREAK_MILESTONES = [3, 7, 14, 30, 60, 100, 200, 365] as const;

/**
 * The milestone a sign-in nudge is currently "due" for, or null. Returns the
 * highest milestone the user has reached that is past what they last dismissed,
 * so the prompt escalates with the streak (3 → 7 → 14 …) without nagging at the
 * same milestone twice. `dismissedAt` is the last milestone the user dismissed
 * (0 = never).
 */
export function dueSignInMilestone(streak: number, dismissedAt: number): number | null {
  let due: number | null = null;
  for (const m of STREAK_MILESTONES) {
    if (streak >= m && m > dismissedAt) due = m;
  }
  return due;
}

/** Set of `YYYY-MM-DD` dates that met the daily goal. */
export function completedDays(
  activity: { date: string; seconds: number }[],
  goal = DAILY_GOAL_SECONDS,
): Set<string> {
  return new Set(activity.filter((a) => a.seconds >= goal).map((a) => a.date));
}

/**
 * Consecutive complete days ending at today, or at yesterday if today isn't done
 * yet (the streak is still "alive" until the gap reaches two days).
 */
export function computeStreak(completed: Set<string>, today = todayLocal()): number {
  let anchor: string | null = null;
  if (completed.has(today)) anchor = today;
  else if (completed.has(addDays(today, -1))) anchor = addDays(today, -1);
  if (!anchor) return 0;

  let n = 0;
  let d = anchor;
  while (completed.has(d)) {
    n += 1;
    d = addDays(d, -1);
  }
  return n;
}

// ── Flame tiers ──────────────────────────────────────────────────────────────

export type FlameTierId = 'orange' | 'ember' | 'violet' | 'supernova';

export interface FlameTier {
  id: FlameTierId;
  label: string;
  /** Smallest streak that reaches this tier. */
  minStreak: number;
  image: ImageSourcePropType;
  /** Representative accent for glow / progress UI. */
  color: string;
}

/** Streak → flame tier. Hotter flames (violet, blue) reward longer streaks. */
export const FLAME_TIERS: FlameTier[] = [
  {
    id: 'orange',
    label: 'Getting warm',
    minStreak: 1,
    image: require('../../assets/images/streak - orange.png'),
    color: '#F0801E',
  },
  {
    id: 'ember',
    label: 'On fire',
    minStreak: 7,
    image: require('../../assets/images/streak - classic ember.png'),
    color: '#F0532A',
  },
  {
    id: 'violet',
    label: 'Unstoppable',
    minStreak: 14,
    image: require('../../assets/images/streak - cosmic violet.png'),
    color: '#9A4FD6',
  },
  {
    id: 'supernova',
    label: 'Supernova',
    minStreak: 30,
    image: require('../../assets/images/streak-supanova blue.png'),
    color: '#2E9BE6',
  },
];

/** The flame tier for a given streak length (the highest one reached). */
export function flameTierFor(streak: number): FlameTier {
  let tier = FLAME_TIERS[0];
  for (const t of FLAME_TIERS) {
    if (streak >= t.minStreak) tier = t;
  }
  return tier;
}

/** The next tier above the current streak, or null once at the top. */
export function nextFlameTier(streak: number): FlameTier | null {
  for (const t of FLAME_TIERS) {
    if (streak < t.minStreak) return t;
  }
  return null;
}

// ── Money-back guarantee ─────────────────────────────────────────────────────

export interface GuaranteeProgress {
  /** Longest run of consecutive complete days inside the guarantee window. */
  bestRun: number;
  /** Days still required to qualify. */
  remaining: number;
  /** GUARANTEE_DAYS — total consecutive days needed. */
  needed: number;
  /** Calendar days left in the guarantee window (0 once it closes). */
  daysLeft: number;
  /** Window still open (within GUARANTEE_WINDOW_DAYS of first launch). */
  windowOpen: boolean;
  /** Met the consecutive-day requirement while the window was/is valid. */
  eligible: boolean;
  /**
   * A qualified user can still claim a refund (within the window + grace). Bounds
   * the refund CTA so it doesn't show forever to a long-retained subscriber.
   */
  claimOpen: boolean;
}

/**
 * Progress toward the 20-consecutive-day money-back guarantee. Only complete
 * days that fall inside the [firstLaunch, firstLaunch + window] range count.
 */
export function guaranteeProgress(
  completed: Set<string>,
  firstLaunchDate: string | null,
  today = todayLocal(),
): GuaranteeProgress {
  const needed = GUARANTEE_DAYS;
  const base: GuaranteeProgress = {
    bestRun: 0,
    remaining: needed,
    needed,
    daysLeft: 0,
    windowOpen: false,
    eligible: false,
    claimOpen: false,
  };
  if (!firstLaunchDate) return base;

  const elapsed = daysBetween(firstLaunchDate, today);
  const daysLeft = Math.max(0, GUARANTEE_WINDOW_DAYS - elapsed);
  const windowOpen = elapsed >= 0 && elapsed < GUARANTEE_WINDOW_DAYS;
  // Refund stays claimable through the window plus a grace period, then closes.
  const claimOpen =
    elapsed >= 0 && elapsed < GUARANTEE_WINDOW_DAYS + GUARANTEE_CLAIM_GRACE_DAYS;

  // Longest consecutive run of complete days across the whole window range.
  let bestRun = 0;
  let run = 0;
  for (let i = 0; i < GUARANTEE_WINDOW_DAYS; i += 1) {
    const d = addDays(firstLaunchDate, i);
    if (completed.has(d)) {
      run += 1;
      if (run > bestRun) bestRun = run;
    } else {
      run = 0;
    }
  }

  return {
    bestRun,
    remaining: Math.max(0, needed - bestRun),
    needed,
    daysLeft,
    windowOpen,
    eligible: bestRun >= needed,
    claimOpen,
  };
}

/**
 * Reconcile the ledger-computed streak with a stored (possibly synced) scalar.
 *
 * The local daily_activity ledger is the source of truth — EXCEPT it can be
 * shorter than the real streak after a reinstall, where only the synced scalar
 * streakCount survives and the ledger starts empty then rebuilds one day at a
 * time. A "still alive" stored streak (its last completed day is today or
 * yesterday) may represent history the ledger can't see, so the short ledger must
 * never SHRINK it: reconcile to the larger. A genuinely lapsed stored streak
 * (last day older than yesterday) is NOT alive, and the ledger resets it.
 *
 * Pure so both the launch/turn refresh and the streak screen agree exactly.
 */
export function reconcileStreak(
  completed: Set<string>,
  today: string,
  stored: number,
  storedLast: string | null,
): { streak: number; lastDate: string | null } {
  const ledgerStreak = computeStreak(completed, today);
  const storedAlive =
    stored > 0 && (storedLast === today || storedLast === addDays(today, -1));

  let streak = ledgerStreak;
  let lastDate: string | null = completed.has(today)
    ? today
    : completed.has(addDays(today, -1))
      ? addDays(today, -1)
      : storedLast;

  if (storedAlive) {
    // Today's practice that continues a streak which ended yesterday grows the
    // run from the stored count (the ledger only counts the days it holds).
    const continued =
      completed.has(today) && storedLast === addDays(today, -1) ? stored + 1 : stored;
    if (continued > streak) {
      streak = continued;
      lastDate = completed.has(today) ? today : storedLast;
    }
  }
  return { streak, lastDate };
}

/**
 * Light today's streak day when the free taste is spent.
 *
 * The first flame is, by design, the user's first streak day — the celebratory
 * paywall literally says so. A safety net: the wall-clock heartbeat usually has
 * today already past the 10-min goal by exhaustion time (the free taste is ~600s
 * of *estimated speech*, which is well over 10 real minutes), but on edge cases —
 * a churned user with little foreground time, or a burst of fast typed turns — the
 * server can 403 before today's wall-clock total reaches DAILY_GOAL_SECONDS, which
 * would read 0 next to a "Day 1" celebration.
 *
 * Top today up to the goal, then recompute. Idempotent (a no-op once today is
 * already complete) and best-effort.
 */
export async function creditFreeTasteStreakDay(): Promise<void> {
  try {
    const today = todayLocal();
    const activity = await loadDailyActivity();
    const todaySeconds = activity.find((a) => a.date === today)?.seconds ?? 0;
    if (todaySeconds < DAILY_GOAL_SECONDS) {
      await addDailyActivity(today, DAILY_GOAL_SECONDS - todaySeconds);
    }
    await refreshStreakFromHistory();
  } catch {
    // Best-effort — streak is UX polish, never blocks the paywall flow.
  }
}

/**
 * Recompute the streak from the daily-activity table and mirror it into the
 * store + kv. Called as the wall-clock heartbeat banks practice time. Best-effort
 * and a no-op when there's no persisted activity (e.g. web), so it never clobbers
 * an in-memory streak with a phantom zero.
 */
export async function refreshStreakFromHistory(): Promise<void> {
  try {
    const activity = await loadDailyActivity();
    if (activity.length === 0) return;
    const completed = completedDays(activity);
    const today = todayLocal();

    const s = useAppStore.getState();
    const { streak, lastDate } = reconcileStreak(
      completed,
      today,
      s.streakCount,
      s.lastSessionDate,
    );

    if (s.streakCount === streak && (s.lastSessionDate ?? null) === (lastDate ?? null)) {
      return;
    }
    s.setStreak(streak, lastDate ?? null);
    await saveStreak(streak, lastDate ?? null);
  } catch {
    // Best-effort — streak is UX polish, never blocks Marie.
  }
}
