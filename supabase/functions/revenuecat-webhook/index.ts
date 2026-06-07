/**
 * `revenuecat-webhook` Edge Function — receives RC subscription events and
 * upserts the `subscriptions` mirror table so backend (this fn, future
 * dunning automation, analytics) can query tier/status in SQL.
 *
 * Auth: RC sends `Authorization: Bearer <RC_WEBHOOK_SECRET>` on every call.
 * Verify with constant-time compare; reject mismatches with 401.
 *
 * Important: always return 200 once auth has passed. RC retries 4xx/5xx
 * indefinitely; a malformed payload should be logged and dropped, not retried.
 */
import { corsHeaders } from '../_shared/cors.ts';
import { serviceClient } from '../_shared/db.ts';

type Tier = 'monthly' | 'annual' | 'lifetime';
type Status = 'active' | 'trialing' | 'in_grace' | 'expired' | 'cancelled';

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function tierFor(productId: string): Tier | null {
  const p = productId.toLowerCase();
  if (p.includes('lifetime')) return 'lifetime';
  if (p.includes('annual') || p.includes('year')) return 'annual';
  if (p.includes('monthly') || p.includes('month')) return 'monthly';
  return null;
}

function statusFor(eventType: string, periodType: string | null): Status {
  switch (eventType) {
    case 'INITIAL_PURCHASE':
    case 'RENEWAL':
    case 'PRODUCT_CHANGE':
    case 'UNCANCELLATION':
      return periodType === 'TRIAL' ? 'trialing' : 'active';
    case 'EXPIRATION':
      return 'expired';
    case 'CANCELLATION':
      return 'cancelled';
    case 'BILLING_ISSUE':
      return 'in_grace';
    case 'SUBSCRIPTION_PAUSED':
      return 'in_grace';
    default:
      return 'active';
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405, headers: corsHeaders });
  }

  const secret = Deno.env.get('RC_WEBHOOK_SECRET') ?? '';
  if (!secret) {
    console.error('RC_WEBHOOK_SECRET not set');
    return new Response('not configured', { status: 500, headers: corsHeaders });
  }
  const auth = req.headers.get('authorization') ?? '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m || !constantTimeEq(m[1], secret)) {
    return new Response('unauthorized', { status: 401, headers: corsHeaders });
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch (e) {
    console.error('webhook json parse failed', e instanceof Error ? e.message : e);
    return new Response('ok', { status: 200, headers: corsHeaders });
  }

  try {
    const event = (payload.event ?? {}) as Record<string, unknown>;
    const eventType = String(event.type ?? '');
    const appUserId = String(event.app_user_id ?? '');
    const productId = String(event.product_id ?? '');
    const periodType = (event.period_type as string | null) ?? null;
    const expirationMs = event.expiration_at_ms as number | undefined;

    // TRANSFER fires when an anonymous RC user is aliased onto a signed-in
    // identity (Purchases.logIn). The subscription moves from the old anon id to
    // the new one; delete the stale anon row so the mirror has a single source
    // of truth and the cap resolver doesn't read an orphan.
    if (eventType === 'TRANSFER') {
      const fromIds = Array.isArray(event.transferred_from)
        ? (event.transferred_from as string[])
        : [];
      if (fromIds.length > 0) {
        const svc = serviceClient();
        const { error } = await svc
          .from('subscriptions')
          .delete()
          .in('app_user_id', fromIds);
        if (error) console.error('transfer cleanup failed', error.message);
      }
      return new Response('ok', { status: 200, headers: corsHeaders });
    }

    if (!appUserId || !productId) {
      console.error('webhook missing fields', { eventType, appUserId, productId });
      return new Response('ok', { status: 200, headers: corsHeaders });
    }

    const tier = tierFor(productId);
    if (!tier) {
      console.error('webhook unknown product', productId);
      return new Response('ok', { status: 200, headers: corsHeaders });
    }

    const status = statusFor(eventType, periodType);

    // The entitlement resolver keys solely on `app_user_id` (after RC logIn a
    // signed-in user's appUserID == their Supabase uuid), so this column is for
    // analytics only — never for resolution. We can't reliably tell an anon uuid
    // from a Supabase uuid by shape, so leave it null and let downstream joins
    // populate it. (Previously this guessed from `aliases`, which mislabelled
    // anonymous rows.)
    const supabaseUserId = null;

    const svc = serviceClient();
    const { error } = await svc.from('subscriptions').upsert(
      {
        app_user_id: appUserId,
        supabase_user_id: supabaseUserId,
        tier,
        status,
        product_identifier: productId,
        period_type: periodType,
        current_period_end: expirationMs ? new Date(expirationMs).toISOString() : null,
        will_renew: status === 'active' || status === 'trialing',
        last_event_type: eventType,
        last_event_at: new Date().toISOString(),
        raw: payload,
      },
      { onConflict: 'app_user_id' },
    );
    if (error) {
      console.error('subscriptions upsert failed', error.message);
    }
  } catch (e) {
    console.error('webhook handler failed', e instanceof Error ? e.message : e);
  }

  return new Response('ok', { status: 200, headers: corsHeaders });
});
