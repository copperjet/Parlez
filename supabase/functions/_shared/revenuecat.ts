/**
 * RevenueCat REST fallback — consulted by the entitlement resolver when the
 * `subscriptions` mirror has no row for a caller (webhook lag right after a
 * fresh purchase). Authenticates with the RC *secret* key
 * (`REVENUECAT_SECRET_KEY`), never the public SDK key. Fails closed: any error,
 * 404, or missing secret returns `{ entitled: false }`.
 */
export type Tier = 'monthly' | 'annual' | 'lifetime';

const RC_API = 'https://api.revenuecat.com/v1/subscribers';
const ENTITLEMENT_ID = 'premium';

/** Map a product identifier to a tier. Mirrors the webhook + client logic. */
export function tierForProduct(productId: string | null | undefined): Tier | null {
  if (!productId) return null;
  const p = productId.toLowerCase();
  if (p.includes('lifetime')) return 'lifetime';
  if (p.includes('annual') || p.includes('year')) return 'annual';
  if (p.includes('monthly') || p.includes('month')) return 'monthly';
  return null;
}

export interface RcEntitlement {
  tier: Tier | null;
  entitled: boolean;
}

/**
 * Ask RevenueCat directly whether `appUserId` holds the `premium` entitlement.
 * Active when the entitlement exists and its `expires_date` is null (lifetime)
 * or in the future.
 */
export async function fetchEntitlementFromRC(appUserId: string): Promise<RcEntitlement> {
  const secret = Deno.env.get('REVENUECAT_SECRET_KEY') ?? '';
  if (!secret) {
    console.error('REVENUECAT_SECRET_KEY not set — cannot verify entitlement on mirror miss');
    return { tier: null, entitled: false };
  }
  try {
    const res = await fetch(`${RC_API}/${encodeURIComponent(appUserId)}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    if (!res.ok) return { tier: null, entitled: false };
    const body = (await res.json()) as {
      subscriber?: {
        entitlements?: Record<
          string,
          { expires_date?: string | null; product_identifier?: string }
        >;
      };
    };
    const ent = body.subscriber?.entitlements?.[ENTITLEMENT_ID];
    if (!ent) return { tier: null, entitled: false };
    const expiresMs = ent.expires_date ? new Date(ent.expires_date).getTime() : null;
    const active = expiresMs === null || expiresMs > Date.now();
    if (!active) return { tier: null, entitled: false };
    return { tier: tierForProduct(ent.product_identifier), entitled: true };
  } catch (e) {
    console.error('RC entitlement fetch failed', e instanceof Error ? e.message : e);
    return { tier: null, entitled: false };
  }
}
