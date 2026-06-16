/**
 * Real conversation service — talks to the Supabase Edge Functions that
 * orchestrate Whisper (STT), Claude (AI), and ElevenLabs (TTS), per spec §7.2.
 *
 * Selected over the mock when EXPO_PUBLIC_PARLEZ_SERVICE=supabase and the
 * Supabase URL + anon key are configured (see lib/env.ts). The app code never
 * depends on this directly — only on the ConversationService interface.
 */
import * as FileSystem from 'expo-file-system/legacy';

import { SPEECH_SPEEDS, type MarieVoiceId, type SpeechSpeed } from '@/lib/constants';
import { ENV, functionsBase, useSupabaseService } from '@/lib/env';
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
export async function authHeaders(): Promise<Record<string, string>> {
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

/**
 * Server-side account deletion (Play data-safety + GDPR). Calls the
 * `delete-account` Edge Function so the user's data is removed from our servers,
 * not just locally: a signed-in user is resolved from their JWT (auth.users +
 * RLS-scoped rows + the RevenueCat subscriber), and we always pass the
 * RevenueCat appUserID so the anonymous path is covered too.
 *
 * Best-effort: resolves true on a 2xx, false otherwise — the caller still wipes
 * local data and logs out regardless. MUST run BEFORE the local logout, which
 * invalidates the session token this relies on.
 */
export async function deleteAccountOnServer(): Promise<boolean> {
  if (!useSupabaseService || !supabase) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);
  try {
    const headers = await authHeaders();
    const appUserId = await getCallerId();
    const res = await fetch(`${functionsBase()}/delete-account`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(appUserId ? { appUserId } : {}),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    // Network/timeout/abort — local wipe + logout still proceed in the caller.
    return false;
  } finally {
    clearTimeout(timer);
  }
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
    profileFacts: ctx.profileFacts ?? {},
    streakDays: ctx.streakDays ?? 0,
    history: ctx.history.slice(-10).map((m) => ({ speaker: m.speaker, text: m.text })),
  };
}

/** Coerce an untrusted value into a bounded key→value facts map. Mirrors the
 *  server's sanitizeProfileFacts so client and server agree on the shape. */
function sanitizeProfileFacts(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k !== 'string' || typeof v !== 'string') continue;
    const key = k.trim().slice(0, 32);
    const value = v.trim().slice(0, 160);
    if (!key || !value) continue;
    out[key] = value;
    if (Object.keys(out).length >= 14) break;
  }
  return out;
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
    profileFacts: sanitizeProfileFacts(r.profileFacts),
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
  opts: {
    audioUri?: string | null;
    text?: string | null;
    simpler?: boolean;
    sttMs?: number | null;
  } = {},
): Promise<TurnResponse> {
  // Non-file form fields, sent as multipart parameters on either transport.
  const params: Record<string, string> = {
    mode,
    context: JSON.stringify(serializeContext(ctx)),
  };
  if (opts.simpler != null) params.simpler = String(opts.simpler);
  if (opts.text) params.text = opts.text;
  // Streaming STT (Tier 2): client transcribed live, so we send the measured
  // speech duration with the text turn so the server still bills + caps it.
  if (opts.sttMs != null && opts.sttMs > 0) params.stt_ms = String(Math.round(opts.sttMs));

  // Identify the caller for server-side usage attribution + cap enforcement.
  // Signed-in users are also identified via JWT; passing this is harmless and
  // keeps the anonymous path working.
  const appUserId = await getCallerId();
  if (appUserId) params.app_user_id = appUserId;

  // Decide whether we have real, readable audio to upload. Scribe (server STT) is
  // far more accurate and code-switch native, so a good recording should be the
  // authoritative transcript; the device `text` stays the server's empty-STT
  // fallback. Android's system recognizer sometimes persists an empty/header-only
  // file, so probe first (guarded fetch → arrayBuffer) and only upload when it
  // reads AND carries real bytes.
  let audioUpload: { uri: string; mime: string } | null = null;
  if (opts.audioUri) {
    let bytes = 0;
    try {
      bytes = (await (await fetch(opts.audioUri)).arrayBuffer()).byteLength;
    } catch {
      // Unreadable on this runtime — treat as no audio, degrade to the text path.
      bytes = 0;
    }
    if (bytes >= AUDIO_MIN_BYTES) {
      const ext = (opts.audioUri.split('.').pop() ?? 'wav').toLowerCase();
      audioUpload = { uri: opts.audioUri, mime: AUDIO_MIME[ext] ?? 'audio/wav' };
    }
    if (__DEV__) {
      console.log(`[stt] audio ${audioUpload ? 'attached' : 'skipped'} — ${bytes} bytes`);
    }
  }

  const headers = await authHeaders();
  const url = `${functionsBase()}/turn`;

  let status: number;
  let body: string;

  if (audioUpload) {
    // Upload via expo-file-system's native uploader. RN's own multipart path is
    // unusable for a file on this runtime: fetch(uri).blob() crashes Hermes
    // ("Creating blobs from 'ArrayBuffer'…"), and the {uri,name,type} FormData
    // part throws "Unsupported FormDataPart implementation" in RN 0.85's native
    // networking. uploadAsync sends one RFC-2387 multipart request — the file in
    // the `audio` field, the rest as string `parameters` — exactly what the turn
    // fn parses. (No AbortController timeout here; voice uploads are small.)
    const res = await FileSystem.uploadAsync(url, audioUpload.uri, {
      httpMethod: 'POST',
      uploadType: FileSystem.FileSystemUploadType.MULTIPART,
      fieldName: 'audio',
      mimeType: audioUpload.mime,
      parameters: params,
      headers,
    });
    status = res.status;
    body = res.body ?? '';
  } else {
    // No audio — a plain text turn. RN's FormData handles string-only parts fine,
    // and we keep the abort timeout so a hung connection can't wedge the UI.
    const form = new FormData();
    for (const [k, v] of Object.entries(params)) form.append(k, v);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: form,
        signal: controller.signal,
      });
      status = res.status;
      body = await res.text();
    } finally {
      clearTimeout(timeout);
    }
  }

  if (status === 403) {
    // Server says the caller isn't entitled — cached entitlement is stale.
    throw new NotEntitledError();
  }
  if (status === 402) {
    // Daily cap hit server-side. Surface to the store + throw a typed sentinel
    // the turn engine catches without retrying.
    let parsed: { tier?: string; cap_seconds?: number } = {};
    try {
      parsed = JSON.parse(body) as { tier?: string; cap_seconds?: number };
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
  if (status < 200 || status >= 300) {
    // Surface the server's error body so the cause (e.g. `claude 404: model …`,
    // `ANTHROPIC_API_KEY not set`) is diagnosable on-device instead of collapsing
    // to a bare status. The turn engine surfaces this in DEV/diag.
    throw new Error(`turn ${status}${body ? `: ${body.slice(0, 300)}` : ''}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`turn ${status}: invalid JSON body`);
  }
  return parseTurnResponse(json);
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
      return callTurn('reply', ctx, {
        audioUri: input.audioUri,
        text: input.text,
        sttMs: input.sttMs ?? null,
      });
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
