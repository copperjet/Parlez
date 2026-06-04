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
  isRecognitionAvailable,
  startRecognition,
  stopRecognition,
  subscribeRecognition,
} from '@/lib/audio/recognizer';
import { addProfileNotes, buildProfileSummary } from '@/lib/db/profile';
import { saveLevel, saveMessage, saveProfileSummary } from '@/lib/db/sessions';
import {
  GRACE_MS,
  MAX_CORRECTIONS_PER_TURN,
  MIN_SPEECH_MS,
  SILENCE_CONTINUE_MS,
  SILENCE_PROMPT_MS,
  SILENCE_STOP_MS,
} from '@/lib/constants';
import type { SynthesizedSpeech } from '@/lib/services';
import { useAppStore } from '@/stores/appStore';
import type { TurnContext, TurnResponse } from '@/lib/types';

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
}

export function useTurnEngine(online: boolean): TurnEngine {
  const playerRef = useRef<MariePlayer | null>(null);
  if (playerRef.current == null) playerRef.current = new MariePlayer();

  const onlineRef = useRef(online);
  onlineRef.current = online;

  const [micLevel, setMicLevel] = useState(0);
  const onMicPressRef = useRef<() => void>(() => {});
  const submitTextRef = useRef<(text: string) => void>(() => {});

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
    let lastVoiceAt = 0;
    let silenceRound = 0;
    let latestTranscript = '';
    let recognitionUri: string | null = null;

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
      };
    };

    /** Merge this turn's AI observations into the learning profile (spec §5.4). */
    const persistProfile = async (notes: string[]) => {
      if (notes.length === 0) return;
      await addProfileNotes(notes);
      const summary = await buildProfileSummary();
      if (!alive) return;
      store().setProfileSummary(summary);
      void saveProfileSummary(summary);
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

      let speech: SynthesizedSpeech;
      try {
        speech = await s.service.synthesize(
          response.speechText,
          s.settings.voice,
          s.settings.speechSpeed,
        );
      } catch {
        speech = FALLBACK_SPEECH;
      }
      if (!alive) return;

      const marieMsg = s.addMessage({
        speaker: 'marie',
        text: response.speechText,
        corrections: response.corrections.slice(0, MAX_CORRECTIONS_PER_TURN),
      });
      s.applyLevelSignal(response.levelSignal);
      void saveMessage(marieMsg);
      void saveLevel(store().level);
      void persistProfile(response.profileNotes);

      s.setTurnState('marie_speaking');
      await player.play(speech, store().settings.speechSpeed);
      if (!alive) return;
      enterGrace();
    };

    /** The user stayed silent — Marie gives a gentle nudge (spec §6.3). */
    const onSilence = async () => {
      if (!alive || !listening()) return;
      const simpler = silenceRound >= 1;
      silenceRound += 1;
      awaitingEnd = false;
      stopPoll();
      clearSilenceTimer();
      clearEndFallback();
      abortRecognition();
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
    }) => {
      if (!alive) return;
      haptic('medium');
      store().setErrorNotice(null);
      store().setTurnState('processing');

      // One automatic retry after 3s on failure (spec §10.2).
      let response: TurnResponse | null = null;
      for (let attempt = 0; attempt < 2 && response == null; attempt += 1) {
        try {
          response = await store().service.sendTurn(
            { audioUri: input.audioUri ?? null, text: input.text ?? null },
            buildContext(),
          );
        } catch {
          if (attempt === 0) await wait(3000);
        }
        if (!alive) return;
      }

      if (response == null) {
        // AI / network failure — Marie apologises in French, then we listen again.
        store().setErrorNotice(
          'Something went wrong. Check your connection and try again.',
        );
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

      if (response.transcript) {
        const userMsg = store().addMessage({
          speaker: 'user',
          text: response.transcript,
        });
        void saveMessage(userMsg);
      }
      await speak(response);
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
      const uri = recognitionUri;
      store().setLiveTranscript('');

      // Auto-ended with nothing heard — treat as silence, not a failed turn.
      if (!text && !manualStop) {
        await onSilence();
        return;
      }

      const isOnline = onlineRef.current;
      await runUserTurn({
        audioUri: isOnline ? uri : null,
        text: isOnline ? null : text || null,
      });
    };

    /** Stop the recognizer; `consumeRecognition` runs once `end` arrives. */
    const requestFinish = (manual: boolean) => {
      if (!alive || !awaitingEnd) return;
      manualStop = manual;
      stopPoll();
      clearSilenceTimer();
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
      if (now - speechStartAt >= MIN_SPEECH_MS && now - lastVoiceAt >= SILENCE_STOP_MS) {
        requestFinish(false);
      }
    };

    const startListening = async () => {
      if (!alive) return;
      store().setTurnState('listening');
      store().setLiveTranscript('');
      speechStartAt = null;
      lastVoiceAt = Date.now();
      latestTranscript = '';
      recognitionUri = null;
      manualStop = false;
      setMicLevel(0);
      haptic('light');

      let recognitionOk = false;
      try {
        startRecognition(onlineRef.current);
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
      let response: TurnResponse;
      try {
        response = await store().service.openTurn(buildContext());
      } catch {
        return;
      }
      if (!alive) return;
      await speak(response);
    };

    unsubscribe = subscribeRecognition({
      result: (e) => {
        if (!alive || !listening()) return;
        const t = e.results?.[0]?.transcript ?? '';
        if (t) {
          latestTranscript = t;
          store().setLiveTranscript(t);
          markVoice();
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
      end: () => {
        clearEndFallback();
        void consumeRecognition();
      },
    });

    onMicPressRef.current = () => {
      const p = phase();
      if (p === 'marie_speaking') {
        player.interrupt();
      } else if (p === 'listening' || p === 'recording') {
        requestFinish(true);
      } else if (p === 'idle') {
        void start();
      }
    };
    submitTextRef.current = (text: string) => void submitText(text);

    void start();

    return () => {
      alive = false;
      stopPoll();
      clearSilenceTimer();
      clearEndFallback();
      if (graceTimer) clearTimeout(graceTimer);
      unsubscribe?.();
      abortRecognition();
      player.release();
    };
  }, []);

  return {
    micLevel,
    onMicPress: () => onMicPressRef.current(),
    submitText: (text: string) => submitTextRef.current(text),
    sttUnavailable: !isRecognitionAvailable(),
  };
}
