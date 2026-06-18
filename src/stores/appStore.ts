import { create } from 'zustand';

import { nextId } from '@/lib/id';
import { createConversationService } from '@/lib/services';
import type { ConversationService } from '@/lib/services';
import type {
  Level,
  LevelSignal,
  Message,
  OnboardingChoice,
  Settings,
  TurnState,
} from '@/lib/types';

const CHOICE_TO_LEVEL: Record<OnboardingChoice, Level> = {
  nothing: 'A',
  little: 'A',
  some: 'B',
  // Self-rating is unreliable, so we never seed the top level — "decent" starts
  // at B and earns C through level-up signals (see applyLevelSignal).
  decent: 'B',
};

const LEVELS: Level[] = ['A', 'B', 'C'];

/**
 * Consecutive 'up' signals required before the level actually rises. Promotion
 * is deliberately slower than demotion: one good turn shouldn't over-promote a
 * user into a harder level they then struggle with.
 */
const LEVEL_UP_CONFIRMATIONS = 2;

/** Marie's internal level shift — invisible to the user (spec §5.2). */
function shiftLevel(level: Level, signal: LevelSignal): Level {
  const i = LEVELS.indexOf(level);
  if (signal === 'up') return LEVELS[Math.min(i + 1, LEVELS.length - 1)];
  if (signal === 'down') return LEVELS[Math.max(i - 1, 0)];
  return level;
}

export const DEFAULT_SETTINGS: Settings = {
  speechSpeed: 'normal',
  voice: 'camille',
  micSensitivity: 'auto',
  haptics: true,
  chatTheme: 'ember',
};

interface AppStore {
  /** Onboarding */
  hasOnboarded: boolean;
  onboardingChoice: OnboardingChoice | null;
  /** Marie's internal level estimate. */
  level: Level;
  /** Consecutive 'up' signals seen so far — gates promotion (in-memory only). */
  levelUpStreak: number;

  /** User settings (spec §4.5). */
  settings: Settings;

  /** Conversation transcript and turn state. */
  messages: Message[];
  /** Prior-session transcript — feeds the AI's context, never rendered (spec §3.2). */
  priorHistory: Message[];
  /**
   * Larger prior-session backlog rendered above the live transcript so a
   * returning user can scroll back and reference past turns. Display-only —
   * NOT fed to the AI (that stays bounded to {@link priorHistory}).
   */
  renderedHistory: Message[];
  turnState: TurnState;
  /** Faint live STT text shown while the user records (spec §3.3). */
  liveTranscript: string;

  /** Transient English error notice shown on screen (spec §10.2); null when clear. */
  errorNotice: string | null;

  /** Compact learning-profile summary fed to the system prompt (spec §5.4). */
  profileSummary: string;

  /** Typed profile slots — what Marie has learned by category, not by sentence. */
  learnerName: string | null;
  interests: string[];
  /**
   * Durable personal facts (location, occupation, family, goals…) as a small
   * key→value map. Persisted forever until the user wipes their data, and NOT
   * routed through the lossy profileSummary consolidation — so who the learner
   * is stays remembered. Injected compactly into the system prompt.
   */
  profileFacts: Record<string, string>;

  /** Calendar-day streak — surfaced in settings only. NOT cleared on memory reset. */
  streakCount: number;
  lastSessionDate: string | null;

  /**
   * Set to the streak length when today's 10-minute goal is first met, to trigger
   * the one-shot celebration overlay; null while there's nothing to celebrate.
   * Transient (never persisted) — the once-per-day guard lives in kv.
   */
  pendingStreakCelebration: number | null;

  /**
   * First-launch date (YYYY-MM-DD local) — anchors the money-back guarantee
   * window. Set once on the first hydrate that finds none; never reset by a
   * memory clear.
   */
  firstLaunchDate: string | null;

  /** True only for genuine first-time installs — gates the money-back tracker. */
  isFirstTimeUser: boolean;

  /** Counter that gates the next LLM consolidation pass. */
  turnsSinceConsolidation: number;

  /** ms since the user was last active — drives Marie's session-resume (spec §3.2). */
  gapSinceLastSession: number | null;

  /** Bumped whenever the conversation must restart fresh (e.g. cleared history). */
  sessionEpoch: number;

  /** The active STT/AI/TTS service — mock today, Supabase in Phase 7. */
  service: ConversationService;

  /** Restore persisted state on launch (spec §7.2). */
  hydrate: (state: {
    hasOnboarded: boolean;
    onboardingChoice: OnboardingChoice | null;
    level: Level;
    settings: Settings;
    profileSummary: string;
    gapSinceLastSession: number | null;
    priorHistory: Message[];
    renderedHistory: Message[];
    learnerName: string | null;
    interests: string[];
    profileFacts: Record<string, string>;
    streakCount: number;
    lastSessionDate: string | null;
    firstLaunchDate: string | null;
    isFirstTimeUser: boolean;
    turnsSinceConsolidation: number;
  }) => void;
  completeOnboarding: (choice: OnboardingChoice) => void;
  setTurnState: (s: TurnState) => void;
  addMessage: (input: {
    speaker: Message['speaker'];
    text: string;
    corrections?: Message['corrections'];
    translation?: Message['translation'];
    segments?: Message['segments'];
    pending?: boolean;
  }) => Message;
  updateMessage: (id: string, patch: Partial<Message>) => void;
  removeMessage: (id: string) => void;
  setLiveTranscript: (text: string) => void;
  setErrorNotice: (notice: string | null) => void;
  applyLevelSignal: (signal: LevelSignal) => void;
  setProfileSummary: (summary: string) => void;
  setStructuredProfile: (input: {
    learnerName?: string | null;
    interests?: string[];
  }) => void;
  /** Replace the durable personal-facts map (merge logic lives in the turn loop). */
  setProfileFacts: (facts: Record<string, string>) => void;
  setStreak: (count: number, date: string | null) => void;
  setPendingStreakCelebration: (streak: number | null) => void;
  setTurnsSinceConsolidation: (count: number) => void;
  updateSettings: (patch: Partial<Settings>) => void;
  /** "Clear session history" — resets Marie's memory of the user (spec §4.5). */
  resetMemory: () => void;
  /** "Delete all my data" — same as resetMemory, plus wipes streak. */
  resetAll: () => void;
}

export const useAppStore = create<AppStore>((set) => ({
  hasOnboarded: false,
  onboardingChoice: null,
  level: 'B',
  levelUpStreak: 0,
  settings: DEFAULT_SETTINGS,
  messages: [],
  priorHistory: [],
  renderedHistory: [],
  turnState: 'idle',
  liveTranscript: '',
  errorNotice: null,
  profileSummary: '',
  learnerName: null,
  interests: [],
  profileFacts: {},
  streakCount: 0,
  lastSessionDate: null,
  pendingStreakCelebration: null,
  firstLaunchDate: null,
  isFirstTimeUser: true,
  turnsSinceConsolidation: 0,
  gapSinceLastSession: null,
  sessionEpoch: 0,
  service: createConversationService(),

  hydrate: (state) =>
    set({
      hasOnboarded: state.hasOnboarded,
      onboardingChoice: state.onboardingChoice,
      level: state.level,
      settings: state.settings,
      profileSummary: state.profileSummary,
      gapSinceLastSession: state.gapSinceLastSession,
      priorHistory: state.priorHistory,
      renderedHistory: state.renderedHistory,
      learnerName: state.learnerName,
      interests: state.interests,
      profileFacts: state.profileFacts,
      streakCount: state.streakCount,
      lastSessionDate: state.lastSessionDate,
      firstLaunchDate: state.firstLaunchDate,
      isFirstTimeUser: state.isFirstTimeUser,
      turnsSinceConsolidation: state.turnsSinceConsolidation,
    }),

  completeOnboarding: (choice) =>
    set({
      hasOnboarded: true,
      onboardingChoice: choice,
      level: CHOICE_TO_LEVEL[choice],
    }),

  setTurnState: (turnState) => set({ turnState }),

  addMessage: (input) => {
    const message: Message = {
      id: nextId(input.speaker),
      speaker: input.speaker,
      text: input.text,
      corrections: input.corrections,
      translation: input.translation,
      segments: input.segments,
      pending: input.pending,
      createdAt: Date.now(),
    };
    set((s) => ({ messages: [...s.messages, message] }));
    return message;
  },

  updateMessage: (id, patch) =>
    set((s) => ({
      messages: s.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    })),

  removeMessage: (id) =>
    set((s) => ({ messages: s.messages.filter((m) => m.id !== id) })),

  setLiveTranscript: (liveTranscript) => set({ liveTranscript }),

  setErrorNotice: (errorNotice) => set({ errorNotice }),

  applyLevelSignal: (signal) =>
    set((s) => {
      // Demote immediately; reset the up-run on anything that isn't 'up'.
      if (signal === 'down')
        return { level: shiftLevel(s.level, 'down'), levelUpStreak: 0 };
      if (signal === 'hold') return { levelUpStreak: 0 };
      // 'up' — only promote after enough *consecutive* up signals.
      const streak = s.levelUpStreak + 1;
      if (streak >= LEVEL_UP_CONFIRMATIONS)
        return { level: shiftLevel(s.level, 'up'), levelUpStreak: 0 };
      return { levelUpStreak: streak };
    }),

  setProfileSummary: (profileSummary) => set({ profileSummary }),

  setStructuredProfile: ({ learnerName, interests }) =>
    set((s) => ({
      learnerName: learnerName === undefined ? s.learnerName : learnerName,
      interests: interests === undefined ? s.interests : interests,
    })),

  setProfileFacts: (profileFacts) => set({ profileFacts }),

  setStreak: (streakCount, lastSessionDate) =>
    set({ streakCount, lastSessionDate }),

  setPendingStreakCelebration: (pendingStreakCelebration) =>
    set({ pendingStreakCelebration }),

  setTurnsSinceConsolidation: (turnsSinceConsolidation) =>
    set({ turnsSinceConsolidation }),

  updateSettings: (patch) =>
    set((s) => ({ settings: { ...s.settings, ...patch } })),

  /**
   * Clears memory but DELIBERATELY preserves streakCount + lastSessionDate —
   * the streak is engagement state, not a memory of the user.
   */
  resetMemory: () =>
    set((s) => ({
      messages: [],
      priorHistory: [],
      renderedHistory: [],
      profileSummary: '',
      learnerName: null,
      interests: [],
      profileFacts: {},
      turnsSinceConsolidation: 0,
      gapSinceLastSession: null,
      liveTranscript: '',
      errorNotice: null,
      turnState: 'idle',
      service: createConversationService(),
      sessionEpoch: s.sessionEpoch + 1,
    })),

  /**
   * Wipe everything — used by "Delete all my data". Resets streak AND Marie's
   * internal level estimate (the user asked to delete everything Marie has
   * learned, which includes their estimated proficiency).
   */
  resetAll: () =>
    set((s) => ({
      level: 'B',
      levelUpStreak: 0,
      messages: [],
      priorHistory: [],
      renderedHistory: [],
      profileSummary: '',
      learnerName: null,
      interests: [],
      profileFacts: {},
      streakCount: 0,
      lastSessionDate: null,
      turnsSinceConsolidation: 0,
      gapSinceLastSession: null,
      liveTranscript: '',
      errorNotice: null,
      turnState: 'idle',
      service: createConversationService(),
      sessionEpoch: s.sessionEpoch + 1,
    })),
}));
