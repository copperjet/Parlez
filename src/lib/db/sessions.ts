/**
 * Persistence of scalar app state (the `kv` table) and the conversation
 * transcript (the `messages` table). Returning users resume against this:
 * past messages feed the AI's context and the gap since last activity decides
 * whether Marie continues the old topic or starts fresh (spec §3.2).
 */
import { MARIE_VOICES } from '@/lib/constants';
import type { Correction, Level, Message, OnboardingChoice, Settings } from '@/lib/types';
import { DEFAULT_SETTINGS } from '@/stores/appStore';

import { getDb } from './index';

/** Coerce a persisted settings blob onto the current shape (e.g. drop the
 *  retired "claire" voice so legacy installs land on a valid Female voice). */
function sanitizeSettings(raw: Partial<Settings>): Settings {
  const merged = { ...DEFAULT_SETTINGS, ...raw };
  if (!MARIE_VOICES.some((v) => v.id === merged.voice)) {
    merged.voice = DEFAULT_SETTINGS.voice;
  }
  if (!VALID_CHAT_THEMES.includes(merged.chatTheme)) {
    merged.chatTheme = DEFAULT_SETTINGS.chatTheme;
  }
  return merged;
}

const VALID_CHAT_THEMES: Settings['chatTheme'][] = ['sand', 'ember', 'violet', 'supernova'];

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
  /**
   * Larger prior-session backlog rendered above the live conversation so a
   * returning user can scroll back and reference what they've said. Display-only:
   * NEVER fed to the AI (that stays bounded to {@link priorHistory}), so the
   * context window and request payload are unaffected.
   */
  renderedHistory: Message[];
  /** Structured profile slots — the typed counterpart to profileSummary. */
  learnerName: string | null;
  interests: string[];
  /** Durable personal facts (location, occupation, family…) — never decayed. */
  profileFacts: Record<string, string>;
  /** Daily-streak state — surfaced in settings only. */
  streakCount: number;
  lastSessionDate: string | null;
  /** First-launch date (YYYY-MM-DD local) — anchors the money-back guarantee. */
  firstLaunchDate: string | null;
  /**
   * True only for genuine first-time installs — the money-back guarantee tracker
   * is shown to these users. Decided once: an install that already shows prior
   * usage when this flag is first resolved (an upgrade) is treated as existing.
   */
  isFirstTimeUser: boolean;
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
  renderedHistory: [],
  learnerName: null,
  interests: [],
  profileFacts: {},
  streakCount: 0,
  lastSessionDate: null,
  firstLaunchDate: null,
  isFirstTimeUser: true,
  turnsSinceConsolidation: 0,
};

/** Messages fed to the AI as resume context (spec §3.2) — bounded window. */
const AI_HISTORY_WINDOW = 12;
/** Messages restored to the on-screen backlog so a returning user can scroll
 *  back and reference past turns. Display-only — never sent to the AI. */
const TRANSCRIPT_BACKLOG_LIMIT = 200;

/** Parse the persisted durable-facts JSON into a bounded key→value map. */
function parseProfileFacts(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof k === 'string' && typeof v === 'string' && k.trim() && v.trim()) {
        out[k.trim()] = v.trim();
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Today as YYYY-MM-DD local (kept local to avoid a streak.ts import cycle). */
function todayLocalDate(): string {
  return new Date().toLocaleDateString('en-CA');
}

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
    // Anchor the guarantee window + first-time status on the very first launch.
    const { firstLaunchDate, isFirstTimeUser } = await resolveGuaranteeAnchor(kv);
    if (kv.size === 0) return { ...DEFAULT_STATE, firstLaunchDate, isFirstTimeUser };

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
    const profileFacts = parseProfileFacts(kv.get('profileFacts'));

    // One read serves both: the full backlog is rendered for the user to scroll,
    // while only its tail (the bounded AI window) is handed to Marie as context.
    const backlog = await loadRecentMessages(TRANSCRIPT_BACKLOG_LIMIT);

    return {
      hasOnboarded: kv.get('hasOnboarded') === 'true',
      onboardingChoice: (kv.get('onboardingChoice') as OnboardingChoice) ?? null,
      level: (kv.get('level') as Level) ?? 'B',
      settings: kv.get('settings')
        ? sanitizeSettings(JSON.parse(kv.get('settings')!))
        : DEFAULT_SETTINGS,
      profileSummary: kv.get('profileSummary') ?? '',
      gapSinceLastSession: gap,
      priorHistory: backlog.slice(-AI_HISTORY_WINDOW),
      renderedHistory: backlog,
      learnerName,
      interests,
      profileFacts,
      streakCount,
      lastSessionDate: (kv.get('lastSessionDate') || null) ?? null,
      firstLaunchDate,
      isFirstTimeUser,
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
  profileFacts?: Record<string, string>;
}): Promise<void> {
  const entries: Record<string, string> = {};
  if (input.learnerName !== undefined) {
    entries.learnerName = input.learnerName ?? '';
  }
  if (input.interests !== undefined) {
    entries.interests = input.interests.join(',');
  }
  if (input.profileFacts !== undefined) {
    entries.profileFacts = JSON.stringify(input.profileFacts);
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

/**
 * Resolve the guarantee anchor (first-launch date) and whether this is a genuine
 * first-time install — both decided once and persisted. An install that already
 * shows prior usage at resolve time (i.e. an upgrade from before this feature) is
 * treated as an existing user, so the money-back tracker stays hidden for them.
 */
async function resolveGuaranteeAnchor(
  kv: Map<string, string>,
): Promise<{ firstLaunchDate: string; isFirstTimeUser: boolean }> {
  const storedDate = (kv.get('firstLaunchDate') ?? '').trim();
  const storedFlag = kv.get('guaranteeFirstTimeUser');

  // Already resolved on a prior launch — trust the stored decision.
  if (storedDate && storedFlag != null) {
    return { firstLaunchDate: storedDate, isFirstTimeUser: storedFlag === '1' };
  }

  // First resolve. An existing install betrays itself via prior usage signals.
  const existingUser =
    kv.get('hasOnboarded') === 'true' ||
    (kv.get('lastActiveAt') ?? '').trim() !== '' ||
    Number(kv.get('streakCount') ?? '0') > 0;

  const firstLaunchDate = storedDate || todayLocalDate();
  const isFirstTimeUser = storedFlag != null ? storedFlag === '1' : !existingUser;
  await saveKv({
    firstLaunchDate,
    guaranteeFirstTimeUser: isFirstTimeUser ? '1' : '0',
  });
  return { firstLaunchDate, isFirstTimeUser };
}

/**
 * Add practice seconds to a given local day's running total (upsert). Drives the
 * 10-minute-a-day streak and the consecutive-day guarantee. Best-effort.
 */
export async function addDailyActivity(date: string, seconds: number): Promise<void> {
  const add = Math.max(0, Math.round(seconds));
  if (add === 0) return;
  const db = await getDb();
  if (!db) return;
  try {
    await db.runAsync(
      'INSERT INTO daily_activity (date, seconds) VALUES (?, ?) ' +
        'ON CONFLICT(date) DO UPDATE SET seconds = seconds + excluded.seconds',
      date,
      add,
    );
  } catch {
    // Best-effort — streak is engagement polish, never blocks the turn.
  }
}

/** Per-day practice seconds, most recent first. Powers the streak calendar. */
export async function loadDailyActivity(
  limit = 120,
): Promise<{ date: string; seconds: number }[]> {
  const db = await getDb();
  if (!db) return [];
  try {
    return await db.getAllAsync<{ date: string; seconds: number }>(
      'SELECT date, seconds FROM daily_activity ORDER BY date DESC LIMIT ?',
      limit,
    );
  } catch {
    return [];
  }
}

/** Wipe all daily-activity history — part of "Delete all my data". */
export async function clearDailyActivity(): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await db.runAsync('DELETE FROM daily_activity');
  } catch {
    // Best-effort.
  }
}

/**
 * The last streak milestone at which the user dismissed the sign-in nudge
 * (0 = never). Drives the escalating, non-nagging anonymous sign-in prompt.
 */
export async function loadSignInNudgeDismissed(): Promise<number> {
  try {
    const db = await getDb();
    if (!db) return 0;
    const row = await db.getFirstAsync<{ value: string }>(
      'SELECT value FROM kv WHERE key = ?',
      'signInNudgeDismissed',
    );
    const n = Number(row?.value ?? '0');
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

export function saveSignInNudgeDismissed(milestone: number): Promise<void> {
  return saveKv({ signInNudgeDismissed: String(Math.max(0, Math.floor(milestone))) });
}

/**
 * The local day (YYYY-MM-DD) we last showed the "streak day complete" celebration,
 * so it fires once per day — not again on every relaunch after the goal is met.
 */
export async function loadStreakCelebratedDate(): Promise<string | null> {
  try {
    const db = await getDb();
    if (!db) return null;
    const row = await db.getFirstAsync<{ value: string }>(
      'SELECT value FROM kv WHERE key = ?',
      'streakCelebratedDate',
    );
    const v = (row?.value ?? '').trim();
    return v ? v : null;
  } catch {
    return null;
  }
}

export function saveStreakCelebratedDate(date: string): Promise<void> {
  return saveKv({ streakCelebratedDate: date });
}

/** Persist the consolidation counter so it survives a relaunch. */
export function saveTurnsSinceConsolidation(count: number): Promise<void> {
  return saveKv({
    turnsSinceConsolidation: String(Math.max(0, Math.floor(count))),
  });
}

/** Full structured-profile wipe — used by "Delete all my data". */
export function clearStructuredProfile(): Promise<void> {
  return saveKv({ learnerName: '', interests: '', profileFacts: '{}' });
}

/** Full streak wipe — used by "Delete all my data". */
export function clearStreak(): Promise<void> {
  return saveKv({
    streakCount: '0',
    lastSessionDate: '',
    turnsSinceConsolidation: '0',
    streakCelebratedDate: '',
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

/**
 * The Supabase uid that "owns" the local account-scoped data on this device.
 * Device-scoped metadata: survives sign-out, is NOT touched by any clear*() and
 * is NOT synced. The sign-in guard compares it to the incoming uid to decide
 * whether a different account is taking over (and the local data must be wiped).
 */
const ACTIVE_UID_KEY = 'activeAccountUid';

export async function loadActiveAccountUid(): Promise<string | null> {
  const map = await readKv();
  const v = map.get(ACTIVE_UID_KEY);
  return v ? v : null; // '' means none
}

export function saveActiveAccountUid(uid: string | null): Promise<void> {
  return saveKv({ [ACTIVE_UID_KEY]: uid ?? '' });
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
