/**
 * Calendar-day practice streak — a tiny engagement counter that surfaces only
 * on the settings screen (CLAUDE.md "no gamification" rule is intentionally
 * relaxed for this single, off-screen indicator).
 *
 * Pure helpers + one stateful `tickStreak()` that reads the kv store, computes
 * the next value, and persists it. The conversation screen calls `tickStreak`
 * once per session mount — never blocking Marie's reply.
 */
import { saveStreak } from '@/lib/db/sessions';
import { useAppStore } from '@/stores/appStore';

export interface StreakState {
  count: number;
  date: string;
}

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
function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Pure streak step.
 *   no prev          → {1, today}
 *   prev = today     → unchanged
 *   prev = yesterday → {prev.count + 1, today}
 *   else             → {1, today}   (miss = reset)
 */
export function computeNextStreak(
  prev: StreakState | null,
  today: string,
): StreakState {
  if (!prev || prev.count <= 0) return { count: 1, date: today };
  if (prev.date === today) return prev;
  if (prev.date === addDays(today, -1)) {
    return { count: prev.count + 1, date: today };
  }
  return { count: 1, date: today };
}

/**
 * Read current streak from the store, compute the next value, persist it, and
 * update the store. Best-effort — must never throw into the turn engine.
 */
export async function tickStreak(): Promise<void> {
  try {
    const today = todayLocal();
    const s = useAppStore.getState();
    const prev: StreakState | null = s.lastSessionDate
      ? { count: s.streakCount, date: s.lastSessionDate }
      : null;
    const next = computeNextStreak(prev, today);
    if (prev && prev.count === next.count && prev.date === next.date) return;
    s.setStreak(next.count, next.date);
    await saveStreak(next.count, next.date);
  } catch {
    // Best-effort — streak is UX polish, never blocks Marie.
  }
}
