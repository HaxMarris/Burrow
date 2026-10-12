import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { openDb } from '../src/db.ts';
import { createApp } from '../src/app.ts';

// LiveKit's API, for removing people from rooms; it only has to answer.
const fakeLiveKit = createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{}'));
const voice = { apiKey: 'devkey', apiSecret: 'a-secret-that-is-at-least-32-characters-long', apiUrl: '' };
const db = openDb(':memory:');
let app: Server;
let base = '';
before(async () => {
  await new Promise<void>((r) => fakeLiveKit.listen(0, r));
  voice.apiUrl = `http://localhost:${(fakeLiveKit.address() as AddressInfo).port}`;
  app = createApp({ db, publicDir: '/nonexistent', voice, uploadDir: join(mkdtempSync(join(tmpdir(), 'peiskos-extras-')), 'uploads') });
  await new Promise<void>((r) => app.listen(0, r));
  base = `http://localhost:${(app.address() as AddressInfo).port}`;
});
after(() => {
  fakeLiveKit.close();
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
const reg = async (username: string) => (await call('/api/register', { body: { username, password: 'password1' } })).data;
function socket(token: string) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${token}`);
  const events: any[] = [];
  ws.on('message', (raw) => events.push(JSON.parse(String(raw))));
  const next = async (pred: (e: any) => boolean) => {
    for (let i = 0; i < 100; i++) {
      const at = events.findIndex(pred);
      if (at >= 0) return events.splice(at, 1)[0];
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('no such event');
  };
  return { ws, events, next };
}
/** Makes a room and gives back its id (making one returns the whole hearth). */
const addRoom = async (serverId: number, token: string, body: object) =>
  (await call(`/api/servers/${serverId}/channels`, { body, token })).data.channels.find((c: any) => c.name.toLowerCase() === (body as any).name.toLowerCase()).id as number;
const HOUR = 3600_000;
/** Pretends someone sat at a fire for a while, a year ago or this year. */
const sat = (userId: number, serverId: number, channelId: number, hours: number, at = Date.now() - 2 * HOUR * hours) =>
  db.prepare('INSERT INTO voice_time (user_id, server_id, channel_id, started_at, ended_at) VALUES (?, ?, ?, ?, ?)').run(userId, serverId, channelId, at, at + hours * HOUR);

test('time at the fire is counted, and unlocks things by your seat and the hearth\'s fire', async () => {
  const max = await reg('max');
  const sam = await reg('sam');
  const s = (await call('/api/servers', { body: { name: 'Lodge' }, token: max.token })).data;
  await call('/api/join', { body: { inviteCode: s.inviteCode }, token: sam.token });
  const fireId = await addRoom(s.id, max.token, { name: 'Fire', kind: 'voice' });

  // Sitting down and getting up again leaves a visit behind.
  const ws = socket(sam.token);
  await ws.next((e) => e.type === 'ready');
  ws.ws.send(JSON.stringify({ type: 'voice_join', channelId: fireId }));
  await ws.next((e) => e.type === 'voice_state' && e.userIds.length === 1);
  // Not enough time for marshmallows yet.
  assert.equal((await call('/api/voice/marshmallow', { body: {}, token: sam.token })).status, 403);
  ws.ws.send(JSON.stringify({ type: 'voice_leave' }));
  await ws.next((e) => e.type === 'voice_state' && e.userIds.length === 0);
  const visit = db.prepare('SELECT server_id, channel_id, ended_at >= started_at AS ok FROM voice_time WHERE user_id = ?').get(sam.user.id) as any;
  assert.deepEqual({ ...visit }, { server_id: s.id, channel_id: fireId, ok: 1 });

  let mine = (await call('/api/me/fire', { token: sam.token })).data;
  assert.ok(mine.hours < 0.1);
  assert.equal(mine.item, null);
  assert.equal((await call('/api/me/fire', { method: 'PUT', body: { item: 'cocoa' }, token: sam.token })).status, 403);
  sat(sam.user.id, s.id, fireId, 12);
  mine = (await call('/api/me/fire', { method: 'PUT', body: { item: 'guitar' }, token: sam.token })).data;
  assert.equal(mine.item, 'guitar');
  assert.equal((await call('/api/me/fire', { method: 'PUT', body: { item: 'bear' }, token: sam.token })).status, 403);
  assert.equal((await call('/api/me/fire', { method: 'PUT', body: { item: 'nope' }, token: sam.token })).status, 400);
  // Everyone in the hearth sees what's by your seat.
  const lodge = (await call('/api/servers', { token: max.token })).data.find((x: any) => x.id === s.id);
  assert.equal(lodge.members.find((m: any) => m.id === sam.user.id).fireItem, 'guitar');

  // The hearth's fire: 12 hours there unlock birch logs, not sparks; only people who can edit the hearth change it.
  const f = (await call(`/api/servers/${s.id}/fire`, { token: sam.token })).data;
  assert.ok(f.hours >= 12);
  assert.equal(f.look, 'classic');
  assert.equal(f.canChange, false);
  assert.equal((await call(`/api/servers/${s.id}/fire`, { method: 'PUT', body: { look: 'birch' }, token: sam.token })).status, 403);
  assert.equal((await call(`/api/servers/${s.id}/fire`, { method: 'PUT', body: { look: 'sparks' }, token: max.token })).status, 403);
  assert.equal((await call(`/api/servers/${s.id}/fire`, { method: 'PUT', body: { look: 'birch' }, token: max.token })).data.look, 'birch');
  assert.equal((await call('/api/servers', { token: sam.token })).data.find((x: any) => x.id === s.id).fireLook, 'birch');
  // Time at the AFK fire doesn't count.
  const afkId = await addRoom(s.id, max.token, { name: 'AFK', kind: 'voice' });
  db.prepare('UPDATE servers SET afk_channel_id = ? WHERE id = ?').run(afkId, s.id);
  sat(max.user.id, s.id, afkId, 50);
  assert.ok((await call(`/api/servers/${s.id}/fire`, { token: max.token })).data.hours < 13);

  // Marshmallows: everyone at the fire hears how it went, and not too often.
  ws.ws.send(JSON.stringify({ type: 'voice_join', channelId: fireId }));
  await ws.next((e) => e.type === 'voice_state' && e.userIds.length === 1);
  const toast = await call('/api/voice/marshmallow', { body: {}, token: sam.token });
  assert.equal(toast.status, 200);
  const heard = await ws.next((e) => e.type === 'marshmallow');
  assert.equal(heard.userId, sam.user.id);
  assert.equal(heard.outcome, toast.data.outcome);
  assert.equal((await call('/api/voice/marshmallow', { body: {}, token: sam.token })).status, 429);
  assert.equal((await call('/api/voice/marshmallow', { body: {}, token: max.token })).status, 400);
  ws.ws.close();
});

test('birthdays', async () => {
  const ana = await reg('ana');
  const bo = await reg('bo');
  const s = (await call('/api/servers', { body: { name: 'Party' }, token: ana.token })).data;
  await call('/api/join', { body: { inviteCode: s.inviteCode }, token: bo.token });
  for (const bad of ['13-01', '02-30', '2-3', 'March 3']) assert.equal((await call('/api/me', { method: 'PATCH', body: { birthday: bad }, token: ana.token })).status, 400, bad);
  assert.equal((await call('/api/me', { method: 'PATCH', body: { birthday: '02-29' }, token: ana.token })).data.birthday, '02-29');
  const party = (await call('/api/servers', { token: bo.token })).data.find((x: any) => x.id === s.id);
  assert.equal(party.members.find((m: any) => m.id === ana.user.id).birthday, '02-29');
  assert.equal((await call(`/api/users/${ana.user.id}`, { token: bo.token })).data.birthday, '02-29');
  assert.equal((await call('/api/me', { method: 'PATCH', body: { birthday: null }, token: ana.token })).data.birthday, null);
});

test('message of the day', async () => {
  const kim = await reg('kim');
  const lu = await reg('lu');
  const s = (await call('/api/servers', { body: { name: 'Daily' }, token: kim.token })).data;
  await call('/api/join', { body: { inviteCode: s.inviteCode }, token: lu.token });
  assert.equal((await call(`/api/servers/${s.id}/motd`, { body: { text: 'Hi' }, token: lu.token })).status, 403);
  assert.equal((await call(`/api/servers/${s.id}/motd`, { body: { text: '  ' }, token: kim.token })).status, 400);
  let r = await call(`/api/servers/${s.id}/motd`, { body: { text: 'Drink water' }, token: kim.token });
  assert.deepEqual(r.data.motd.map((m: any) => m.text), ['Drink water']);
  // With a photo.
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  const res = await fetch(`${base}/api/servers/${s.id}/motd/picture?text=${encodeURIComponent('The view')}`, {
    method: 'POST', headers: { authorization: `Bearer ${kim.token}`, 'content-type': 'image/png' }, body: png,
  });
  r = { status: res.status, data: await res.json() };
  assert.equal(r.status, 200);
  const photo = r.data.motd[1];
  assert.equal(photo.text, 'The view');
  assert.match(photo.picture, /^\/api\/burrow-pictures\/[\w-]+\.png$/);
  assert.equal((await fetch(base + photo.picture)).status, 200);
  const daily = (await call('/api/servers', { token: lu.token })).data.find((x: any) => x.id === s.id);
  assert.equal(daily.motd.length, 2);
  assert.equal((await call(`/api/motd/${photo.id}`, { method: 'PATCH', body: { text: 'Our view' }, token: kim.token })).data.motd[1].text, 'Our view');
  assert.equal((await call(`/api/motd/${photo.id}`, { method: 'DELETE', token: lu.token })).status, 403);
  assert.equal((await call(`/api/motd/${photo.id}`, { method: 'DELETE', token: kim.token })).data.motd.length, 1);
});

test('the year in review', async () => {
  const one = await reg('one');
  const two = await reg('two');
  const s = (await call('/api/servers', { body: { name: 'Recap' }, token: one.token })).data;
  await call('/api/join', { body: { inviteCode: s.inviteCode }, token: two.token });
  const general = s.channels.find((c: any) => c.kind === 'text').id;
  const gamesId = await addRoom(s.id, one.token, { name: 'games', kind: 'text' });
  const secretId = await addRoom(s.id, one.token, { name: 'secret', kind: 'text', private: true });
  for (let i = 0; i < 3; i++) await call(`/api/channels/${gamesId}/messages`, { body: { content: `gg ${i}` }, token: two.token });
  const loved = (await call(`/api/channels/${general}/messages`, { body: { content: 'pizza tonight?' }, token: one.token })).data;
  for (let i = 0; i < 5; i++) await call(`/api/channels/${secretId}/messages`, { body: { content: 'shh' }, token: one.token });
  await call(`/api/messages/${loved.id}/reactions`, { body: { emoji: '🍕' }, token: two.token });
  await call(`/api/messages/${loved.id}/reactions`, { body: { emoji: '🍕' }, token: one.token });
  const fireId = await addRoom(s.id, one.token, { name: 'Fire', kind: 'voice' });
  sat(two.user.id, s.id, fireId, 3);
  // Last year's fire doesn't count this year.
  sat(one.user.id, s.id, fireId, 7, Date.UTC(new Date().getUTCFullYear() - 1, 5, 1));

  const year = new Date().getUTCFullYear();
  const mine = (await call(`/api/servers/${s.id}/review/${year}`, { token: one.token })).data;
  assert.equal(mine.messages, 9);
  assert.equal(mine.topRooms[0].name, 'secret');
  const theirs = (await call(`/api/servers/${s.id}/review/${year}`, { token: two.token })).data;
  // The private room isn't theirs to see.
  assert.equal(theirs.messages, 4);
  assert.deepEqual(theirs.topRooms.map((r: any) => [r.name, r.messages]), [['games', 3], ['general', 1]]);
  assert.deepEqual(theirs.topReactions, [{ emoji: '🍕', n: 2 }]);
  assert.equal(theirs.mostLoved.content, 'pizza tonight?');
  assert.equal(theirs.mostLoved.reactions, 2);
  assert.deepEqual(theirs.topPeople.map((p: any) => [p.name, p.n]), [['two', 3], ['one', 1]]);
  assert.equal(Math.round(theirs.fireHours), 3);
  assert.equal(theirs.topFire[0].name, 'two');
  assert.equal(Math.round(theirs.you.fireHours), 3);
  assert.equal(theirs.you.messages, 3);
  assert.equal(theirs.you.reactions, 1);
  assert.equal(theirs.newPeople, 2);
  assert.ok(theirs.years.includes(year));
  const last = (await call(`/api/servers/${s.id}/review/${year - 1}`, { token: one.token })).data;
  assert.equal(Math.round(last.fireHours), 7);
  assert.equal(last.messages, 0);
  const outsider = await reg('three');
  assert.equal((await call(`/api/servers/${s.id}/review/${year}`, { token: outsider.token })).status, 404);
});
