import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { openDb } from '../src/db.ts';
import { createApp } from '../src/app.ts';

const app = createApp({ db: openDb(':memory:'), publicDir: '/nonexistent' });
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

function listen(token: string) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws?token=' + token);
  const events: any[] = [];
  ws.on('message', (d) => events.push(JSON.parse(String(d))));
  const ready = new Promise<void>((r) => ws.once('message', () => r()));
  return { ws, events, ready };
}

const tick = () => new Promise((r) => setTimeout(r, 100));

test('favorite burrows', async () => {
  const reg = async (username: string) => (await call('/api/register', { body: { username, password: 'password1' } })).data;
  const max = await reg('max');
  const sam = await reg('sam');
  const burrows = [];
  for (let i = 1; i <= 6; i++) burrows.push((await call('/api/servers', { body: { name: `B${i}` }, token: max.token })).data);
  const [b1, b2, b3, b4, b5, b6] = burrows.map((b) => b.id);
  const theirs = (await call('/api/servers', { body: { name: 'Sam only' }, token: sam.token })).data;

  assert.deepEqual((await call('/api/me/favorites', { token: max.token })).data, { serverIds: [] });

  // Your other devices hear about it.
  const other = listen(max.token);
  await other.ready;
  const set = await call('/api/me/favorites', { body: { serverIds: [b3, b1] }, token: max.token });
  assert.deepEqual(set.data, { serverIds: [b3, b1] });
  await tick();
  assert.deepEqual(other.events.find((e) => e.type === 'favorites'), { type: 'favorites', serverIds: [b3, b1] });
  other.ws.close();
  assert.deepEqual((await call('/api/me/favorites', { token: max.token })).data, { serverIds: [b3, b1] });

  // At most five, and only burrows you're in.
  assert.equal((await call('/api/me/favorites', { body: { serverIds: [b1, b2, b3, b4, b5, b6] }, token: max.token })).status, 400);
  assert.equal((await call('/api/me/favorites', { body: { serverIds: [theirs.id] }, token: max.token })).status, 404);
  assert.deepEqual((await call('/api/me/favorites', { token: max.token })).data, { serverIds: [b3, b1] });

  // Favorites are per person, and leaving a burrow drops it.
  assert.deepEqual((await call('/api/me/favorites', { token: sam.token })).data, { serverIds: [] });
  await call('/api/join', { body: { inviteCode: burrows[2].inviteCode }, token: sam.token });
  await call('/api/me/favorites', { body: { serverIds: [b3] }, token: sam.token });
  await call(`/api/servers/${b3}/leave`, { method: 'POST', token: sam.token });
  assert.deepEqual((await call('/api/me/favorites', { token: sam.token })).data, { serverIds: [] });
  assert.deepEqual((await call('/api/me/favorites', { token: max.token })).data, { serverIds: [b3, b1] });

  // Clearing them.
  assert.deepEqual((await call('/api/me/favorites', { body: { serverIds: [] }, token: max.token })).data, { serverIds: [] });
});
