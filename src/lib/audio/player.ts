/**
 * Marie's voice playback (spec §6.2). Wraps expo-audio's imperative player so
 * the turn engine can simply `await play()` and the promise settles when Marie
 * finishes — or immediately when the user interrupts her.
 *
 * When a SynthesizedSpeech has no real audio (the mock service), playback is a
 * timed simulation of the same duration so the waveform animates believably.
 */
import { createAudioPlayer, type AudioPlayer } from 'expo-audio';

import { SPEECH_SPEEDS, type SpeechSpeed } from '@/lib/constants';
import type { SynthesizedSpeech } from '@/lib/services';

/**
 * Finish playback if the stream stops making progress for this long. Re-armed on
 * every advancing status update, so genuinely long speech (which keeps
 * progressing) is never cut — only a stalled/dead stream trips it.
 */
const STALL_MS = 10000;

/**
 * Absolute ceiling on a single line, in case status updates never arrive at all
 * (no `didJustFinish`, no progress events). Well above any real utterance.
 */
const HARD_CAP_MS = 180000;

export class MariePlayer {
  private player: AudioPlayer | null = null;
  private sub: { remove: () => void } | null = null;
  /** Re-armed stall watchdog (no playback progress for STALL_MS → finish). */
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Absolute backstop, set once per play() call. */
  private hardTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last observed playback position (seconds), to detect real progress. */
  private lastTime = 0;
  private settle: (() => void) | null = null;
  /** Fired once, the moment audio actually begins (real progress or sim start). */
  private onStart: (() => void) | null = null;
  private started = false;

  /** True while Marie's audio (real or simulated) is playing. */
  get isPlaying(): boolean {
    return this.settle != null;
  }

  /**
   * Play Marie's speech; resolves when it finishes or is interrupted.
   *
   * `onStart` fires exactly once when audio truly begins — for a streamed line
   * that's the first frame that actually advances (so the caller can reveal the
   * text bubble in sync with the voice, not seconds ahead while the stream
   * buffers); for the simulated/mock line it fires immediately.
   */
  play(speech: SynthesizedSpeech, speed: SpeechSpeed, onStart?: () => void): Promise<void> {
    this.stopInternal(true);
    return new Promise<void>((resolve) => {
      this.settle = resolve;
      this.lastTime = 0;
      this.started = false;
      this.onStart = onStart ?? null;

      if (!speech.uri) {
        this.fireStart();
        this.timer = setTimeout(() => this.finish(), speech.durationMs);
        return;
      }

      const source = speech.headers
        ? { uri: speech.uri, headers: speech.headers }
        : speech.uri;
      const player = createAudioPlayer(source, { updateInterval: 150 });
      this.player = player;
      player.shouldCorrectPitch = true;
      // Marie must come out at full media volume — a prior recording session can
      // leave the player attenuated on some Android devices.
      try {
        player.volume = 1;
      } catch {
        // Volume may be rejected before load; the default is already 1.
      }
      this.sub = player.addListener('playbackStatusUpdate', (status) => {
        if (status.isLoaded) {
          try {
            player.setPlaybackRate(SPEECH_SPEEDS[speed], 'high');
          } catch {
            // Rate may be rejected before full load; harmless to skip.
          }
        }
        // Re-arm the stall watchdog whenever playback actually advances. Long
        // lines keep progressing (~150 ms cadence) so they're never cut; only a
        // stalled/dead stream (network drop, ElevenLabs 502 body, unsupported
        // chunk) stops advancing and trips the timer — which previously hung the
        // turn engine in `marie_speaking` with a dead mic. The old fixed 20 s
        // ceiling cut off any reply longer than ~20 s of audio mid-sentence.
        const t = typeof status.currentTime === 'number' ? status.currentTime : 0;
        if (t > this.lastTime + 0.05) {
          this.lastTime = t;
          // First real frame of audio — the voice is now actually sounding, so
          // this is the moment to reveal the text in sync with it.
          this.fireStart();
          this.armStall();
        }
        if (status.didJustFinish) this.finish();
      });
      // Initial watchdog (covers a stream that never starts) + absolute backstop
      // (covers status updates that never arrive at all).
      this.armStall();
      this.hardTimer = setTimeout(() => this.finish(), HARD_CAP_MS);
      player.play();
    });
  }

  /** Fire the one-shot start callback (idempotent within a play() call). */
  private fireStart(): void {
    if (this.started) return;
    this.started = true;
    const cb = this.onStart;
    this.onStart = null;
    if (cb) cb();
  }

  /** (Re)start the no-progress stall watchdog. */
  private armStall(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.finish(), STALL_MS);
  }

  /** Stop Marie immediately — used when the user taps to interrupt (spec §6.2). */
  interrupt(): void {
    this.stopInternal(true);
  }

  /** Release all audio resources. */
  release(): void {
    this.stopInternal(true);
  }

  private finish(): void {
    this.stopInternal(true);
  }

  private stopInternal(resolvePending: boolean): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.hardTimer) {
      clearTimeout(this.hardTimer);
      this.hardTimer = null;
    }
    if (this.sub) {
      this.sub.remove();
      this.sub = null;
    }
    if (this.player) {
      try {
        this.player.pause();
        this.player.remove();
      } catch {
        // Player may already be released.
      }
      this.player = null;
    }
    // Drop a never-fired start callback so a stalled/interrupted line can't
    // reveal its bubble after the fact.
    this.onStart = null;
    const settle = this.settle;
    this.settle = null;
    if (settle && resolvePending) settle();
  }
}
