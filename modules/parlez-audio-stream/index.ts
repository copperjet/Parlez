import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * Native PCM mic-streaming module (Parlez Tier-2 live STT).
 *
 * Emits raw microphone audio as base64-encoded PCM16 / 16 kHz / mono chunks
 * (~100 ms each) via the `onAudioChunk` event, so the JS layer can relay them to
 * a streaming STT WebSocket.
 *
 * Android-only (declared in expo-module.config.json) — no native code is compiled
 * on iOS. Accessed LAZILY via {@link getAudioStreamModule}: an eager top-level
 * `requireOptionalNativeModule` can run before the native registry is ready and
 * cache `null` forever (this is exactly why recognizer.ts probes lazily). We
 * re-probe until the module resolves, then cache it.
 */
export interface AudioChunkEvent {
  /** base64-encoded PCM16 little-endian, 16 kHz mono. */
  base64: string;
  /** 0..1 RMS amplitude of this chunk — drives the waveform without the recognizer. */
  rms: number;
}

export interface ParlezAudioStreamModule {
  /** Begin capture. Rejects (UNSUPPORTED) on platforms without an implementation. */
  start(): Promise<void>;
  /** Stop capture and release the recorder. */
  stop(): Promise<void>;
  addListener(event: 'onAudioChunk', listener: (e: AudioChunkEvent) => void): { remove(): void };
}

let cached: ParlezAudioStreamModule | null = null;

/**
 * Lazily resolve the native module. Returns null until it registers (iOS, Expo
 * Go, web — or transiently during early app init), so callers degrade to the
 * device recognizer. Never caches a null result, so a probe that runs before the
 * native registry is ready doesn't permanently disable streaming.
 */
export function getAudioStreamModule(): ParlezAudioStreamModule | null {
  if (cached) return cached;
  cached =
    (requireOptionalNativeModule('ParlezAudioStream') as ParlezAudioStreamModule | null) ?? null;
  return cached;
}

export default getAudioStreamModule;
