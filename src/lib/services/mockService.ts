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

/** First-conversation openings, parameterised by the partner's chosen name. */
const FIRST_OPENINGS: Record<Level, (name: string) => string> = {
  A: (n) => `Bonjour ! Moi, c’est ${n}. Je suis très content(e) de te parler. Comment tu t’appelles ?`,
  B: (n) => `Bonjour ! Je suis ${n}, et je suis ravi(e) de te rencontrer. Dis-moi, comment tu t’appelles ?`,
  C: (n) => `Bonjour ! Ravi(e) de faire ta connaissance, moi c’est ${n}. Raconte-moi un peu : qu’est-ce qui t’a marqué dans ta journée ?`,
};

const FIRST_OPENING_TRANSLATIONS: Record<Level, string> = {
  A: "Hello! I'm {name}. I'm very happy to talk with you. What's your name?",
  B: "Hello! I'm {name}, and I'm delighted to meet you. Tell me, what's your name?",
  C: "Hello! Pleased to meet you, I'm {name}. Tell me a little: what stood out in your day?",
};

const RETURNING_OPENING =
  'Te revoilà ! Ça me fait plaisir. La dernière fois, on parlait de tes films préférés. Tu as regardé quelque chose depuis ?';

const RETURNING_OPENING_TRANSLATION =
  "You're back! That makes me happy. Last time, we were talking about your favourite films. Have you watched anything since?";

/** The scripted user-turn replies. `transcript` is what the mock pretends the user said. */
const SCRIPT: TurnResponse[] = [
  {
    transcript: 'Je m’appelle Alex.',
    speechText:
      'Enchanté(e), Alex ! Tu parles déjà bien. Dis-moi, qu’est-ce que tu as fait aujourd’hui ?',
    translation:
      'Nice to meet you, Alex! You already speak well. Tell me, what did you do today?',
    corrections: [],
    profileNotes: ['User introduced themselves confidently.'],
    levelSignal: 'hold',
    learnerName: 'Alex',
    interests: [],
  },
  {
    transcript: 'Aujourd’hui je vais au travail.',
    speechText:
      'Ah, tu es allé au travail ! Moi aussi, j’ai travaillé ce matin. C’était comment, ta journée ?',
    translation:
      'Ah, you went to work! Me too, I worked this morning. How was your day?',
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
    translation:
      'I understand, it’s normal to be tired after work. What do you like to do to relax?',
    corrections: [],
    profileNotes: ['Handled a short past-tense sentence without error.'],
    levelSignal: 'hold',
  },
  {
    transcript: 'J’aime regarder le film.',
    speechText:
      'Ah, tu aimes regarder des films ! Quel genre de films tu préfères ?',
    translation: 'Ah, you like watching films! What kind of films do you prefer?',
    corrections: [
      {
        original: 'regarder le film',
        corrected: 'regarder des films',
        gloss: 'Use "des" when speaking about films in general.',
      },
    ],
    profileNotes: ['Article choice: uses definite article where a partitive is needed.'],
    levelSignal: 'hold',
    interests: ['films'],
  },
  {
    transcript: 'Je préfère les films de action.',
    speechText: 'Les films d’action, super ! Tu as un film préféré ?',
    translation: 'Action films, great! Do you have a favourite film?',
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
    translation:
      'Excellent choice! Inception is a fascinating film. Why do you like it so much?',
    corrections: [],
    profileNotes: ['Expressed a clear opinion fluently — handling current level well.'],
    levelSignal: 'up',
  },
  {
    transcript: 'Parce que l’histoire est très intéressant.',
    speechText:
      'C’est vrai, l’histoire est très intéressante. Et la fin, est-ce que tu l’as comprise ?',
    translation:
      'It’s true, the story is very interesting. And the ending, did you understand it?',
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
    translation:
      'Haha, a lot of people don’t understand it either! Do you want to talk about it, or change the subject?',
    corrections: [],
    profileNotes: ['Used negation correctly and engaged with a harder topic.'],
    levelSignal: 'hold',
  },
];

const SILENCE_GENTLE: TurnResponse = {
  transcript: '',
  speechText: 'Tu veux dire quelque chose ? Prends ton temps, il n’y a pas de pression.',
  translation: 'Do you want to say something? Take your time, there’s no pressure.',
  corrections: [],
  profileNotes: [],
  levelSignal: 'hold',
};

const SILENCE_SIMPLER: TurnResponse = {
  transcript: '',
  speechText: 'Pas de souci. Dis-moi simplement : qu’est-ce que tu aimes manger ?',
  translation: 'No worries. Just tell me: what do you like to eat?',
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
  const translations = [
    'That’s interesting! Go on, tell me a little more.',
    'Oh yes? And what do you think about it?',
    'I see! And then, what happened?',
  ];
  return {
    transcript: '…',
    speechText: lines[index % lines.length],
    translation: translations[index % translations.length],
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
      const name = ctx.personaName?.trim() || 'Marie';
      return {
        transcript: '',
        speechText: returning ? RETURNING_OPENING : FIRST_OPENINGS[ctx.level](name),
        translation: returning
          ? RETURNING_OPENING_TRANSLATION
          : FIRST_OPENING_TRANSLATIONS[ctx.level].replace('{name}', name),
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
