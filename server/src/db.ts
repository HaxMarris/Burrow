import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = DatabaseSync;

/**
 * Preparing SQL takes longer than running it, and the same few hundred queries run over and over
 * (some once per person in a burrow), so each prepared statement is kept and reused.
 */
export function withStatementCache(db: Db): Db {
  const cache = new Map<string, ReturnType<Db['prepare']>>();
  const prepare = (sql: string) => {
    let st = cache.get(sql);
    if (st) {
      // Most recently used last, so the oldest go first when it's full.
      cache.delete(sql);
      cache.set(sql, st);
      return st;
    }
    st = db.prepare(sql);
    cache.set(sql, st);
    // Queries with a list of ids in them differ each time; don't let those pile up.
    if (cache.size > 1000) cache.delete(cache.keys().next().value!);
    return st;
  };
  return new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') return prepare;
      const v = Reflect.get(target, key, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

/** Runs `fn` as one transaction: all of its changes, or (if it throws) none. */
export function inTransaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

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
  addVoiceExtras(db);
  addPresence(db);
  addModeration(db);
  addStreaming(db);
  addProfiles(db);
  addMediaSizes(db);
  addHosting(db);
  hashSessionTokens(db);
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

/** Added with the voice and Campfire update: seat limits, kept fireside chat, the AFK fire, server mute and the soundboard. */
function addVoiceExtras(db: Db) {
  addColumn(db, 'channels', 'user_limit', 'INTEGER NOT NULL DEFAULT 0'); // seats at a fire; 0 is no limit
  addColumn(db, 'channels', 'keep_chat', 'INTEGER NOT NULL DEFAULT 0'); // fireside chat stays after everyone leaves
  addColumn(db, 'servers', 'afk_channel_id', 'INTEGER'); // where idle people are moved
  addColumn(db, 'servers', 'afk_minutes', 'INTEGER NOT NULL DEFAULT 15');
  addColumn(db, 'members', 'voice_muted', 'INTEGER NOT NULL DEFAULT 0'); // muted for everyone by a moderator
  db.exec(`
    -- Fireside chat for fires that keep it; other fires keep theirs in memory only.
    CREATE TABLE IF NOT EXISTS fireside_messages (
      id         INTEGER PRIMARY KEY,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      author     TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS fireside_by_channel ON fireside_messages(channel_id, id);
    -- Short clips anyone at a burrow's fire can play for everyone there.
    CREATE TABLE IF NOT EXISTS sounds (
      id         INTEGER PRIMARY KEY,
      server_id  INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      emoji      TEXT NOT NULL DEFAULT '',
      file       TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL
    );
  `);
}

/** Added with the notifications and presence update: status, push, the mentions inbox, quiet hours and email. */
function addPresence(db: Db) {
  addColumn(db, 'users', 'status', "TEXT NOT NULL DEFAULT 'online'"); // 'online', 'away' or 'dnd'
  addColumn(db, 'users', 'status_text', 'TEXT');
  addColumn(db, 'users', 'status_emoji', 'TEXT');
  addColumn(db, 'users', 'status_until', 'INTEGER'); // when the custom status clears itself
  addColumn(db, 'users', 'quiet_start', 'INTEGER'); // minutes after midnight, in time_zone
  addColumn(db, 'users', 'quiet_end', 'INTEGER');
  addColumn(db, 'users', 'time_zone', 'TEXT');
  addColumn(db, 'users', 'email', 'TEXT');
  addColumn(db, 'users', 'email_verified', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'users', 'email_code', 'TEXT');
  addColumn(db, 'users', 'email_code_expires', 'INTEGER');
  addColumn(db, 'users', 'reset_code', 'TEXT'); // sha256 of the emailed code for a forgotten password
  addColumn(db, 'users', 'reset_expires', 'INTEGER');
  addColumn(db, 'users', 'reset_tries', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'messages', 'pings', 'TEXT'); // {"everyone":1,"here":1,"roles":[ids]} when the author may ping those
  const hadMentions = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mentions'").get();
  db.exec(`
    -- Phones and browsers that get alerts while Burrow is closed.
    CREATE TABLE IF NOT EXISTS push_subs (
      id         INTEGER PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint   TEXT NOT NULL UNIQUE,
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    -- Who each message is for: @name, a reply, @everyone, @here or one of their roles.
    CREATE TABLE IF NOT EXISTS mentions (
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (message_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS mentions_by_user ON mentions(user_id, message_id);
    -- Emails about missed mentions were dropped for password resets.
    DROP TABLE IF EXISTS missed_mentions;
  `);
  for (const col of ['email_mentions', 'last_mention_email'])
    if ((db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get('users', col))) db.exec(`ALTER TABLE users DROP COLUMN ${col}`);
  if (hadMentions) return;
  // Older messages: @names and replies, so the inbox starts full.
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const add = db.prepare('INSERT OR IGNORE INTO mentions (message_id, user_id) VALUES (?, ?)');
  const servers = db.prepare("SELECT id FROM servers WHERE kind = 'burrow'").all() as { id: number }[];
  for (const { id } of servers) {
    const members = db.prepare('SELECT u.id, u.username FROM members m JOIN users u ON u.id = m.user_id WHERE m.server_id = ?').all(id) as { id: number; username: string }[];
    const named = members.map((m) => ({ id: m.id, re: new RegExp(`@${escape(m.username)}\\b`, 'i') }));
    const rows = db
      .prepare(
        `SELECT m.id, m.author_id AS author, m.content, r.author_id AS repliedTo FROM messages m JOIN channels c ON c.id = m.channel_id
         LEFT JOIN messages r ON r.id = m.reply_to WHERE c.server_id = ? AND (m.content LIKE '%@%' OR m.reply_to IS NOT NULL)`,
      )
      .all(id) as { id: number; author: number | null; content: string; repliedTo: number | null }[];
    for (const row of rows) {
      for (const n of named) if (n.id !== row.author && n.re.test(row.content)) add.run(row.id, n.id);
      if (row.repliedTo && row.repliedTo !== row.author && members.some((m) => m.id === row.repliedTo)) add.run(row.id, row.repliedTo);
    }
  }
}

function addModeration(db: Db) {
  addColumn(db, 'members', 'timeout_until', 'INTEGER'); // can't write or talk until then
  addColumn(db, 'roles', 'upload_mb', 'INTEGER'); // largest upload for this role; null = the server's limit, 0 = none
  addColumn(db, 'servers', 'upload_mb', 'INTEGER'); // the same for people with no role that says otherwise
  addColumn(db, 'servers', 'word_filter', 'TEXT'); // {"words":[...],"action":"block"|"flag"}
  const hadAudit = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'").get();
  db.exec(`
    -- Who removed, banned, deleted or changed what in a burrow, and when.
    CREATE TABLE IF NOT EXISTS audit_log (
      id         INTEGER PRIMARY KEY,
      server_id  INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      actor_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action     TEXT NOT NULL,
      target_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      detail     TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audit_by_server ON audit_log(server_id, id);
    -- Messages someone (or the word filter) flagged for the people who look after the burrow.
    CREATE TABLE IF NOT EXISTS reports (
      id          INTEGER PRIMARY KEY,
      server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      message_id  INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      channel_id  INTEGER,
      author_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      content     TEXT NOT NULL DEFAULT '',
      reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL, -- null: the word filter
      reason      TEXT NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL,
      resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS reports_open ON reports(server_id, resolved_at);
    -- Roles that can read a room but not write in it.
    CREATE TABLE IF NOT EXISTS channel_read_only (
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      role_id    INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      PRIMARY KEY (channel_id, role_id)
    );
  `);
  if (hadAudit) return;
  // The new switches split off older ones, so roles keep doing what they could.
  const roles = db.prepare('SELECT id, perms FROM roles').all() as { id: number; perms: string }[];
  const add = db.prepare('UPDATE roles SET perms = ? WHERE id = ?');
  for (const r of roles) {
    const perms = new Set(r.perms.split(',').filter(Boolean));
    if (perms.has('messages')) perms.add('pin');
    if (perms.has('burrow')) perms.add('invites');
    if (perms.has('remove')) perms.add('timeout');
    if (perms.has('ban')) perms.add('audit');
    add.run([...perms].join(','), r.id);
  }
}

/** Added with the video and streaming update: "is live" announcements. */
function addStreaming(db: Db) {
  // The text room where "someone is live" is posted (null: not announced).
  addColumn(db, 'servers', 'live_channel_id', 'INTEGER REFERENCES channels(id) ON DELETE SET NULL');
  // A go-live announcement: JSON { voiceChannelId, endedAt }.
  addColumn(db, 'messages', 'live', 'TEXT');
  // Nobody is still live after a restart.
  db.prepare(`UPDATE messages SET live = json_set(live, '$.endedAt', ?) WHERE live IS NOT NULL AND json_extract(live, '$.endedAt') IS NULL`).run(Date.now());
}

/** Added with the profiles, friends and DMs update. */
function addProfiles(db: Db) {
  addColumn(db, 'users', 'display_name', 'TEXT'); // shown instead of the username when set
  addColumn(db, 'users', 'bio', "TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'users', 'banner', 'TEXT'); // picture file in uploads/avatars
  addColumn(db, 'users', 'accent', 'TEXT'); // '#rrggbb' for the profile card
  addColumn(db, 'users', 'totp_secret', 'TEXT'); // two-step login, when on
  addColumn(db, 'users', 'totp_pending', 'TEXT'); // being set up, not on yet
  addColumn(db, 'users', 'totp_last_step', 'INTEGER NOT NULL DEFAULT -1'); // so a code can't be used twice
  addColumn(db, 'users', 'recovery_codes', "TEXT NOT NULL DEFAULT '[]'"); // sha256 of each unused one
  addColumn(db, 'users', 'reset_link', 'TEXT'); // sha256 of a reset link made by whoever runs the server
  addColumn(db, 'users', 'reset_link_expires', 'INTEGER');
  addColumn(db, 'users', 'deleted_at', 'INTEGER');
  addColumn(db, 'members', 'nickname', 'TEXT'); // your name in one burrow
  addColumn(db, 'sessions', 'device', 'TEXT'); // the browser or app's user agent
  addColumn(db, 'sessions', 'ip', 'TEXT');
  db.exec(`
    -- A friend request, or (once accepted_at is set) a friendship. user_a < user_b.
    CREATE TABLE IF NOT EXISTS friends (
      user_a       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_b       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      requested_by INTEGER NOT NULL,
      created_at   INTEGER NOT NULL,
      accepted_at  INTEGER,
      PRIMARY KEY (user_a, user_b)
    );
    CREATE INDEX IF NOT EXISTS friends_by_b ON friends(user_b);
    CREATE TABLE IF NOT EXISTS blocks (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, blocked_id)
    );
    CREATE INDEX IF NOT EXISTS blocks_by_blocked ON blocks(blocked_id);
    CREATE TABLE IF NOT EXISTS passkeys (
      id           TEXT PRIMARY KEY, -- the credential id, base64url
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      public_key   TEXT NOT NULL, -- JWK
      alg          INTEGER NOT NULL,
      sign_count   INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL,
      last_used_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS passkeys_by_user ON passkeys(user_id);
  `);
}

/** Every new burrow starts with a Moderator role, which the host can change or delete. */
export function addModeratorRole(db: Db, serverId: number) {
  const r = db
    .prepare("INSERT INTO roles (server_id, name, color, perms, position, created_at) VALUES (?, 'Moderator', '#4f8a5b', 'rooms,messages,remove,ban,voice,everyone,pin,invites,timeout,audit', 1, ?)")
    .run(serverId, Date.now());
  return Number(r.lastInsertRowid);
}

/** Added with the speed and reliability update: picture and video sizes, and video thumbnails. */
function addMediaSizes(db: Db) {
  // Known before a picture or video loads, so its space is kept and the chat doesn't jump.
  addColumn(db, 'attachments', 'width', 'INTEGER');
  addColumn(db, 'attachments', 'height', 'INTEGER');
  // A small still from a video, stored next to it as <id>.thumb.
  addColumn(db, 'attachments', 'thumb', 'INTEGER NOT NULL DEFAULT 0');
}

/** Added with the hosting, admin and security update: signup links, bots, webhooks and error reports. */
function addHosting(db: Db) {
  // Bots are accounts that log in with a token instead of a password, made for one burrow.
  addColumn(db, 'users', 'bot', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'users', 'bot_server_id', 'INTEGER REFERENCES servers(id) ON DELETE SET NULL');
  db.exec(`
    -- Settings the host changes on the admin page: { signup_mode: 'open' | 'code' | 'links' }.
    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    -- One-time (or few-time) links to sign up with, made on the admin page.
    CREATE TABLE IF NOT EXISTS signup_links (
      code       TEXT PRIMARY KEY,
      note       TEXT NOT NULL DEFAULT '',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      max_uses   INTEGER NOT NULL DEFAULT 1,
      uses       INTEGER NOT NULL DEFAULT 0
    );
    -- A web address other services post to, which writes in one room as its own bot account.
    CREATE TABLE IF NOT EXISTS webhooks (
      id         INTEGER PRIMARY KEY,
      server_id  INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS webhooks_by_server ON webhooks(server_id);
    -- Crashes in people's apps, the same one counted once.
    CREATE TABLE IF NOT EXISTS client_errors (
      id       INTEGER PRIMARY KEY,
      hash     TEXT NOT NULL UNIQUE,
      message  TEXT NOT NULL,
      stack    TEXT NOT NULL DEFAULT '',
      where_at TEXT NOT NULL DEFAULT '',
      app      TEXT NOT NULL DEFAULT '',
      user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      first_at INTEGER NOT NULL,
      last_at  INTEGER NOT NULL,
      count    INTEGER NOT NULL DEFAULT 1
    );
  `);
}

/** What a login token is kept as: its SHA-256, so a copy of the database (a backup) can't be used to log in. */
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

/** Logins kept from before tokens were stored hashed are hashed in place; everyone stays logged in. */
function hashSessionTokens(db: Db) {
  const old = db.prepare('SELECT token FROM sessions WHERE length(token) != 64').all() as { token: string }[];
  if (!old.length) return;
  const update = db.prepare('UPDATE sessions SET token = ? WHERE token = ?');
  inTransaction(db, () => {
    for (const { token } of old) update.run(tokenHash(token), token);
  });
}
