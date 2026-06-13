import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * Native PCM mic-streaming module (Parlez Tier-2 live STT).
 *
 * Emits raw microphone audio as base64-encoded PCM16 / 16 kHz / mono chunks
 * (~100 ms each) via the `onAudioChunk` event, so the JS layer can relay them to
 * a streaming STT WebSocket.
 *
 * Android-only (declared in expo-module.config.json) — no native code is compiled
 * on iOS. `requireOptionalNativeModule` returns null wherever the module isn't
 * present (iOS, Expo Go, web), matching the recognizer's lazy-probe pattern, so
 * the app degrades to the device recognizer instead of throwing at import time.
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

const audioStream =
  requireOptionalNativeModule('ParlezAudioStream') as ParlezAudioStreamModule | null;

export default audioStream;
