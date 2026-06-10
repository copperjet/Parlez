/**
 * Persistence of scalar app state (the `kv` table) and the conversation
 * transcript (the `messages` table). Returning users resume against this:
 * past messages feed the AI's context and the gap since last activity decides
 * whether Marie continues the old topic or starts fresh (spec §3.2).
 */
import { MARIE_VOICES } from '@/lib/constants';
import type { Correction, Level, Message, OnboardingChoice, Settings } from '@/lib/types';
import { DEFAULT_SETTINGS } from '@/stores/appStore';

/** Coerce a persisted settings blob onto the current shape (e.g. drop the
 *  retired "claire" voice so legacy installs land on a valid Female voice). */
function sanitizeSettings(raw: Partial<Settings>): Settings {
  const merged = { ...DEFAULT_SETTINGS, ...raw };
  if (!MARIE_VOICES.some((v) => v.id === merged.voice)) {
    merged.voice = DEFAULT_SETTINGS.voice;
  }
  return merged;
}

import { getDb } from './index';

/** App state restored on launch. */
export interface PersistedState {
  hasOnboarded: boolean;
  onboardingChoice: OnboardingChoice | null;
  level: Level;
  settings: Settings;
  profileSummary: string;
  /** ms since the user was last active, or null on a first-ever launch. */
  gapSinceLastSession: number | null;
  /** Prior-session transcript — feeds the AI, never shown on screen (spec §3.2). */
  priorHistory: Message[];
  /** Structured profile slots — the typed counterpart to profileSummary. */
  learnerName: string | null;
  interests: string[];
  /** Daily-streak state — surfaced in settings only. */
  streakCount: number;
  lastSessionDate: string | null;
  /** Counter that gates LLM-driven note consolidation. */
  turnsSinceConsolidation: number;
}

const DEFAULT_STATE: PersistedState = {
  hasOnboarded: false,
  onboardingChoice: null,
  level: 'B',
  settings: DEFAULT_SETTINGS,
  profileSummary: '',
  gapSinceLastSession: null,
  priorHistory: [],
  learnerName: null,
  interests: [],
  streakCount: 0,
  lastSessionDate: null,
  turnsSinceConsolidation: 0,
};

async function readKv(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const db = await getDb();
  if (!db) return map;
  const rows = await db.getAllAsync<{ key: string; value: string }>(
    'SELECT key, value FROM kv',
  );
  for (const r of rows) map.set(r.key, r.value);
  return map;
}

/** Restore persisted app state. Falls back to defaults on any failure. */
export async function loadPersistedState(): Promise<PersistedState> {
  try {
    const kv = await readKv();
    if (kv.size === 0) return DEFAULT_STATE;

    const lastActive = kv.get('lastActiveAt');
    const gap = lastActive ? Date.now() - Number(lastActive) : null;

    const interestsRaw = kv.get('interests') ?? '';
    const interests = interestsRaw
      ? interestsRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    const streakRaw = Number(kv.get('streakCount') ?? '0');
    const streakCount = Number.isFinite(streakRaw) && streakRaw > 0 ? streakRaw : 0;
    const turnsSinceRaw = Number(kv.get('turnsSinceConsolidation') ?? '0');
    const turnsSinceConsolidation =
      Number.isFinite(turnsSinceRaw) && turnsSinceRaw > 0 ? turnsSinceRaw : 0;
    const learnerNameRaw = kv.get('learnerName') ?? '';
    const learnerName = learnerNameRaw.trim() ? learnerNameRaw.trim() : null;

    return {
      hasOnboarded: kv.get('hasOnboarded') === 'true',
      onboardingChoice: (kv.get('onboardingChoice') as OnboardingChoice) ?? null,
      level: (kv.get('level') as Level) ?? 'B',
      settings: kv.get('settings')
        ? sanitizeSettings(JSON.parse(kv.get('settings')!))
        : DEFAULT_SETTINGS,
      profileSummary: kv.get('profileSummary') ?? '',
      gapSinceLastSession: gap,
      priorHistory: await loadRecentMessages(),
      learnerName,
      interests,
      streakCount,
      lastSessionDate: (kv.get('lastSessionDate') || null) ?? null,
      turnsSinceConsolidation,
    };
  } catch {
    return DEFAULT_STATE;
  }
}

/** Write one or more kv entries. */
export async function saveKv(entries: Record<string, string>): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    for (const [key, value] of Object.entries(entries)) {
      await db.runAsync(
        'INSERT INTO kv (key, value) VALUES (?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        key,
        value,
      );
    }
  } catch {
    // Persistence is best-effort; the app keeps working in memory.
  }
}

export function saveOnboarding(choice: OnboardingChoice, level: Level): Promise<void> {
  return saveKv({ hasOnboarded: 'true', onboardingChoice: choice, level });
}

export function saveSettings(settings: Settings): Promise<void> {
  return saveKv({ settings: JSON.stringify(settings) });
}

export function saveLevel(level: Level): Promise<void> {
  return saveKv({ level });
}

export function saveProfileSummary(summary: string): Promise<void> {
  return saveKv({ profileSummary: summary });
}

/** Persist the typed profile slots (separate from the bullet summary). */
export function saveStructuredProfile(input: {
  learnerName?: string | null;
  interests?: string[];
}): Promise<void> {
  const entries: Record<string, string> = {};
  if (input.learnerName !== undefined) {
    entries.learnerName = input.learnerName ?? '';
  }
  if (input.interests !== undefined) {
    entries.interests = input.interests.join(',');
  }
  return saveKv(entries);
}

/** Persist the calendar-day streak (one write per turn at most). */
export function saveStreak(count: number, date: string | null): Promise<void> {
  return saveKv({
    streakCount: String(Math.max(0, Math.floor(count))),
    lastSessionDate: date ?? '',
  });
}

/** Persist the consolidation counter so it survives a relaunch. */
export function saveTurnsSinceConsolidation(count: number): Promise<void> {
  return saveKv({
    turnsSinceConsolidation: String(Math.max(0, Math.floor(count))),
  });
}

/** Full structured-profile wipe — used by "Delete all my data". */
export function clearStructuredProfile(): Promise<void> {
  return saveKv({ learnerName: '', interests: '' });
}

/** Full streak wipe — used by "Delete all my data". */
export function clearStreak(): Promise<void> {
  return saveKv({
    streakCount: '0',
    lastSessionDate: '',
    turnsSinceConsolidation: '0',
  });
}

/**
 * Reset the activity + level kv slots — used by "Delete all my data" so the
 * next launch behaves like a fresh install (no "X hours ago" resume context,
 * level back to the default).
 */
export function clearActivity(): Promise<void> {
  return saveKv({ lastActiveAt: '', level: 'B' });
}

/** Record that the user is active right now (drives the resume-gap on relaunch). */
export function touchActivity(): Promise<void> {
  return saveKv({ lastActiveAt: String(Date.now()) });
}

/** Append one message to the persisted transcript. */
export async function saveMessage(message: Message): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await db.runAsync(
      'INSERT OR REPLACE INTO messages (id, speaker, text, corrections, translation, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?)',
      message.id,
      message.speaker,
      message.text,
      message.corrections ? JSON.stringify(message.corrections) : null,
      message.translation ?? null,
      message.createdAt,
    );
    await touchActivity();
  } catch {
    // Best-effort.
  }
}

/** Load the most recent messages (chronological) for the AI's context window. */
export async function loadRecentMessages(limit = 12): Promise<Message[]> {
  const db = await getDb();
  if (!db) return [];
  try {
    const rows = await db.getAllAsync<{
      id: string;
      speaker: string;
      text: string;
      corrections: string | null;
      translation: string | null;
      created_at: number;
    }>('SELECT * FROM messages ORDER BY created_at DESC LIMIT ?', limit);

    return rows
      .map((r) => ({
        id: r.id,
        speaker: r.speaker as Message['speaker'],
        text: r.text,
        corrections: r.corrections
          ? (JSON.parse(r.corrections) as Correction[])
          : undefined,
        translation: r.translation ?? undefined,
        createdAt: r.created_at,
      }))
      .reverse();
  } catch {
    return [];
  }
}

/**
 * All corrections the user has received, most recent first — powers the
 * progress / review screen. Flattens the per-message correction arrays.
 */
export async function loadCorrections(limit = 100): Promise<Correction[]> {
  const db = await getDb();
  if (!db) return [];
  try {
    const rows = await db.getAllAsync<{ corrections: string | null }>(
      "SELECT corrections FROM messages WHERE corrections IS NOT NULL " +
        'ORDER BY created_at DESC LIMIT ?',
      limit,
    );
    const out: Correction[] = [];
    for (const r of rows) {
      if (!r.corrections) continue;
      try {
        const parsed = JSON.parse(r.corrections) as Correction[];
        for (const c of parsed) {
          if (c && c.original && c.corrected) out.push(c);
        }
      } catch {
        // Skip a malformed row.
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Wipe the transcript — part of "Clear session history" (spec §4.5). */
export async function clearMessages(): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await db.runAsync('DELETE FROM messages');
  } catch {
    // Best-effort.
  }
}
