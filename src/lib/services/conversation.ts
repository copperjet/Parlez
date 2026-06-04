/**
 * The single seam between the app and the heavy cloud work (spec §7.1).
 * Two implementations live behind this interface:
 *   - MockConversationService  — canned French, no network, no API keys.
 *   - SupabaseConversationService — real Whisper / Claude / ElevenLabs (Phase 7).
 * The app only ever depends on this interface.
 */
import type { MarieVoiceId, SpeechSpeed } from '@/lib/constants';
import type { TurnContext, TurnResponse } from '@/lib/types';

/** Result of turning Marie's text into audio. */
export interface SynthesizedSpeech {
  /** Playable audio URI, or null when the service has no real audio (mock). */
  uri: string | null;
  /** Expected playback length in ms — drives waveform timing when uri is null. */
  durationMs: number;
  /** HTTP headers when streaming from an authenticated endpoint (real TTS). */
  headers?: Record<string, string>;
}

/** A user turn's raw input: recorded audio (preferred) or typed text. */
export interface TurnInput {
  audioUri: string | null;
  text: string | null;
}

export interface ConversationService {
  /** Marie speaks first — onboarding intro or the start of a returning session. */
  openTurn(ctx: TurnContext): Promise<TurnResponse>;

  /** A user turn: audio or text in, Marie's structured response out. */
  sendTurn(input: TurnInput, ctx: TurnContext): Promise<TurnResponse>;

  /**
   * Marie's gentle nudge after the user stays silent (spec §6.3).
   * `simpler` true means fall back to an easier question.
   */
  promptSilence(simpler: boolean, ctx: TurnContext): Promise<TurnResponse>;

  /** Convert Marie's text into speech audio. */
  synthesize(
    text: string,
    voice: MarieVoiceId,
    speed: SpeechSpeed,
  ): Promise<SynthesizedSpeech>;
}
