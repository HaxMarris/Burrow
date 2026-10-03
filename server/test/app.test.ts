import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { openDb } from '../src/db.ts';
import { createApp } from '../src/app.ts';

const here = dirname(fileURLToPath(import.meta.url));
const app = createApp({ db: openDb(':memory:'), publicDir: resolve(here, '../../client'), registrationCode: 'friends' });
let base = '';

before(async () => {
  await new Promise<void>((r) => app.listen(0, r));
  base = `http://localhost:${(app.address() as AddressInfo).port}`;
});
after(() => {
  app.closeAllConnections();
  app.close();
});

async function call(path: string, opts: { method?: string; body?: unknown; token?: string } = {}) {
  const res = await fetch(base + path, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, data: (await res.json()) as any };
}

function openSocket(token: string) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${token}`);
  const events: any[] = [];
  const waiters: [(e: any) => boolean, (e: any) => void][] = [];
  ws.on('message', (raw) => {
    const e = JSON.parse(String(raw));
    events.push(e);
    for (const w of [...waiters]) if (w[0](e)) { waiters.splice(waiters.indexOf(w), 1); w[1](e); }
  });
  const next = (pred: (e: any) => boolean) =>
    new Promise<any>((resolve, reject) => {
      const found = events.find(pred);
      if (found) return resolve(found);
      waiters.push([pred, resolve]);
      setTimeout(() => reject(new Error('timed out waiting for event')), 2000);
    });
  return { ws, next };
}

test('full chat flow', async () => {
  // Registration requires the code.
  assert.equal((await call('/api/register', { body: { username: 'max', password: 'password1' } })).status, 403);
  const max = (await call('/api/register', { body: { username: 'max', password: 'password1', registrationCode: 'friends' } })).data;
  assert.ok(max.token);
  assert.equal((await call('/api/register', { body: { username: 'MAX', password: 'password1', registrationCode: 'friends' } })).status, 409);
  const sam = (await call('/api/register', { body: { username: 'sam', password: 'password2', registrationCode: 'friends' } })).data;

  // Login.
  assert.equal((await call('/api/login', { body: { username: 'max', password: 'nope' } })).status, 401);
  assert.ok((await call('/api/login', { body: { username: 'max', password: 'password1' } })).data.token);

  // Max creates a server; it comes with #general.
  const server = (await call('/api/servers', { body: { name: 'The Boys' }, token: max.token })).data;
  assert.equal(server.channels[0].name, 'general');
  const general = server.channels[0].id;

  // Sam can't see the channel until joining.
  assert.equal((await call(`/api/channels/${general}/messages`, { token: sam.token })).status, 404);
  const maxWs = openSocket(max.token);
  await maxWs.next((e) => e.type === 'ready');
  const joined = (await call('/api/join', { body: { inviteCode: server.inviteCode }, token: sam.token })).data;
  assert.equal(joined.members.length, 2);
  await maxWs.next((e) => e.type === 'server_updated' && e.server.members.length === 2);

  // Presence: Sam connects, Max sees it.
  const samWs = openSocket(sam.token);
  await samWs.next((e) => e.type === 'ready');
  await maxWs.next((e) => e.type === 'presence' && e.userId === sam.user.id && e.online);

  // Only the owner makes channels.
  assert.equal((await call(`/api/servers/${server.id}/channels`, { body: { name: 'x' }, token: sam.token })).status, 403);
  const withGames = (await call(`/api/servers/${server.id}/channels`, { body: { name: 'Game Night' }, token: max.token })).data;
  assert.equal(withGames.channels[1].name, 'game-night');

  // Realtime message over the socket reaches the other member.
  samWs.ws.send(JSON.stringify({ type: 'send', channelId: general, content: 'hey @max' }));
  const got = await maxWs.next((e) => e.type === 'message');
  assert.equal(got.message.content, 'hey @max');
  assert.equal(got.message.author, 'sam');

  // Typing indicators go to others only.
  maxWs.ws.send(JSON.stringify({ type: 'typing', channelId: general }));
  assert.equal((await samWs.next((e) => e.type === 'typing')).username, 'max');

  // History and pagination.
  for (let i = 0; i < 60; i++) await call(`/api/channels/${general}/messages`, { body: { content: `msg ${i}` }, token: max.token });
  const page1 = (await call(`/api/channels/${general}/messages?limit=50`, { token: sam.token })).data;
  assert.equal(page1.length, 50);
  assert.equal(page1.at(-1).content, 'msg 59');
  const page2 = (await call(`/api/channels/${general}/messages?limit=50&before=${page1[0].id}`, { token: sam.token })).data;
  assert.equal(page2.length, 11);
  assert.equal(page2[0].content, 'hey @max');

  // Edit and delete only your own messages.
  const mine = page1.at(-1);
  assert.equal((await call(`/api/messages/${mine.id}`, { method: 'PATCH', body: { content: 'x' }, token: sam.token })).status, 403);
  const edited = (await call(`/api/messages/${mine.id}`, { method: 'PATCH', body: { content: 'edited!' }, token: max.token })).data;
  assert.ok(edited.editedAt);
  await samWs.next((e) => e.type === 'message_updated' && e.message.content === 'edited!');
  assert.equal((await call(`/api/messages/${mine.id}`, { method: 'DELETE', token: max.token })).status, 200);
  await samWs.next((e) => e.type === 'message_deleted' && e.id === mine.id);

  // Leaving, then offline presence.
  assert.equal((await call(`/api/servers/${server.id}/leave`, { method: 'POST', token: sam.token })).status, 200);
  assert.equal((await call(`/api/channels/${general}/messages`, { token: sam.token })).status, 404);

  // Bad tokens are rejected for HTTP and WebSocket.
  assert.equal((await call('/api/me', { token: 'bogus' })).status, 401);
  const bad = new WebSocket(`${base.replace('http', 'ws')}/ws?token=bogus`);
  await new Promise((r) => bad.on('error', r));

  maxWs.ws.close();
  samWs.ws.close();
});

test('serves the client', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<title>Burrow<\/title>/);
  const traversal = await fetch(base + '/..%2f..%2fserver/package.json');
  assert.doesNotMatch(await traversal.text(), /burrow-chat-server/);
});
