/**
 * `tts` Edge Function — Marie's voice (spec §6.2). Converts her text into
 * speech with ElevenLabs and streams the audio straight back to the client so
 * the first chunk plays fast.
 *
 * Called as a GET so the mobile audio player can stream it directly:
 *   /tts?text=...&voice=marie&speed=1.0&app_user_id=<rc anon uuid when not signed in>
 *
 * Phase 2 monetization: logs `text.length` chars per call into `usage_events`
 * (non-blocking) for cost telemetry.
 */
import { corsHeaders } from '../_shared/cors.ts';
import { resolveCaller } from '../_shared/caller.ts';
import { serviceClient } from '../_shared/db.ts';
import { estimateTtsMicrocents } from '../_shared/pricing.ts';

/** Map Marie's voice ids to ElevenLabs voice ids (override via env). */
function voiceId(voice: string): string {
  const env = Deno.env.get(`ELEVENLABS_VOICE_${voice.toUpperCase()}`);
  if (env) return env;
  // Fallback: a single configured default voice.
  return Deno.env.get('ELEVENLABS_VOICE_DEFAULT') ?? 'EXAVITQu4vr4xnSDxMaL';
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const text = url.searchParams.get('text') ?? '';
    const voice = url.searchParams.get('voice') ?? 'marie';
    const speed = Number(url.searchParams.get('speed') ?? '1.0');
    const appUserId = url.searchParams.get('app_user_id');

    if (!text) {
      return new Response('missing text', { status: 400, headers: corsHeaders });
    }

    // Log TTS usage (non-blocking). Failure must not delay the audio stream.
    const caller = resolveCaller(req, appUserId);
    if (caller && text.length > 0) {
      try {
        const svc = serviceClient();
        void svc
          .from('usage_events')
          .insert({
            user_id: caller.userId,
            is_anon: caller.isAnon,
            kind: 'tts',
            tts_chars: text.length,
            estimated_cost_microcents: estimateTtsMicrocents(text.length).toString(),
          })
          .then(({ error }) => {
            if (error) console.error('tts usage insert failed', error.message);
          });
      } catch (e) {
        console.error('tts serviceClient unavailable', e instanceof Error ? e.message : e);
      }
    }

    const key = Deno.env.get('ELEVENLABS_API_KEY');
    if (!key) {
      return new Response('ELEVENLABS_API_KEY not set', {
        status: 500,
        headers: corsHeaders,
      });
    }

    // ElevenLabs accepts a 0.7–1.2 speed; clamp the app's range into it.
    const clampedSpeed = Math.max(0.7, Math.min(1.2, speed));

    const eleven = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId(voice)}/stream` +
        `?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'xi-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({
          text,
          // Flash v2.5: ~half the cost of multilingual v2, lower latency, quality
          // still high. Override via ELEVENLABS_MODEL to restore the premium voice.
          model_id: Deno.env.get('ELEVENLABS_MODEL') ?? 'eleven_flash_v2_5',
          voice_settings: {
            stability: 0.45,
            similarity_boost: 0.8,
            speed: clampedSpeed,
          },
        }),
      },
    );

    if (!eleven.ok || !eleven.body) {
      // Forward ElevenLabs' own error body so the real reason (quota, missing
      // permission, unusual-activity gate, etc.) is visible to the caller.
      const detail = await eleven.text().catch(() => '');
      return new Response(`elevenlabs ${eleven.status}: ${detail}`, {
        status: 502,
        headers: corsHeaders,
      });
    }

    // Proxy the audio stream straight through to the client.
    return new Response(eleven.body, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    return new Response(e instanceof Error ? e.message : String(e), {
      status: 500,
      headers: corsHeaders,
    });
  }
});
