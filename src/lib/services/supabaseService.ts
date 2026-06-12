/**
 * Real conversation service — talks to the Supabase Edge Functions that
 * orchestrate Whisper (STT), Claude (AI), and ElevenLabs (TTS), per spec §7.2.
 *
 * Selected over the mock when EXPO_PUBLIC_PARLEZ_SERVICE=supabase and the
 * Supabase URL + anon key are configured (see lib/env.ts). The app code never
 * depends on this directly — only on the ConversationService interface.
 */
import { SPEECH_SPEEDS, type MarieVoiceId, type SpeechSpeed } from '@/lib/constants';
import { ENV, functionsBase } from '@/lib/env';
import { getCallerId } from '@/lib/revenuecat';
import { supabase } from '@/lib/supabase';
import { useSubscriptionStore } from '@/stores/subscriptionStore';
import type {
  Correction,
  LevelSignal,
  MessageSegment,
  TurnContext,
  TurnResponse,
} from '@/lib/types';

import type { ConversationService, SynthesizedSpeech, TurnInput } from './conversation';

type TurnMode = 'open' | 'reply' | 'silence';

/**
 * Hard ceiling on a single /turn request. Without it, a hung connection never
 * rejects and the UI sticks on the thinking indicator (•••) forever — notably
 * the opening turn after the app's been backgrounded. On timeout the fetch
 * aborts and the turn engine runs its normal error path (retry-once / idle).
 */
const TURN_TIMEOUT_MS = 20000;

/** Sentinel error thrown when the server returns a 402 daily-cap response. */
export class DailyCapError extends Error {
  constructor(
    public readonly tier: 'monthly' | 'annual' | 'lifetime',
    public readonly capSeconds: number,
  ) {
    super('daily_cap');
    this.name = 'DailyCapError';
  }
}

/**
 * Sentinel thrown when the server rejects the caller as not entitled (403). The
 * server is authoritative for monetization; this means the client's cached
 * entitlement is stale (expired/cancelled/transferred). The turn engine catches
 * it, refreshes RevenueCat, and routes to the paywall.
 */
export class NotEntitledError extends Error {
  constructor() {
    super('not_entitled');
    this.name = 'NotEntitledError';
  }
}

/**
 * Build the headers for an edge-fn call. Prefer the signed-in user's JWT so
 * the server can resolve auth.uid() in RLS / `usage_events.is_anon = false`;
 * fall back to the anon key when no session exists. The apikey header stays
 * the anon key in both cases (Supabase requires it for routing).
 */
async function authHeaders(): Promise<Record<string, string>> {
  let token = ENV.supabaseAnonKey;
  if (supabase) {
    try {
      const { data } = await supabase.auth.getSession();
      const access = data.session?.access_token;
      if (access) token = access;
    } catch {
      // fall through to anon key
    }
  }
  return {
    apikey: ENV.supabaseAnonKey,
    Authorization: `Bearer ${token}`,
  };
}


/** Trim the context to what the BFF needs — recent text only, never audio. */
function serializeContext(ctx: TurnContext) {
  return {
    level: ctx.level,
    profileSummary: ctx.profileSummary,
    gapSinceLastSession: ctx.gapSinceLastSession,
    personaName: ctx.personaName,
    learnerName: ctx.learnerName ?? null,
    interests: ctx.interests ?? [],
    streakDays: ctx.streakDays ?? 0,
    history: ctx.history.slice(-10).map((m) => ({ speaker: m.speaker, text: m.text })),
  };
}

/** Coerce the BFF's JSON into a well-formed TurnResponse. */
function parseTurnResponse(raw: unknown): TurnResponse {
  const r = (raw ?? {}) as Record<string, unknown>;
  const corrections = Array.isArray(r.corrections)
    ? (r.corrections as Correction[]).filter((c) => c && c.original && c.corrected)
    : [];
  const profileNotes = Array.isArray(r.profileNotes)
    ? (r.profileNotes as unknown[]).filter((n): n is string => typeof n === 'string')
    : [];
  const signal = r.levelSignal;
  const learnerName =
    typeof r.learnerName === 'string' && r.learnerName.trim()
      ? r.learnerName.trim()
      : null;
  const interests = Array.isArray(r.interests)
    ? (r.interests as unknown[])
        .filter((i): i is string => typeof i === 'string')
        .map((i) => i.trim())
        .filter(Boolean)
        .slice(0, 8)
    : [];
  const segments = Array.isArray(r.segments)
    ? (r.segments as unknown[])
        .map((s) => {
          const seg = (s ?? {}) as Record<string, unknown>;
          const text = typeof seg.text === 'string' ? seg.text.trim() : '';
          if (!text) return null;
          const label =
            typeof seg.label === 'string' && seg.label.trim()
              ? seg.label.trim()
              : undefined;
          return { label, text } as MessageSegment;
        })
        .filter((s): s is MessageSegment => s != null)
        .slice(0, 6)
    : undefined;
  return {
    transcript: typeof r.transcript === 'string' ? r.transcript : '',
    speechText: typeof r.speechText === 'string' ? r.speechText : '',
    translation: typeof r.translation === 'string' ? r.translation : undefined,
    segments: segments && segments.length > 0 ? segments : undefined,
    corrections,
    profileNotes,
    levelSignal: (signal === 'up' || signal === 'down' ? signal : 'hold') as LevelSignal,
    learnerName,
    interests,
  };
}

/** Recording extension → MIME type for the multipart audio part. */
const AUDIO_MIME: Record<string, string> = {
  wav: 'audio/wav',
  m4a: 'audio/m4a',
  mp4: 'audio/mp4',
  caf: 'audio/x-caf',
  '3gp': 'audio/3gpp',
  amr: 'audio/amr',
};

/**
 * Minimum bytes for a recording to count as real speech worth uploading. A bare
 * WAV/container header is only tens of bytes, and Android's system recognizer
 * frequently persists an empty or header-only file. Below this we skip the
 * upload and let the server fall back to the device transcript.
 */
const AUDIO_MIN_BYTES = 2048;

async function callTurn(
  mode: TurnMode,
  ctx: TurnContext,
  opts: { audioUri?: string | null; text?: string | null; simpler?: boolean } = {},
): Promise<TurnResponse> {
  const form = new FormData();
  form.append('mode', mode);
  form.append('context', JSON.stringify(serializeContext(ctx)));
  if (opts.simpler != null) form.append('simpler', String(opts.simpler));
  if (opts.text) form.append('text', opts.text);

  // Identify the caller for server-side usage attribution + cap enforcement.
  // Signed-in users are also identified via JWT; passing this is harmless and
  // keeps the anonymous path working.
  const appUserId = await getCallerId();
  if (appUserId) form.append('app_user_id', appUserId);

  // Attach the recording ONLY when it is real, readable audio. Scribe (server
  // STT) is far more accurate and code-switch native, so a good recording should
  // be the authoritative transcript; the device `text` above stays the server's
  // empty-STT fallback. Two hazards force a pre-check before attaching:
  //   1. Under RN 0.85 / Hermes we cannot build a Blob from the file, so the part
  //      must be RN's URI-object form ({uri,name,type}); the native multipart
  //      serializer reads the file lazily at POST time.
  //   2. Android's system recognizer frequently persists an empty/unusable file.
  //      Appending such a URI makes the POST itself throw (unreadable part) —
  //      which previously failed EVERY spoken turn with the generic "couldn't
  //      respond" banner.
  // So we probe the file first (guarded fetch → arrayBuffer) and attach only if it
  // reads AND carries real bytes; otherwise we skip it and let the server fall
  // back to the device transcript. The probe doubling as a read-check guarantees
  // the POST won't choke on an unreadable part. `audioUri` only exists on native
  // (web has no recognizer), so the URI-object builder is always correct here.
  if (opts.audioUri) {
    let bytes = 0;
    try {
      const probe = await fetch(opts.audioUri);
      bytes = (await probe.arrayBuffer()).byteLength;
    } catch {
      // Unreadable on this runtime (e.g. Hermes/Blob, or a content:// the JS
      // fetch can't open) — treat as no audio and degrade to the text path.
      bytes = 0;
    }
    if (bytes >= AUDIO_MIN_BYTES) {
      // The recognizer persists a .wav (or .caf on iOS); keep the extension so
      // the server detects the format.
      const ext = (opts.audioUri.split('.').pop() ?? 'wav').toLowerCase();
      const type = AUDIO_MIME[ext] ?? 'audio/wav';
      form.append(
        'audio',
        { uri: opts.audioUri, name: `turn.${ext}`, type } as unknown as Blob,
      );
    }
    if (__DEV__) {
      // Phase-2 gate: is the device producing real audio, or are we always
      // falling back to text? The byte count is the decisive signal.
      console.log(
        `[stt] audio ${bytes >= AUDIO_MIN_BYTES ? 'attached' : 'skipped'} — ${bytes} bytes`,
      );
    }
  }

  const headers = await authHeaders();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${functionsBase()}/turn`, {
      method: 'POST',
      headers,
      body: form,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (res.status === 403) {
    // Server says the caller isn't entitled — cached entitlement is stale.
    throw new NotEntitledError();
  }
  if (res.status === 402) {
    // Daily cap hit server-side. Surface to the store + throw a typed sentinel
    // the turn engine catches without retrying.
    let parsed: { tier?: string; cap_seconds?: number } = {};
    try {
      parsed = (await res.json()) as { tier?: string; cap_seconds?: number };
    } catch {
      // body wasn't JSON; ignore
    }
    const tier =
      parsed.tier === 'monthly' || parsed.tier === 'annual' || parsed.tier === 'lifetime'
        ? parsed.tier
        : 'monthly';
    const capSeconds =
      typeof parsed.cap_seconds === 'number' ? parsed.cap_seconds : 1800;
    useSubscriptionStore.getState().setCapBlocked({ tier, capSeconds });
    throw new DailyCapError(tier, capSeconds);
  }
  if (!res.ok) {
    // Capture the server's error body so the cause (e.g. `claude 404: model …`,
    // `ANTHROPIC_API_KEY not set`, `whisper 401`) is diagnosable on-device instead
    // of collapsing to a bare status. The turn engine surfaces this in DEV/diag.
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      // body unreadable — status alone
    }
    throw new Error(`turn ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return parseTurnResponse(await res.json());
}

/** Rough spoken-duration estimate, used only as a waveform-timing fallback. */
function estimateDuration(text: string, speed: SpeechSpeed): number {
  const words = text.trim().split(/\s+/).length;
  return Math.round(Math.max(1400, Math.min(9000, words * 360)) / SPEECH_SPEEDS[speed]);
}

export function createSupabaseService(): ConversationService {
  return {
    openTurn(ctx: TurnContext): Promise<TurnResponse> {
      return callTurn('open', ctx);
    },

    sendTurn(input: TurnInput, ctx: TurnContext): Promise<TurnResponse> {
      return callTurn('reply', ctx, { audioUri: input.audioUri, text: input.text });
    },

    promptSilence(simpler: boolean, ctx: TurnContext): Promise<TurnResponse> {
      return callTurn('silence', ctx, { simpler });
    },

    async synthesize(
      text: string,
      voice: MarieVoiceId,
      speed: SpeechSpeed,
    ): Promise<SynthesizedSpeech> {
      // The player streams the audio directly from the tts function so the
      // first chunk arrives fast (spec §6.2). Auth travels as a header.
      const appUserId = await getCallerId();
      const params = new URLSearchParams({
        text,
        voice,
        speed: String(SPEECH_SPEEDS[speed]),
      });
      if (appUserId) params.append('app_user_id', appUserId);
      return {
        uri: `${functionsBase()}/tts?${params.toString()}`,
        durationMs: estimateDuration(text, speed),
        headers: await authHeaders(),
      };
    },
  };
}
