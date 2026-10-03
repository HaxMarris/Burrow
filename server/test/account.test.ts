import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { openDb } from '../src/db.ts';
import { createApp } from '../src/app.ts';

const uploadDir = join(mkdtempSync(join(tmpdir(), 'burrow-account-')), 'uploads');
const app = createApp({ db: openDb(':memory:'), publicDir: '/nonexistent', uploadDir });
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

const uploadAvatar = (token: string, data: Uint8Array | string, type = 'image/png') =>
  fetch(`${base}/api/me/avatar`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': type }, body: data });

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);

/** Opens a socket and collects its events until closed. */
function listen(token: string) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws?token=' + token);
  const events: any[] = [];
  let closeCode = 0;
  ws.on('message', (d) => events.push(JSON.parse(String(d))));
  const closed = new Promise<void>((r) => ws.on('close', (code) => { closeCode = code; r(); }));
  const ready = new Promise<void>((r) => ws.on('message', () => r()));
  return { ws, events, ready, closed, code: () => closeCode };
}
const tick = () => new Promise((r) => setTimeout(r, 100));

test('changing your password', async () => {
  const laptop = (await call('/api/register', { body: { username: 'max', password: 'password1' } })).data;
  const phone = (await call('/api/login', { body: { username: 'max', password: 'password1' } })).data;
  const phoneSocket = listen(phone.token);
  const laptopSocket = listen(laptop.token);
  await Promise.all([phoneSocket.ready, laptopSocket.ready]);

  const change = (body: unknown) => call('/api/me/password', { body, token: laptop.token });
  assert.equal((await change({ currentPassword: 'nope', newPassword: 'password2' })).status, 403);
  assert.equal((await change({ currentPassword: 'password1', newPassword: 'short' })).status, 400);
  assert.equal((await change({ currentPassword: 'password1', newPassword: 'password2' })).status, 200);

  // This login keeps working; every other one is signed out, including its live connection.
  assert.equal((await call('/api/me', { token: laptop.token })).status, 200);
  assert.equal((await call('/api/me', { token: phone.token })).status, 401);
  await phoneSocket.closed;
  assert.equal(phoneSocket.code(), 4001);
  assert.equal(laptopSocket.ws.readyState, WebSocket.OPEN);
  laptopSocket.ws.close();

  assert.equal((await call('/api/login', { body: { username: 'max', password: 'password1' } })).status, 401);
  assert.equal((await call('/api/login', { body: { username: 'max', password: 'password2' } })).status, 200);
});

test('profile pictures', async () => {
  const sam = (await call('/api/register', { body: { username: 'sam', password: 'password1' } })).data;
  const kit = (await call('/api/register', { body: { username: 'kit', password: 'password1' } })).data;
  const loner = (await call('/api/register', { body: { username: 'loner', password: 'password1' } })).data;
  assert.equal(sam.user.avatar, null);
  const server = (await call('/api/servers', { body: { name: 'Den' }, token: sam.token })).data;
  await call('/api/join', { body: { inviteCode: server.inviteCode }, token: kit.token });
  const room = server.channels[0].id;
  await call(`/api/channels/${room}/messages`, { body: { content: 'hi' }, token: sam.token });

  const kitSocket = listen(kit.token);
  const lonerSocket = listen(loner.token);
  await Promise.all([kitSocket.ready, lonerSocket.ready]);

  // Only real images, and not too big.
  assert.equal((await uploadAvatar(sam.token, '<svg onload="alert(1)"/>', 'image/png')).status, 400);
  assert.equal((await uploadAvatar(sam.token, new Uint8Array(2 * 1024 * 1024 + 1))).status, 413);
  assert.equal((await uploadAvatar('nope', PNG)).status, 401);

  const first = (await (await uploadAvatar(sam.token, PNG)).json()) as any;
  assert.match(first.avatar, /^\/api\/avatars\/[\w-]+\.png$/);
  const img = await fetch(base + first.avatar);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(new Uint8Array(await img.arrayBuffer()), PNG);

  // It shows up wherever sam does.
  assert.equal((await call('/api/me', { token: sam.token })).data.avatar, first.avatar);
  const members = (await call('/api/servers', { token: kit.token })).data[0].members;
  assert.equal(members.find((m: any) => m.username === 'sam').avatar, first.avatar);
  const history = (await call(`/api/channels/${room}/messages`, { token: kit.token })).data;
  assert.equal(history[0].authorAvatar, first.avatar);

  // People sharing a burrow hear about it right away; strangers don't.
  await tick();
  assert.ok(kitSocket.events.some((e) => e.type === 'user_updated' && e.user.avatar === first.avatar));
  assert.ok(!lonerSocket.events.some((e) => e.type === 'user_updated'));

  // A new picture replaces the old file; removing it clears both.
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const second = (await (await uploadAvatar(sam.token, jpeg, 'application/octet-stream')).json()) as any;
  assert.match(second.avatar, /\.jpg$/);
  await tick();
  assert.equal((await fetch(base + first.avatar)).status, 404);
  assert.deepEqual(readdirSync(join(uploadDir, 'avatars')), [second.avatar.split('/').pop()]);

  assert.equal((await call('/api/me/avatar', { method: 'DELETE', token: sam.token })).data.avatar, null);
  await tick();
  assert.deepEqual(readdirSync(join(uploadDir, 'avatars')), []);
  assert.equal((await call('/api/me', { token: sam.token })).data.avatar, null);

  // Odd paths don't reach other files.
  assert.equal((await fetch(base + '/api/avatars/..%2F..%2Fetc%2Fpasswd.png')).status, 404);
  kitSocket.ws.close();
  lonerSocket.ws.close();
});
