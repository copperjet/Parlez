/**
 * Conversation-rhythm constants, all sourced from the Parlez spec (§3, §6).
 * One place so the turn loop, recorder, and UI stay in agreement.
 */
import type { Level } from '@/lib/types';

// Canonical host is www: codarti.com 307-redirects to www.codarti.com, so we
// link the www form directly and skip the redirect hop. All three live (HTTP 200).
/** Hosted legal pages (also linked from the paywall + Play Store listing). */
export const PRIVACY_POLICY_URL = 'https://www.codarti.com/parlez/privacy';
export const TERMS_URL = 'https://www.codarti.com/parlez/terms';
/** Public account-deletion page (Play data-safety link + in-app "delete on web"). */
export const DELETE_ACCOUNT_URL = 'https://www.codarti.com/parlez/delete-account';
/** Where money-back guarantee refund requests are sent (in-app mailto). */
export const SUPPORT_EMAIL = 'support@codarti.com';

/** Notice shown when the OS mic permission is off — tapping it opens Settings. */
export const MIC_OFF_NOTICE = 'Microphone access is off. Tap to open Settings.';

/** Splash screen max duration before onboarding (spec §3.1 step 1). */
export const SPLASH_MS = 1500;

/** Pause after Marie finishes before the mic auto-activates (spec §6.3). */
export const GRACE_MS = 800;

/** Silence after mic activates before Marie gives a gentle prompt (spec §6.3). */
export const SILENCE_PROMPT_MS = 4000;

/** Further silence before Marie continues with a simpler question (spec §6.3). */
export const SILENCE_CONTINUE_MS = 8000;

/** Silence that auto-stops recording, once the user has actually spoken (spec §6.1). */
export const SILENCE_STOP_MS = 2000;

/**
 * Extended silence window when the transcript looks unfinished (trailing comma,
 * conjunction, or filler) — gives learners room to think mid-sentence without
 * the turn ending under them.
 */
export const SILENCE_STOP_UNFINISHED_MS = 4000;

/** Minimum speech needed before silence-stop can trigger (spec §6.1). */
export const MIN_SPEECH_MS = 500;

/**
 * Hard ceiling on a single listen, regardless of recognizer behaviour. A
 * backstop against Android's continuous recognizer re-emitting forever and
 * never going silent — once the user has actually spoken, the turn is force-
 * finished after this so the mic can never hang hot indefinitely.
 */
export const MAX_LISTEN_MS = 25000;

/**
 * Auto-send when the transcript has stopped gaining words for this long, even
 * if the volume meter still reads "voice" (noisy room, recognizer echo). Keeps
 * the practical auto-send delay far under MAX_LISTEN_MS while staying at least as
 * long as the unfinished-sentence silence window, so a thinking pause is never
 * cut earlier than it already would be.
 */
export const TRANSCRIPT_STALE_STOP_MS = 4000;

/**
 * Beat between revealing the user's transcribed bubble and Camille's reply. The
 * server returns the transcript and the reply in one round-trip, so without this
 * pause both bubbles land in the same frame and feel simultaneous. Holding the
 * user's words on screen first — thinking dots beneath — lets them read what they
 * said before Camille answers, like a real conversational turn.
 */
export const USER_REPLY_BEAT_MS = 550;

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

/**
 * Practice time that marks a calendar day "complete" for the streak — 10 minutes
 * of conversation. Accumulated locally per day (see `daily_activity` + the rolling
 * usage counter); once a day crosses this, it counts toward the streak.
 */
export const DAILY_GOAL_SECONDS = 10 * 60;

/**
 * Money-back guarantee (first-time users): complete this many *consecutive* days
 * of {@link DAILY_GOAL_SECONDS} practice, within {@link GUARANTEE_WINDOW_DAYS} of
 * first launch, to qualify for a refund. Refunds are processed by the store, not
 * in-app — the app only tracks and surfaces eligibility.
 */
export const GUARANTEE_DAYS = 20;
export const GUARANTEE_WINDOW_DAYS = 30;
/**
 * Grace period AFTER the guarantee window closes during which a qualified user can
 * still claim their refund. Bounds the "Request a refund" CTA so it isn't parked in
 * front of long-term happy subscribers forever: the guarantee card disappears once
 * GUARANTEE_WINDOW_DAYS + this grace have elapsed since first launch.
 */
export const GUARANTEE_CLAIM_GRACE_DAYS = 14;

/** Max correction cards shown per Marie turn (spec §5.3.2). */
export const MAX_CORRECTIONS_PER_TURN = 2;

/**
 * Per-level correction cap. Beginners (A) get at most one card so a turn never
 * feels like red ink; B/C keep the full ceiling. Must stay ≤ MAX_CORRECTIONS_PER_TURN.
 */
export function maxCorrectionsForLevel(level: Level): number {
  return level === 'A' ? 1 : MAX_CORRECTIONS_PER_TURN;
}

/**
 * The conversation partner's fixed name. "Camille" is gender-neutral, so it
 * fits both the female and male voice. Single source of truth for the name in
 * the header, accessibility labels, error banners, and the AI's system prompt.
 */
export const PERSONA_NAME = 'Camille';

/**
 * Available TTS voices (spec §6.2). The user no longer picks a named persona —
 * just a voice gender — so this is now a two-entry registry keyed by gender.
 * The multi-voice infrastructure (env-mapped `ELEVENLABS_VOICE_<ID>` on the
 * server) is unchanged; we simply expose two of the configured voices.
 */
export const MARIE_VOICES = [
  { id: 'camille', label: 'Camille', gender: 'female' },
  { id: 'henri', label: 'Henri', gender: 'male' },
] as const;
export type MarieVoiceId = (typeof MARIE_VOICES)[number]['id'];

export type VoiceGender = 'female' | 'male';

/** Voice id used for each gender of the Female/Male toggle. */
export const VOICE_BY_GENDER: Record<VoiceGender, MarieVoiceId> = {
  female: 'camille',
  male: 'henri',
};

/** Which gender toggle a stored voice id maps to. */
export function genderOfVoice(id: MarieVoiceId): VoiceGender {
  return id === 'henri' ? 'male' : 'female';
}

/**
 * The partner's name. Always {@link PERSONA_NAME} regardless of voice — the
 * persona stays "Camille" whether the user hears the female or male voice.
 * Kept as a function (taking the voice id) so every existing call site stays
 * unchanged.
 */
export function voiceName(_id: MarieVoiceId): string {
  return PERSONA_NAME;
}
