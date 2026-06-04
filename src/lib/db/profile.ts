/**
 * The learning profile (spec §5.4) — the intelligence layer that makes Parlez
 * more useful over time. The AI emits free-text observations each turn
 * (recurring errors, vocabulary gaps, confident vs. hesitant topics); they are
 * stored here and condensed into a compact summary for the next system prompt.
 *
 * The profile is per-user, persists across sessions, and is never shown to the
 * user. It resets only on explicit request (spec §5.4.2).
 */
import { getDb } from './index';

/** How many recent notes to consider when building the summary. */
const SUMMARY_WINDOW = 40;
/** How many distinct notes to keep in the summary. */
const SUMMARY_MAX = 12;

/** Store this turn's profile observations. */
export async function addProfileNotes(notes: string[]): Promise<void> {
  if (notes.length === 0) return;
  const db = await getDb();
  if (!db) return;
  try {
    const now = Date.now();
    for (const note of notes) {
      const trimmed = note.trim();
      if (trimmed) {
        await db.runAsync(
          'INSERT INTO profile_notes (note, created_at) VALUES (?, ?)',
          trimmed,
          now,
        );
      }
    }
  } catch {
    // Best-effort.
  }
}

/**
 * Condense the recent profile notes into a compact summary string for the
 * system prompt — most recent distinct observations first.
 */
export async function buildProfileSummary(): Promise<string> {
  const db = await getDb();
  if (!db) return '';
  try {
    const rows = await db.getAllAsync<{ note: string }>(
      'SELECT note FROM profile_notes ORDER BY created_at DESC LIMIT ?',
      SUMMARY_WINDOW,
    );
    const seen = new Set<string>();
    const distinct: string[] = [];
    for (const r of rows) {
      const key = r.note.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        distinct.push(r.note);
        if (distinct.length >= SUMMARY_MAX) break;
      }
    }
    return distinct.map((n) => `- ${n}`).join('\n');
  } catch {
    return '';
  }
}

/** Wipe the learning profile — part of "Clear session history" (spec §4.5, §5.4.2). */
export async function clearProfile(): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await db.runAsync('DELETE FROM profile_notes');
  } catch {
    // Best-effort.
  }
}
