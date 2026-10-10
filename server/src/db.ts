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
  addChatExtras(db);
  addOrganization(db);
  return db;
}

const hasColumn = (db: Db, table: string, column: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
const addColumn = (db: Db, table: string, column: string, type: string) => {
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
};

/** Added with the chat and messages update: pins, saved messages, threads, polls, search and the rest. */
function addChatExtras(db: Db) {
  // Pinned messages, forwarded messages (a JSON note of where it came from), stickers,
  // and whether the author hid its link previews.
  addColumn(db, 'messages', 'pinned_at', 'INTEGER');
  addColumn(db, 'messages', 'pinned_by', 'INTEGER');
  addColumn(db, 'messages', 'forwarded', 'TEXT');
  addColumn(db, 'messages', 'sticker_id', 'INTEGER');
  addColumn(db, 'messages', 'embeds_off', 'INTEGER NOT NULL DEFAULT 0');
  // Pictures hidden until tapped, and recorded voice messages (their length).
  addColumn(db, 'attachments', 'spoiler', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'attachments', 'voice_seconds', 'REAL');
  // A thread is a room of kind 'thread' that hangs off one message in another room.
  addColumn(db, 'channels', 'parent_id', 'INTEGER REFERENCES channels(id) ON DELETE CASCADE');
  addColumn(db, 'channels', 'parent_message_id', 'INTEGER REFERENCES messages(id) ON DELETE SET NULL');
  addColumn(db, 'channels', 'created_by', 'INTEGER');
  // "Seen" in direct messages: shown only when both people leave it on.
  addColumn(db, 'users', 'read_receipts', 'INTEGER NOT NULL DEFAULT 1');
  const hadReadState = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'read_state'").get();
  const hadSearch = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'").get();
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS threads_by_message ON channels(parent_message_id);
    CREATE INDEX IF NOT EXISTS channels_by_parent ON channels(parent_id);
    CREATE TABLE IF NOT EXISTS message_edits (
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      content    TEXT NOT NULL,
      edited_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS message_edits_by_message ON message_edits(message_id);
    CREATE TABLE IF NOT EXISTS saved_messages (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      saved_at   INTEGER NOT NULL,
      remind_at  INTEGER,
      reminded   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS saved_by_reminder ON saved_messages(remind_at) WHERE remind_at IS NOT NULL AND reminded = 0;
    -- The newest message each person has read in each room.
    CREATE TABLE IF NOT EXISTS read_state (
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel_id   INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      last_read_id INTEGER NOT NULL,
      PRIMARY KEY (user_id, channel_id)
    );
    CREATE TABLE IF NOT EXISTS scheduled_messages (
      id         INTEGER PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      content    TEXT NOT NULL,
      reply_to   INTEGER,
      send_at    INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS scheduled_by_time ON scheduled_messages(send_at);
    CREATE TABLE IF NOT EXISTS polls (
      message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      question   TEXT NOT NULL,
      options    TEXT NOT NULL, -- JSON list of answers
      multi      INTEGER NOT NULL DEFAULT 0,
      closes_at  INTEGER,
      ended      INTEGER NOT NULL DEFAULT 0 -- everyone has been told it closed
    );
    CREATE TABLE IF NOT EXISTS poll_votes (
      message_id INTEGER NOT NULL REFERENCES polls(message_id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      option     INTEGER NOT NULL,
      PRIMARY KEY (message_id, user_id, option)
    );
    -- Each burrow's own emoji and stickers. The picture lives in uploads/emoji.
    CREATE TABLE IF NOT EXISTS custom_emoji (
      id         INTEGER PRIMARY KEY,
      server_id  INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      kind       TEXT NOT NULL, -- 'emoji' or 'sticker'
      file       TEXT NOT NULL,
      created_by INTEGER,
      created_at INTEGER NOT NULL,
      UNIQUE (server_id, kind, name)
    );
    -- Link previews worked out for a message, in the order the links appear.
    CREATE TABLE IF NOT EXISTS message_embeds (
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      position   INTEGER NOT NULL,
      data       TEXT NOT NULL,
      PRIMARY KEY (message_id, position)
    );
    -- Secrets the server makes for itself once, like the key that signs link preview picture links.
    CREATE TABLE IF NOT EXISTS app_secrets (
      name  TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    -- Word search over messages, kept in step with the messages table.
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content, content='messages', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE OF content ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;
  `);
  if (!hadSearch) db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");
  // Everything already in the database counts as read, so nobody starts with a wall of unread rooms.
  if (!hadReadState)
    db.exec(`INSERT OR IGNORE INTO read_state (user_id, channel_id, last_read_id)
             SELECT m.user_id, c.id, COALESCE((SELECT MAX(id) FROM messages WHERE channel_id = c.id), 0)
             FROM members m JOIN channels c ON c.server_id = m.server_id`);
}

/** Added with the rooms, burrows and organization update. */
function addOrganization(db: Db) {
  // Rooms: their place in the list, an optional heading they sit under, a topic line,
  // slow mode, announcement rooms (only some roles post) and archiving.
  addColumn(db, 'channels', 'position', 'INTEGER');
  addColumn(db, 'channels', 'group_id', 'INTEGER REFERENCES room_groups(id) ON DELETE SET NULL');
  addColumn(db, 'channels', 'topic', "TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'channels', 'slow_seconds', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'channels', 'announce', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'channels', 'archived_at', 'INTEGER');
  // Burrows: a banner and blurb, a welcome room and rules. Group DMs use the name too.
  addColumn(db, 'servers', 'description', "TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'servers', 'banner', 'TEXT');
  addColumn(db, 'servers', 'welcome_channel_id', 'INTEGER');
  addColumn(db, 'servers', 'rules', "TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'members', 'rules_accepted_at', 'INTEGER');
  // Your own folders of burrows, as JSON: [{ id, name, serverIds }].
  addColumn(db, 'users', 'burrow_folders', "TEXT NOT NULL DEFAULT '[]'");
  db.exec(`
    CREATE TABLE IF NOT EXISTS room_groups (
      id        INTEGER PRIMARY KEY,
      server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      name      TEXT NOT NULL,
      position  INTEGER NOT NULL
    );
    -- Roles that may post in an announcement room (people who manage rooms always can).
    CREATE TABLE IF NOT EXISTS channel_post_roles (
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      role_id    INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      PRIMARY KEY (channel_id, role_id)
    );
    -- Invite links with a time or use limit, on top of each burrow's permanent code.
    CREATE TABLE IF NOT EXISTS invites (
      code       TEXT PRIMARY KEY,
      server_id  INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      max_uses   INTEGER,
      uses       INTEGER NOT NULL DEFAULT 0
    );
    -- How loudly each room or burrow tells you about messages. channel_id 0 is the whole burrow.
    -- level: 'all', 'mentions' or 'none' (null: follow the burrow, or the usual).
    CREATE TABLE IF NOT EXISTS notify_prefs (
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      channel_id  INTEGER NOT NULL DEFAULT 0,
      level       TEXT,
      muted_until INTEGER, -- -1: until turned back on
      PRIMARY KEY (user_id, server_id, channel_id)
    );
    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY,
      server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      channel_id  INTEGER REFERENCES channels(id) ON DELETE SET NULL, -- where it happens, if anywhere
      title       TEXT NOT NULL,
      details     TEXT NOT NULL DEFAULT '',
      starts_at   INTEGER NOT NULL,
      created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at  INTEGER NOT NULL,
      reminded    INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS events_by_server ON events(server_id, starts_at);
    CREATE TABLE IF NOT EXISTS event_rsvps (
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status   TEXT NOT NULL, -- 'going', 'maybe' or 'no'
      PRIMARY KEY (event_id, user_id)
    );
  `);
}

/** Every new burrow starts with a Moderator role, which the host can change or delete. */
export function addModeratorRole(db: Db, serverId: number) {
  const r = db
    .prepare("INSERT INTO roles (server_id, name, color, perms, position, created_at) VALUES (?, 'Moderator', '#4f8a5b', 'rooms,messages,remove,ban', 1, ?)")
    .run(serverId, Date.now());
  return Number(r.lastInsertRowid);
}
