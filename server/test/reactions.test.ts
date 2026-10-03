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

test('reactions and replies', async () => {
  const max = (await call('/api/register', { body: { username: 'max', password: 'password1' } })).data;
  const sam = (await call('/api/register', { body: { username: 'sam', password: 'password2' } })).data;
  const eve = (await call('/api/register', { body: { username: 'eve', password: 'password3' } })).data;
  const server = (await call('/api/servers', { body: { name: 'Den' }, token: max.token })).data;
  await call('/api/join', { body: { inviteCode: server.inviteCode }, token: sam.token });
  const room = server.channels[0].id;
  const other = (await call(`/api/servers/${server.id}/channels`, { body: { name: 'other' }, token: max.token })).data.channels[1].id;

  const hello = (await call(`/api/channels/${room}/messages`, { body: { content: 'who wants pizza?' }, token: max.token })).data;
  assert.deepEqual(hello.reactions, []);
  assert.equal(hello.replyTo, null);

  // Reactions toggle, group by emoji and broadcast.
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${max.token}`);
  const events: any[] = [];
  ws.on('message', (raw) => events.push(JSON.parse(String(raw))));
  await new Promise((r) => ws.on('open', r));
  const react = (token: string, emoji: string) => call(`/api/messages/${hello.id}/reactions`, { body: { emoji }, token });
  await react(sam.token, '🍕');
  await react(max.token, '🍕');
  const after3 = (await react(sam.token, '👍🏽')).data.reactions;
  assert.deepEqual(after3, [
    { emoji: '🍕', userIds: [sam.user.id, max.user.id] },
    { emoji: '👍🏽', userIds: [sam.user.id] },
  ]);
  assert.deepEqual((await react(sam.token, '🍕')).data.reactions[0], { emoji: '🍕', userIds: [max.user.id] });
  assert.equal((await react(sam.token, 'lol')).status, 400);
  assert.equal((await react(eve.token, '🍕')).status, 404);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(events.filter((e) => e.type === 'reactions').length, 4);

  // Replies carry a preview of what they answer, from the same room only.
  const reply = (await call(`/api/channels/${room}/messages`, { body: { content: 'me!', replyTo: hello.id }, token: sam.token })).data;
  assert.deepEqual(reply.replyTo, { id: hello.id, content: 'who wants pizza?', authorId: max.user.id, author: 'max', hasAttachments: false });
  assert.equal((await call(`/api/channels/${other}/messages`, { body: { content: 'x', replyTo: hello.id }, token: sam.token })).status, 400);
  assert.equal((await call(`/api/channels/${room}/messages`, { body: { content: 'x', replyTo: 999 }, token: sam.token })).status, 400);

  // History includes both; deleting the original leaves the reply pointing at a deleted message.
  const history = (await call(`/api/channels/${room}/messages`, { token: sam.token })).data;
  assert.equal(history[0].reactions.length, 2);
  assert.equal(history[1].replyTo.id, hello.id);
  await call(`/api/messages/${hello.id}`, { method: 'DELETE', token: max.token });
  const later = (await call(`/api/channels/${room}/messages`, { token: sam.token })).data;
  assert.deepEqual(later[0].replyTo, { deleted: true });
  ws.close();
});
