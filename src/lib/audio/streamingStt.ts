/**
 * Streaming STT orchestrator (Tier 2) — live, code-switch-accurate captions.
 *
 * Owns one realtime transcription session: mints a single-use token from the
 * `stt-token` edge fn, opens a WebSocket to ElevenLabs Scribe v2 Realtime, starts
 * the native PCM capture module, relays each base64 audio chunk to the socket,
 * and surfaces partial transcripts + amplitude back to the turn engine. On stop
 * it commits, waits briefly for the final committed transcript, and returns it as
 * the authoritative text (no audio upload, no server STT round-trip).
 *
 * Android-only for now (the native capture module isn't compiled on iOS); offline
 * / iOS / any failure here makes `isStreamingSttAvailable()` false or `start`
 * reject, so the turn engine falls back to the device speech recognizer.
 */
import { Platform } from 'react-native';

import getAudioStreamModule from '../../../modules/parlez-audio-stream';
import { functionsBase } from '@/lib/env';
import { getCallerId } from '@/lib/revenuecat';
import { authHeaders } from '@/lib/services/supabaseService';

/** Realtime model id — override via env; default verified against the dashboard. */
const REALTIME_MODEL =
  process.env.EXPO_PUBLIC_ELEVENLABS_REALTIME_STT_MODEL ?? 'scribe_v2_realtime';

/** ElevenLabs realtime STT WebSocket (production server). */
const WS_BASE = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';

/** RMS above which a chunk counts as the user speaking (0..1 scale). */
const VOICE_RMS_FLOOR = 0.03;

export interface StreamingHandlers {
  /** Latest interim transcript — drives the live caption + growth heuristic. */
  onPartial: (text: string) => void;
  /** Raw 0..1 RMS amplitude per chunk — the engine scales it + detects voice. */
  onAmplitude: (rms: number) => void;
  /** Non-fatal runtime error (logged; the turn still finishes on what we have). */
  onError?: (err: Error) => void;
}

export interface StreamingResult {
  /** Final transcript (committed, or the last partial if commit didn't land). */
  text: string;
  /** Measured capture duration in ms — billed + capped server-side as user speech. */
  durationMs: number;
}

let ws: WebSocket | null = null;
let wsReady = false;
/** In-flight pre-warm (token + socket), so startStreaming can await it. */
let preparing: Promise<void> | null = null;
let chunkSub: { remove(): void } | null = null;
let startedAt = 0;
let committedText = '';
let lastPartial = '';
let committedResolve: ((text: string) => void) | null = null;

/** True when the native capture module is present AND we're on Android. */
export function isStreamingSttAvailable(): boolean {
  return Platform.OS === 'android' && getAudioStreamModule() != null;
}

function waitForOpen(socket: WebSocket, timeoutMs = 6000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws open timeout')), timeoutMs);
    socket.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.onerror = (e: unknown) => {
      clearTimeout(timer);
      const msg = (e as { message?: string })?.message ?? 'ws error';
      reject(new Error(msg));
    };
  });
}

function closeWs(): void {
  if (ws) {
    try {
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      ws.close();
    } catch {
      // already closing
    }
  }
  ws = null;
  wsReady = false;
}

/**
 * Open the realtime socket (mint token + connect), WITHOUT attaching transcript
 * handlers or starting capture. The slow part (HTTP token mint + WS handshake,
 * ~1–3s) — split out so it can be pre-warmed during Camille's speech so the mic
 * starts instantly when the user's turn begins.
 */
async function openSocket(): Promise<void> {
  const appUserId = await getCallerId();
  const qs = appUserId ? `?app_user_id=${encodeURIComponent(appUserId)}` : '';
  const tokenRes = await fetch(`${functionsBase()}/stt-token${qs}`, {
    method: 'GET',
    headers: await authHeaders(),
  });
  if (!tokenRes.ok) {
    throw new Error(`stt-token ${tokenRes.status}: ${(await tokenRes.text()).slice(0, 120)}`);
  }
  const { token } = (await tokenRes.json()) as { token?: string };
  if (!token) throw new Error('stt-token returned no token');

  // commit_strategy=manual so OUR turn-end logic drives the commit; no
  // language_code → automatic multilingual EN/FR code-switch detection.
  const url =
    `${WS_BASE}?model_id=${encodeURIComponent(REALTIME_MODEL)}` +
    `&audio_format=pcm_16000&commit_strategy=manual` +
    `&token=${encodeURIComponent(token)}`;
  const socket = new WebSocket(url);
  ws = socket;
  await waitForOpen(socket);
  wsReady = true;
}

/**
 * Pre-warm the socket so the next listen starts capturing immediately. Safe to
 * call repeatedly and fire-and-forget; no-op if a socket is already open or
 * opening. Call this while Camille is speaking to hide the handshake latency.
 */
export function prepareStreaming(): void {
  if (!isStreamingSttAvailable()) return;
  if (preparing || (ws && wsReady)) return;
  preparing = openSocket()
    .catch(() => {
      // Pre-warm failed — leave it; startStreaming will open on demand (or fall back).
      closeWs();
    })
    .finally(() => {
      preparing = null;
    });
}

/**
 * Begin a streaming session. Resolves once audio is flowing; rejects on token,
 * socket, or capture failure so the caller can fall back to the device recognizer.
 */
export async function startStreaming(handlers: StreamingHandlers): Promise<void> {
  const audioStream = getAudioStreamModule();
  if (!audioStream) {
    throw new Error('native audio module unavailable');
  }

  try {
    // Reuse a pre-warmed socket if one is open (or finishing opening); otherwise
    // open on demand. This is where the per-turn handshake latency is hidden when
    // prepareStreaming() ran during Camille's speech.
    if (preparing) {
      await preparing;
    }
    if (!ws || !wsReady || ws.readyState !== 1 /* OPEN */) {
      closeWs();
      await openSocket();
    }
    const socket = ws;
    if (!socket) throw new Error('socket unavailable');

    committedText = '';
    lastPartial = '';
    committedResolve = null;

    socket.onmessage = (ev: { data: string }) => {
    let msg: { message_type?: string; text?: string; error?: string };
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    switch (msg.message_type) {
      case 'partial_transcript':
        lastPartial = msg.text ?? lastPartial;
        handlers.onPartial(lastPartial);
        break;
      case 'committed_transcript':
      case 'committed_transcript_with_timestamps':
        // We commit once at turn end (manual strategy), so this is the single
        // final. Replace (not append) so a duplicate variant can't double-count.
        committedText = (msg.text ?? '').trim() || committedText;
        if (committedResolve) {
          committedResolve(committedText);
          committedResolve = null;
        }
        break;
      case 'session_started':
        break;
      default:
        if (msg.error) handlers.onError?.(new Error(msg.error));
    }
  };
  socket.onerror = (e: unknown) => {
    handlers.onError?.(new Error((e as { message?: string })?.message ?? 'ws error'));
  };

  // 3. Start native capture; relay PCM chunks + amplitude.
  startedAt = Date.now();
  chunkSub = audioStream.addListener('onAudioChunk', (e) => {
    handlers.onAmplitude(e.rms);
    if (ws && ws.readyState === 1 /* OPEN */) {
      try {
        ws.send(
          JSON.stringify({
            message_type: 'input_audio_chunk',
            audio_base_64: e.base64,
            sample_rate: 16000,
          }),
        );
      } catch {
        // socket closing mid-send — ignore; stop() handles teardown
      }
    }
  });
    await audioStream.start();
  } catch (e) {
    // Failed partway (token / socket / capture) — tear down before rethrowing so
    // the caller's fallback doesn't inherit a half-open socket or live recorder.
    abortStreaming();
    throw e;
  }
}

/**
 * Stop capture, commit, and resolve the final transcript. Always tears down the
 * socket + recorder, even on error.
 */
export async function stopStreaming(): Promise<StreamingResult> {
  const durationMs = startedAt ? Date.now() - startedAt : 0;
  startedAt = 0;

  try {
    await getAudioStreamModule()?.stop();
  } catch {
    // ignore
  }
  chunkSub?.remove();
  chunkSub = null;

  let text = committedText || lastPartial;
  if (ws && ws.readyState === 1 /* OPEN */) {
    const committed = new Promise<string>((resolve) => {
      committedResolve = resolve;
      setTimeout(() => {
        if (committedResolve) {
          committedResolve(committedText || lastPartial);
          committedResolve = null;
        }
      }, 1500);
    });
    try {
      ws.send(
        JSON.stringify({
          message_type: 'input_audio_chunk',
          audio_base_64: '',
          sample_rate: 16000,
          commit: true,
        }),
      );
    } catch {
      // ignore
    }
    text = await committed;
  }

  closeWs();
  return { text: (text || '').trim(), durationMs };
}

/** Abort immediately with no final result — cancel / cleanup / barge paths. */
export function abortStreaming(): void {
  startedAt = 0;
  committedResolve = null;
  try {
    void getAudioStreamModule()?.stop();
  } catch {
    // ignore
  }
  chunkSub?.remove();
  chunkSub = null;
  closeWs();
}

export { VOICE_RMS_FLOOR };
