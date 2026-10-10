import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { openDb } from '../src/db.ts';
import { createApp } from '../src/app.ts';

const db = openDb(':memory:');
const app = createApp({ db, publicDir: '/nonexistent' });
let base = '';
const checkClock = () => (app as unknown as { checkClock: () => void }).checkClock();

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
  ws.on('message', (raw) => events.push(JSON.parse(String(raw))));
  const next = (pred: (e: any) => boolean, ms = 3000) =>
    new Promise<any>((resolve, reject) => {
      const started = Date.now();
      const look = () => {
        const found = events.find(pred);
        if (found) return resolve(found);
        if (Date.now() - started > ms) return reject(new Error('timed out waiting for event'));
        setTimeout(look, 10);
      };
      look();
    });
  return { ws, events, next, opened: new Promise((r) => ws.on('open', r)) };
}

let n = 0;
async function people(...names: string[]) {
  const out: any[] = [];
  for (const name of names) out.push((await call('/api/register', { body: { username: `${name}${++n}`, password: 'password1' } })).data);
  return out;
}
async function burrow(host: any, ...others: any[]) {
  const server = (await call('/api/servers', { body: { name: 'Den' }, token: host.token })).data;
  for (const o of others) await call('/api/join', { body: { inviteCode: server.inviteCode }, token: o.token });
  return { server, room: server.channels[0].id as number };
}
const say = (room: number, who: { token: string }, content: string) =>
  call(`/api/channels/${room}/messages`, { body: { content }, token: who.token });
const addRoom = async (serverId: number, who: any, name: string, extra = {}) => {
  const s = (await call(`/api/servers/${serverId}/channels`, { body: { name, ...extra }, token: who.token })).data;
  return s.channels.find((c: any) => c.name === name).id as number;
};

test('room order, headings and topics', async () => {
  const [max, sam] = await people('max', 'sam');
  const { server, room: general } = await burrow(max, sam);
  const games = await addRoom(server.id, max, 'games');
  const news = await addRoom(server.id, max, 'news');
  const g = (await call(`/api/servers/${server.id}/groups`, { body: { name: 'Hangout' }, token: max.token })).data.groups[0];
  assert.equal((await call(`/api/servers/${server.id}/groups`, { body: { name: 'Nope' }, token: sam.token })).status, 403);

  const laid = (
    await call(`/api/servers/${server.id}/layout`, {
      body: { rooms: [{ id: news }, { id: games, groupId: g.id }, { id: general, groupId: g.id }] },
      token: max.token,
    })
  ).data;
  assert.deepEqual(laid.channels.map((c: any) => [c.name, c.groupId]), [['news', null], ['games', g.id], ['general', g.id]]);
  assert.equal((await call(`/api/servers/${server.id}/layout`, { body: { rooms: [] }, token: sam.token })).status, 403);

  // Deleting the heading keeps its rooms.
  const after = (await call(`/api/groups/${g.id}`, { method: 'DELETE', token: max.token })).data;
  assert.deepEqual(after.channels.map((c: any) => c.groupId), [null, null, null]);
  assert.deepEqual(after.groups, []);

  const topic = (await call(`/api/channels/${games}`, { method: 'PATCH', body: { topic: '  Friday nights  ' }, token: max.token })).data;
  assert.equal(topic.channels.find((c: any) => c.id === games).topic, 'Friday nights');
  assert.equal((await call(`/api/channels/${games}`, { method: 'PATCH', body: { topic: 'x'.repeat(201) }, token: max.token })).status, 400);
});

test('slow mode, announcement rooms and archiving', async () => {
  const [max, sam, mia] = await people('max', 'sam', 'mia');
  const { server, room } = await burrow(max, sam, mia);
  await call(`/api/channels/${room}`, { method: 'PATCH', body: { slow: 30 }, token: max.token });
  assert.equal((await say(room, sam, 'one')).status, 200);
  const second = await say(room, sam, 'two');
  assert.equal(second.status, 429);
  assert.match(second.data.error, /Slow mode/);
  // People who manage rooms aren't held back.
  assert.equal((await say(room, max, 'a')).status, 200);
  assert.equal((await say(room, max, 'b')).status, 200);

  const news = await addRoom(server.id, max, 'news');
  const roles = (await call(`/api/servers/${server.id}/roles`, { body: { name: 'Writers' }, token: max.token })).data.roles;
  const writers = roles.find((r: any) => r.name === 'Writers');
  await call(`/api/servers/${server.id}/members/${mia.user.id}/roles`, { body: { roleIds: [writers.id] }, token: max.token });
  const s = (await call(`/api/channels/${news}`, { method: 'PATCH', body: { announce: true, postRoleIds: [writers.id] }, token: max.token })).data;
  assert.deepEqual(s.channels.find((c: any) => c.id === news).postRoleIds, [writers.id]);
  assert.equal((await say(news, sam, 'hi')).status, 403);
  assert.equal((await say(news, mia, 'news!')).status, 200);
  const samView = (await call('/api/servers', { token: sam.token })).data.find((x: any) => x.id === server.id);
  assert.equal(samView.channels.find((c: any) => c.id === news).canPost, false);
  assert.equal(samView.channels.find((c: any) => c.id === news).postRoleIds, undefined);

  // Archived rooms keep their messages but take no new ones.
  const old = await addRoom(server.id, max, 'old');
  await say(old, sam, 'before');
  const archived = (await call(`/api/channels/${old}`, { method: 'PATCH', body: { archived: true }, token: max.token })).data;
  assert.equal(archived.channels.find((c: any) => c.id === old).archived, true);
  assert.equal((await say(old, max, 'after')).status, 403);
  assert.equal((await call(`/api/channels/${old}/messages`, { token: sam.token })).data.length, 1);
  await call(`/api/channels/${old}`, { method: 'PATCH', body: { archived: false }, token: max.token });
  assert.equal((await say(old, max, 'back')).status, 200);
});

test('invite links that run out, the invite page and a new code', async () => {
  const [max, sam, mia, ola, eve] = await people('max', 'sam', 'mia', 'ola', 'eve');
  const { server } = await burrow(max, sam);
  // Anyone in the burrow can make one.
  const made = (await call(`/api/servers/${server.id}/invites`, { body: { maxUses: 1, expiresIn: 3600 }, token: sam.token })).data;
  assert.equal(made.invites.length, 1);

  const page = await call(`/api/invites/${made.code}`);
  assert.equal(page.status, 200);
  assert.equal(page.data.name, 'Den');
  assert.equal(page.data.members, 2);
  assert.equal(page.data.inviteCode, undefined);

  assert.equal((await call('/api/join', { body: { inviteCode: `https://burrow.example/invite/${made.code}` }, token: mia.token })).status, 200);
  const usedUp = await call('/api/join', { body: { inviteCode: made.code }, token: ola.token });
  assert.equal(usedUp.status, 410);
  assert.match(usedUp.data.error, /used up/);
  assert.equal((await call(`/api/invites/${made.code}`)).status, 410);

  // Max sees everyone's invites, Sam only his own; a new permanent code retires the old one.
  await call(`/api/servers/${server.id}/invites`, { body: {}, token: max.token });
  assert.equal((await call(`/api/servers/${server.id}/invites`, { token: max.token })).data.length, 1);
  assert.equal((await call(`/api/servers/${server.id}/invites`, { token: sam.token })).data.length, 0);
  assert.equal((await call(`/api/servers/${server.id}/invite-code`, { body: {}, token: sam.token })).status, 403);
  const fresh = (await call(`/api/servers/${server.id}/invite-code`, { body: {}, token: max.token })).data;
  assert.notEqual(fresh.inviteCode, server.inviteCode);
  assert.equal((await call('/api/join', { body: { inviteCode: server.inviteCode }, token: eve.token })).status, 404);
  assert.equal((await call('/api/join', { body: { inviteCode: fresh.inviteCode }, token: eve.token })).status, 200);

  // Invite links open the app with the code, which shows the burrow before joining.
  const link = await fetch(`${base}/invite/${made.code}`, { redirect: 'manual' });
  assert.equal(link.status, 302);
  assert.equal(link.headers.get('location'), `/?invite=${made.code}`);
});

test('burrow details, rules, welcome room and handing it over', async () => {
  const [max, sam] = await people('max', 'sam');
  const { server, room } = await burrow(max);
  const s = (
    await call(`/api/servers/${server.id}`, {
      method: 'PATCH',
      body: { name: 'The Den', description: 'Friday games', welcomeChannelId: room, rules: 'Be kind.' },
      token: max.token,
    })
  ).data;
  assert.equal(s.name, 'The Den');
  assert.equal(s.description, 'Friday games');
  assert.equal(s.welcomeChannelId, room);
  assert.equal(s.rulesAccepted, true); // the host wrote them

  await call('/api/join', { body: { inviteCode: server.inviteCode }, token: sam.token });
  const samView = (await call('/api/servers', { token: sam.token })).data[0];
  assert.equal(samView.rulesAccepted, false);
  assert.equal(samView.channels[0].canPost, false);
  assert.equal((await say(room, sam, 'hi')).status, 403);
  assert.equal((await call(`/api/servers/${server.id}/rules/accept`, { body: {}, token: sam.token })).data.rulesAccepted, true);
  assert.equal((await say(room, sam, 'hi')).status, 200);
  assert.equal((await call(`/api/servers/${server.id}`, { method: 'PATCH', body: { name: 'Mine' }, token: sam.token })).status, 403);

  assert.equal((await call(`/api/servers/${server.id}/transfer`, { body: { userId: max.user.id }, token: sam.token })).status, 403);
  const handed = (await call(`/api/servers/${server.id}/transfer`, { body: { userId: sam.user.id }, token: max.token })).data;
  assert.equal(handed.ownerId, sam.user.id);
  assert.equal((await call(`/api/servers/${server.id}`, { method: 'PATCH', body: { name: 'Sam\'s' }, token: sam.token })).status, 200);
});

test('muting and notification settings are per person', async () => {
  const [max, sam] = await people('max', 'sam');
  const { server, room } = await burrow(max, sam);
  const muted = (await call('/api/notify', { body: { serverId: server.id, channelId: room, level: 'mentions', mutedUntil: Date.now() + 3600_000 }, token: max.token })).data;
  assert.equal(muted.channels[0].notify.level, 'mentions');
  assert.ok(muted.channels[0].notify.mutedUntil > Date.now());
  const all = (await call('/api/notify', { body: { serverId: server.id, mutedUntil: -1 }, token: max.token })).data;
  assert.deepEqual(all.notify, { level: null, mutedUntil: -1 });
  assert.equal((await call('/api/servers', { token: sam.token })).data[0].notify, null);
  assert.equal((await call('/api/notify', { body: { serverId: server.id, mutedUntil: Date.now() - 5 }, token: max.token })).status, 400);
  const cleared = (await call('/api/notify', { body: { serverId: server.id, channelId: room }, token: max.token })).data;
  assert.equal(cleared.channels[0].notify, null);
});

test('group conversations', async () => {
  const [max, sam, mia, ola, stranger] = await people('max', 'sam', 'mia', 'ola', 'stranger');
  await burrow(max, sam, mia, ola);
  assert.equal((await call('/api/dms', { body: { userIds: [sam.user.id, stranger.user.id] }, token: max.token })).status, 403);
  const g = (await call('/api/dms', { body: { userIds: [sam.user.id, mia.user.id], name: 'Trip' }, token: max.token })).data;
  assert.equal(g.group, true);
  assert.equal(g.name, 'Trip');
  assert.equal(g.members.length, 3);
  assert.equal(g.seen, null);
  // A second group with the same people is a new conversation; a pair still reuses theirs.
  const g2 = (await call('/api/dms', { body: { userIds: [sam.user.id, mia.user.id] }, token: max.token })).data;
  assert.notEqual(g2.id, g.id);
  const pair = (await call('/api/dms', { body: { userId: sam.user.id }, token: max.token })).data;
  assert.equal(pair.group, false);
  assert.equal((await call('/api/dms', { body: { userIds: [sam.user.id] }, token: max.token })).data.id, pair.id);

  const room = g.channels[0].id;
  assert.equal((await say(room, mia, 'hello all')).status, 200);
  const added = (await call(`/api/dms/${g.id}/members`, { body: { userIds: [ola.user.id] }, token: sam.token })).data;
  assert.equal(added.members.length, 4);
  assert.equal((await call(`/api/servers/${g.id}`, { method: 'PATCH', body: { name: 'Road trip' }, token: ola.token })).data.name, 'Road trip');

  for (const who of [max, sam, mia]) assert.equal((await call(`/api/servers/${g.id}/leave`, { body: {}, token: who.token })).status, 200);
  assert.equal((await call(`/api/channels/${room}/messages`, { token: max.token })).status, 404);
  assert.equal((await call(`/api/channels/${room}/messages`, { token: ola.token })).data.length, 1);
  await call(`/api/servers/${g.id}/leave`, { body: {}, token: ola.token });
  assert.equal(db.prepare('SELECT 1 FROM servers WHERE id = ?').get(g.id), undefined);
});

test('events with RSVPs and a reminder', async () => {
  const [max, sam, eve] = await people('max', 'sam', 'eve');
  const { server, room } = await burrow(max, sam);
  const sock = openSocket(sam.token);
  await sock.opened;
  const startsAt = Date.now() + 3600_000;
  const s = (await call(`/api/servers/${server.id}/events`, { body: { title: 'Game night', startsAt, channelId: room }, token: sam.token })).data;
  const ev = s.events[0];
  assert.equal(ev.title, 'Game night');
  assert.deepEqual(ev.rsvps, [{ userId: sam.user.id, status: 'going' }]);
  assert.equal((await call(`/api/servers/${server.id}/events`, { body: { title: 'x', startsAt }, token: eve.token })).status, 404);

  const answered = (await call(`/api/events/${ev.id}/rsvp`, { body: { status: 'maybe' }, token: max.token })).data;
  assert.equal(answered.events[0].rsvps.length, 2);
  assert.equal((await call(`/api/events/${ev.id}`, { method: 'PATCH', body: { title: 'Mine now' }, token: eve.token })).status, 404);

  // Moving it to within the reminder window sends the reminder.
  db.prepare('UPDATE events SET starts_at = ?, reminded = 0 WHERE id = ?').run(Date.now() + 60_000, ev.id);
  checkClock();
  const reminder = await sock.next((e) => e.type === 'event_reminder');
  assert.equal(reminder.event.title, 'Game night');

  // Max can delete it because he hosts the burrow.
  assert.deepEqual((await call(`/api/events/${ev.id}`, { method: 'DELETE', token: max.token })).data.events, []);
  sock.ws.close();
});

test('folders of burrows', async () => {
  const [max, sam] = await people('max', 'sam');
  const a = (await burrow(max)).server;
  const b = (await burrow(max)).server;
  const other = (await burrow(sam)).server;
  const saved = (
    await call('/api/me/folders', {
      body: { folders: [{ name: 'Games', serverIds: [a.id, b.id, other.id] }, { name: 'Work', serverIds: [a.id] }] },
      token: max.token,
    })
  ).data.folders;
  assert.deepEqual(saved.map((f: any) => [f.name, f.serverIds]), [['Games', [a.id, b.id]], ['Work', []]]);
  assert.deepEqual((await call('/api/me', { token: max.token })).data.folders, saved);
  assert.equal((await call('/api/me/folders', { body: { folders: [{ name: '' }] }, token: max.token })).status, 400);
});
