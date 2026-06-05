/**
 * SQLite connection — native implementation (spec §7.2). Opened lazily and
 * migrated once.
 *
 * Web uses `index.web.ts` instead, a no-op stub: expo-sqlite's web build needs
 * wasm asset setup the app does not require, so persistence is native-only and
 * the app runs fully in memory on web. Metro picks the right file per platform.
 */
import * as SQLite from 'expo-sqlite';

import { SCHEMA } from './schema';

export const PERSISTENCE_ENABLED = true;

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

/** Returns the migrated database, or null if it cannot be opened. */
export async function getDb(): Promise<SQLite.SQLiteDatabase | null> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync('parlez.db');
      await db.execAsync(SCHEMA);
      // Migrate pre-existing message tables that lack the translation column.
      // Harmless on fresh databases (the column already exists → ignored).
      try {
        await db.execAsync('ALTER TABLE messages ADD COLUMN translation TEXT');
      } catch {
        // Column already present.
      }
      try {
        await db.execAsync(
          'ALTER TABLE profile_notes ADD COLUMN count INTEGER NOT NULL DEFAULT 1',
        );
      } catch {
        // Column already present.
      }
      try {
        await db.execAsync(
          'CREATE INDEX IF NOT EXISTS idx_profile_count ON profile_notes (count)',
        );
      } catch {
        // Index already present.
      }
      return db;
    })();
  }
  try {
    return await dbPromise;
  } catch {
    dbPromise = null;
    return null;
  }
}
