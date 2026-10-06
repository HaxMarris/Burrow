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
  // Added with burrow pictures: the picture's file name in uploads/burrow-pictures.
  if (!serverCols.some((c) => c.name === 'icon')) db.exec('ALTER TABLE servers ADD COLUMN icon TEXT');
  // Added with moderators: 'member' or 'mod'. Replaced by custom roles below, and only read to move moderators over.
  // Private rooms and bans came at the same time.
  const memberCols = db.prepare('PRAGMA table_info(members)').all() as { name: string }[];
  if (!memberCols.some((c) => c.name === 'role')) db.exec("ALTER TABLE members ADD COLUMN role TEXT NOT NULL DEFAULT 'member'");
  // Your favorite burrows (up to 5) are shown in the top bar, in this order: 1 first. NULL = not a favorite.
  if (!memberCols.some((c) => c.name === 'favorite')) db.exec('ALTER TABLE members ADD COLUMN favorite INTEGER');
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
  // Added with login expiry: when the login was last used (null means its created_at).
  const sessionCols = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
  if (!sessionCols.some((c) => c.name === 'last_used_at')) db.exec('ALTER TABLE sessions ADD COLUMN last_used_at INTEGER');
  // Added with custom roles: each burrow has its own roles with a name, a color and permissions.
  // position 1 is the top role; people can only act on those below their own highest role.
  const hadRoles = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'roles'").get();
  db.exec(`
    CREATE TABLE IF NOT EXISTS roles (
      id         INTEGER PRIMARY KEY,
      server_id  INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      color      TEXT NOT NULL,
      perms      TEXT NOT NULL DEFAULT '',
      position   INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS member_roles (
      server_id INTEGER NOT NULL,
      user_id   INTEGER NOT NULL,
      role_id   INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      PRIMARY KEY (role_id, user_id),
      FOREIGN KEY (server_id, user_id) REFERENCES members(server_id, user_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS member_roles_by_member ON member_roles(server_id, user_id);
    CREATE TABLE IF NOT EXISTS channel_role_access (
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      role_id    INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      PRIMARY KEY (channel_id, role_id)
    );
  `);
  // Burrows from before custom roles get a Moderator role, given to everyone who was a moderator.
  if (!hadRoles) {
    for (const { id } of db.prepare("SELECT id FROM servers WHERE kind = 'burrow'").all() as { id: number }[]) {
      const roleId = addModeratorRole(db, id);
      db.prepare("INSERT INTO member_roles (server_id, user_id, role_id) SELECT server_id, user_id, ? FROM members WHERE server_id = ? AND role = 'mod'").run(roleId, id);
    }
  }
  return db;
}

/** Every new burrow starts with a Moderator role, which the host can change or delete. */
export function addModeratorRole(db: Db, serverId: number) {
  const r = db
    .prepare("INSERT INTO roles (server_id, name, color, perms, position, created_at) VALUES (?, 'Moderator', '#4f8a5b', 'rooms,messages,remove,ban', 1, ?)")
    .run(serverId, Date.now());
  return Number(r.lastInsertRowid);
}
