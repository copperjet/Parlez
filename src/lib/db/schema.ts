/**
 * Local SQLite schema (spec §7.2, §7.4). Three tables:
 *   kv             — scalar app state (onboarding, level, settings, profile summary)
 *   messages       — the full conversation transcript across sessions
 *   profile_notes  — raw learning-profile observations emitted by the AI
 *
 * The transcript and profile feed the AI's context; they are never persisted as
 * voice audio — audio is discarded after STT (spec §8).
 */
export const SCHEMA = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY NOT NULL,
  value TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY NOT NULL,
  speaker     TEXT NOT NULL,
  text        TEXT NOT NULL,
  corrections TEXT,
  translation TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages (created_at);

CREATE TABLE IF NOT EXISTS profile_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  note       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  count      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_profile_created ON profile_notes (created_at);
CREATE INDEX IF NOT EXISTS idx_profile_count ON profile_notes (count);

CREATE TABLE IF NOT EXISTS daily_activity (
  date    TEXT PRIMARY KEY NOT NULL,  -- YYYY-MM-DD local
  seconds INTEGER NOT NULL DEFAULT 0  -- practice seconds accumulated that day
);
`;
