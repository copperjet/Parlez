/**
 * Referral & affiliate code system — shared constants + reward crediting.
 *
 * One code system, three lanes (`referral_codes.type`):
 *   user     — friend referrals; owner earns bonus-minutes rewards in-app
 *   creator  — influencer affiliates; payout handled externally, no in-app reward
 *   educator — teachers referring adult students; free-access milestones granted
 *              manually via the RevenueCat dashboard for now
 *
 * Rewards are a bonus-minutes bank (`bonus_grants` ledger) — the one currency
 * that works for free users (extends the taste) and subscribers (extends the
 * daily cap) alike. Referee reward is instant at redemption; referrer rewards
 * are staged behind referee activation and purchase so farming fresh identities
 * yields nothing beyond the cheap taste minutes.
 */
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

/** Bonus granted to the referee at redemption: 10 min -> 20 min total taste. */
export const REFEREE_BONUS_MS = 600_000;
/** Referrer reward when the referee activates (real conversation, see threshold). */
export const REFERRER_ACTIVATED_MS = 600_000;
/** Referrer reward when the referee makes a real store purchase (webhook-driven). */
export const REFERRER_PURCHASED_MS = 1_800_000;
/** A referee counts as activated once their lifetime conversation crosses this. */
export const ACTIVATION_THRESHOLD_MS = 300_000;
/** Max rewarded referrals per referrer per rolling 365 days (user-type codes). */
export const REFERRER_YEARLY_CAP = 12;

export type CodeType = 'user' | 'creator' | 'educator';

/** Redemptions allowed per code per UTC day — a viral creator post must not
 *  turn into an unbounded free-compute bill in one afternoon. */
export const DAILY_BURST_CAP: Record<CodeType, number> = {
  user: 10,
  educator: 100,
  creator: 500,
};

/** Unambiguous alphabet — no 0/O/1/I so codes survive handwriting and speech. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

export function generateCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

/** Uppercase, strip whitespace/dashes so "pz-7xk4q " matches "7XK4Q". Vanity
 *  creator codes may legitimately contain dashes, so only trim edges there. */
export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '').replace(/^PZ-/, '');
}

interface ReferralRow {
  referee_id: string;
  code: string;
  referrer_id: string;
  status: 'redeemed' | 'activated' | 'purchased';
}

/** Sum of the bonus-minutes ledger. Missing rows -> 0. */
export async function loadBonusBalanceMs(
  svc: SupabaseClient,
  userId: string,
): Promise<number> {
  const { data } = await svc
    .from('bonus_grants')
    .select('ms')
    .eq('user_id', userId);
  if (!Array.isArray(data)) return 0;
  let ms = 0;
  for (const row of data as { ms?: number }[]) ms += Number(row.ms ?? 0);
  return Math.max(0, ms);
}

/**
 * Record consumption of banked minutes (negative ledger row), clamped to the
 * current balance. Fire-and-forget from `turn` — a failure must never fail the
 * conversation, it only lets the caller draw slightly ahead of the ledger.
 */
export async function consumeBonus(
  svc: SupabaseClient,
  userId: string,
  ms: number,
): Promise<void> {
  if (ms <= 0) return;
  const balance = await loadBonusBalanceMs(svc, userId);
  const take = Math.min(ms, balance);
  if (take <= 0) return;
  const { error } = await svc.from('bonus_grants').insert({
    user_id: userId,
    ms: -take,
    reason: 'consumed',
  });
  if (error) console.error('bonus consume insert failed', error.message);
}

/** True when the referrer already earned their yearly quota of rewarded referrals. */
async function referrerAtYearlyCap(
  svc: SupabaseClient,
  referrerId: string,
): Promise<boolean> {
  const since = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString();
  const { count } = await svc
    .from('bonus_grants')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', referrerId)
    .in('reason', ['referrer_activated', 'referrer_purchased'])
    .gte('created_at', since);
  return (count ?? 0) >= REFERRER_YEARLY_CAP;
}

/** Load the code row for a referral so reward routing can branch on lane. */
async function codeTypeFor(
  svc: SupabaseClient,
  code: string,
): Promise<CodeType | null> {
  const { data } = await svc
    .from('referral_codes')
    .select('type')
    .eq('code', code)
    .maybeSingle();
  const t = (data as { type?: string } | null)?.type;
  return t === 'user' || t === 'creator' || t === 'educator' ? t : null;
}

/**
 * Advance a referral to `activated` and credit the referrer (user-type codes
 * only — creator payouts are external, educator rewards are manual RC grants).
 * Idempotent: the status check gates re-entry and the unique partial index on
 * bonus_grants makes a racing duplicate insert a harmless conflict.
 */
export async function creditReferrerOnActivation(
  svc: SupabaseClient,
  refereeId: string,
): Promise<void> {
  const { data } = await svc
    .from('referrals')
    .select('referee_id, code, referrer_id, status')
    .eq('referee_id', refereeId)
    .maybeSingle();
  const row = data as ReferralRow | null;
  if (!row || row.status !== 'redeemed') return;

  const { error: upErr } = await svc
    .from('referrals')
    .update({ status: 'activated', activated_at: new Date().toISOString() })
    .eq('referee_id', refereeId)
    .eq('status', 'redeemed');
  if (upErr) {
    console.error('referral activate update failed', upErr.message);
    return;
  }

  if ((await codeTypeFor(svc, row.code)) !== 'user') return;
  if (await referrerAtYearlyCap(svc, row.referrer_id)) return;

  const { error } = await svc.from('bonus_grants').insert({
    user_id: row.referrer_id,
    ms: REFERRER_ACTIVATED_MS,
    reason: 'referrer_activated',
    ref_referee_id: refereeId,
  });
  // 23505 = unique violation: another instance already granted this — fine.
  if (error && error.code !== '23505') {
    console.error('referrer activation grant failed', error.message);
  }
}

/** A commission becomes payable this many days after purchase (covers the
 *  refund guarantee and store refund windows). Mirrors docs/affiliate-terms.md. */
export const CREATOR_HOLDBACK_DAYS = 60;
/** Balances below this roll over to the next monthly payout. */
export const CREATOR_MIN_PAYOUT_USD = 25;
/** Store commission assumed when RevenueCat doesn't report one (small-business tier). */
const DEFAULT_STORE_FEE = 0.15;

/** First-purchase economics from the RevenueCat event (all optional — RC may
 *  omit price data, e.g. on sandbox events). */
export interface PurchaseInfo {
  plan: string | null;
  grossUsd: number | null;
  taxPct: number | null;
  storeFeePct: number | null;
}

/**
 * Creator commission on a first payment: rate × what we actually net. RC reports
 * tax and store commission as fractions of the transaction price, so both come
 * off the gross. Null when the price is unknown — shown as "—", never guessed.
 */
export function computeCommissionUsd(p: PurchaseInfo, rate: number): number | null {
  if (p.grossUsd === null || !Number.isFinite(p.grossUsd) || p.grossUsd <= 0) return null;
  const tax = p.taxPct !== null && Number.isFinite(p.taxPct) ? p.taxPct : 0;
  const fee =
    p.storeFeePct !== null && Number.isFinite(p.storeFeePct) ? p.storeFeePct : DEFAULT_STORE_FEE;
  const net = p.grossUsd * Math.max(0, 1 - tax - fee);
  return Math.round(net * rate * 100) / 100;
}

/**
 * Advance a referral to `purchased`, record the first-payment economics (and the
 * commission, for creator codes), and credit a user-lane referrer's big reward.
 * Called from the RevenueCat webhook on the first real payment — an immediate
 * purchase, a trial conversion, or a lifetime purchase. Must never throw (the
 * webhook always returns 200 after auth). First payment only: an already
 * purchased referral is left untouched, so renewals never re-credit.
 */
export async function creditReferrerOnPurchase(
  svc: SupabaseClient,
  refereeId: string,
  purchase: PurchaseInfo = { plan: null, grossUsd: null, taxPct: null, storeFeePct: null },
): Promise<void> {
  const { data } = await svc
    .from('referrals')
    .select('referee_id, code, referrer_id, status')
    .eq('referee_id', refereeId)
    .maybeSingle();
  const row = data as ReferralRow | null;
  if (!row || row.status === 'purchased') return;

  const { data: codeData } = await svc
    .from('referral_codes')
    .select('type, commission_rate')
    .eq('code', row.code)
    .maybeSingle();
  const codeRow = codeData as { type?: string; commission_rate?: number | string } | null;
  const type = codeRow?.type;
  const rate = Number(codeRow?.commission_rate ?? 0.3);

  const { error: upErr } = await svc
    .from('referrals')
    .update({
      status: 'purchased',
      purchased_at: new Date().toISOString(),
      plan: purchase.plan,
      gross_usd:
        purchase.grossUsd !== null && Number.isFinite(purchase.grossUsd)
          ? Math.round(purchase.grossUsd * 100) / 100
          : null,
      commission_usd: type === 'creator' ? computeCommissionUsd(purchase, rate) : null,
    })
    .eq('referee_id', refereeId)
    .neq('status', 'purchased');
  if (upErr) {
    console.error('referral purchase update failed', upErr.message);
    return;
  }

  if (type !== 'user') return;
  if (await referrerAtYearlyCap(svc, row.referrer_id)) return;

  const { error } = await svc.from('bonus_grants').insert({
    user_id: row.referrer_id,
    ms: REFERRER_PURCHASED_MS,
    reason: 'referrer_purchased',
    ref_referee_id: refereeId,
  });
  if (error && error.code !== '23505') {
    console.error('referrer purchase grant failed', error.message);
  }
}

/**
 * Flag a purchased referral as refunded so its commission never becomes
 * payable (or is netted off if already paid — the dashboard's available
 * balance excludes it). Idempotent; a no-op for non-referred users.
 */
export async function markReferralRefunded(
  svc: SupabaseClient,
  refereeId: string,
): Promise<void> {
  const { error } = await svc
    .from('referrals')
    .update({ refunded_at: new Date().toISOString() })
    .eq('referee_id', refereeId)
    .eq('status', 'purchased')
    .is('refunded_at', null);
  if (error) console.error('referral refund mark failed', error.message);
}
