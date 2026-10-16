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

test('direct messages', async () => {
  const reg = async (username: string) => (await call('/api/register', { body: { username, password: 'password1' } })).data;
  const max = await reg('max');
  const sam = await reg('sam');
  const eve = await reg('eve');
  const burrow = (await call('/api/servers', { body: { name: 'Den' }, token: max.token })).data;
  await call('/api/join', { body: { inviteCode: burrow.inviteCode }, token: sam.token });
  const samSocket = listen(sam.token);
  const eveSocket = listen(eve.token);
  await Promise.all([samSocket.ready, eveSocket.ready]);

  // Only people who share a burrow, and not yourself.
  assert.equal((await call('/api/dms', { body: { userId: eve.user.id }, token: max.token })).status, 403);
  assert.equal((await call('/api/dms', { body: { userId: max.user.id }, token: max.token })).status, 400);
  assert.equal((await call('/api/dms', { body: { userId: 9999 }, token: max.token })).status, 403);

  const dm = (await call('/api/dms', { body: { userId: sam.user.id }, token: max.token })).data;
  assert.equal(dm.kind, 'dm');
  assert.equal(dm.inviteCode, undefined);
  assert.deepEqual(dm.members.map((m: any) => m.username).sort(), ['max', 'sam']);
  // Same pair, same conversation, whoever starts it.
  assert.equal((await call('/api/dms', { body: { userId: max.user.id }, token: sam.token })).data.id, dm.id);
  await tick();
  assert.ok(samSocket.events.some((e) => e.type === 'server_updated' && e.server.id === dm.id));

  // Messages work like any room, and only the two of them see them.
  const room = dm.channels[0].id;
  assert.equal((await call(`/api/channels/${room}/messages`, { body: { content: 'psst' }, token: max.token })).status, 200);
  await tick();
  assert.ok(samSocket.events.some((e) => e.type === 'message' && e.message.content === 'psst'));
  assert.ok(!eveSocket.events.some((e) => e.type === 'message'));
  assert.equal((await call(`/api/channels/${room}/messages`, { token: eve.token })).status, 404);
  assert.equal((await call(`/api/channels/${room}/messages`, { token: sam.token })).data[0].content, 'psst');

  // DMs are listed separately from burrows, and can't be joined, left or given rooms.
  assert.deepEqual((await call('/api/servers', { token: sam.token })).data.map((s: any) => s.id), [burrow.id]);
  const dms = (await call('/api/dms', { token: sam.token })).data;
  assert.deepEqual(dms.map((s: any) => s.id), [dm.id]);
  assert.ok(dms[0].lastActive > 0);
  assert.equal((await call('/api/dms', { token: eve.token })).data.length, 0);
  assert.equal((await call(`/api/servers/${dm.id}/channels`, { body: { name: 'x' }, token: max.token })).status, 404);
  assert.equal((await call(`/api/servers/${dm.id}/leave`, { body: {}, token: max.token })).status, 404);

  // The conversation lasts even after they stop sharing a burrow.
  await call(`/api/servers/${burrow.id}/leave`, { body: {}, token: sam.token });
  assert.equal((await call('/api/dms', { body: { userId: sam.user.id }, token: max.token })).data.id, dm.id);
  samSocket.ws.close();
  eveSocket.ws.close();
});

test('closing a conversation hides it until someone writes', async () => {
  const reg = async (username: string) => (await call('/api/register', { body: { username, password: 'password1' } })).data;
  const ann = await reg('ann');
  const bob = await reg('bob');
  const burrow = (await call('/api/servers', { body: { name: 'Nook' }, token: ann.token })).data;
  await call('/api/join', { body: { inviteCode: burrow.inviteCode }, token: bob.token });
  const dm = (await call('/api/dms', { body: { userId: bob.user.id }, token: ann.token })).data;
  const room = dm.channels[0].id;
  await call(`/api/channels/${room}/messages`, { body: { content: 'hi' }, token: bob.token });
  const annSocket = listen(ann.token);
  await annSocket.ready;

  // Only members can close it, and only for themselves.
  assert.equal((await call(`/api/dms/${dm.id}/close`, { body: {}, token: (await reg('cat')).token })).status, 404);
  assert.equal((await call(`/api/dms/${dm.id}/close`, { body: {}, token: ann.token })).status, 200);
  await tick();
  assert.ok(annSocket.events.some((e) => e.type === 'server_deleted' && e.serverId === dm.id));
  assert.equal((await call('/api/dms', { token: ann.token })).data.length, 0);
  assert.equal((await call('/api/dms', { token: bob.token })).data.length, 1);
  // The history is still there.
  assert.equal((await call(`/api/channels/${room}/messages`, { token: ann.token })).data[0].content, 'hi');

  // A new message brings it back, announced before the message itself.
  annSocket.events.length = 0;
  await call(`/api/channels/${room}/messages`, { body: { content: 'you there?' }, token: bob.token });
  await tick();
  const back = annSocket.events.findIndex((e) => e.type === 'server_updated' && e.server.id === dm.id);
  const msg = annSocket.events.findIndex((e) => e.type === 'message' && e.message.content === 'you there?');
  assert.ok(back >= 0 && back < msg);
  // What was in it when it was closed counted as read.
  assert.equal(annSocket.events[back].server.channels[0].unread, 0);
  assert.deepEqual((await call('/api/dms', { token: ann.token })).data.map((s: any) => s.id), [dm.id]);

  // So does messaging them again yourself.
  await call(`/api/dms/${dm.id}/close`, { body: {}, token: ann.token });
  assert.equal((await call('/api/dms', { body: { userId: bob.user.id }, token: ann.token })).data.id, dm.id);
  assert.equal((await call('/api/dms', { token: ann.token })).data.length, 1);
  annSocket.ws.close();
});

test('the list of conversations carries each one\'s newest message', async () => {
  const reg = async (username: string) => (await call('/api/register', { body: { username, password: 'password1' } })).data;
  const ana = await reg('ana');
  const bo = await reg('bo');
  const burrow = (await call('/api/servers', { body: { name: 'Hut' }, token: ana.token })).data;
  await call('/api/join', { body: { inviteCode: burrow.inviteCode }, token: bo.token });
  const dm = (await call('/api/dms', { body: { userId: bo.user.id }, token: ana.token })).data;
  const listed = async () => (await call('/api/dms', { token: ana.token })).data.find((s: any) => s.id === dm.id);
  assert.equal((await listed()).last, null);
  await call(`/api/channels/${dm.channels[0].id}/messages`, { body: { content: 'first' }, token: ana.token });
  const second = (await call(`/api/channels/${dm.channels[0].id}/messages`, { body: { content: 'see you saturday' }, token: bo.token })).data;
  const last = (await listed()).last;
  assert.equal(last.id, second.id);
  assert.equal(last.authorId, bo.user.id);
  assert.equal(last.text, 'see you saturday');
  assert.equal(last.files, 0);
});
