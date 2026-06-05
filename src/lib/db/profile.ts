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
const SUMMARY_MAX = 18;
/** Hard cap on profile_notes rows — keeps SQLite small after months of use. */
const RETENTION_MAX = 200;

/**
 * Store this turn's profile observations.
 *
 * Frequency-aware: an exact (case-insensitive) match increments a counter
 * rather than inserting a duplicate row. The counter is what the summary then
 * ranks on — repeated observations rise to the top, one-offs fade.
 */
export async function addProfileNotes(notes: string[]): Promise<void> {
  if (notes.length === 0) return;
  const db = await getDb();
  if (!db) return;
  try {
    const now = Date.now();
    await db.withTransactionAsync(async () => {
      for (const note of notes) {
        const trimmed = note.trim();
        if (!trimmed) continue;
        const upd = await db.runAsync(
          'UPDATE profile_notes SET count = count + 1, created_at = ? ' +
            'WHERE LOWER(note) = LOWER(?)',
          now,
          trimmed,
        );
        if (upd.changes === 0) {
          await db.runAsync(
            'INSERT INTO profile_notes (note, created_at, count) VALUES (?, ?, 1)',
            trimmed,
            now,
          );
        }
      }
      // Retention cap — only sweep when the table has actually exceeded the
      // cap, so we skip a pointless DELETE on every turn for typical users.
      const row = await db.getFirstAsync<{ c: number }>(
        'SELECT COUNT(*) AS c FROM profile_notes',
      );
      if ((row?.c ?? 0) > RETENTION_MAX) {
        await db.runAsync(
          'DELETE FROM profile_notes WHERE id NOT IN (' +
            'SELECT id FROM profile_notes ORDER BY count DESC, created_at DESC LIMIT ?' +
            ')',
          RETENTION_MAX,
        );
      }
    });
  } catch {
    // Best-effort.
  }
}

/**
 * Condense the recent profile notes into a compact summary string for the
 * system prompt — frequency-ranked, then most recent.
 */
export async function buildProfileSummary(): Promise<string> {
  const db = await getDb();
  if (!db) return '';
  try {
    const rows = await db.getAllAsync<{ note: string }>(
      'SELECT note FROM profile_notes ORDER BY count DESC, created_at DESC LIMIT ?',
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

/** Row shape sent to the consolidate endpoint and rebuilt after merge. */
export interface ProfileNoteRow {
  id?: number;
  note: string;
  count: number;
}

/** Read every note for an LLM-driven semantic consolidation pass. */
export async function getAllNotesForConsolidation(): Promise<ProfileNoteRow[]> {
  const db = await getDb();
  if (!db) return [];
  try {
    const rows = await db.getAllAsync<{ id: number; note: string; count: number }>(
      'SELECT id, note, count FROM profile_notes ORDER BY count DESC, created_at DESC',
    );
    return rows.map((r) => ({ id: r.id, note: r.note, count: r.count }));
  } catch {
    return [];
  }
}

/** Count rows — used to gate consolidation triggers. */
export async function countProfileNotes(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  try {
    const row = await db.getFirstAsync<{ c: number }>(
      'SELECT COUNT(*) AS c FROM profile_notes',
    );
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

/** Atomically replace the entire notes table with a canonical merged set. */
export async function replaceNotes(canonical: ProfileNoteRow[]): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    const now = Date.now();
    await db.withTransactionAsync(async () => {
      await db.runAsync('DELETE FROM profile_notes');
      for (const row of canonical) {
        const trimmed = row.note.trim();
        if (!trimmed) continue;
        const c = Math.max(1, Math.floor(row.count) || 1);
        await db.runAsync(
          'INSERT INTO profile_notes (note, created_at, count) VALUES (?, ?, ?)',
          trimmed,
          now,
          c,
        );
      }
    });
  } catch {
    // Best-effort.
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
