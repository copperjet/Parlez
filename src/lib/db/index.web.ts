/**
 * SQLite connection — web stub. Persistence is native-only (see index.ts).
 * On web every db helper sees `getDb()` return null and degrades to a no-op,
 * so the app runs fully in memory. Metro picks this file for web builds.
 */
import type { SQLiteDatabase } from 'expo-sqlite';

export const PERSISTENCE_ENABLED = false;

/** Always null on web — persistence is disabled here. */
export async function getDb(): Promise<SQLiteDatabase | null> {
  return null;
}
