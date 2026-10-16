import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.ts';
import { createApp } from '../src/app.ts';

// Fixes from the full code review (October 2026).
const uploadDir = mkdtempSync(join(tmpdir(), 'peiskos-review-'));
const db = openDb(':memory:');
const app = createApp({ db, publicDir: '/nonexistent', uploadDir });
let base = '';
before(async () => {
  await new Promise<void>((r) => app.listen(0, r));
  base = `http://localhost:${(app.address() as AddressInfo).port}`;
});
after(() => {
  app.closeAllConnections();
  app.close();
  rmSync(uploadDir, { recursive: true, force: true });
});

async function call(path: string, opts: { method?: string; body?: unknown; token?: string } = {}) {
  const res = await fetch(base + path, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, data: (await res.json()) as any };
}
let n = 0;
const reg = async (name: string) => (await call('/api/register', { body: { username: `${name}${++n}`, password: 'password1' } })).data;
const burrowWith = async (host: any, ...others: any[]) => {
  const server = (await call('/api/servers', { body: { name: 'Den' }, token: host.token })).data;
  for (const p of others) await call('/api/join', { body: { inviteCode: server.inviteCode }, token: p.token });
  return server;
};

test('used-up invites stop counting towards the limit', async () => {
  const max = await reg('max');
  const server = await burrowWith(max);
  for (let i = 0; i < 100; i++) assert.equal((await call(`/api/servers/${server.id}/invites`, { body: { maxUses: 1 }, token: max.token })).status, 200);
  assert.equal((await call(`/api/servers/${server.id}/invites`, { body: {}, token: max.token })).status, 400);
  db.prepare('UPDATE invites SET uses = 1').run();
  assert.equal((await call(`/api/servers/${server.id}/invites`, { token: max.token })).data.length, 0);
  assert.equal((await call(`/api/servers/${server.id}/invites`, { body: {}, token: max.token })).status, 200);
});

test("a timed-out member can't start a thread", async () => {
  const [max, sam] = [await reg('max'), await reg('sam')];
  const server = await burrowWith(max, sam);
  const room = server.channels[0].id;
  const m = (await call(`/api/channels/${room}/messages`, { body: { content: 'hi' }, token: max.token })).data;
  await call(`/api/servers/${server.id}/members/${sam.user.id}/timeout`, { body: { minutes: 60 }, token: max.token });
  assert.equal((await call(`/api/messages/${m.id}/thread`, { body: { name: 'sneaky' }, token: sam.token })).status, 403);
  // Opening a thread that's already there still works.
  const t = await call(`/api/messages/${m.id}/thread`, { body: {}, token: max.token });
  assert.equal(t.status, 200);
  assert.equal((await call(`/api/messages/${m.id}/thread`, { body: {}, token: sam.token })).data.threadId, t.data.threadId);
});

test('deleting a message in a thread updates its reply count', async () => {
  const max = await reg('max');
  const server = await burrowWith(max);
  const room = server.channels[0].id;
  const m = (await call(`/api/channels/${room}/messages`, { body: { content: 'start' }, token: max.token })).data;
  const { threadId } = (await call(`/api/messages/${m.id}/thread`, { body: {}, token: max.token })).data;
  const reply = (await call(`/api/channels/${threadId}/messages`, { body: { content: 'one' }, token: max.token })).data;
  await call(`/api/channels/${threadId}/messages`, { body: { content: 'two' }, token: max.token });
  const ws = new (await import('ws')).WebSocket(base.replace('http', 'ws') + '/ws?token=' + max.token);
  const events: any[] = [];
  ws.on('message', (d) => events.push(JSON.parse(String(d))));
  await new Promise((r) => ws.once('message', r));
  await call(`/api/messages/${reply.id}`, { method: 'DELETE', token: max.token });
  await new Promise((r) => setTimeout(r, 100));
  const update = events.find((e) => e.type === 'message_updated' && e.message.id === m.id);
  assert.equal(update?.message.thread.count, 1);
  ws.close();
});

test('changing several hearth settings is all or nothing', async () => {
  const max = await reg('max');
  const server = await burrowWith(max);
  const r = await call(`/api/servers/${server.id}`, { method: 'PATCH', body: { description: 'changed', afkMinutes: 9999 }, token: max.token });
  assert.equal(r.status, 400);
  assert.equal((db.prepare('SELECT description FROM servers WHERE id = ?').get(server.id) as any).description, '');
  assert.equal((await call(`/api/servers/${server.id}`, { method: 'PATCH', body: { description: 'changed', afkMinutes: 20 }, token: max.token })).data.description, 'changed');
});

test('forwarding files follows the upload limit where they land', async () => {
  const [max, sam] = [await reg('max'), await reg('sam')];
  const from = await burrowWith(max, sam);
  const to = await burrowWith(max, sam);
  const room = from.channels[0].id;
  const up = await fetch(`${base}/api/channels/${room}/attachments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${sam.token}`, 'content-type': 'text/plain', 'x-filename': 'a.txt' },
    body: 'hello',
  });
  assert.equal(up.status, 200);
  const file = await up.json();
  const m = (await call(`/api/channels/${room}/messages`, { body: { content: 'file', attachmentIds: [file.id] }, token: sam.token })).data;
  await call(`/api/servers/${to.id}`, { method: 'PATCH', body: { uploadMb: 0 }, token: max.token });
  const r = await call(`/api/messages/${m.id}/forward`, { body: { channelId: to.channels[0].id }, token: sam.token });
  assert.equal(r.status, 403);
  // Nothing is left waiting from the refused forward.
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE message_id IS NULL').get() as any).n, 0);
});

test('a failed forward leaves no copied files behind', async () => {
  const [max, sam] = [await reg('max'), await reg('sam')];
  const from = await burrowWith(max, sam);
  const to = await burrowWith(max, sam);
  const room = from.channels[0].id;
  const up = await fetch(`${base}/api/channels/${room}/attachments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${sam.token}`, 'content-type': 'text/plain', 'x-filename': 'a.txt' },
    body: 'hello',
  });
  const file = await up.json();
  const m = (await call(`/api/channels/${room}/messages`, { body: { content: 'file', attachmentIds: [file.id] }, token: sam.token })).data;
  await call(`/api/servers/${to.id}/members/${sam.user.id}/timeout`, { body: { minutes: 10 }, token: max.token });
  assert.equal((await call(`/api/messages/${m.id}/forward`, { body: { channelId: to.channels[0].id }, token: sam.token })).status, 403);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE message_id IS NULL').get() as any).n, 0);
});

test('asking for a conversation with yourself or someone twice finds the same one', async () => {
  const [max, sam] = [await reg('max'), await reg('sam')];
  await burrowWith(max, sam);
  const dm = (await call('/api/dms', { body: { userId: sam.user.id }, token: max.token })).data;
  for (const userIds of [[sam.user.id, sam.user.id], [max.user.id, sam.user.id]]) {
    const r = await call('/api/dms', { body: { userIds }, token: max.token });
    assert.equal(r.status, 200);
    assert.equal(r.data.id, dm.id);
  }
});

test('passkey login options are limited per address', async () => {
  const statuses: number[] = [];
  for (let i = 0; i < 35; i++) statuses.push((await call('/api/login/passkey/options', { body: {} })).status);
  assert.equal(statuses.filter((s) => s === 200).length, 30);
  assert.equal(statuses.at(-1), 429);
});

test("a deleted message's id isn't given to the next one", async () => {
  const max = await reg('max');
  const server = await burrowWith(max);
  const room = server.channels[0].id;
  const typo = (await call(`/api/channels/${room}/messages`, { body: { content: 'oops typo' }, token: max.token })).data;
  await call(`/api/messages/${typo.id}`, { method: 'DELETE', token: max.token });
  const fixed = (await call(`/api/channels/${room}/messages`, { body: { content: 'the real message' }, token: max.token })).data;
  assert.ok(fixed.id > typo.id);
});

test('a backup cut off halfway is made again, not kept as that day\'s', async () => {
  const { backupNow } = await import('../src/backup.ts');
  const { writeFileSync, readdirSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'peiskos-backup-'));
  const day = new Date(Date.UTC(2026, 9, 16));
  // What an interrupted copy leaves behind.
  writeFileSync(join(dir, 'burrow-2026-10-16.db.part'), 'half a database');
  const file = await backupNow(db, dir, 3, day);
  assert.deepEqual(readdirSync(dir).sort(), ['burrow-2026-10-16.db']);
  const copy = openDb(file);
  assert.ok(copy.prepare('SELECT COUNT(*) AS n FROM users').get());
  copy.close();
  rmSync(dir, { recursive: true, force: true });
});
