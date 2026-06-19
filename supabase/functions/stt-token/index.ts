/**
 * `stt-token` Edge Function — mints a short-lived single-use token so the client
 * can open a realtime speech-to-text WebSocket directly to ElevenLabs (Scribe v2
 * Realtime) without ever shipping the account API key.
 *
 * Same entitlement gate as `turn`/`tts`: an unidentified or non-entitled caller
 * is denied before a token is minted. The daily cap is NOT enforced here — it
 * binds on the subsequent `/turn` call (which carries the conversation seconds),
 * so a token alone draws no paid AI/TTS work.
 *
 * Called as GET (cache-free), mirroring `tts`:
 *   /stt-token?app_user_id=<rc anon uuid when not signed in>
 *
 * Set PARLEZ_MOCK=true to return a stub token for end-to-end testing without keys.
 */
import { corsHeaders, json } from '../_shared/cors.ts';
import { resolveCaller } from '../_shared/caller.ts';
import { serviceClient } from '../_shared/db.ts';
import { loadEntitlement, loadLifetimeElapsedMs } from '../_shared/caps.ts';

/**
 * Free-taste allowance — MUST match FREE_TASTE_MS in `turn/index.ts` and
 * `tts/index.ts` (and FREE_TASTE_SECONDS in the subscription store). Without
 * parity here, streaming STT 403'd every non-subscriber, forcing the client to
 * fall back to the device recognizer: degraded en-US captions for beginners and
 * a "…" placeholder bubble until the reply. Voice streaming only worked on
 * already-entitled accounts.
 */
const FREE_TASTE_MS = 10 * 60 * 1000;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const appUserId = url.searchParams.get('app_user_id');

    if (Deno.env.get('PARLEZ_MOCK') === 'true') {
      return json({ token: 'sutkn_mock' });
    }

    // Entitlement gate — same source of truth as `turn`/`tts`. Deny unidentified
    // or non-entitled callers before minting a token. Fail open only on a genuine
    // infra error so paying users aren't blocked.
    const caller = resolveCaller(req, appUserId);
    if (!caller) {
      return json({ reason: 'not_entitled' }, 403);
    }
    try {
      const svc = serviceClient();
      const { entitled } = await loadEntitlement(svc, caller.userId);
      if (!entitled) {
        // Value-first parity with `turn`/`tts`: a non-entitled caller may stream
        // until their lifetime conversation time crosses FREE_TASTE_MS. Denying
        // them here forced the degraded device-recognizer fallback (en-US caption
        // mangling, "…" placeholder bubble) on every free user.
        const freeUsedMs = await loadLifetimeElapsedMs(svc, caller.userId);
        if (freeUsedMs >= FREE_TASTE_MS) {
          return json({ reason: 'not_entitled' }, 403);
        }
      }
    } catch (e) {
      // Fail open on a genuine infra error so paying users aren't blocked (matches tts/turn).
      console.error('stt-token entitlement check failed', e instanceof Error ? e.message : e);
    }

    const key = Deno.env.get('ELEVENLABS_API_KEY');
    if (!key) {
      return json({ error: 'ELEVENLABS_API_KEY not set' }, 500);
    }

    // 15-minute single-use token scoped to the realtime Scribe socket.
    const res = await fetch(
      'https://api.elevenlabs.io/v1/single-use-token/realtime_scribe',
      { method: 'POST', headers: { 'xi-api-key': key } },
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return json({ error: `elevenlabs token ${res.status}: ${detail.slice(0, 300)}` }, 502);
    }
    const data = await res.json();
    const token = typeof data.token === 'string' ? data.token : '';
    if (!token) {
      return json({ error: 'elevenlabs returned no token' }, 502);
    }
    return json({ token });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
