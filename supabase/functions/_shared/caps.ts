/**
 * Tiered daily conversation caps.
 *   monthly  → 30 min  (1800 s)
 *   annual   → 90 min  (5400 s)
 *   lifetime → unlimited (null)
 *
 * Free users never reach the `turn` fn — the client paywall gate blocks them
 * earlier. When `subscriptions` has no row for a caller (webhook lag, fresh
 * purchase), default to `annual` so paying users are never falsely denied.
 */
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export type Tier = 'monthly' | 'annual' | 'lifetime';

export function tierCapSeconds(tier: Tier): number | null {
  switch (tier) {
    case 'monthly':  return 1800;
    case 'annual':   return 5400;
    case 'lifetime': return null;
  }
}

/** Resolve tier from the subscriptions mirror; falls back to 'annual'. */
export async function loadTier(
  svc: SupabaseClient,
  userId: string,
  isAnon: boolean,
): Promise<Tier> {
  const col = isAnon ? 'app_user_id' : 'supabase_user_id';
  const { data } = await svc
    .from('subscriptions')
    .select('tier')
    .eq(col, userId)
    .maybeSingle();
  const t = (data as { tier?: Tier } | null)?.tier;
  if (t === 'monthly' || t === 'annual' || t === 'lifetime') return t;
  return 'annual';
}

/** Today's accumulated elapsed_ms across all usage_events for the user (UTC day). */
export async function loadTodayElapsedMs(
  svc: SupabaseClient,
  userId: string,
): Promise<number> {
  const { data } = await svc
    .from('usage_daily')
    .select('elapsed_ms, day')
    .eq('user_id', userId)
    .eq('day', new Date().toISOString().slice(0, 10))
    .maybeSingle();
  const ms = (data as { elapsed_ms?: number } | null)?.elapsed_ms ?? 0;
  return ms;
}
