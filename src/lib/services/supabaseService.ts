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
import type { Correction, LevelSignal, TurnContext, TurnResponse } from '@/lib/types';

import type { ConversationService, SynthesizedSpeech, TurnInput } from './conversation';

type TurnMode = 'open' | 'reply' | 'silence';

/** MIME type for the recorder's audio file, inferred from its extension. */
function audioMime(ext: string): string {
  if (ext === 'caf') return 'audio/x-caf';
  if (ext === 'm4a') return 'audio/m4a';
  if (ext === 'mp3') return 'audio/mpeg';
  return 'audio/wav';
}

function authHeaders(): Record<string, string> {
  return {
    apikey: ENV.supabaseAnonKey,
    Authorization: `Bearer ${ENV.supabaseAnonKey}`,
  };
}

/** Trim the context to what the BFF needs — recent text only, never audio. */
function serializeContext(ctx: TurnContext) {
  return {
    level: ctx.level,
    profileSummary: ctx.profileSummary,
    gapSinceLastSession: ctx.gapSinceLastSession,
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
  return {
    transcript: typeof r.transcript === 'string' ? r.transcript : '',
    speechText: typeof r.speechText === 'string' ? r.speechText : '',
    corrections,
    profileNotes,
    levelSignal: (signal === 'up' || signal === 'down' ? signal : 'hold') as LevelSignal,
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
  if (opts.audioUri) {
    // The recognizer persists a .wav (or .caf on iOS); match name + type to it.
    const ext = (opts.audioUri.split('.').pop() ?? 'wav').toLowerCase();
    // React Native FormData file shape.
    form.append('audio', {
      uri: opts.audioUri,
      name: `turn.${ext}`,
      type: audioMime(ext),
    } as unknown as Blob);
  }

  const res = await fetch(`${functionsBase()}/turn`, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  });
  if (!res.ok) {
    throw new Error(`turn failed: ${res.status}`);
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
      const params = new URLSearchParams({
        text,
        voice,
        speed: String(SPEECH_SPEEDS[speed]),
      });
      return {
        uri: `${functionsBase()}/tts?${params.toString()}`,
        durationMs: estimateDuration(text, speed),
        headers: authHeaders(),
      };
    },
  };
}
