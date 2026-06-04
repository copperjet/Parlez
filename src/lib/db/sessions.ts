/**
 * Persistence of scalar app state (the `kv` table) and the conversation
 * transcript (the `messages` table). Returning users resume against this:
 * past messages feed the AI's context and the gap since last activity decides
 * whether Marie continues the old topic or starts fresh (spec §3.2).
 */
import type { Correction, Level, Message, OnboardingChoice, Settings } from '@/lib/types';
import { DEFAULT_SETTINGS } from '@/stores/appStore';

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
}

const DEFAULT_STATE: PersistedState = {
  hasOnboarded: false,
  onboardingChoice: null,
  level: 'B',
  settings: DEFAULT_SETTINGS,
  profileSummary: '',
  gapSinceLastSession: null,
  priorHistory: [],
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

    return {
      hasOnboarded: kv.get('hasOnboarded') === 'true',
      onboardingChoice: (kv.get('onboardingChoice') as OnboardingChoice) ?? null,
      level: (kv.get('level') as Level) ?? 'B',
      settings: kv.get('settings')
        ? { ...DEFAULT_SETTINGS, ...JSON.parse(kv.get('settings')!) }
        : DEFAULT_SETTINGS,
      profileSummary: kv.get('profileSummary') ?? '',
      gapSinceLastSession: gap,
      priorHistory: await loadRecentMessages(),
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
      'INSERT OR REPLACE INTO messages (id, speaker, text, corrections, created_at) ' +
        'VALUES (?, ?, ?, ?, ?)',
      message.id,
      message.speaker,
      message.text,
      message.corrections ? JSON.stringify(message.corrections) : null,
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
        createdAt: r.created_at,
      }))
      .reverse();
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
