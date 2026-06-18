/**
 * Audio-session configuration and microphone-sensitivity helpers (spec §6, §9.1).
 *
 * Recording itself is owned by the speech recognizer (see `recognizer.ts`); this
 * module only configures the shared audio session for Marie's playback and maps
 * the recognizer's volume readings for the waveform and voice detection.
 */
import { setAudioModeAsync } from 'expo-audio';

import type { Settings } from '@/lib/types';

/**
 * Put the audio session into recording mode (call before listening).
 *
 * `allowsRecording` is iOS-only; the speech recognizer owns the mic on Android.
 * We still pin `shouldRouteThroughEarpiece: false` so that if anything plays
 * during the listen it stays on the loudspeaker, never the earpiece.
 */
export async function configureAudioSession(): Promise<void> {
  await setAudioModeAsync({
    allowsRecording: true,
    playsInSilentMode: true,
    shouldRouteThroughEarpiece: false,
    // Marie keeps speaking if the app is backgrounded mid-playback (spec §9.1).
    shouldPlayInBackground: true,
  });
}

/**
 * Put the audio session into playback mode (call before Marie speaks).
 *
 * The real fix for "Marie is inaudible on Android": after a speech-recognition
 * session the OS leaves the audio routed to the earpiece on the voice-call
 * stream, so playback is silent or near-silent. `shouldRouteThroughEarpiece:
 * false` forces the loudspeaker, and `interruptionMode: 'doNotMix'` requests
 * media-stream audio focus so Marie plays at media volume. (`allowsRecording`
 * does NOT control routing on Android — it's iOS-only — which is why toggling it
 * alone never fixed this.) Idempotent and cheap to call per turn.
 */
export async function setPlaybackAudioMode(): Promise<void> {
  await setAudioModeAsync({
    allowsRecording: false,
    playsInSilentMode: true,
    shouldRouteThroughEarpiece: false,
    interruptionMode: 'doNotMix',
    shouldPlayInBackground: true,
  });
}

/**
 * The recognizer reports input volume as a float roughly between -2 and 10
 * (below 0 is inaudible). Map it to a 0..1 amplitude for the waveform.
 */
export function volumeToAmplitude(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value / 8));
}

/**
 * The volume above which a reading counts as the user actually speaking.
 * "Manual" sensitivity lowers the bar so softer speakers still register (spec §4.5).
 */
export function voiceThreshold(sensitivity: Settings['micSensitivity']): number {
  return sensitivity === 'manual' ? 0.6 : 1.6;
}

/** True when a volume reading indicates speech rather than background noise. */
export function isAudibleVoice(
  value: number,
  sensitivity: Settings['micSensitivity'],
): boolean {
  return Number.isFinite(value) && value > voiceThreshold(sensitivity);
}
