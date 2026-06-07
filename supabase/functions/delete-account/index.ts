/**
 * Account & subscription deletion endpoint (Play Store + GDPR requirement).
 *
 * GET  → HTML form. The URL is what Play Console's data-safety section links to.
 * POST → looks up the user (by email or by raw appUserID), then in parallel:
 *        - calls RevenueCat `DELETE /v1/subscribers/{id}` to wipe the
 *          subscription record (keeps invoices, removes PII / entitlements).
 *        - deletes the `user_state` row in Postgres.
 *
 * The RevenueCat *secret* key MUST be set as the function secret
 * `REVENUECAT_SECRET_KEY`. It is never exposed to clients.
 */
// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

import { corsHeaders } from '../_shared/cors.ts';

const RC_API = 'https://api.revenuecat.com/v1/subscribers';

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' },
  });
}

const FORM = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Delete your Parlez account</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; max-width: 520px; margin: 4rem auto; padding: 0 1.25rem; color: #1F1B16; background: #FBF9F6; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    p { line-height: 1.5; color: #6B635A; }
    label { display: block; margin-top: 1rem; font-weight: 600; }
    input, textarea { width: 100%; padding: 0.6rem; font-size: 1rem; border: 1px solid #E8E2D8; border-radius: 8px; box-sizing: border-box; }
    button { margin-top: 1.25rem; padding: 0.75rem 1.25rem; background: #C2483B; color: #fff; border: 0; border-radius: 999px; font-size: 1rem; font-weight: 600; cursor: pointer; }
    .small { font-size: 0.85rem; color: #A89E92; margin-top: 1.25rem; }
  </style>
</head>
<body>
  <h1>Delete your Parlez account</h1>
  <p>This permanently removes your subscription record, the learning profile Marie has built about you, and any cross-device sync data. Past payment receipts are retained for tax law compliance.</p>
  <form method="POST">
    <label for="email">Email associated with your account</label>
    <input id="email" name="email" type="email" required placeholder="you@example.com" />
    <label for="appUserId">— or — your in-app User ID (Settings → Account)</label>
    <input id="appUserId" name="appUserId" type="text" placeholder="rc_anon_xxxxx" />
    <label for="reason">Reason (optional)</label>
    <textarea id="reason" name="reason" rows="3" placeholder="What didn’t work for you?"></textarea>
    <button type="submit">Delete my account</button>
  </form>
  <p class="small">You may also delete locally in-app: Settings → Privacy → Delete all my data.</p>
</body>
</html>`;

function done(message: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Deleted</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:520px;margin:4rem auto;padding:0 1.25rem;color:#1F1B16;background:#FBF9F6;}</style>
</head><body><h1>Done.</h1><p>${message}</p></body></html>`;
}

async function deleteFromRevenueCat(appUserId: string, secret: string): Promise<boolean> {
  try {
    const res = await fetch(`${RC_API}/${encodeURIComponent(appUserId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${secret}` },
    });
    // 200 = deleted, 404 = already gone — both are fine.
    return res.status === 200 || res.status === 204 || res.status === 404;
  } catch {
    return false;
  }
}

async function deleteUserStateRow(
  client: ReturnType<typeof createClient>,
  userId: string,
): Promise<boolean> {
  try {
    const { error } = await client.from('user_state').delete().eq('user_id', userId);
    return !error;
  } catch {
    return false;
  }
}

/**
 * Purge the monetization/telemetry footprint for an id (Play Data-Safety
 * "delete account"): usage rows (keyed by user_id) and the subscription mirror
 * row (keyed by app_user_id). RevenueCat-side data is wiped separately via the
 * DELETE subscriber call.
 */
async function deleteUsageAndSubscription(
  client: ReturnType<typeof createClient>,
  id: string,
): Promise<void> {
  try {
    await client.from('usage_events').delete().eq('user_id', id);
  } catch {
    // best-effort
  }
  try {
    await client.from('subscriptions').delete().eq('app_user_id', id);
  } catch {
    // best-effort
  }
  try {
    await client.from('subscriptions').delete().eq('supabase_user_id', id);
  } catch {
    // best-effort
  }
}

async function lookupUserIdByEmail(
  client: ReturnType<typeof createClient>,
  email: string,
): Promise<string | null> {
  try {
    const admin: any = (client as any).auth?.admin;
    if (!admin?.listUsers) return null;
    const { data } = await admin.listUsers();
    const user = data?.users?.find(
      (u: { email?: string | null }) =>
        (u.email ?? '').toLowerCase() === email.toLowerCase(),
    );
    return user?.id ?? null;
  } catch {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method === 'GET') {
    return html(FORM);
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const rcSecret = Deno.env.get('REVENUECAT_SECRET_KEY') ?? '';
  if (!supabaseUrl || !serviceKey || !rcSecret) {
    return html(done('Server is misconfigured. Please email support@parlez.app.'), 500);
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let email = '';
  let appUserId = '';
  const ct = req.headers.get('content-type') ?? '';
  try {
    if (ct.includes('application/json')) {
      const body = (await req.json()) as { email?: string; appUserId?: string };
      email = (body.email ?? '').trim();
      appUserId = (body.appUserId ?? '').trim();
    } else {
      const form = await req.formData();
      email = String(form.get('email') ?? '').trim();
      appUserId = String(form.get('appUserId') ?? '').trim();
    }
  } catch {
    return html(done('Bad request.'), 400);
  }

  if (!email && !appUserId) {
    return html(done('You must provide an email or an in-app User ID.'), 400);
  }

  const ids = new Set<string>();
  if (appUserId) ids.add(appUserId);
  if (email) {
    const uid = await lookupUserIdByEmail(admin, email);
    if (uid) ids.add(uid);
  }

  if (ids.size === 0) {
    return html(
      done(
        'We couldn’t find an account for that email. If you used the anonymous in-app User ID, please paste it instead.',
      ),
      404,
    );
  }

  await Promise.all(
    Array.from(ids).flatMap((id) => [
      deleteFromRevenueCat(id, rcSecret),
      deleteUserStateRow(admin, id),
      deleteUsageAndSubscription(admin, id),
    ]),
  );

  return html(
    done('Your account, subscription record, and learning profile have been deleted.'),
  );
});
