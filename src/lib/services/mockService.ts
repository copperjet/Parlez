/**
 * Mock conversation service — a scripted French dialogue so the entire app
 * (turn loop, bubbles, correction cards, level changes) can be built and tested
 * with no API keys and no network. Swapped for the real Supabase service in
 * Phase 7 behind the identical ConversationService interface.
 */
import { SPEECH_SPEEDS, type MarieVoiceId, type SpeechSpeed } from '@/lib/constants';
import type { Level, TurnContext, TurnResponse } from '@/lib/types';

import type { ConversationService, SynthesizedSpeech, TurnInput } from './conversation';

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Rough spoken-duration estimate so the waveform animates for a believable time. */
function estimateDuration(text: string, speed: SpeechSpeed): number {
  const words = text.trim().split(/\s+/).length;
  const base = Math.max(1400, Math.min(9000, words * 360));
  return Math.round(base / SPEECH_SPEEDS[speed]);
}

const FIRST_OPENINGS: Record<Level, string> = {
  A: 'Bonjour ! Moi, c’est Marie. Je suis très contente de te parler. Comment tu t’appelles ?',
  B: 'Bonjour ! Je suis Marie, et je suis ravie de te rencontrer. Dis-moi, comment tu t’appelles ?',
  C: 'Bonjour ! Ravie de faire ta connaissance, moi c’est Marie. Raconte-moi un peu : qu’est-ce qui t’a marqué dans ta journée ?',
};

const RETURNING_OPENING =
  'Te revoilà ! Ça me fait plaisir. La dernière fois, on parlait de tes films préférés. Tu as regardé quelque chose depuis ?';

/** The scripted user-turn replies. `transcript` is what the mock pretends the user said. */
const SCRIPT: TurnResponse[] = [
  {
    transcript: 'Je m’appelle Alex.',
    speechText:
      'Enchantée, Alex ! Tu parles déjà bien. Dis-moi, qu’est-ce que tu as fait aujourd’hui ?',
    corrections: [],
    profileNotes: ['User introduced themselves confidently.'],
    levelSignal: 'hold',
  },
  {
    transcript: 'Aujourd’hui je vais au travail.',
    speechText:
      'Ah, tu es allé au travail ! Moi aussi, j’ai travaillé ce matin. C’était comment, ta journée ?',
    corrections: [
      {
        original: 'je vais au travail',
        corrected: 'je suis allé au travail',
        gloss: 'Use the passé composé for an action that is already finished.',
      },
    ],
    profileNotes: ['Confuses présent and passé composé for completed actions.'],
    levelSignal: 'hold',
  },
  {
    transcript: 'Ma journée était bien. Je suis un peu fatigué.',
    speechText:
      'Je comprends, c’est normal d’être fatigué après le travail. Qu’est-ce que tu aimes faire pour te détendre ?',
    corrections: [],
    profileNotes: ['Handled a short past-tense sentence without error.'],
    levelSignal: 'hold',
  },
  {
    transcript: 'J’aime regarder le film.',
    speechText:
      'Ah, tu aimes regarder des films ! Quel genre de films tu préfères ?',
    corrections: [
      {
        original: 'regarder le film',
        corrected: 'regarder des films',
        gloss: 'Use "des" when speaking about films in general.',
      },
    ],
    profileNotes: ['Article choice: uses definite article where a partitive is needed.'],
    levelSignal: 'hold',
  },
  {
    transcript: 'Je préfère les films de action.',
    speechText: 'Les films d’action, super ! Tu as un film préféré ?',
    corrections: [
      {
        original: 'films de action',
        corrected: 'films d’action',
        gloss: '"de" becomes "d’" before a vowel sound.',
      },
    ],
    profileNotes: ['Elision: misses de -> d’ before vowels.'],
    levelSignal: 'hold',
  },
  {
    transcript: 'Oui, j’aime beaucoup Inception.',
    speechText:
      'Excellent choix ! Inception est un film fascinant. Pourquoi est-ce que tu l’aimes autant ?',
    corrections: [],
    profileNotes: ['Expressed a clear opinion fluently — handling current level well.'],
    levelSignal: 'up',
  },
  {
    transcript: 'Parce que l’histoire est très intéressant.',
    speechText:
      'C’est vrai, l’histoire est très intéressante. Et la fin, est-ce que tu l’as comprise ?',
    corrections: [
      {
        original: 'l’histoire est très intéressant',
        corrected: 'l’histoire est très intéressante',
        gloss: '"histoire" is feminine, so the adjective agrees.',
      },
    ],
    profileNotes: ['Gender agreement: adjective not agreeing with feminine nouns.'],
    levelSignal: 'hold',
  },
  {
    transcript: 'Non, je ne comprends pas bien la fin.',
    speechText:
      'Haha, beaucoup de gens ne la comprennent pas non plus ! Tu veux qu’on en parle, ou on change de sujet ?',
    corrections: [],
    profileNotes: ['Used negation correctly and engaged with a harder topic.'],
    levelSignal: 'hold',
  },
];

const SILENCE_GENTLE: TurnResponse = {
  transcript: '',
  speechText: 'Tu veux dire quelque chose ? Prends ton temps, il n’y a pas de pression.',
  corrections: [],
  profileNotes: [],
  levelSignal: 'hold',
};

const SILENCE_SIMPLER: TurnResponse = {
  transcript: '',
  speechText: 'Pas de souci. Dis-moi simplement : qu’est-ce que tu aimes manger ?',
  corrections: [],
  profileNotes: ['Needed a simpler fallback question after silence.'],
  levelSignal: 'down',
};

/** A generic, encouraging reply once the scripted dialogue is exhausted. */
function fallbackTurn(index: number): TurnResponse {
  const lines = [
    'C’est intéressant ! Continue, raconte-moi un peu plus.',
    'Ah oui ? Et qu’est-ce que tu en penses, toi ?',
    'Je vois ! Et après, qu’est-ce qui s’est passé ?',
  ];
  return {
    transcript: '…',
    speechText: lines[index % lines.length],
    corrections: [],
    profileNotes: [],
    levelSignal: 'hold',
  };
}

export function createMockService(): ConversationService {
  let cursor = 0;

  return {
    async openTurn(ctx: TurnContext): Promise<TurnResponse> {
      await delay(800);
      const returning = ctx.history.length > 0 || ctx.gapSinceLastSession != null;
      return {
        transcript: '',
        speechText: returning ? RETURNING_OPENING : FIRST_OPENINGS[ctx.level],
        corrections: [],
        profileNotes: [],
        levelSignal: 'hold',
      };
    },

    async sendTurn(_input: TurnInput, _ctx: TurnContext): Promise<TurnResponse> {
      // Realistic STT + AI latency budget (spec §7.3).
      await delay(1400);
      const turn = cursor < SCRIPT.length ? SCRIPT[cursor] : fallbackTurn(cursor);
      cursor += 1;
      return turn;
    },

    async promptSilence(simpler: boolean): Promise<TurnResponse> {
      await delay(400);
      return simpler ? SILENCE_SIMPLER : SILENCE_GENTLE;
    },

    async synthesize(
      text: string,
      _voice: MarieVoiceId,
      speed: SpeechSpeed,
    ): Promise<SynthesizedSpeech> {
      await delay(600);
      return { uri: null, durationMs: estimateDuration(text, speed) };
    },
  };
}
