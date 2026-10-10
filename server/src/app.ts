import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { writeFile, mkdir, unlink, stat, copyFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { addModeratorRole, type Db } from './db.ts';
import { hashPassword, verifyPassword, newToken, newInviteCode } from './auth.ts';
import { closeRoom, removeFromRoom, voiceToken, type VoiceOptions } from './voice.ts';
import { staticFiles } from './static.ts';
import { gifSearch, download, type GifOptions } from './gifs.ts';
import { fetchEmbed, fetchImage, linksIn, type Embed, type EmbedOptions } from './embeds.ts';

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
}

type User = { id: number; username: string; avatar: string | null };
const PERMS = ['rooms', 'messages', 'remove', 'ban', 'roles', 'burrow', 'emoji'] as const;
type Perm = (typeof PERMS)[number];
type Standing = { host: boolean; rank: number; perms: Set<Perm>; roleIds: number[] };
const parsePerms = (text: string) => text.split(',').filter((p): p is Perm => (PERMS as readonly string[]).includes(p));
type Channel = { id: number; serverId: number; name: string; kind: 'text' | 'voice' | 'thread'; private: number; parentId: number | null };
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
};

export function createApp(opts: AppOptions): Server {
  const { db } = opts;
  const now = () => Date.now();

  // ---- data helpers -------------------------------------------------------

  // A login lasts until it goes unused for SESSION_IDLE_MS. Using it keeps it going.
  const userByToken = (token: string | undefined): User | undefined => {
    if (!token) return undefined;
    const row = db
      .prepare(
        `SELECT u.id, u.username, ${avatarUrl('u.avatar')} AS avatar, COALESCE(s.last_used_at, s.created_at) AS lastUsed
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
      )
      .get(token) as (User & { lastUsed: number }) | undefined;
    if (!row) return undefined;
    const t = now();
    if (t - row.lastUsed > SESSION_IDLE_MS) {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      return undefined;
    }
    if (t - row.lastUsed > 60 * 60 * 1000) db.prepare('UPDATE sessions SET last_used_at = ? WHERE token = ?').run(t, token);
    const { lastUsed: _, ...user } = row;
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

  const isMember = (serverId: number, userId: number) =>
    !!db.prepare('SELECT 1 FROM members WHERE server_id = ? AND user_id = ?').get(serverId, userId);

  const channelById = (id: number) =>
    db.prepare('SELECT id, server_id AS serverId, name, kind, private, parent_id AS parentId FROM channels WHERE id = ?').get(id) as
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
        `SELECT m.id, m.content, u.id AS authorId, u.username AS author,
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
    rows = rows.map(({ replyToId, stickerId, embedsOff, forwarded, ...r }) => ({
      ...r,
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
        `SELECT id, message_id, name, type, size, spoiler, voice_seconds FROM attachments
         WHERE message_id IN (${ids.map(() => '?').join(',')}) ORDER BY position`,
      )
      .all(...ids) as Json[];
    return rows.map((r) => ({ ...r, attachments: atts.filter((a) => a.message_id === r.id).map(attachmentJson) }));
  };

  // Every message is read with these columns, then filled in by withAttachments.
  const MESSAGE_SELECT = `SELECT m.id, m.channel_id AS channelId, m.content, m.created_at AS createdAt, m.edited_at AS editedAt,
      m.reply_to AS replyToId, m.pinned_at AS pinnedAt, m.forwarded, m.sticker_id AS stickerId, m.embeds_off AS embedsOff,
      u.id AS authorId, u.username AS author, ${avatarUrl('u.avatar')} AS authorAvatar
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
        `SELECT id, name, kind, owner_id AS ownerId, invite_code AS inviteCode,
                CASE WHEN icon IS NULL THEN NULL ELSE '/api/burrow-pictures/' || icon END AS icon
         FROM servers WHERE id = ?`,
      )
      .get(serverId) as Json;
    if (server.kind === 'dm') delete server.inviteCode;
    const manager = can(serverId, viewerId, 'rooms');
    const ids = (sql: string, id: number) => (db.prepare(sql).all(id) as { id: number }[]).map((r) => r.id);
    const channels = (
      db
        .prepare("SELECT id, server_id AS serverId, name, kind, private, parent_id AS parentId FROM channels WHERE server_id = ? AND kind != 'thread' ORDER BY id")
        .all(serverId) as Channel[]
    )
      .filter((c) => canSee(c, viewerId))
      .map(({ serverId: _, private: priv, parentId: __, ...c }) => ({
        ...c,
        private: !!priv,
        ...(c.kind === 'voice' ? voiceSummary(c.id) : readInfo(c.id, serverId, viewerId)),
        // Who has been let in, for the people who can change it.
        ...(priv && manager
          ? {
              memberIds: ids('SELECT user_id AS id FROM channel_access WHERE channel_id = ?', c.id),
              roleIds: ids('SELECT role_id AS id FROM channel_role_access WHERE channel_id = ?', c.id),
            }
          : {}),
      }));
    const roles = (
      db.prepare('SELECT id, name, color, perms, position FROM roles WHERE server_id = ? ORDER BY position').all(serverId) as Json[]
    ).map((r) => ({ ...r, perms: parsePerms(r.perms as string) }));
    const memberRoles = db
      .prepare('SELECT mr.user_id, mr.role_id FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.server_id = ? ORDER BY r.position')
      .all(serverId) as { user_id: number; role_id: number }[];
    const members = db
      .prepare(
        `SELECT u.id, u.username, ${avatarUrl('u.avatar')} AS avatar FROM members m JOIN users u ON u.id = m.user_id
         WHERE m.server_id = ? ORDER BY u.username`,
      )
      .all(serverId) as User[];
    return {
      ...server,
      channels,
      threads: threadsIn(serverId, viewerId),
      emoji: emojiOf(serverId),
      ...(server.kind === 'dm' ? { seen: dmSeen(serverId, viewerId) } : {}),
      roles,
      members: members.map((m) => {
        // Highest role first. 'role' is kept for apps from before custom roles.
        const roleIds = memberRoles.filter((r) => r.user_id === m.id).map((r) => r.role_id);
        const host = server.kind === 'burrow' && m.id === server.ownerId;
        const powers = roleIds.some((id) => (roles.find((r) => r.id === id)?.perms.length ?? 0) > 0);
        return { ...m, roleIds, role: host ? 'host' : powers ? 'mod' : 'member', online: online.has(m.id) };
      }),
    };
  };

  const startSession = (user: User) => {
    const token = newToken();
    db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, user.id, now());
    return { token, user };
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
  const usersInVoice = (channelId: number) => [...inVoice].filter(([, c]) => c === channelId).map(([u]) => u);
  /** Who's in a voice room, and which of them are muted or deafened, so everyone in the burrow can see. */
  const voiceSummary = (channelId: number) => {
    const userIds = usersInVoice(channelId);
    const flagged = (flag: 'muted' | 'deafened') => userIds.filter((u) => voiceFlags.get(u)?.[flag]);
    return { voiceUsers: userIds, voiceMuted: flagged('muted'), voiceDeafened: flagged('deafened') };
  };
  // Fireside chat: text for the people in a voice room, while they're there. It's kept in memory
  // only, sent to whoever is in the room, and gone once the last person leaves.
  const fireside = new Map<number, Json[]>(); // voice channel id -> recent messages, oldest first
  let firesideId = 0;
  const FIRESIDE_KEEP = 100;
  const voiceStateEvent = (channelId: number) => {
    const { voiceUsers, voiceMuted, voiceDeafened } = voiceSummary(channelId);
    return { type: 'voice_state', channelId, userIds: voiceUsers, muted: voiceMuted, deafened: voiceDeafened };
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
    if (prev !== undefined) {
      inVoice.delete(userId);
      if (!usersInVoice(prev).length) fireside.delete(prev);
      const old = channelById(prev);
      if (old) broadcastToChannel(old, voiceStateEvent(old.id));
    }
    if (channelId !== null) {
      const channel = channelById(channelId)!;
      inVoice.set(userId, channelId);
      sendTo([userId], { type: 'fireside_history', channelId, messages: fireside.get(channelId) ?? [] });
      broadcastToChannel(channel, voiceStateEvent(channelId));
    }
  };
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
  type PostExtras = { forwarded?: Json; poll?: PollInput };

  /**
   * Posts a message: text, files (some hidden as spoilers), a sticker, a reply, and for polls
   * and forwards, the extras those bring. Everyone who can see the room gets it.
   */
  const postMessage = (user: User, channelId: number, input: Json, extras: PostExtras = {}) => {
    const channel = channelById(channelId);
    if (!channel || !canSee(channel, user.id)) throw new HttpError(404, 'Room not found');
    if (channel.kind === 'voice') throw new HttpError(400, 'Voice rooms have no messages');
    let content = input.content ?? '';
    if (typeof content !== 'string') throw new HttpError(400, 'Message is empty');
    if (content.length > MAX_MESSAGE_LENGTH) throw new HttpError(400, 'Message is too long');
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
    if (!content.trim() && !usable.length && !stickerId && !extras.poll && !extras.forwarded) throw new HttpError(400, 'Message is empty');
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
      .prepare('INSERT INTO messages (channel_id, author_id, content, created_at, reply_to, sticker_id, forwarded) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(channelId, user.id, content, now(), replyId, stickerId, extras.forwarded ? JSON.stringify(extras.forwarded) : null);
    const messageId = Number(r.lastInsertRowid);
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
    // Writing in a room means you've read it.
    markRead(user.id, channel, messageId);
    if (channel.kind === 'thread') threadChanged(channel);
    previewLinks(messageId, channel, content);
    return message;
  };

  // ---- HTTP routes --------------------------------------------------------

  type Handler = (ctx: { user: User; params: string[]; body: Json; url: URL; token: string | undefined; ip: string }) => unknown;
  type Route = { method: string; pattern: RegExp; auth: boolean; handler: Handler };
  const routes: Route[] = [];
  const route = (method: string, path: string, handler: Handler, auth = true) =>
    routes.push({ method, pattern: new RegExp('^' + path.replace(/:\w+/g, '(\\d+)') + '$'), auth, handler });

  route(
    'GET',
    '/api/config',
    () => ({
      registrationCodeRequired: !!opts.registrationCode,
      voice: !!opts.voice,
      maxUploadBytes: opts.uploadDir ? maxUpload : 0,
      gifs: !!gifs,
    }),
    false,
  );

  route(
    'POST',
    '/api/register',
    ({ body, ip }) => {
      checkTries([`register-ip:${ip}`], 10);
      const username = cleanName(body.username, 'Username', 32);
      if (!/^[\w.-]+$/.test(username)) throw new HttpError(400, 'Username may only use letters, numbers, _ . -');
      if (typeof body.password !== 'string' || body.password.length < 8)
        throw new HttpError(400, 'Password must be at least 8 characters');
      if (opts.registrationCode && !sameText(body.registrationCode, opts.registrationCode)) {
        failedTry([`register-ip:${ip}`], 60 * 60 * 1000);
        throw new HttpError(403, 'Invalid registration code');
      }
      if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username))
        throw new HttpError(409, 'That username is taken');
      const r = db
        .prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
        .run(username, hashPassword(body.password), now());
      return startSession({ id: Number(r.lastInsertRowid), username, avatar: null });
    },
    false,
  );

  route(
    'POST',
    '/api/login',
    ({ body, ip }) => {
      const name = String(body.username ?? '').toLowerCase();
      const keys = [`login-user:${name}`, `login-ip:${ip}`];
      checkTries(keys.slice(0, 1), 10);
      checkTries(keys.slice(1), 30);
      const row = db
        .prepare(`SELECT id, username, ${avatarUrl('avatar')} AS avatar, password_hash FROM users WHERE username = ?`)
        .get(String(body.username ?? '')) as (User & { password_hash: string }) | undefined;
      if (!row || !verifyPassword(String(body.password ?? ''), row.password_hash)) {
        failedTry(keys);
        throw new HttpError(401, 'Wrong username or password');
      }
      clearTries(keys[0]);
      return startSession({ id: row.id, username: row.username, avatar: row.avatar });
    },
    false,
  );

  route('POST', '/api/logout', ({ body }) => {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(String(body.token ?? ''));
    return { ok: true };
  });

  route('GET', '/api/me', ({ user }) => ({ ...user, readReceipts: readReceiptsOn(user.id) }));

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
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(user.id, token);
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
    if (ids.length > MAX_FAVORITES) throw new HttpError(400, `You can favorite up to ${MAX_FAVORITES} burrows`);
    const isBurrow = db.prepare("SELECT 1 FROM members m JOIN servers s ON s.id = m.server_id WHERE m.user_id = ? AND m.server_id = ? AND s.kind = 'burrow'");
    for (const id of ids) if (!isBurrow.get(user.id, id)) throw new HttpError(404, 'Burrow not found');
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

  /** Opens your conversation with someone, starting it if needed. You can only start one with people you share a burrow with. */
  route('POST', '/api/dms', ({ user, body }) => {
    const otherId = Number(body.userId);
    if (otherId === user.id) throw new HttpError(400, "You can't message yourself");
    const key = [user.id, otherId].sort((a, b) => a - b).join(':');
    const existing = db.prepare('SELECT id FROM servers WHERE dm_key = ?').get(key) as { id: number } | undefined;
    if (existing) return serverSummary(existing.id, user.id);
    const sharesBurrow = db
      .prepare(
        `SELECT 1 FROM members a JOIN members b ON a.server_id = b.server_id JOIN servers s ON s.id = a.server_id
         WHERE a.user_id = ? AND b.user_id = ? AND s.kind = 'burrow'`,
      )
      .get(user.id, otherId);
    if (!sharesBurrow) throw new HttpError(403, 'You can only message people who share a burrow with you');
    const t = now();
    const r = db
      .prepare("INSERT INTO servers (name, owner_id, invite_code, created_at, kind, dm_key) VALUES ('', ?, ?, ?, 'dm', ?)")
      .run(user.id, newInviteCode(), t, key);
    const serverId = Number(r.lastInsertRowid);
    for (const id of [user.id, otherId])
      db.prepare('INSERT INTO members (server_id, user_id, joined_at) VALUES (?, ?, ?)').run(serverId, id, t);
    db.prepare('INSERT INTO channels (server_id, name, created_at) VALUES (?, ?, ?)').run(serverId, 'dm', t);
    sendServerUpdate(serverId);
    return serverSummary(serverId, user.id);
  });

  route('POST', '/api/servers', ({ user, body }) => {
    const name = cleanName(body.name, 'Burrow name');
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

  route('POST', '/api/join', ({ user, body }) => {
    const code = String(body.inviteCode ?? '').trim().split('/').pop();
    const server = db.prepare("SELECT id FROM servers WHERE invite_code = ? AND kind = 'burrow'").get(code ?? '') as
      | { id: number }
      | undefined;
    if (!server) throw new HttpError(404, 'Invite code not found');
    if (db.prepare('SELECT 1 FROM bans WHERE server_id = ? AND user_id = ?').get(server.id, user.id))
      throw new HttpError(403, "You've been banned from this burrow");
    if (!isMember(server.id, user.id)) {
      db.prepare('INSERT INTO members (server_id, user_id, joined_at) VALUES (?, ?, ?)').run(server.id, user.id, now());
      sendServerUpdate(server.id);
    }
    return serverSummary(server.id, user.id);
  });

  route('POST', '/api/servers/:id/leave', ({ user, params }) => {
    const serverId = Number(params[0]);
    const owner = db.prepare("SELECT owner_id FROM servers WHERE id = ? AND kind = 'burrow'").get(serverId) as
      | { owner_id: number }
      | undefined;
    if (!owner || !isMember(serverId, user.id)) throw new HttpError(404, 'Burrow not found');
    if (owner.owner_id === user.id) {
      broadcastToServer(serverId, { type: 'server_deleted', serverId });
      for (const id of voiceRoomIds(serverId)) closeVoiceRoom(id);
      removeFiles(
        db
          .prepare('SELECT a.id FROM attachments a JOIN channels c ON c.id = a.channel_id WHERE c.server_id = ?')
          .all(serverId) as Json[],
      );
      removeBurrowPicture(serverId);
      for (const e of db.prepare('SELECT file FROM custom_emoji WHERE server_id = ?').all(serverId) as { file: string }[]) removeEmojiFile(e.file);
      db.prepare('DELETE FROM servers WHERE id = ?').run(serverId);
    } else {
      removeMember(serverId, user.id);
    }
    return { ok: true };
  });

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
    if (!me) throw new HttpError(404, 'Burrow not found');
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
    if (count.n >= MAX_ROLES) throw new HttpError(400, `A burrow can have at most ${MAX_ROLES} roles`);
    // New roles start at the bottom, below everyone's.
    db.prepare('INSERT INTO roles (server_id, name, color, perms, position, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      serverId,
      cleanName(body.name, 'Role name', 32),
      cleanColor(body.color ?? '#8a8f87'),
      cleanPerms(body.perms, me),
      (count.last ?? 0) + 1,
      now(),
    );
    sendServerUpdate(serverId);
    return serverSummary(serverId, user.id);
  });

  // Rename, recolor, change permissions, or move up or down one place.
  route('PATCH', '/api/roles/:id', ({ user, params, body }) => {
    const { role, me } = managedRole(Number(params[0]), user);
    if (body.name !== undefined) db.prepare('UPDATE roles SET name = ? WHERE id = ?').run(cleanName(body.name, 'Role name', 32), role.id);
    if (body.color !== undefined) db.prepare('UPDATE roles SET color = ? WHERE id = ?').run(cleanColor(body.color), role.id);
    if (body.perms !== undefined) db.prepare('UPDATE roles SET perms = ? WHERE id = ?').run(cleanPerms(body.perms, me, role.perms), role.id);
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
    db.prepare('DELETE FROM roles WHERE id = ?').run(role.id);
    accessChanged(role.serverId);
    return serverSummary(role.serverId, user.id);
  });

  // Gives someone exactly these roles. Roles at or above your own stay as they are.
  route('POST', '/api/servers/:id/members/:id/roles', ({ user, params, body }) => {
    const [serverId, targetId] = params.map(Number);
    const me = allowed(serverId, user, 'roles');
    const target = standing(serverId, targetId);
    if (!target) throw new HttpError(404, "They aren't in this burrow");
    if (targetId !== user.id && target.rank <= me.rank) throw new HttpError(403, "You can't change their roles");
    const wanted = new Set(roleList(serverId, body.roleIds));
    const changeable = (id: number) => roleById(id)!.position > me.rank;
    for (const id of new Set([...wanted, ...target.roleIds])) {
      if (wanted.has(id) === target.roleIds.includes(id)) continue;
      if (!changeable(id)) throw new HttpError(403, 'You can only give or take roles below your own');
      if (wanted.has(id)) db.prepare('INSERT INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)').run(serverId, targetId, id);
      else db.prepare('DELETE FROM member_roles WHERE role_id = ? AND user_id = ?').run(id, targetId);
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
    if (!target) throw new HttpError(404, "They aren't in this burrow");
    if (target.host || target.rank <= me.rank || targetId === user.id) throw new HttpError(403, "You can't remove them");
    if (body.ban) db.prepare('INSERT OR IGNORE INTO bans (server_id, user_id, banned_at) VALUES (?, ?, ?)').run(serverId, targetId, now());
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
    return { ok: true };
  });

  route('POST', '/api/servers/:id/channels', ({ user, params, body }) => {
    const serverId = Number(params[0]);
    allowed(serverId, user, 'rooms');
    const kind = body.kind === 'voice' ? 'voice' : 'text';
    const name = roomName(body.name, kind);
    const r = db
      .prepare('INSERT INTO channels (server_id, name, kind, private, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(serverId, name, kind, body.private ? 1 : 0, now());
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
    accessChanged(channel.serverId);
    return serverSummary(channel.serverId, user.id);
  });

  route('DELETE', '/api/channels/:id', ({ user, params }) => {
    const channel = channelById(Number(params[0]));
    if (!channel || !canSee(channel, user.id)) throw new HttpError(404, 'Room not found');
    const threadMessage = channel.kind === 'thread' ? manageableThread(channel, user) : null;
    if (channel.kind !== 'thread') allowed(channel.serverId, user, 'rooms');
    const textRooms = db.prepare("SELECT COUNT(*) AS n FROM channels WHERE server_id = ? AND kind = 'text'").get(channel.serverId) as { n: number };
    if (channel.kind === 'text' && textRooms.n <= 1) throw new HttpError(400, 'A burrow needs at least one text room');
    if (channel.kind === 'voice') closeVoiceRoom(channel.id);
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
    return { url: opts.voice.url ?? null, token: voiceToken(opts.voice, user, `room-${channel.id}`) };
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
    // The old wording is kept, so anyone can see what an edited message used to say.
    db.prepare('INSERT INTO message_edits (message_id, content, edited_at) VALUES (?, ?, ?)').run(id, before.content, before.at);
    db.prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?').run(body.content, now(), id);
    const linksChanged = linksIn(before.content).join() !== linksIn(body.content).join();
    if (linksChanged) db.prepare('DELETE FROM message_embeds WHERE message_id = ?').run(id);
    const message = messageById(id)!;
    broadcastToChannel(channel, { type: 'message_updated', message });
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
    removeFiles(db.prepare('SELECT id FROM attachments WHERE message_id = ?').all(id) as Json[]);
    db.prepare('DELETE FROM messages WHERE id = ?').run(id);
    broadcastToChannel(channel, { type: 'message_deleted', id, channelId: channel.id });
    return { ok: true };
  });

  // ---- uploads ------------------------------------------------------------

  const maxUpload = opts.maxUploadBytes ?? 25 * 1024 * 1024;
  const filePath = (id: string) => join(opts.uploadDir!, id);
  const removeFiles = (rows: Json[]) => {
    if (!opts.uploadDir) return;
    for (const r of rows) unlink(filePath(r.id as string)).catch(() => {});
  };

  // The file is the raw request body; its name comes in the x-filename header.
  const handleUpload = async (req: IncomingMessage, res: ServerResponse, channelId: number) => {
    const user = userByToken(req.headers.authorization?.replace(/^Bearer /, ''));
    if (!user) throw new HttpError(401, 'Not logged in');
    if (!opts.uploadDir) throw new HttpError(503, 'Uploads are not set up on this server');
    const channel = channelById(channelId);
    if (!channel || !canSee(channel, user.id)) throw new HttpError(404, 'Room not found');
    if (channel.kind === 'voice') throw new HttpError(400, 'Voice rooms have no messages');
    const declared = Number(req.headers['content-length']);
    if (declared > maxUpload) throw new HttpError(413, `Files can be at most ${Math.round(maxUpload / 1048576)} MB`);
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
        if (size > maxUpload) {
          req.pause();
          reject(new HttpError(413, `Files can be at most ${Math.round(maxUpload / 1048576)} MB`));
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
    db.prepare(
      'INSERT INTO attachments (id, channel_id, uploader_id, name, type, size, created_at, voice_seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, channel.id, user.id, name, type, size, now(), voice);
    send(res, 200, attachmentJson({ id, name, type, size, voice_seconds: voice }));
  };

  // Attachment links are unguessable (128 random bits), so images work in <img> tags without a login.
  const serveAttachment = async (req: IncomingMessage, res: ServerResponse, id: string) => {
    const a = db.prepare('SELECT name, type, size FROM attachments WHERE id = ? AND message_id IS NOT NULL').get(id) as
      | { name: string; type: string; size: number }
      | undefined;
    if (!a || !opts.uploadDir || !(await stat(filePath(id)).catch(() => null))) throw new HttpError(404, 'File not found');
    const inline = INLINE_TYPES.has(a.type);
    res.writeHead(200, {
      'content-type': inline ? a.type : 'application/octet-stream',
      'content-length': a.size,
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.name)}`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, max-age=31536000, immutable',
    });
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
    const updated = { id: user.id, username: user.username, avatar: file && `/api/avatars/${file}` };
    sendTo(new Set([user.id, ...usersSharingServerWith(user.id)]), { type: 'user_updated', user: updated });
    return updated;
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
  const setBurrowPicture = (serverId: number, file: string | null) => {
    removeBurrowPicture(serverId);
    db.prepare('UPDATE servers SET icon = ? WHERE id = ?').run(file, serverId);
    sendServerUpdate(serverId);
  };
  const removeBurrowPicture = (serverId: number) => {
    const old = db.prepare('SELECT icon FROM servers WHERE id = ?').get(serverId) as { icon: string | null } | undefined;
    if (old?.icon && opts.uploadDir) unlink(picturePath('burrow-pictures', old.icon)).catch(() => {});
  };

  // The host, and roles allowed to edit the burrow, can change its picture.
  const handleBurrowPictureUpload = async (req: IncomingMessage, res: ServerResponse, serverId: number) => {
    const user = pictureUploader(req);
    allowed(serverId, user, 'burrow');
    const file = await savePicture(req, 'burrow-pictures', 'Burrow pictures');
    // They may have lost the right (or the burrow may be gone) while it uploaded.
    try {
      allowed(serverId, user, 'burrow');
    } catch (err) {
      unlink(picturePath('burrow-pictures', file)).catch(() => {});
      throw err;
    }
    setBurrowPicture(serverId, file);
    send(res, 200, serverSummary(serverId, user.id));
  };
  route('DELETE', '/api/servers/:id/picture', ({ user, params }) => {
    const serverId = Number(params[0]);
    allowed(serverId, user, 'burrow');
    setBurrowPicture(serverId, null);
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
      ? (db.prepare('SELECT u.username FROM members m JOIN users u ON u.id = m.user_id WHERE m.server_id = ? AND m.user_id != ?').get(c.serverId as number, viewerId) as { username: string } | undefined)?.username
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

  // ---- unread messages: the newest message each person has read in each room ----

  // Whether a message mentions someone: "@name" as a whole word, the way the app highlights it.
  db.function('mentions_name', { deterministic: true }, (content, name) =>
    new RegExp(`@${String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(String(content)) ? 1 : 0,
  );
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
    const name = (db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string }).username;
    // In a DM everything is for you; elsewhere it's @mentions and replies to you.
    const mentions = dm
      ? unread
      : count('AND (mentions_name(m.content, ?) OR EXISTS (SELECT 1 FROM messages r WHERE r.id = m.reply_to AND r.author_id = ?))', name, userId);
    return { lastReadId, unread, mentions };
  };

  const readReceiptsOn = (userId: number) =>
    !!(db.prepare('SELECT read_receipts FROM users WHERE id = ?').get(userId) as { read_receipts: number } | undefined)?.read_receipts;
  const dmPartner = (serverId: number, userId: number) =>
    (db.prepare('SELECT user_id FROM members WHERE server_id = ? AND user_id != ?').get(serverId, userId) as { user_id: number } | undefined)?.user_id;
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
    return { ...user, readReceipts: readReceiptsOn(user.id) };
  });

  // ---- pinned messages ----

  const MAX_PINS = 50;
  route('POST', '/api/messages/:id/pin', ({ user, params, body }) => {
    const id = Number(params[0]);
    const { channel } = visibleMessage(user, id);
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
      const user = db.prepare(`SELECT id, username, ${avatarUrl('avatar')} AS avatar FROM users WHERE id = ?`).get(uid) as User | undefined;
      if (!user) continue;
      // The message it answered may be gone by now; it's sent anyway, as a plain message.
      const replyStill = s.reply_to != null && db.prepare('SELECT 1 FROM messages WHERE id = ? AND channel_id = ?').get(s.reply_to as number, s.channel_id as number);
      try {
        postMessage(user, s.channel_id as number, { content: s.content, replyTo: replyStill ? s.reply_to : null });
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
        db.prepare(
          'INSERT INTO attachments (id, channel_id, uploader_id, name, type, size, created_at, voice_seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(copy, to.id, user.id, a.name as string, a.type as string, a.size as number, now(), (a.voiceSeconds as number) ?? null);
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

  route('POST', '/api/channels/:id/polls', ({ user, params, body }) => {
    const question = cleanName(body.question, 'Question', 300);
    const options = (Array.isArray(body.options) ? body.options : []).map((o) => (typeof o === 'string' ? o.trim() : '')).filter(Boolean);
    if (options.length < 2) throw new HttpError(400, 'A poll needs at least two answers');
    if (options.length > MAX_POLL_OPTIONS) throw new HttpError(400, `A poll can have at most ${MAX_POLL_OPTIONS} answers`);
    if (options.some((o) => o.length > 80)) throw new HttpError(400, 'Answers can be at most 80 characters');
    if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) throw new HttpError(400, 'Each answer must be different');
    const hours = Number(body.hours) || 0;
    if (hours < 0 || hours > 24 * 30) throw new HttpError(400, 'A poll can run for up to 30 days');
    const poll = { question, options, multi: body.multi === true, closesAt: hours ? now() + hours * 3600_000 : null };
    return postMessage(user, Number(params[0]), { content: '', replyTo: body.replyTo }, { poll });
  });

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
      if (count >= MAX_EMOJI[kind]) throw new HttpError(400, `A burrow can have up to ${MAX_EMOJI[kind]} ${kind === 'sticker' ? 'stickers' : 'emoji'}`);
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
      const name = body.name ? threadName(body.name) : firstLine.replace(/\s+/g, ' ').trim().slice(0, 40) || 'Thread';
      const r = db
        .prepare("INSERT INTO channels (server_id, name, kind, private, created_at, parent_id, parent_message_id, created_by) VALUES (?, ?, 'thread', 0, ?, ?, ?, ?)")
        .run(channel.serverId, name, now(), channel.id, id, user.id);
      thread = { id: Number(r.lastInsertRowid) };
      messageChanged(id, channel);
      sendServerUpdate(channel.serverId);
    }
    return { threadId: thread.id, server: serverSummary(channel.serverId, user.id) };
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
           UNION ALL SELECT MIN(closes_at) FROM polls WHERE ended = 0)`,
      )
      .get(now()) as { t: number | null }).t;
  const tick = () => {
    wakeTimer = null;
    wakeTime = Infinity;
    try {
      sendScheduled();
      deliverReminders();
      endPolls();
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
      return serveStatic(req, res, url.pathname);
    }

    try {
      const upload = req.method === 'POST' && url.pathname.match(/^\/api\/channels\/(\d+)\/attachments$/);
      if (upload) return await handleUpload(req, res, Number(upload[1]));
      const file = (req.method === 'GET' || req.method === 'HEAD') && url.pathname.match(/^\/api\/attachments\/([\w-]+)(\/|$)/);
      if (file) return await serveAttachment(req, res, file[1]);
      if (req.method === 'POST' && url.pathname === '/api/me/avatar') return await handleAvatarUpload(req, res);
      const burrowUpload = req.method === 'POST' && url.pathname.match(/^\/api\/servers\/(\d+)\/picture$/);
      if (burrowUpload) return await handleBurrowPictureUpload(req, res, Number(burrowUpload[1]));
      const emojiUpload = req.method === 'POST' && url.pathname.match(/^\/api\/servers\/(\d+)\/emoji$/);
      if (emojiUpload) return await handleEmojiUpload(req, res, Number(emojiUpload[1]), url);
      const reading = req.method === 'GET' || req.method === 'HEAD';
      const picture = reading && url.pathname.match(/^\/api\/(avatars|burrow-pictures|emoji)\/([\w-]+\.(?:png|jpg|gif|webp))$/);
      if (picture) return await servePicture(req, res, picture[1], picture[2]);
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
        return send(res, 200, await r.handler({ user: user!, params: m.slice(1), body, url, token, ip: clientIp(req) }));
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
      sendTo(usersSharingServerWith(user.id), { type: 'presence', userId: user.id, online: true });
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
        if (msg.type === 'send') {
          postMessage(user, Number(msg.channelId), msg);
        } else if (msg.type === 'voice_join') {
          const channel = channelById(Number(msg.channelId));
          if (!channel || channel.kind !== 'voice' || !canSee(channel, user.id))
            throw new HttpError(404, 'Room not found');
          setVoice(user.id, channel.id, flagsFrom(msg));
        } else if (msg.type === 'voice_status') {
          // Muted or deafened, in the room they're already in.
          const channelId = inVoice.get(user.id);
          if (channelId !== undefined) setVoice(user.id, channelId, flagsFrom(msg));
        } else if (msg.type === 'voice_leave') {
          setVoice(user.id, null);
        } else if (msg.type === 'fireside_send') {
          const channelId = inVoice.get(user.id);
          if (channelId === undefined) throw new HttpError(400, 'Join the fire to talk there');
          const content = typeof msg.content === 'string' ? msg.content.trim() : '';
          if (!content) throw new HttpError(400, 'Message is empty');
          if (content.length > 1000) throw new HttpError(400, 'Message is too long');
          const message = { id: ++firesideId, userId: user.id, author: user.username, content, createdAt: Date.now() };
          const list = fireside.get(channelId) ?? [];
          list.push(message);
          if (list.length > FIRESIDE_KEEP) list.shift();
          fireside.set(channelId, list);
          sendTo(usersInVoice(channelId), { type: 'fireside', channelId, message });
        } else if (msg.type === 'typing') {
          const channel = channelById(Number(msg.channelId));
          if (channel && canSee(channel, user.id))
            sendTo(
              channelAudience(channel).filter((id) => id !== user.id),
              { type: 'typing', channelId: channel.id, userId: user.id, username: user.username },
            );
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', error: err instanceof Error ? err.message : 'Error' }));
      }
    });

    ws.on('close', () => {
      clearInterval(ping);
      set!.delete(ws);
      if (set!.size === 0) {
        sockets.delete(user.id);
        online.delete(user.id);
        setVoice(user.id, null);
        sendTo(usersSharingServerWith(user.id), { type: 'presence', userId: user.id, online: false });
      }
    });
  };

  // Tests set a due time in the past and then check the clock, rather than waiting for it.
  Object.assign(server, { checkClock: tick });
  server.on('close', () => {
    wss.close();
    if (wakeTimer) clearTimeout(wakeTimer);
  });
  return server;
}
