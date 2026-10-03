import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import type { Db } from './db.ts';
import { hashPassword, verifyPassword, newToken, newInviteCode } from './auth.ts';

export interface AppOptions {
  db: Db;
  publicDir: string;
  /** When set, new accounts must supply this code to register. */
  registrationCode?: string;
}

type User = { id: number; username: string };
type Json = Record<string, unknown>;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MAX_MESSAGE_LENGTH = 4000;
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
      .prepare('SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?')
      .get(token) as User | undefined;
  };

  const isMember = (serverId: number, userId: number) =>
    !!db.prepare('SELECT 1 FROM members WHERE server_id = ? AND user_id = ?').get(serverId, userId);

  const channelById = (id: number) =>
    db.prepare('SELECT id, server_id AS serverId, name FROM channels WHERE id = ?').get(id) as
      | { id: number; serverId: number; name: string }
      | undefined;

  const serverMemberIds = (serverId: number) =>
    (db.prepare('SELECT user_id FROM members WHERE server_id = ?').all(serverId) as { user_id: number }[]).map(
      (r) => r.user_id,
    );

  const messageById = (id: number) =>
    db
      .prepare(
        `SELECT m.id, m.channel_id AS channelId, m.content, m.created_at AS createdAt, m.edited_at AS editedAt,
                u.id AS authorId, u.username AS author
         FROM messages m JOIN users u ON u.id = m.author_id WHERE m.id = ?`,
      )
      .get(id) as Json | undefined;

  const serverSummary = (serverId: number) => {
    const server = db
      .prepare('SELECT id, name, owner_id AS ownerId, invite_code AS inviteCode FROM servers WHERE id = ?')
      .get(serverId) as Json;
    const channels = db
      .prepare('SELECT id, name FROM channels WHERE server_id = ? ORDER BY id')
      .all(serverId);
    const members = db
      .prepare(
        'SELECT u.id, u.username FROM members m JOIN users u ON u.id = m.user_id WHERE m.server_id = ? ORDER BY u.username',
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
  const online = new Set<number>();

  const sendTo = (userIds: Iterable<number>, event: Json) => {
    const data = JSON.stringify(event);
    for (const id of userIds) for (const ws of sockets.get(id) ?? []) if (ws.readyState === WebSocket.OPEN) ws.send(data);
  };

  const broadcastToServer = (serverId: number, event: Json) => sendTo(serverMemberIds(serverId), event);

  const usersSharingServerWith = (userId: number) =>
    (
      db
        .prepare(
          'SELECT DISTINCT b.user_id FROM members a JOIN members b ON a.server_id = b.server_id WHERE a.user_id = ?',
        )
        .all(userId) as { user_id: number }[]
    ).map((r) => r.user_id);

  const postMessage = (user: User, channelId: number, content: unknown) => {
    const channel = channelById(channelId);
    if (!channel || !isMember(channel.serverId, user.id)) throw new HttpError(404, 'Room not found');
    if (typeof content !== 'string' || !content.trim()) throw new HttpError(400, 'Message is empty');
    if (content.length > MAX_MESSAGE_LENGTH) throw new HttpError(400, 'Message is too long');
    const r = db
      .prepare('INSERT INTO messages (channel_id, author_id, content, created_at) VALUES (?, ?, ?, ?)')
      .run(channelId, user.id, content, now());
    const message = messageById(Number(r.lastInsertRowid))!;
    broadcastToServer(channel.serverId, { type: 'message', message });
    return message;
  };

  // ---- HTTP routes --------------------------------------------------------

  type Handler = (ctx: { user: User; params: string[]; body: Json; url: URL }) => unknown;
  type Route = { method: string; pattern: RegExp; auth: boolean; handler: Handler };
  const routes: Route[] = [];
  const route = (method: string, path: string, handler: Handler, auth = true) =>
    routes.push({ method, pattern: new RegExp('^' + path.replace(/:\w+/g, '(\\d+)') + '$'), auth, handler });

  route(
    'GET',
    '/api/config',
    () => ({ registrationCodeRequired: !!opts.registrationCode }),
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
      return startSession({ id: Number(r.lastInsertRowid), username });
    },
    false,
  );

  route(
    'POST',
    '/api/login',
    ({ body }) => {
      const row = db
        .prepare('SELECT id, username, password_hash FROM users WHERE username = ?')
        .get(String(body.username ?? '')) as (User & { password_hash: string }) | undefined;
      if (!row || !verifyPassword(String(body.password ?? ''), row.password_hash))
        throw new HttpError(401, 'Wrong username or password');
      return startSession({ id: row.id, username: row.username });
    },
    false,
  );

  route('POST', '/api/logout', ({ body }) => {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(String(body.token ?? ''));
    return { ok: true };
  });

  route('GET', '/api/me', ({ user }) => user);

  route('GET', '/api/servers', ({ user }) => {
    const ids = db
      .prepare('SELECT server_id FROM members WHERE user_id = ? ORDER BY joined_at')
      .all(user.id) as { server_id: number }[];
    return ids.map((r) => serverSummary(r.server_id));
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
    const server = db.prepare('SELECT id FROM servers WHERE invite_code = ?').get(code ?? '') as
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
    const owner = db.prepare('SELECT owner_id FROM servers WHERE id = ?').get(serverId) as
      | { owner_id: number }
      | undefined;
    if (!owner || !isMember(serverId, user.id)) throw new HttpError(404, 'Burrow not found');
    if (owner.owner_id === user.id) {
      broadcastToServer(serverId, { type: 'server_deleted', serverId });
      db.prepare('DELETE FROM servers WHERE id = ?').run(serverId);
    } else {
      db.prepare('DELETE FROM members WHERE server_id = ? AND user_id = ?').run(serverId, user.id);
      broadcastToServer(serverId, { type: 'server_updated', server: serverSummary(serverId) });
    }
    return { ok: true };
  });

  route('POST', '/api/servers/:id/channels', ({ user, params, body }) => {
    const serverId = Number(params[0]);
    const server = db.prepare('SELECT owner_id FROM servers WHERE id = ?').get(serverId) as
      | { owner_id: number }
      | undefined;
    if (!server || !isMember(serverId, user.id)) throw new HttpError(404, 'Burrow not found');
    if (server.owner_id !== user.id) throw new HttpError(403, 'Only the host of this burrow can add rooms');
    const name = cleanName(body.name, 'Room name', 32).toLowerCase().replace(/\s+/g, '-');
    db.prepare('INSERT INTO channels (server_id, name, created_at) VALUES (?, ?, ?)').run(serverId, name, now());
    const summary = serverSummary(serverId);
    broadcastToServer(serverId, { type: 'server_updated', server: summary });
    return summary;
  });

  route('GET', '/api/channels/:id/messages', ({ user, params, url }) => {
    const channel = channelById(Number(params[0]));
    if (!channel || !isMember(channel.serverId, user.id)) throw new HttpError(404, 'Room not found');
    const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
    const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 100);
    const rows = db
      .prepare(
        `SELECT m.id, m.channel_id AS channelId, m.content, m.created_at AS createdAt, m.edited_at AS editedAt,
                u.id AS authorId, u.username AS author
         FROM messages m JOIN users u ON u.id = m.author_id
         WHERE m.channel_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`,
      )
      .all(channel.id, before, limit);
    return rows.reverse();
  });

  route('POST', '/api/channels/:id/messages', ({ user, params, body }) =>
    postMessage(user, Number(params[0]), body.content),
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
    if (typeof body.content !== 'string' || !body.content.trim()) throw new HttpError(400, 'Message is empty');
    if (body.content.length > MAX_MESSAGE_LENGTH) throw new HttpError(400, 'Message is too long');
    db.prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?').run(body.content, now(), id);
    const message = messageById(id)!;
    broadcastToServer(channel.serverId, { type: 'message_updated', message });
    return message;
  });

  route('DELETE', '/api/messages/:id', ({ user, params }) => {
    const id = Number(params[0]);
    const channel = ownMessage(user, id);
    db.prepare('DELETE FROM messages WHERE id = ?').run(id);
    broadcastToServer(channel.serverId, { type: 'message_deleted', id, channelId: channel.id });
    return { ok: true };
  });

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
    res.setHeader('access-control-allow-headers', 'authorization, content-type');
    res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();

    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);

    try {
      for (const r of routes) {
        const m = r.method === req.method && url.pathname.match(r.pattern);
        if (!m) continue;
        const token = req.headers.authorization?.replace(/^Bearer /, '');
        const user = userByToken(token);
        if (r.auth && !user) throw new HttpError(401, 'Not logged in');
        const body = req.method === 'GET' ? {} : await readBody(req);
        if (url.pathname === '/api/logout') body.token = token;
        return send(res, 200, await r.handler({ user: user!, params: m.slice(1), body, url }));
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
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, user));
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
          postMessage(user, Number(msg.channelId), msg.content);
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
        sendTo(usersSharingServerWith(user.id), { type: 'presence', userId: user.id, online: false });
      }
    });
  };

  server.on('close', () => wss.close());
  return server;
}
