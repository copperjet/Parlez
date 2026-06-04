/** Shared domain types for the Parlez conversation. */

import type { MarieVoiceId, SpeechSpeed } from '@/lib/constants';

/** Who is speaking in a bubble. */
export type Speaker = 'marie' | 'user';

/**
 * Marie's internal estimate of the user's ability (spec §5.2).
 * Never shown to the user. Seeded by onboarding, then adjusted by level signals.
 */
export type Level = 'A' | 'B' | 'C';

/** The four onboarding self-assessment answers (spec §3.1 step 2). */
export type OnboardingChoice = 'nothing' | 'little' | 'some' | 'decent';

/** A single inline correction rendered as a card below a Marie bubble (spec §4.3). */
export interface Correction {
  /** What the user said. */
  original: string;
  /** What they should say. */
  corrected: string;
  /** Optional one-line English gloss, only when the grammar point benefits. */
  gloss?: string;
}

/** One bubble in the conversation transcript. */
export interface Message {
  id: string;
  speaker: Speaker;
  /** Spoken text exactly as said — never silently corrected (spec §4.2). */
  text: string;
  /** Correction cards, only ever attached to a Marie message. */
  corrections?: Correction[];
  /** True while a user message is still being transcribed (faint rendering). */
  pending?: boolean;
  createdAt: number;
}

/** Signal from the AI on whether to adjust conversation complexity (spec §7.5). */
export type LevelSignal = 'up' | 'hold' | 'down';

/** Context passed to the conversation service for one turn. */
export interface TurnContext {
  level: Level;
  /** Compact learning-profile summary for the system prompt (spec §5.4). */
  profileSummary: string;
  /** Recent transcript for conversational continuity. */
  history: Message[];
  /** ms since the previous session ended, or null on the very first turn. */
  gapSinceLastSession: number | null;
}

/** Structured result of one conversational turn (spec §7.5). */
export interface TurnResponse {
  /** STT transcript of what the user said. */
  transcript: string;
  /** What Marie says back. */
  speechText: string;
  /** Correction cards for this turn (already capped to the spec limit). */
  corrections: Correction[];
  /** Internal observations to merge into the learning profile. */
  profileNotes: string[];
  /** Whether to raise, hold, or lower complexity. */
  levelSignal: LevelSignal;
}

/** Phases of one conversational turn (spec §3.3, §6.3). */
export type TurnState =
  | 'idle'
  | 'marie_speaking'
  | 'grace'
  | 'listening'
  | 'recording'
  | 'processing';

/** User-adjustable settings (spec §4.5). */
export interface Settings {
  speechSpeed: SpeechSpeed;
  voice: MarieVoiceId;
  micSensitivity: 'auto' | 'manual';
  haptics: boolean;
}
