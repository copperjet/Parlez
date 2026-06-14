/**
 * The turn engine — the rhythm of the whole app (spec §3.3, §6.3).
 *
 * Drives one conversational turn through its phases:
 *   marie_speaking -> grace -> listening -> recording -> processing -> ...
 *
 * Owns Marie's player, the speech-recognition session, and every timer (grace
 * pause, silence prompts, silence-stop). It depends only on the
 * ConversationService interface, so it works identically against the mock and
 * the real Supabase service.
 *
 * The user's turn is captured by the device speech recognizer: interim results
 * drive the live transcript, and a persisted audio file is uploaded to Whisper
 * for accurate transcription when online (the device transcript is used offline).
 */
import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';

import { MariePlayer } from '@/lib/audio/player';
import { configureAudioSession, isAudibleVoice, volumeToAmplitude } from '@/lib/audio/recorder';
import {
  abortRecognition,
  getRecognitionPermissions,
  isRecognitionAvailable,
  startRecognition,
  stopRecognition,
  subscribeRecognition,
} from '@/lib/audio/recognizer';
import {
  abortStreaming,
  isStreamingSttAvailable,
  prepareStreaming,
  startStreaming,
  stopStreaming,
  VOICE_RMS_FLOOR,
} from '@/lib/audio/streamingStt';
import {
  addProfileNotes,
  buildProfileSummary,
  countProfileNotes,
  getAllNotesForConsolidation,
  replaceNotes,
} from '@/lib/db/profile';
import {
  addDailyActivity,
  saveLevel,
  saveMessage,
  saveProfileSummary,
  saveStructuredProfile,
  saveTurnsSinceConsolidation,
} from '@/lib/db/sessions';
import { refreshStreakFromHistory, todayLocal } from '@/lib/streak';
import { consolidateProfile } from '@/lib/services';
import { router } from 'expo-router';

import { DailyCapError, NotEntitledError } from '@/lib/services/supabaseService';
import {
  GRACE_MS,
  maxCorrectionsForLevel,
  MAX_LISTEN_MS,
  MIC_OFF_NOTICE,
  MIN_SPEECH_MS,
  SILENCE_CONTINUE_MS,
  SILENCE_PROMPT_MS,
  SILENCE_STOP_MS,
  SILENCE_STOP_UNFINISHED_MS,
  TRANSCRIPT_STALE_STOP_MS,
  USER_REPLY_BEAT_MS,
  voiceName,
} from '@/lib/constants';
import type { SynthesizedSpeech } from '@/lib/services';
import { useAppStore } from '@/stores/appStore';
import { useSubscriptionStore } from '@/stores/subscriptionStore';
import type { Message, TurnContext, TurnResponse } from '@/lib/types';

const POLL_MS = 150;
/** Safety net: if `end` never arrives after a stop, finish the turn anyway. */
const END_FALLBACK_MS = 2500;
const FALLBACK_SPEECH: SynthesizedSpeech = { uri: null, durationMs: 2500 };

/** Marie's spoken apology when the AI/network fails (spec §10.2). */
const AI_ERROR_SPEECH =
  'Oh, j’ai un petit problème technique. Un instant, et on reprend.';

/** Marie's spoken re-prompt when speech-to-text caught nothing (spec §10.2). */
const STT_MISS_SPEECH =
  'Je n’ai pas bien entendu. Tu peux répéter, s’il te plaît ?';

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Conversation-time estimate from a character count (~14 chars/sec, French).
 * Mirrors the server's `estimateSpeechMs` so the local soft-cap counter and the
 * server's authoritative `elapsed_ms` measure the same thing — otherwise the
 * client would block earlier (or later) than the server actually caps.
 */
const estimateSpeechMs = (chars: number) => Math.max(0, Math.round((chars / 14) * 1000));

export interface TurnEngine {
  /** 0..1 live mic amplitude, for the recording waveform. */
  micLevel: number;
  /** Tap handler for the mic button — meaning depends on the current phase. */
  onMicPress: () => void;
  /** Submit a typed turn — the accessibility / noisy-environment fallback (spec §4.4). */
  submitText: (text: string) => void;
  /**
   * True when the native speech recognizer is absent (Expo Go, web). The screen
   * then drives a typed-text conversation instead of a dead listening loop.
   */
  sttUnavailable: boolean;
  /** Re-synthesize and play a past partner message on demand (per-bubble replay). */
  replay: (text: string) => void;
}

/**
 * Map a recognizer failure to user-facing banner copy. The code comes from the
 * `error` event (W3C SpeechRecognition error codes); we only special-case the
 * ones a learner can act on, and otherwise keep the gentle "didn't hear" copy.
 */
/**
 * Words that signal the learner is mid-thought — give them the longer silence
 * window rather than cutting the turn. French + English (code-switching is
 * normal for learners), plus hesitation fillers.
 */
const CONTINUATION_CUES = new Set([
  'et', 'mais', 'ou', 'donc', 'alors', 'puis', 'que', 'de', 'à', 'parce',
  'euh', 'um', 'uh', 'and', 'but', 'so', 'or', 'because',
]);

/**
 * Heuristic: does the live transcript look like an unfinished sentence?
 * Trailing comma, conjunction, or filler → wait longer before auto-stopping.
 * Interim transcripts rarely carry final punctuation, so the default stays the
 * short window; this only extends genuinely dangling speech.
 */
export function looksUnfinished(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (t.endsWith(',')) return true;
  if (/[.!?…]$/.test(t)) return false;
  const lastWord = t.split(/\s+/).pop()?.replace(/[«»"'’,;:]/g, '') ?? '';
  return CONTINUATION_CUES.has(lastWord);
}

/**
 * Canonical form for comparing recognizer transcripts. Android's continuous
 * recognizer re-emits the same speech with drifting punctuation and casing
 * ("salut" / "Salut !" / "Salut."), which defeats exact-string dedup and makes
 * the transcript look like it keeps growing — postponing the silence auto-stop
 * all the way to the MAX_LISTEN_MS backstop. Compare normalized; display raw.
 */
function normalizeTranscript(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,!?…:;«»"'’\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when `transcript` is plausibly an echo of Camille’s last message —
 * i.e. the mic captured TTS speaker output rather than the user speaking.
 * Only fires when the transcript is substantial (≥20 chars) and is either
 * an exact normalized match or a long-enough substring of the reference.
 * Short user responses ("la musique", "oui") are never flagged, preventing
 * false positives when the user’s answer happens to use Camille’s words.
 */
function isEchoOf(transcript: string, reference: string): boolean {
  const t = normalizeTranscript(transcript);
  const r = normalizeTranscript(reference);
  if (!t || !r || t.length < 20) return false;
  if (t === r) return true;
  // Partial capture: mic caught a long segment of Camille’s TTS
  if (r.includes(t) && t.length >= Math.max(20, r.length * 0.5)) return true;
  return false;
}

function micFailureNotice(code: string | null, online: boolean): string {
  if (code === 'not-allowed' || code === 'service-not-allowed') {
    return MIC_OFF_NOTICE;
  }
  if (code === 'network' && !online) {
    return 'You’re offline — voice needs a connection. Tap to retry.';
  }
  return 'Couldn’t hear the mic — tap to try again.';
}

export function useTurnEngine(online: boolean): TurnEngine {
  const playerRef = useRef<MariePlayer | null>(null);
  if (playerRef.current == null) playerRef.current = new MariePlayer();

  const onlineRef = useRef(online);
  onlineRef.current = online;

  const [micLevel, setMicLevel] = useState(0);
  const onMicPressRef = useRef<() => void>(() => {});
  const submitTextRef = useRef<(text: string) => void>(() => {});
  const replayRef = useRef<(text: string) => void>(() => {});

  useEffect(() => {
    let alive = true;
    const player = playerRef.current!;

    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let endFallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;

    // Per-listen state.
    let awaitingEnd = false;
    let manualStop = false;
    let speechStartAt: number | null = null;
    /** Wall-clock when the current listen began — drives the max-listen backstop. */
    let listenStartedAt = 0;
    let lastVoiceAt = 0;
    let silenceRound = 0;
    let latestTranscript = '';
    /** Wall-clock of the last genuine transcript growth — drives the stale-transcript auto-send. */
    let lastGrowthAt = 0;
    /**
     * Finalized segments accumulated across pauses. Android's continuous
     * recognizer finalizes a segment after each pause and starts the next one
     * empty — without this buffer, "Bonjour" would be erased by "ça va ?".
     * On iOS the interim transcript is cumulative and a single final arrives at
     * stop, so this stays empty until the end (same behaviour as before).
     */
    let committedTranscript = '';
    let recognitionUri: string | null = null;
    /** This listen is using the streaming STT path (vs the device recognizer). */
    let streaming = false;
    /**
     * Live chat toggle (spec §6.3, tap-to-toggle model). The mic is OFF by
     * default: Camille greets, then waits. Tapping turns live mode on and starts
     * the listen→record→send→reply loop; tapping again turns it off (mic idle).
     * Only while this is true does a finished turn auto-continue listening.
     */
    let liveMode = false;
    /** Set when the user barges in during Camille's speech — resume into listening, not grace. */
    let interruptedDuringSpeak = false;
    /** Consecutive empty recognizer ends — guards against an Android error storm. */
    let emptyEndStreak = 0;
    /** Last recognizer `error` code this listen — drives the runaway banner copy. */
    let lastRecognizerError: string | null = null;

    const store = () => useAppStore.getState();
    const phase = () => store().turnState;
    const listening = () => phase() === 'listening' || phase() === 'recording';

    const buildContext = (): TurnContext => {
      const s = store();
      return {
        level: s.level,
        profileSummary: s.profileSummary,
        // Prior-session transcript feeds the AI but is never shown (spec §3.2).
        history: [...s.priorHistory, ...s.messages],
        gapSinceLastSession: s.gapSinceLastSession,
        personaName: voiceName(s.settings.voice),
        learnerName: s.learnerName ?? null,
        interests: s.interests,
        streakDays: s.streakCount,
      };
    };

    /** Consolidation thresholds — bounded LLM calls (~3 per 100 turns max). */
    const CONSOLIDATION_TURN_THRESHOLD = 20;
    const CONSOLIDATION_MIN_ROWS = 30;
    let consolidationInFlight = false;

    /** Fire-and-forget LLM merge of similar notes. Never blocks the turn. */
    const maybeConsolidate = () => {
      if (consolidationInFlight) return;
      if (store().turnsSinceConsolidation < CONSOLIDATION_TURN_THRESHOLD) return;
      consolidationInFlight = true;
      void (async () => {
        try {
          const rows = await countProfileNotes();
          if (rows < CONSOLIDATION_MIN_ROWS) return;
          const notes = await getAllNotesForConsolidation();
          const canonical = await consolidateProfile(
            notes,
            store().profileSummary,
          );
          // null = transport failure → keep the counter so we retry naturally.
          // Empty array = the LLM legitimately considers nothing worth keeping
          // (or trivial); that's a successful call and we reset to avoid an
          // every-turn re-trigger loop.
          if (!alive || canonical == null) return;
          if (canonical.length > 0) {
            await replaceNotes(canonical);
            const summary = await buildProfileSummary();
            if (!alive) return;
            store().setProfileSummary(summary);
            void saveProfileSummary(summary);
          }
          store().setTurnsSinceConsolidation(0);
          void saveTurnsSinceConsolidation(0);
        } catch {
          // Best-effort — counter stays, retries naturally next eligible turn.
        } finally {
          consolidationInFlight = false;
        }
      })();
    };

    /** Merge this turn's AI observations into the learning profile (spec §5.4). */
    const persistProfile = async (
      notes: string[],
      learnerName: string | null | undefined,
      interests: string[] | undefined,
    ) => {
      const s = store();
      if (learnerName !== undefined) {
        const next = learnerName ? learnerName.trim() : null;
        if (next !== s.learnerName) {
          s.setStructuredProfile({ learnerName: next });
          void saveStructuredProfile({ learnerName: next });
        }
      }
      if (interests && interests.length > 0) {
        const merged = Array.from(
          new Set([...s.interests, ...interests.map((x) => x.trim()).filter(Boolean)]),
        ).slice(0, 8);
        if (merged.length !== s.interests.length) {
          s.setStructuredProfile({ interests: merged });
          void saveStructuredProfile({ interests: merged });
        }
      }
      if (notes.length === 0) return;
      await addProfileNotes(notes);
      const summary = await buildProfileSummary();
      if (!alive) return;
      store().setProfileSummary(summary);
      void saveProfileSummary(summary);
      const next = store().turnsSinceConsolidation + 1;
      store().setTurnsSinceConsolidation(next);
      void saveTurnsSinceConsolidation(next);
      maybeConsolidate();
    };

    const haptic = (style: 'light' | 'medium') => {
      if (Platform.OS === 'web' || !store().settings.haptics) return;
      const map = {
        light: Haptics.ImpactFeedbackStyle.Light,
        medium: Haptics.ImpactFeedbackStyle.Medium,
      };
      Haptics.impactAsync(map[style]).catch(() => {});
    };

    const clearSilenceTimer = () => {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = null;
    };
    const clearEndFallback = () => {
      if (endFallbackTimer) clearTimeout(endFallbackTimer);
      endFallbackTimer = null;
    };
    const stopPoll = () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    };
    const clearGraceTimer = () => {
      if (graceTimer) clearTimeout(graceTimer);
      graceTimer = null;
    };

    /** Leave live mode: silence the mic, drop every timer, return to idle. */
    const turnOff = () => {
      liveMode = false;
      awaitingEnd = false;
      stopPoll();
      clearSilenceTimer();
      clearEndFallback();
      clearGraceTimer();
      abortRecognition();
      abortStreaming();
      setMicLevel(0);
      store().setLiveTranscript('');
      store().setTurnState('idle');
    };

    const enterGrace = () => {
      if (!alive) return;
      store().setTurnState('grace');
      graceTimer = setTimeout(() => {
        if (alive) void startListening();
      }, GRACE_MS);
    };

    const speak = async (response: TurnResponse) => {
      if (!alive) return;
      const s = store();
      s.setTurnState('processing');

      // Never render an empty Camille bubble. An empty speechText means the model
      // returned nothing usable — most often a soft STT miss where a device
      // transcript was present, so the earlier miss-guard didn't fire. Fall back to
      // the gentle spoken re-prompt (and drop translation/segments, which would
      // describe content that no longer exists).
      const hasSpeech = response.speechText.trim().length > 0;
      const speechText = hasSpeech ? response.speechText : STT_MISS_SPEECH;

      // Show the reply the moment it arrives — don't make the user wait on TTS
      // synthesis before they can read it. We commit the bubble and flip to
      // 'marie_speaking' first, then synthesize and play the audio under it. This
      // shaves the synth round-trip off the *perceived* response time.
      const marieMsg = s.addMessage({
        speaker: 'marie',
        text: speechText,
        translation: hasSpeech ? response.translation : undefined,
        segments: hasSpeech ? response.segments : undefined,
        corrections: hasSpeech
          ? response.corrections.slice(0, maxCorrectionsForLevel(s.level))
          : [],
      });
      s.applyLevelSignal(response.levelSignal);
      void saveMessage(marieMsg);
      void saveLevel(store().level);
      void persistProfile(
        response.profileNotes,
        response.learnerName,
        response.interests,
      );

      s.setTurnState('marie_speaking');
      interruptedDuringSpeak = false;

      // Pre-warm the streaming socket now, while Camille speaks. Minting the token
      // + opening the WebSocket takes ~1–3s; doing it here (in parallel with TTS
      // synth + playback) means the mic starts capturing instantly when the user's
      // turn begins, instead of stalling at the start of the listen. Fire-and-forget
      // and self-guarded (no-op offline / iOS / already open).
      if (onlineRef.current) prepareStreaming();

      let speech: SynthesizedSpeech;
      try {
        speech = await s.service.synthesize(
          speechText,
          s.settings.voice,
          s.settings.speechSpeed,
        );
      } catch {
        speech = FALLBACK_SPEECH;
      }
      if (!alive) return;
      // The user can barge in while the audio is still synthesizing (the bubble is
      // already on screen and the mic is live in 'marie_speaking'). If they did,
      // skip playback and start listening instead of speaking over them.
      if (interruptedDuringSpeak) {
        interruptedDuringSpeak = false;
        void startListening();
        return;
      }
      await player.play(speech, store().settings.speechSpeed);
      if (!alive) return;
      // Barge-in: the user tapped to interrupt — resume listening immediately,
      // skipping the grace pause.
      if (interruptedDuringSpeak) {
        interruptedDuringSpeak = false;
        void startListening();
        return;
      }
      // Otherwise only keep the conversation going while live mode is on; with it
      // off, Camille has spoken her piece and we wait for the next tap.
      if (liveMode) {
        enterGrace();
      } else {
        store().setTurnState('idle');
      }
    };

    /** The user stayed silent — Marie gives a gentle nudge (spec §6.3). */
    const onSilence = async () => {
      if (!alive || !listening()) return;
      // After two unanswered nudges (gentle, then simpler) the user is clearly
      // away. Rather than keep a hot mic open and re-prompt forever, pause the
      // conversation back to idle and invite them to tap when they're ready.
      // silenceRound only climbs across *consecutive* silent rounds —
      // markVoice() resets it the moment the user speaks.
      if (silenceRound >= 2) {
        turnOff();
        store().setErrorNotice('Paused. Tap the mic whenever you’re ready to keep going.');
        return;
      }
      const simpler = silenceRound >= 1;
      silenceRound += 1;
      awaitingEnd = false;
      stopPoll();
      clearSilenceTimer();
      clearEndFallback();
      abortRecognition();
      abortStreaming();
      setMicLevel(0);
      store().setLiveTranscript('');
      let response: TurnResponse;
      try {
        response = await store().service.promptSilence(simpler, buildContext());
      } catch {
        if (alive) enterGrace();
        return;
      }
      if (!alive) return;
      await speak(response);
    };

    const runUserTurn = async (input: {
      audioUri?: string | null;
      text?: string | null;
      sttMs?: number | null;
    }) => {
      if (!alive) return;
      haptic('medium');
      store().setErrorNotice(null);
      store().setTurnState('processing');

      // Phase 2 monetization — soft cap (client side, UX). The server is the
      // source of truth (402 → DailyCapError below); this pre-empts the round-
      // trip when we already know we're over.
      const sub = useSubscriptionStore.getState();
      sub.resetDailyIfNewDay();
      const subNow = useSubscriptionStore.getState();
      if (
        subNow.tier &&
        subNow.tier !== 'lifetime' &&
        subNow.tierCapSeconds != null &&
        subNow.usageTodaySeconds >= subNow.tierCapSeconds
      ) {
        subNow.setCapBlocked({
          tier: subNow.tier,
          capSeconds: subNow.tierCapSeconds,
        });
        store().setTurnState('idle');
        return;
      }

      // Optimistic echo: show the user's turn in the transcript immediately
      // (faint, like a messaging app) so it doesn't vanish during the STT/AI
      // round-trip. With state already 'processing', the ThinkingIndicator footer
      // shows directly beneath it.
      //
      // When Scribe will be authoritative (online + we have a recording), do NOT
      // echo the device transcript: it's the mangled fr-FR preview of English and
      // we'd flash it, then overwrite it with Scribe's accurate text — exactly the
      // "sent wrong, corrected later" jank. Show a neutral placeholder instead and
      // fill it with Scribe's transcript on reconcile below. Offline / typed turns
      // have no Scribe, so the device/typed text IS final and we echo it directly.
      const optimisticText = (input.text ?? '').trim();
      const scribeAuthoritative = onlineRef.current && !!input.audioUri;
      let optimisticMsg: Message | null = null;
      if (scribeAuthoritative || optimisticText) {
        optimisticMsg = store().addMessage({
          speaker: 'user',
          text: scribeAuthoritative ? '…' : optimisticText,
          pending: true,
        });
      }
      /** Un-faint the echoed bubble so it never stays stuck in the pending look. */
      const settleOptimistic = () => {
        if (optimisticMsg) store().updateMessage(optimisticMsg.id, { pending: false });
      };

      // One automatic retry after 3s on failure (spec §10.2).
      let response: TurnResponse | null = null;
      let capHit = false;
      let notEntitled = false;
      let lastTurnError: string | null = null;
      for (let attempt = 0; attempt < 2 && response == null && !capHit && !notEntitled; attempt += 1) {
        try {
          response = await store().service.sendTurn(
            {
              audioUri: input.audioUri ?? null,
              text: input.text ?? null,
              sttMs: input.sttMs ?? null,
            },
            buildContext(),
          );
        } catch (e) {
          if (e instanceof DailyCapError) {
            // Server overruled — never retry, never apologise.
            capHit = true;
            break;
          }
          if (e instanceof NotEntitledError) {
            // Server says the subscription is no longer valid. Don't retry.
            notEntitled = true;
            break;
          }
          // Keep the real cause (server error body / network message) so it can be
          // surfaced for diagnosis instead of vanishing behind the generic banner.
          lastTurnError = e instanceof Error ? e.message : String(e);
          if (__DEV__) console.warn('[turn]', lastTurnError);
          if (attempt === 0) await wait(3000);
        }
        if (!alive) return;
      }

      if (notEntitled) {
        // Re-pull RevenueCat truth (flips the gate live) and send the user to the
        // paywall rather than apologising for a server error.
        settleOptimistic();
        void useSubscriptionStore.getState().refresh();
        store().setTurnState('idle');
        router.replace('/paywall' as never);
        return;
      }

      if (capHit) {
        settleOptimistic();
        store().setTurnState('idle');
        return;
      }

      if (response == null) {
        // AI / network failure — Marie apologises in French, then we listen again.
        // Only blame the connection when we're genuinely offline; otherwise the
        // server (STT/AI/TTS provider) failed and a "check your connection"
        // message is misleading.
        store().setErrorNotice(
          onlineRef.current
            ? `${voiceName(store().settings.voice)} couldn’t respond just now. Please try again in a moment.`
            : 'You’re offline — reconnect and try again.',
        );
        // Keep the user's echoed turn on screen (don't drop their words) while
        // Camille apologises.
        settleOptimistic();
        await speak({
          transcript: '',
          speechText: AI_ERROR_SPEECH,
          corrections: [],
          profileNotes: [],
          levelSignal: 'hold',
        });
        return;
      }

      // STT miss: audio was sent but nothing was transcribed — Marie says so too (spec §10.2).
      // (Only reachable with no device transcript, so there's no optimistic echo to settle.)
      if (input.audioUri && !input.text && !response.transcript) {
        store().setErrorNotice('I didn’t catch that — try again?');
        await speak({
          transcript: '',
          speechText: STT_MISS_SPEECH,
          corrections: [],
          profileNotes: [],
          levelSignal: 'hold',
        });
        return;
      }

      // Echo guard: if the transcript matches Camille's last message, the mic
      // captured speaker output (barge-in or quick tap after TTS). Silently discard
      // the turn and re-listen rather than echoing her words back as user speech.
      // Applies to any VOICE turn — Scribe audio path (scribeAuthoritative) OR the
      // streaming path (sttMs present) — but never a typed turn.
      const voiceTurn = scribeAuthoritative || (input.sttMs != null && input.sttMs > 0);
      if (response.transcript && voiceTurn) {
        const msgs = store().messages;
        let lastMarieText = '';
        for (let i = msgs.length - 1; i >= 0; i -= 1) {
          if (msgs[i].speaker === 'marie') { lastMarieText = msgs[i].text; break; }
        }
        if (lastMarieText && isEchoOf(response.transcript, lastMarieText)) {
          if (optimisticMsg) store().removeMessage(optimisticMsg.id);
          if (liveMode) void startListening();
          else store().setTurnState('idle');
          return;
        }
      }

      // Reconcile the user's turn into the transcript. Prefer the server's
      // (Whisper) transcript; if it came back empty but we have a device
      // transcript, keep that rather than dropping the user's words.
      const finalUserText = response.transcript || optimisticText;
      if (finalUserText) {
        let userMsg: Message;
        if (optimisticMsg) {
          // Replace the optimistic echo in place — no new bubble, no flicker.
          store().updateMessage(optimisticMsg.id, { text: finalUserText, pending: false });
          userMsg = { ...optimisticMsg, text: finalUserText, pending: false };
        } else {
          // Audio-only turn (no device transcript) — add the bubble now.
          userMsg = store().addMessage({ speaker: 'user', text: finalUserText });
        }
        void saveMessage(userMsg);
        // Hold the user's words on screen for a beat (thinking dots beneath, since
        // we're still 'processing') before Camille's reply lands. The server returns
        // both in one round-trip, so without this they'd appear in the same frame.
        await wait(USER_REPLY_BEAT_MS);
        if (!alive) return;
      }

      // We heard the user — their words are already on screen — but the model
      // returned an empty reply. That's a model/parse hiccup, NOT an STT miss, so
      // never fall through to speak()'s "Je n'ai pas bien entendu, répète"
      // fallback: that tells the user we didn't catch a message we clearly
      // understood (the bug behind the duplicate re-prompts). Retry the turn once
      // with the transcript we already have; if it's still empty, apologise for
      // the technical glitch and re-listen.
      if (finalUserText && !response.speechText.trim()) {
        try {
          const retry = await store().service.sendTurn(
            { audioUri: null, text: finalUserText, sttMs: input.sttMs ?? null },
            buildContext(),
          );
          if (retry && retry.speechText.trim()) response = retry;
        } catch {
          // Keep the honest apology below.
        }
        if (!alive) return;
        if (!response.speechText.trim()) {
          store().setErrorNotice(null);
          await speak({
            transcript: response.transcript,
            speechText: AI_ERROR_SPEECH,
            corrections: [],
            profileNotes: [],
            levelSignal: 'hold',
          });
          return;
        }
      }

      await speak(response);
      // Attribute conversation time to the local rolling-day counter using the
      // same char-based estimate the server uses for elapsed_ms, so the soft cap
      // pre-empts at the same point the server would hard-cap (no early/late skew).
      const convoMs =
        estimateSpeechMs(response.transcript.length) +
        estimateSpeechMs(response.speechText.length);
      useSubscriptionStore.getState().recordTurnElapsed(convoMs);
      // Same time also feeds the daily-streak ledger: bank today's seconds, then
      // recompute the streak (a day counts once it crosses 10 min). Fire-and-forget.
      void addDailyActivity(todayLocal(), Math.round(convoMs / 1000)).then(() =>
        refreshStreakFromHistory(),
      );
    };

    /** Funnel for the end of a user turn — fired by the recognizer's `end` event. */
    const consumeRecognition = async () => {
      if (!alive || !awaitingEnd) return;
      awaitingEnd = false;
      stopPoll();
      clearSilenceTimer();
      clearEndFallback();
      setMicLevel(0);
      const text = latestTranscript.trim();
      // `audioend` (which sets recognitionUri to the persisted .wav) normally
      // precedes `end`, but the order isn't guaranteed on every Android stop
      // path. When we're online with a real turn to send, give the recorder a
      // brief moment to surface its file URI so the accurate Scribe transcript
      // isn't lost to a race and we silently fall back to the device text.
      if (onlineRef.current && text && !recognitionUri) {
        for (let i = 0; i < 6 && !recognitionUri && alive; i += 1) {
          await wait(50);
        }
      }
      const uri = recognitionUri;
      store().setLiveTranscript('');

      // Auto-ended with nothing heard. This is NOT user silence — the genuine
      // silence nudge is driven solely by the silence timer (onSilence). An empty
      // `end` here is the recognizer cycling (notably Android firing end+error
      // straight away), so we must NOT call the server, or it re-greets on every
      // empty turn ("Bonjour, je m'appelle Camille…" spam). Just listen again.
      if (!text && !manualStop) {
        emptyEndStreak += 1;
        // Runaway recognizer (mic busy / unavailable): stop looping, drop to idle
        // with one non-scary banner instead of a silent dead mic.
        if (emptyEndStreak >= 4) {
          emptyEndStreak = 0;
          store().setErrorNotice(micFailureNotice(lastRecognizerError, onlineRef.current));
          turnOff();
          return;
        }
        if (liveMode) void startListening();
        else store().setTurnState('idle');
        return;
      }
      emptyEndStreak = 0;
      lastRecognizerError = null;

      const isOnline = onlineRef.current;
      // Send the recorded audio to cloud Whisper as the PRIMARY transcript when
      // online — it's markedly more accurate than the device recognizer. We also
      // send the device transcript as `text`: the server prefers Whisper but
      // falls back to this when Whisper errors or the recording is unusable
      // (notably Android's system recognizer, which yields an empty file). Offline,
      // there's no Whisper, so the device transcript is all we have.
      await runUserTurn({
        audioUri: isOnline ? uri : null,
        text: text || null,
      });
    };

    /**
     * End-of-turn funnel for the streaming STT path. Mirrors consumeRecognition:
     * stop capture, commit, take the streamed final as the authoritative
     * transcript (no audio upload), and send it. An empty result with no manual
     * stop just re-listens, same as an empty recognizer end.
     */
    const consumeStreaming = async () => {
      if (!alive || !awaitingEnd) return;
      awaitingEnd = false;
      stopPoll();
      clearSilenceTimer();
      clearEndFallback();
      setMicLevel(0);

      let result: { text: string; durationMs: number };
      try {
        result = await stopStreaming();
      } catch {
        result = { text: latestTranscript.trim(), durationMs: 0 };
      }
      if (!alive) return;
      store().setLiveTranscript('');
      const text = (result.text || latestTranscript).trim();

      if (!text && !manualStop) {
        emptyEndStreak += 1;
        if (emptyEndStreak >= 4) {
          emptyEndStreak = 0;
          store().setErrorNotice(micFailureNotice(null, onlineRef.current));
          turnOff();
          return;
        }
        if (liveMode) void startListening();
        else store().setTurnState('idle');
        return;
      }
      emptyEndStreak = 0;

      // Streamed text is final + accurate (Scribe v2). No audioUri → no server STT
      // round-trip; pass the measured duration so the cap still counts user speech.
      await runUserTurn({
        audioUri: null,
        text: text || null,
        sttMs: result.durationMs,
      });
    };

    /** Stop capture; the matching consume funnel finishes the turn. */
    const requestFinish = (manual: boolean) => {
      if (!alive || !awaitingEnd) return;
      manualStop = manual;
      stopPoll();
      clearSilenceTimer();
      if (streaming) {
        // The streamed commit + final transcript are awaited directly in consume.
        void consumeStreaming();
        return;
      }
      stopRecognition();
      clearEndFallback();
      endFallbackTimer = setTimeout(() => void consumeRecognition(), END_FALLBACK_MS);
    };

    /** Mark voice activity from a volume reading or an interim result. */
    const markVoice = () => {
      lastVoiceAt = Date.now();
      if (speechStartAt == null) {
        speechStartAt = lastVoiceAt;
        silenceRound = 0;
        clearSilenceTimer();
        if (phase() === 'listening') {
          store().setTurnState('recording');
          haptic('light');
        }
      }
    };

    /** Auto-stop after enough silence once the user has actually spoken (spec §6.1). */
    const pollTick = () => {
      if (!alive || !listening() || speechStartAt == null) return;
      const now = Date.now();
      // Backstop: once the user has actually spoken, never let a single listen
      // run past MAX_LISTEN_MS. Guards against a recognizer that re-emits forever
      // and never goes silent (Android continuous mode), so the mic can't hang.
      if (now - listenStartedAt >= MAX_LISTEN_MS) {
        requestFinish(false);
        return;
      }
      // The volume meter can keep reading "voice" (background noise, handling,
      // speaker echo) long after the user stopped, pinning lastVoiceAt fresh and
      // pushing the send all the way to the MAX_LISTEN_MS backstop. Real speech
      // grows the transcript — so once words have stopped arriving for
      // TRANSCRIPT_STALE_STOP_MS, send what we have.
      if (
        latestTranscript &&
        lastGrowthAt > 0 &&
        now - lastGrowthAt >= TRANSCRIPT_STALE_STOP_MS
      ) {
        requestFinish(false);
        return;
      }
      const stopWindow = looksUnfinished(latestTranscript)
        ? SILENCE_STOP_UNFINISHED_MS
        : SILENCE_STOP_MS;
      if (now - speechStartAt >= MIN_SPEECH_MS && now - lastVoiceAt >= stopWindow) {
        requestFinish(false);
      }
    };

    const startListening = async () => {
      if (!alive) return;
      store().setTurnState('listening');
      store().setLiveTranscript('');
      speechStartAt = null;
      listenStartedAt = Date.now();
      lastVoiceAt = Date.now();
      latestTranscript = '';
      lastGrowthAt = 0;
      committedTranscript = '';
      recognitionUri = null;
      manualStop = false;
      lastRecognizerError = null;
      streaming = false;
      setMicLevel(0);
      haptic('light');

      // Tier 2: when online and the native streaming module is available, transcribe
      // live via ElevenLabs realtime (accurate EN/FR code-switch, no upload). On any
      // failure (token/socket/capture) fall through to the device recognizer so a
      // turn is never lost. Offline / iOS always uses the recognizer.
      if (onlineRef.current && isStreamingSttAvailable()) {
        try {
          await startStreaming({
            onPartial: (t) => {
              if (!alive || !listening()) return;
              const joined = t.trim();
              const grew =
                normalizeTranscript(joined).length >
                normalizeTranscript(latestTranscript).length;
              latestTranscript = joined;
              store().setLiveTranscript(joined);
              if (grew) {
                lastGrowthAt = Date.now();
                markVoice();
              }
            },
            onAmplitude: (rms) => {
              if (!alive || !listening()) return;
              const amp = Math.max(0, Math.min(1, rms * 4));
              setMicLevel((prev) => (Math.abs(prev - amp) > 0.04 ? amp : prev));
              if (rms > VOICE_RMS_FLOOR) markVoice();
            },
            onError: (e) => {
              if (__DEV__) console.warn('[stream]', e.message);
            },
          });
          // Token fetch + WS open take time. If the user cancelled meanwhile
          // (turnOff → idle/grace) or the engine unmounted, don't leave the socket
          // + recorder running — tear down and bail.
          if (!alive || !listening()) {
            abortStreaming();
            return;
          }
          streaming = true;
          awaitingEnd = true;
          pollTimer = setInterval(pollTick, POLL_MS);
          // Audio capture starts inside startStreaming, so a chunk may have already
          // fired markVoice (→ speechStartAt set, silence timer cleared) during the
          // await. Only arm the silence prompt if no voice has been detected yet,
          // or we'd re-arm a timer that fires mid-speech.
          if (speechStartAt == null) {
            const delay =
              silenceRound === 0 ? SILENCE_PROMPT_MS : SILENCE_CONTINUE_MS;
            silenceTimer = setTimeout(() => void onSilence(), delay);
          }
          return;
        } catch (e) {
          // Streaming unavailable this turn — clean up and use the recognizer.
          abortStreaming();
          streaming = false;
          if (__DEV__) console.warn('[stream] start failed, falling back', e instanceof Error ? e.message : e);
          if (!alive) return;
        }
      }

      let recognitionOk = false;
      try {
        startRecognition(onlineRef.current, store().level);
        recognitionOk = true;
        awaitingEnd = true;
      } catch {
        recognitionOk = false;
      }
      if (!alive) return;

      pollTimer = setInterval(pollTick, POLL_MS);
      // Silence prompts only make sense when recognition is actually running.
      if (recognitionOk) {
        const delay =
          silenceRound === 0 ? SILENCE_PROMPT_MS : SILENCE_CONTINUE_MS;
        silenceTimer = setTimeout(() => void onSilence(), delay);
      }
    };

    /** Submit a typed turn — the text-input fallback (spec §4.4). */
    const submitText = async (text: string) => {
      const trimmed = text.trim();
      if (!alive || !trimmed || !listening()) return;
      awaitingEnd = false;
      stopPoll();
      clearSilenceTimer();
      clearEndFallback();
      setMicLevel(0);
      abortRecognition();
      abortStreaming();
      store().setLiveTranscript('');
      if (!alive) return;
      await runUserTurn({ text: trimmed, audioUri: null });
    };

    const start = async () => {
      try {
        await configureAudioSession();
      } catch {
        // Recording will simply be unavailable; the loop still runs.
      }
      if (!alive) return;
      store().setTurnState('processing');
      // Mirror runUserTurn's error semantics: one automatic retry on transient
      // failure (cold network at app launch, slow function cold-start), and the
      // typed sentinels routed properly instead of swallowed into the generic
      // "couldn't start" banner — a daily-cap 402 or stale-entitlement 403 at
      // open is not a technical failure.
      let response: TurnResponse | null = null;
      for (let attempt = 0; attempt < 2 && response == null; attempt += 1) {
        try {
          response = await store().service.openTurn(buildContext());
        } catch (e) {
          if (e instanceof NotEntitledError) {
            // Server says the cached entitlement is stale — refresh and route to
            // the paywall, same as a reply turn.
            void useSubscriptionStore.getState().refresh();
            store().setTurnState('idle');
            router.replace('/paywall' as never);
            return;
          }
          if (e instanceof DailyCapError) {
            // callTurn already called setCapBlocked — the cap UI takes it from here.
            store().setTurnState('idle');
            return;
          }
          if (__DEV__) console.warn('[open]', e instanceof Error ? e.message : String(e));
          if (attempt === 0) await wait(3000);
        }
        if (!alive) return;
      }
      if (response == null) {
        // Both attempts failed (token expired after being away, slow/hung
        // server). Don't leave the state stuck on 'processing' — that's the
        // permanently hung ••• bubble. Drop to idle with a tappable retry.
        store().setErrorNotice(
          onlineRef.current
            ? `${voiceName(store().settings.voice)} couldn’t start just now. Tap the mic to try again.`
            : 'You’re offline — reconnect and tap the mic to start.',
        );
        store().setTurnState('idle');
        return;
      }
      // Streak is intentionally NOT ticked here — opening the app doesn't
      // count as practice. It ticks on the first real user reply (runUserTurn).
      await speak(response);
    };

    unsubscribe = subscribeRecognition({
      result: (e) => {
        if (!alive || !listening()) return;
        const t = (e.results?.[0]?.transcript ?? '').trim();
        if (t) {
          // Dedup finals before accumulating. Android's continuous recognizer
          // re-emits the SAME final repeatedly ("je fais je fais …"), often with
          // drifting punctuation/casing ("salut" vs "Salut !") — so the
          // comparison must be normalized, or every revision looks like new
          // speech, committedTranscript grows without bound, markVoice never
          // stops, and the silence auto-stop never fires (the mic hangs until
          // the MAX_LISTEN_MS backstop).
          if (e.isFinal) {
            const nc = normalizeTranscript(committedTranscript);
            const nt = normalizeTranscript(t);
            if (!nc) {
              committedTranscript = t;
            } else if (!nt || nc === nt || nc.endsWith(` ${nt}`)) {
              // Re-emission of the whole buffer or its tail (any punctuation) — ignore.
            } else if (nt.startsWith(`${nc} `)) {
              // Cumulative final (iOS-style) — the recognizer restated everything.
              committedTranscript = t;
            } else {
              committedTranscript = `${committedTranscript} ${t}`;
            }
          }
          const joined = e.isFinal
            ? committedTranscript
            : committedTranscript
              ? `${committedTranscript} ${t}`
              : t;
          // Only NEW speech counts as voice activity — measured on the
          // normalized text, so an interim flipping "Salut" ↔ "Salut !" doesn't
          // register as growth and reset the silence clock. Volume-based
          // markVoice (real mic energy) still runs independently for early
          // speech onset and the "still speaking" signal.
          const grew =
            normalizeTranscript(joined).length > normalizeTranscript(latestTranscript).length;
          latestTranscript = joined;
          // Show the interim caption live as the user speaks. The recognizer
          // language now follows the learner's level (en-US for beginners, fr-FR
          // otherwise), so the on-device interim is accurate for their dominant
          // language instead of fr-FR mangling English. The floating caption is
          // low-stakes — it clears on send; the sent bubble stays Scribe-
          // authoritative (filled on reconcile), so an imperfect mid-sentence
          // EN/FR switch here never reaches the transcript bubble.
          store().setLiveTranscript(joined);
          if (grew) {
            lastGrowthAt = Date.now();
            markVoice();
          }
        }
      },
      volumechange: (e) => {
        if (!alive || !listening()) return;
        const amp = volumeToAmplitude(e.value);
        setMicLevel((prev) => (Math.abs(prev - amp) > 0.04 ? amp : prev));
        if (isAudibleVoice(e.value, store().settings.micSensitivity)) {
          markVoice();
        }
      },
      audioend: (e) => {
        recognitionUri = e.uri;
      },
      error: (e) => {
        // Recognizer failed (no-speech, mic busy, permission, etc.). `end` normally
        // follows and drives consumeRecognition; arm the fallback so we never hang
        // if it doesn't. The empty-text path then re-listens (or stops on a storm)
        // without hitting the server. Keep the code so the runaway banner can name
        // the real cause instead of a single generic message.
        lastRecognizerError = e.error ?? null;
        if (__DEV__) console.warn('[stt]', e.error, e.message);
        if (!alive || !awaitingEnd) return;
        clearEndFallback();
        endFallbackTimer = setTimeout(() => void consumeRecognition(), END_FALLBACK_MS);
      },
      end: () => {
        clearEndFallback();
        void consumeRecognition();
      },
    });

    onMicPressRef.current = () => {
      const p = phase();
      if (p === 'marie_speaking') {
        // Barge-in: cut Camille off and listen immediately (interruptedDuringSpeak
        // is read by speak()'s tail). Tapping mid-speech keeps us in live mode.
        interruptedDuringSpeak = true;
        liveMode = true;
        store().setErrorNotice(null);
        player.interrupt();
      } else if (p === 'recording') {
        // The user has spoken and tapped the mic — "I'm done": SEND this turn
        // now, then stop the live session. liveMode=false so speak()'s tail
        // drops to idle (mic off) after Camille's reply instead of auto-
        // continuing the listen loop. manualStop=true routes consumeRecognition
        // straight to the server.
        liveMode = false;
        requestFinish(true);
      } else if (p === 'listening') {
        // Mic on but no speech yet — tapping cancels (leave live mode, go idle).
        turnOff();
      } else if (p === 'grace') {
        // Tapped between turns — leave live mode rather than auto-continuing.
        turnOff();
      } else if (p === 'idle') {
        // Live mode toggle ON — the greeting has already played; start listening.
        // Preflight the mic permission first: a revoked/never-granted mic would
        // otherwise storm the recognizer straight into the runaway banner.
        emptyEndStreak = 0;
        store().setErrorNotice(null);
        void (async () => {
          const { granted } = await getRecognitionPermissions();
          if (!alive) return;
          if (!granted) {
            store().setErrorNotice(MIC_OFF_NOTICE);
            return;
          }
          liveMode = true;
          void startListening();
        })();
      }
    };
    submitTextRef.current = (text: string) => void submitText(text);

    /** Re-hear a past partner message. Only when not mid-turn, so it never
     * fights the live conversation's audio. */
    replayRef.current = (text: string) => {
      const trimmed = text.trim();
      // Replay only when idle/grace — never mid-turn, so it can't clobber the
      // partner's live speech or the user's recording.
      if (!trimmed || (phase() !== 'idle' && phase() !== 'grace')) {
        return;
      }
      void (async () => {
        const s = store();
        let speech: SynthesizedSpeech;
        try {
          speech = await s.service.synthesize(trimmed, s.settings.voice, s.settings.speechSpeed);
        } catch {
          return;
        }
        if (!alive) return;
        await player.play(speech, store().settings.speechSpeed);
      })();
    };

    void start();

    return () => {
      alive = false;
      stopPoll();
      clearSilenceTimer();
      clearEndFallback();
      if (graceTimer) clearTimeout(graceTimer);
      unsubscribe?.();
      abortRecognition();
      abortStreaming();
      player.release();
    };
  }, []);

  return {
    micLevel,
    onMicPress: () => onMicPressRef.current(),
    submitText: (text: string) => submitTextRef.current(text),
    sttUnavailable: !isRecognitionAvailable(),
    replay: (text: string) => replayRef.current(text),
  };
}
