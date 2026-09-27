/**
 * `referral` Edge Function — the referral/affiliate code API.
 *
 * JSON POST, `action` field:
 *   get    → caller's own share code (created on first request), funnel stats,
 *            bonus-minutes balance, and whether the caller may still redeem.
 *   redeem → validate + redeem a code for the caller: one redemption per
 *            identity ever; grants the referee bonus (taste 10 → 20 min).
 *   dashboard → creator/educator dashboard (funnel, earnings, payouts). Requires
 *            a signed-in caller whose JWT is verified by the auth server.
 *
 * Self-authenticating like turn/tts (verify_jwt off): signed-in callers via
 * JWT, anonymous onboarding callers via `app_user_id` in the body — a referee
 * redeems during onboarding, before any account exists.
 *
 * The server is the source of truth: grants land in `bonus_grants` and the
 * turn/tts/stt gates honour them; the client mirrors allowance only for UX.
 */
import { corsHeaders, json } from '../_shared/cors.ts';
import { resolveCaller, verifiedUser } from '../_shared/caller.ts';
import { serviceClient } from '../_shared/db.ts';
import { loadEntitlement } from '../_shared/caps.ts';
import {
  CREATOR_HOLDBACK_DAYS,
  CREATOR_MIN_PAYOUT_USD,
  DAILY_BURST_CAP,
  REFEREE_BONUS_MS,
  type CodeType,
  generateCode,
  normalizeCode,
} from '../_shared/referral.ts';

/** Mirrors FREE_TASTE_MS in turn/tts/stt-token — base taste before bonuses. */
const FREE_TASTE_MS = 10 * 60 * 1000;

interface CodeRow {
  code: string;
  owner_id: string;
  type: CodeType;
  max_redemptions: number | null;
  active: boolean;
}

type Svc = ReturnType<typeof serviceClient>;

/** Sum of positive grants — the caller's total earned bonus, never reduced by
 *  consumption. base + granted is what the client's local meter gates against
 *  (consumption mirrors the same overage the meter already counts). */
async function loadGrantedMs(svc: Svc, userId: string): Promise<number> {
  const { data } = await svc
    .from('bonus_grants')
    .select('ms')
    .eq('user_id', userId)
    .gt('ms', 0);
  if (!Array.isArray(data)) return 0;
  let ms = 0;
  for (const row of data as { ms?: number }[]) ms += Number(row.ms ?? 0);
  return ms;
}

/** The caller's own user-type share code, created on first request. */
async function ownCode(svc: Svc, userId: string): Promise<string> {
  const { data } = await svc
    .from('referral_codes')
    .select('code')
    .eq('owner_id', userId)
    .eq('type', 'user')
    .maybeSingle();
  const existing = (data as { code?: string } | null)?.code;
  if (existing) return existing;

  // Create; retry on the (rare) random collision.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateCode();
    const { error } = await svc
      .from('referral_codes')
      .insert({ code, owner_id: userId, type: 'user' });
    if (!error) return code;
    if (error.code !== '23505') throw new Error(`code insert failed: ${error.message}`);
    // 23505 on the PK = collision → regenerate. On owner uniqueness races the
    // re-select below settles it.
    const { data: raced } = await svc
      .from('referral_codes')
      .select('code')
      .eq('owner_id', userId)
      .eq('type', 'user')
      .maybeSingle();
    const racedCode = (raced as { code?: string } | null)?.code;
    if (racedCode) return racedCode;
  }
  throw new Error('could not allocate a referral code');
}

interface PartnerCode {
  code: string;
  type: 'creator' | 'educator';
  label: string | null;
  commission_rate: number;
}

/** The caller's active creator/educator code, if they've been designated one
 *  (most recent wins). Owning one is what makes an account a partner. */
async function loadPartnerCode(svc: Svc, userId: string): Promise<PartnerCode | null> {
  const { data } = await svc
    .from('referral_codes')
    .select('code, type, label, commission_rate')
    .eq('owner_id', userId)
    .eq('active', true)
    .in('type', ['creator', 'educator'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const row = data as
    | { code: string; type: 'creator' | 'educator'; label: string | null; commission_rate: number | string }
    | null;
  if (!row) return null;
  return { ...row, commission_rate: Number(row.commission_rate) };
}

async function handleGet(svc: Svc, userId: string): Promise<Response> {
  const [code, statsRes, grantedMs, redeemedRes, entitlement, partner] = await Promise.all([
    ownCode(svc, userId),
    svc.from('referrals').select('status').eq('referrer_id', userId),
    loadGrantedMs(svc, userId),
    svc.from('referrals').select('referee_id').eq('referee_id', userId).maybeSingle(),
    loadEntitlement(svc, userId),
    loadPartnerCode(svc, userId),
  ]);

  let redeemed = 0;
  let activated = 0;
  let purchased = 0;
  for (const row of (statsRes.data ?? []) as { status?: string }[]) {
    if (row.status === 'purchased') purchased += 1;
    else if (row.status === 'activated') activated += 1;
    else redeemed += 1;
  }

  return json({
    code,
    // Which Settings entry the client shows: partners get their dashboard,
    // everyone else the regular invite-a-friend screen.
    role: partner?.type ?? 'user',
    stats: {
      // Funnel counts are cumulative: a purchased referee also joined+activated.
      joined: redeemed + activated + purchased,
      activated: activated + purchased,
      purchased,
    },
    granted_seconds: Math.round(grantedMs / 1000),
    allowance_seconds: Math.round((FREE_TASTE_MS + grantedMs) / 1000),
    may_redeem: !redeemedRes.data && !entitlement.entitled,
  });
}

const toCents = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

/**
 * Creator/educator dashboard. The caller is resolved from a VERIFIED JWT only —
 * this serves earnings, so the forgeable decode/app_user_id path is not enough.
 * Referee identities are never returned: conversions are date · plan · amount.
 */
async function handleDashboard(svc: Svc, userId: string): Promise<Response> {
  const partner = await loadPartnerCode(svc, userId);
  if (!partner) return json({ role: 'user' });
  const isCreator = partner.type === 'creator';

  const [refsRes, payoutsRes] = await Promise.all([
    svc
      .from('referrals')
      .select('status, purchased_at, plan, commission_usd, refunded_at')
      .eq('code', partner.code),
    isCreator
      ? svc
          .from('creator_payouts')
          .select('amount_usd, paid_at, method')
          .eq('code', partner.code)
          .order('paid_at', { ascending: false })
      : Promise.resolve({ data: [] as unknown[] }),
  ]);

  type Ref = {
    status: string;
    purchased_at: string | null;
    plan: string | null;
    commission_usd: number | string | null;
    refunded_at: string | null;
  };
  const refs = (refsRes.data ?? []) as Ref[];
  const holdbackMs = CREATOR_HOLDBACK_DAYS * 24 * 3600 * 1000;
  const now = Date.now();

  let joined = 0;
  let activated = 0;
  let purchased = 0;
  let refunded = 0;
  let pendingCents = 0;
  let eligibleCents = 0;
  const conversions: {
    purchased_at: string;
    plan: string | null;
    commission_usd?: number | null;
    status: 'pending' | 'eligible' | 'refunded';
  }[] = [];

  for (const r of refs) {
    joined += 1;
    if (r.status === 'activated' || r.status === 'purchased') activated += 1;
    if (r.status !== 'purchased' || !r.purchased_at) continue;
    purchased += 1;
    const cents = toCents(r.commission_usd);
    let status: 'pending' | 'eligible' | 'refunded';
    if (r.refunded_at) {
      refunded += 1;
      status = 'refunded';
    } else if (now - new Date(r.purchased_at).getTime() >= holdbackMs) {
      status = 'eligible';
      eligibleCents += cents;
    } else {
      status = 'pending';
      pendingCents += cents;
    }
    conversions.push({
      purchased_at: r.purchased_at,
      plan: r.plan,
      ...(isCreator
        ? { commission_usd: r.commission_usd === null ? null : cents / 100 }
        : {}),
      status,
    });
  }
  conversions.sort((a, b) => b.purchased_at.localeCompare(a.purchased_at));

  const body: Record<string, unknown> = {
    role: partner.type,
    code: partner.code,
    label: partner.label,
    funnel: { joined, activated, purchased, refunded },
    conversions: conversions.slice(0, 20),
  };

  if (isCreator) {
    type Payout = { amount_usd: number | string; paid_at: string; method: string | null };
    const payouts = (payoutsRes.data ?? []) as Payout[];
    const paidCents = payouts.reduce((s, p) => s + toCents(p.amount_usd), 0);
    body.earnings = {
      rate: partner.commission_rate,
      pending_usd: pendingCents / 100,
      // A refund after payout can push this negative; the deficit is carried in
      // the arithmetic (future eligible commissions absorb it) but never shown.
      available_usd: Math.max(0, eligibleCents - paidCents) / 100,
      paid_usd: paidCents / 100,
      holdback_days: CREATOR_HOLDBACK_DAYS,
      min_payout_usd: CREATOR_MIN_PAYOUT_USD,
    };
    body.payouts = payouts.slice(0, 12).map((p) => ({
      paid_at: p.paid_at,
      amount_usd: toCents(p.amount_usd) / 100,
      method: p.method,
    }));
  }

  return json(body);
}

async function handleRedeem(
  svc: Svc,
  userId: string,
  rawCode: string,
): Promise<Response> {
  const code = normalizeCode(rawCode);
  if (!code) return json({ ok: false, error: 'invalid_code' });

  const { data } = await svc
    .from('referral_codes')
    .select('code, owner_id, type, max_redemptions, active')
    .eq('code', code)
    .maybeSingle();
  const row = data as CodeRow | null;
  if (!row || !row.active) return json({ ok: false, error: 'invalid_code' });
  if (row.owner_id === userId) return json({ ok: false, error: 'own_code' });

  // One redemption per identity, ever (the referrals PK backs this up).
  const { data: prior } = await svc
    .from('referrals')
    .select('referee_id')
    .eq('referee_id', userId)
    .maybeSingle();
  if (prior) return json({ ok: false, error: 'already_redeemed' });

  // Codes are for people who haven't bought yet — a subscriber redeeming only
  // muddies attribution.
  const { entitled } = await loadEntitlement(svc, userId);
  if (entitled) return json({ ok: false, error: 'not_eligible' });

  // Per-code lifetime cap (explicit) and per-type daily burst cap (a viral
  // creator post must not become an unbounded free-compute bill overnight).
  if (row.max_redemptions !== null) {
    const { count } = await svc
      .from('referrals')
      .select('referee_id', { count: 'exact', head: true })
      .eq('code', code);
    if ((count ?? 0) >= row.max_redemptions) {
      return json({ ok: false, error: 'code_exhausted' });
    }
  }
  const dayStart = `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
  const { count: todayCount } = await svc
    .from('referrals')
    .select('referee_id', { count: 'exact', head: true })
    .eq('code', code)
    .gte('redeemed_at', dayStart);
  if ((todayCount ?? 0) >= DAILY_BURST_CAP[row.type]) {
    return json({ ok: false, error: 'code_exhausted' });
  }

  const { error: insErr } = await svc.from('referrals').insert({
    referee_id: userId,
    code,
    referrer_id: row.owner_id,
  });
  if (insErr) {
    // PK violation = a concurrent redeem won the race.
    if (insErr.code === '23505') return json({ ok: false, error: 'already_redeemed' });
    throw new Error(`referral insert failed: ${insErr.message}`);
  }

  const { error: grantErr } = await svc.from('bonus_grants').insert({
    user_id: userId,
    ms: REFEREE_BONUS_MS,
    reason: 'referee_redeem',
    ref_referee_id: userId,
  });
  if (grantErr && grantErr.code !== '23505') {
    console.error('referee grant failed', grantErr.message);
  }

  const grantedMs = await loadGrantedMs(svc, userId);
  return json({
    ok: true,
    granted_seconds: Math.round(grantedMs / 1000),
    allowance_seconds: Math.round((FREE_TASTE_MS + grantedMs) / 1000),
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json({ error: 'method not allowed' }, 405);
  }

  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = typeof body.action === 'string' ? body.action : '';
    const bodyAppUserId =
      typeof body.app_user_id === 'string' ? body.app_user_id : null;

    if (Deno.env.get('PARLEZ_MOCK') === 'true') {
      if (action === 'redeem') {
        return json({ ok: true, granted_seconds: 600, allowance_seconds: 1200 });
      }
      if (action === 'dashboard') return json({ role: 'user' });
      return json({
        code: 'MOCK42',
        role: 'user',
        stats: { joined: 0, activated: 0, purchased: 0 },
        granted_seconds: 0,
        allowance_seconds: 600,
        may_redeem: true,
      });
    }

    if (action === 'dashboard') {
      // Earnings data: verified signed-in callers only (no app_user_id fallback).
      const svc = serviceClient();
      const user = await verifiedUser(svc, req);
      if (!user) return json({ error: 'sign-in required' }, 401);
      return await handleDashboard(svc, user.id);
    }

    const caller = resolveCaller(req, bodyAppUserId);
    if (!caller) {
      return json({ error: 'unidentified caller' }, 403);
    }

    const svc = serviceClient();
    if (action === 'get') {
      return await handleGet(svc, caller.userId);
    }
    if (action === 'redeem') {
      const rawCode = typeof body.code === 'string' ? body.code : '';
      return await handleRedeem(svc, caller.userId, rawCode);
    }
    return json({ error: `unsupported action: ${action}` }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
