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

export class MariePlayer {
  private player: AudioPlayer | null = null;
  private sub: { remove: () => void } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private settle: (() => void) | null = null;

  /** True while Marie's audio (real or simulated) is playing. */
  get isPlaying(): boolean {
    return this.settle != null;
  }

  /** Play Marie's speech; resolves when it finishes or is interrupted. */
  play(speech: SynthesizedSpeech, speed: SpeechSpeed): Promise<void> {
    this.stopInternal(true);
    return new Promise<void>((resolve) => {
      this.settle = resolve;

      if (!speech.uri) {
        this.timer = setTimeout(() => this.finish(), speech.durationMs);
        return;
      }

      const source = speech.headers
        ? { uri: speech.uri, headers: speech.headers }
        : speech.uri;
      const player = createAudioPlayer(source, { updateInterval: 150 });
      this.player = player;
      player.shouldCorrectPitch = true;
      this.sub = player.addListener('playbackStatusUpdate', (status) => {
        if (status.isLoaded) {
          try {
            player.setPlaybackRate(SPEECH_SPEEDS[speed], 'high');
          } catch {
            // Rate may be rejected before full load; harmless to skip.
          }
        }
        if (status.didJustFinish) this.finish();
      });
      // Safety net: a stalled or errored stream (network drop, ElevenLabs 502
      // body, unsupported chunk) never fires `didJustFinish`, which would hang
      // the turn engine in `marie_speaking` with a dead mic. Finish anyway after
      // a ceiling well above any real line (estimate caps at 9s) so legitimate
      // speech is never cut off.
      this.timer = setTimeout(
        () => this.finish(),
        Math.max(speech.durationMs * 2, 20000),
      );
      player.play();
    });
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
    const settle = this.settle;
    this.settle = null;
    if (settle && resolvePending) settle();
  }
}
