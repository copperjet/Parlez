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
import type { Correction, LevelSignal, TurnContext, TurnResponse } from '@/lib/types';

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
  return {
    transcript: typeof r.transcript === 'string' ? r.transcript : '',
    speechText: typeof r.speechText === 'string' ? r.speechText : '',
    translation: typeof r.translation === 'string' ? r.translation : undefined,
    corrections,
    profileNotes,
    levelSignal: (signal === 'up' || signal === 'down' ? signal : 'hold') as LevelSignal,
    learnerName,
    interests,
  };
}

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

  // Attach the recording for Whisper ONLY when we have no device transcript.
  // Native STT (expo-speech-recognition) normally yields text directly, and the
  // server falls back to that text anyway — so sending text-only is the common,
  // correct path. It also sidesteps a hard runtime failure: under RN 0.85 /
  // Hermes, `fetch(fileUri).blob()` throws "Creating blobs from 'ArrayBuffer'
  // and 'ArrayBufferView' are not supported", which previously killed every
  // spoken turn before the request even left the device. The blob build is
  // additionally guarded so any failure degrades to a text/STT-miss turn rather
  // than throwing.
  if (opts.audioUri && !opts.text) {
    try {
      // The recognizer persists a .wav (or .caf on iOS); keep the extension so
      // Whisper detects the format.
      const ext = (opts.audioUri.split('.').pop() ?? 'wav').toLowerCase();
      const fileRes = await fetch(opts.audioUri);
      const blob = await fileRes.blob();
      form.append('audio', blob, `turn.${ext}`);
    } catch {
      // Blob unsupported on this runtime — proceed without audio; the server
      // returns a clean STT-miss the client renders as a gentle re-prompt.
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
