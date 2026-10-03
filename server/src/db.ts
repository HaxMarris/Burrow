import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = DatabaseSync;

export function openDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY,
      username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS servers (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      owner_id    INTEGER NOT NULL REFERENCES users(id),
      invite_code TEXT NOT NULL UNIQUE,
      created_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS members (
      server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (server_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS channels (
      id         INTEGER PRIMARY KEY,
      server_id  INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id         INTEGER PRIMARY KEY,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      author_id  INTEGER NOT NULL REFERENCES users(id),
      content    TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      edited_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS messages_by_channel ON messages(channel_id, id);
  `);
  return db;
}
