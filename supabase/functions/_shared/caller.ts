/**
 * Resolve who is making this edge-fn call.
 *
 * Two paths:
 *   1. Signed-in user — the Authorization header carries the Supabase user's
 *      JWT and `sub` is their auth.users.id (UUID).
 *   2. Anonymous user — the client passes the RevenueCat appUserID (the same
 *      UUID v4 it persists locally) in the request body as `app_user_id`.
 *
 * The Supabase anon-key JWT is rejected as a user id (its `role` is 'anon' and
 * it has no `sub`), so we fall through to the body field.
 */

function decodeJwtSub(jwt: string): string | null {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    // base64url -> base64
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 === 0 ? b64 : b64 + '='.repeat(4 - (b64.length % 4));
    const payload = JSON.parse(atob(pad));
    if (typeof payload.sub !== 'string') return null;
    // The anon key has `role: 'anon'` and uses the project ref as `sub`; ignore.
    if (payload.role === 'anon' || payload.role === 'service_role') return null;
    return payload.sub;
  } catch {
    return null;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Caller {
  userId: string;
  isAnon: boolean;
}

export function resolveCallerFromJwt(req: Request): string | null {
  const auth = req.headers.get('authorization') ?? '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  return decodeJwtSub(m[1]);
}

/** Minimal shape of a supabase-js client for auth verification — structural so
 *  callers holding differently-parameterised clients all fit. */
interface AuthVerifier {
  auth: {
    getUser(jwt: string): Promise<{
      data: { user: { id: string; email?: string | null } | null } | null;
    }>;
  };
}

/**
 * Resolve the caller from a bearer JWT whose signature is VERIFIED by the auth
 * server (`auth.getUser`). Use this — not `resolveCaller` — for anything that
 * serves sensitive data (earnings) or performs destructive actions: the
 * decode-only path above can be forged by anyone who knows a user's uuid.
 */
export async function verifiedUser(
  client: unknown,
  req: Request,
): Promise<{ id: string; email: string | null } | null> {
  const auth = req.headers.get('authorization') ?? '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  try {
    const { data } = await (client as AuthVerifier).auth.getUser(m[1]);
    if (!data?.user) return null;
    return { id: data.user.id, email: data.user.email ?? null };
  } catch {
    return null;
  }
}

/**
 * Try the JWT first; if it doesn't resolve to a real user, fall back to the
 * caller-supplied `app_user_id`. Returns null when neither yields a usable id.
 */
export function resolveCaller(
  req: Request,
  bodyAppUserId: string | null,
): Caller | null {
  const fromJwt = resolveCallerFromJwt(req);
  if (fromJwt && UUID_RE.test(fromJwt)) {
    return { userId: fromJwt, isAnon: false };
  }
  if (bodyAppUserId && UUID_RE.test(bodyAppUserId)) {
    return { userId: bodyAppUserId, isAnon: true };
  }
  return null;
}
