/**
 * Tiered daily conversation caps + server-side entitlement gate.
 *   monthly  → 30 min  (1800 s)
 *   annual   → 90 min  (5400 s)
 *   lifetime → unlimited (null)
 *
 * The server is the source of truth for monetization — it verifies the caller
 * actually holds an active entitlement before doing any paid work, so an
 * expired/cancelled subscriber or an unidentified caller can't draw free
 * Whisper/Claude/ElevenLabs. The client paywall is UX only.
 */
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { fetchEntitlementFromRC } from './revenuecat.ts';

export type Tier = 'monthly' | 'annual' | 'lifetime';

export function tierCapSeconds(tier: Tier): number | null {
  switch (tier) {
    case 'monthly':  return 1800;
    case 'annual':   return 5400;
    case 'lifetime': return null;
  }
}

export interface Entitlement {
  tier: Tier;
  entitled: boolean;
}

/**
 * Resolve the caller's entitlement, always keyed by `app_user_id`. After RC
 * `logIn`, a signed-in user's appUserID == their Supabase uuid == caller.userId,
 * so this one column resolves both anonymous and signed-in callers.
 *
 *   - Row present, status active/trialing/in_grace, not past current_period_end
 *     (lifetime never expires) → entitled.
 *   - Row present but expired/cancelled → NOT entitled (definitive deny).
 *   - No row (webhook lag on a fresh purchase) → RevenueCat REST fallback.
 */
export async function loadEntitlement(
  svc: SupabaseClient,
  userId: string,
): Promise<Entitlement> {
  const { data } = await svc
    .from('subscriptions')
    .select('tier, status, current_period_end')
    .eq('app_user_id', userId)
    .maybeSingle();

  const row = data as
    | { tier?: Tier; status?: string; current_period_end?: string | null }
    | null;

  if (row) {
    const tier: Tier =
      row.tier === 'monthly' || row.tier === 'annual' || row.tier === 'lifetime'
        ? row.tier
        : 'annual';
    const activeStatus =
      row.status === 'active' || row.status === 'trialing' || row.status === 'in_grace';
    const notExpired =
      tier === 'lifetime' ||
      !row.current_period_end ||
      new Date(row.current_period_end).getTime() > Date.now();
    return { tier, entitled: activeStatus && notExpired };
  }

  // Mirror miss — verify directly with RevenueCat so a just-purchased user isn't
  // falsely denied while the webhook is in flight. Unknown tier but entitled
  // (product naming mismatch) falls back to the generous 'annual' cap.
  const rc = await fetchEntitlementFromRC(userId);
  return { tier: rc.tier ?? 'annual', entitled: rc.entitled };
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
