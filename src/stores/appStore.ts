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
  decent: 'C',
};

const LEVELS: Level[] = ['A', 'B', 'C'];

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
};

interface AppStore {
  /** Onboarding */
  hasOnboarded: boolean;
  onboardingChoice: OnboardingChoice | null;
  /** Marie's internal level estimate. */
  level: Level;

  /** User settings (spec §4.5). */
  settings: Settings;

  /** Conversation transcript and turn state. */
  messages: Message[];
  /** Prior-session transcript — feeds the AI's context, never rendered (spec §3.2). */
  priorHistory: Message[];
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

  /** Calendar-day streak — surfaced in settings only. NOT cleared on memory reset. */
  streakCount: number;
  lastSessionDate: string | null;

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
    learnerName: string | null;
    interests: string[];
    streakCount: number;
    lastSessionDate: string | null;
    turnsSinceConsolidation: number;
  }) => void;
  completeOnboarding: (choice: OnboardingChoice) => void;
  setTurnState: (s: TurnState) => void;
  addMessage: (input: {
    speaker: Message['speaker'];
    text: string;
    corrections?: Message['corrections'];
    translation?: Message['translation'];
    pending?: boolean;
  }) => Message;
  updateMessage: (id: string, patch: Partial<Message>) => void;
  setLiveTranscript: (text: string) => void;
  setErrorNotice: (notice: string | null) => void;
  applyLevelSignal: (signal: LevelSignal) => void;
  setProfileSummary: (summary: string) => void;
  setStructuredProfile: (input: {
    learnerName?: string | null;
    interests?: string[];
  }) => void;
  setStreak: (count: number, date: string | null) => void;
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
  settings: DEFAULT_SETTINGS,
  messages: [],
  priorHistory: [],
  turnState: 'idle',
  liveTranscript: '',
  errorNotice: null,
  profileSummary: '',
  learnerName: null,
  interests: [],
  streakCount: 0,
  lastSessionDate: null,
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
      learnerName: state.learnerName,
      interests: state.interests,
      streakCount: state.streakCount,
      lastSessionDate: state.lastSessionDate,
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

  setLiveTranscript: (liveTranscript) => set({ liveTranscript }),

  setErrorNotice: (errorNotice) => set({ errorNotice }),

  applyLevelSignal: (signal) =>
    set((s) => ({ level: shiftLevel(s.level, signal) })),

  setProfileSummary: (profileSummary) => set({ profileSummary }),

  setStructuredProfile: ({ learnerName, interests }) =>
    set((s) => ({
      learnerName: learnerName === undefined ? s.learnerName : learnerName,
      interests: interests === undefined ? s.interests : interests,
    })),

  setStreak: (streakCount, lastSessionDate) =>
    set({ streakCount, lastSessionDate }),

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
      profileSummary: '',
      learnerName: null,
      interests: [],
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
      messages: [],
      priorHistory: [],
      profileSummary: '',
      learnerName: null,
      interests: [],
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
