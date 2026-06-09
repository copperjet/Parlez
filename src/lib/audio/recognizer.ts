/**
 * Speech recognition — the device-side STT layer (spec §6.1, §11.1). Wraps
 * expo-speech-recognition so the turn engine gets live interim transcripts, a
 * persisted audio file for cloud Whisper, and on-device recognition offline.
 *
 * The session is French-first; audio is captured to a cache file only so it can
 * be uploaded for accurate transcription, then discarded (spec §8).
 */
import { requireOptionalNativeModule } from 'expo-modules-core';
import type {
  ExpoSpeechRecognitionModule as ESRModule,
  ExpoSpeechRecognitionNativeEventMap,
} from 'expo-speech-recognition';

let moduleRef: typeof ESRModule | null = null;
let loaded = false;

/**
 * Lazily load the native STT module. Returns null where it isn't installed —
 * Expo Go and web — so the app degrades to the typed-text fallback.
 *
 * We probe with `requireOptionalNativeModule` first: it returns null instead of
 * throwing when the native module is absent. Only when it exists do we `require`
 * the JS wrapper. This matters because importing 'expo-speech-recognition' runs a
 * throwing top-level `requireNativeModule`, and Metro/LogBox reports that error
 * even if we catch it — so in Expo Go we must avoid the import entirely. Full
 * voice STT needs a development build where the native module is present.
 */
function getModule(): typeof ESRModule | null {
  if (!loaded) {
    loaded = true;
    if (requireOptionalNativeModule('ExpoSpeechRecognition') != null) {
      moduleRef = require('expo-speech-recognition').ExpoSpeechRecognitionModule;
    } else {
      moduleRef = null;
    }
  }
  return moduleRef;
}

/**
 * True when the native STT module is present (a dev/standalone build). False in
 * Expo Go and on web, where the turn engine must fall back to typed text.
 */
export function isRecognitionAvailable(): boolean {
  return getModule() != null;
}

type RecognitionHandlers = {
  result?: (e: ExpoSpeechRecognitionNativeEventMap['result']) => void;
  volumechange?: (e: ExpoSpeechRecognitionNativeEventMap['volumechange']) => void;
  audioend?: (e: ExpoSpeechRecognitionNativeEventMap['audioend']) => void;
  /** Hard recognizer failure (mic busy, no-speech, etc.) — fires before `end`. */
  error?: (e: ExpoSpeechRecognitionNativeEventMap['error']) => void;
  end?: () => void;
};

/** Subscribe to the recognition events the turn engine needs. Returns an unsubscribe fn. */
export function subscribeRecognition(handlers: RecognitionHandlers): () => void {
  const mod = getModule();
  if (!mod) return () => {};
  const subs = Object.entries(handlers).map(([name, fn]) =>
    mod.addListener(name as never, fn as never),
  );
  return () => subs.forEach((s) => s.remove());
}

/**
 * Start a French recognition session with live interim results and a persisted
 * audio file. Offline, recognition runs on-device (spec §11.1).
 */
export function startRecognition(online: boolean): void {
  const mod = getModule();
  // No native module (Expo Go / web): signal the turn engine to fall back to
  // typed text. It catches this and skips the silence timers (turnStateMachine.ts).
  if (!mod) throw new Error('speech recognition unavailable');
  mod.start({
    lang: 'fr-FR',
    interimResults: true,
    continuous: true,
    requiresOnDeviceRecognition: !online,
    addsPunctuation: true,
    recordingOptions: { persist: true },
    volumeChangeEventOptions: { enabled: true, intervalMillis: 120 },
  });
}

/** Stop the session and ask for a final result (fires `result`, then `end`). */
export function stopRecognition(): void {
  const mod = getModule();
  if (!mod) return;
  try {
    mod.stop();
  } catch {
    // Session may already be stopping; harmless.
  }
}

/** Cancel the session immediately with no final result. */
export function abortRecognition(): void {
  const mod = getModule();
  if (!mod) return;
  try {
    mod.abort();
  } catch {
    // Session may already be inactive; harmless.
  }
}

/** Request microphone + speech-recognition permission together (spec §3.1 step 3). */
export async function requestRecognitionPermissions(): Promise<{ granted: boolean }> {
  const mod = getModule();
  if (!mod) return { granted: false };
  const res = await mod.requestPermissionsAsync();
  return { granted: res.granted };
}

/**
 * Read current permission state without prompting. Used as a preflight before
 * starting a live-mode listen so a revoked mic surfaces one clear message instead
 * of storming the recognizer. Never throws; reports not-granted when no module.
 */
export async function getRecognitionPermissions(): Promise<{ granted: boolean }> {
  const mod = getModule();
  if (!mod) return { granted: false };
  try {
    const res = await mod.getPermissionsAsync();
    return { granted: res.granted };
  } catch {
    return { granted: false };
  }
}
