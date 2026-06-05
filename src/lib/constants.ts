/**
 * Conversation-rhythm constants, all sourced from the Parlez spec (§3, §6).
 * One place so the turn loop, recorder, and UI stay in agreement.
 */

/** Splash screen max duration before onboarding (spec §3.1 step 1). */
export const SPLASH_MS = 1500;

/** Pause after Marie finishes before the mic auto-activates (spec §6.3). */
export const GRACE_MS = 800;

/** Silence after mic activates before Marie gives a gentle prompt (spec §6.3). */
export const SILENCE_PROMPT_MS = 4000;

/** Further silence before Marie continues with a simpler question (spec §6.3). */
export const SILENCE_CONTINUE_MS = 8000;

/** Silence that auto-stops recording, once the user has actually spoken (spec §6.1). */
export const SILENCE_STOP_MS = 1500;

/** Minimum speech needed before silence-stop can trigger (spec §6.1). */
export const MIN_SPEECH_MS = 500;

/** Audio capture format for STT (spec §7.4). */
export const SAMPLE_RATE = 16000;

/** Marie's TTS playback speeds (spec §6.2). */
export const SPEECH_SPEEDS = {
  slow: 0.75,
  normal: 1.0,
  fast: 1.25,
} as const;
export type SpeechSpeed = keyof typeof SPEECH_SPEEDS;

/** A fresh topic is started if the gap since the last session exceeds this (spec §3.2). */
export const FRESH_TOPIC_GAP_MS = 48 * 60 * 60 * 1000;

/** Max correction cards shown per Marie turn (spec §5.3.2). */
export const MAX_CORRECTIONS_PER_TURN = 2;

/** Marie's available TTS voices (spec §6.2). */
export const MARIE_VOICES = [
  { id: 'marie', label: 'Marie', gender: 'female' },
  { id: 'claire', label: 'Claire', gender: 'female' },
  { id: 'henri', label: 'Henri', gender: 'male' },
] as const;
export type MarieVoiceId = (typeof MARIE_VOICES)[number]['id'];

/**
 * The persona's display + spoken name for a given voice. The conversation
 * partner adopts the chosen voice's name, so a male voice is never called
 * "Marie". Single source of truth for the name shown in the header, used in
 * accessibility labels, error banners, and the AI's system prompt.
 */
export function voiceName(id: MarieVoiceId): string {
  return MARIE_VOICES.find((v) => v.id === id)?.label ?? 'Marie';
}
