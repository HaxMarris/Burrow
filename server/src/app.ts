import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFile, writeFile, mkdir, unlink, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import type { Db } from './db.ts';
import { hashPassword, verifyPassword, newToken, newInviteCode } from './auth.ts';
import { voiceToken, type VoiceOptions } from './voice.ts';

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
}

type User = { id: number; username: string; avatar: string | null };
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
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
// A user's picture link, from their users.avatar file name (or null).
const avatarUrl = (col: string) => `CASE WHEN ${col} IS NULL THEN NULL ELSE '/api/avatars/' || ${col} END`;
// Profile pictures are recognised by their first bytes, not by what the client says they are.
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
  'video/mp4', 'video/webm', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm',
]);
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export function createApp(opts: AppOptions): Server {
  const { db } = opts;
  const now = () => Date.now();

  // ---- data helpers -------------------------------------------------------

  const userByToken = (token: string | undefined): User | undefined => {
    if (!token) return undefined;
    return db
      .prepare(`SELECT u.id, u.username, ${avatarUrl('u.avatar')} AS avatar FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`)
      .get(token) as User | undefined;
  };

  const isMember = (serverId: number, userId: number) =>
    !!db.prepare('SELECT 1 FROM members WHERE server_id = ? AND user_id = ?').get(serverId, userId);

  const channelById = (id: number) =>
    db.prepare('SELECT id, server_id AS serverId, name, kind FROM channels WHERE id = ?').get(id) as
      | { id: number; serverId: number; name: string; kind: 'text' | 'voice' }
      | undefined;

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

  /** Adds attachments, reactions and reply previews to a list of message rows. */
  const withAttachments = (rows: Json[]) => {
    if (!rows.length) return rows;
    rows = rows.map(({ replyToId, ...r }) => ({ ...r, replyTo: replyPreview(replyToId), reactions: reactionsFor(r.id as number) }));
    const ids = rows.map((r) => r.id as number);
    const atts = db
      .prepare(
        `SELECT id, message_id, name, type, size FROM attachments
         WHERE message_id IN (${ids.map(() => '?').join(',')}) ORDER BY position`,
      )
      .all(...ids) as Json[];
    return rows.map((r) => ({ ...r, attachments: atts.filter((a) => a.message_id === r.id).map(attachmentJson) }));
  };

  const messageById = (id: number) => {
    const row = db
      .prepare(
        `SELECT m.id, m.channel_id AS channelId, m.content, m.created_at AS createdAt, m.edited_at AS editedAt,
                m.reply_to AS replyToId, u.id AS authorId, u.username AS author, ${avatarUrl('u.avatar')} AS authorAvatar
         FROM messages m JOIN users u ON u.id = m.author_id WHERE m.id = ?`,
      )
      .get(id) as Json | undefined;
    return row && withAttachments([row])[0];
  };

  const serverSummary = (serverId: number) => {
    const server = db
      .prepare('SELECT id, name, kind, owner_id AS ownerId, invite_code AS inviteCode FROM servers WHERE id = ?')
      .get(serverId) as Json;
    if (server.kind === 'dm') delete server.inviteCode;
    const channels = (
      db.prepare('SELECT id, name, kind FROM channels WHERE server_id = ? ORDER BY id').all(serverId) as Json[]
    ).map((c) => (c.kind === 'voice' ? { ...c, voiceUsers: usersInVoice(c.id as number) } : c));
    const members = db
      .prepare(
        `SELECT u.id, u.username, ${avatarUrl('u.avatar')} AS avatar FROM members m JOIN users u ON u.id = m.user_id
         WHERE m.server_id = ? ORDER BY u.username`,
      )
      .all(serverId) as User[];
    return {
      ...server,
      channels,
      members: members.map((m) => ({ ...m, online: online.has(m.id) })),
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

  const usersInVoice = (channelId: number) => [...inVoice].filter(([, c]) => c === channelId).map(([u]) => u);

  const sendTo = (userIds: Iterable<number>, event: Json) => {
    const data = JSON.stringify(event);
    for (const id of userIds) for (const ws of sockets.get(id) ?? []) if (ws.readyState === WebSocket.OPEN) ws.send(data);
  };

  const broadcastToServer = (serverId: number, event: Json) => sendTo(serverMemberIds(serverId), event);

  // Who is in which voice room. The app reports joining and leaving; LiveKit carries the audio.
  const setVoice = (userId: number, channelId: number | null) => {
    const prev = inVoice.get(userId);
    if (prev === channelId || (prev === undefined && channelId === null)) return;
    if (prev !== undefined) {
      inVoice.delete(userId);
      const old = channelById(prev);
      if (old) broadcastToServer(old.serverId, { type: 'voice_state', channelId: old.id, userIds: usersInVoice(old.id) });
    }
    if (channelId !== null) {
      const channel = channelById(channelId)!;
      inVoice.set(userId, channelId);
      broadcastToServer(channel.serverId, { type: 'voice_state', channelId, userIds: usersInVoice(channelId) });
    }
  };

  const usersSharingServerWith = (userId: number) =>
    (
      db
        .prepare(
          'SELECT DISTINCT b.user_id FROM members a JOIN members b ON a.server_id = b.server_id WHERE a.user_id = ?',
        )
        .all(userId) as { user_id: number }[]
    ).map((r) => r.user_id);

  const postMessage = (user: User, channelId: number, content: unknown, attachmentIds: unknown = [], replyTo: unknown = null) => {
    const channel = channelById(channelId);
    if (!channel || !isMember(channel.serverId, user.id)) throw new HttpError(404, 'Room not found');
    if (channel.kind === 'voice') throw new HttpError(400, 'Voice rooms have no messages');
    if (content == null) content = '';
    if (typeof content !== 'string') throw new HttpError(400, 'Message is empty');
    if (content.length > MAX_MESSAGE_LENGTH) throw new HttpError(400, 'Message is too long');
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
    if (!content.trim() && !usable.length) throw new HttpError(400, 'Message is empty');
    let replyId: number | null = null;
    if (replyTo != null) {
      const target = db.prepare('SELECT channel_id FROM messages WHERE id = ?').get(Number(replyTo)) as
        | { channel_id: number }
        | undefined;
      if (!target || target.channel_id !== channelId) throw new HttpError(400, "Can't reply to that message");
      replyId = Number(replyTo);
    }
    const r = db
      .prepare('INSERT INTO messages (channel_id, author_id, content, created_at, reply_to) VALUES (?, ?, ?, ?, ?)')
      .run(channelId, user.id, content, now(), replyId);
    usable.forEach((id, position) =>
      db.prepare('UPDATE attachments SET message_id = ?, position = ? WHERE id = ?').run(Number(r.lastInsertRowid), position, id),
    );
    const message = messageById(Number(r.lastInsertRowid))!;
    broadcastToServer(channel.serverId, { type: 'message', message });
    return message;
  };

  // ---- HTTP routes --------------------------------------------------------

  type Handler = (ctx: { user: User; params: string[]; body: Json; url: URL; token: string | undefined }) => unknown;
  type Route = { method: string; pattern: RegExp; auth: boolean; handler: Handler };
  const routes: Route[] = [];
  const route = (method: string, path: string, handler: Handler, auth = true) =>
    routes.push({ method, pattern: new RegExp('^' + path.replace(/:\w+/g, '(\\d+)') + '$'), auth, handler });

  route(
    'GET',
    '/api/config',
    () => ({ registrationCodeRequired: !!opts.registrationCode, voice: !!opts.voice, maxUploadBytes: opts.uploadDir ? maxUpload : 0 }),
    false,
  );

  route(
    'POST',
    '/api/register',
    ({ body }) => {
      const username = cleanName(body.username, 'Username', 32);
      if (!/^[\w.-]+$/.test(username)) throw new HttpError(400, 'Username may only use letters, numbers, _ . -');
      if (typeof body.password !== 'string' || body.password.length < 8)
        throw new HttpError(400, 'Password must be at least 8 characters');
      if (opts.registrationCode && body.registrationCode !== opts.registrationCode)
        throw new HttpError(403, 'Invalid registration code');
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
    ({ body }) => {
      const row = db
        .prepare(`SELECT id, username, ${avatarUrl('avatar')} AS avatar, password_hash FROM users WHERE username = ?`)
        .get(String(body.username ?? '')) as (User & { password_hash: string }) | undefined;
      if (!row || !verifyPassword(String(body.password ?? ''), row.password_hash))
        throw new HttpError(401, 'Wrong username or password');
      return startSession({ id: row.id, username: row.username, avatar: row.avatar });
    },
    false,
  );

  route('POST', '/api/logout', ({ body }) => {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(String(body.token ?? ''));
    return { ok: true };
  });

  route('GET', '/api/me', ({ user }) => user);

  // Changing your password signs you out everywhere else.
  route('POST', '/api/me/password', ({ user, body, token }) => {
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as { password_hash: string };
    if (!verifyPassword(String(body.currentPassword ?? ''), row.password_hash))
      throw new HttpError(403, 'Your current password is wrong');
    if (typeof body.newPassword !== 'string' || body.newPassword.length < 8)
      throw new HttpError(400, 'New password must be at least 8 characters');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(body.newPassword), user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(user.id, token);
    for (const ws of sockets.get(user.id) ?? []) if (socketTokens.get(ws) !== token) ws.close(4001, 'Password changed');
    return { ok: true };
  });

  route('DELETE', '/api/me/avatar', ({ user }) => setAvatarFile(user, null));

  route('GET', '/api/servers', ({ user }) => {
    const ids = db
      .prepare(
        "SELECT m.server_id FROM members m JOIN servers s ON s.id = m.server_id WHERE m.user_id = ? AND s.kind = 'burrow' ORDER BY m.joined_at",
      )
      .all(user.id) as { server_id: number }[];
    return ids.map((r) => serverSummary(r.server_id));
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
    return rows.map((r) => ({ ...serverSummary(r.id), lastActive: r.lastActive }));
  });

  /** Opens your conversation with someone, starting it if needed. You can only start one with people you share a burrow with. */
  route('POST', '/api/dms', ({ user, body }) => {
    const otherId = Number(body.userId);
    if (otherId === user.id) throw new HttpError(400, "You can't message yourself");
    const key = [user.id, otherId].sort((a, b) => a - b).join(':');
    const existing = db.prepare('SELECT id FROM servers WHERE dm_key = ?').get(key) as { id: number } | undefined;
    if (existing) return serverSummary(existing.id);
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
    const summary = serverSummary(serverId);
    broadcastToServer(serverId, { type: 'server_updated', server: summary });
    return summary;
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
    return serverSummary(serverId);
  });

  route('POST', '/api/join', ({ user, body }) => {
    const code = String(body.inviteCode ?? '').trim().split('/').pop();
    const server = db.prepare("SELECT id FROM servers WHERE invite_code = ? AND kind = 'burrow'").get(code ?? '') as
      | { id: number }
      | undefined;
    if (!server) throw new HttpError(404, 'Invite code not found');
    if (!isMember(server.id, user.id)) {
      db.prepare('INSERT INTO members (server_id, user_id, joined_at) VALUES (?, ?, ?)').run(server.id, user.id, now());
      broadcastToServer(server.id, { type: 'server_updated', server: serverSummary(server.id) });
    }
    return serverSummary(server.id);
  });

  route('POST', '/api/servers/:id/leave', ({ user, params }) => {
    const serverId = Number(params[0]);
    const owner = db.prepare("SELECT owner_id FROM servers WHERE id = ? AND kind = 'burrow'").get(serverId) as
      | { owner_id: number }
      | undefined;
    if (!owner || !isMember(serverId, user.id)) throw new HttpError(404, 'Burrow not found');
    if (owner.owner_id === user.id) {
      broadcastToServer(serverId, { type: 'server_deleted', serverId });
      for (const [u, c] of inVoice) if (channelById(c)?.serverId === serverId) inVoice.delete(u);
      removeFiles(
        db
          .prepare('SELECT a.id FROM attachments a JOIN channels c ON c.id = a.channel_id WHERE c.server_id = ?')
          .all(serverId) as Json[],
      );
      db.prepare('DELETE FROM servers WHERE id = ?').run(serverId);
    } else {
      const voiceChannel = inVoice.get(user.id);
      if (voiceChannel !== undefined && channelById(voiceChannel)?.serverId === serverId) setVoice(user.id, null);
      db.prepare('DELETE FROM members WHERE server_id = ? AND user_id = ?').run(serverId, user.id);
      broadcastToServer(serverId, { type: 'server_updated', server: serverSummary(serverId) });
    }
    return { ok: true };
  });

  route('POST', '/api/servers/:id/channels', ({ user, params, body }) => {
    const serverId = Number(params[0]);
    const server = db.prepare("SELECT owner_id FROM servers WHERE id = ? AND kind = 'burrow'").get(serverId) as
      | { owner_id: number }
      | undefined;
    if (!server || !isMember(serverId, user.id)) throw new HttpError(404, 'Burrow not found');
    if (server.owner_id !== user.id) throw new HttpError(403, 'Only the host of this burrow can add rooms');
    const kind = body.kind === 'voice' ? 'voice' : 'text';
    // Text rooms read like #game-night; voice rooms keep their spaces ("Game Night").
    let name = cleanName(body.name, 'Room name', 32);
    if (kind === 'text') name = name.toLowerCase().replace(/\s+/g, '-');
    db.prepare('INSERT INTO channels (server_id, name, kind, created_at) VALUES (?, ?, ?, ?)').run(serverId, name, kind, now());
    const summary = serverSummary(serverId);
    broadcastToServer(serverId, { type: 'server_updated', server: summary });
    return summary;
  });

  route('POST', '/api/channels/:id/voice', ({ user, params }) => {
    const channel = channelById(Number(params[0]));
    if (!channel || !isMember(channel.serverId, user.id)) throw new HttpError(404, 'Room not found');
    if (channel.kind !== 'voice') throw new HttpError(400, 'That is not a voice room');
    if (!opts.voice) throw new HttpError(503, 'Voice is not set up on this server');
    return { url: opts.voice.url ?? null, token: voiceToken(opts.voice, user, `room-${channel.id}`) };
  });

  route('GET', '/api/channels/:id/messages', ({ user, params, url }) => {
    const channel = channelById(Number(params[0]));
    if (!channel || !isMember(channel.serverId, user.id)) throw new HttpError(404, 'Room not found');
    if (channel.kind === 'voice') return [];
    const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
    const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 100);
    const rows = db
      .prepare(
        `SELECT m.id, m.channel_id AS channelId, m.content, m.created_at AS createdAt, m.edited_at AS editedAt,
                m.reply_to AS replyToId, u.id AS authorId, u.username AS author, ${avatarUrl('u.avatar')} AS authorAvatar
         FROM messages m JOIN users u ON u.id = m.author_id
         WHERE m.channel_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`,
      )
      .all(channel.id, before, limit) as Json[];
    return withAttachments(rows.reverse());
  });

  route('POST', '/api/channels/:id/messages', ({ user, params, body }) =>
    postMessage(user, Number(params[0]), body.content, body.attachmentIds, body.replyTo),
  );

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
    db.prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?').run(body.content, now(), id);
    const message = messageById(id)!;
    broadcastToServer(channel.serverId, { type: 'message_updated', message });
    return message;
  });

  // Adds your reaction, or takes it away if you'd already reacted with that emoji.
  route('POST', '/api/messages/:id/reactions', ({ user, params, body }) => {
    const id = Number(params[0]);
    const msg = db.prepare('SELECT channel_id FROM messages WHERE id = ?').get(id) as { channel_id: number } | undefined;
    const channel = msg && channelById(msg.channel_id);
    if (!channel || !isMember(channel.serverId, user.id)) throw new HttpError(404, 'Message not found');
    const emoji = typeof body.emoji === 'string' ? body.emoji.trim() : '';
    if (!emoji || emoji.length > 16 || !EMOJI.test(emoji)) throw new HttpError(400, 'That is not an emoji');
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
    broadcastToServer(channel.serverId, { type: 'reactions', messageId: id, channelId: channel.id, reactions });
    return { reactions };
  });

  route('DELETE', '/api/messages/:id', ({ user, params }) => {
    const id = Number(params[0]);
    const channel = ownMessage(user, id);
    removeFiles(db.prepare('SELECT id FROM attachments WHERE message_id = ?').all(id) as Json[]);
    db.prepare('DELETE FROM messages WHERE id = ?').run(id);
    broadcastToServer(channel.serverId, { type: 'message_deleted', id, channelId: channel.id });
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
    if (!channel || !isMember(channel.serverId, user.id)) throw new HttpError(404, 'Room not found');
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
    db.prepare(
      'INSERT INTO attachments (id, channel_id, uploader_id, name, type, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, channel.id, user.id, name, type, size, now());
    send(res, 200, attachmentJson({ id, name, type, size }));
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

  // ---- profile pictures ---------------------------------------------------

  const avatarPath = (file: string) => join(opts.uploadDir!, 'avatars', file);

  /** Swaps in a new picture file (or none), removes the old one and tells everyone who can see this user. */
  const setAvatarFile = (user: User, file: string | null) => {
    const old = db.prepare('SELECT avatar FROM users WHERE id = ?').get(user.id) as { avatar: string | null };
    db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(file, user.id);
    if (old.avatar && opts.uploadDir) unlink(avatarPath(old.avatar)).catch(() => {});
    const updated = { id: user.id, username: user.username, avatar: file && `/api/avatars/${file}` };
    sendTo(new Set([user.id, ...usersSharingServerWith(user.id)]), { type: 'user_updated', user: updated });
    return updated;
  };

  // The picture is the raw request body. The app shrinks it to a small square before sending.
  const handleAvatarUpload = async (req: IncomingMessage, res: ServerResponse) => {
    const user = userByToken(req.headers.authorization?.replace(/^Bearer /, ''));
    if (!user) throw new HttpError(401, 'Not logged in');
    if (!opts.uploadDir) throw new HttpError(503, 'Uploads are not set up on this server');
    const tooBig = new HttpError(413, `Profile pictures can be at most ${MAX_AVATAR_BYTES / 1048576} MB`);
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
    if (!kind) throw new HttpError(400, 'Profile pictures must be PNG, JPEG, GIF or WebP images');
    const file = `${randomBytes(16).toString('base64url')}.${kind.ext}`;
    await mkdir(join(opts.uploadDir, 'avatars'), { recursive: true });
    await writeFile(avatarPath(file), data);
    send(res, 200, setAvatarFile(user, file));
  };

  // Picture links are unguessable and never reused, so they can be cached forever.
  const serveAvatar = async (req: IncomingMessage, res: ServerResponse, file: string) => {
    const kind = AVATAR_TYPES.find((t) => file.endsWith('.' + t.ext))!;
    const info = opts.uploadDir ? await stat(avatarPath(file)).catch(() => null) : null;
    if (!info) throw new HttpError(404, 'Picture not found');
    res.writeHead(200, {
      'content-type': kind.type,
      'content-length': info.size,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'public, max-age=31536000, immutable',
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(avatarPath(file)).pipe(res);
  };

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

  const serveStatic = async (res: ServerResponse, pathname: string) => {
    const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
    const file = join(opts.publicDir, rel);
    if (!file.startsWith(opts.publicDir)) return send(res, 404, { error: 'Not found' });
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(data);
    } catch {
      // Single-page app: unknown non-API paths get the shell.
      const html = await readFile(join(opts.publicDir, 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html'] });
      res.end(html);
    }
  };

  const server = createServer(async (req, res) => {
    // The desktop client loads its UI locally and talks to this server cross-origin.
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'authorization, content-type, x-filename');
    res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();

    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);

    try {
      const upload = req.method === 'POST' && url.pathname.match(/^\/api\/channels\/(\d+)\/attachments$/);
      if (upload) return await handleUpload(req, res, Number(upload[1]));
      const file = (req.method === 'GET' || req.method === 'HEAD') && url.pathname.match(/^\/api\/attachments\/([\w-]+)(\/|$)/);
      if (file) return await serveAttachment(req, res, file[1]);
      if (req.method === 'POST' && url.pathname === '/api/me/avatar') return await handleAvatarUpload(req, res);
      const avatar = (req.method === 'GET' || req.method === 'HEAD') && url.pathname.match(/^\/api\/avatars\/([\w-]+\.(?:png|jpg|gif|webp))$/);
      if (avatar) return await serveAvatar(req, res, avatar[1]);
      for (const r of routes) {
        const m = r.method === req.method && url.pathname.match(r.pattern);
        if (!m) continue;
        const token = req.headers.authorization?.replace(/^Bearer /, '');
        const user = userByToken(token);
        if (r.auth && !user) throw new HttpError(401, 'Not logged in');
        const body = req.method === 'GET' ? {} : await readBody(req);
        if (url.pathname === '/api/logout') body.token = token;
        return send(res, 200, await r.handler({ user: user!, params: m.slice(1), body, url, token }));
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
          postMessage(user, Number(msg.channelId), msg.content, msg.attachmentIds, msg.replyTo);
        } else if (msg.type === 'voice_join') {
          const channel = channelById(Number(msg.channelId));
          if (!channel || channel.kind !== 'voice' || !isMember(channel.serverId, user.id))
            throw new HttpError(404, 'Room not found');
          setVoice(user.id, channel.id);
        } else if (msg.type === 'voice_leave') {
          setVoice(user.id, null);
        } else if (msg.type === 'typing') {
          const channel = channelById(Number(msg.channelId));
          if (channel && isMember(channel.serverId, user.id))
            sendTo(
              serverMemberIds(channel.serverId).filter((id) => id !== user.id),
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

  server.on('close', () => wss.close());
  return server;
}
