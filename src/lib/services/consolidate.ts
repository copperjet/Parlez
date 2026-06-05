/**
 * Periodic LLM-driven merge of the raw profile_notes log into a canonical set
 * (spec §5.4 — extension). Called rarely (gated by a turn counter), fire-and-
 * forget — never blocks Marie's reply. Mock service returns null.
 */
import { ENV, functionsBase, useSupabaseService } from '@/lib/env';
import type { ProfileNoteRow } from '@/lib/db/profile';

interface ConsolidateResult {
  canonical: ProfileNoteRow[];
}

function authHeaders(): Record<string, string> {
  return {
    apikey: ENV.supabaseAnonKey,
    Authorization: `Bearer ${ENV.supabaseAnonKey}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Send the current notes and summary to the turn function in `consolidate`
 * mode. Returns the canonical merged list, or null when not available (mock,
 * offline, or transport error).
 */
export async function consolidateProfile(
  notes: ProfileNoteRow[],
  summary: string,
): Promise<ProfileNoteRow[] | null> {
  if (!useSupabaseService || notes.length === 0) return null;
  try {
    const res = await fetch(`${functionsBase()}/turn`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        mode: 'consolidate',
        notes: notes.map((n) => ({ note: n.note, count: n.count })),
        summary,
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<ConsolidateResult>;
    if (!Array.isArray(data.canonical)) return null;
    const cleaned: ProfileNoteRow[] = [];
    for (const row of data.canonical) {
      if (!row || typeof row.note !== 'string') continue;
      const note = row.note.trim();
      if (!note) continue;
      const count =
        typeof row.count === 'number' && row.count > 0 ? Math.floor(row.count) : 1;
      cleaned.push({ note, count });
    }
    return cleaned;
  } catch {
    return null;
  }
}
