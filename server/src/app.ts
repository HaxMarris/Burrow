import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { writeFile, mkdir, unlink, stat, copyFile, readFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { addModeratorRole, type Db } from './db.ts';
import { hashPassword, verifyPassword, newToken, newInviteCode } from './auth.ts';
import { closeRoom, removeFromRoom, setCanSpeak, voiceToken, type VoiceOptions } from './voice.ts';
import { staticFiles } from './static.ts';
import { gifSearch, download, type GifOptions } from './gifs.ts';
import { fetchEmbed, fetchImage, linksIn, type Embed, type EmbedOptions } from './embeds.ts';
import { newVapidKeys, sendPush, vapidKeysWork, type VapidKeys } from './push.ts';
import { looksLikeEmail, sendMail, type MailConfig } from './mail.ts';
import { hosting, type HostingOptions } from './hosting.ts';
import { checkTotp, hashRecovery, newRecoveryCodes, newTotpSecret, verifyAssertion, verifyRegistration, ZipWriter } from './account.ts';

export interface AppOptions {
  db: Db;
  publicDir: string;
  /** When set, new accounts must supply this code to register. */
  registrationCode?: string;
  /** LiveKit settings; voice rooms are turned off without them. */
  voice?: VoiceOptions;
  /** Where uploaded files are stored; uploads are turned off without it. */
  uploadDir?: string;
  /** Largest upload in bytes (default 25 MB). */
  maxUploadBytes?: number;
  /** KLIPY settings; the GIF picker is turned off without them (or without uploads). */
  gifs?: GifOptions;
  /** Link previews are on unless this is false. */
  linkPreviews?: EmbedOptions | false;
  /** Where to send email (confirming an address, resetting a forgotten password); email is off without it. */
  mail?: MailConfig;
  /** The address people open Burrow at, for links in emails. */
  publicUrl?: string;
  /** Who push services can contact about this server's pushes (a mailto: or https: address). */
  pushContact?: string;
  /** Push services Burrow will send to. Tests add their own. */
  pushHosts?: string[];
  /** How long a mention waits unread before it's emailed (default 15 minutes). */
  /** Backups, the admin page, updates and uptime (see hosting.ts). */
  hosting?: HostingOptions;
}

type User = { id: number; username: string; displayName: string | null; avatar: string | null };
const PERMS = ['rooms', 'messages', 'remove', 'ban', 'roles', 'burrow', 'emoji', 'voice', 'everyone', 'pin', 'invites', 'timeout', 'audit'] as const;
type Perm = (typeof PERMS)[number];
type Standing = { host: boolean; rank: number; perms: Set<Perm>; roleIds: number[] };
const parsePerms = (text: string) => text.split(',').filter((p): p is Perm => (PERMS as readonly string[]).includes(p));
type Channel = {
  id: number;
  serverId: number;
  name: string;
  kind: 'text' | 'voice' | 'thread';
  private: number;
  parentId: number | null;
  slow: number; // slow mode: seconds between someone's messages
  announce: number; // only some roles can post
  archivedAt: number | null;
  userLimit: number; // seats at a fire; 0 is no limit
  keepChat: number; // the fireside chat stays after everyone leaves
};
const CHANNEL_COLS = `id, server_id AS serverId, name, kind, private, parent_id AS parentId,
  slow_seconds AS slow, announce, archived_at AS archivedAt, user_limit AS userLimit, keep_chat AS keepChat`;
type Json = Record<string, unknown>;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MAX_MESSAGE_LENGTH = 4000;
const MAX_ATTACHMENTS = 10;
const MAX_REACTIONS = 20; // different emoji on one message
const MAX_ROLES = 30;
const MAX_TOPIC = 200;
const MAX_DESCRIPTION = 300;
const MAX_RULES = 2000;
const MAX_GROUP_DM = 10; // people in a group conversation
const MAX_FOLDERS = 20;
const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000; // logins unused for 30 days expire
const APP_CSP = [
  "default-src 'self'",
  // Noise suppression runs as WebAssembly.
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  // Voice may live on another address (LIVEKIT_URL).
  "connect-src 'self' https: wss: ws:",
  "worker-src 'self' blob:",
  // Listen together plays YouTube in its privacy-enhanced player.
  "frame-src https://www.youtube-nocookie.com",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** Compares secrets without leaking how much of them matched through timing. */
function sameText(a: unknown, b: string) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The visitor's address. Behind Caddy on the same machine, Caddy passes it along in X-Forwarded-For. */
function clientIp(req: IncomingMessage) {
  const direct = req.socket.remoteAddress ?? '';
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').pop()?.trim();
  const local = direct === '127.0.0.1' || direct === '::1' || direct === '::ffff:127.0.0.1' || /^(::ffff:)?(172|10)\./.test(direct);
  return local && forwarded ? forwarded : direct;
}
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
// A user's picture link, from their users.avatar file name (or null).
const avatarUrl = (col: string) => `CASE WHEN ${col} IS NULL THEN NULL ELSE '/api/avatars/' || ${col} END`;
// Profile and burrow pictures are recognised by their first bytes, not by what the client says they are.
const AVATAR_TYPES: { ext: string; type: string; magic: (b: Buffer) => boolean }[] = [
  { ext: 'png', type: 'image/png', magic: (b) => b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
  { ext: 'jpg', type: 'image/jpeg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'gif', type: 'image/gif', magic: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8' },
  { ext: 'webp', type: 'image/webp', magic: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];
// Soundboard clips, also recognised by their first bytes.
const MAX_SOUND_BYTES = 1024 * 1024;
const SOUND_TYPES: { ext: string; type: string; magic: (b: Buffer) => boolean }[] = [
  { ext: 'mp3', type: 'audio/mpeg', magic: (b) => b.subarray(0, 3).toString('latin1') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) },
  { ext: 'ogg', type: 'audio/ogg', magic: (b) => b.subarray(0, 4).toString('latin1') === 'OggS' },
  { ext: 'wav', type: 'audio/wav', magic: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WAVE' },
  { ext: 'webm', type: 'audio/webm', magic: (b) => b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) },
  { ext: 'm4a', type: 'audio/mp4', magic: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' },
];
const MAX_SOUNDS = 30;

const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
// Shown in the page. Everything else downloads, so an uploaded .html or .svg can't run as part of Burrow.
const INLINE_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
  'video/mp4', 'video/webm', 'video/quicktime', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm',
  'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/flac',
]);
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Preparing SQL takes longer than running it, and the same few hundred queries run over and over
 * (some once per person in a burrow), so each prepared statement is kept and reused.
 */
function withStatementCache(db: Db): Db {
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

export function createApp(opts: AppOptions): Server {
  const db = withStatementCache(opts.db);
  const now = () => Date.now();

  // ---- data helpers -------------------------------------------------------

  // A login lasts until it goes unused for SESSION_IDLE_MS. Using it keeps it going.
  const userByToken = (token: string | undefined): User | undefined => {
    if (!token) return undefined;
    const row = db
      .prepare(
        `SELECT u.id, u.username, u.display_name AS displayName, ${avatarUrl('u.avatar')} AS avatar, COALESCE(s.last_used_at, s.created_at) AS lastUsed, u.bot
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND u.deleted_at IS NULL`,
      )
      .get(token) as (User & { lastUsed: number; bot: number }) | undefined;
    if (!row) return undefined;
    const t = now();
    // A bot's token lasts until it's replaced; people's logins run out when unused.
    if (!row.bot && t - row.lastUsed > SESSION_IDLE_MS) {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      return undefined;
    }
    if (t - row.lastUsed > 60 * 60 * 1000) db.prepare('UPDATE sessions SET last_used_at = ? WHERE token = ?').run(t, token);
    const { lastUsed: _, bot: __, ...user } = row;
    return user;
  };

  // ---- guessing limits ----------------------------------------------------
  // Wrong passwords and registration codes are counted per person and per address;
  // too many in a row and that door closes for a while.
  const failures = new Map<string, { count: number; until: number }>();
  const checkTries = (keys: string[], limit: number) => {
    const t = now();
    for (const key of keys) {
      const f = failures.get(key);
      if (f && f.until > t && f.count >= limit) {
        const minutes = Math.ceil((f.until - t) / 60000);
        throw new HttpError(429, `Too many tries. Wait ${minutes} minute${minutes === 1 ? '' : 's'} and try again.`);
      }
    }
  };
  const failedTry = (keys: string[], windowMs = 15 * 60 * 1000) => {
    const t = now();
    for (const key of keys) {
      const f = failures.get(key);
      if (!f || f.until <= t) failures.set(key, { count: 1, until: t + windowMs });
      else f.count++;
    }
    if (failures.size > 10000) for (const [k, f] of failures) if (f.until <= t) failures.delete(k);
  };
  const clearTries = (key: string) => failures.delete(key);

  const USER_COLS = `id, username, display_name AS displayName, ${avatarUrl('avatar')} AS avatar`;
  const userById = (id: number) => db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(id) as User | undefined;
  /** Bots stay in the one burrow they were made for: no joining others, no DMs, no friends. */
  const notBot = (user: User) => {
    if ((db.prepare('SELECT bot FROM users WHERE id = ?').get(user.id) as { bot: number } | undefined)?.bot)
      throw new HttpError(403, "Bots can't do that");
  };
  /** The name someone goes by in a burrow: their nickname there, else their display name, else their username. */
  const nameSql = (userAlias: string, serverIdSql: string) =>
    `COALESCE((SELECT nn.nickname FROM members nn WHERE nn.server_id = ${serverIdSql} AND nn.user_id = ${userAlias}.id), ${userAlias}.display_name, ${userAlias}.username)`;
  const nameIn = (serverId: number, userId: number) =>
    (db.prepare(`SELECT ${nameSql('u', '?')} AS name FROM users u WHERE u.id = ?`).get(serverId, userId) as { name: string } | undefined)?.name ?? 'Someone';

  const isMember = (serverId: number, userId: number) =>
    !!db.prepare('SELECT 1 FROM members WHERE server_id = ? AND user_id = ?').get(serverId, userId);

  const channelById = (id: number) =>
    db.prepare(`SELECT ${CHANNEL_COLS} FROM channels WHERE id = ?`).get(id) as
      | Channel
      | undefined;

  // ---- roles: the host (whoever created the burrow) and the burrow's own custom roles ----

  /**
   * Where someone stands in a burrow: their roles, what those let them do, and their rank
   * (the position of their highest role; lower is higher, the host is above everyone).
   * Null if they aren't in it. DMs have no roles.
   */
  const standing = (serverId: number, userId: number): Standing | null => {
    const row = db
      .prepare('SELECT s.owner_id, s.kind FROM members m JOIN servers s ON s.id = m.server_id WHERE m.server_id = ? AND m.user_id = ?')
      .get(serverId, userId) as { owner_id: number; kind: string } | undefined;
    if (!row) return null;
    if (row.kind !== 'burrow') return { host: false, rank: Infinity, perms: new Set(), roleIds: [] };
    const roles = db
      .prepare('SELECT r.id, r.position, r.perms FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.server_id = ? AND mr.user_id = ?')
      .all(serverId, userId) as { id: number; position: number; perms: string }[];
    const host = row.owner_id === userId;
    return {
      host,
      rank: host ? 0 : Math.min(Infinity, ...roles.map((r) => r.position)),
      perms: new Set(host ? PERMS : roles.flatMap((r) => parsePerms(r.perms))),
      roleIds: roles.map((r) => r.id),
    };
  };
  const can = (serverId: number, userId: number, perm: Perm) => !!standing(serverId, userId)?.perms.has(perm);
  /** Private rooms are seen by people who manage rooms, the people let in, and anyone with a role let in. */
  const canSee = (channel: Channel, userId: number): boolean => {
    // A thread is seen by whoever sees the room it hangs off.
    if (channel.kind === 'thread') {
      const parent = channel.parentId === null ? undefined : channelById(channel.parentId);
      return !!parent && canSee(parent, userId);
    }
    if (!isMember(channel.serverId, userId)) return false;
    if (!channel.private || can(channel.serverId, userId, 'rooms')) return true;
    return !!db
      .prepare(
        `SELECT 1 FROM channel_access WHERE channel_id = ? AND user_id = ?
         UNION SELECT 1 FROM channel_role_access cra JOIN member_roles mr ON mr.role_id = cra.role_id WHERE cra.channel_id = ? AND mr.user_id = ?`,
      )
      .get(channel.id, userId, channel.id, userId);
  };
  const channelAudience = (channel: Channel) => serverMemberIds(channel.serverId).filter((id) => canSee(channel, id));

  const serverMemberIds = (serverId: number) =>
    (db.prepare('SELECT user_id FROM members WHERE server_id = ?').all(serverId) as { user_id: number }[]).map(
      (r) => r.user_id,
    );

  const attachmentJson = (a: Json) => ({
    id: a.id,
    name: a.name,
    type: a.type,
    size: a.size,
    url: `/api/attachments/${a.id}/${encodeURIComponent(a.name as string)}`,
    ...(a.spoiler ? { spoiler: true } : {}),
    ...(a.voice_seconds != null ? { voiceSeconds: a.voice_seconds } : {}),
    ...(a.width && a.height ? { width: a.width, height: a.height } : {}),
    ...(a.thumb ? { thumb: `/api/attachments/${a.id}/thumb` } : {}),
  });

  const reactionsFor = (messageId: number) => {
    const rows = db
      .prepare('SELECT emoji, user_id FROM reactions WHERE message_id = ? ORDER BY created_at, rowid')
      .all(messageId) as { emoji: string; user_id: number }[];
    const byEmoji = new Map<string, number[]>();
    for (const r of rows) byEmoji.set(r.emoji, [...(byEmoji.get(r.emoji) ?? []), r.user_id]);
    return [...byEmoji].map(([emoji, userIds]) => ({ emoji, userIds }));
  };

  /** A short preview of the message being replied to, or { deleted: true } if it's gone. */
  const replyPreview = (id: unknown) => {
    if (id == null) return null;
    const m = db
      .prepare(
        `SELECT m.id, m.content, u.id AS authorId, ${nameSql('u', '(SELECT c.server_id FROM channels c WHERE c.id = m.channel_id)')} AS author,
                EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id) AS hasAttachments
         FROM messages m JOIN users u ON u.id = m.author_id WHERE m.id = ?`,
      )
      .get(id as number) as Json | undefined;
    if (!m) return { deleted: true };
    return { ...m, content: (m.content as string).slice(0, 160), hasAttachments: !!m.hasAttachments };
  };

  /** Adds attachments, reactions, reply previews, polls, link previews and threads to a list of message rows. */
  const withAttachments = (rows: Json[]): Json[] => {
    if (!rows.length) return rows;
    rows = rows.map(({ replyToId, stickerId, embedsOff, forwarded, pings, live, authorBot, ...r }) => ({
      ...r,
      ...(authorBot ? { authorBot: true } : {}),
      ...(live ? { live: JSON.parse(live as string) } : {}),
      pings: pings ? JSON.parse(pings as string) : null,
      pinnedAt: r.pinnedAt ?? null,
      replyTo: replyPreview(replyToId),
      reactions: reactionsFor(r.id as number),
      forwarded: forwarded ? JSON.parse(forwarded as string) : null,
      sticker: stickerId == null ? null : stickerJson(stickerId as number),
      poll: pollFor(r.id as number),
      embeds: embedsOff ? [] : embedsFor(r.id as number),
      thread: threadOf(r.id as number),
    }));
    const ids = rows.map((r) => r.id as number);
    const atts = db
      .prepare(
        `SELECT id, message_id, name, type, size, spoiler, voice_seconds, width, height, thumb FROM attachments
         WHERE message_id IN (${ids.map(() => '?').join(',')}) ORDER BY position`,
      )
      .all(...ids) as Json[];
    return rows.map((r) => ({ ...r, attachments: atts.filter((a) => a.message_id === r.id).map(attachmentJson) }));
  };

  // Every message is read with these columns, then filled in by withAttachments.
  const MESSAGE_SELECT = `SELECT m.id, m.channel_id AS channelId, m.content, m.created_at AS createdAt, m.edited_at AS editedAt,
      m.reply_to AS replyToId, m.pinned_at AS pinnedAt, m.forwarded, m.sticker_id AS stickerId, m.embeds_off AS embedsOff, m.pings, m.live,
      u.id AS authorId, ${nameSql('u', '(SELECT c.server_id FROM channels c WHERE c.id = m.channel_id)')} AS author, u.username AS authorUsername,
      ${avatarUrl('u.avatar')} AS authorAvatar, u.bot AS authorBot
    FROM messages m JOIN users u ON u.id = m.author_id`;

  const messageById = (id: number) => {
    const row = db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(id) as Json | undefined;
    return row && withAttachments([row])[0];
  };
  /** Messages by id, in the order given, leaving out any that are gone. */
  const messagesByIds = (ids: number[]) => {
    if (!ids.length) return [];
    const rows = db.prepare(`${MESSAGE_SELECT} WHERE m.id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Json[];
    const byId = new Map(withAttachments(rows).map((r) => [r.id, r]));
    return ids.map((id) => byId.get(id)).filter((r): r is Json => !!r);
  };

  /** A burrow as one person sees it: private rooms they can't enter are left out. */
  const serverSummary = (serverId: number, viewerId: number) => {
    const server = db
      .prepare(
        `SELECT id, name, kind, owner_id AS ownerId, invite_code AS inviteCode, dm_key AS dmKey, description, rules,
                welcome_channel_id AS welcomeChannelId, afk_channel_id AS afkChannelId, afk_minutes AS afkMinutes, live_channel_id AS liveChannelId,
                CASE WHEN icon IS NULL THEN NULL ELSE '/api/burrow-pictures/' || icon END AS icon,
                CASE WHEN banner IS NULL THEN NULL ELSE '/api/burrow-pictures/' || banner END AS banner
         FROM servers WHERE id = ?`,
      )
      .get(serverId) as Json;
    // A conversation with no pair key is a group DM, which can have a name.
    if (server.kind === 'dm') {
      delete server.inviteCode;
      server.group = server.dmKey === null;
    }
    delete server.dmKey;
    const manager = can(serverId, viewerId, 'rooms');
    const ids = (sql: string, id: number) => (db.prepare(sql).all(id) as { id: number }[]).map((r) => r.id);
    const prefs = notifyPrefsOf(viewerId, serverId);
    const channels = (
      db
        .prepare(`SELECT ${CHANNEL_COLS}, topic, group_id AS groupId FROM channels WHERE server_id = ? AND kind != 'thread' ORDER BY COALESCE(position, id), id`)
        .all(serverId) as (Channel & { topic: string; groupId: number | null })[]
    )
      .filter((c) => canSee(c, viewerId))
      .map(({ serverId: _, private: priv, parentId: __, announce, archivedAt, ...c }) => ({
        ...c,
        keepChat: !!c.keepChat,
        private: !!priv,
        announce: !!announce,
        archived: archivedAt !== null,
        canPost: postProblem({ ...c, serverId, private: priv, parentId: null, announce, archivedAt }, viewerId) === null,
        notify: prefs.get(c.id) ?? null,
        ...(c.kind === 'voice' ? voiceSummary(c.id) : readInfo(c.id, serverId, viewerId)),
        // Who has been let in (and who may post in an announcement room), for the people who can change it.
        ...(priv && manager
          ? {
              memberIds: ids('SELECT user_id AS id FROM channel_access WHERE channel_id = ?', c.id),
              roleIds: ids('SELECT role_id AS id FROM channel_role_access WHERE channel_id = ?', c.id),
            }
          : {}),
        ...(announce && manager ? { postRoleIds: ids('SELECT role_id AS id FROM channel_post_roles WHERE channel_id = ?', c.id) } : {}),
        ...(manager ? { readOnlyRoleIds: ids('SELECT role_id AS id FROM channel_read_only WHERE channel_id = ?', c.id) } : {}),
      }));
    const roles = (
      db.prepare('SELECT id, name, color, perms, position, upload_mb AS uploadMb FROM roles WHERE server_id = ? ORDER BY position').all(serverId) as Json[]
    ).map((r) => ({ ...r, id: r.id as number, perms: parsePerms(r.perms as string) }));
    const memberRoles = db
      .prepare('SELECT mr.user_id, mr.role_id FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.server_id = ? ORDER BY r.position')
      .all(serverId) as { user_id: number; role_id: number }[];
    const members = db
      .prepare(
        `SELECT u.id, u.username, u.display_name AS displayName, m.nickname, u.accent, ${avatarUrl('u.avatar')} AS avatar,
                u.deleted_at IS NOT NULL AS deleted, m.voice_muted AS voiceMuted, m.timeout_until AS timeoutUntil, u.bot
         FROM members m JOIN users u ON u.id = m.user_id
         WHERE m.server_id = ? ORDER BY u.username`,
      )
      .all(serverId) as (User & { voiceMuted: number; timeoutUntil: number | null; deleted: number; bot: number })[];
    const accepted = (db.prepare('SELECT rules_accepted_at FROM members WHERE server_id = ? AND user_id = ?').get(serverId, viewerId) as
      | { rules_accepted_at: number | null }
      | undefined)?.rules_accepted_at;
    return {
      ...server,
      rulesAccepted: !server.rules || !!accepted,
      notify: prefs.get(0) ?? null,
      channels,
      groups: db.prepare('SELECT id, name FROM room_groups WHERE server_id = ? ORDER BY position, id').all(serverId),
      events: server.kind === 'burrow' ? eventsIn(serverId, viewerId) : [],
      threads: threadsIn(serverId, viewerId),
      emoji: emojiOf(serverId),
      sounds: soundsOf(serverId),
      serverMuted: serverMuted(serverId, viewerId),
      ...(server.kind === 'burrow' ? moderationSummary(serverId, viewerId) : {}),
      ...(server.kind === 'dm' ? { seen: dmSeen(serverId, viewerId) } : {}),
      roles,
      members: members.map((m) => {
        // Highest role first. 'role' is kept for apps from before custom roles.
        const roleIds = memberRoles.filter((r) => r.user_id === m.id).map((r) => r.role_id);
        const host = server.kind === 'burrow' && m.id === server.ownerId;
        const powers = roleIds.some((id) => (roles.find((r) => r.id === id)?.perms.length ?? 0) > 0);
        return { ...m, deleted: !!m.deleted, bot: !!m.bot, voiceMuted: !!m.voiceMuted, timeoutUntil: (m.timeoutUntil ?? 0) > now() ? m.timeoutUntil : null, roleIds, role: host ? 'host' : powers ? 'mod' : 'member', online: online.has(m.id), ...presenceOf(m.id) };
      }),
    };
  };

  /** Logs someone in on this device. `from` is the request, so "your devices" can say which one it is. */
  const startSession = (user: User, from?: { ip: string; ua: string }) => {
    const token = newToken();
    db.prepare('INSERT INTO sessions (token, user_id, created_at, last_used_at, device, ip) VALUES (?, ?, ?, ?, ?, ?)').run(
      token, user.id, now(), now(), from?.ua.slice(0, 300) ?? null, from?.ip ?? null,
    );
    return { token, user: userById(user.id) ?? user };
  };

  const cleanName = (value: unknown, field: string, max = 64) => {
    if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${field} is required`);
    const v = value.trim();
    if (v.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
    return v;
  };

  // ---- realtime -----------------------------------------------------------

  const sockets = new Map<number, Set<WebSocket>>(); // userId -> open sockets
  const socketTokens = new WeakMap<WebSocket, string>(); // which login each socket belongs to
  const online = new Set<number>();
  const inVoice = new Map<number, number>(); // userId -> voice channel they are in

  const voiceFlags = new Map<number, { muted: boolean; deafened: boolean }>(); // userId -> mic off / not listening
  const speaking = new Set<number>(); // people talking right now, as their apps report it
  const lastActive = new Map<number, number>(); // userId -> when they last talked or touched the app, for the AFK fire
  const usersInVoice = (channelId: number) => [...inVoice].filter(([, c]) => c === channelId).map(([u]) => u);
  /** Muted for everyone in this burrow by a moderator, or timed out. */
  const serverMuted = (serverId: number, userId: number) => {
    const r = db.prepare('SELECT voice_muted, timeout_until FROM members WHERE server_id = ? AND user_id = ?').get(serverId, userId) as
      | { voice_muted: number; timeout_until: number | null }
      | undefined;
    return !!r && (!!r.voice_muted || (r.timeout_until ?? 0) > now()); // muted by a moderator, or timed out
  };
  /** Who's in a voice room, and which of them are muted, deafened or talking, so everyone in the burrow can see. */
  const voiceSummary = (channelId: number) => {
    const userIds = usersInVoice(channelId);
    const flagged = (flag: 'muted' | 'deafened') => userIds.filter((u) => voiceFlags.get(u)?.[flag]);
    const serverId = channelById(channelId)?.serverId;
    return {
      voiceUsers: userIds,
      voiceMuted: flagged('muted'),
      voiceDeafened: flagged('deafened'),
      voiceServerMuted: serverId === undefined ? [] : userIds.filter((u) => serverMuted(serverId, u)),
      voiceSpeaking: userIds.filter((u) => speaking.has(u)),
    };
  };
  // Fireside chat: text for the people in a voice room, while they're there. It's kept in memory
  // only, sent to whoever is in the room, and gone once the last person leaves.
  const fireside = new Map<number, Json[]>(); // voice channel id -> recent messages, oldest first
  let firesideId = 0;
  const FIRESIDE_KEEP = 100;
  const voiceStateEvent = (channelId: number) => {
    const { voiceUsers, voiceMuted, voiceDeafened, voiceServerMuted, voiceSpeaking } = voiceSummary(channelId);
    return { type: 'voice_state', channelId, userIds: voiceUsers, muted: voiceMuted, deafened: voiceDeafened, serverMuted: voiceServerMuted, speaking: voiceSpeaking };
  };
  // Listen together: one YouTube video per fire, played in step for everyone there. Like the
  // fireside chat, it's only kept while someone is at the fire.
  type Listening = { videoId: string; title: string; playing: boolean; position: number; since: number; by: number };
  const listening = new Map<number, Listening>(); // voice channel id -> what's playing
  /** Where the video is now, in seconds, and the clock it was read at, so apps can line up. */
  const listenEvent = (channelId: number) => {
    const l = listening.get(channelId);
    const at = Date.now();
    return {
      type: 'listen_state',
      channelId,
      at,
      state: l ? { videoId: l.videoId, title: l.title, playing: l.playing, by: l.by, position: l.position + (l.playing ? (at - l.since) / 1000 : 0) } : null,
    };
  };

  const sendTo = (userIds: Iterable<number>, event: Json) => {
    const data = JSON.stringify(event);
    for (const id of userIds) for (const ws of sockets.get(id) ?? []) if (ws.readyState === WebSocket.OPEN) ws.send(data);
  };

  const broadcastToServer = (serverId: number, event: Json) => sendTo(serverMemberIds(serverId), event);
  const broadcastToChannel = (channel: Channel, event: Json) => sendTo(channelAudience(channel), event);
  /** Everyone in a burrow gets their own view of it, since private rooms differ person to person. */
  const sendServerUpdate = (serverId: number) => {
    for (const id of serverMemberIds(serverId)) sendTo([id], { type: 'server_updated', server: serverSummary(serverId, id) });
  };

  // Who is in which voice room. The app reports joining and leaving; LiveKit carries the audio.
  const setVoice = (userId: number, channelId: number | null, flags?: { muted: boolean; deafened: boolean }) => {
    const prev = inVoice.get(userId);
    if (channelId === null) voiceFlags.delete(userId);
    else if (flags) voiceFlags.set(userId, flags);
    if (prev === channelId) {
      // Same room: only muting or deafening changed.
      if (flags && prev !== undefined) broadcastToChannel(channelById(prev)!, voiceStateEvent(prev));
      return;
    }
    if (prev === undefined && channelId === null) return;
    speaking.delete(userId);
    if (prev !== undefined) {
      endLive(userId);
      inVoice.delete(userId);
      // The last one out puts the fire out: its chat (unless it's kept) and whatever was playing.
      if (!usersInVoice(prev).length) {
        fireside.delete(prev);
        listening.delete(prev);
      }
      const old = channelById(prev);
      if (old) broadcastToChannel(old, voiceStateEvent(old.id));
    }
    if (channelId === null) lastActive.delete(userId);
    else {
      const channel = channelById(channelId)!;
      inVoice.set(userId, channelId);
      lastActive.set(userId, Date.now());
      sendTo([userId], { type: 'fireside_history', channelId, messages: firesideHistory(channel) });
      if (listening.has(channelId)) sendTo([userId], listenEvent(channelId));
      broadcastToChannel(channel, voiceStateEvent(channelId));
    }
  };
  // Going live: sharing your screen posts "is live" in the burrow's go-live room, with a way to
  // join, and it's marked as over when the share stops or they leave the fire.
  const liveNow = new Map<number, number>(); // userId -> their go-live message
  const RELIVE_MS = 5 * 60_000; // sharing again this soon picks the same post back up
  function setLiveEnded(messageId: number, endedAt: number | null) {
    db.prepare("UPDATE messages SET live = json_set(live, '$.endedAt', ?) WHERE id = ? AND live IS NOT NULL").run(endedAt, messageId);
    const message = messageById(messageId);
    const channel = message && channelById(message.channelId as number);
    if (message && channel) broadcastToChannel(channel, { type: 'message_updated', message });
  }
  function endLive(userId: number) {
    const messageId = liveNow.get(userId);
    if (messageId === undefined) return;
    liveNow.delete(userId);
    setLiveEnded(messageId, now());
  }
  function goLive(user: User) {
    const voiceId = inVoice.get(user.id);
    if (voiceId === undefined || liveNow.has(user.id)) return;
    const voice = channelById(voiceId);
    if (!voice || !isBurrow(voice.serverId)) return;
    const liveId = (db.prepare('SELECT live_channel_id FROM servers WHERE id = ?').get(voice.serverId) as { live_channel_id: number | null }).live_channel_id;
    const target = liveId === null ? undefined : channelById(liveId);
    if (!target || !canSee(target, user.id) || postProblem(target, user.id)) return;
    const last = db
      .prepare('SELECT id, live FROM messages WHERE channel_id = ? AND author_id = ? AND live IS NOT NULL ORDER BY id DESC LIMIT 1')
      .get(target.id, user.id) as { id: number; live: string } | undefined;
    const was = last && JSON.parse(last.live);
    if (last && was.voiceChannelId === voiceId && was.endedAt && was.endedAt > now() - RELIVE_MS) {
      liveNow.set(user.id, last.id);
      return setLiveEnded(last.id, null);
    }
    try {
      const message = postMessage(user, target.id, { content: '' }, { live: { voiceChannelId: voiceId, endedAt: null } });
      liveNow.set(user.id, message.id as number);
    } catch {
      // Slow mode or the like: no announcement this time.
    }
  }
  const firesideHistory = (channel: Channel) =>
    channel.keepChat
      ? (db.prepare('SELECT id, user_id AS userId, author, content, created_at AS createdAt FROM fireside_messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?')
          .all(channel.id, FIRESIDE_KEEP) as Json[]).reverse()
      : fireside.get(channel.id) ?? [];
  const flagsFrom = (msg: Json) => ({ muted: msg.muted === true, deafened: msg.deafened === true });

  // LiveKit only checks who may join when they join, so people who lose access are disconnected
  // there too. (The key keeper also stops handing them voice keys; see the app.)
  const tellLiveKit = (what: string, call: (voice: VoiceOptions) => Promise<void>) => {
    if (opts.voice) call(opts.voice).catch((err) => console.warn(`Couldn't ${what}: ${err.message}`));
  };
  /** Takes someone out of a voice room: off the room's list, and disconnected from LiveKit. */
  const kickFromVoice = (userId: number, channelId = inVoice.get(userId)) => {
    if (channelId === undefined) return;
    if (inVoice.get(userId) === channelId) setVoice(userId, null);
    tellLiveKit(`take user ${userId} out of room-${channelId}`, (v) => removeFromRoom(v, `room-${channelId}`, String(userId)));
  };
  const closeVoiceRoom = (channelId: number) => {
    for (const [u, c] of inVoice) if (c === channelId) setVoice(u, null);
    tellLiveKit(`close room-${channelId}`, (v) => closeRoom(v, `room-${channelId}`));
  };
  const voiceRoomIds = (serverId: number) =>
    (db.prepare("SELECT id FROM channels WHERE server_id = ? AND kind = 'voice'").all(serverId) as { id: number }[]).map((r) => r.id);

  const usersSharingServerWith = (userId: number) =>
    (
      db
        .prepare(
          'SELECT DISTINCT b.user_id FROM members a JOIN members b ON a.server_id = b.server_id WHERE a.user_id = ?',
        )
        .all(userId) as { user_id: number }[]
    ).map((r) => r.user_id);

  type PollInput = { question: string; options: string[]; multi: boolean; closesAt: number | null };
  type PostExtras = { forwarded?: Json; poll?: PollInput; scheduled?: boolean; live?: Json; webhook?: boolean };

  // ---- slash commands, worked out by the server so nobody can fake a dice roll

  /**
   * A message starting with one of these is changed before it's sent: /roll 2d6, /flip, /shrug,
   * /me, /spoiler and /poll Question | answer | answer. Anything else starting with / is sent as
   * it is, so a bot in the room can answer its own commands.
   */
  const slashCommand = (content: string): { content: string; poll?: PollInput } | null => {
    const m = /^\/(\w+)(?:\s+([\s\S]*))?$/.exec(content.trim());
    if (!m) return null;
    const rest = (m[2] ?? '').trim();
    switch (m[1].toLowerCase()) {
      case 'roll': {
        const d = /^(\d{0,2})d(\d{1,4})\s*([+-]\s*\d{1,4})?$/i.exec(rest || 'd6');
        if (!d) throw new HttpError(400, 'Roll dice like /roll 2d6, /roll d20 or /roll 3d8+2');
        const count = Math.max(1, Number(d[1] || 1)), sides = Number(d[2]), bonus = Number((d[3] ?? '0').replace(/\s/g, ''));
        if (count > 20 || sides < 2) throw new HttpError(400, 'Up to 20 dice, with at least 2 sides');
        const rolls = Array.from({ length: count }, () => randomInt(1, sides + 1));
        const total = rolls.reduce((a, b) => a + b, 0) + bonus;
        const shown = `${count}d${sides}${bonus ? (bonus > 0 ? `+${bonus}` : bonus) : ''}`;
        const working = count > 1 || bonus ? `${rolls.join(' + ')}${bonus ? ` ${bonus > 0 ? '+' : '-'} ${Math.abs(bonus)}` : ''} = ` : '';
        return { content: `🎲 rolled ${shown}: ${working}**${total}**` };
      }
      case 'flip':
        return { content: `🪙 flipped a coin: **${randomInt(2) ? 'heads' : 'tails'}**` };
      case 'shrug':
        return { content: `${rest ? rest + ' ' : ''}¯\\_(ツ)_/¯` };
      case 'me':
        return rest ? { content: `*${rest}*` } : null;
      case 'spoiler':
        return rest ? { content: `||${rest}||` } : null;
      case 'poll': {
        const parts = rest.split('|').map((p) => p.trim()).filter(Boolean);
        if (parts.length < 3) throw new HttpError(400, 'Make a poll like /poll Pizza or tacos? | Pizza | Tacos');
        return { content: '', poll: makePoll({ question: parts[0], options: parts.slice(1) }) };
      }
      default:
        return null;
    }
  };

  /**
   * Posts a message: text, files (some hidden as spoilers), a sticker, a reply, and for polls
   * and forwards, the extras those bring. Everyone who can see the room gets it.
   */
  const postMessage = (user: User, channelId: number, input: Json, extras: PostExtras = {}) => {
    const channel = channelById(channelId);
    // A webhook writes in the one room it was made for, whoever can see it.
    if (!channel || (!extras.webhook && !canSee(channel, user.id))) throw new HttpError(404, 'Room not found');
    if (channel.kind === 'voice') throw new HttpError(400, 'Voice rooms have no messages');
    const problem = extras.webhook ? null : postProblem(channel, user.id);
    if (problem) throw new HttpError(403, problem);
    dmBlockCheck(channel.serverId, user.id);
    const flagged = filterCheck(channel, user.id, typeof input.content === 'string' ? input.content : '');
    // Slow mode: people who manage rooms or messages aren't held back, and nor are scheduled messages.
    if (channel.slow && !extras.scheduled && !can(channel.serverId, user.id, 'rooms') && !can(channel.serverId, user.id, 'messages')) {
      const last = (db.prepare('SELECT MAX(created_at) AS t FROM messages WHERE channel_id = ? AND author_id = ?').get(channelId, user.id) as { t: number | null }).t;
      const wait = last === null ? 0 : Math.ceil((last + channel.slow * 1000 - now()) / 1000);
      if (wait > 0) throw new HttpError(429, `Slow mode is on. You can send another message in ${wait} second${wait === 1 ? '' : 's'}.`);
    }
    const raw = input.content ?? '';
    if (typeof raw !== 'string') throw new HttpError(400, 'Message is empty');
    let content = raw;
    if (content.length > MAX_MESSAGE_LENGTH) throw new HttpError(400, 'Message is too long');
    if (content.startsWith('/') && !extras.forwarded && !extras.webhook) {
      const command = slashCommand(content);
      if (command) {
        content = command.content;
        if (command.poll) extras = { ...extras, poll: command.poll };
      }
    }
    const attachmentIds = input.attachmentIds;
    const ids = Array.isArray(attachmentIds) ? [...new Set(attachmentIds.map(String))] : [];
    if (ids.length > MAX_ATTACHMENTS) throw new HttpError(400, `At most ${MAX_ATTACHMENTS} files per message`);
    // Only your own uploads to this room that aren't on a message yet.
    const usable = ids.filter(
      (id) =>
        !!db
          .prepare('SELECT 1 FROM attachments WHERE id = ? AND uploader_id = ? AND channel_id = ? AND message_id IS NULL')
          .get(id, user.id, channelId),
    );
    if (usable.length !== ids.length) throw new HttpError(400, 'One of the files is missing or already sent');
    const spoilers = new Set(Array.isArray(input.spoilerIds) ? input.spoilerIds.map(String) : []);
    let stickerId: number | null = null;
    if (input.stickerId != null) {
      const sticker = db.prepare("SELECT server_id FROM custom_emoji WHERE id = ? AND kind = 'sticker'").get(Number(input.stickerId)) as
        | { server_id: number }
        | undefined;
      if (!sticker || !isMember(sticker.server_id, user.id)) throw new HttpError(400, "That sticker isn't available");
      stickerId = Number(input.stickerId);
    }
    if (!content.trim() && !usable.length && !stickerId && !extras.poll && !extras.forwarded && !extras.live) throw new HttpError(400, 'Message is empty');
    let replyId: number | null = null;
    const replyTo = input.replyTo;
    if (replyTo != null) {
      const target = db.prepare('SELECT channel_id FROM messages WHERE id = ?').get(Number(replyTo)) as
        | { channel_id: number }
        | undefined;
      if (!target || target.channel_id !== channelId) throw new HttpError(400, "Can't reply to that message");
      replyId = Number(replyTo);
    }
    const r = db
      .prepare('INSERT INTO messages (channel_id, author_id, content, created_at, reply_to, sticker_id, forwarded, live) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(channelId, user.id, content, now(), replyId, stickerId, extras.forwarded ? JSON.stringify(extras.forwarded) : null, extras.live ? JSON.stringify(extras.live) : null);
    const messageId = Number(r.lastInsertRowid);
    const forWhom = recordMentions(channel, messageId, user.id, content, replyId);
    usable.forEach((id, position) =>
      db.prepare('UPDATE attachments SET message_id = ?, position = ?, spoiler = ? WHERE id = ?').run(messageId, position, spoilers.has(id) ? 1 : 0, id),
    );
    if (extras.poll) {
      const p = extras.poll;
      db.prepare('INSERT INTO polls (message_id, question, options, multi, closes_at) VALUES (?, ?, ?, ?, ?)').run(
        messageId, p.question, JSON.stringify(p.options), p.multi ? 1 : 0, p.closesAt,
      );
      if (p.closesAt) wakeAt(p.closesAt);
    }
    const message = messageById(messageId)!;
    broadcastToChannel(channel, { type: 'message', message });
    if (flagged) fileReport(channel.serverId, message, null, `Word filter: ${flagged}`);
    alertAway(channel, message, forWhom);
    // Writing in a room means you've read it.
    markRead(user.id, channel, messageId);
    if (channel.kind === 'thread') threadChanged(channel);
    previewLinks(messageId, channel, content);
    return message;
  };

  // ---- HTTP routes --------------------------------------------------------

  type Handler = (ctx: { user: User; params: string[]; body: Json; url: URL; token: string | undefined; ip: string; ua: string; host: string; secure: boolean }) => unknown;
  type Route = { method: string; pattern: RegExp; auth: boolean; handler: Handler };
  const routes: Route[] = [];
  const route = (method: string, path: string, handler: Handler, auth = true) =>
    routes.push({ method, pattern: new RegExp('^' + path.replace(/:code/g, '([\\w-]+)').replace(/:\w+/g, '(\\d+)') + '$'), auth, handler });

  const admin = hosting({
    db, rawDb: opts.db, route, fail: (status, message) => new HttpError(status, message),
    hosting: opts.hosting, registrationCode: opts.registrationCode, uploadDir: opts.uploadDir, publicUrl: opts.publicUrl,
    online, inVoice,
    signOut: (userId) => {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
      for (const ws of sockets.get(userId) ?? []) ws.close(4001, 'Signed out');
    },
  });

  route(
    'GET',
    '/api/config',
    () => ({
      registrationCodeRequired: admin.signupMode() === 'code',
      signupLinksOnly: admin.signupMode() === 'links',
      voice: !!opts.voice,
      maxUploadBytes: opts.uploadDir ? maxUpload : 0,
      gifs: !!gifs,
      email: !!opts.mail,
    }),
    false,
  );

  route(
    'POST',
    '/api/register',
    ({ body, ip, ua }) => {
      checkTries([`register-ip:${ip}`], 10);
      const username = cleanName(body.username, 'Username', 32);
      if (!/^[\w.-]+$/.test(username)) throw new HttpError(400, 'Username may only use letters, numbers, _ . -');
      if (typeof body.password !== 'string' || body.password.length < 8)
        throw new HttpError(400, 'Password must be at least 8 characters');
      // A signup link, the registration code, or nothing at all, as the host chose on the admin page.
      const link = admin.checkSignup(body);
      if (link === 'code' && opts.registrationCode && !sameText(body.registrationCode, opts.registrationCode)) {
        failedTry([`register-ip:${ip}`], 60 * 60 * 1000);
        throw new HttpError(403, 'Invalid registration code');
      }
      if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username))
        throw new HttpError(409, 'That username is taken');
      const r = db
        .prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
        .run(username, hashPassword(body.password), now());
      if (link && link !== 'code') admin.useSignupLink(link);
      return startSession(userById(Number(r.lastInsertRowid))!, { ip, ua });
    },
    false,
  );

  route(
    'POST',
    '/api/login',
    ({ body, ip, ua }) => {
      const name = String(body.username ?? '').toLowerCase();
      const keys = [`login-user:${name}`, `login-ip:${ip}`];
      checkTries(keys.slice(0, 1), 10);
      checkTries(keys.slice(1), 30);
      const row = db
        .prepare(`SELECT id, password_hash FROM users WHERE username = ? AND deleted_at IS NULL`)
        .get(String(body.username ?? '')) as { id: number; password_hash: string } | undefined;
      if (!row || !verifyPassword(String(body.password ?? ''), row.password_hash)) {
        failedTry(keys);
        throw new HttpError(401, 'Wrong username or password');
      }
      clearTries(keys[0]);
      return loginOrAskCode(row.id, { ip, ua });
    },
    false,
  );

  route('POST', '/api/logout', ({ body }) => {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(String(body.token ?? ''));
    return { ok: true };
  });

  route('GET', '/api/me', ({ user }) => ({ ...meJson(user), folders: foldersOf(user.id) }));

  // Changing your password signs you out everywhere else.
  route('POST', '/api/me/password', ({ user, body, token }) => {
    const key = `password-user:${user.id}`;
    checkTries([key], 10);
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as { password_hash: string };
    if (!verifyPassword(String(body.currentPassword ?? ''), row.password_hash)) {
      failedTry([key]);
      throw new HttpError(403, 'Your current password is wrong');
    }
    clearTries(key);
    if (typeof body.newPassword !== 'string' || body.newPassword.length < 8)
      throw new HttpError(400, 'New password must be at least 8 characters');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(body.newPassword), user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(user.id, token ?? '');
    for (const ws of sockets.get(user.id) ?? []) if (socketTokens.get(ws) !== token) ws.close(4001, 'Password changed');
    return { ok: true };
  });

  route('DELETE', '/api/me/avatar', ({ user }) => setAvatarFile(user, null));

  // ---- favorite burrows: the ones shown in your top bar --------------------

  const MAX_FAVORITES = 5;
  const favoritesOf = (userId: number) =>
    (
      db
        .prepare('SELECT server_id AS id FROM members WHERE user_id = ? AND favorite IS NOT NULL ORDER BY favorite')
        .all(userId) as { id: number }[]
    ).map((r) => r.id);

  route('GET', '/api/me/favorites', ({ user }) => ({ serverIds: favoritesOf(user.id) }));

  /** Replaces your favorites with these burrows, in this order. */
  route('POST', '/api/me/favorites', ({ user, body }) => {
    if (!Array.isArray(body.serverIds)) throw new HttpError(400, 'serverIds must be a list');
    const ids = [...new Set(body.serverIds.map(Number))];
    if (ids.length > MAX_FAVORITES) throw new HttpError(400, `You can favorite up to ${MAX_FAVORITES} hearths`);
    const isBurrow = db.prepare("SELECT 1 FROM members m JOIN servers s ON s.id = m.server_id WHERE m.user_id = ? AND m.server_id = ? AND s.kind = 'burrow'");
    for (const id of ids) if (!isBurrow.get(user.id, id)) throw new HttpError(404, 'Hearth not found');
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE members SET favorite = NULL WHERE user_id = ?').run(user.id);
      const set = db.prepare('UPDATE members SET favorite = ? WHERE user_id = ? AND server_id = ?');
      ids.forEach((id, i) => set.run(i + 1, user.id, id));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    const serverIds = favoritesOf(user.id);
    sendTo([user.id], { type: 'favorites', serverIds }); // your other devices
    return { serverIds };
  });

  route('GET', '/api/servers', ({ user }) => {
    const ids = db
      .prepare(
        "SELECT m.server_id FROM members m JOIN servers s ON s.id = m.server_id WHERE m.user_id = ? AND s.kind = 'burrow' ORDER BY m.joined_at",
      )
      .all(user.id) as { server_id: number }[];
    return ids.map((r) => serverSummary(r.server_id, user.id));
  });

  // ---- direct messages ----------------------------------------------------

  /** Your conversations, most recently active first. */
  route('GET', '/api/dms', ({ user }) => {
    const rows = db
      .prepare(
        `SELECT s.id, COALESCE((SELECT MAX(msg.created_at) FROM channels c JOIN messages msg ON msg.channel_id = c.id
                                WHERE c.server_id = s.id), s.created_at) AS lastActive
         FROM members m JOIN servers s ON s.id = m.server_id
         WHERE m.user_id = ? AND s.kind = 'dm' ORDER BY lastActive DESC`,
      )
      .all(user.id) as { id: number; lastActive: number }[];
    return rows.map((r) => ({ ...serverSummary(r.id, user.id), lastActive: r.lastActive }));
  });

  const sharesBurrow = (a: number, b: number) =>
    !!db
      .prepare(
        `SELECT 1 FROM members a JOIN members b ON a.server_id = b.server_id JOIN servers s ON s.id = a.server_id
         WHERE a.user_id = ? AND b.user_id = ? AND s.kind = 'burrow'`,
      )
      .get(a, b);
  /** The people you're adding to a conversation: real, not you, friends or sharing a burrow with you, and not blocked either way. */
  const dmPeople = (user: User, ids: unknown) => {
    const list = [...new Set((Array.isArray(ids) ? ids : []).map(Number))].filter((id) => id !== user.id);
    for (const id of list) {
      if (!sharesBurrow(user.id, id) && !areFriends(user.id, id)) throw new HttpError(403, 'You can only message friends and people who share a hearth with you');
      if (blockedEitherWay(user.id, id)) throw new HttpError(403, "You can't message this person");
    }
    return list;
  };
  const isGroupDm = (serverId: number) => !!db.prepare("SELECT 1 FROM servers WHERE id = ? AND kind = 'dm' AND dm_key IS NULL").get(serverId);

  /**
   * Opens your conversation with someone, starting it if needed. With several people (userIds)
   * it starts a group conversation instead. You can only message people you share a burrow with.
   */
  route('POST', '/api/dms', ({ user, body }) => {
    notBot(user);
    // A conversation you already have stays open to you, even if you no longer share a burrow.
    const ids = (Array.isArray(body.userIds) ? body.userIds : [body.userId]).map(Number);
    if (ids.length === 1 && ids[0] !== user.id) {
      const existing = db.prepare('SELECT id FROM servers WHERE dm_key = ?').get([user.id, ids[0]].sort((a, b) => a - b).join(':')) as { id: number } | undefined;
      if (existing) return serverSummary(existing.id, user.id);
    }
    const others = dmPeople(user, ids);
    if (!others.length) throw new HttpError(400, "You can't message yourself");
    if (others.length + 1 > MAX_GROUP_DM) throw new HttpError(400, `A group conversation can have up to ${MAX_GROUP_DM} people`);
    const key = others.length === 1 ? [user.id, others[0]].sort((a, b) => a - b).join(':') : null;
    const name = key ? '' : typeof body.name === 'string' ? body.name.trim().slice(0, 64) : '';
    const t = now();
    const r = db
      .prepare("INSERT INTO servers (name, owner_id, invite_code, created_at, kind, dm_key) VALUES (?, ?, ?, ?, 'dm', ?)")
      .run(name, user.id, newInviteCode(), t, key);
    const serverId = Number(r.lastInsertRowid);
    for (const id of [user.id, ...others])
      db.prepare('INSERT INTO members (server_id, user_id, joined_at) VALUES (?, ?, ?)').run(serverId, id, t);
    db.prepare('INSERT INTO channels (server_id, name, created_at) VALUES (?, ?, ?)').run(serverId, 'dm', t);
    sendServerUpdate(serverId);
    return serverSummary(serverId, user.id);
  });

  // Anyone in a group conversation can add people (that they share a burrow with).
  route('POST', '/api/dms/:id/members', ({ user, params, body }) => {
    const serverId = Number(params[0]);
    if (!isGroupDm(serverId) || !isMember(serverId, user.id)) throw new HttpError(404, 'Conversation not found');
    const adding = dmPeople(user, body.userIds).filter((id) => !isMember(serverId, id));
    if (serverMemberIds(serverId).length + adding.length > MAX_GROUP_DM)
      throw new HttpError(400, `A group conversation can have up to ${MAX_GROUP_DM} people`);
    for (const id of adding) db.prepare('INSERT INTO members (server_id, user_id, joined_at) VALUES (?, ?, ?)').run(serverId, id, now());
    sendServerUpdate(serverId);
    return serverSummary(serverId, user.id);
  });

  /** Leaves a group conversation. The last one out takes it with them. */
  const leaveGroup = (serverId: number, user: User) => {
    db.prepare('DELETE FROM members WHERE server_id = ? AND user_id = ?').run(serverId, user.id);
    sendTo([user.id], { type: 'server_deleted', serverId });
    if (serverMemberIds(serverId).length) {
      sendServerUpdate(serverId);
    } else {
      removeFiles(db.prepare('SELECT a.id FROM attachments a JOIN channels c ON c.id = a.channel_id WHERE c.server_id = ?').all(serverId) as Json[]);
      db.prepare('DELETE FROM servers WHERE id = ?').run(serverId);
    }
    return { ok: true };
  };

  route('POST', '/api/servers', ({ user, body }) => {
    notBot(user);
    const name = cleanName(body.name, 'Hearth name');
    const t = now();
    const r = db
      .prepare('INSERT INTO servers (name, owner_id, invite_code, created_at) VALUES (?, ?, ?, ?)')
      .run(name, user.id, newInviteCode(), t);
    const serverId = Number(r.lastInsertRowid);
    db.prepare('INSERT INTO members (server_id, user_id, joined_at) VALUES (?, ?, ?)').run(serverId, user.id, t);
    db.prepare('INSERT INTO channels (server_id, name, created_at) VALUES (?, ?, ?)').run(serverId, 'general', t);
    addModeratorRole(db, serverId);
    return serverSummary(serverId, user.id);
  });

  // The code can be pasted on its own or as a whole invite link.
  route('POST', '/api/join', ({ user, body }) => {
    notBot(user);
    const { serverId, invite } = inviteTarget(body.inviteCode);
    if (db.prepare('SELECT 1 FROM bans WHERE server_id = ? AND user_id = ?').get(serverId, user.id))
      throw new HttpError(403, "You've been banned from this hearth");
    if (!isMember(serverId, user.id)) {
      db.prepare('INSERT INTO members (server_id, user_id, joined_at) VALUES (?, ?, ?)').run(serverId, user.id, now());
      if (invite) db.prepare('UPDATE invites SET uses = uses + 1 WHERE code = ?').run(invite);
      sendServerUpdate(serverId);
    }
    return serverSummary(serverId, user.id);
  });

  route('POST', '/api/servers/:id/leave', ({ user, params }) => {
    const serverId = Number(params[0]);
    if (isGroupDm(serverId) && isMember(serverId, user.id)) return leaveGroup(serverId, user);
    const owner = db.prepare("SELECT owner_id FROM servers WHERE id = ? AND kind = 'burrow'").get(serverId) as
      | { owner_id: number }
      | undefined;
    if (!owner || !isMember(serverId, user.id)) throw new HttpError(404, 'Hearth not found');
    if (owner.owner_id === user.id) deleteBurrow(serverId);
    else removeMember(serverId, user.id);
    return { ok: true };
  });

  /** A host leaving deletes the burrow, with its files, pictures and emoji. */
  const deleteBurrow = (serverId: number) => {
    broadcastToServer(serverId, { type: 'server_deleted', serverId });
    for (const id of voiceRoomIds(serverId)) closeVoiceRoom(id);
    removeFiles(
      db
        .prepare('SELECT a.id FROM attachments a JOIN channels c ON c.id = a.channel_id WHERE c.server_id = ?')
        .all(serverId) as Json[],
    );
    removeBurrowPicture(serverId);
    removeBurrowPicture(serverId, 'banner');
    for (const e of db.prepare('SELECT file FROM custom_emoji WHERE server_id = ?').all(serverId) as { file: string }[]) removeEmojiFile(e.file);
    db.prepare('DELETE FROM servers WHERE id = ?').run(serverId);
  };

  /** Takes someone out of a burrow: out of its voice rooms, its private rooms and its member list. */
  const removeMember = (serverId: number, userId: number) => {
    // Every voice room in the burrow, not just the one we think they're in: the app may not have said.
    for (const id of voiceRoomIds(serverId)) kickFromVoice(userId, id);
    db.prepare('DELETE FROM channel_access WHERE user_id = ? AND channel_id IN (SELECT id FROM channels WHERE server_id = ?)').run(userId, serverId);
    db.prepare('DELETE FROM members WHERE server_id = ? AND user_id = ?').run(serverId, userId);
    sendServerUpdate(serverId);
  };

  /** Your standing in a burrow, if it lets you do this. */
  const allowed = (serverId: number, user: User, perm: Perm) => {
    const kind = (db.prepare('SELECT kind FROM servers WHERE id = ?').get(serverId) as { kind: string } | undefined)?.kind;
    const me = kind === 'burrow' ? standing(serverId, user.id) : null;
    if (!me) throw new HttpError(404, 'Hearth not found');
    if (!me.perms.has(perm)) throw new HttpError(403, "Your roles don't allow that");
    return me;
  };

  /** Checks a private room's guest list: people in the burrow, without duplicates. */
  const accessList = (serverId: number, ids: unknown) => {
    const members = new Set(serverMemberIds(serverId));
    return [...new Set(Array.isArray(ids) ? ids.map(Number) : [])].filter((id) => members.has(id));
  };
  /** The same for roles: this burrow's roles, without duplicates. */
  const roleList = (serverId: number, ids: unknown) => {
    const roles = new Set((db.prepare('SELECT id FROM roles WHERE server_id = ?').all(serverId) as { id: number }[]).map((r) => r.id));
    return [...new Set(Array.isArray(ids) ? ids.map(Number) : [])].filter((id) => roles.has(id));
  };
  const setAccess = (channelId: number, ids: number[], roleIds: number[]) => {
    db.prepare('DELETE FROM channel_access WHERE channel_id = ?').run(channelId);
    for (const id of ids) db.prepare('INSERT INTO channel_access (channel_id, user_id) VALUES (?, ?)').run(channelId, id);
    db.prepare('DELETE FROM channel_role_access WHERE channel_id = ?').run(channelId);
    for (const id of roleIds) db.prepare('INSERT INTO channel_role_access (channel_id, role_id) VALUES (?, ?)').run(channelId, id);
  };

  /** After rooms or roles change: anyone in a voice room they can no longer see is taken out, and everyone gets the new view. */
  const accessChanged = (serverId: number) => {
    for (const [u, c] of inVoice) {
      const channel = channelById(c);
      if (channel?.serverId === serverId && !canSee(channel, u)) kickFromVoice(u);
    }
    sendServerUpdate(serverId);
  };

  // ---- custom roles ----
  // People who manage roles can only touch roles below their own highest role,
  // and can't hand out permissions they don't have themselves. The host can do anything.

  const roleById = (id: number) =>
    db.prepare('SELECT id, server_id AS serverId, position, perms FROM roles WHERE id = ?').get(id) as
      | { id: number; serverId: number; position: number; perms: string }
      | undefined;
  const cleanColor = (value: unknown) => {
    if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw new HttpError(400, 'Color must look like #4f8a5b');
    return value.toLowerCase();
  };
  // Permissions you don't have yourself stay as they were.
  const cleanPerms = (value: unknown, me: Standing, current = '') => {
    const wanted = new Set(parsePerms(Array.isArray(value) ? value.join(',') : ''));
    const had = new Set(parsePerms(current));
    return PERMS.filter((p) => (me.perms.has(p) ? wanted.has(p) : had.has(p))).join(',');
  };
  /** The role, if you're allowed to change it. */
  const managedRole = (id: number, user: User) => {
    const role = roleById(id);
    if (!role || !isMember(role.serverId, user.id)) throw new HttpError(404, 'Role not found');
    const me = allowed(role.serverId, user, 'roles');
    if (role.position <= me.rank) throw new HttpError(403, 'You can only change roles below your own');
    return { role, me };
  };

  route('POST', '/api/servers/:id/roles', ({ user, params, body }) => {
    const serverId = Number(params[0]);
    const me = allowed(serverId, user, 'roles');
    const count = (db.prepare('SELECT COUNT(*) AS n, MAX(position) AS last FROM roles WHERE server_id = ?').get(serverId) as { n: number; last: number | null });
    if (count.n >= MAX_ROLES) throw new HttpError(400, `A hearth can have at most ${MAX_ROLES} roles`);
    // New roles start at the bottom, below everyone's.
    const name = cleanName(body.name, 'Role name', 32);
    audit(serverId, user.id, 'role_create', null, name);
    db.prepare('INSERT INTO roles (server_id, name, color, perms, position, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      serverId,
      name,
      cleanColor(body.color ?? '#8a8f87'),
      cleanPerms(body.perms, me),
      (count.last ?? 0) + 1,
      now(),
    );
    if (body.uploadMb !== undefined) db.prepare('UPDATE roles SET upload_mb = ? WHERE id = (SELECT MAX(id) FROM roles WHERE server_id = ?)').run(cleanUploadMb(body.uploadMb), serverId);
    sendServerUpdate(serverId);
    return serverSummary(serverId, user.id);
  });

  // Rename, recolor, change permissions, or move up or down one place.
  route('PATCH', '/api/roles/:id', ({ user, params, body }) => {
    const { role, me } = managedRole(Number(params[0]), user);
    if (body.name !== undefined) db.prepare('UPDATE roles SET name = ? WHERE id = ?').run(cleanName(body.name, 'Role name', 32), role.id);
    if (body.color !== undefined) db.prepare('UPDATE roles SET color = ? WHERE id = ?').run(cleanColor(body.color), role.id);
    if (body.perms !== undefined) db.prepare('UPDATE roles SET perms = ? WHERE id = ?').run(cleanPerms(body.perms, me, role.perms), role.id);
    if (body.uploadMb !== undefined) db.prepare('UPDATE roles SET upload_mb = ? WHERE id = ?').run(cleanUploadMb(body.uploadMb), role.id);
    if (body.name !== undefined || body.color !== undefined || body.perms !== undefined || body.uploadMb !== undefined)
      audit(role.serverId, user.id, 'role_edit', null, roleName(role.id));
    if (body.move === 'up' || body.move === 'down') {
      const neighbor = db
        .prepare(
          body.move === 'up'
            ? 'SELECT id, position FROM roles WHERE server_id = ? AND position < ? ORDER BY position DESC LIMIT 1'
            : 'SELECT id, position FROM roles WHERE server_id = ? AND position > ? ORDER BY position LIMIT 1',
        )
        .get(role.serverId, role.position) as { id: number; position: number } | undefined;
      if (neighbor && neighbor.position <= me.rank) throw new HttpError(403, "You can't move a role above your own");
      if (neighbor) {
        db.prepare('UPDATE roles SET position = ? WHERE id = ?').run(neighbor.position, role.id);
        db.prepare('UPDATE roles SET position = ? WHERE id = ?').run(role.position, neighbor.id);
      }
    }
    accessChanged(role.serverId);
    return serverSummary(role.serverId, user.id);
  });

  route('DELETE', '/api/roles/:id', ({ user, params }) => {
    const { role } = managedRole(Number(params[0]), user);
    audit(role.serverId, user.id, 'role_delete', null, roleName(role.id));
    db.prepare('DELETE FROM roles WHERE id = ?').run(role.id);
    accessChanged(role.serverId);
    return serverSummary(role.serverId, user.id);
  });

  // Gives someone exactly these roles. Roles at or above your own stay as they are.
  route('POST', '/api/servers/:id/members/:id/roles', ({ user, params, body }) => {
    const [serverId, targetId] = params.map(Number);
    const me = allowed(serverId, user, 'roles');
    const target = standing(serverId, targetId);
    if (!target) throw new HttpError(404, "They aren't in this hearth");
    if (targetId !== user.id && target.rank <= me.rank) throw new HttpError(403, "You can't change their roles");
    const wanted = new Set(roleList(serverId, body.roleIds));
    const changeable = (id: number) => roleById(id)!.position > me.rank;
    for (const id of new Set([...wanted, ...target.roleIds])) {
      if (wanted.has(id) === target.roleIds.includes(id)) continue;
      if (!changeable(id)) throw new HttpError(403, 'You can only give or take roles below your own');
      if (wanted.has(id)) db.prepare('INSERT INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)').run(serverId, targetId, id);
      else db.prepare('DELETE FROM member_roles WHERE role_id = ? AND user_id = ?').run(id, targetId);
      audit(serverId, user.id, wanted.has(id) ? 'role_give' : 'role_take', targetId, roleName(id));
    }
    accessChanged(serverId);
    return { ok: true };
  });

  // Removes someone; with ban: true they can't come back with the invite code.
  // You can only remove people whose highest role is below yours.
  route('POST', '/api/servers/:id/members/:id/remove', ({ user, params, body }) => {
    const [serverId, targetId] = params.map(Number);
    const me = allowed(serverId, user, body.ban ? 'ban' : 'remove');
    const target = standing(serverId, targetId);
    if (!target) throw new HttpError(404, "They aren't in this hearth");
    if (target.host || target.rank <= me.rank || targetId === user.id) throw new HttpError(403, "You can't remove them");
    if (body.ban) db.prepare('INSERT OR IGNORE INTO bans (server_id, user_id, banned_at) VALUES (?, ?, ?)').run(serverId, targetId, now());
    audit(serverId, user.id, body.ban ? 'ban' : 'remove', targetId);
    removeMember(serverId, targetId);
    sendTo([targetId], { type: 'server_deleted', serverId });
    return { ok: true };
  });

  route('GET', '/api/servers/:id/bans', ({ user, params }) => {
    allowed(Number(params[0]), user, 'ban');
    return db
      .prepare(
        `SELECT u.id, u.username, ${avatarUrl('u.avatar')} AS avatar, b.banned_at AS bannedAt
         FROM bans b JOIN users u ON u.id = b.user_id WHERE b.server_id = ? ORDER BY b.banned_at DESC`,
      )
      .all(Number(params[0]));
  });

  route('DELETE', '/api/servers/:id/bans/:id', ({ user, params }) => {
    const [serverId, targetId] = params.map(Number);
    allowed(serverId, user, 'ban');
    db.prepare('DELETE FROM bans WHERE server_id = ? AND user_id = ?').run(serverId, targetId);
    audit(serverId, user.id, 'unban', targetId);
    return { ok: true };
  });

  route('POST', '/api/servers/:id/channels', ({ user, params, body }) => {
    const serverId = Number(params[0]);
    allowed(serverId, user, 'rooms');
    const kind = body.kind === 'voice' ? 'voice' : 'text';
    const name = roomName(body.name, kind);
    const last = (db.prepare("SELECT MAX(COALESCE(position, id)) AS p FROM channels WHERE server_id = ? AND kind != 'thread'").get(serverId) as { p: number | null }).p;
    const groupId = kind === 'text' && body.groupId != null ? groupIn(serverId, body.groupId) : null;
    const r = db
      .prepare('INSERT INTO channels (server_id, name, kind, private, created_at, position, group_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(serverId, name, kind, body.private ? 1 : 0, now(), (last ?? 0) + 1, groupId);
    if (body.private) setAccess(Number(r.lastInsertRowid), accessList(serverId, body.memberIds), roleList(serverId, body.roleIds));
    sendServerUpdate(serverId);
    return serverSummary(serverId, user.id);
  });

  // Text rooms read like #game-night; voice rooms keep their spaces ("Game Night").
  const roomName = (value: unknown, kind: string) => {
    const name = cleanName(value, 'Room name', 32);
    return kind === 'text' ? name.toLowerCase().replace(/\s+/g, '-') : name;
  };

  // Rename a room, make it private or public, or change who's let in.
  route('PATCH', '/api/channels/:id', ({ user, params, body }) => {
    const channel = channelById(Number(params[0]));
    if (!channel || !canSee(channel, user.id)) throw new HttpError(404, 'Room not found');
    if (channel.kind === 'thread') return renameThread(channel, user, body.name);
    allowed(channel.serverId, user, 'rooms');
    if (body.name !== undefined) db.prepare('UPDATE channels SET name = ? WHERE id = ?').run(roomName(body.name, channel.kind), channel.id);
    if (body.private !== undefined) db.prepare('UPDATE channels SET private = ? WHERE id = ?').run(body.private ? 1 : 0, channel.id);
    if (body.memberIds !== undefined || body.roleIds !== undefined)
      setAccess(channel.id, accessList(channel.serverId, body.memberIds), roleList(channel.serverId, body.roleIds));
    if (body.topic !== undefined) {
      const topic = typeof body.topic === 'string' ? body.topic.trim() : '';
      if (topic.length > MAX_TOPIC) throw new HttpError(400, `The topic can be at most ${MAX_TOPIC} characters`);
      db.prepare('UPDATE channels SET topic = ? WHERE id = ?').run(topic, channel.id);
    }
    if (body.slow !== undefined) {
      const slow = Math.floor(Number(body.slow) || 0);
      if (slow < 0 || slow > 6 * 3600) throw new HttpError(400, 'Slow mode can be at most 6 hours');
      db.prepare('UPDATE channels SET slow_seconds = ? WHERE id = ?').run(slow, channel.id);
    }
    if (body.announce !== undefined) db.prepare('UPDATE channels SET announce = ? WHERE id = ?').run(body.announce ? 1 : 0, channel.id);
    if (body.postRoleIds !== undefined) {
      db.prepare('DELETE FROM channel_post_roles WHERE channel_id = ?').run(channel.id);
      for (const id of roleList(channel.serverId, body.postRoleIds))
        db.prepare('INSERT INTO channel_post_roles (channel_id, role_id) VALUES (?, ?)').run(channel.id, id);
    }
    if (body.readOnlyRoleIds !== undefined) {
      db.prepare('DELETE FROM channel_read_only WHERE channel_id = ?').run(channel.id);
      for (const id of roleList(channel.serverId, body.readOnlyRoleIds))
        db.prepare('INSERT INTO channel_read_only (channel_id, role_id) VALUES (?, ?)').run(channel.id, id);
    }
    if (body.userLimit !== undefined && channel.kind === 'voice') {
      const limit = Math.floor(Number(body.userLimit) || 0);
      if (limit < 0 || limit > 99) throw new HttpError(400, 'A fire can have up to 99 seats');
      db.prepare('UPDATE channels SET user_limit = ? WHERE id = ?').run(limit, channel.id);
    }
    if (body.keepChat !== undefined && channel.kind === 'voice') {
      db.prepare('UPDATE channels SET keep_chat = ? WHERE id = ?').run(body.keepChat ? 1 : 0, channel.id);
      // Turned off: what was kept goes, and the chat now lives only while people are at the fire.
      if (!body.keepChat) db.prepare('DELETE FROM fireside_messages WHERE channel_id = ?').run(channel.id);
      else if (fireside.has(channel.id)) {
        for (const m of fireside.get(channel.id)!)
          db.prepare('INSERT INTO fireside_messages (channel_id, user_id, author, content, created_at) VALUES (?, ?, ?, ?, ?)').run(channel.id, m.userId as number, m.author as string, m.content as string, m.createdAt as number);
        fireside.delete(channel.id);
      }
    }
    if (body.archived !== undefined && channel.kind === 'text') {
      if (body.archived && !channel.archivedAt) {
        const open = db.prepare("SELECT COUNT(*) AS n FROM channels WHERE server_id = ? AND kind = 'text' AND archived_at IS NULL").get(channel.serverId) as { n: number };
        if (open.n <= 1) throw new HttpError(400, 'A hearth needs at least one text room that isn\'t archived');
      }
      db.prepare('UPDATE channels SET archived_at = ? WHERE id = ?').run(body.archived ? channel.archivedAt ?? now() : null, channel.id);
    }
    audit(channel.serverId, user.id, 'room_edit', null, `#${channelById(channel.id)!.name}`);
    accessChanged(channel.serverId);
    return serverSummary(channel.serverId, user.id);
  });

  route('DELETE', '/api/channels/:id', ({ user, params }) => {
    const channel = channelById(Number(params[0]));
    if (!channel || !canSee(channel, user.id)) throw new HttpError(404, 'Room not found');
    const threadMessage = channel.kind === 'thread' ? manageableThread(channel, user) : null;
    if (channel.kind !== 'thread') allowed(channel.serverId, user, 'rooms');
    const textRooms = db.prepare("SELECT COUNT(*) AS n FROM channels WHERE server_id = ? AND kind = 'text'").get(channel.serverId) as { n: number };
    if (channel.kind === 'text' && textRooms.n <= 1) throw new HttpError(400, 'A hearth needs at least one text room');
    if (channel.kind === 'voice') closeVoiceRoom(channel.id);
    if (channel.kind !== 'thread') audit(channel.serverId, user.id, 'room_delete', null, `#${channel.name}`);
    removeFiles(
      db.prepare('SELECT id FROM attachments WHERE channel_id = ? OR channel_id IN (SELECT id FROM channels WHERE parent_id = ?)').all(channel.id, channel.id) as Json[],
    );
    db.prepare('DELETE FROM channels WHERE id = ?').run(channel.id);
    if (channel.kind === 'thread') threadDeleted(channel, threadMessage);
    sendServerUpdate(channel.serverId);
    return { ok: true };
  });

  route('POST', '/api/channels/:id/voice', ({ user, params }) => {
    const channel = channelById(Number(params[0]));
    if (!channel || !canSee(channel, user.id)) throw new HttpError(404, 'Room not found');
    if (channel.kind !== 'voice') throw new HttpError(400, 'That is not a voice room');
    if (!opts.voice) throw new HttpError(503, 'Voice is not set up on this server');
    checkSeat(channel, user.id);
    const canSpeak = !serverMuted(channel.serverId, user.id);
    return { url: opts.voice.url ?? null, token: voiceToken(opts.voice, user, `room-${channel.id}`, undefined, canSpeak), canSpeak };
  });

  // ---- voice and the Campfire -----------------------------------------------

  // Someone moved by a moderator (or to the AFK fire) gets a seat even at a full fire, for a little while.
  const pendingMoves = new Map<number, { channelId: number; until: number }>();
  /** A fire with a seat limit is full for everyone but people who manage voice, and people being moved there. */
  const checkSeat = (channel: Channel, userId: number) => {
    if (!channel.userLimit || inVoice.get(userId) === channel.id) return;
    const move = pendingMoves.get(userId);
    if (move && move.channelId === channel.id && move.until > Date.now()) return;
    if (usersInVoice(channel.id).length >= channel.userLimit && !can(channel.serverId, userId, 'voice'))
      throw new HttpError(403, `This fire is full (${channel.userLimit} seats)`);
  };

  /** Someone in a voice room of this burrow that you may move, mute or disconnect. */
  const voiceTarget = (serverId: number, user: User, targetId: number) => {
    const me = allowed(serverId, user, 'voice');
    const target = standing(serverId, targetId);
    if (!target) throw new HttpError(404, "They aren't in this hearth");
    if (targetId !== user.id && (target.host || target.rank <= me.rank)) throw new HttpError(403, "You can't do that to them");
    return target;
  };
  const moveTo = (userId: number, channelId: number, extra: Json = {}) => {
    pendingMoves.set(userId, { channelId, until: Date.now() + 30_000 });
    sendTo([userId], { type: 'voice_move', channelId, ...extra });
  };

  // Moving someone to another fire in the same burrow. Their app takes them there.
  route('POST', '/api/voice/move', ({ user, body }) => {
    const to = channelById(Number(body.channelId));
    const targetId = Number(body.userId);
    const from = channelById(inVoice.get(targetId) ?? -1);
    if (!to || to.kind !== 'voice' || !canSee(to, user.id)) throw new HttpError(404, 'Room not found');
    voiceTarget(to.serverId, user, targetId);
    if (!from || from.serverId !== to.serverId) throw new HttpError(400, "They aren't at a fire in this hearth");
    if (!canSee(to, targetId)) throw new HttpError(403, "They can't see that room");
    if (from.id !== to.id) {
      audit(to.serverId, user.id, 'voice_move', targetId, `#${from.name} › #${to.name}`);
      moveTo(targetId, to.id, { by: nameIn(to.serverId, user.id) });
    }
    return { ok: true };
  });

  route('POST', '/api/voice/disconnect', ({ user, body }) => {
    const targetId = Number(body.userId);
    const from = channelById(inVoice.get(targetId) ?? -1);
    if (!from) throw new HttpError(400, "They aren't at a fire");
    voiceTarget(from.serverId, user, targetId);
    sendTo([targetId], { type: 'voice_kicked', by: user.displayName || user.username });
    audit(from.serverId, user.id, 'voice_disconnect', targetId, `#${from.name}`);
    kickFromVoice(targetId);
    return { ok: true };
  });

  // Muted for everyone, in every voice room of the burrow, until a moderator lets them speak again.
  // LiveKit stops taking their microphone too, so it doesn't rely on their app playing along.
  route('POST', '/api/servers/:id/members/:id/voice-mute', ({ user, params, body }) => {
    const [serverId, targetId] = params.map(Number);
    if (targetId === user.id) throw new HttpError(400, "You can't mute yourself for everyone");
    voiceTarget(serverId, user, targetId);
    const muted = body.muted === true;
    db.prepare('UPDATE members SET voice_muted = ? WHERE server_id = ? AND user_id = ?').run(muted ? 1 : 0, serverId, targetId);
    audit(serverId, user.id, muted ? 'voice_mute' : 'voice_unmute', targetId);
    sendTo([targetId], { type: 'server_muted', serverId, muted });
    sendServerUpdate(serverId);
    const channel = channelById(inVoice.get(targetId) ?? -1);
    if (channel?.serverId === serverId) {
      tellLiveKit(`change whether user ${targetId} can speak`, (v) => setCanSpeak(v, `room-${channel.id}`, String(targetId), !muted));
      broadcastToChannel(channel, voiceStateEvent(channel.id));
    }
    return { ok: true };
  });

  // The AFK fire: people who haven't talked or touched the app for a while are moved there.
  const checkAfk = (t = Date.now()) => {
    for (const [userId, channelId] of inVoice) {
      const channel = channelById(channelId);
      if (!channel) continue;
      const afk = db.prepare("SELECT afk_channel_id AS id, afk_minutes AS minutes FROM servers WHERE id = ? AND kind = 'burrow'").get(channel.serverId) as
        | { id: number | null; minutes: number }
        | undefined;
      if (!afk?.id || afk.id === channelId) continue;
      if (t - (lastActive.get(userId) ?? t) < afk.minutes * 60_000) continue;
      const to = channelById(afk.id);
      if (to?.kind !== 'voice' || to.serverId !== channel.serverId || !canSee(to, userId)) continue;
      lastActive.set(userId, t);
      moveTo(userId, to.id, { afk: true });
    }
  };
  const afkTimer = setInterval(() => checkAfk(), 30_000);
  afkTimer.unref();

  // ---- the soundboard: each burrow's short clips, played for everyone at its fires

  const soundsOf = (serverId: number) =>
    db.prepare("SELECT id, name, emoji, '/api/sounds/' || file AS url FROM sounds WHERE server_id = ? ORDER BY name").all(serverId);
  const soundPath = (file: string) => picturePath('sounds', file);
  const soundName = (value: unknown) => {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name || name.length > 32) throw new HttpError(400, 'Sound names are 1 to 32 characters');
    return name;
  };
  // An emoji shown on the sound's button: one emoji, or one of the burrow's own.
  const soundEmoji = (value: unknown) => {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text.length > 64) throw new HttpError(400, 'Pick one emoji');
    return text;
  };

  const handleSoundUpload = async (req: IncomingMessage, res: ServerResponse, serverId: number, url: URL) => {
    const user = pictureUploader(req);
    allowed(serverId, user, 'emoji');
    const name = soundName(url.searchParams.get('name'));
    const emoji = soundEmoji(url.searchParams.get('emoji'));
    const check = () => {
      const count = (db.prepare('SELECT COUNT(*) AS n FROM sounds WHERE server_id = ?').get(serverId) as { n: number }).n;
      if (count >= MAX_SOUNDS) throw new HttpError(400, `A hearth can have up to ${MAX_SOUNDS} sounds`);
    };
    check();
    const tooBig = new HttpError(413, `Sounds can be at most ${MAX_SOUND_BYTES / 1024} KB`);
    if (Number(req.headers['content-length']) > MAX_SOUND_BYTES) throw tooBig;
    const chunks: Buffer[] = [];
    let size = 0;
    await new Promise<void>((resolve, reject) => {
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_SOUND_BYTES) {
          req.pause();
          reject(tooBig);
        } else chunks.push(c);
      });
      req.on('end', resolve);
      req.on('error', reject);
    });
    const data = Buffer.concat(chunks);
    const kind = SOUND_TYPES.find((t) => t.magic(data));
    if (!kind) throw new HttpError(400, 'Sounds must be MP3, OGG, WAV, WebM or M4A audio');
    allowed(serverId, user, 'emoji');
    check();
    const file = `${randomBytes(16).toString('base64url')}.${kind.ext}`;
    await mkdir(join(opts.uploadDir!, 'sounds'), { recursive: true });
    await writeFile(soundPath(file), data);
    db.prepare('INSERT INTO sounds (server_id, name, emoji, file, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(serverId, name, emoji, file, user.id, now());
    sendServerUpdate(serverId);
    send(res, 200, serverSummary(serverId, user.id));
  };

  const serveSound = async (req: IncomingMessage, res: ServerResponse, file: string) => {
    const kind = SOUND_TYPES.find((t) => file.endsWith('.' + t.ext))!;
    const info = opts.uploadDir ? await stat(soundPath(file)).catch(() => null) : null;
    if (!info) throw new HttpError(404, 'Sound not found');
    res.writeHead(200, {
      'content-type': kind.type,
      'content-length': info.size,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'public, max-age=31536000, immutable',
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(soundPath(file)).pipe(res);
  };

  const managedSound = (id: number, user: User) => {
    const row = db.prepare('SELECT id, server_id, file FROM sounds WHERE id = ?').get(id) as { id: number; server_id: number; file: string } | undefined;
    if (!row || !isMember(row.server_id, user.id)) throw new HttpError(404, 'Sound not found');
    allowed(row.server_id, user, 'emoji');
    return row;
  };
  route('PATCH', '/api/sounds/:id', ({ user, params, body }) => {
    const row = managedSound(Number(params[0]), user);
    if (body.name !== undefined) db.prepare('UPDATE sounds SET name = ? WHERE id = ?').run(soundName(body.name), row.id);
    if (body.emoji !== undefined) db.prepare('UPDATE sounds SET emoji = ? WHERE id = ?').run(soundEmoji(body.emoji), row.id);
    sendServerUpdate(row.server_id);
    return serverSummary(row.server_id, user.id);
  });
  route('DELETE', '/api/sounds/:id', ({ user, params }) => {
    const row = managedSound(Number(params[0]), user);
    db.prepare('DELETE FROM sounds WHERE id = ?').run(row.id);
    if (opts.uploadDir) unlink(soundPath(row.file)).catch(() => {});
    sendServerUpdate(row.server_id);
    return serverSummary(row.server_id, user.id);
  });

  const lastSound = new Map<number, number>(); // userId -> when they last played one
  /** Plays a clip for everyone at your fire. Each app fetches and plays it itself. */
  const playSound = (user: User, soundId: number) => {
    const channel = channelById(inVoice.get(user.id) ?? -1);
    if (!channel) throw new HttpError(400, 'Join a fire to play sounds');
    const sound = db.prepare("SELECT id, '/api/sounds/' || file AS url FROM sounds WHERE id = ? AND server_id = ?").get(soundId, channel.serverId) as Json | undefined;
    if (!sound) throw new HttpError(404, 'Sound not found');
    if (serverMuted(channel.serverId, user.id)) throw new HttpError(403, "You've been muted here");
    const t = Date.now();
    if (t - (lastSound.get(user.id) ?? 0) < 2000) throw new HttpError(429, 'One sound at a time');
    lastSound.set(user.id, t);
    lastActive.set(user.id, t);
    sendTo(usersInVoice(channel.id), { type: 'soundboard', channelId: channel.id, userId: user.id, soundId, url: sound.url });
  };

  // ---- listen together

  const listenTogether = (user: User, msg: Json) => {
    const channelId = inVoice.get(user.id);
    if (channelId === undefined) throw new HttpError(400, 'Join a fire to listen together');
    const t = Date.now();
    const l = listening.get(channelId);
    const here = (l: Listening) => l.position + (l.playing ? (t - l.since) / 1000 : 0);
    const position = (value: unknown) => Math.max(0, Math.min(Number(value) || 0, 24 * 3600));
    if (msg.action === 'start') {
      const videoId = typeof msg.videoId === 'string' && /^[\w-]{11}$/.test(msg.videoId) ? msg.videoId : null;
      if (!videoId) throw new HttpError(400, "That isn't a YouTube video");
      listening.set(channelId, { videoId, title: '', playing: true, position: position(msg.position), since: t, by: user.id });
    } else if (!l) {
      return;
    } else if (msg.action === 'title') {
      // The app that started it says what it's called, once the video has loaded.
      if (l.title || typeof msg.title !== 'string') return;
      l.title = msg.title.trim().slice(0, 200);
    } else if (msg.action === 'pause' || msg.action === 'play') {
      Object.assign(l, { position: here(l), since: t, playing: msg.action === 'play' });
    } else if (msg.action === 'seek') {
      Object.assign(l, { position: position(msg.position), since: t });
    } else if (msg.action === 'ended') {
      // Stops at the end for everyone, rather than starting over.
      Object.assign(l, { position: here(l), since: t, playing: false });
    } else if (msg.action === 'stop') {
      listening.delete(channelId);
    } else return;
    lastActive.set(user.id, t);
    sendTo(usersInVoice(channelId), listenEvent(channelId));
  };

  // ---- calls in direct messages: a conversation's own voice room, and ringing the others

  const callRoom = (serverId: number) =>
    (db.prepare("SELECT id FROM channels WHERE server_id = ? AND kind = 'voice'").get(serverId) as { id: number } | undefined)?.id;
  route('POST', '/api/dms/:id/call', ({ user, params }) => {
    const serverId = Number(params[0]);
    const kind = (db.prepare('SELECT kind FROM servers WHERE id = ?').get(serverId) as { kind: string } | undefined)?.kind;
    if (kind !== 'dm' || !isMember(serverId, user.id)) throw new HttpError(404, 'Conversation not found');
    if (!opts.voice) throw new HttpError(503, 'Voice is not set up on this server');
    let channelId = callRoom(serverId);
    if (channelId === undefined) {
      channelId = Number(db.prepare("INSERT INTO channels (server_id, name, kind, created_at) VALUES (?, 'Call', 'voice', ?)").run(serverId, now()).lastInsertRowid);
      sendServerUpdate(serverId);
    }
    const inCall = new Set(usersInVoice(channelId));
    const others = serverMemberIds(serverId).filter((id) => id !== user.id && !inCall.has(id));
    sendTo(others, { type: 'ring', serverId, channelId, from: { id: user.id, username: user.displayName || user.username } });
    return { channelId };
  });
  // Not picking up: the people in the call hear about it, and your other devices stop ringing.
  route('POST', '/api/dms/:id/call/decline', ({ user, params }) => {
    const serverId = Number(params[0]);
    if (!isMember(serverId, user.id)) throw new HttpError(404, 'Conversation not found');
    const channelId = callRoom(serverId);
    if (channelId !== undefined) sendTo(usersInVoice(channelId), { type: 'ring_declined', serverId, userId: user.id, username: user.displayName || user.username });
    sendTo([user.id], { type: 'ring_stop', serverId });
    return { ok: true };
  });

  // The newest messages, or with ?before= older ones, ?after= newer ones (oldest first),
  // or ?around= the messages either side of one (to jump to it).
  route('GET', '/api/channels/:id/messages', ({ user, params, url }) => {
    const channel = channelById(Number(params[0]));
    if (!channel || !canSee(channel, user.id)) throw new HttpError(404, 'Room not found');
    if (channel.kind === 'voice') return [];
    const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 100);
    const older = (before: number, n: number) =>
      (db.prepare(`${MESSAGE_SELECT} WHERE m.channel_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`).all(channel.id, before, n) as Json[]).reverse();
    const newer = (after: number, n: number) =>
      db.prepare(`${MESSAGE_SELECT} WHERE m.channel_id = ? AND m.id > ? ORDER BY m.id LIMIT ?`).all(channel.id, after, n) as Json[];
    const around = Number(url.searchParams.get('around'));
    if (around) return withAttachments([...older(around + 1, Math.ceil(limit / 2)), ...newer(around, Math.floor(limit / 2))]);
    const after = url.searchParams.get('after');
    if (after !== null) return withAttachments(newer(Number(after) || 0, limit));
    return withAttachments(older(Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER, limit));
  });

  route('POST', '/api/channels/:id/messages', ({ user, params, body }) => postMessage(user, Number(params[0]), body));

  const ownMessage = (user: User, id: number) => {
    const msg = db.prepare('SELECT author_id, channel_id FROM messages WHERE id = ?').get(id) as
      | { author_id: number; channel_id: number }
      | undefined;
    if (!msg) throw new HttpError(404, 'Message not found');
    if (msg.author_id !== user.id) throw new HttpError(403, 'You can only change your own messages');
    return channelById(msg.channel_id)!;
  };

  route('PATCH', '/api/messages/:id', ({ user, params, body }) => {
    const id = Number(params[0]);
    const channel = ownMessage(user, id);
    const hasFiles = !!db.prepare('SELECT 1 FROM attachments WHERE message_id = ?').get(id);
    if (typeof body.content !== 'string' || (!body.content.trim() && !hasFiles)) throw new HttpError(400, 'Message is empty');
    if (body.content.length > MAX_MESSAGE_LENGTH) throw new HttpError(400, 'Message is too long');
    const before = db.prepare('SELECT content, COALESCE(edited_at, created_at) AS at FROM messages WHERE id = ?').get(id) as { content: string; at: number };
    if (before.content === body.content) return messageById(id);
    const flagged = filterCheck(channel, user.id, body.content);
    // The old wording is kept, so anyone can see what an edited message used to say.
    db.prepare('INSERT INTO message_edits (message_id, content, edited_at) VALUES (?, ?, ?)').run(id, before.content, before.at);
    db.prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?').run(body.content, now(), id);
    // New @names count for the inbox, without alerting anyone again.
    const replyTo = (db.prepare('SELECT reply_to FROM messages WHERE id = ?').get(id) as { reply_to: number | null }).reply_to;
    recordMentions(channel, id, user.id, body.content, replyTo);
    const linksChanged = linksIn(before.content).join() !== linksIn(body.content).join();
    if (linksChanged) db.prepare('DELETE FROM message_embeds WHERE message_id = ?').run(id);
    const message = messageById(id)!;
    broadcastToChannel(channel, { type: 'message_updated', message });
    if (flagged) fileReport(channel.serverId, message, null, `Word filter: ${flagged}`);
    if (linksChanged) previewLinks(id, channel, body.content);
    return message;
  });

  // Adds your reaction, or takes it away if you'd already reacted with that emoji.
  route('POST', '/api/messages/:id/reactions', ({ user, params, body }) => {
    const id = Number(params[0]);
    const msg = db.prepare('SELECT channel_id FROM messages WHERE id = ?').get(id) as { channel_id: number } | undefined;
    const channel = msg && channelById(msg.channel_id);
    if (!channel || !canSee(channel, user.id)) throw new HttpError(404, 'Message not found');
    const emoji = typeof body.emoji === 'string' ? body.emoji.trim() : '';
    if (!emoji || !(isCustomEmoji(emoji, user.id) || (emoji.length <= 16 && EMOJI.test(emoji)))) throw new HttpError(400, 'That is not an emoji');
    const mine = db.prepare('SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').get(id, user.id, emoji);
    if (mine) {
      db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(id, user.id, emoji);
    } else {
      const kinds = reactionsFor(id);
      if (!kinds.some((k) => k.emoji === emoji) && kinds.length >= MAX_REACTIONS)
        throw new HttpError(400, 'That message has all the reactions it can hold');
      db.prepare('INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)').run(id, user.id, emoji, now());
    }
    const reactions = reactionsFor(id);
    broadcastToChannel(channel, { type: 'reactions', messageId: id, channelId: channel.id, reactions });
    return { reactions };
  });

  // Your own messages, or anyone's if you look after the burrow.
  route('DELETE', '/api/messages/:id', ({ user, params }) => {
    const id = Number(params[0]);
    const msg = db.prepare('SELECT author_id, channel_id FROM messages WHERE id = ?').get(id) as
      | { author_id: number; channel_id: number }
      | undefined;
    const channel = msg && channelById(msg.channel_id);
    if (!msg || !channel || !canSee(channel, user.id)) throw new HttpError(404, 'Message not found');
    if (msg.author_id !== user.id && !can(channel.serverId, user.id, 'messages'))
      throw new HttpError(403, 'You can only delete your own messages');
    if (msg.author_id !== user.id) {
      const text = (db.prepare('SELECT content FROM messages WHERE id = ?').get(id) as { content: string }).content;
      audit(channel.serverId, user.id, 'message_delete', msg.author_id, `in #${channel.name}: ${text.slice(0, 120)}`);
    }
    removeFiles(db.prepare('SELECT id FROM attachments WHERE message_id = ?').all(id) as Json[]);
    db.prepare('DELETE FROM messages WHERE id = ?').run(id);
    broadcastToChannel(channel, { type: 'message_deleted', id, channelId: channel.id });
    return { ok: true };
  });

  // ---- moderation: timeouts, the audit log, bulk delete, the word filter, reports, upload limits ----

  const isBurrow = (serverId: number) => !!db.prepare("SELECT 1 FROM servers WHERE id = ? AND kind = 'burrow'").get(serverId);
  const roleName = (id: number) => (db.prepare('SELECT name FROM roles WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? '';
  const BURROW_FIELDS: Record<string, string> = {
    name: 'name', description: 'description', welcomeChannelId: 'welcome room', afkChannelId: 'AFK fire', afkMinutes: 'AFK time',
    rules: 'rules', uploadMb: 'upload limit', wordFilter: 'word filter', liveChannelId: 'go-live room',
  };

  /** Notes who did what, for the audit log. */
  const audit = (serverId: number, actorId: number | null, action: string, targetId: number | null, detail = '') => {
    if (!isBurrow(serverId)) return;
    db.prepare('INSERT INTO audit_log (server_id, actor_id, action, target_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      serverId, actorId, action, targetId, detail.slice(0, 300), now(),
    );
  };
  route('GET', '/api/servers/:id/audit', ({ user, params, url }) => {
    const serverId = Number(params[0]);
    allowed(serverId, user, 'audit');
    const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
    const rows = db
      .prepare(
        `SELECT a.id, a.action, a.detail, a.created_at AS createdAt, a.actor_id AS actorId, COALESCE(ua.display_name, ua.username) AS actor, a.target_id AS targetId, COALESCE(ut.display_name, ut.username) AS target
         FROM audit_log a LEFT JOIN users ua ON ua.id = a.actor_id LEFT JOIN users ut ON ut.id = a.target_id
         WHERE a.server_id = ? AND a.id < ? ORDER BY a.id DESC LIMIT 51`,
      )
      .all(serverId, before) as Json[];
    return { entries: rows.slice(0, 50), more: rows.length > 50 };
  });

  // Timeouts: someone can't write, react with files, or talk at a fire until it runs out.
  const MAX_TIMEOUT_MINUTES = 7 * 24 * 60;
  const timeoutTimers = new Map<string, NodeJS.Timeout>();
  const timeoutUntil = (serverId: number, userId: number) =>
    (db.prepare('SELECT timeout_until FROM members WHERE server_id = ? AND user_id = ?').get(serverId, userId) as { timeout_until: number | null } | undefined)?.timeout_until ?? 0;
  /** "12 minutes" or "3 hours" left on a timeout, or null if there isn't one. */
  const timeoutLeft = (serverId: number, userId: number) => {
    const ms = timeoutUntil(serverId, userId) - now();
    if (ms <= 0) return null;
    const minutes = Math.ceil(ms / 60000);
    if (minutes < 60) return `${minutes} more minute${minutes === 1 ? '' : 's'}`;
    const hours = Math.round(minutes / 60);
    return hours < 48 ? `${hours} more hour${hours === 1 ? '' : 's'}` : `${Math.round(hours / 24)} more days`;
  };
  /** Tells LiveKit whether someone at a fire can speak, after a timeout starts or ends. */
  const voiceRightsChanged = (serverId: number, userId: number) => {
    const channel = channelById(inVoice.get(userId) ?? -1);
    if (channel?.serverId !== serverId) return;
    tellLiveKit(`change whether user ${userId} can speak`, (v) => setCanSpeak(v, `room-${channel.id}`, String(userId), !serverMuted(serverId, userId)));
    broadcastToChannel(channel, voiceStateEvent(channel.id));
  };
  const scheduleTimeoutEnd = (serverId: number, userId: number, until: number) => {
    const key = `${serverId}:${userId}`;
    clearTimeout(timeoutTimers.get(key));
    timeoutTimers.delete(key);
    if (until <= now()) return;
    const t = setTimeout(() => {
      timeoutTimers.delete(key);
      if (timeoutUntil(serverId, userId) > now()) return;
      voiceRightsChanged(serverId, userId);
      sendServerUpdate(serverId);
    }, Math.min(until - now() + 500, 2 ** 31 - 1));
    t.unref();
    timeoutTimers.set(key, t);
  };
  for (const r of db.prepare('SELECT server_id, user_id, timeout_until FROM members WHERE timeout_until > ?').all(now()) as { server_id: number; user_id: number; timeout_until: number }[])
    scheduleTimeoutEnd(r.server_id, r.user_id, r.timeout_until);

  route('POST', '/api/servers/:id/members/:id/timeout', ({ user, params, body }) => {
    const [serverId, targetId] = params.map(Number);
    const me = allowed(serverId, user, 'timeout');
    const target = standing(serverId, targetId);
    if (!target) throw new HttpError(404, "They aren't in this hearth");
    if (target.host || target.rank <= me.rank || targetId === user.id) throw new HttpError(403, "You can't time them out");
    const minutes = Math.floor(Number(body.minutes) || 0);
    if (minutes < 0 || minutes > MAX_TIMEOUT_MINUTES) throw new HttpError(400, 'A timeout can last up to a week');
    const until = minutes ? now() + minutes * 60000 : null;
    db.prepare('UPDATE members SET timeout_until = ? WHERE server_id = ? AND user_id = ?').run(until, serverId, targetId);
    audit(serverId, user.id, until ? 'timeout' : 'timeout_end', targetId, until ? `${minutes} minutes` : '');
    scheduleTimeoutEnd(serverId, targetId, until ?? 0);
    voiceRightsChanged(serverId, targetId);
    sendServerUpdate(serverId);
    return { ok: true, timeoutUntil: until };
  });

  // Bulk delete: a message and everything after it in the room, up to 100 at a time.
  const MAX_BULK = 100;
  route('POST', '/api/channels/:id/bulk-delete', ({ user, params, body }) => {
    const channel = channelById(Number(params[0]));
    if (!channel || !canSee(channel, user.id)) throw new HttpError(404, 'Room not found');
    allowed(channel.serverId, user, 'messages');
    const fromId = Number(body.fromId);
    const ids = (db.prepare('SELECT id FROM messages WHERE channel_id = ? AND id >= ? ORDER BY id LIMIT ?').all(channel.id, fromId, MAX_BULK + 1) as { id: number }[]).map((r) => r.id);
    if (!ids.length) throw new HttpError(404, 'Message not found');
    if (ids.length > MAX_BULK) throw new HttpError(400, `That's more than ${MAX_BULK} messages. Pick a newer one to start from.`);
    for (const id of ids) {
      removeFiles(db.prepare('SELECT id FROM attachments WHERE message_id = ?').all(id) as Json[]);
      db.prepare('DELETE FROM messages WHERE id = ?').run(id);
      broadcastToChannel(channel, { type: 'message_deleted', id, channelId: channel.id });
    }
    audit(channel.serverId, user.id, 'bulk_delete', null, `${ids.length} message${ids.length === 1 ? '' : 's'} in #${channel.name}`);
    if (channel.kind === 'thread') threadChanged(channel);
    return { deleted: ids.length };
  });

  // The word filter: chosen words either stop a message, or let it through and report it.
  type WordFilter = { words: string[]; action: 'block' | 'flag' };
  const cleanWordFilter = (value: unknown) => {
    if (value === null) return null;
    const v = (value ?? {}) as Json;
    const words = [...new Set((Array.isArray(v.words) ? v.words : []).map((w) => String(w).trim().toLowerCase()).filter(Boolean))];
    if (words.length > 200) throw new HttpError(400, 'The word filter can hold up to 200 words');
    if (words.some((w) => w.length > 40)) throw new HttpError(400, 'Each filtered word can be at most 40 characters');
    if (!words.length) return null;
    return JSON.stringify({ words, action: v.action === 'flag' ? 'flag' : 'block' });
  };
  const wordFilterOf = (serverId: number): WordFilter | null => {
    const raw = (db.prepare('SELECT word_filter FROM servers WHERE id = ?').get(serverId) as { word_filter: string | null } | undefined)?.word_filter;
    return raw ? JSON.parse(raw) : null;
  };
  const filterRegexes = new Map<string, RegExp>();
  /** The first filtered word in a message, matched as a whole word in any letter case. */
  const filteredWord = (filter: WordFilter, text: string) => {
    for (const word of filter.words) {
      let re = filterRegexes.get(word);
      if (!re) {
        re = new RegExp(`(?<![\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu');
        if (filterRegexes.size > 5000) filterRegexes.clear();
        filterRegexes.set(word, re);
      }
      if (re.test(text)) return word;
    }
    return null;
  };
  /** Stops a message the filter blocks; returns the word if it should be reported instead. People who manage messages are exempt. */
  const filterCheck = (channel: Channel, userId: number, text: string) => {
    const filter = text ? wordFilterOf(channel.serverId) : null;
    if (!filter || can(channel.serverId, userId, 'messages')) return null;
    const word = filteredWord(filter, text);
    if (word && filter.action === 'block') throw new HttpError(400, "Your message has a word this hearth doesn't allow");
    return word;
  };

  // Reports: anyone can flag a message for the people who manage messages.
  const openReports = (serverId: number) =>
    (db.prepare('SELECT COUNT(*) AS n FROM reports WHERE server_id = ? AND resolved_at IS NULL').get(serverId) as { n: number }).n;
  const reportsChanged = (serverId: number) => {
    const count = openReports(serverId);
    sendTo(serverMemberIds(serverId).filter((id) => can(serverId, id, 'messages')), { type: 'reports', serverId, open: count });
  };
  const fileReport = (serverId: number, message: Json, reporterId: number | null, reason: string) => {
    db.prepare(
      'INSERT INTO reports (server_id, message_id, channel_id, author_id, content, reporter_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(serverId, message.id as number, message.channelId as number, message.authorId as number, String(message.content ?? '').slice(0, 1000), reporterId, reason.slice(0, 200), now());
    reportsChanged(serverId);
  };
  route('POST', '/api/messages/:id/report', ({ user, params, body }) => {
    const { channel } = visibleMessage(user, Number(params[0]));
    const message = messageById(Number(params[0]))!;
    if (!isBurrow(channel.serverId)) throw new HttpError(400, 'Only messages in hearths can be reported');
    if (db.prepare('SELECT 1 FROM reports WHERE message_id = ? AND reporter_id = ? AND resolved_at IS NULL').get(message.id as number, user.id))
      throw new HttpError(409, "You've already reported this message");
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason.length > 200) throw new HttpError(400, 'The reason can be at most 200 characters');
    fileReport(channel.serverId, message, user.id, reason);
    return { ok: true };
  });
  route('GET', '/api/servers/:id/reports', ({ user, params }) => {
    const serverId = Number(params[0]);
    allowed(serverId, user, 'messages');
    return db
      .prepare(
        `SELECT r.id, r.message_id AS messageId, r.channel_id AS channelId, c.name AS channelName, r.content, r.reason, r.created_at AS createdAt,
                r.author_id AS authorId, COALESCE(ua.display_name, ua.username) AS author, ${avatarUrl('ua.avatar')} AS authorAvatar, ur.username AS reporter,
                r.resolved_at AS resolvedAt, uv.username AS resolvedBy
         FROM reports r LEFT JOIN users ua ON ua.id = r.author_id LEFT JOIN users ur ON ur.id = r.reporter_id
         LEFT JOIN users uv ON uv.id = r.resolved_by LEFT JOIN channels c ON c.id = r.channel_id
         WHERE r.server_id = ? AND (r.resolved_at IS NULL OR r.resolved_at > ?) ORDER BY r.resolved_at IS NOT NULL, r.id DESC LIMIT 100`,
      )
      .all(serverId, now() - 7 * 86400e3);
  });
  // Dealt with: optionally deleting the message too. Every open report on that message closes.
  route('POST', '/api/reports/:id/resolve', ({ user, params, body }) => {
    const report = db.prepare('SELECT server_id, message_id, author_id FROM reports WHERE id = ?').get(Number(params[0])) as
      | { server_id: number; message_id: number | null; author_id: number | null }
      | undefined;
    if (!report || !isMember(report.server_id, user.id)) throw new HttpError(404, 'Report not found');
    allowed(report.server_id, user, 'messages');
    const message = report.message_id === null ? undefined : (db.prepare('SELECT id, channel_id, content FROM messages WHERE id = ?').get(report.message_id) as Json | undefined);
    if (body.deleteMessage && message) {
      const channel = channelById(message.channel_id as number)!;
      audit(report.server_id, user.id, 'message_delete', report.author_id, `in #${channel.name}: ${String(message.content).slice(0, 120)}`);
      removeFiles(db.prepare('SELECT id FROM attachments WHERE message_id = ?').all(message.id as number) as Json[]);
      db.prepare('DELETE FROM messages WHERE id = ?').run(message.id as number);
      broadcastToChannel(channel, { type: 'message_deleted', id: message.id, channelId: channel.id });
    }
    db.prepare('UPDATE reports SET resolved_at = ?, resolved_by = ? WHERE resolved_at IS NULL AND (id = ? OR (message_id IS NOT NULL AND message_id = ?))').run(
      now(), user.id, Number(params[0]), report.message_id ?? -1,
    );
    reportsChanged(report.server_id);
    return { ok: true };
  });

  // Upload limits: a size for the burrow, and roles that allow more (or less). 0 means no files.
  const cleanUploadMb = (value: unknown) => {
    if (value === null || value === '') return null;
    const mb = Math.floor(Number(value));
    if (!(mb >= 0 && mb <= 10000)) throw new HttpError(400, 'Pick an upload limit in MB, or leave it empty');
    return mb;
  };
  /** The largest file someone can share in a burrow, in bytes (0: none). The server's own limit is the most. */
  const uploadLimitFor = (serverId: number, userId: number) => {
    if (!isBurrow(serverId)) return maxUpload;
    const me = standing(serverId, userId);
    if (!me || me.host) return maxUpload;
    const base = (db.prepare('SELECT upload_mb FROM servers WHERE id = ?').get(serverId) as { upload_mb: number | null }).upload_mb;
    const roleLimits = me.roleIds.length
      ? (db.prepare(`SELECT upload_mb FROM roles WHERE upload_mb IS NOT NULL AND id IN (${me.roleIds.map(() => '?').join(',')})`).all(...me.roleIds) as { upload_mb: number }[]).map((r) => r.upload_mb)
      : [];
    const mb = Math.max(base ?? Infinity, ...roleLimits);
    return Math.min(maxUpload, mb * 1024 * 1024);
  };

  /** What the burrow's settings screens need, for the people allowed to see each part. */
  const moderationSummary = (serverId: number, viewerId: number) => {
    const r = db.prepare('SELECT upload_mb, word_filter FROM servers WHERE id = ?').get(serverId) as { upload_mb: number | null; word_filter: string | null };
    return {
      uploadMb: r.upload_mb,
      myUploadLimit: opts.uploadDir ? uploadLimitFor(serverId, viewerId) : 0,
      timeoutUntil: timeoutUntil(serverId, viewerId) > now() ? timeoutUntil(serverId, viewerId) : null,
      ...(can(serverId, viewerId, 'burrow') ? { wordFilter: r.word_filter ? JSON.parse(r.word_filter) : null } : {}),
      ...(can(serverId, viewerId, 'messages') ? { openReports: openReports(serverId) } : {}),
    };
  };

  // ---- uploads ------------------------------------------------------------

  const maxUpload = opts.maxUploadBytes ?? 25 * 1024 * 1024;
  const filePath = (id: string) => join(opts.uploadDir!, id);
  const removeFiles = (rows: Json[]) => {
    if (!opts.uploadDir) return;
    for (const r of rows) {
      unlink(filePath(r.id as string)).catch(() => {});
      unlink(thumbPath(r.id as string)).catch(() => {});
    }
  };
  const thumbPath = (id: string) => join(opts.uploadDir!, `${id}.thumb`);
  /** A picture or video's size in pixels, from the uploader, when it's believable. */
  const mediaSize = (type: string, w: unknown, h: unknown) => {
    const width = Math.round(Number(w)), height = Math.round(Number(h));
    if (!/^(image|video)\//.test(type) || !(width >= 1 && width <= 20000 && height >= 1 && height <= 20000)) return { width: null, height: null };
    return { width, height };
  };

  // The file is the raw request body; its name comes in the x-filename header.
  const handleUpload = async (req: IncomingMessage, res: ServerResponse, channelId: number) => {
    const user = userByToken(req.headers.authorization?.replace(/^Bearer /, ''));
    if (!user) throw new HttpError(401, 'Not logged in');
    if (!opts.uploadDir) throw new HttpError(503, 'Uploads are not set up on this server');
    const channel = channelById(channelId);
    if (!channel || !canSee(channel, user.id)) throw new HttpError(404, 'Room not found');
    if (channel.kind === 'voice') throw new HttpError(400, 'Voice rooms have no messages');
    const limit = uploadLimitFor(channel.serverId, user.id);
    if (!limit) throw new HttpError(403, "Your roles can't share files in this hearth");
    const tooBig = () => new HttpError(413, `You can share files up to ${Math.round(limit / 1048576)} MB here`);
    const declared = Number(req.headers['content-length']);
    if (declared > limit) throw tooBig();
    let name = 'file';
    try {
      name = decodeURIComponent(String(req.headers['x-filename'] ?? 'file'));
    } catch {}
    name = name.replace(/[\\/\x00-\x1f]/g, '_').trim().slice(-200) || 'file';
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() || 'application/octet-stream';

    await mkdir(opts.uploadDir, { recursive: true });
    const id = randomBytes(16).toString('base64url');
    const out = createWriteStream(filePath(id));
    let size = 0;
    await new Promise<void>((resolve, reject) => {
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) {
          req.pause();
          reject(tooBig());
        } else out.write(chunk);
      });
      req.on('end', () => out.end(resolve));
      req.on('error', reject);
      out.on('error', reject);
    }).catch((err) => {
      out.destroy();
      unlink(filePath(id)).catch(() => {});
      throw err;
    });
    if (!size) {
      unlink(filePath(id)).catch(() => {});
      throw new HttpError(400, 'File is empty');
    }
    // Voice messages say how long they are, so the player can show it before loading.
    const voiceSeconds = Number(req.headers['x-voice-seconds']);
    const voice = type.startsWith('audio/') && voiceSeconds > 0 && voiceSeconds <= 3600 ? Math.round(voiceSeconds * 10) / 10 : null;
    const { width, height } = mediaSize(type, req.headers['x-width'], req.headers['x-height']);
    db.prepare(
      'INSERT INTO attachments (id, channel_id, uploader_id, name, type, size, created_at, voice_seconds, width, height) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, channel.id, user.id, name, type, size, now(), voice, width, height);
    send(res, 200, attachmentJson({ id, name, type, size, voice_seconds: voice, width, height }));
  };

  const MAX_THUMB_BYTES = 300 * 1024;
  // A video's thumbnail: a small still the uploader's app took from it, sent before the message.
  const THUMB_TYPES: Record<string, (b: Buffer) => boolean> = {
    'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
    'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8,
  };
  const handleThumbUpload = async (req: IncomingMessage, res: ServerResponse, id: string) => {
    const user = userByToken(req.headers.authorization?.replace(/^Bearer /, ''));
    if (!user) throw new HttpError(401, 'Not logged in');
    if (!opts.uploadDir) throw new HttpError(503, 'Uploads are not set up on this server');
    const a = db.prepare('SELECT type FROM attachments WHERE id = ? AND uploader_id = ? AND message_id IS NULL').get(id, user.id) as { type: string } | undefined;
    if (!a) throw new HttpError(404, 'File not found');
    if (!a.type.startsWith('video/')) throw new HttpError(400, 'Only videos have thumbnails');
    const tooBig = new HttpError(413, 'That thumbnail is too big');
    if (Number(req.headers['content-length']) > MAX_THUMB_BYTES) throw tooBig;
    const chunks: Buffer[] = [];
    let size = 0;
    await new Promise<void>((resolve, reject) => {
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_THUMB_BYTES) {
          req.pause();
          reject(tooBig);
        } else chunks.push(c);
      });
      req.on('end', resolve);
      req.on('error', reject);
    });
    const data = Buffer.concat(chunks);
    const kind = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (!THUMB_TYPES[kind]?.(data)) throw new HttpError(400, 'Send the thumbnail as a WebP or JPEG picture');
    await writeFile(thumbPath(id), data);
    db.prepare('UPDATE attachments SET thumb = 1 WHERE id = ?').run(id);
    send(res, 200, { thumb: `/api/attachments/${id}/thumb` });
  };
  const serveThumb = async (req: IncomingMessage, res: ServerResponse, id: string) => {
    const a = db.prepare('SELECT 1 FROM attachments WHERE id = ? AND thumb = 1 AND message_id IS NOT NULL').get(id);
    const data = a && opts.uploadDir ? await readFile(thumbPath(id)).catch(() => null) : null;
    if (!data) throw new HttpError(404, 'No thumbnail');
    res.writeHead(200, {
      'content-type': THUMB_TYPES['image/webp'](data) ? 'image/webp' : 'image/jpeg',
      'content-length': data.length,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, max-age=31536000, immutable',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  };

  // Attachment links are unguessable (128 random bits), so images work in <img> tags without a login.
  const serveAttachment = async (req: IncomingMessage, res: ServerResponse, id: string) => {
    const a = db.prepare('SELECT name, type, size FROM attachments WHERE id = ? AND message_id IS NOT NULL').get(id) as
      | { name: string; type: string; size: number }
      | undefined;
    if (!a || !opts.uploadDir || !(await stat(filePath(id)).catch(() => null))) throw new HttpError(404, 'File not found');
    const inline = INLINE_TYPES.has(a.type);
    const headers: Record<string, string | number> = {
      'content-type': inline ? a.type : 'application/octet-stream',
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.name)}`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, max-age=31536000, immutable',
      'accept-ranges': 'bytes',
    };
    // Videos and long voice messages are fetched a piece at a time, so they start (and skip ahead) without downloading it all.
    const range = String(req.headers.range ?? '').match(/^bytes=(\d*)-(\d*)$/);
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : Math.max(0, a.size - Number(range[2]));
      let end = range[1] && range[2] ? Math.min(Number(range[2]), a.size - 1) : a.size - 1;
      if (start >= a.size || start > end) {
        res.writeHead(416, { 'content-range': `bytes */${a.size}` });
        return res.end();
      }
      res.writeHead(206, { ...headers, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${a.size}` });
      if (req.method === 'HEAD') return res.end();
      return void createReadStream(filePath(id), { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'content-length': a.size });
    if (req.method === 'HEAD') return res.end();
    createReadStream(filePath(id)).pipe(res);
  };

  // ---- profile and burrow pictures ----------------------------------------

  // Profile pictures live in uploads/avatars, burrow pictures in uploads/burrow-pictures.
  const picturePath = (folder: string, file: string) => join(opts.uploadDir!, folder, file);
  const avatarPath = (file: string) => picturePath('avatars', file);

  /** Swaps in a new picture file (or none), removes the old one and tells everyone who can see this user. */
  const setAvatarFile = (user: User, file: string | null) => {
    const old = db.prepare('SELECT avatar FROM users WHERE id = ?').get(user.id) as { avatar: string | null };
    db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(file, user.id);
    if (old.avatar && opts.uploadDir) unlink(avatarPath(old.avatar)).catch(() => {});
    return userChanged(user.id);
  };

  /** The logged-in uploader of a picture, which is the raw request body. */
  const pictureUploader = (req: IncomingMessage) => {
    const user = userByToken(req.headers.authorization?.replace(/^Bearer /, ''));
    if (!user) throw new HttpError(401, 'Not logged in');
    if (!opts.uploadDir) throw new HttpError(503, 'Uploads are not set up on this server');
    return user;
  };

  /** Reads a picture from the request body and saves it in `folder`, returning its new file name. */
  const savePicture = async (req: IncomingMessage, folder: string, what: string) => {
    const tooBig = new HttpError(413, `${what} can be at most ${MAX_AVATAR_BYTES / 1048576} MB`);
    if (Number(req.headers['content-length']) > MAX_AVATAR_BYTES) throw tooBig;
    const chunks: Buffer[] = [];
    let size = 0;
    await new Promise<void>((resolve, reject) => {
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_AVATAR_BYTES) {
          req.pause();
          reject(tooBig);
        } else chunks.push(c);
      });
      req.on('end', resolve);
      req.on('error', reject);
    });
    const data = Buffer.concat(chunks);
    const kind = AVATAR_TYPES.find((t) => t.magic(data));
    if (!kind) throw new HttpError(400, `${what} must be PNG, JPEG, GIF or WebP images`);
    const file = `${randomBytes(16).toString('base64url')}.${kind.ext}`;
    await mkdir(join(opts.uploadDir!, folder), { recursive: true });
    await writeFile(picturePath(folder, file), data);
    return file;
  };

  // The app shrinks the picture to a small square before sending.
  const handleAvatarUpload = async (req: IncomingMessage, res: ServerResponse) => {
    const user = pictureUploader(req);
    send(res, 200, setAvatarFile(user, await savePicture(req, 'avatars', 'Profile pictures')));
  };

  /** Swaps in a burrow's new picture (or none) and shows it to everyone in the burrow. */
  // The banner is a wide picture kept next to the burrow's picture.
  type PictureColumn = 'icon' | 'banner';
  const setBurrowPicture = (serverId: number, file: string | null, column: PictureColumn = 'icon') => {
    removeBurrowPicture(serverId, column);
    db.prepare(`UPDATE servers SET ${column} = ? WHERE id = ?`).run(file, serverId);
    sendServerUpdate(serverId);
  };
  const removeBurrowPicture = (serverId: number, column: PictureColumn = 'icon') => {
    const old = db.prepare(`SELECT ${column} AS file FROM servers WHERE id = ?`).get(serverId) as { file: string | null } | undefined;
    if (old?.file && opts.uploadDir) unlink(picturePath('burrow-pictures', old.file)).catch(() => {});
  };

  // The host, and roles allowed to edit the burrow, can change its picture and banner.
  const handleBurrowPictureUpload = async (req: IncomingMessage, res: ServerResponse, serverId: number, column: PictureColumn = 'icon') => {
    const user = pictureUploader(req);
    allowed(serverId, user, 'burrow');
    const file = await savePicture(req, 'burrow-pictures', column === 'icon' ? 'Hearth pictures' : 'Banners');
    // They may have lost the right (or the burrow may be gone) while it uploaded.
    try {
      allowed(serverId, user, 'burrow');
    } catch (err) {
      unlink(picturePath('burrow-pictures', file)).catch(() => {});
      throw err;
    }
    setBurrowPicture(serverId, file, column);
    send(res, 200, serverSummary(serverId, user.id));
  };
  route('DELETE', '/api/servers/:id/picture', ({ user, params }) => {
    const serverId = Number(params[0]);
    allowed(serverId, user, 'burrow');
    setBurrowPicture(serverId, null);
    return serverSummary(serverId, user.id);
  });
  route('DELETE', '/api/servers/:id/banner', ({ user, params }) => {
    const serverId = Number(params[0]);
    allowed(serverId, user, 'burrow');
    setBurrowPicture(serverId, null, 'banner');
    return serverSummary(serverId, user.id);
  });

  // Picture links are unguessable and never reused, so they can be cached forever.
  const servePicture = async (req: IncomingMessage, res: ServerResponse, folder: string, file: string) => {
    const kind = AVATAR_TYPES.find((t) => file.endsWith('.' + t.ext))!;
    const info = opts.uploadDir ? await stat(picturePath(folder, file)).catch(() => null) : null;
    if (!info) throw new HttpError(404, 'Picture not found');
    res.writeHead(200, {
      'content-type': kind.type,
      'content-length': info.size,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'public, max-age=31536000, immutable',
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(picturePath(folder, file)).pipe(res);
  };

  // ---- GIFs ---------------------------------------------------------------
  // Searching and previews go through Burrow (see gifs.ts). A GIF that's sent is saved like an
  // uploaded file, so it keeps working even if KLIPY drops it.

  const gifs = opts.gifs && opts.uploadDir ? gifSearch(opts.gifs) : null;
  const gifsOn = () => {
    if (!gifs) throw new HttpError(503, "GIFs aren't set up on this server");
    return gifs;
  };
  const gifTries = (user: User) => {
    const key = `gif:${user.id}`;
    checkTries([key], 120); // searches a minute, per person; plenty for typing as you go
    failedTry([key], 60_000);
  };
  const GIF_TYPES = AVATAR_TYPES.filter((t) => t.ext === 'gif' || t.ext === 'webp');

  route('GET', '/api/gifs', async ({ user, url }) => {
    gifTries(user);
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
    const page = Math.max(1, Math.min(50, Number(url.searchParams.get('page')) || 1));
    try {
      return await (q ? gifsOn().search(q, page, user.id) : gifsOn().trending(page, user.id));
    } catch (err) {
      if (err instanceof HttpError) throw err;
      console.warn(`GIF search failed: ${err instanceof Error ? err.message : err}`);
      throw new HttpError(502, "Couldn't reach the GIF search. Try again in a moment.");
    }
  });

  // Previews load in <img> tags, which can't log in; the ids are random and only last a while.
  const serveGifPreview = async (req: IncomingMessage, res: ServerResponse, id: string) => {
    const gif = gifs?.get(id);
    if (!gif) throw new HttpError(404, 'GIF not found');
    let data: Buffer;
    try {
      data = await download(gif.preview, 5 * 1024 * 1024);
    } catch {
      throw new HttpError(502, "Couldn't load that GIF");
    }
    const kind = GIF_TYPES.find((t) => t.magic(data));
    if (!kind) throw new HttpError(502, "Couldn't load that GIF");
    res.writeHead(200, {
      'content-type': kind.type,
      'content-length': data.length,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, max-age=86400',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  };

  /** Saves a GIF from a search into a room, ready to send like an uploaded file. */
  route('POST', '/api/channels/:id/gifs', async ({ user, params, body }) => {
    const channel = channelById(Number(params[0]));
    if (!channel || !canSee(channel, user.id)) throw new HttpError(404, 'Room not found');
    if (channel.kind === 'voice') throw new HttpError(400, 'Voice rooms have no messages');
    const gif = gifsOn().get(String(body.id ?? ''));
    if (!gif) throw new HttpError(404, 'That GIF is no longer available. Search again.');
    let data: Buffer;
    try {
      data = await download(gif.full, maxUpload);
    } catch (err) {
      throw new HttpError(502, err instanceof Error && err.message.includes('too big') ? 'That GIF is too big to send' : "Couldn't fetch that GIF");
    }
    const kind = GIF_TYPES.find((t) => t.magic(data));
    if (!kind) throw new HttpError(502, "Couldn't fetch that GIF");
    const id = randomBytes(16).toString('base64url');
    const name = `${gif.title.replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 60) || 'gif'}.${kind.ext}`;
    await mkdir(opts.uploadDir!, { recursive: true });
    await writeFile(filePath(id), data);
    db.prepare(
      'INSERT INTO attachments (id, channel_id, uploader_id, name, type, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, channel.id, user.id, name, kind.type, data.length, now());
    return attachmentJson({ id, name, type: kind.type, size: data.length });
  });

  // Uploads that never made it into a message are cleared out after a day.
  if (opts.uploadDir) {
    const sweep = () => {
      const stale = db
        .prepare('SELECT id FROM attachments WHERE message_id IS NULL AND created_at < ?')
        .all(now() - 24 * 3600_000) as Json[];
      removeFiles(stale);
      db.prepare('DELETE FROM attachments WHERE message_id IS NULL AND created_at < ?').run(now() - 24 * 3600_000);
    };
    setInterval(sweep, 3600_000).unref();
  }

  // ---- where a message is, for lists that mix rooms (saved, search, reminders) ----

  /** The burrow (or DM) and room a message is in, as someone sees it. */
  const placeOf = (channelId: number, viewerId: number) => {
    const c = db
      .prepare(
        `SELECT c.name, c.kind, p.name AS parentName, s.id AS serverId, s.name AS serverName, s.kind AS serverKind
         FROM channels c JOIN servers s ON s.id = c.server_id LEFT JOIN channels p ON p.id = c.parent_id WHERE c.id = ?`,
      )
      .get(channelId) as Json | undefined;
    if (!c) return null;
    const dm = c.serverKind === 'dm';
    const partnerName = dm
      ? (db.prepare('SELECT COALESCE(u.display_name, u.username) AS name FROM members m JOIN users u ON u.id = m.user_id WHERE m.server_id = ? AND m.user_id != ?').get(c.serverId as number, viewerId) as { name: string } | undefined)?.name
      : null;
    return {
      serverId: c.serverId,
      channelId,
      kind: dm ? 'dm' : 'burrow',
      serverName: dm ? partnerName ?? 'Direct message' : c.serverName,
      channelName: c.kind === 'thread' ? c.parentName : c.name,
      threadName: c.kind === 'thread' ? c.name : null,
    };
  };

  /** A message and its room, if this person can see it. */
  const visibleMessage = (user: User, id: number) => {
    const msg = db.prepare('SELECT channel_id, author_id FROM messages WHERE id = ?').get(id) as { channel_id: number; author_id: number } | undefined;
    const channel = msg && channelById(msg.channel_id);
    if (!msg || !channel || !canSee(channel, user.id)) throw new HttpError(404, 'Message not found');
    return { channel, authorId: msg.author_id };
  };
  const messageChanged = (id: number, channel: Channel) => {
    const message = messageById(id);
    if (message) broadcastToChannel(channel, { type: 'message_updated', message });
    return message;
  };

  // ---- notifications and presence ----
  //
  // Who a message is for (your @name, a reply to you, @everyone, @here or one of your roles) is
  // worked out once, when it's sent, and kept: that's your mentions inbox and your unread
  // mention counts. People who are away get a push on their phone or browser, and if they set
  // up email, an email when a mention is still unread a while later.

  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const serverKind = (serverId: number) => (db.prepare('SELECT kind FROM servers WHERE id = ?').get(serverId) as { kind: string } | undefined)?.kind;

  /** @everyone, @here and @Role, if the author's roles let them ping those. */
  const pingsIn = (channel: Channel, authorId: number, content: string) => {
    if (!content.includes('@') || serverKind(channel.serverId) !== 'burrow' || !can(channel.serverId, authorId, 'everyone')) return null;
    const out: { everyone?: 1; here?: 1; roles?: number[] } = {};
    if (/@everyone\b/i.test(content)) out.everyone = 1;
    if (/@here\b/i.test(content)) out.here = 1;
    const roles = db.prepare('SELECT id, name FROM roles WHERE server_id = ?').all(channel.serverId) as { id: number; name: string }[];
    const named = roles.filter((r) => new RegExp(`@${escapeRe(r.name)}(?![\\w-])`, 'i').test(content)).map((r) => r.id);
    if (named.length) out.roles = named;
    return Object.keys(out).length ? out : null;
  };

  /** Keeps who a message is for (never its author), and returns them. Direct messages are for everyone in them anyway. */
  const recordMentions = (channel: Channel, messageId: number, authorId: number, content: string, replyId: number | null) => {
    const pings = pingsIn(channel, authorId, content);
    db.prepare('UPDATE messages SET pings = ? WHERE id = ?').run(pings ? JSON.stringify(pings) : null, messageId);
    const forWhom = new Set<number>();
    if (serverKind(channel.serverId) !== 'burrow') return forWhom;
    const audience = channelAudience(channel).filter((id) => id !== authorId);
    if (content.includes('@')) {
      const names = db
        .prepare(`SELECT id, username FROM users WHERE id IN (${audience.map(() => '?').join(',') || 'NULL'})`)
        .all(...audience) as { id: number; username: string }[];
      for (const u of names) if (new RegExp(`@${escapeRe(u.username)}\\b`, 'i').test(content)) forWhom.add(u.id);
    }
    if (replyId !== null) {
      const to = (db.prepare('SELECT author_id FROM messages WHERE id = ?').get(replyId) as { author_id: number } | undefined)?.author_id;
      if (to !== undefined && audience.includes(to)) forWhom.add(to);
    }
    if (pings?.everyone) audience.forEach((id) => forWhom.add(id));
    if (pings?.here) audience.filter((id) => online.has(id)).forEach((id) => forWhom.add(id));
    if (pings?.roles) {
      const inRoles = db
        .prepare(`SELECT DISTINCT user_id FROM member_roles WHERE server_id = ? AND role_id IN (${pings.roles.map(() => '?').join(',')})`)
        .all(channel.serverId, ...pings.roles) as { user_id: number }[];
      for (const { user_id } of inRoles) if (audience.includes(user_id)) forWhom.add(user_id);
    }
    // Nobody is pinged by someone they've blocked.
    for (const id of forWhom) if (blocked(id, authorId)) forWhom.delete(id);
    const add = db.prepare('INSERT OR IGNORE INTO mentions (message_id, user_id) VALUES (?, ?)');
    for (const id of forWhom) add.run(messageId, id);
    return forWhom;
  };

  // Presence: online, away (chosen, or nobody's touched any of their devices for a while) or
  // do not disturb; a custom status; and the game the desktop app sees them playing.
  const idleSockets = new Map<number, Set<WebSocket>>();
  const activities = new Map<number, { name: string; since: number }>();
  const userIdle = (userId: number) => {
    const all = sockets.get(userId);
    const idleOnes = idleSockets.get(userId);
    return !!all?.size && !!idleOnes && [...all].every((ws) => idleOnes.has(ws));
  };
  type StatusRow = { status: string; status_text: string | null; status_emoji: string | null; status_until: number | null };
  const statusRow = (userId: number) =>
    db.prepare('SELECT status, status_text, status_emoji, status_until FROM users WHERE id = ?').get(userId) as StatusRow | undefined;
  const customOf = (r: StatusRow | undefined) =>
    r && (r.status_text || r.status_emoji) && (!r.status_until || r.status_until > now())
      ? { text: r.status_text ?? '', emoji: r.status_emoji ?? '', until: r.status_until }
      : null;
  const presenceOf = (userId: number) => {
    const r = statusRow(userId);
    const on = online.has(userId);
    const status = !on ? 'offline' : r?.status === 'dnd' ? 'dnd' : r?.status === 'away' || userIdle(userId) ? 'away' : 'online';
    const activity = on ? activities.get(userId) ?? null : null;
    return { status, custom: customOf(r), activity };
  };
  const sendPresence = (userId: number) =>
    sendTo(new Set([...usersSharingServerWith(userId), ...friendIds(userId)]), { type: 'presence', userId, online: online.has(userId), ...presenceOf(userId) });
  // A custom status that runs out disappears for everyone at that moment.
  const statusTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const expireStatusAt = (userId: number, until: number | null) => {
    clearTimeout(statusTimers.get(userId));
    statusTimers.delete(userId);
    if (!until) return;
    const t = setTimeout(() => { statusTimers.delete(userId); sendPresence(userId); }, Math.min(Math.max(0, until - now()) + 50, 2 ** 31 - 1));
    t.unref();
    statusTimers.set(userId, t);
  };

  type MeRow = StatusRow & {
    quiet_start: number | null; quiet_end: number | null; time_zone: string | null; email: string | null; email_verified: number;
    totp_secret: string | null; recovery_codes: string;
  };
  const meRow = (userId: number) =>
    db
      .prepare('SELECT status, status_text, status_emoji, status_until, quiet_start, quiet_end, time_zone, email, email_verified, totp_secret, recovery_codes FROM users WHERE id = ?')
      .get(userId) as MeRow;
  /** You, as your own apps see you: settings included. */
  const meJson = (user: User) => {
    const r = meRow(user.id);
    return {
      ...user,
      readReceipts: readReceiptsOn(user.id),
      status: r.status,
      customStatus: customOf(r),
      quietHours: r.quiet_start === null || r.quiet_end === null ? null : { start: r.quiet_start, end: r.quiet_end, timeZone: r.time_zone },
      email: r.email,
      emailVerified: !!r.email_verified,
      ...profileOf(user.id),
      twoStep: !!r.totp_secret,
      ...(admin.isAdmin(user.id) ? { admin: true } : {}),
      recoveryCodesLeft: (JSON.parse(r.recovery_codes) as string[]).length,
      blockedIds: blockedBy(user.id),
    };
  };
  const validTimeZone = (tz: unknown) => {
    if (typeof tz !== 'string' || tz.length > 64) return false;
    try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
  };
  /** Status, custom status, quiet hours and the email switch, from PATCH /api/me. */
  const updateMyPresence = (user: User, body: Json) => {
    let changed = false;
    if (body.status !== undefined) {
      if (!['online', 'away', 'dnd'].includes(body.status as string)) throw new HttpError(400, 'Pick online, away or do not disturb');
      db.prepare('UPDATE users SET status = ? WHERE id = ?').run(body.status as string, user.id);
      changed = true;
    }
    if (body.customStatus !== undefined) {
      const c = body.customStatus as Json | null;
      if (c === null) {
        db.prepare('UPDATE users SET status_text = NULL, status_emoji = NULL, status_until = NULL WHERE id = ?').run(user.id);
        expireStatusAt(user.id, null);
      } else {
        const text = typeof c.text === 'string' ? c.text.replace(/\s+/g, ' ').trim() : '';
        const emoji = typeof c.emoji === 'string' ? c.emoji.trim() : '';
        if (text.length > 80) throw new HttpError(400, 'Keep your status under 80 characters');
        if (emoji.length > 40) throw new HttpError(400, "That emoji doesn't work here");
        if (!text && !emoji) throw new HttpError(400, 'Write a status or pick an emoji');
        const until = c.until == null ? null : Math.floor(Number(c.until));
        if (until !== null && !(until > now())) throw new HttpError(400, 'Pick a time in the future');
        db.prepare('UPDATE users SET status_text = ?, status_emoji = ?, status_until = ? WHERE id = ?').run(text || null, emoji || null, until, user.id);
        expireStatusAt(user.id, until);
      }
      changed = true;
    }
    if (body.quietHours !== undefined) {
      const q = body.quietHours as Json | null;
      if (q === null) db.prepare('UPDATE users SET quiet_start = NULL, quiet_end = NULL WHERE id = ?').run(user.id);
      else {
        const start = Math.floor(Number(q.start)), end = Math.floor(Number(q.end));
        const ok = (m: number) => Number.isFinite(m) && m >= 0 && m < 1440;
        if (!ok(start) || !ok(end) || start === end) throw new HttpError(400, 'Pick when quiet hours start and end');
        if (!validTimeZone(q.timeZone)) throw new HttpError(400, "That time zone isn't one Peiskos knows");
        db.prepare('UPDATE users SET quiet_start = ?, quiet_end = ?, time_zone = ? WHERE id = ?').run(start, end, q.timeZone as string, user.id);
      }
    }
    if (changed) {
      sendPresence(user.id);
      sendTo([user.id], { type: 'me_updated', me: meJson(user) }); // your other devices
    }
  };

  /** Whether it's within someone's quiet hours where they are. */
  const inQuietHours = (userId: number, t = now()) => {
    const r = meRow(userId);
    if (r.quiet_start === null || r.quiet_end === null) return false;
    let minutes: number;
    try {
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: r.time_zone ?? 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(t);
      minutes = Number(parts.find((p) => p.type === 'hour')!.value) * 60 + Number(parts.find((p) => p.type === 'minute')!.value);
    } catch {
      return false;
    }
    // Quiet hours usually run past midnight (22:00 to 07:00).
    return r.quiet_start < r.quiet_end ? minutes >= r.quiet_start && minutes < r.quiet_end : minutes >= r.quiet_start || minutes < r.quiet_end;
  };

  // ---- push: alerts while Burrow is closed ----

  const vapid: VapidKeys = (() => {
    const saved = db.prepare("SELECT value FROM app_secrets WHERE name = 'vapid'").get() as { value: string } | undefined;
    if (saved) {
      try {
        const keys = JSON.parse(saved.value) as VapidKeys;
        if (vapidKeysWork(keys)) return keys;
      } catch {}
    }
    const keys = newVapidKeys();
    db.prepare("INSERT OR REPLACE INTO app_secrets (name, value) VALUES ('vapid', ?)").run(JSON.stringify(keys));
    return keys;
  })();
  const pushContact = opts.pushContact || 'https://github.com/HaxMarris/Burrow';
  // Only the big browsers' push services, so nobody can make the server post to anywhere else.
  const PUSH_HOSTS = ['.googleapis.com', '.mozilla.com', '.push.apple.com', '.notify.windows.com', ...(opts.pushHosts ?? [])];
  const pushHostAllowed = (endpoint: string) => {
    try {
      const u = new URL(endpoint);
      const testHost = opts.pushHosts?.includes(u.host);
      return (u.protocol === 'https:' || (testHost && u.protocol === 'http:')) && (testHost || PUSH_HOSTS.some((h) => h.startsWith('.') && u.hostname.endsWith(h)));
    } catch {
      return false;
    }
  };
  const MAX_PUSH_DEVICES = 10;

  route('GET', '/api/push/key', () => ({ key: vapid.publicKey }));
  route('POST', '/api/push', ({ user, body }) => {
    const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
    const keys = (body.keys ?? {}) as Json;
    const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh : '';
    const auth = typeof keys.auth === 'string' ? keys.auth : '';
    if (endpoint.length > 2000 || !pushHostAllowed(endpoint)) throw new HttpError(400, "That browser's alerts aren't supported");
    if (Buffer.from(p256dh, 'base64url').length !== 65 || Buffer.from(auth, 'base64url').length !== 16) throw new HttpError(400, 'Those alert keys look wrong');
    db.prepare(
      `INSERT INTO push_subs (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at`,
    ).run(user.id, endpoint, p256dh, auth, now());
    db.prepare(
      `DELETE FROM push_subs WHERE user_id = ? AND id NOT IN (SELECT id FROM push_subs WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ${MAX_PUSH_DEVICES})`,
    ).run(user.id, user.id);
    return { ok: true };
  });
  route('DELETE', '/api/push', ({ user, body }) => {
    db.prepare('DELETE FROM push_subs WHERE user_id = ? AND endpoint = ?').run(user.id, String(body.endpoint ?? ''));
    return { ok: true };
  });

  /** Unread @mentions plus unread direct messages, for the number on the app icon. */
  const badgeCount = (userId: number) => {
    const mentions = (db
      .prepare(
        `SELECT COUNT(*) AS n FROM (SELECT 1 FROM mentions x JOIN messages m ON m.id = x.message_id
         LEFT JOIN read_state r ON r.user_id = x.user_id AND r.channel_id = m.channel_id
         WHERE x.user_id = ? AND m.id > COALESCE(r.last_read_id, 0) LIMIT 100)`,
      )
      .get(userId) as { n: number }).n;
    const dms = (db
      .prepare(
        `SELECT COUNT(*) AS n FROM (SELECT 1 FROM members mb JOIN servers s ON s.id = mb.server_id AND s.kind = 'dm'
         JOIN channels c ON c.server_id = s.id JOIN messages m ON m.channel_id = c.id
         LEFT JOIN read_state r ON r.user_id = mb.user_id AND r.channel_id = c.id
         WHERE mb.user_id = ? AND m.author_id != mb.user_id AND m.id > COALESCE(r.last_read_id, 0) AND m.created_at >= mb.joined_at LIMIT 100)`,
      )
      .get(userId) as { n: number }).n;
    return Math.min(99, mentions + dms);
  };

  const pushTo = (userId: number, message: Json) => {
    const subs = db.prepare('SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id = ?').all(userId) as { endpoint: string; p256dh: string; auth: string }[];
    for (const sub of subs) {
      void sendPush(sub, message, vapid, pushContact).then((result) => {
        if (result === 'gone') db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(sub.endpoint);
      });
    }
  };

  /** A message's text without formatting marks, for an alert or an email. */
  const plainPreview = (m: Json) => {
    const text = String(m.content ?? '')
      .replace(/```[\s\S]*?```/g, '[code]')
      .replace(/\|\|[\s\S]*?\|\|/g, '[spoiler]')
      .replace(/[*_~`>#]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) return text.length > 200 ? text.slice(0, 199) + '…' : text;
    const files = m.attachments as Json[] | undefined;
    return m.poll ? `Poll: ${(m.poll as Json).question}` : m.sticker ? 'Sent a sticker' : files?.length ? `Sent ${files.length === 1 ? 'a file' : `${files.length} files`}` : '';
  };

  /**
   * After a message is sent: pushes to the phones and browsers of people it's for who aren't
   * looking at Burrow right now, and remembers mentions for email. Muted rooms, "nothing" and
   * do not disturb stay silent; quiet hours make the alert silent.
   */
  const alertAway = (channel: Channel, message: Json, forWhom: Set<number>) => {
    const dm = serverKind(channel.serverId) === 'dm';
    const room = channel.kind === 'thread' && channel.parentId !== null ? channel.parentId : channel.id;
    const place = placeOf(channel.id, message.authorId as number);
    for (const id of channelAudience(channel)) {
      if (id === message.authorId || blocked(id, message.authorId as number)) continue;
      const forThem = dm || forWhom.has(id);
      const prefs = notifyPrefsOf(id, channel.serverId);
      const roomPref = prefs.get(room), burrowPref = prefs.get(0);
      if (roomPref?.mutedUntil || burrowPref?.mutedUntil) continue;
      const level = roomPref?.level ?? burrowPref?.level ?? null;
      if (level === 'none') continue;
      // Every message only when they asked for every message; otherwise just what's for them.
      if (!forThem && level !== 'all') continue;
      if (statusRow(id)?.status === 'dnd') continue;
      if (online.has(id) && !userIdle(id)) continue; // they'll see it in the app
      const where = dm
        ? isGroupDm(channel.serverId) ? `${message.author} in ${(db.prepare('SELECT name FROM servers WHERE id = ?').get(channel.serverId) as { name: string }).name || 'your group'}` : String(message.author)
        : `${message.author} in #${place?.channelName ?? channel.name}${place?.threadName ? ` › ${place.threadName}` : ''} (${place?.serverName ?? ''})`;
      pushTo(id, {
        title: where,
        body: plainPreview(message),
        tag: `room-${channel.id}`,
        channelId: channel.id,
        messageId: message.id,
        silent: inQuietHours(id),
        badge: badgeCount(id),
      });
    }
  };

  // ---- the mentions inbox ----

  route('GET', '/api/mentions', ({ user, url }) => {
    const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
    const seen = new Map<number, Channel | null>();
    const out: { id: number; channelId: number }[] = [];
    let cursor = before;
    // Rooms they can no longer see are skipped, so read in batches until there's one more than a page.
    for (let done = false; out.length <= 30 && !done; ) {
      const rows = db
        .prepare(
          `SELECT x.message_id AS id, m.channel_id AS channelId FROM mentions x JOIN messages m ON m.id = x.message_id
           WHERE x.user_id = ? AND x.message_id < ? ORDER BY x.message_id DESC LIMIT 60`,
        )
        .all(user.id, cursor) as { id: number; channelId: number }[];
      done = rows.length < 60;
      for (const r of rows) {
        cursor = r.id;
        if (!seen.has(r.channelId)) {
          const c = channelById(r.channelId);
          seen.set(r.channelId, c && canSee(c, user.id) ? c : null);
        }
        if (seen.get(r.channelId)) out.push(r);
      }
    }
    const more = out.length > 30;
    out.length = Math.min(out.length, 30);
    const lastRead = new Map<number, number>();
    const messages = messagesByIds(out.map((r) => r.id)).map((m) => {
      const c = seen.get(m.channelId as number)!;
      if (!lastRead.has(c.id)) lastRead.set(c.id, lastReadOf(user.id, c.id, c.serverId));
      return { ...m, place: placeOf(c.id, user.id), unread: (m.id as number) > lastRead.get(c.id)! };
    });
    return { messages, more };
  });
  // Clearing one from your inbox (it stays in the room).
  route('DELETE', '/api/mentions/:id', ({ user, params }) => {
    db.prepare('DELETE FROM mentions WHERE user_id = ? AND message_id = ?').run(user.id, Number(params[0]));
    return { ok: true };
  });

  // ---- email: confirming your address, so you can reset a forgotten password ----

  const mailTo = async (to: string, subject: string, text: string) => {
    if (!opts.mail) throw new HttpError(400, "Email isn't set up on this server");
    await sendMail(opts.mail, { to, subject, text });
  };

  route('POST', '/api/me/email', async ({ user, body }) => {
    if (!opts.mail) throw new HttpError(400, "Email isn't set up on this server");
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    if (!looksLikeEmail(email)) throw new HttpError(400, "That doesn't look like an email address");
    checkTries([`email:${user.id}`], 5);
    failedTry([`email:${user.id}`], 60 * 60 * 1000); // every code sent counts, so nobody's inbox is flooded
    const code = String(randomBytes(4).readUInt32BE() % 1_000_000).padStart(6, '0');
    db.prepare('UPDATE users SET email = ?, email_verified = 0, email_code = ?, email_code_expires = ? WHERE id = ?').run(email, code, now() + 30 * 60 * 1000, user.id);
    try {
      await mailTo(email, `Your Peiskos code: ${code}`, `Hi ${user.username},\n\nYour code to confirm this email address on Peiskos is ${code}. It works for 30 minutes.\n\nIf you didn't ask for this, you can ignore this email.`);
    } catch (err) {
      console.error('Sending email failed:', err);
      throw new HttpError(502, "Peiskos couldn't send the email. Check the address, or ask whoever runs this server.");
    }
    return meJson(user);
  });
  route('POST', '/api/me/email/verify', ({ user, body }) => {
    const r = db.prepare('SELECT email_code, email_code_expires FROM users WHERE id = ?').get(user.id) as { email_code: string | null; email_code_expires: number | null };
    checkTries([`email-code:${user.id}`], 5);
    if (!r.email_code || !r.email_code_expires || r.email_code_expires < now()) throw new HttpError(400, 'That code has run out. Send a new one.');
    if (!sameText(String(body.code ?? '').trim(), r.email_code)) {
      failedTry([`email-code:${user.id}`], 30 * 60 * 1000);
      throw new HttpError(400, "That code isn't right");
    }
    db.prepare('UPDATE users SET email_verified = 1, email_code = NULL, email_code_expires = NULL WHERE id = ?').run(user.id);
    return meJson(user);
  });
  route('DELETE', '/api/me/email', ({ user }) => {
    db.prepare('UPDATE users SET email = NULL, email_verified = 0, email_code = NULL, email_code_expires = NULL, reset_code = NULL WHERE id = ?').run(user.id);
    return meJson(user);
  });

  // Forgot your password: a code goes to your confirmed email, and the code sets a new one.
  const RESET_MINUTES = 30;
  const hashCode = (code: string) => createHash('sha256').update(code).digest('hex');
  route(
    'POST',
    '/api/password/forgot',
    async ({ body, ip }) => {
      if (!opts.mail) throw new HttpError(400, "Email isn't set up on this server, so ask whoever runs it to reset your password.");
      const name = String(body.username ?? '').trim();
      checkTries([`forgot-ip:${ip}`], 10);
      checkTries([`reset-user:${name.toLowerCase()}`], 3);
      failedTry([`forgot-ip:${ip}`], 60 * 60 * 1000);
      failedTry([`reset-user:${name.toLowerCase()}`], 60 * 60 * 1000); // every code sent counts, so nobody's inbox is flooded
      const u = db.prepare('SELECT id, username, email, email_verified FROM users WHERE username = ?').get(name) as
        | { id: number; username: string; email: string | null; email_verified: number }
        | undefined;
      // The same answer either way, so this can't be used to find out who has an email on file.
      const answer = { ok: true, minutes: RESET_MINUTES };
      if (!u?.email || !u.email_verified) return answer;
      const code = String(randomBytes(4).readUInt32BE() % 1_000_000).padStart(6, '0');
      db.prepare('UPDATE users SET reset_code = ?, reset_expires = ?, reset_tries = 0 WHERE id = ?').run(hashCode(code), now() + RESET_MINUTES * 60 * 1000, u.id);
      const link = opts.publicUrl ? `\n\nOpen Peiskos: ${opts.publicUrl}` : '';
      await mailTo(u.email, `Your Peiskos password code: ${code}`, `Hi ${u.username},\n\nSomeone (hopefully you) asked to reset your Peiskos password. Your code is ${code}. It works for ${RESET_MINUTES} minutes.${link}\n\nIf it wasn't you, ignore this email: your password stays the same.`).catch((err) =>
        console.error('Sending a password reset email failed:', err),
      );
      return answer;
    },
    false,
  );
  route(
    'POST',
    '/api/password/reset',
    ({ body, ip, ua }) => {
      const name = String(body.username ?? '').trim();
      checkTries([`reset-ip:${ip}`], 10);
      const u = db.prepare(`SELECT id, username, ${avatarUrl('avatar')} AS avatar, reset_code, reset_expires, reset_tries FROM users WHERE username = ?`).get(name) as
        | (User & { reset_code: string | null; reset_expires: number | null; reset_tries: number })
        | undefined;
      if (!u?.reset_code || !u.reset_expires || u.reset_expires < now()) throw new HttpError(400, 'That code has run out. Ask for a new one.');
      if (!sameText(hashCode(String(body.code ?? '').trim()), u.reset_code)) {
        failedTry([`reset-ip:${ip}`]);
        // Five wrong guesses and the code is gone, so it can't be guessed.
        if (u.reset_tries + 1 >= 5) db.prepare('UPDATE users SET reset_code = NULL WHERE id = ?').run(u.id);
        else db.prepare('UPDATE users SET reset_tries = reset_tries + 1 WHERE id = ?').run(u.id);
        throw new HttpError(400, u.reset_tries + 1 >= 5 ? 'Too many wrong codes. Ask for a new one.' : "That code isn't right");
      }
      if (typeof body.newPassword !== 'string' || body.newPassword.length < 8) throw new HttpError(400, 'New password must be at least 8 characters');
      db.prepare('UPDATE users SET password_hash = ?, reset_code = NULL, reset_expires = NULL, reset_tries = 0 WHERE id = ?').run(hashPassword(body.newPassword), u.id);
      // Signed out everywhere, as when you change it yourself.
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
      for (const ws of sockets.get(u.id) ?? []) ws.close(4001, 'Password changed');
      clearTries(`login-user:${name.toLowerCase()}`);
      // With two-step login on, the new password still needs the code from their phone.
      return loginOrAskCode(u.id, { ip, ua });
    },
    false,
  );

  // ---- unread messages: the newest message each person has read in each room ----

  const UNREAD_CAP = 100; // counts stop here; the app shows "99+"

  const lastReadOf = (userId: number, channelId: number, serverId: number) => {
    const row = db.prepare('SELECT last_read_id FROM read_state WHERE user_id = ? AND channel_id = ?').get(userId, channelId) as
      | { last_read_id: number }
      | undefined;
    if (row) return row.last_read_id;
    // A room you've never opened: what was said before you joined counts as read.
    const joined = (db.prepare('SELECT joined_at FROM members WHERE server_id = ? AND user_id = ?').get(serverId, userId) as { joined_at: number } | undefined)?.joined_at ?? 0;
    return (db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE channel_id = ? AND created_at < ?').get(channelId, joined) as { id: number }).id;
  };

  /** Where someone stopped reading a room, how many messages came after, and how many of those are for them. */
  const readInfo = (channelId: number, serverId: number, userId: number) => {
    const lastReadId = lastReadOf(userId, channelId, serverId);
    const count = (sql: string, ...args: (number | string)[]) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM messages m WHERE m.channel_id = ? AND m.id > ? AND m.author_id != ? ${sql} LIMIT ${UNREAD_CAP})`)
        .get(channelId, lastReadId, userId, ...args) as { n: number }).n;
    const unread = count('');
    if (!unread) return { lastReadId, unread, mentions: 0 };
    const dm = (db.prepare('SELECT kind FROM servers WHERE id = ?').get(serverId) as { kind: string } | undefined)?.kind === 'dm';
    // In a DM everything is for you; elsewhere it's @mentions (your name, @everyone, your roles) and replies to you.
    const mentions = dm ? unread : count('AND EXISTS (SELECT 1 FROM mentions x WHERE x.message_id = m.id AND x.user_id = ?)', userId);
    return { lastReadId, unread, mentions };
  };

  const readReceiptsOn = (userId: number) =>
    !!(db.prepare('SELECT read_receipts FROM users WHERE id = ?').get(userId) as { read_receipts: number } | undefined)?.read_receipts;
  // Only two-person conversations have a partner (and "Seen"); group ones don't.
  const dmPartner = (serverId: number, userId: number) =>
    isGroupDm(serverId)
      ? undefined
      : (db.prepare('SELECT user_id FROM members WHERE server_id = ? AND user_id != ?').get(serverId, userId) as { user_id: number } | undefined)?.user_id;
  /** In a DM, how far the other person has read, if you both share that. */
  const dmSeen = (serverId: number, viewerId: number) => {
    const partner = dmPartner(serverId, viewerId);
    const channel = db.prepare("SELECT id FROM channels WHERE server_id = ? AND kind = 'text'").get(serverId) as { id: number } | undefined;
    if (!partner || !channel || !readReceiptsOn(partner) || !readReceiptsOn(viewerId)) return null;
    return { userId: partner, lastReadId: lastReadOf(partner, channel.id, serverId) };
  };

  /**
   * Moves where someone has read up to. It only moves forward, unless `force` (marking a message
   * unread moves it back). Their other devices hear about it, and in a DM so does the other person.
   */
  const markRead = (userId: number, channel: Channel, messageId: number, { force = false, quiet = false } = {}) => {
    if (channel.kind === 'voice') return;
    if (!force && messageId <= lastReadOf(userId, channel.id, channel.serverId)) return;
    db.prepare(
      `INSERT INTO read_state (user_id, channel_id, last_read_id) VALUES (?, ?, ?)
       ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_id = excluded.last_read_id`,
    ).run(userId, channel.id, messageId);
    sendTo([userId], { type: 'read', channelId: channel.id, ...readInfo(channel.id, channel.serverId, userId) });
    if (quiet || force || channel.kind !== 'text') return;
    const kind = (db.prepare('SELECT kind FROM servers WHERE id = ?').get(channel.serverId) as { kind: string }).kind;
    const partner = kind === 'dm' ? dmPartner(channel.serverId, userId) : undefined;
    if (partner && readReceiptsOn(partner) && readReceiptsOn(userId))
      sendTo([partner], { type: 'dm_seen', serverId: channel.serverId, channelId: channel.id, userId, lastReadId: messageId });
  };

  // You've read a room up to here. With unread: true, it's set back to here ("mark unread").
  route('POST', '/api/channels/:id/read', ({ user, params, body }) => {
    const channel = channelById(Number(params[0]));
    if (!channel || !canSee(channel, user.id)) throw new HttpError(404, 'Room not found');
    const newest = (db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE channel_id = ?').get(channel.id) as { id: number }).id;
    const id = Math.max(0, Math.min(Math.floor(Number(body.lastReadId) || 0), newest));
    markRead(user.id, channel, id, { force: body.unread === true });
    return readInfo(channel.id, channel.serverId, user.id);
  });

  // Turning DM read receipts on or off. Your conversations update for both sides.
  route('PATCH', '/api/me', ({ user, body }) => {
    if (body.readReceipts !== undefined) {
      db.prepare('UPDATE users SET read_receipts = ? WHERE id = ?').run(body.readReceipts ? 1 : 0, user.id);
      const dms = db.prepare("SELECT s.id FROM members m JOIN servers s ON s.id = m.server_id WHERE m.user_id = ? AND s.kind = 'dm'").all(user.id) as { id: number }[];
      for (const { id } of dms) sendServerUpdate(id);
    }
    updateProfile(user, body);
    updateMyPresence(user, body);
    return meJson(userById(user.id)!);
  });

  // ---- pinned messages ----

  const MAX_PINS = 50;
  route('POST', '/api/messages/:id/pin', ({ user, params, body }) => {
    const id = Number(params[0]);
    const { channel } = visibleMessage(user, id);
    if (isBurrow(channel.serverId) && !can(channel.serverId, user.id, 'pin')) throw new HttpError(403, "Your roles don't allow pinning");
    if (body.pinned === false) db.prepare('UPDATE messages SET pinned_at = NULL, pinned_by = NULL WHERE id = ?').run(id);
    else {
      const pins = (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND pinned_at IS NOT NULL AND id != ?').get(channel.id, id) as { n: number }).n;
      if (pins >= MAX_PINS) throw new HttpError(400, `A room can have at most ${MAX_PINS} pins. Unpin one first.`);
      db.prepare('UPDATE messages SET pinned_at = COALESCE(pinned_at, ?), pinned_by = COALESCE(pinned_by, ?) WHERE id = ?').run(now(), user.id, id);
    }
    return messageChanged(id, channel);
  });

  /** A room's pinned messages, most recently pinned first. */
  route('GET', '/api/channels/:id/pins', ({ user, params }) => {
    const channel = channelById(Number(params[0]));
    if (!channel || !canSee(channel, user.id)) throw new HttpError(404, 'Room not found');
    const ids = db.prepare('SELECT id FROM messages WHERE channel_id = ? AND pinned_at IS NOT NULL ORDER BY pinned_at DESC').all(channel.id) as { id: number }[];
    return messagesByIds(ids.map((r) => r.id));
  });

  // ---- edit history ----

  /** What an edited message used to say, oldest first, each with when it was written. */
  route('GET', '/api/messages/:id/edits', ({ user, params }) => {
    const id = Number(params[0]);
    visibleMessage(user, id);
    return db.prepare('SELECT content, edited_at AS writtenAt FROM message_edits WHERE message_id = ? ORDER BY rowid').all(id);
  });

  // ---- saved messages and reminders: a private list of messages to come back to ----

  const MAX_SAVED = 500;
  const savedJson = (row: Json) => ({
    messageId: row.message_id,
    savedAt: row.saved_at,
    remindAt: row.remind_at,
    reminded: !!row.reminded,
  });

  route('POST', '/api/messages/:id/save', ({ user, params, body }) => {
    const id = Number(params[0]);
    visibleMessage(user, id);
    if (body.saved === false) {
      db.prepare('DELETE FROM saved_messages WHERE user_id = ? AND message_id = ?').run(user.id, id);
      sendTo([user.id], { type: 'saved', messageId: id, saved: null });
      return { saved: null };
    }
    let remindAt: number | null = null;
    if (body.remindAt != null) {
      remindAt = Math.floor(Number(body.remindAt));
      if (!(remindAt > now() && remindAt < now() + 366 * 86400_000)) throw new HttpError(400, 'Pick a time in the next year');
    }
    const count = (db.prepare('SELECT COUNT(*) AS n FROM saved_messages WHERE user_id = ?').get(user.id) as { n: number }).n;
    const already = db.prepare('SELECT 1 FROM saved_messages WHERE user_id = ? AND message_id = ?').get(user.id, id);
    if (!already && count >= MAX_SAVED) throw new HttpError(400, `You can save up to ${MAX_SAVED} messages`);
    db.prepare(
      `INSERT INTO saved_messages (user_id, message_id, saved_at, remind_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, message_id) DO UPDATE SET remind_at = excluded.remind_at, reminded = 0`,
    ).run(user.id, id, now(), remindAt);
    if (remindAt) wakeAt(remindAt);
    const row = db.prepare('SELECT * FROM saved_messages WHERE user_id = ? AND message_id = ?').get(user.id, id) as Json;
    const saved = savedJson(row);
    sendTo([user.id], { type: 'saved', messageId: id, saved });
    return { saved };
  });

  /** Your saved messages, newest first, with where each one is. Messages you can no longer see are left out. */
  route('GET', '/api/me/saved', ({ user }) => {
    const rows = db.prepare('SELECT * FROM saved_messages WHERE user_id = ? ORDER BY saved_at DESC').all(user.id) as Json[];
    const messages = new Map(messagesByIds(rows.map((r) => r.message_id as number)).map((m) => [m.id, m]));
    return rows.flatMap((r) => {
      const message = messages.get(r.message_id);
      const channel = message && channelById(message.channelId as number);
      if (!message || !channel || !canSee(channel, user.id)) return [];
      return [{ ...savedJson(r), message, place: placeOf(channel.id, user.id) }];
    });
  });

  /** Sends reminders that are due to whoever set them, if they're connected. The rest wait until they are. */
  const deliverReminders = (userId?: number) => {
    const rows = db
      .prepare(`SELECT * FROM saved_messages WHERE remind_at <= ? AND reminded = 0 ${userId ? 'AND user_id = ?' : ''}`)
      .all(...(userId ? [now(), userId] : [now()])) as Json[];
    for (const r of rows) {
      const uid = r.user_id as number;
      if (!sockets.has(uid)) continue;
      db.prepare('UPDATE saved_messages SET reminded = 1 WHERE user_id = ? AND message_id = ?').run(uid, r.message_id as number);
      const message = messageById(r.message_id as number);
      const channel = message && channelById(message.channelId as number);
      if (!message || !channel || !canSee(channel, uid)) continue;
      const saved = savedJson({ ...r, reminded: 1 });
      sendTo([uid], { type: 'reminder', saved, message, place: placeOf(channel.id, uid) });
    }
  };

  // ---- scheduled messages: written now, sent later ----

  const MAX_SCHEDULED = 25;
  const scheduledOf = (userId: number) =>
    (db.prepare('SELECT id, channel_id AS channelId, content, reply_to AS replyTo, send_at AS sendAt FROM scheduled_messages WHERE user_id = ? ORDER BY send_at').all(userId) as Json[])
      .map((s) => ({ ...s, place: placeOf(s.channelId as number, userId) }));
  const scheduledChanged = (userId: number) => sendTo([userId], { type: 'scheduled', items: scheduledOf(userId) });

  route('POST', '/api/channels/:id/scheduled', ({ user, params, body }) => {
    const channel = channelById(Number(params[0]));
    if (!channel || !canSee(channel, user.id)) throw new HttpError(404, 'Room not found');
    if (channel.kind === 'voice') throw new HttpError(400, 'Voice rooms have no messages');
    const content = typeof body.content === 'string' ? body.content : '';
    if (!content.trim()) throw new HttpError(400, 'Message is empty');
    if (content.length > MAX_MESSAGE_LENGTH) throw new HttpError(400, 'Message is too long');
    const sendAt = Math.floor(Number(body.sendAt));
    if (!(sendAt > now() + 10_000 && sendAt < now() + 366 * 86400_000)) throw new HttpError(400, 'Pick a time in the next year');
    const count = (db.prepare('SELECT COUNT(*) AS n FROM scheduled_messages WHERE user_id = ?').get(user.id) as { n: number }).n;
    if (count >= MAX_SCHEDULED) throw new HttpError(400, `You can have up to ${MAX_SCHEDULED} messages waiting to send`);
    db.prepare('INSERT INTO scheduled_messages (user_id, channel_id, content, reply_to, send_at, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      user.id, channel.id, content, body.replyTo == null ? null : Number(body.replyTo), sendAt, now(),
    );
    wakeAt(sendAt);
    scheduledChanged(user.id);
    return scheduledOf(user.id);
  });

  route('GET', '/api/me/scheduled', ({ user }) => scheduledOf(user.id));

  route('DELETE', '/api/scheduled/:id', ({ user, params }) => {
    db.prepare('DELETE FROM scheduled_messages WHERE id = ? AND user_id = ?').run(Number(params[0]), user.id);
    scheduledChanged(user.id);
    return scheduledOf(user.id);
  });

  /** Sends scheduled messages whose time has come, as the person who wrote them. */
  const sendScheduled = () => {
    const due = db.prepare('SELECT * FROM scheduled_messages WHERE send_at <= ? ORDER BY send_at').all(now()) as Json[];
    for (const s of due) {
      db.prepare('DELETE FROM scheduled_messages WHERE id = ?').run(s.id as number);
      const uid = s.user_id as number;
      const user = userById(uid);
      if (!user) continue;
      // The message it answered may be gone by now; it's sent anyway, as a plain message.
      const replyStill = s.reply_to != null && db.prepare('SELECT 1 FROM messages WHERE id = ? AND channel_id = ?').get(s.reply_to as number, s.channel_id as number);
      try {
        postMessage(user, s.channel_id as number, { content: s.content, replyTo: replyStill ? s.reply_to : null }, { scheduled: true });
      } catch (err) {
        sendTo([uid], { type: 'scheduled_failed', content: s.content, error: err instanceof Error ? err.message : 'Error' });
      }
      scheduledChanged(uid);
    }
  };

  // ---- forwarding: a copy of a message in another room, saying where it came from ----

  route('POST', '/api/messages/:id/forward', async ({ user, params, body }) => {
    const id = Number(params[0]);
    const { channel: from } = visibleMessage(user, id);
    const to = channelById(Number(body.channelId));
    if (!to || !canSee(to, user.id)) throw new HttpError(404, 'Room not found');
    if (to.kind === 'voice') throw new HttpError(400, 'Voice rooms have no messages');
    const m = messageById(id)!;
    const place = placeOf(from.id, user.id)!;
    // Files are copied, so the forward keeps working if the original is deleted.
    const attachmentIds: string[] = [];
    const spoilerIds: string[] = [];
    if ((m.attachments as Json[]).length) {
      if (!opts.uploadDir) throw new HttpError(503, 'Uploads are not set up on this server');
      for (const a of m.attachments as Json[]) {
        const copy = randomBytes(16).toString('base64url');
        await copyFile(filePath(a.id as string), filePath(copy)).catch(() => {
          throw new HttpError(410, 'One of its files is gone');
        });
        const thumb = a.thumb ? await copyFile(thumbPath(a.id as string), thumbPath(copy)).then(() => 1, () => 0) : 0;
        db.prepare(
          'INSERT INTO attachments (id, channel_id, uploader_id, name, type, size, created_at, voice_seconds, width, height, thumb) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(copy, to.id, user.id, a.name as string, a.type as string, a.size as number, now(), (a.voiceSeconds as number) ?? null, (a.width as number) ?? null, (a.height as number) ?? null, thumb);
        attachmentIds.push(copy);
        if (a.spoiler) spoilerIds.push(copy);
      }
    }
    let content = m.content as string;
    const poll = m.poll as { question: string; options: { text: string }[] } | null;
    if (poll) content = `📊 ${poll.question}\n${poll.options.map((o) => `• ${o.text}`).join('\n')}`;
    const sticker = m.sticker as { id: number; name: string } | null;
    const stickerServer = sticker?.id && (db.prepare('SELECT server_id FROM custom_emoji WHERE id = ?').get(sticker.id) as { server_id: number } | undefined)?.server_id;
    const keepSticker = !!stickerServer && isMember(stickerServer, user.id);
    if (sticker && !keepSticker) content = `${content}${content ? '\n' : ''}[sticker: ${sticker.name ?? 'removed'}]`;
    const forwarded = {
      messageId: id,
      authorId: m.authorId,
      author: m.author,
      createdAt: m.createdAt,
      from: place.kind === 'dm' ? 'a direct message' : place.threadName ? `${place.serverName} › #${place.channelName} › ${place.threadName}` : `${place.serverName} › #${place.channelName}`,
    };
    return postMessage(user, to.id, { content: content.slice(0, MAX_MESSAGE_LENGTH), attachmentIds, spoilerIds, stickerId: keepSticker ? sticker!.id : null }, { forwarded });
  });

  // ---- bots and webhooks ----
  //
  // A bot is an account for one burrow that logs in with a token instead of a password and uses
  // the same API and live connection as the app. A webhook is a web address that writes in one
  // room as its own bot, for services that only know how to send a message (GitHub, a home
  // server, a script). People who can edit the burrow make both.

  const MAX_BOTS = 20; // bots and webhooks in one burrow
  const botName = (value: unknown) => {
    const name = cleanName(value, 'Name', 32);
    if (/[\x00-\x1f]/.test(name)) throw new HttpError(400, "Names can't have control characters");
    return name;
  };
  /** A bot account: a username from its name (made unique), never able to log in with a password. */
  const makeBot = (serverId: number, name: string) => {
    const base = name.toLowerCase().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'bot';
    let username = `${base}-bot`;
    for (let n = 2; db.prepare('SELECT 1 FROM users WHERE username = ?').get(username); n++) username = `${base}-bot${n}`;
    const r = db
      .prepare('INSERT INTO users (username, display_name, password_hash, created_at, bot, bot_server_id) VALUES (?, ?, ?, ?, 1, ?)')
      .run(username, name, `bot$${randomBytes(16).toString('base64url')}`, now(), serverId);
    const id = Number(r.lastInsertRowid);
    db.prepare('INSERT INTO members (server_id, user_id, joined_at) VALUES (?, ?, ?)').run(serverId, id, now());
    return id;
  };
  const newBotToken = (userId: number) => {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    const token = newToken();
    db.prepare("INSERT INTO sessions (token, user_id, created_at, last_used_at, device) VALUES (?, ?, ?, ?, 'Bot')").run(token, userId, now(), now());
    return token;
  };
  const removeBot = (serverId: number, userId: number) => {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    for (const ws of sockets.get(userId) ?? []) ws.close(4001, 'Signed out');
    db.prepare('DELETE FROM webhooks WHERE user_id = ?').run(userId);
    // Its messages stay, under its name.
    db.prepare('UPDATE users SET deleted_at = ? WHERE id = ?').run(now(), userId);
    removeMember(serverId, userId);
  };
  const botsOf = (serverId: number) => ({
    bots: db
      .prepare(`SELECT u.id, u.username, u.display_name AS name, u.created_at AS createdAt,
                  (SELECT MAX(COALESCE(s.last_used_at, s.created_at)) FROM sessions s WHERE s.user_id = u.id) AS lastUsed
                FROM users u WHERE u.bot = 1 AND u.bot_server_id = ? AND u.deleted_at IS NULL
                  AND NOT EXISTS (SELECT 1 FROM webhooks w WHERE w.user_id = u.id) ORDER BY u.id`)
      .all(serverId),
    webhooks: db
      .prepare(`SELECT w.id, w.channel_id AS channelId, u.display_name AS name, u.id AS userId, w.created_at AS createdAt
                FROM webhooks w JOIN users u ON u.id = w.user_id WHERE w.server_id = ? ORDER BY w.id`)
      .all(serverId),
  });
  const botCount = (serverId: number) =>
    (db.prepare('SELECT COUNT(*) AS n FROM users WHERE bot = 1 AND bot_server_id = ? AND deleted_at IS NULL').get(serverId) as { n: number }).n;
  const webhookUrl = (host: string, secure: boolean, id: number, token: string) =>
    `${(opts.publicUrl || `${secure ? 'https' : 'http'}://${host}`).replace(/\/$/, '')}/api/webhooks/${id}/${token}`;

  route('GET', '/api/servers/:id/bots', ({ user, params }) => {
    const serverId = Number(params[0]);
    allowed(serverId, user, 'burrow');
    return botsOf(serverId);
  });
  route('POST', '/api/servers/:id/bots', ({ user, params, body }) => {
    const serverId = Number(params[0]);
    allowed(serverId, user, 'burrow');
    if (botCount(serverId) >= MAX_BOTS) throw new HttpError(400, `A hearth can have up to ${MAX_BOTS} bots and webhooks`);
    const id = makeBot(serverId, botName(body.name));
    audit(serverId, user.id, 'bot_add', id);
    sendServerUpdate(serverId);
    return { ...botsOf(serverId), token: newBotToken(id), botId: id };
  });
  const ownBot = (serverId: number, botId: number) => {
    const bot = db.prepare('SELECT id FROM users WHERE id = ? AND bot = 1 AND bot_server_id = ? AND deleted_at IS NULL').get(botId, serverId);
    if (!bot) throw new HttpError(404, 'No such bot');
  };
  route('POST', '/api/servers/:id/bots/:id/token', ({ user, params }) => {
    const [serverId, botId] = params.map(Number);
    allowed(serverId, user, 'burrow');
    ownBot(serverId, botId);
    for (const ws of sockets.get(botId) ?? []) ws.close(4001, 'Signed out');
    return { token: newBotToken(botId) };
  });
  route('DELETE', '/api/servers/:id/bots/:id', ({ user, params }) => {
    const [serverId, botId] = params.map(Number);
    allowed(serverId, user, 'burrow');
    ownBot(serverId, botId);
    removeBot(serverId, botId);
    audit(serverId, user.id, 'bot_remove', botId);
    return botsOf(serverId);
  });

  route('POST', '/api/channels/:id/webhooks', ({ user, params, body, host, secure }) => {
    const channel = channelById(Number(params[0]));
    if (!channel || channel.kind !== 'text' || !canSee(channel, user.id)) throw new HttpError(404, 'Room not found');
    allowed(channel.serverId, user, 'burrow');
    if (botCount(channel.serverId) >= MAX_BOTS) throw new HttpError(400, `A hearth can have up to ${MAX_BOTS} bots and webhooks`);
    const botId = makeBot(channel.serverId, botName(body.name));
    const token = randomBytes(24).toString('base64url');
    const r = db
      .prepare('INSERT INTO webhooks (server_id, channel_id, user_id, token_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(channel.serverId, channel.id, botId, createHash('sha256').update(token).digest('hex'), user.id, now());
    audit(channel.serverId, user.id, 'webhook_add', botId, `#${channel.name}`);
    sendServerUpdate(channel.serverId);
    return { ...botsOf(channel.serverId), url: webhookUrl(host, secure, Number(r.lastInsertRowid), token) };
  });
  route('DELETE', '/api/webhooks/:id', ({ user, params }) => {
    const hook = db.prepare('SELECT server_id AS serverId, user_id AS userId FROM webhooks WHERE id = ?').get(Number(params[0])) as
      | { serverId: number; userId: number }
      | undefined;
    if (!hook) throw new HttpError(404, 'No such webhook');
    allowed(hook.serverId, user, 'burrow');
    removeBot(hook.serverId, hook.userId);
    audit(hook.serverId, user.id, 'webhook_remove', hook.userId);
    return botsOf(hook.serverId);
  });

  // Posting to a webhook: { "content": "…" } (Discord style) or { "text": "…" } (Slack style).
  const hookTries = new Map<number, { count: number; until: number }>();
  route('POST', '/api/webhooks/:id/:code', ({ params, body }) => {
    const id = Number(params[0]);
    const hook = db.prepare('SELECT channel_id AS channelId, user_id AS userId, token_hash AS hash FROM webhooks WHERE id = ?').get(id) as
      | { channelId: number; userId: number; hash: string }
      | undefined;
    if (!hook || !sameText(createHash('sha256').update(params[1]).digest('hex'), hook.hash)) throw new HttpError(404, 'No such webhook');
    const t = now();
    const tries = hookTries.get(id);
    if (tries && tries.until > t && tries.count >= 30) throw new HttpError(429, 'Slow down: at most 30 messages a minute');
    if (!tries || tries.until <= t) hookTries.set(id, { count: 1, until: t + 60_000 });
    else tries.count++;
    const text = typeof body.content === 'string' ? body.content : typeof body.text === 'string' ? body.text : '';
    if (!text.trim()) throw new HttpError(400, 'Send { "content": "your message" }');
    const message = postMessage(userById(hook.userId)!, hook.channelId, { content: text.slice(0, MAX_MESSAGE_LENGTH) }, { webhook: true });
    return { id: message.id };
  }, false);

  // ---- polls ----

  const MAX_POLL_OPTIONS = 10;
  const pollFor = (messageId: number) => {
    const p = db.prepare('SELECT question, options, multi, closes_at FROM polls WHERE message_id = ?').get(messageId) as Json | undefined;
    if (!p) return null;
    const votes = db.prepare('SELECT user_id, option FROM poll_votes WHERE message_id = ? ORDER BY rowid').all(messageId) as { user_id: number; option: number }[];
    const options = (JSON.parse(p.options as string) as string[]).map((text, i) => ({ text, userIds: votes.filter((v) => v.option === i).map((v) => v.user_id) }));
    const closesAt = (p.closes_at as number | null) ?? null;
    return { question: p.question, options, multi: !!p.multi, closesAt, closed: closesAt !== null && closesAt <= now() };
  };

  const makePoll = (body: Json): PollInput => {
    const question = cleanName(body.question, 'Question', 300);
    const options = (Array.isArray(body.options) ? body.options : []).map((o) => (typeof o === 'string' ? o.trim() : '')).filter(Boolean);
    if (options.length < 2) throw new HttpError(400, 'A poll needs at least two answers');
    if (options.length > MAX_POLL_OPTIONS) throw new HttpError(400, `A poll can have at most ${MAX_POLL_OPTIONS} answers`);
    if (options.some((o) => o.length > 80)) throw new HttpError(400, 'Answers can be at most 80 characters');
    if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) throw new HttpError(400, 'Each answer must be different');
    const hours = Number(body.hours) || 0;
    if (hours < 0 || hours > 24 * 30) throw new HttpError(400, 'A poll can run for up to 30 days');
    return { question, options, multi: body.multi === true, closesAt: hours ? now() + hours * 3600_000 : null };
  };

  route('POST', '/api/channels/:id/polls', ({ user, params, body }) =>
    postMessage(user, Number(params[0]), { content: '', replyTo: body.replyTo }, { poll: makePoll(body) }));

  // Your answer (or answers) to a poll; an empty list takes your vote back.
  route('POST', '/api/messages/:id/vote', ({ user, params, body }) => {
    const id = Number(params[0]);
    const { channel } = visibleMessage(user, id);
    const poll = pollFor(id);
    if (!poll) throw new HttpError(404, "That message isn't a poll");
    if (poll.closed) throw new HttpError(400, 'This poll has closed');
    const picks = [...new Set((Array.isArray(body.options) ? body.options : []).map(Number))];
    if (picks.some((i) => !Number.isInteger(i) || i < 0 || i >= poll.options.length)) throw new HttpError(400, "That isn't one of the answers");
    if (!poll.multi && picks.length > 1) throw new HttpError(400, 'This poll takes one answer');
    db.prepare('DELETE FROM poll_votes WHERE message_id = ? AND user_id = ?').run(id, user.id);
    for (const i of picks) db.prepare('INSERT INTO poll_votes (message_id, user_id, option) VALUES (?, ?, ?)').run(id, user.id, i);
    return messageChanged(id, channel);
  });

  // Whoever asked (or anyone who can delete messages) can close a poll early.
  route('POST', '/api/messages/:id/poll/end', ({ user, params }) => {
    const id = Number(params[0]);
    const { channel, authorId } = visibleMessage(user, id);
    if (!pollFor(id)) throw new HttpError(404, "That message isn't a poll");
    if (authorId !== user.id && !can(channel.serverId, user.id, 'messages')) throw new HttpError(403, 'Only whoever asked can end this poll');
    db.prepare('UPDATE polls SET closes_at = MIN(COALESCE(closes_at, ?), ?), ended = 1 WHERE message_id = ?').run(now(), now(), id);
    return messageChanged(id, channel);
  });

  /** Tells everyone about polls that have just closed, so their results show as final. */
  const endPolls = () => {
    const due = db.prepare('SELECT p.message_id, m.channel_id FROM polls p JOIN messages m ON m.id = p.message_id WHERE p.ended = 0 AND p.closes_at <= ?').all(now()) as { message_id: number; channel_id: number }[];
    for (const p of due) {
      db.prepare('UPDATE polls SET ended = 1 WHERE message_id = ?').run(p.message_id);
      const channel = channelById(p.channel_id);
      if (channel) messageChanged(p.message_id, channel);
    }
  };

  // ---- custom emoji and stickers, each burrow's own ----

  const MAX_EMOJI = { emoji: 50, sticker: 20 } as const;
  const emojiOf = (serverId: number) =>
    db.prepare("SELECT id, name, kind, '/api/emoji/' || file AS url FROM custom_emoji WHERE server_id = ? ORDER BY kind, name").all(serverId);
  const stickerJson = (id: number) =>
    (db.prepare("SELECT id, name, '/api/emoji/' || file AS url FROM custom_emoji WHERE id = ? AND kind = 'sticker'").get(id) as Json | undefined) ?? { id, deleted: true };
  /** A custom emoji written <:name:id>, from a burrow this person is in. */
  const isCustomEmoji = (text: string, userId: number) => {
    const m = /^<:(\w{2,32}):(\d+)>$/.exec(text);
    if (!m) return false;
    const row = db.prepare("SELECT server_id, name FROM custom_emoji WHERE id = ? AND kind = 'emoji'").get(Number(m[2])) as { server_id: number; name: string } | undefined;
    return !!row && row.name === m[1] && isMember(row.server_id, userId);
  };
  const emojiName = (value: unknown) => {
    const name = typeof value === 'string' ? value.trim().replace(/^:|:$/g, '') : '';
    if (!/^\w{2,32}$/.test(name)) throw new HttpError(400, 'Names use 2 to 32 letters, numbers or underscores');
    return name;
  };
  const removeEmojiFile = (file: string) => {
    if (opts.uploadDir) unlink(picturePath('emoji', file)).catch(() => {});
  };

  // The picture is the raw request body; ?name= and ?kind=emoji|sticker say what it is.
  const handleEmojiUpload = async (req: IncomingMessage, res: ServerResponse, serverId: number, url: URL) => {
    const user = pictureUploader(req);
    allowed(serverId, user, 'emoji');
    const kind = url.searchParams.get('kind') === 'sticker' ? 'sticker' : 'emoji';
    const name = emojiName(url.searchParams.get('name'));
    const check = () => {
      const count = (db.prepare('SELECT COUNT(*) AS n FROM custom_emoji WHERE server_id = ? AND kind = ?').get(serverId, kind) as { n: number }).n;
      if (count >= MAX_EMOJI[kind]) throw new HttpError(400, `A hearth can have up to ${MAX_EMOJI[kind]} ${kind === 'sticker' ? 'stickers' : 'emoji'}`);
      if (db.prepare('SELECT 1 FROM custom_emoji WHERE server_id = ? AND kind = ? AND name = ?').get(serverId, kind, name))
        throw new HttpError(409, `There's already ${kind === 'sticker' ? 'a sticker' : 'an emoji'} called ${name}`);
    };
    check();
    const file = await savePicture(req, 'emoji', kind === 'sticker' ? 'Stickers' : 'Emoji');
    try {
      allowed(serverId, user, 'emoji');
      check();
    } catch (err) {
      removeEmojiFile(file);
      throw err;
    }
    db.prepare('INSERT INTO custom_emoji (server_id, name, kind, file, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(serverId, name, kind, file, user.id, now());
    sendServerUpdate(serverId);
    send(res, 200, serverSummary(serverId, user.id));
  };

  const managedEmoji = (id: number, user: User) => {
    const row = db.prepare('SELECT id, server_id, kind, file FROM custom_emoji WHERE id = ?').get(id) as { id: number; server_id: number; kind: string; file: string } | undefined;
    if (!row || !isMember(row.server_id, user.id)) throw new HttpError(404, 'Emoji not found');
    allowed(row.server_id, user, 'emoji');
    return row;
  };
  route('PATCH', '/api/emoji/:id', ({ user, params, body }) => {
    const row = managedEmoji(Number(params[0]), user);
    const name = emojiName(body.name);
    if (db.prepare('SELECT 1 FROM custom_emoji WHERE server_id = ? AND kind = ? AND name = ? AND id != ?').get(row.server_id, row.kind, name, row.id))
      throw new HttpError(409, `That name is taken`);
    db.prepare('UPDATE custom_emoji SET name = ? WHERE id = ?').run(name, row.id);
    sendServerUpdate(row.server_id);
    return serverSummary(row.server_id, user.id);
  });
  route('DELETE', '/api/emoji/:id', ({ user, params }) => {
    const row = managedEmoji(Number(params[0]), user);
    db.prepare('DELETE FROM custom_emoji WHERE id = ?').run(row.id);
    removeEmojiFile(row.file);
    sendServerUpdate(row.server_id);
    return serverSummary(row.server_id, user.id);
  });

  // ---- link previews ----

  const previewOpts = opts.linkPreviews === false ? null : opts.linkPreviews ?? {};
  const secret = (name: string) => {
    const row = db.prepare('SELECT value FROM app_secrets WHERE name = ?').get(name) as { value: string } | undefined;
    if (row) return row.value;
    const value = randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO app_secrets (name, value) VALUES (?, ?)').run(name, value);
    return value;
  };
  // Preview pictures load in <img> tags, which can't log in, so their links are signed instead.
  const embedKey = secret('embed-images');
  const embedSig = (messageId: number, position: number) =>
    createHmac('sha256', embedKey).update(`${messageId}:${position}`).digest('base64url').slice(0, 22);
  const embedsFor = (messageId: number) =>
    (db.prepare('SELECT position, data FROM message_embeds WHERE message_id = ? ORDER BY position').all(messageId) as { position: number; data: string }[]).map((r) => {
      const e = JSON.parse(r.data) as Embed;
      return { ...e, image: e.image ? `/api/embeds/${messageId}/${r.position}/${embedSig(messageId, r.position)}` : null };
    });

  // The same link is often posted more than once; previews are remembered for an hour.
  const previewCache = new Map<string, { at: number; embed: Embed | null }>();
  const cachedPreview = async (link: string) => {
    const hit = previewCache.get(link);
    if (hit && now() - hit.at < 3600_000) return hit.embed;
    const embed = await fetchEmbed(link, previewOpts!).catch(() => null);
    previewCache.set(link, { at: now(), embed });
    if (previewCache.size > 500) previewCache.delete(previewCache.keys().next().value!);
    return embed;
  };

  /** Fetches previews for a message's links in the background, then shows them to everyone. */
  const previewLinks = (messageId: number, channel: Channel, content: string) => {
    const links = previewOpts ? linksIn(content) : [];
    if (!links.length) return;
    Promise.all(links.map(cachedPreview)).then((embeds) => {
      // The message may have been deleted or edited to other links in the meantime.
      const current = db.prepare('SELECT content, embeds_off FROM messages WHERE id = ?').get(messageId) as { content: string; embeds_off: number } | undefined;
      if (!current || current.embeds_off || linksIn(current.content).join() !== links.join()) return;
      const found = embeds.filter((e): e is Embed => !!e);
      if (!found.length) return;
      db.prepare('DELETE FROM message_embeds WHERE message_id = ?').run(messageId);
      found.forEach((e, i) => db.prepare('INSERT INTO message_embeds (message_id, position, data) VALUES (?, ?, ?)').run(messageId, i, JSON.stringify(e)));
      messageChanged(messageId, channel);
    }).catch((err) => console.warn(`Link preview failed: ${err.message}`));
  };

  // Whoever wrote a message can hide its previews.
  route('POST', '/api/messages/:id/embeds', ({ user, params }) => {
    const id = Number(params[0]);
    const { channel, authorId } = visibleMessage(user, id);
    if (authorId !== user.id) throw new HttpError(403, 'You can only change your own messages');
    db.prepare('UPDATE messages SET embeds_off = 1 WHERE id = ?').run(id);
    db.prepare('DELETE FROM message_embeds WHERE message_id = ?').run(id);
    return messageChanged(id, channel);
  });

  const imageCache = new Map<string, { type: string; data: Buffer }>();
  let imageCacheBytes = 0;
  const serveEmbedImage = async (req: IncomingMessage, res: ServerResponse, messageId: number, position: number, sig: string) => {
    if (!sameText(sig, embedSig(messageId, position))) throw new HttpError(404, 'Picture not found');
    const row = db.prepare('SELECT data FROM message_embeds WHERE message_id = ? AND position = ?').get(messageId, position) as { data: string } | undefined;
    const link = row && (JSON.parse(row.data) as Embed).image;
    if (!link || !previewOpts) throw new HttpError(404, 'Picture not found');
    let image = imageCache.get(link);
    if (!image) {
      try {
        image = await fetchImage(link, previewOpts);
      } catch {
        throw new HttpError(502, "Couldn't load that picture");
      }
      imageCache.set(link, image);
      imageCacheBytes += image.data.length;
      for (const [k, v] of imageCache) {
        if (imageCacheBytes <= 40 * 1024 * 1024) break;
        imageCache.delete(k);
        imageCacheBytes -= v.data.length;
      }
    }
    res.writeHead(200, {
      'content-type': image.type,
      'content-length': image.data.length,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, max-age=86400',
    });
    res.end(req.method === 'HEAD' ? undefined : image.data);
  };

  // ---- search ----

  /** The rooms a search looks through: a burrow's (with its threads), your DMs, or everything you can see. */
  const searchRooms = (user: User, scope: string | null) => {
    const sql = `SELECT c.id, c.server_id AS serverId, c.name, c.kind, c.private, c.parent_id AS parentId FROM channels c
                 JOIN members m ON m.server_id = c.server_id AND m.user_id = ? JOIN servers s ON s.id = c.server_id
                 WHERE c.kind != 'voice' ${scope === 'dms' ? "AND s.kind = 'dm'" : scope ? 'AND s.id = ?' : ''}`;
    const args = scope && scope !== 'dms' ? [user.id, Number(scope)] : [user.id];
    return (db.prepare(sql).all(...args) as Channel[]).filter((c) => canSee(c, user.id)).map((c) => c.id);
  };

  // ?q= words (matching the start of words), and optionally in= a burrow id or "dms", room=, from= a user id,
  // has=image|video|audio|file|link, before= and after= (times in ms), and offset= for more.
  route('GET', '/api/search', ({ user, url }) => {
    const p = url.searchParams;
    const words = (p.get('q') ?? '').match(/[\p{L}\p{N}_]+/gu) ?? [];
    const conditions: string[] = [];
    const args: (string | number)[] = [];
    let rooms = searchRooms(user, p.get('in'));
    if (p.get('room')) rooms = rooms.filter((id) => id === Number(p.get('room')));
    if (words.length) {
      conditions.push('m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)');
      args.push(words.slice(0, 12).map((w) => `"${w}"*`).join(' '));
    }
    if (p.get('from')) {
      conditions.push('m.author_id = ?');
      args.push(Number(p.get('from')));
    }
    const has = p.get('has');
    const attachment = (type: string) => `EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id ${type})`;
    if (has === 'image') conditions.push(`(${attachment("AND a.type LIKE 'image/%'")} OR m.sticker_id IS NOT NULL)`);
    else if (has === 'video') conditions.push(attachment("AND a.type LIKE 'video/%'"));
    else if (has === 'audio') conditions.push(attachment("AND a.type LIKE 'audio/%'"));
    else if (has === 'file') conditions.push(attachment(''));
    else if (has === 'link') conditions.push("(m.content LIKE '%http://%' OR m.content LIKE '%https://%')");
    else if (has === 'poll') conditions.push('EXISTS (SELECT 1 FROM polls WHERE message_id = m.id)');
    if (!conditions.length) throw new HttpError(400, 'Type something to search for');
    if (Number(p.get('before'))) {
      conditions.push('m.created_at < ?');
      args.push(Number(p.get('before')));
    }
    if (Number(p.get('after'))) {
      conditions.push('m.created_at >= ?');
      args.push(Number(p.get('after')));
    }
    if (!rooms.length) return { results: [], more: false };
    const PAGE = 25;
    const offset = Math.max(0, Math.min(Number(p.get('offset')) || 0, 1000));
    const ids = (
      db
        .prepare(`SELECT m.id FROM messages m WHERE m.channel_id IN (${rooms.join(',')}) AND ${conditions.join(' AND ')} ORDER BY m.id DESC LIMIT ? OFFSET ?`)
        .all(...args, PAGE + 1, offset) as { id: number }[]
    ).map((r) => r.id);
    const results = messagesByIds(ids.slice(0, PAGE)).map((message) => ({ message, place: placeOf(message.channelId as number, user.id) }));
    return { results, more: ids.length > PAGE };
  });

  // ---- threads: side conversations off one message ----

  const threadOf = (messageId: number) =>
    (db
      .prepare(
        `SELECT c.id, c.name, (SELECT COUNT(*) FROM messages WHERE channel_id = c.id) AS count,
                (SELECT MAX(created_at) FROM messages WHERE channel_id = c.id) AS lastAt
         FROM channels c WHERE c.parent_message_id = ? AND c.kind = 'thread'`,
      )
      .get(messageId) as Json | undefined) ?? null;

  /** A burrow's threads that someone can see, with how much of each they've read. */
  const threadsIn = (serverId: number, viewerId: number) => {
    const rows = db
      .prepare(
        `SELECT c.id, c.name, c.parent_id AS parentId, c.parent_message_id AS parentMessageId, c.created_by AS createdBy,
                c.created_at AS createdAt, (SELECT COUNT(*) FROM messages WHERE channel_id = c.id) AS count,
                COALESCE((SELECT MAX(created_at) FROM messages WHERE channel_id = c.id), c.created_at) AS lastAt
         FROM channels c WHERE c.server_id = ? AND c.kind = 'thread' ORDER BY lastAt DESC`,
      )
      .all(serverId) as Json[];
    const seen = new Map<number, boolean>();
    const parentVisible = (id: number) => {
      if (!seen.has(id)) {
        const parent = channelById(id);
        seen.set(id, !!parent && canSee(parent, viewerId));
      }
      return seen.get(id)!;
    };
    return rows.filter((t) => parentVisible(t.parentId as number)).map((t) => ({ ...t, ...readInfo(t.id as number, serverId, viewerId) }));
  };

  /** The thread's message in the room it hangs off shows its reply count, so that message updates. */
  const threadChanged = (thread: Channel) => {
    const row = db.prepare('SELECT parent_message_id FROM channels WHERE id = ?').get(thread.id) as { parent_message_id: number | null } | undefined;
    const parent = thread.parentId === null ? undefined : channelById(thread.parentId);
    if (row?.parent_message_id && parent) messageChanged(row.parent_message_id, parent);
  };
  /** After a thread is deleted, its message loses the reply count. */
  const threadDeleted = (thread: Channel, parentMessageId: number | null) => {
    const parent = thread.parentId === null ? undefined : channelById(thread.parentId);
    if (parent && parentMessageId) messageChanged(parentMessageId, parent);
  };

  /** Whoever started a thread can rename or delete it, and so can anyone who manages rooms. */
  const manageableThread = (thread: Channel, user: User) => {
    const row = db.prepare('SELECT created_by, parent_message_id FROM channels WHERE id = ?').get(thread.id) as { created_by: number | null; parent_message_id: number | null };
    if (row.created_by !== user.id && !can(thread.serverId, user.id, 'rooms')) throw new HttpError(403, 'Only whoever started this thread can change it');
    return row.parent_message_id;
  };
  const threadName = (value: unknown) => {
    const name = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
    if (!name) throw new HttpError(400, 'Thread name is required');
    return name.slice(0, 60);
  };
  const renameThread = (thread: Channel, user: User, name: unknown) => {
    manageableThread(thread, user);
    db.prepare('UPDATE channels SET name = ? WHERE id = ?').run(threadName(name), thread.id);
    sendServerUpdate(thread.serverId);
    threadChanged(thread);
    return serverSummary(thread.serverId, user.id);
  };

  // Starts a thread off a message (or opens the one it already has).
  route('POST', '/api/messages/:id/thread', ({ user, params, body }) => {
    const id = Number(params[0]);
    const { channel } = visibleMessage(user, id);
    if (channel.kind !== 'text') throw new HttpError(400, "Threads can't start inside a thread");
    let thread = db.prepare("SELECT id FROM channels WHERE parent_message_id = ? AND kind = 'thread'").get(id) as { id: number } | undefined;
    if (!thread) {
      const m = db.prepare('SELECT content FROM messages WHERE id = ?').get(id) as { content: string };
      const firstLine = m.content.split('\n').find((l) => l.trim()) ?? '';
      // The first line, without its formatting marks (headings, quotes, bold and so on) or custom emoji codes.
      const plain = firstLine.replace(/<:(\w+):\d+>/g, ':$1:').replace(/^\s*(#{1,3}|>|[-*]|\d+[.)])\s+/, '').replace(/[*_~`|]/g, '');
      const name = body.name ? threadName(body.name) : plain.replace(/\s+/g, ' ').trim().slice(0, 40) || 'Thread';
      const r = db
        .prepare("INSERT INTO channels (server_id, name, kind, private, created_at, parent_id, parent_message_id, created_by) VALUES (?, ?, 'thread', 0, ?, ?, ?, ?)")
        .run(channel.serverId, name, now(), channel.id, id, user.id);
      thread = { id: Number(r.lastInsertRowid) };
      messageChanged(id, channel);
      sendServerUpdate(channel.serverId);
    }
    return { threadId: thread.id, server: serverSummary(channel.serverId, user.id) };
  });

  // ---- rooms, burrows and organization -------------------------------------

  /** Whether someone has accepted the burrow's rules, or there are none. The host wrote them. */
  const rulesOk = (serverId: number, userId: number) => {
    const row = db
      .prepare('SELECT s.rules, s.owner_id, m.rules_accepted_at FROM servers s JOIN members m ON m.server_id = s.id WHERE s.id = ? AND m.user_id = ?')
      .get(serverId, userId) as { rules: string; owner_id: number; rules_accepted_at: number | null } | undefined;
    return !row?.rules || row.owner_id === userId || row.rules_accepted_at !== null;
  };

  /** Why someone can't write in a room right now (archived, announcements only, rules not accepted), or null if they can. */
  const postProblem = (channel: Channel, userId: number): string | null => {
    const room = channel.kind === 'thread' && channel.parentId !== null ? channelById(channel.parentId) ?? channel : channel;
    if (room.archivedAt !== null) return 'This room is archived';
    const me = standing(channel.serverId, userId);
    if (!me) return 'Room not found';
    if (channel.kind !== 'thread' && channel.announce && !me.perms.has('rooms')) {
      const allowedRoles = db.prepare('SELECT role_id FROM channel_post_roles WHERE channel_id = ?').all(channel.id) as { role_id: number }[];
      if (!allowedRoles.some((r) => me.roleIds.includes(r.role_id))) return 'Only some roles can post in this room';
    }
    if (!me.perms.has('rooms') && me.roleIds.length) {
      const readOnly = db.prepare('SELECT role_id FROM channel_read_only WHERE channel_id = ?').all(room.id) as { role_id: number }[];
      if (readOnly.some((r) => me.roleIds.includes(r.role_id))) return 'Your role can only read this room';
    }
    const left = timeoutLeft(channel.serverId, userId);
    if (left) return `You're timed out for ${left}`;
    if (!rulesOk(channel.serverId, userId)) return "Accept the hearth's rules first";
    return null;
  };

  /** Your notification settings in a burrow: channel id (0 for the whole burrow) -> { level, mutedUntil }. Ended mutes are left out. */
  const notifyPrefsOf = (userId: number, serverId: number) => {
    const rows = db
      .prepare('SELECT channel_id, level, muted_until FROM notify_prefs WHERE user_id = ? AND server_id = ?')
      .all(userId, serverId) as { channel_id: number; level: string | null; muted_until: number | null }[];
    const out = new Map<number, { level: string | null; mutedUntil: number | null }>();
    for (const r of rows) {
      const mutedUntil = r.muted_until !== null && (r.muted_until === -1 || r.muted_until > now()) ? r.muted_until : null;
      if (r.level || mutedUntil) out.set(r.channel_id, { level: r.level, mutedUntil });
    }
    return out;
  };

  // All messages, only @mentions, or nothing; and muting for a while (or until turned back on).
  route('POST', '/api/notify', ({ user, body }) => {
    const serverId = Number(body.serverId);
    if (!isMember(serverId, user.id)) throw new HttpError(404, 'Hearth not found');
    const channelId = body.channelId == null ? 0 : Number(body.channelId);
    if (channelId) {
      const channel = channelById(channelId);
      if (!channel || channel.serverId !== serverId || !canSee(channel, user.id)) throw new HttpError(404, 'Room not found');
    }
    const level = ['all', 'mentions', 'none'].includes(body.level as string) ? (body.level as string) : null;
    const until = body.mutedUntil == null ? null : Math.floor(Number(body.mutedUntil));
    if (until !== null && until !== -1 && !(until > now())) throw new HttpError(400, 'Pick a time in the future');
    db.prepare(
      `INSERT INTO notify_prefs (user_id, server_id, channel_id, level, muted_until) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, server_id, channel_id) DO UPDATE SET level = excluded.level, muted_until = excluded.muted_until`,
    ).run(user.id, serverId, channelId, level, until);
    const server = serverSummary(serverId, user.id);
    sendTo([user.id], { type: 'server_updated', server }); // your other devices
    return server;
  });

  /** A room heading in this burrow, or a 400. */
  const groupIn = (serverId: number, id: unknown) => {
    const row = db.prepare('SELECT id FROM room_groups WHERE id = ? AND server_id = ?').get(Number(id), serverId) as { id: number } | undefined;
    if (!row) throw new HttpError(400, 'That heading is gone');
    return row.id;
  };
  const groupById = (id: number) =>
    db.prepare('SELECT id, server_id AS serverId FROM room_groups WHERE id = ?').get(id) as { id: number; serverId: number } | undefined;

  route('POST', '/api/servers/:id/groups', ({ user, params, body }) => {
    const serverId = Number(params[0]);
    allowed(serverId, user, 'rooms');
    const count = db.prepare('SELECT COUNT(*) AS n, MAX(position) AS last FROM room_groups WHERE server_id = ?').get(serverId) as { n: number; last: number | null };
    if (count.n >= 30) throw new HttpError(400, 'A hearth can have at most 30 headings');
    db.prepare('INSERT INTO room_groups (server_id, name, position) VALUES (?, ?, ?)').run(serverId, cleanName(body.name, 'Heading', 32), (count.last ?? 0) + 1);
    sendServerUpdate(serverId);
    return serverSummary(serverId, user.id);
  });

  route('PATCH', '/api/groups/:id', ({ user, params, body }) => {
    const group = groupById(Number(params[0]));
    if (!group || !isMember(group.serverId, user.id)) throw new HttpError(404, 'Heading not found');
    allowed(group.serverId, user, 'rooms');
    db.prepare('UPDATE room_groups SET name = ? WHERE id = ?').run(cleanName(body.name, 'Heading', 32), group.id);
    sendServerUpdate(group.serverId);
    return serverSummary(group.serverId, user.id);
  });

  // Deleting a heading keeps its rooms; they move out from under it.
  route('DELETE', '/api/groups/:id', ({ user, params }) => {
    const group = groupById(Number(params[0]));
    if (!group || !isMember(group.serverId, user.id)) throw new HttpError(404, 'Heading not found');
    allowed(group.serverId, user, 'rooms');
    db.prepare('UPDATE channels SET group_id = NULL WHERE group_id = ?').run(group.id);
    db.prepare('DELETE FROM room_groups WHERE id = ?').run(group.id);
    sendServerUpdate(group.serverId);
    return serverSummary(group.serverId, user.id);
  });

  /**
   * Puts the rooms in this order, each under its heading (or none), and the headings in their order.
   * Rooms left out keep their place after the ones given. Voice rooms never sit under a heading.
   */
  route('POST', '/api/servers/:id/layout', ({ user, params, body }) => {
    const serverId = Number(params[0]);
    allowed(serverId, user, 'rooms');
    const rooms = new Map(
      (db.prepare("SELECT id, kind FROM channels WHERE server_id = ? AND kind != 'thread' ORDER BY COALESCE(position, id), id").all(serverId) as { id: number; kind: string }[]).map((r) => [r.id, r.kind]),
    );
    const groups = new Set((db.prepare('SELECT id FROM room_groups WHERE server_id = ?').all(serverId) as { id: number }[]).map((g) => g.id));
    const given = (Array.isArray(body.rooms) ? body.rooms : []) as Json[];
    const order: { id: number; groupId: number | null }[] = [];
    for (const r of given) {
      const id = Number(r?.id);
      if (!rooms.has(id) || order.some((o) => o.id === id)) continue;
      const groupId = r.groupId == null || rooms.get(id) !== 'text' ? null : Number(r.groupId);
      if (groupId !== null && !groups.has(groupId)) throw new HttpError(400, 'That heading is gone');
      order.push({ id, groupId });
    }
    db.exec('BEGIN');
    try {
      let position = 1;
      const place = db.prepare('UPDATE channels SET position = ?, group_id = ? WHERE id = ?');
      for (const o of order) place.run(position++, o.groupId, o.id);
      for (const id of rooms.keys()) if (!order.some((o) => o.id === id)) db.prepare('UPDATE channels SET position = ? WHERE id = ?').run(position++, id);
      if (Array.isArray(body.groups)) {
        const seen = new Set<number>();
        let gp = 1;
        for (const g of body.groups.map(Number)) if (groups.has(g) && !seen.has(g)) { seen.add(g); db.prepare('UPDATE room_groups SET position = ? WHERE id = ?').run(gp++, g); }
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    sendServerUpdate(serverId);
    return serverSummary(serverId, user.id);
  });

  // The burrow's name, blurb, welcome room and rules. In a group conversation anyone can rename it.
  route('PATCH', '/api/servers/:id', ({ user, params, body }) => {
    const serverId = Number(params[0]);
    if (isGroupDm(serverId)) {
      if (!isMember(serverId, user.id)) throw new HttpError(404, 'Conversation not found');
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name.length > 64) throw new HttpError(400, 'The name can be at most 64 characters');
      db.prepare('UPDATE servers SET name = ? WHERE id = ?').run(name, serverId);
      sendServerUpdate(serverId);
      return serverSummary(serverId, user.id);
    }
    allowed(serverId, user, 'burrow');
    const changes = Object.keys(body).filter((k) => ['name', 'description', 'welcomeChannelId', 'afkChannelId', 'afkMinutes', 'rules', 'uploadMb', 'wordFilter', 'liveChannelId'].includes(k));
    if (changes.length) audit(serverId, user.id, 'burrow_edit', null, changes.map((k) => BURROW_FIELDS[k]).join(', '));
    if (body.uploadMb !== undefined) db.prepare('UPDATE servers SET upload_mb = ? WHERE id = ?').run(cleanUploadMb(body.uploadMb), serverId);
    if (body.wordFilter !== undefined) db.prepare('UPDATE servers SET word_filter = ? WHERE id = ?').run(cleanWordFilter(body.wordFilter), serverId);
    if (body.liveChannelId !== undefined) {
      const channel = body.liveChannelId === null ? null : channelById(Number(body.liveChannelId));
      if (channel && (channel.serverId !== serverId || channel.kind !== 'text'))
        throw new HttpError(400, 'Pick a text room in this hearth for go-live posts');
      db.prepare('UPDATE servers SET live_channel_id = ? WHERE id = ?').run(channel?.id ?? null, serverId);
    }
    if (body.name !== undefined) db.prepare('UPDATE servers SET name = ? WHERE id = ?').run(cleanName(body.name, 'Hearth name'), serverId);
    if (body.description !== undefined) {
      const text = typeof body.description === 'string' ? body.description.trim() : '';
      if (text.length > MAX_DESCRIPTION) throw new HttpError(400, `The description can be at most ${MAX_DESCRIPTION} characters`);
      db.prepare('UPDATE servers SET description = ? WHERE id = ?').run(text, serverId);
    }
    if (body.welcomeChannelId !== undefined) {
      const channel = body.welcomeChannelId === null ? null : channelById(Number(body.welcomeChannelId));
      if (channel && (channel.serverId !== serverId || channel.kind !== 'text' || channel.private))
        throw new HttpError(400, 'The welcome room must be a text room everyone can see');
      db.prepare('UPDATE servers SET welcome_channel_id = ? WHERE id = ?').run(channel?.id ?? null, serverId);
    }
    if (body.afkChannelId !== undefined) {
      const channel = body.afkChannelId === null ? null : channelById(Number(body.afkChannelId));
      if (channel && (channel.serverId !== serverId || channel.kind !== 'voice')) throw new HttpError(400, 'The AFK fire must be one of this hearth\'s voice rooms');
      db.prepare('UPDATE servers SET afk_channel_id = ? WHERE id = ?').run(channel?.id ?? null, serverId);
    }
    if (body.afkMinutes !== undefined) {
      const minutes = Math.floor(Number(body.afkMinutes));
      if (!(minutes >= 1 && minutes <= 240)) throw new HttpError(400, 'Pick between 1 minute and 4 hours');
      db.prepare('UPDATE servers SET afk_minutes = ? WHERE id = ?').run(minutes, serverId);
    }
    if (body.rules !== undefined) {
      const rules = typeof body.rules === 'string' ? body.rules.trim() : '';
      if (rules.length > MAX_RULES) throw new HttpError(400, `The rules can be at most ${MAX_RULES} characters`);
      const old = (db.prepare('SELECT rules FROM servers WHERE id = ?').get(serverId) as { rules: string }).rules;
      db.prepare('UPDATE servers SET rules = ? WHERE id = ?').run(rules, serverId);
      // Changed rules need accepting again, by everyone but whoever changed them.
      if (rules !== old) {
        db.prepare('UPDATE members SET rules_accepted_at = NULL WHERE server_id = ?').run(serverId);
        db.prepare('UPDATE members SET rules_accepted_at = ? WHERE server_id = ? AND user_id = ?').run(now(), serverId, user.id);
      }
    }
    sendServerUpdate(serverId);
    return serverSummary(serverId, user.id);
  });

  route('POST', '/api/servers/:id/rules/accept', ({ user, params }) => {
    const serverId = Number(params[0]);
    if (!isMember(serverId, user.id)) throw new HttpError(404, 'Hearth not found');
    db.prepare('UPDATE members SET rules_accepted_at = ? WHERE server_id = ? AND user_id = ?').run(now(), serverId, user.id);
    const server = serverSummary(serverId, user.id);
    sendTo([user.id], { type: 'server_updated', server });
    return server;
  });

  // The host hands the burrow to someone else in it, and becomes an ordinary member.
  route('POST', '/api/servers/:id/transfer', ({ user, params, body }) => {
    const serverId = Number(params[0]);
    const me = standing(serverId, user.id);
    if (!me?.host) throw new HttpError(403, 'Only the host can hand the hearth over');
    const to = Number(body.userId);
    if (to === user.id || !isMember(serverId, to)) throw new HttpError(400, "They aren't in this hearth");
    db.prepare('UPDATE servers SET owner_id = ? WHERE id = ?').run(to, serverId);
    accessChanged(serverId);
    return serverSummary(serverId, user.id);
  });

  // ---- invites: each burrow's permanent code, plus links that run out ----

  /** The burrow an invite code or link opens, or why it doesn't. */
  const inviteTarget = (raw: unknown) => {
    const code = String(raw ?? '').trim().split('/').pop() ?? '';
    const permanent = db.prepare("SELECT id FROM servers WHERE invite_code = ? AND kind = 'burrow'").get(code) as { id: number } | undefined;
    if (permanent) return { serverId: permanent.id, invite: null };
    const inv = db.prepare('SELECT code, server_id, expires_at, max_uses, uses FROM invites WHERE code = ?').get(code) as
      | { code: string; server_id: number; expires_at: number | null; max_uses: number | null; uses: number }
      | undefined;
    if (!inv) throw new HttpError(404, 'Invite code not found');
    if (inv.expires_at !== null && inv.expires_at <= now()) throw new HttpError(410, 'This invite has expired');
    if (inv.max_uses !== null && inv.uses >= inv.max_uses) throw new HttpError(410, 'This invite has been used up');
    return { serverId: inv.server_id, invite: inv.code };
  };

  const invitesOf = (serverId: number, user: User) => {
    const all = can(serverId, user.id, 'invites');
    return db
      .prepare(
        `SELECT i.code, i.created_at AS createdAt, i.expires_at AS expiresAt, i.max_uses AS maxUses, i.uses, u.username AS createdBy
         FROM invites i LEFT JOIN users u ON u.id = i.created_by
         WHERE i.server_id = ? AND (? OR i.created_by = ?)
           AND (i.expires_at IS NULL OR i.expires_at > ?) AND (i.max_uses IS NULL OR i.uses < i.max_uses)
         ORDER BY i.created_at DESC`,
      )
      .all(serverId, all ? 1 : 0, user.id, now());
  };

  // Anyone in a burrow can make an invite; people who can edit the burrow see and cancel everyone's.
  route('GET', '/api/servers/:id/invites', ({ user, params }) => {
    const serverId = Number(params[0]);
    if (!standing(serverId, user.id) || isGroupDm(serverId)) throw new HttpError(404, 'Hearth not found');
    return invitesOf(serverId, user);
  });

  route('POST', '/api/servers/:id/invites', ({ user, params, body }) => {
    const serverId = Number(params[0]);
    const kind = (db.prepare('SELECT kind FROM servers WHERE id = ?').get(serverId) as { kind: string } | undefined)?.kind;
    if (kind !== 'burrow' || !isMember(serverId, user.id)) throw new HttpError(404, 'Hearth not found');
    const expiresIn = body.expiresIn == null ? null : Math.floor(Number(body.expiresIn));
    if (expiresIn !== null && !(expiresIn >= 60 && expiresIn <= 30 * 86400)) throw new HttpError(400, 'Invites can last from a minute to 30 days');
    const maxUses = body.maxUses == null ? null : Math.floor(Number(body.maxUses));
    if (maxUses !== null && !(maxUses >= 1 && maxUses <= 1000)) throw new HttpError(400, 'Invites can be used from 1 to 1000 times');
    const live = (db.prepare('SELECT COUNT(*) AS n FROM invites WHERE server_id = ? AND (expires_at IS NULL OR expires_at > ?)').get(serverId, now()) as { n: number }).n;
    if (live >= 100) throw new HttpError(400, 'This hearth has too many invites. Cancel some first.');
    const code = newInviteCode();
    db.prepare('INSERT INTO invites (code, server_id, created_by, created_at, expires_at, max_uses) VALUES (?, ?, ?, ?, ?, ?)').run(
      code, serverId, user.id, now(), expiresIn === null ? null : now() + expiresIn * 1000, maxUses,
    );
    return { code, invites: invitesOf(serverId, user) };
  });

  route('DELETE', '/api/invites/:code', ({ user, params }) => {
    const inv = db.prepare('SELECT server_id, created_by FROM invites WHERE code = ?').get(params[0]) as { server_id: number; created_by: number | null } | undefined;
    if (!inv || !isMember(inv.server_id, user.id)) throw new HttpError(404, 'Invite not found');
    if (inv.created_by !== user.id) allowed(inv.server_id, user, 'invites');
    db.prepare('DELETE FROM invites WHERE code = ?').run(params[0]);
    return invitesOf(inv.server_id, user);
  });

  // A new permanent code; the old one stops working.
  route('POST', '/api/servers/:id/invite-code', ({ user, params }) => {
    const serverId = Number(params[0]);
    allowed(serverId, user, 'invites');
    db.prepare('UPDATE servers SET invite_code = ? WHERE id = ?').run(newInviteCode(), serverId);
    audit(serverId, user.id, 'invite_reset', null);
    sendServerUpdate(serverId);
    return serverSummary(serverId, user.id);
  });

  // What an invite link opens, shown before joining. Anyone with the link can see this much.
  route(
    'GET',
    '/api/invites/:code',
    ({ params, ip }) => {
      checkTries([`invite:${ip}`], 60);
      let target;
      try {
        target = inviteTarget(params[0]);
      } catch (err) {
        failedTry([`invite:${ip}`]);
        throw err;
      }
      const s = db
        .prepare(
          `SELECT name, description,
                  CASE WHEN icon IS NULL THEN NULL ELSE '/api/burrow-pictures/' || icon END AS icon,
                  CASE WHEN banner IS NULL THEN NULL ELSE '/api/burrow-pictures/' || banner END AS banner
           FROM servers WHERE id = ?`,
        )
        .get(target.serverId) as Json;
      const ids = serverMemberIds(target.serverId);
      return { ...s, members: ids.length, online: ids.filter((id) => online.has(id)).length };
    },
    false,
  );

  // ---- events: game nights and the like, with RSVPs and a reminder ----

  const EVENT_REMIND_MS = 15 * 60_000;
  /** Upcoming events in a burrow, and ones that started in the last few hours. */
  const eventsIn = (serverId: number, viewerId: number) => {
    const rows = db
      .prepare(
        `SELECT id, title, details, starts_at AS startsAt, channel_id AS channelId, created_by AS createdBy FROM events
         WHERE server_id = ? AND starts_at > ? ORDER BY starts_at LIMIT 50`,
      )
      .all(serverId, now() - 3 * 3600_000) as Json[];
    return rows
      .filter((e) => {
        const c = e.channelId === null ? null : channelById(e.channelId as number);
        if (c && !canSee(c, viewerId)) return false;
        if (!c) e.channelId = null;
        return true;
      })
      .map((e) => ({
        ...e,
        rsvps: db.prepare('SELECT user_id AS userId, status FROM event_rsvps WHERE event_id = ?').all(e.id as number),
      }));
  };
  const eventById = (id: number) =>
    db.prepare('SELECT id, server_id AS serverId, created_by AS createdBy, starts_at AS startsAt, title FROM events WHERE id = ?').get(id) as
      | { id: number; serverId: number; createdBy: number | null; startsAt: number; title: string }
      | undefined;
  const cleanEvent = (serverId: number, user: User, body: Json, partial = false) => {
    const out: Json = {};
    if (!partial || body.title !== undefined) out.title = cleanName(body.title, 'Event name', 100);
    if (!partial || body.details !== undefined) {
      const details = typeof body.details === 'string' ? body.details.trim() : '';
      if (details.length > 1000) throw new HttpError(400, 'The details can be at most 1000 characters');
      out.details = details;
    }
    if (!partial || body.startsAt !== undefined) {
      const t = Math.floor(Number(body.startsAt));
      if (!(t > now() - 60_000 && t < now() + 366 * 86400_000)) throw new HttpError(400, 'Pick a time in the next year');
      out.starts_at = t;
      out.reminded = t - EVENT_REMIND_MS <= now() ? 1 : 0;
    }
    if (!partial || body.channelId !== undefined) {
      const c = body.channelId == null ? null : channelById(Number(body.channelId));
      if (c && (c.serverId !== serverId || !canSee(c, user.id))) throw new HttpError(400, "That room isn't in this hearth");
      out.channel_id = c?.id ?? null;
    }
    return out;
  };
  /** The event, if you made it or can edit the burrow. */
  const ownEvent = (id: number, user: User) => {
    const e = eventById(id);
    if (!e || !isMember(e.serverId, user.id)) throw new HttpError(404, 'Event not found');
    if (e.createdBy !== user.id) allowed(e.serverId, user, 'burrow');
    return e;
  };

  route('POST', '/api/servers/:id/events', ({ user, params, body }) => {
    const serverId = Number(params[0]);
    const kind = (db.prepare('SELECT kind FROM servers WHERE id = ?').get(serverId) as { kind: string } | undefined)?.kind;
    if (kind !== 'burrow' || !isMember(serverId, user.id)) throw new HttpError(404, 'Hearth not found');
    const upcoming = (db.prepare('SELECT COUNT(*) AS n FROM events WHERE server_id = ? AND starts_at > ?').get(serverId, now()) as { n: number }).n;
    if (upcoming >= 50) throw new HttpError(400, 'This hearth has 50 events coming up already');
    const e = cleanEvent(serverId, user, body);
    const r = db
      .prepare('INSERT INTO events (server_id, channel_id, title, details, starts_at, created_by, created_at, reminded) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(serverId, e.channel_id as number | null, e.title as string, e.details as string, e.starts_at as number, user.id, now(), e.reminded as number);
    // Whoever plans it is going.
    db.prepare("INSERT INTO event_rsvps (event_id, user_id, status) VALUES (?, ?, 'going')").run(Number(r.lastInsertRowid), user.id);
    wakeAt((e.starts_at as number) - EVENT_REMIND_MS);
    sendServerUpdate(serverId);
    return serverSummary(serverId, user.id);
  });

  route('PATCH', '/api/events/:id', ({ user, params, body }) => {
    const ev = ownEvent(Number(params[0]), user);
    const e = cleanEvent(ev.serverId, user, body, true);
    for (const [col, value] of Object.entries(e)) db.prepare(`UPDATE events SET ${col} = ? WHERE id = ?`).run(value as string | number | null, ev.id);
    if (e.starts_at) wakeAt((e.starts_at as number) - EVENT_REMIND_MS);
    sendServerUpdate(ev.serverId);
    return serverSummary(ev.serverId, user.id);
  });

  route('DELETE', '/api/events/:id', ({ user, params }) => {
    const ev = ownEvent(Number(params[0]), user);
    db.prepare('DELETE FROM events WHERE id = ?').run(ev.id);
    sendServerUpdate(ev.serverId);
    return serverSummary(ev.serverId, user.id);
  });

  // Going, maybe, or not going (null takes your answer back).
  route('POST', '/api/events/:id/rsvp', ({ user, params, body }) => {
    const ev = eventById(Number(params[0]));
    if (!ev || !isMember(ev.serverId, user.id)) throw new HttpError(404, 'Event not found');
    if (['going', 'maybe', 'no'].includes(body.status as string))
      db.prepare(
        `INSERT INTO event_rsvps (event_id, user_id, status) VALUES (?, ?, ?)
         ON CONFLICT (event_id, user_id) DO UPDATE SET status = excluded.status`,
      ).run(ev.id, user.id, body.status as string);
    else db.prepare('DELETE FROM event_rsvps WHERE event_id = ? AND user_id = ?').run(ev.id, user.id);
    sendServerUpdate(ev.serverId);
    return serverSummary(ev.serverId, user.id);
  });

  /** Tells the people going (or maybe going) that an event starts soon. */
  const remindEvents = () => {
    const due = db
      .prepare('SELECT id, server_id, title, starts_at, channel_id FROM events WHERE reminded = 0 AND starts_at - ? <= ? AND starts_at > ?')
      .all(EVENT_REMIND_MS, now(), now() - 3600_000) as { id: number; server_id: number; title: string; starts_at: number; channel_id: number | null }[];
    for (const e of due) {
      db.prepare('UPDATE events SET reminded = 1 WHERE id = ?').run(e.id);
      const people = (db.prepare("SELECT user_id FROM event_rsvps WHERE event_id = ? AND status IN ('going', 'maybe')").all(e.id) as { user_id: number }[])
        .map((r) => r.user_id)
        .filter((id) => isMember(e.server_id, id));
      sendTo(people, { type: 'event_reminder', serverId: e.server_id, event: { id: e.id, title: e.title, startsAt: e.starts_at, channelId: e.channel_id } });
    }
  };

  // ---- folders of burrows: your own grouping in the burrow list ----

  const foldersOf = (userId: number) => {
    const raw = (db.prepare('SELECT burrow_folders FROM users WHERE id = ?').get(userId) as { burrow_folders: string } | undefined)?.burrow_folders;
    try {
      return JSON.parse(raw ?? '[]') as { id: string; name: string; serverIds: number[] }[];
    } catch {
      return [];
    }
  };

  /** Replaces your folders. Each burrow sits in one folder at most, and only burrows you're in count. */
  route('POST', '/api/me/folders', ({ user, body }) => {
    if (!Array.isArray(body.folders)) throw new HttpError(400, 'folders must be a list');
    if (body.folders.length > MAX_FOLDERS) throw new HttpError(400, `You can have up to ${MAX_FOLDERS} folders`);
    const mine = new Set(
      (db.prepare("SELECT m.server_id AS id FROM members m JOIN servers s ON s.id = m.server_id WHERE m.user_id = ? AND s.kind = 'burrow'").all(user.id) as { id: number }[]).map((r) => r.id),
    );
    const used = new Set<number>();
    const folders = (body.folders as Json[]).map((f, i) => ({
      id: typeof f?.id === 'string' && /^[\w-]{1,24}$/.test(f.id) ? f.id : `f${now().toString(36)}${i}`,
      name: cleanName(f?.name, 'Folder name', 32),
      serverIds: (Array.isArray(f?.serverIds) ? f.serverIds.map(Number) : []).filter((id: number) => mine.has(id) && !used.has(id) && used.add(id)),
    }));
    db.prepare('UPDATE users SET burrow_folders = ? WHERE id = ?').run(JSON.stringify(folders), user.id);
    sendTo([user.id], { type: 'folders', folders }); // your other devices
    return { folders };
  });

  // ---- the clock: scheduled messages, reminders and polls closing ----

  let wakeTimer: ReturnType<typeof setTimeout> | null = null;
  let wakeTime = Infinity;
  /** Makes sure the clock goes off by time t. */
  const wakeAt = (t: number) => {
    if (t >= wakeTime) return;
    if (wakeTimer) clearTimeout(wakeTimer);
    wakeTime = t;
    // Timers can't wait more than about 24 days; an hourly check is plenty for anything further off.
    wakeTimer = setTimeout(tick, Math.max(0, Math.min(t - now(), 3600_000)));
    wakeTimer.unref();
  };
  const nextDue = () =>
    (db
      .prepare(
        `SELECT MIN(t) AS t FROM (
           SELECT MIN(send_at) AS t FROM scheduled_messages
           UNION ALL SELECT MIN(remind_at) FROM saved_messages WHERE reminded = 0 AND remind_at > ?
           UNION ALL SELECT MIN(closes_at) FROM polls WHERE ended = 0
           UNION ALL SELECT MIN(starts_at) - ? FROM events WHERE reminded = 0 AND starts_at > ?)`,
      )
      .get(now(), EVENT_REMIND_MS, now()) as { t: number | null }).t;
  const tick = () => {
    wakeTimer = null;
    wakeTime = Infinity;
    try {
      sendScheduled();
      deliverReminders();
      endPolls();
      remindEvents();
    } catch (err) {
      console.error(err);
    } finally {
      const next = nextDue();
      if (next !== null) wakeAt(next);
    }
  };
  {
    const next = nextDue();
    if (next !== null) wakeAt(next);
  }

  // ---- profiles: names, about-me cards and nicknames ----------------------

  const MAX_BIO = 190;
  const profileOf = (userId: number) => {
    const r = db.prepare('SELECT display_name, bio, banner, accent, created_at FROM users WHERE id = ?').get(userId) as
      | { display_name: string | null; bio: string; banner: string | null; accent: string | null; created_at: number }
      | undefined;
    return {
      displayName: r?.display_name ?? null,
      bio: r?.bio ?? '',
      banner: r?.banner ? `/api/avatars/${r.banner}` : null,
      accent: r?.accent ?? null,
      joinedAt: r?.created_at ?? null,
    };
  };

  /** Tells everyone who can see this person that their name, picture or card changed. */
  const userChanged = (userId: number) => {
    const u = userById(userId)!;
    const p = profileOf(userId);
    const updated = { ...u, accent: p.accent };
    sendTo(new Set([userId, ...usersSharingServerWith(userId), ...friendIds(userId), ...pendingIds(userId)]), { type: 'user_updated', user: updated });
    sendTo([userId], { type: 'me_updated', me: meJson(u) });
    return updated;
  };

  /** Display name, bio and accent colour, from PATCH /api/me. */
  const updateProfile = (user: User, body: Json) => {
    let changed = false;
    if (body.displayName !== undefined) {
      const name = typeof body.displayName === 'string' ? body.displayName.replace(/\s+/g, ' ').trim() : '';
      if (name.length > 32) throw new HttpError(400, 'Keep your display name to 32 characters');
      db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name || null, user.id);
      changed = true;
    }
    if (body.bio !== undefined) {
      const bio = typeof body.bio === 'string' ? body.bio.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim() : '';
      if (bio.length > MAX_BIO) throw new HttpError(400, `Keep your about me to ${MAX_BIO} characters`);
      db.prepare('UPDATE users SET bio = ? WHERE id = ?').run(bio, user.id);
      changed = true;
    }
    if (body.accent !== undefined) {
      db.prepare('UPDATE users SET accent = ? WHERE id = ?').run(body.accent === null ? null : cleanColor(body.accent), user.id);
      changed = true;
    }
    if (changed) userChanged(user.id);
  };

  const setBannerFile = (user: User, file: string | null) => {
    const old = db.prepare('SELECT banner FROM users WHERE id = ?').get(user.id) as { banner: string | null };
    db.prepare('UPDATE users SET banner = ? WHERE id = ?').run(file, user.id);
    if (old.banner && opts.uploadDir) unlink(avatarPath(old.banner)).catch(() => {});
    userChanged(user.id);
    return meJson(user);
  };
  const handleBannerUpload = async (req: IncomingMessage, res: ServerResponse) => {
    const user = pictureUploader(req);
    send(res, 200, setBannerFile(user, await savePicture(req, 'avatars', 'Banners')));
  };
  route('DELETE', '/api/me/banner', ({ user }) => setBannerFile(user, null));

  /** Someone's card: who they are, what you share, and whether you're friends. */
  route('GET', '/api/users/:id', ({ user, params }) => {
    const id = Number(params[0]);
    const u = userById(id);
    const knows = id === user.id || usersSharingServerWith(user.id).includes(id) || friendRow(user.id, id);
    if (!u || !knows) throw new HttpError(404, 'Person not found');
    const mutual = db
      .prepare(
        `SELECT s.id, s.name FROM members a JOIN members b ON a.server_id = b.server_id JOIN servers s ON s.id = a.server_id
         WHERE a.user_id = ? AND b.user_id = ? AND s.kind = 'burrow' ORDER BY s.name`,
      )
      .all(user.id, id);
    const deleted = !!(db.prepare('SELECT deleted_at FROM users WHERE id = ?').get(id) as { deleted_at: number | null }).deleted_at;
    return { ...u, ...profileOf(id), deleted, friend: friendState(user.id, id), blocked: blocked(user.id, id), mutualBurrows: id === user.id ? [] : mutual };
  });

  // Your name in one burrow. Empty goes back to your display name.
  route('PATCH', '/api/servers/:id/nickname', ({ user, params, body }) => {
    const serverId = Number(params[0]);
    if (!isBurrow(serverId) || !isMember(serverId, user.id)) throw new HttpError(404, 'Hearth not found');
    const nick = typeof body.nickname === 'string' ? body.nickname.replace(/\s+/g, ' ').trim() : '';
    if (nick.length > 32) throw new HttpError(400, 'Keep your nickname to 32 characters');
    db.prepare('UPDATE members SET nickname = ? WHERE server_id = ? AND user_id = ?').run(nick || null, serverId, user.id);
    sendServerUpdate(serverId);
    return serverSummary(serverId, user.id);
  });

  // ---- friends and blocking -----------------------------------------------

  const pair = (a: number, b: number) => (a < b ? [a, b] : [b, a]);
  type FriendRow = { requested_by: number; accepted_at: number | null };
  const friendRow = (a: number, b: number) =>
    db.prepare('SELECT requested_by, accepted_at FROM friends WHERE user_a = ? AND user_b = ?').get(...pair(a, b)) as FriendRow | undefined;
  /** 'friends', 'incoming' (they asked you), 'outgoing' (you asked them) or null. */
  const friendState = (me: number, other: number) => {
    const r = friendRow(me, other);
    return !r ? null : r.accepted_at ? 'friends' : r.requested_by === me ? 'outgoing' : 'incoming';
  };
  const areFriends = (a: number, b: number) => !!friendRow(a, b)?.accepted_at;
  const friendIds = (userId: number) =>
    (
      db
        .prepare('SELECT CASE WHEN user_a = ? THEN user_b ELSE user_a END AS id FROM friends WHERE (user_a = ? OR user_b = ?) AND accepted_at IS NOT NULL')
        .all(userId, userId, userId) as { id: number }[]
    ).map((r) => r.id);
  const pendingIds = (userId: number) =>
    (
      db
        .prepare('SELECT CASE WHEN user_a = ? THEN user_b ELSE user_a END AS id FROM friends WHERE (user_a = ? OR user_b = ?) AND accepted_at IS NULL')
        .all(userId, userId, userId) as { id: number }[]
    ).map((r) => r.id);
  /** Whether `viewer` has blocked `other`. */
  const blocked = (viewer: number, other: number) => !!db.prepare('SELECT 1 FROM blocks WHERE user_id = ? AND blocked_id = ?').get(viewer, other);
  const blockedEitherWay = (a: number, b: number) => blocked(a, b) || blocked(b, a);
  const blockedBy = (userId: number) =>
    (db.prepare('SELECT blocked_id AS id FROM blocks WHERE user_id = ? ORDER BY created_at').all(userId) as { id: number }[]).map((r) => r.id);
  /** A one-to-one conversation stops when either person blocks the other, or the other deleted their account. */
  const dmBlockCheck = (serverId: number, userId: number) => {
    const s = db.prepare("SELECT dm_key FROM servers WHERE id = ? AND kind = 'dm'").get(serverId) as { dm_key: string | null } | undefined;
    if (!s?.dm_key) return;
    const other = s.dm_key.split(':').map(Number).find((id) => id !== userId);
    if (other === undefined) return;
    if (blockedEitherWay(userId, other)) throw new HttpError(403, "You can't message this person");
    if ((db.prepare('SELECT deleted_at FROM users WHERE id = ?').get(other) as { deleted_at: number | null } | undefined)?.deleted_at)
      throw new HttpError(403, 'This account was deleted');
  };

  const personJson = (id: number) => {
    const u = userById(id)!;
    return { ...u, online: online.has(id), ...presenceOf(id) };
  };
  /** Your friends (with who's online), requests both ways, and the people you've blocked. */
  const friendsOf = (userId: number) => {
    const rows = db
      .prepare('SELECT user_a, user_b, requested_by, accepted_at FROM friends WHERE user_a = ? OR user_b = ? ORDER BY COALESCE(accepted_at, created_at) DESC')
      .all(userId, userId) as (FriendRow & { user_a: number; user_b: number })[];
    const other = (r: { user_a: number; user_b: number }) => (r.user_a === userId ? r.user_b : r.user_a);
    return {
      friends: rows.filter((r) => r.accepted_at).map((r) => personJson(other(r))),
      incoming: rows.filter((r) => !r.accepted_at && r.requested_by !== userId).map((r) => personJson(other(r))),
      outgoing: rows.filter((r) => !r.accepted_at && r.requested_by === userId).map((r) => personJson(other(r))),
      blocked: blockedBy(userId).map((id) => userById(id)!).filter(Boolean),
    };
  };
  const friendsChanged = (...ids: number[]) => {
    for (const id of ids) sendTo([id], { type: 'friends', ...friendsOf(id) });
  };

  route('GET', '/api/friends', ({ user }) => friendsOf(user.id));

  // Asks someone to be friends, by username or id. If they already asked you, you're friends.
  route('POST', '/api/friends', ({ user, body }) => {
    notBot(user);
    checkTries([`friend:${user.id}`], 30);
    failedTry([`friend:${user.id}`], 60 * 60 * 1000); // every request counts, so nobody is flooded
    const target = (
      body.userId != null
        ? db.prepare('SELECT id FROM users WHERE id = ? AND deleted_at IS NULL').get(Number(body.userId))
        : db.prepare('SELECT id FROM users WHERE username = ? AND deleted_at IS NULL').get(String(body.username ?? '').trim().replace(/^@/, ''))
    ) as { id: number } | undefined;
    if (target?.id === user.id) throw new HttpError(400, "You can't add yourself");
    // The same answer for nobody and for someone who blocked you.
    if (!target || blocked(target.id, user.id)) throw new HttpError(404, "Couldn't find anyone with that username");
    if (blocked(user.id, target.id)) throw new HttpError(400, 'Unblock them first');
    const r = friendRow(user.id, target.id);
    if (r?.accepted_at) return friendsOf(user.id);
    if (r && r.requested_by !== user.id) {
      db.prepare('UPDATE friends SET accepted_at = ? WHERE user_a = ? AND user_b = ?').run(now(), ...pair(user.id, target.id));
    } else if (!r) {
      const [a, b] = pair(user.id, target.id);
      db.prepare('INSERT INTO friends (user_a, user_b, requested_by, created_at) VALUES (?, ?, ?, ?)').run(a, b, user.id, now());
      pushTo(target.id, { title: 'Friend request', body: `${user.displayName || user.username} wants to be friends`, tag: `friend-${user.id}` });
    }
    friendsChanged(user.id, target.id);
    return friendsOf(user.id);
  });

  route('POST', '/api/friends/:id/accept', ({ user, params }) => {
    const other = Number(params[0]);
    const r = friendRow(user.id, other);
    if (!r || r.requested_by === user.id) throw new HttpError(404, 'No friend request from them');
    if (!r.accepted_at) db.prepare('UPDATE friends SET accepted_at = ? WHERE user_a = ? AND user_b = ?').run(now(), ...pair(user.id, other));
    friendsChanged(user.id, other);
    sendPresence(user.id);
    sendPresence(other);
    return friendsOf(user.id);
  });

  // Unfriends, declines a request, or takes back one you sent.
  route('DELETE', '/api/friends/:id', ({ user, params }) => {
    const other = Number(params[0]);
    db.prepare('DELETE FROM friends WHERE user_a = ? AND user_b = ?').run(...pair(user.id, other));
    friendsChanged(user.id, other);
    return friendsOf(user.id);
  });

  route('POST', '/api/blocks', ({ user, body }) => {
    const other = Number(body.userId);
    if (other === user.id) throw new HttpError(400, "You can't block yourself");
    if (!userById(other)) throw new HttpError(404, 'Person not found');
    db.prepare('INSERT OR IGNORE INTO blocks (user_id, blocked_id, created_at) VALUES (?, ?, ?)').run(user.id, other, now());
    db.prepare('DELETE FROM friends WHERE user_a = ? AND user_b = ?').run(...pair(user.id, other));
    friendsChanged(user.id, other);
    sendTo([user.id], { type: 'me_updated', me: meJson(user) });
    return meJson(user);
  });

  route('DELETE', '/api/blocks/:id', ({ user, params }) => {
    db.prepare('DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?').run(user.id, Number(params[0]));
    friendsChanged(user.id);
    sendTo([user.id], { type: 'me_updated', me: meJson(user) });
    return meJson(user);
  });

  // ---- your login: username, devices, two-step login, passkeys ------------

  /** Checks your password (and with two-step login on, a code) before something big. */
  const confirmIdentity = (user: User, body: Json, { needCode = true } = {}) => {
    const key = `confirm-user:${user.id}`;
    checkTries([key], 10);
    const row = db.prepare('SELECT password_hash, totp_secret FROM users WHERE id = ?').get(user.id) as { password_hash: string; totp_secret: string | null };
    if (!verifyPassword(String(body.password ?? ''), row.password_hash)) {
      failedTry([key]);
      throw new HttpError(403, 'Your password is wrong');
    }
    if (needCode && row.totp_secret && !useSecondFactor(user.id, String(body.code ?? ''))) {
      failedTry([key]);
      throw new HttpError(403, 'That code from your authenticator app isn\'t right');
    }
    clearTries(key);
  };

  /** Signs a person out everywhere (but this login, if given) and closes those connections. */
  const signOutOthers = (userId: number, keepToken: string | null, reason: string) => {
    if (keepToken) db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(userId, keepToken);
    else db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    for (const ws of sockets.get(userId) ?? []) if (socketTokens.get(ws) !== keepToken) ws.close(4001, reason);
  };

  route('POST', '/api/me/username', ({ user, body }) => {
    confirmIdentity(user, body);
    const username = cleanName(body.username, 'Username', 32);
    if (!/^[\w.-]+$/.test(username)) throw new HttpError(400, 'Username may only use letters, numbers, _ . -');
    const taken = db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number } | undefined;
    if (taken && taken.id !== user.id) throw new HttpError(409, 'That username is taken');
    db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, user.id);
    return userChanged(user.id);
  });

  const sessionId = (token: string) => createHash('sha256').update(token).digest('hex').slice(0, 16);
  /** "Chrome on Windows", "Burrow app on Mac" and so on, from a user agent. */
  const deviceName = (ua: string | null) => {
    if (!ua) return 'Unknown device';
    const os = /iPhone|iPad/.test(ua) ? (/iPad/.test(ua) ? 'iPad' : 'iPhone') : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
    const app = /Electron|Burrow\//.test(ua) ? 'Peiskos app' : /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /node/i.test(ua) ? 'Script' : 'Browser';
    return os ? `${app} on ${os}` : app;
  };
  route('GET', '/api/me/sessions', ({ user, token }) =>
    (
      db.prepare('SELECT token, created_at, last_used_at, device, ip FROM sessions WHERE user_id = ? ORDER BY COALESCE(last_used_at, created_at) DESC').all(user.id) as
        { token: string; created_at: number; last_used_at: number | null; device: string | null; ip: string | null }[]
    ).map((s) => ({
      id: sessionId(s.token),
      device: deviceName(s.device),
      ip: s.ip,
      createdAt: s.created_at,
      lastUsedAt: s.last_used_at ?? s.created_at,
      current: s.token === token,
      online: [...(sockets.get(user.id) ?? [])].some((ws) => socketTokens.get(ws) === s.token),
    })),
  );
  route('DELETE', '/api/me/sessions/:code', ({ user, params, token }) => {
    const all = db.prepare('SELECT token FROM sessions WHERE user_id = ?').all(user.id) as { token: string }[];
    const s = all.find((x) => sessionId(x.token) === params[0]);
    if (!s) throw new HttpError(404, 'That device is already signed out');
    if (s.token === token) throw new HttpError(400, 'Use Log out to sign out of this device');
    db.prepare('DELETE FROM sessions WHERE token = ?').run(s.token);
    for (const ws of sockets.get(user.id) ?? []) if (socketTokens.get(ws) === s.token) ws.close(4001, 'Signed out');
    return { ok: true };
  });
  route('DELETE', '/api/me/sessions', ({ user, token }) => {
    signOutOthers(user.id, token ?? null, 'Signed out');
    return { ok: true };
  });

  // Two-step login. Turning it on is a choice; nobody has to.
  const twoStepTickets = new Map<string, { userId: number; until: number; tries: number; from: { ip: string; ua: string } }>();
  /** A login that's passed the password: straight in, or (with two-step login on) a ticket to swap for one with a code. */
  const loginOrAskCode = (userId: number, from: { ip: string; ua: string }) => {
    const row = db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(userId) as { totp_secret: string | null };
    if (!row.totp_secret) return startSession(userById(userId)!, from);
    const t = now();
    for (const [k, v] of twoStepTickets) if (v.until < t) twoStepTickets.delete(k);
    const ticket = newToken();
    twoStepTickets.set(ticket, { userId, until: t + 5 * 60 * 1000, tries: 0, from });
    return { twoStep: true, ticket };
  };
  /** A code from the authenticator app (used at most once) or one of the recovery codes (then gone). */
  const useSecondFactor = (userId: number, code: string) => {
    const r = db.prepare('SELECT totp_secret, totp_last_step, recovery_codes FROM users WHERE id = ?').get(userId) as
      { totp_secret: string | null; totp_last_step: number; recovery_codes: string };
    if (!r.totp_secret) return true;
    const step = checkTotp(r.totp_secret, code, r.totp_last_step, now());
    if (step !== null) {
      db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, userId);
      return true;
    }
    const codes = JSON.parse(r.recovery_codes) as string[];
    const i = code.trim() ? codes.indexOf(hashRecovery(code)) : -1;
    if (i < 0) return false;
    codes.splice(i, 1);
    db.prepare('UPDATE users SET recovery_codes = ? WHERE id = ?').run(JSON.stringify(codes), userId);
    return true;
  };
  route(
    'POST',
    '/api/login/two-step',
    ({ body, ip }) => {
      checkTries([`two-step-ip:${ip}`], 20);
      const ticket = twoStepTickets.get(String(body.ticket ?? ''));
      if (!ticket || ticket.until < now()) throw new HttpError(400, 'That took too long. Log in again.');
      checkTries([`two-step-user:${ticket.userId}`], 10);
      if (!useSecondFactor(ticket.userId, String(body.code ?? ''))) {
        failedTry([`two-step-ip:${ip}`, `two-step-user:${ticket.userId}`]);
        if (++ticket.tries >= 5) twoStepTickets.delete(String(body.ticket));
        throw new HttpError(401, ticket.tries >= 5 ? 'Too many wrong codes. Log in again.' : "That code isn't right");
      }
      twoStepTickets.delete(String(body.ticket));
      clearTries(`two-step-user:${ticket.userId}`);
      return startSession(userById(ticket.userId)!, ticket.from);
    },
    false,
  );
  // Setting it up: a secret for the authenticator app (shown as a QR code), then a code to prove it works.
  route('POST', '/api/me/two-step/setup', ({ user, body }) => {
    confirmIdentity(user, body, { needCode: false });
    const secret = newTotpSecret();
    db.prepare('UPDATE users SET totp_pending = ? WHERE id = ?').run(secret, user.id);
    const label = encodeURIComponent(`Peiskos:${user.username}`);
    return { secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=Peiskos&digits=6&period=30` };
  });
  route('POST', '/api/me/two-step/enable', ({ user, body }) => {
    const r = db.prepare('SELECT totp_pending FROM users WHERE id = ?').get(user.id) as { totp_pending: string | null };
    if (!r.totp_pending) throw new HttpError(400, 'Start again from the beginning');
    checkTries([`two-step-setup:${user.id}`], 10);
    const step = checkTotp(r.totp_pending, String(body.code ?? ''), -1, now());
    if (step === null) {
      failedTry([`two-step-setup:${user.id}`]);
      throw new HttpError(400, "That code isn't right. Check the time on your phone, and try the newest code.");
    }
    const codes = newRecoveryCodes();
    db.prepare('UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_last_step = ?, recovery_codes = ? WHERE id = ?').run(
      step, JSON.stringify(codes.map(hashRecovery)), user.id,
    );
    sendTo([user.id], { type: 'me_updated', me: meJson(user) });
    return { recoveryCodes: codes, me: meJson(user) };
  });
  route('POST', '/api/me/two-step/disable', ({ user, body }) => {
    confirmIdentity(user, body);
    db.prepare("UPDATE users SET totp_secret = NULL, totp_pending = NULL, recovery_codes = '[]' WHERE id = ?").run(user.id);
    sendTo([user.id], { type: 'me_updated', me: meJson(user) });
    return meJson(user);
  });
  route('POST', '/api/me/two-step/recovery', ({ user, body }) => {
    confirmIdentity(user, body);
    const codes = newRecoveryCodes();
    db.prepare('UPDATE users SET recovery_codes = ? WHERE id = ? AND totp_secret IS NOT NULL').run(JSON.stringify(codes.map(hashRecovery)), user.id);
    return { recoveryCodes: codes, me: meJson(user) };
  });

  // Passkeys: Face ID, Windows Hello, a phone or a security key instead of a password.
  // The site name a passkey is tied to: PUBLIC_URL's host, or the host the app was opened at.
  const rpIdFor = (host: string) => {
    if (opts.publicUrl) return new URL(opts.publicUrl).hostname;
    return host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '') || 'localhost';
  };
  const passkeyChallenges = new Map<string, { challenge: string; until: number; userId?: number; rpId: string }>();
  const newChallenge = (key: string, rpId: string, userId?: number) => {
    const t = now();
    for (const [k, v] of passkeyChallenges) if (v.until < t) passkeyChallenges.delete(k);
    const challenge = randomBytes(32).toString('base64url');
    passkeyChallenges.set(key, { challenge, until: t + 5 * 60 * 1000, userId, rpId });
    return challenge;
  };
  const takeChallenge = (key: string) => {
    const c = passkeyChallenges.get(key);
    passkeyChallenges.delete(key);
    if (!c || c.until < now()) throw new HttpError(400, 'That took too long. Try again.');
    return c;
  };
  const passkeysOf = (userId: number) =>
    db.prepare('SELECT id, name, created_at AS createdAt, last_used_at AS lastUsedAt FROM passkeys WHERE user_id = ? ORDER BY created_at').all(userId);

  route('GET', '/api/me/passkeys', ({ user }) => passkeysOf(user.id));
  route('POST', '/api/me/passkeys/options', ({ user, body, host }) => {
    confirmIdentity(user, body);
    const rpId = rpIdFor(host);
    const challenge = newChallenge(`add:${user.id}`, rpId, user.id);
    return {
      challenge,
      rp: { name: 'Peiskos', id: rpId },
      user: { id: Buffer.from(String(user.id)).toString('base64url'), name: user.username, displayName: user.displayName || user.username },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -8 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'preferred' },
      excludeCredentials: (passkeysOf(user.id) as { id: string }[]).map((p) => ({ type: 'public-key', id: p.id })),
      attestation: 'none',
      timeout: 120_000,
    };
  });
  route('POST', '/api/me/passkeys', ({ user, body, ua }) => {
    const c = takeChallenge(`add:${user.id}`);
    const cred = (body.credential ?? {}) as Json;
    const response = (cred.response ?? {}) as Json;
    let key;
    try {
      key = verifyRegistration({ clientDataJSON: String(response.clientDataJSON ?? ''), attestationObject: String(response.attestationObject ?? '') }, c.challenge, c.rpId);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : 'That passkey didn\'t work');
    }
    if (db.prepare('SELECT 1 FROM passkeys WHERE id = ?').get(key.id)) throw new HttpError(409, 'That passkey is already added');
    const name = (typeof body.name === 'string' && body.name.trim().slice(0, 40)) || `Passkey on ${deviceName(ua).replace(/^.* on /, '')}`;
    db.prepare('INSERT INTO passkeys (id, user_id, name, public_key, alg, sign_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      key.id, user.id, name, JSON.stringify(key.jwk), key.alg, key.signCount, now(),
    );
    return passkeysOf(user.id);
  });
  route('DELETE', '/api/me/passkeys/:code', ({ user, params }) => {
    db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').run(params[0], user.id);
    return passkeysOf(user.id);
  });
  route(
    'POST',
    '/api/login/passkey/options',
    ({ ip, host }) => {
      checkTries([`passkey-ip:${ip}`], 30);
      const id = newToken();
      const rpId = rpIdFor(host);
      return { id, challenge: newChallenge(`login:${id}`, rpId), rpId, userVerification: 'preferred', timeout: 120_000 };
    },
    false,
  );
  route(
    'POST',
    '/api/login/passkey',
    ({ body, ip, ua }) => {
      checkTries([`passkey-ip:${ip}`], 30);
      const c = takeChallenge(`login:${String(body.id ?? '')}`);
      const cred = (body.credential ?? {}) as Json;
      const response = (cred.response ?? {}) as Json;
      const key = db.prepare('SELECT p.user_id, p.public_key, p.alg, p.sign_count FROM passkeys p JOIN users u ON u.id = p.user_id WHERE p.id = ? AND u.deleted_at IS NULL').get(String(cred.id ?? '')) as
        | { user_id: number; public_key: string; alg: number; sign_count: number }
        | undefined;
      if (!key) {
        failedTry([`passkey-ip:${ip}`]);
        throw new HttpError(401, "That passkey isn't on this server anymore. Log in with your password.");
      }
      let signCount;
      try {
        ({ signCount } = verifyAssertion(
          { clientDataJSON: String(response.clientDataJSON ?? ''), authenticatorData: String(response.authenticatorData ?? ''), signature: String(response.signature ?? '') },
          { jwk: JSON.parse(key.public_key), alg: key.alg, signCount: key.sign_count },
          c.challenge,
          c.rpId,
        ));
      } catch (err) {
        failedTry([`passkey-ip:${ip}`]);
        throw new HttpError(401, err instanceof Error ? err.message : "That passkey didn't check out");
      }
      db.prepare('UPDATE passkeys SET sign_count = ?, last_used_at = ? WHERE id = ?').run(signCount, now(), String(cred.id));
      // A passkey already proves two things (the device, and the face or PIN that unlocked it).
      return startSession(userById(key.user_id)!, { ip, ua });
    },
    false,
  );

  // A reset link made by whoever runs the server (server/src/reset-link.ts), for someone locked out.
  const resetLinkUser = (token: unknown) => {
    const u = db.prepare('SELECT id, username, reset_link_expires FROM users WHERE reset_link = ? AND deleted_at IS NULL').get(hashCode(String(token ?? ''))) as
      | { id: number; username: string; reset_link_expires: number }
      | undefined;
    if (!u || u.reset_link_expires < now()) throw new HttpError(400, 'That reset link has run out or was already used. Ask whoever runs this server for a new one.');
    return u;
  };
  route('GET', '/api/password/link', ({ url, ip }) => {
    checkTries([`reset-link-ip:${ip}`], 20);
    try { return { username: resetLinkUser(url.searchParams.get('token')).username }; }
    catch (err) { failedTry([`reset-link-ip:${ip}`]); throw err; }
  }, false);
  route('POST', '/api/password/link', ({ body, ip, ua }) => {
    checkTries([`reset-link-ip:${ip}`], 20);
    let u;
    try { u = resetLinkUser(body.token); }
    catch (err) { failedTry([`reset-link-ip:${ip}`]); throw err; }
    if (typeof body.newPassword !== 'string' || body.newPassword.length < 8) throw new HttpError(400, 'New password must be at least 8 characters');
    db.prepare('UPDATE users SET password_hash = ?, reset_link = NULL, reset_link_expires = NULL WHERE id = ?').run(hashPassword(body.newPassword), u.id);
    signOutOthers(u.id, null, 'Password changed');
    clearTries(`login-user:${u.username.toLowerCase()}`);
    return loginOrAskCode(u.id, { ip, ua });
  }, false);

  // ---- leaving for good, and taking your things with you ------------------

  // Deleting your account: burrows you host with other people in them have to be handed over first.
  // Your messages stay (as "Deleted user") or go, as you choose.
  route('DELETE', '/api/me', ({ user, body }) => {
    confirmIdentity(user, body);
    const hosted = db.prepare("SELECT id, name FROM servers WHERE owner_id = ? AND kind = 'burrow'").all(user.id) as { id: number; name: string }[];
    const busy = hosted.filter((s) => serverMemberIds(s.id).some((id) => id !== user.id));
    if (busy.length)
      throw new HttpError(409, `Hand over or delete ${busy.map((s) => s.name).join(', ')} first: you're the host${busy.length > 1 ? ' of those burrows' : ''}.`);
    signOutOthers(user.id, null, 'Account deleted');
    for (const s of hosted) deleteBurrow(s.id);
    const places = db.prepare('SELECT m.server_id AS id, s.kind, s.dm_key FROM members m JOIN servers s ON s.id = m.server_id WHERE m.user_id = ?').all(user.id) as
      { id: number; kind: string; dm_key: string | null }[];
    if (body.deleteMessages === true) {
      const touched = db.prepare('SELECT DISTINCT channel_id AS id FROM messages WHERE author_id = ?').all(user.id) as { id: number }[];
      removeFiles(db.prepare('SELECT a.id FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.author_id = ?').all(user.id) as Json[]);
      db.prepare('DELETE FROM messages WHERE author_id = ?').run(user.id);
      for (const { id } of touched) {
        const channel = channelById(id);
        if (channel) broadcastToChannel(channel, { type: 'messages_purged', channelId: id, userId: user.id });
      }
    }
    // Out of every burrow and group. One-to-one conversations stay, so the other person keeps theirs.
    for (const p of places) {
      if (p.kind === 'burrow') removeMember(p.id, user.id);
      else if (!p.dm_key) leaveGroup(p.id, user);
    }
    const files = db.prepare('SELECT avatar, banner FROM users WHERE id = ?').get(user.id) as { avatar: string | null; banner: string | null };
    for (const f of [files.avatar, files.banner]) if (f && opts.uploadDir) unlink(avatarPath(f)).catch(() => {});
    for (const table of ['friends_a', 'friends_b', 'blocks', 'blocks_by', 'passkeys', 'push_subs', 'scheduled_messages', 'saved_messages']) {
      const [t, col] =
        table === 'friends_a' ? ['friends', 'user_a'] : table === 'friends_b' ? ['friends', 'user_b'] : table === 'blocks_by' ? ['blocks', 'blocked_id'] : [table, 'user_id'];
      try { db.prepare(`DELETE FROM ${t} WHERE ${col} = ?`).run(user.id); } catch { /* a table this server doesn't have */ }
    }
    db.prepare(
      `UPDATE users SET username = ?, display_name = 'Deleted user', password_hash = '!', avatar = NULL, banner = NULL, bio = '', accent = NULL,
         email = NULL, email_verified = 0, email_code = NULL, reset_code = NULL, reset_link = NULL, totp_secret = NULL, totp_pending = NULL,
         recovery_codes = '[]', status_text = NULL, status_emoji = NULL, deleted_at = ? WHERE id = ?`,
    ).run(`deleted-${user.id}-${randomBytes(4).toString('hex')}`, now(), user.id);
    for (const p of places) if (p.kind === 'dm' && p.dm_key) sendServerUpdate(p.id);
    userChanged(user.id);
    return { ok: true };
  });

  // Export my data: a zip of your account, your messages (as JSON) and the files you sent.
  const handleExport = async (req: IncomingMessage, res: ServerResponse) => {
    const user = userByToken(req.headers.authorization?.replace(/^Bearer /, ''));
    if (!user) throw new HttpError(401, 'Not logged in');
    checkTries([`export:${user.id}`], 5);
    failedTry([`export:${user.id}`], 60 * 60 * 1000);
    const me = meJson(user);
    const burrows = db.prepare("SELECT s.id, s.name, m.joined_at AS joinedAt, m.nickname FROM members m JOIN servers s ON s.id = m.server_id WHERE m.user_id = ? AND s.kind = 'burrow'").all(user.id);
    const messages = (
      db
        .prepare(
          `SELECT m.id, m.channel_id AS channelId, m.content, m.created_at AS createdAt, m.edited_at AS editedAt, m.reply_to AS replyTo, c.name AS room, s.name AS burrow, s.kind
           FROM messages m JOIN channels c ON c.id = m.channel_id JOIN servers s ON s.id = c.server_id WHERE m.author_id = ? ORDER BY m.id`,
        )
        .all(user.id) as Json[]
    ).map(({ kind, burrow, room, ...m }) => ({ ...m, id: m.id as number, place: kind === 'dm' ? placeOf(m.channelId as number, user.id)?.serverName ?? 'Direct message' : `${burrow} › #${room}` }));
    const files = db
      .prepare('SELECT a.id, a.name, a.type, a.size, a.message_id AS messageId FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.author_id = ? ORDER BY a.message_id, a.position')
      .all(user.id) as { id: string; name: string; type: string; size: number; messageId: number }[];
    const safe = (name: string) => name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(-120);
    const fileName = (f: { id: string; name: string }) => `files/${f.id.slice(0, 8)}-${safe(f.name)}`;
    const byMessage = new Map<number, string[]>();
    for (const f of files) byMessage.set(f.messageId, [...(byMessage.get(f.messageId) ?? []), fileName(f)]);
    const zip = new ZipWriter();
    res.writeHead(200, {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="burrow-${safe(user.username)}.zip"`,
      'cache-control': 'no-store',
    });
    const write = async (chunks: Buffer[]) => {
      for (const c of chunks) if (!res.write(c)) await new Promise((r) => res.once('drain', r));
    };
    try {
      const json = (v: unknown) => Buffer.from(JSON.stringify(v, null, 2));
      const { id: _, blockedIds: __, ...account } = me;
      await write(zip.add('account.json', json({ ...account, burrows, friends: friendsOf(user.id).friends.map((f) => f.username), exportedAt: new Date().toISOString() })));
      await write(zip.add('messages.json', json(messages.map((m) => ({ ...m, files: byMessage.get(m.id as number) ?? [] })))));
      const pictures = db.prepare('SELECT avatar, banner FROM users WHERE id = ?').get(user.id) as { avatar: string | null; banner: string | null };
      let total = 0;
      const LIMIT = 3.5 * 1024 ** 3; // a plain zip can't go past 4 GB
      const skipped: string[] = [];
      const addFile = async (path: string, name: string) => {
        const data = await readFile(path).catch(() => null);
        if (!data) return;
        if (total + data.length > LIMIT) return void skipped.push(name);
        total += data.length;
        await write(zip.add(name, data));
      };
      if (opts.uploadDir) {
        if (pictures.avatar) await addFile(avatarPath(pictures.avatar), `profile/picture${extname(pictures.avatar)}`);
        if (pictures.banner) await addFile(avatarPath(pictures.banner), `profile/banner${extname(pictures.banner)}`);
        for (const f of files) await addFile(filePath(f.id), fileName(f));
      }
      if (skipped.length) await write(zip.add('files-left-out.txt', Buffer.from(`These files didn't fit in one zip:\n${skipped.join('\n')}\n`)));
      res.end(zip.finish());
    } catch (err) {
      // Too late for an error message once the download has started, so cut it off.
      console.error('Export failed:', err);
      res.destroy();
    }
  };

  // ---- HTTP plumbing ------------------------------------------------------

  const readBody = (req: IncomingMessage) =>
    new Promise<Json>((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > 1_000_000) reject(new HttpError(413, 'Body too large'));
        else chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(parsed && typeof parsed === 'object' ? parsed : {});
        } catch {
          reject(new HttpError(400, 'Invalid JSON'));
        }
      });
      req.on('error', reject);
    });

  const send = (res: ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  const sendFile = staticFiles();
  const serveStatic = async (req: IncomingMessage, res: ServerResponse, pathname: string) => {
    const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
    const file = join(opts.publicDir, rel);
    if (!file.startsWith(opts.publicDir)) return send(res, 404, { error: 'Not found' });
    if (await sendFile(req, res, file, MIME[extname(file)] ?? 'application/octet-stream')) return;
    // Single-page app: unknown non-API paths get the shell.
    if (!(await sendFile(req, res, join(opts.publicDir, 'index.html'), MIME['.html']))) send(res, 404, { error: 'Not found' });
  };

  const server = createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    // Behind HTTPS (Caddy says so), tell browsers never to use plain HTTP for this site.
    if (req.headers['x-forwarded-proto'] === 'https') res.setHeader('strict-transport-security', 'max-age=31536000');
    // The desktop client loads its UI locally and talks to this server cross-origin.
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'authorization, content-type, x-filename, x-voice-seconds');
    res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();

    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      // The web app may only run its own scripts, and can't be framed by other sites.
      res.setHeader('content-security-policy', APP_CSP);
      res.setHeader('x-frame-options', 'DENY');
      res.setHeader('permissions-policy', 'camera=(self), display-capture=(self), geolocation=(), microphone=(self)');
      // Invite links open the app, which shows the burrow before joining.
      const invite = url.pathname.match(/^\/invite\/([\w-]{1,32})\/?$/);
      if (invite) return res.writeHead(302, { location: `/?invite=${invite[1]}` }).end();
      // Something shared from another app on a phone, before Burrow's service worker was there to
      // catch it: open the app (the shared things are lost, but it doesn't error).
      if (req.method === 'POST' && url.pathname === '/share') return res.writeHead(303, { location: '/' }).end();
      return serveStatic(req, res, url.pathname);
    }

    try {
      const upload = req.method === 'POST' && url.pathname.match(/^\/api\/channels\/(\d+)\/attachments$/);
      if (upload) return await handleUpload(req, res, Number(upload[1]));
      const thumb = url.pathname.match(/^\/api\/attachments\/([\w-]+)\/thumb$/);
      if (thumb && req.method === 'POST') return await handleThumbUpload(req, res, thumb[1]);
      if (thumb && (req.method === 'GET' || req.method === 'HEAD')) return await serveThumb(req, res, thumb[1]);
      const file = (req.method === 'GET' || req.method === 'HEAD') && url.pathname.match(/^\/api\/attachments\/([\w-]+)(\/|$)/);
      if (file) return await serveAttachment(req, res, file[1]);
      if (req.method === 'POST' && url.pathname === '/api/me/avatar') return await handleAvatarUpload(req, res);
      if (req.method === 'POST' && url.pathname === '/api/me/banner') return await handleBannerUpload(req, res);
      if (req.method === 'GET' && url.pathname === '/api/me/export') return await handleExport(req, res);
      const burrowUpload = req.method === 'POST' && url.pathname.match(/^\/api\/servers\/(\d+)\/(picture|banner)$/);
      if (burrowUpload) return await handleBurrowPictureUpload(req, res, Number(burrowUpload[1]), burrowUpload[2] === 'banner' ? 'banner' : 'icon');
      const emojiUpload = req.method === 'POST' && url.pathname.match(/^\/api\/servers\/(\d+)\/emoji$/);
      if (emojiUpload) return await handleEmojiUpload(req, res, Number(emojiUpload[1]), url);
      const soundUpload = req.method === 'POST' && url.pathname.match(/^\/api\/servers\/(\d+)\/sounds$/);
      if (soundUpload) return await handleSoundUpload(req, res, Number(soundUpload[1]), url);
      const reading = req.method === 'GET' || req.method === 'HEAD';
      const picture = reading && url.pathname.match(/^\/api\/(avatars|burrow-pictures|emoji)\/([\w-]+\.(?:png|jpg|gif|webp))$/);
      if (picture) return await servePicture(req, res, picture[1], picture[2]);
      const sound = reading && url.pathname.match(/^\/api\/sounds\/([\w-]+\.(?:mp3|ogg|wav|webm|m4a))$/);
      if (sound) return await serveSound(req, res, sound[1]);
      const embedImage = reading && url.pathname.match(/^\/api\/embeds\/(\d+)\/(\d+)\/([\w-]+)$/);
      if (embedImage) return await serveEmbedImage(req, res, Number(embedImage[1]), Number(embedImage[2]), embedImage[3]);
      const gifPreview = reading && url.pathname.match(/^\/api\/gifs\/preview\/([\w-]+)$/);
      if (gifPreview) return await serveGifPreview(req, res, gifPreview[1]);
      for (const r of routes) {
        const m = r.method === req.method && url.pathname.match(r.pattern);
        if (!m) continue;
        const token = req.headers.authorization?.replace(/^Bearer /, '');
        const user = userByToken(token);
        if (r.auth && !user) throw new HttpError(401, 'Not logged in');
        const body = req.method === 'GET' ? {} : await readBody(req);
        if (url.pathname === '/api/logout') body.token = token;
        const ua = String(req.headers['user-agent'] ?? '');
        const secure = req.headers['x-forwarded-proto'] === 'https' || !!(req.socket as { encrypted?: boolean }).encrypted;
        return send(res, 200, await r.handler({ user: user!, params: m.slice(1), body, url, token, ip: clientIp(req), ua, host: String(req.headers.host ?? ''), secure }));
      }
      throw new HttpError(404, 'Not found');
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      console.error(err);
      send(res, 500, { error: 'Internal server error' });
    }
  });

  // ---- WebSocket ----------------------------------------------------------

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const user = url.pathname === '/ws' ? userByToken(url.searchParams.get('token') ?? undefined) : undefined;
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      socketTokens.set(ws, url.searchParams.get('token')!);
      onConnection(ws, user);
    });
  });

  const onConnection = (ws: WebSocket, user: User) => {
    let set = sockets.get(user.id);
    if (!set) sockets.set(user.id, (set = new Set()));
    set.add(ws);
    if (!online.has(user.id)) {
      online.add(user.id);
      sendPresence(user.id);
    } else if (idleSockets.has(user.id)) {
      // A new device is in use, so they're back.
      const wasIdle = userIdle(user.id);
      if (wasIdle) sendPresence(user.id);
    }
    ws.send(JSON.stringify({ type: 'ready', user }));
    deliverReminders(user.id);

    let alive = true;
    ws.on('pong', () => (alive = true));
    const ping = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 30_000);

    ws.on('message', (raw) => {
      let msg: Json;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      try {
        if (msg.type === 'ping') {
          // The app checks now and then that the connection still works (a dropped Wi-Fi often doesn't close it).
          ws.send(JSON.stringify({ type: 'pong' }));
        } else if (msg.type === 'send') {
          postMessage(user, Number(msg.channelId), msg);
        } else if (msg.type === 'voice_join') {
          const channel = channelById(Number(msg.channelId));
          if (!channel || channel.kind !== 'voice' || !canSee(channel, user.id))
            throw new HttpError(404, 'Room not found');
          checkSeat(channel, user.id);
          pendingMoves.delete(user.id);
          setVoice(user.id, channel.id, flagsFrom(msg));
        } else if (msg.type === 'voice_status') {
          // Muted or deafened, in the room they're already in.
          const channelId = inVoice.get(user.id);
          if (channelId !== undefined) setVoice(user.id, channelId, flagsFrom(msg));
        } else if (msg.type === 'voice_leave') {
          setVoice(user.id, null);
        } else if (msg.type === 'voice_live') {
          // Started or stopped sharing their screen.
          if (msg.live === true) goLive(user);
          else endLive(user.id);
        } else if (msg.type === 'fireside_send') {
          const channelId = inVoice.get(user.id);
          if (channelId === undefined) throw new HttpError(400, 'Join the fire to talk there');
          const content = typeof msg.content === 'string' ? msg.content.trim() : '';
          if (!content) throw new HttpError(400, 'Message is empty');
          if (content.length > 1000) throw new HttpError(400, 'Message is too long');
          const author = nameIn(channelById(channelId)!.serverId, user.id);
          const message = { id: ++firesideId, userId: user.id, author, content, createdAt: Date.now() };
          if (channelById(channelId)?.keepChat) {
            const r = db
              .prepare('INSERT INTO fireside_messages (channel_id, user_id, author, content, created_at) VALUES (?, ?, ?, ?, ?)')
              .run(channelId, user.id, author, content, message.createdAt);
            message.id = Number(r.lastInsertRowid);
            db.prepare('DELETE FROM fireside_messages WHERE channel_id = ? AND id NOT IN (SELECT id FROM fireside_messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?)')
              .run(channelId, channelId, FIRESIDE_KEEP);
          } else {
            const list = fireside.get(channelId) ?? [];
            list.push(message);
            if (list.length > FIRESIDE_KEEP) list.shift();
            fireside.set(channelId, list);
          }
          sendTo(usersInVoice(channelId), { type: 'fireside', channelId, message });
        } else if (msg.type === 'voice_speaking') {
          // Talking or not, so people outside the fire can see who it is.
          const channelId = inVoice.get(user.id);
          const on = msg.speaking === true;
          if (channelId === undefined || speaking.has(user.id) === on) return;
          if (on) {
            speaking.add(user.id);
            lastActive.set(user.id, Date.now());
          } else speaking.delete(user.id);
          broadcastToChannel(channelById(channelId)!, { type: 'voice_speaking', channelId, userId: user.id, speaking: on });
        } else if (msg.type === 'idle') {
          // Nobody has touched this device for a while (or they're back).
          const before = userIdle(user.id);
          let idleHere = idleSockets.get(user.id);
          if (!idleHere) idleSockets.set(user.id, (idleHere = new Set()));
          if (msg.idle) idleHere.add(ws);
          else idleHere.delete(ws);
          if (before !== userIdle(user.id)) sendPresence(user.id);
        } else if (msg.type === 'activity') {
          // The game the desktop app sees running, or nothing.
          const name = typeof msg.name === 'string' ? msg.name.replace(/\s+/g, ' ').trim().slice(0, 64) : '';
          const was = activities.get(user.id);
          if ((was?.name ?? '') === name) return;
          if (name) activities.set(user.id, { name, since: now() });
          else activities.delete(user.id);
          sendPresence(user.id);
        } else if (msg.type === 'voice_active') {
          // Touched the app, so they aren't away.
          if (inVoice.has(user.id)) lastActive.set(user.id, Date.now());
        } else if (msg.type === 'soundboard') {
          playSound(user, Number(msg.soundId));
        } else if (msg.type === 'listen') {
          listenTogether(user, msg);
        } else if (msg.type === 'typing') {
          const channel = channelById(Number(msg.channelId));
          if (channel && canSee(channel, user.id))
            sendTo(
              channelAudience(channel).filter((id) => id !== user.id),
              { type: 'typing', channelId: channel.id, userId: user.id, username: nameIn(channel.serverId, user.id) },
            );
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', error: err instanceof Error ? err.message : 'Error' }));
      }
    });

    ws.on('close', () => {
      clearInterval(ping);
      set!.delete(ws);
      const wasIdle = userIdle(user.id);
      idleSockets.get(user.id)?.delete(ws);
      if (set!.size === 0) {
        sockets.delete(user.id);
        online.delete(user.id);
        idleSockets.delete(user.id);
        activities.delete(user.id);
        setVoice(user.id, null);
        sendPresence(user.id);
      } else if (wasIdle !== userIdle(user.id)) sendPresence(user.id);
    });
  };

  // Tests set a due time in the past and then check the clock, rather than waiting for it.
  Object.assign(server, { checkClock: tick, checkAfk });
  server.on('close', () => {
    wss.close();
    clearInterval(afkTimer);
    for (const t of statusTimers.values()) clearTimeout(t);
    if (wakeTimer) clearTimeout(wakeTimer);
  });
  return server;
}
