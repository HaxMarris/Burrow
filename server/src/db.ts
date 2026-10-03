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
    CREATE TABLE IF NOT EXISTS attachments (
      id          TEXT PRIMARY KEY,
      channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      uploader_id INTEGER NOT NULL REFERENCES users(id),
      message_id  INTEGER REFERENCES messages(id) ON DELETE CASCADE,
      position    INTEGER NOT NULL DEFAULT 0,
      name        TEXT NOT NULL,
      type        TEXT NOT NULL,
      size        INTEGER NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS attachments_by_message ON attachments(message_id);
    CREATE TABLE IF NOT EXISTS reactions (
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji      TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (message_id, user_id, emoji)
    );
  `);
  // Added with voice rooms: 'text' or 'voice'.
  const channelCols = db.prepare('PRAGMA table_info(channels)').all() as { name: string }[];
  if (!channelCols.some((c) => c.name === 'kind'))
    db.exec("ALTER TABLE channels ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'");
  // Added with replies: the message this one answers (it may since have been deleted).
  const messageCols = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[];
  if (!messageCols.some((c) => c.name === 'reply_to')) db.exec('ALTER TABLE messages ADD COLUMN reply_to INTEGER');
  // Added with profile pictures: the picture's file name in the uploads folder.
  const userCols = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
  if (!userCols.some((c) => c.name === 'avatar')) db.exec('ALTER TABLE users ADD COLUMN avatar TEXT');
  // Added with direct messages: a DM is a tiny private 'dm' server with two members and one room.
  // dm_key ("smallerId:largerId") keeps it to one conversation per pair of people.
  const serverCols = db.prepare('PRAGMA table_info(servers)').all() as { name: string }[];
  if (!serverCols.some((c) => c.name === 'kind')) db.exec("ALTER TABLE servers ADD COLUMN kind TEXT NOT NULL DEFAULT 'burrow'");
  if (!serverCols.some((c) => c.name === 'dm_key')) db.exec('ALTER TABLE servers ADD COLUMN dm_key TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS servers_by_dm_key ON servers(dm_key)');
  // Added with roles: 'member' or 'mod' (the host is servers.owner_id), private rooms, and bans.
  const memberCols = db.prepare('PRAGMA table_info(members)').all() as { name: string }[];
  if (!memberCols.some((c) => c.name === 'role')) db.exec("ALTER TABLE members ADD COLUMN role TEXT NOT NULL DEFAULT 'member'");
  if (!channelCols.some((c) => c.name === 'private')) db.exec('ALTER TABLE channels ADD COLUMN private INTEGER NOT NULL DEFAULT 0');
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_access (
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (channel_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS bans (
      server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      banned_at INTEGER NOT NULL,
      PRIMARY KEY (server_id, user_id)
    );
  `);
  return db;
}
