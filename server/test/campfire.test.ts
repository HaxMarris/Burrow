import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';
import { openDb } from '../src/db.ts';
import { createApp } from '../src/app.ts';

// A stand-in for LiveKit's API that records what Burrow asks it to do.
const liveKitCalls: { method: string; body: any }[] = [];
const fakeLiveKit = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    liveKitCalls.push({ method: req.url!.split('/').pop()!, body: JSON.parse(raw) });
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
});
const voice = { apiKey: 'devkey', apiSecret: 'a-secret-that-is-at-least-32-characters-long', apiUrl: '' };
let app: Server;
let base = '';

before(async () => {
  await new Promise<void>((r) => fakeLiveKit.listen(0, r));
  voice.apiUrl = `http://localhost:${(fakeLiveKit.address() as AddressInfo).port}`;
  const uploadDir = join(mkdtempSync(join(tmpdir(), 'burrow-campfire-')), 'uploads');
  app = createApp({ db: openDb(':memory:'), publicDir: '/nonexistent', voice, uploadDir });
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

async function socket(token: string) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${token}`);
  const events: any[] = [];
  ws.on('message', (raw) => events.push(JSON.parse(String(raw))));
  const next = async (pred: (e: any) => boolean) => {
    for (let i = 0; i < 100; i++) {
      const i2 = events.findIndex(pred);
      if (i2 >= 0) return events.splice(i2, 1)[0];
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('timed out waiting for event');
  };
  const send = (msg: unknown) => ws.send(JSON.stringify(msg));
  await next((e) => e.type === 'ready');
  return { ws, events, next, send };
}

const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

let n = 0;
async function people(...names: string[]) {
  const out: any[] = [];
  for (const name of names) out.push((await call('/api/register', { body: { username: `${name}${++n}`, password: 'password1' } })).data);
  return out;
}
/** A burrow with two fires, everyone in it. */
async function burrow(host: any, ...others: any[]) {
  const server = (await call('/api/servers', { body: { name: 'Den' }, token: host.token })).data;
  for (const o of others) await call('/api/join', { body: { inviteCode: server.inviteCode }, token: o.token });
  await call(`/api/servers/${server.id}/channels`, { body: { name: 'Campfire', kind: 'voice' }, token: host.token });
  const s = (await call(`/api/servers/${server.id}/channels`, { body: { name: 'Back Porch', kind: 'voice' }, token: host.token })).data;
  const [fire, porch] = s.channels.filter((c: any) => c.kind === 'voice').map((c: any) => c.id);
  return { server: s, fire, porch };
}

test('a fire with a seat limit is full, except for people who manage voice or are moved there', async () => {
  const [host, bob, carol] = await people('host', 'bob', 'carol');
  const { server, fire, porch } = await burrow(host, bob, carol);
  const set = await call(`/api/channels/${fire}`, { method: 'PATCH', body: { userLimit: 1 }, token: host.token });
  assert.equal(set.data.channels.find((c: any) => c.id === fire).userLimit, 1);
  assert.equal((await call(`/api/channels/${fire}`, { method: 'PATCH', body: { userLimit: 100 }, token: host.token })).status, 400);

  const b = await socket(bob.token);
  b.send({ type: 'voice_join', channelId: fire });
  await b.next((e) => e.type === 'voice_state' && e.userIds.includes(bob.user.id));
  const full = await call(`/api/channels/${fire}/voice`, { body: {}, token: carol.token });
  assert.equal(full.status, 403);
  assert.match(full.data.error, /full/);
  const c = await socket(carol.token);
  c.send({ type: 'voice_join', channelId: fire });
  await c.next((e) => e.type === 'error' && /full/.test(e.error));
  // Bob still has his seat, and the host can always sit down.
  assert.equal((await call(`/api/channels/${fire}/voice`, { body: {}, token: bob.token })).status, 200);
  assert.equal((await call(`/api/channels/${fire}/voice`, { body: {}, token: host.token })).status, 200);

  // Moving carol in: she gets told where to go, and a seat is kept for her.
  c.send({ type: 'voice_join', channelId: porch });
  await c.next((e) => e.type === 'voice_state' && e.userIds.includes(carol.user.id));
  assert.equal((await call('/api/voice/move', { body: { userId: carol.user.id, channelId: fire }, token: bob.token })).status, 403);
  assert.equal((await call('/api/voice/move', { body: { userId: carol.user.id, channelId: fire }, token: host.token })).status, 200);
  assert.deepEqual(await c.next((e) => e.type === 'voice_move'), { type: 'voice_move', channelId: fire, by: host.user.username });
  assert.equal((await call(`/api/channels/${fire}/voice`, { body: {}, token: carol.token })).status, 200);
  c.send({ type: 'voice_join', channelId: fire });
  await b.next((e) => e.type === 'voice_state' && e.channelId === fire && e.userIds.length === 2);

  // Disconnecting takes someone out of voice altogether.
  liveKitCalls.length = 0;
  assert.equal((await call('/api/voice/disconnect', { body: { userId: bob.user.id }, token: host.token })).status, 200);
  await b.next((e) => e.type === 'voice_kicked');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(liveKitCalls.map((x) => [x.method, x.body.identity]), [['RemoveParticipant', String(bob.user.id)]]);
  // Someone who can't manage voice can't move anyone, and nobody can be moved to another burrow's fire.
  const other = await burrow(carol);
  assert.equal((await call('/api/voice/move', { body: { userId: carol.user.id, channelId: other.fire }, token: carol.token })).status, 400);
  assert.equal(server.channels.length > 0, true);
  b.ws.close();
  c.ws.close();
});

test('muted for everyone: LiveKit stops taking their microphone until a moderator lets them speak', async () => {
  const [host, bob] = await people('host', 'bob');
  const { server, fire } = await burrow(host, bob);
  const h = await socket(host.token);
  const b = await socket(bob.token);
  b.send({ type: 'voice_join', channelId: fire });
  await h.next((e) => e.type === 'voice_state' && e.userIds.includes(bob.user.id));

  assert.equal((await call(`/api/servers/${server.id}/members/${host.user.id}/voice-mute`, { body: { muted: true }, token: bob.token })).status, 403);
  liveKitCalls.length = 0;
  assert.equal((await call(`/api/servers/${server.id}/members/${bob.user.id}/voice-mute`, { body: { muted: true }, token: host.token })).status, 200);
  assert.deepEqual(await b.next((e) => e.type === 'server_muted'), { type: 'server_muted', serverId: server.id, muted: true });
  assert.deepEqual((await h.next((e) => e.type === 'voice_state')).serverMuted, [bob.user.id]);
  await new Promise((r) => setTimeout(r, 50));
  const update = liveKitCalls.find((x) => x.method === 'UpdateParticipant')!;
  assert.equal(update.body.identity, String(bob.user.id));
  assert.deepEqual(update.body.permission.canPublishSources, ['CAMERA', 'SCREEN_SHARE', 'SCREEN_SHARE_AUDIO']);

  // It sticks: joining again gets a token without the microphone, and the burrow says so.
  const again = (await call(`/api/channels/${fire}/voice`, { body: {}, token: bob.token })).data;
  assert.equal(again.canSpeak, false);
  assert.deepEqual(claimsOf(again.token).video.canPublishSources, ['camera', 'screen_share', 'screen_share_audio']);
  assert.equal((await call('/api/servers', { token: bob.token })).data.find((s: any) => s.id === server.id).serverMuted, true);
  // And no soundboard either.
  assert.equal((await call(`/api/servers/${server.id}/members/${bob.user.id}/voice-mute`, { body: { muted: false }, token: host.token })).status, 200);
  assert.equal(claimsOf((await call(`/api/channels/${fire}/voice`, { body: {}, token: bob.token })).data.token).video.canPublishSources[0], 'microphone');
  h.ws.close();
  b.ws.close();
});

test('who is talking shows outside the fire, and quiet people are moved to the AFK fire', async () => {
  const [host, bob] = await people('host', 'bob');
  const { server, fire, porch } = await burrow(host, bob);
  const h = await socket(host.token);
  const b = await socket(bob.token);
  b.send({ type: 'voice_join', channelId: fire });
  await h.next((e) => e.type === 'voice_state' && e.userIds.includes(bob.user.id));
  b.send({ type: 'voice_speaking', speaking: true });
  assert.deepEqual(await h.next((e) => e.type === 'voice_speaking'), { type: 'voice_speaking', channelId: fire, userId: bob.user.id, speaking: true });
  assert.deepEqual((await call('/api/servers', { token: host.token })).data.find((s: any) => s.id === server.id).channels.find((c: any) => c.id === fire).voiceSpeaking, [bob.user.id]);
  b.send({ type: 'voice_speaking', speaking: false });
  await h.next((e) => e.type === 'voice_speaking' && !e.speaking);

  const set = await call(`/api/servers/${server.id}`, { method: 'PATCH', body: { afkChannelId: porch, afkMinutes: 5 }, token: host.token });
  assert.deepEqual([set.data.afkChannelId, set.data.afkMinutes], [porch, 5]);
  assert.equal((await call(`/api/servers/${server.id}`, { method: 'PATCH', body: { afkMinutes: 0 }, token: host.token })).status, 400);
  const checkAfk = (t: number) => (app as unknown as { checkAfk: (t: number) => void }).checkAfk(t);
  checkAfk(Date.now() + 4 * 60_000);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(b.events.some((e) => e.type === 'voice_move'), false);
  checkAfk(Date.now() + 6 * 60_000);
  assert.deepEqual(await b.next((e) => e.type === 'voice_move'), { type: 'voice_move', channelId: porch, afk: true });
  h.ws.close();
  b.ws.close();
});

test('a fire can keep its fireside chat after everyone leaves', async () => {
  const [host, bob] = await people('host', 'bob');
  const { fire } = await burrow(host, bob);
  const b = await socket(bob.token);
  b.send({ type: 'voice_join', channelId: fire });
  await b.next((e) => e.type === 'fireside_history');
  b.send({ type: 'fireside_send', content: 'before keeping' });
  await b.next((e) => e.type === 'fireside');
  // Turning it on keeps what's already been said.
  const set = await call(`/api/channels/${fire}`, { method: 'PATCH', body: { keepChat: true }, token: host.token });
  assert.equal(set.data.channels.find((c: any) => c.id === fire).keepChat, true);
  b.send({ type: 'fireside_send', content: 'kept' });
  await b.next((e) => e.type === 'fireside' && e.message.content === 'kept');
  b.send({ type: 'voice_leave' });
  await b.next((e) => e.type === 'voice_state' && !e.userIds.length);
  b.send({ type: 'voice_join', channelId: fire });
  const history = await b.next((e) => e.type === 'fireside_history');
  assert.deepEqual(history.messages.map((m: any) => m.content), ['before keeping', 'kept']);
  // Turning it off throws it away.
  await call(`/api/channels/${fire}`, { method: 'PATCH', body: { keepChat: false }, token: host.token });
  b.send({ type: 'voice_leave' });
  await b.next((e) => e.type === 'voice_state' && !e.userIds.length);
  b.send({ type: 'voice_join', channelId: fire });
  assert.deepEqual((await b.next((e) => e.type === 'fireside_history')).messages, []);
  b.ws.close();
});

test('soundboard: a burrow uploads short clips, and anyone at its fire plays them for everyone there', async () => {
  const [host, bob, carol] = await people('host', 'bob', 'carol');
  const { server, fire } = await burrow(host, bob, carol);
  const clip = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(200)]);
  const upload = (token: string, body: Buffer, name = 'Airhorn') =>
    fetch(`${base}/api/servers/${server.id}/sounds?name=${encodeURIComponent(name)}&emoji=${encodeURIComponent('📯')}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body,
    });
  assert.equal((await upload(bob.token, clip)).status, 403);
  assert.equal((await upload(host.token, Buffer.from('not audio at all'))).status, 400);
  const res = await upload(host.token, clip);
  assert.equal(res.status, 200);
  const sound = ((await res.json()) as any).sounds[0];
  assert.deepEqual([sound.name, sound.emoji], ['Airhorn', '📯']);
  const file = await fetch(base + sound.url);
  assert.equal(file.headers.get('content-type'), 'audio/mpeg');
  assert.equal(Buffer.from(await file.arrayBuffer()).length, clip.length);

  const b = await socket(bob.token);
  const c = await socket(carol.token);
  // Only from the fire.
  b.send({ type: 'soundboard', soundId: sound.id });
  await b.next((e) => e.type === 'error');
  b.send({ type: 'voice_join', channelId: fire });
  c.send({ type: 'voice_join', channelId: fire });
  await b.next((e) => e.type === 'voice_state' && e.userIds.length === 2);
  b.send({ type: 'soundboard', soundId: sound.id });
  assert.deepEqual(await c.next((e) => e.type === 'soundboard'), { type: 'soundboard', channelId: fire, userId: bob.user.id, soundId: sound.id, url: sound.url });
  // One at a time.
  b.send({ type: 'soundboard', soundId: sound.id });
  await b.next((e) => e.type === 'error' && /one sound/i.test(e.error));

  const renamed = await call(`/api/sounds/${sound.id}`, { method: 'PATCH', body: { name: 'Horn' }, token: host.token });
  assert.equal(renamed.data.sounds[0].name, 'Horn');
  assert.equal((await call(`/api/sounds/${sound.id}`, { method: 'DELETE', token: bob.token })).status, 403);
  assert.deepEqual((await call(`/api/sounds/${sound.id}`, { method: 'DELETE', token: host.token })).data.sounds, []);
  assert.equal((await fetch(base + sound.url)).status, 404);
  b.ws.close();
  c.ws.close();
});

test('listen together: one video per fire, in step for everyone, gone when the fire goes out', async () => {
  const [host, bob] = await people('host', 'bob');
  const { fire } = await burrow(host, bob);
  const h = await socket(host.token);
  const b = await socket(bob.token);
  h.send({ type: 'voice_join', channelId: fire });
  await h.next((e) => e.type === 'voice_state');
  h.send({ type: 'listen', action: 'start', videoId: 'not a video' });
  await h.next((e) => e.type === 'error');
  h.send({ type: 'listen', action: 'start', videoId: 'dQw4w9WgXcQ', position: 30 });
  const started = await h.next((e) => e.type === 'listen_state');
  assert.equal(started.state.videoId, 'dQw4w9WgXcQ');
  assert.equal(started.state.playing, true);
  assert.ok(started.state.position >= 30 && started.state.position < 31);
  h.send({ type: 'listen', action: 'title', title: 'Never Gonna Give You Up' });
  await h.next((e) => e.type === 'listen_state' && e.state.title);

  // Someone sitting down later starts where everyone else is.
  b.send({ type: 'voice_join', channelId: fire });
  const joined = await b.next((e) => e.type === 'listen_state');
  assert.equal(joined.state.title, 'Never Gonna Give You Up');
  b.send({ type: 'listen', action: 'pause' });
  const paused = await h.next((e) => e.type === 'listen_state' && !e.state.playing);
  b.send({ type: 'listen', action: 'seek', position: 90 });
  assert.equal((await h.next((e) => e.type === 'listen_state' && e.state.position === 90)).state.playing, false);
  assert.ok(paused.state.position >= 30);

  // The fire goes out: next time, nothing is playing.
  h.send({ type: 'voice_leave' });
  b.send({ type: 'voice_leave' });
  await h.next((e) => e.type === 'voice_state' && !e.userIds.length);
  h.events.length = 0;
  h.send({ type: 'voice_join', channelId: fire });
  await h.next((e) => e.type === 'fireside_history');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(h.events.some((e) => e.type === 'listen_state'), false);
  h.ws.close();
  b.ws.close();
});

test('listen together: a queue, and skipping takes more than half the fire', async () => {
  const [host, bob, carol, dave] = await people('host', 'bob', 'carol', 'dave');
  const { fire } = await burrow(host, bob, carol, dave);
  const [h, b, c, d] = await Promise.all([host, bob, carol, dave].map((p) => socket(p.token)));
  for (const s of [h, b, c, d]) {
    s.send({ type: 'voice_join', channelId: fire });
    await s.next((e) => e.type === 'fireside_history');
  }
  const latest = async (s: any, pred: (st: any) => boolean) => (await s.next((e: any) => e.type === 'listen_state' && e.state && pred(e.state))).state;

  // Bob puts something on; what anyone adds after that waits its turn.
  b.send({ type: 'listen', action: 'start', videoId: 'aaaaaaaaaaa' });
  await latest(h, (st) => st.videoId === 'aaaaaaaaaaa');
  c.send({ type: 'listen', action: 'queue', videoId: 'bbbbbbbbbbb' });
  d.send({ type: 'listen', action: 'start', videoId: 'ccccccccccc' }); // older apps say "start": it's queued too
  let st = await latest(h, (st) => st.queue.length === 2);
  assert.equal(st.videoId, 'aaaaaaaaaaa');
  assert.deepEqual(st.queue.map((q: any) => [q.videoId, q.by]), [['bbbbbbbbbbb', carol.user.id], ['ccccccccccc', dave.user.id]]);
  assert.equal(st.skipsNeeded, 3);

  // Votes: carol and dave aren't enough out of four, and voting again takes it back.
  c.send({ type: 'listen', action: 'skip', videoId: 'aaaaaaaaaaa' });
  st = await latest(h, (st) => st.skipVotes.length === 1);
  d.send({ type: 'listen', action: 'skip', videoId: 'aaaaaaaaaaa' });
  st = await latest(h, (st) => st.skipVotes.length === 2);
  assert.equal(st.videoId, 'aaaaaaaaaaa');
  d.send({ type: 'listen', action: 'skip', videoId: 'aaaaaaaaaaa' });
  st = await latest(h, (st) => st.skipVotes.length === 1);
  assert.deepEqual(st.skipVotes, [carol.user.id]);
  // A vote meant for something that's no longer on doesn't count.
  d.send({ type: 'listen', action: 'skip', videoId: 'zzzzzzzzzzz' });
  d.send({ type: 'listen', action: 'skip', videoId: 'aaaaaaaaaaa' });
  st = await latest(h, (st) => st.skipVotes.length === 2);
  // The host leaving makes it three at the fire, so two votes are now enough: on to carol's.
  h.send({ type: 'voice_leave' });
  st = await latest(b, (st) => st.videoId === 'bbbbbbbbbbb');
  assert.equal(st.by, carol.user.id);
  assert.deepEqual(st.skipVotes, []);
  assert.equal(st.skipsNeeded, 2);
  assert.equal(st.queue.length, 1);

  // Only whoever put it on (or a host or mod) can stop it, or take something out of the queue.
  b.send({ type: 'listen', action: 'stop' });
  await b.next((e) => e.type === 'error' && /vote/i.test(e.error));
  b.send({ type: 'listen', action: 'unqueue', id: st.queue[0].id });
  await b.next((e) => e.type === 'error');
  d.send({ type: 'listen', action: 'unqueue', id: st.queue[0].id });
  st = await latest(b, (st) => !st.queue.length);
  // A stray "it ended" for another video changes nothing.
  b.send({ type: 'listen', action: 'ended', videoId: 'aaaaaaaaaaa' });
  // Carol put this one on, so she skips it right away; with nothing next, it stops at the end.
  c.send({ type: 'listen', action: 'skip', videoId: 'bbbbbbbbbbb' });
  st = await latest(b, (st) => st.ended);
  assert.equal(st.playing, false);
  assert.equal(st.videoId, 'bbbbbbbbbbb');
  // Once it's over, the next thing anyone adds plays straight away.
  d.send({ type: 'listen', action: 'queue', videoId: 'ddddddddddd' });
  st = await latest(b, (st) => st.videoId === 'ddddddddddd');
  assert.equal(st.playing, true);
  assert.equal(st.by, dave.user.id);

  // The host back at the fire skips anyone's pick right away, and can stop it all.
  h.send({ type: 'voice_join', channelId: fire });
  await latest(h, (st) => st.videoId === 'ddddddddddd');
  b.send({ type: 'listen', action: 'queue', videoId: 'eeeeeeeeeee' });
  await latest(h, (st) => st.queue.length === 1);
  h.send({ type: 'listen', action: 'skip' });
  st = await latest(h, (st) => st.videoId === 'eeeeeeeeeee');
  h.send({ type: 'listen', action: 'stop' });
  assert.equal((await b.next((e) => e.type === 'listen_state' && !e.state)).state, null);
  for (const s of [h, b, c, d]) s.ws.close();
});

test('calling someone in a direct message rings their app', async () => {
  const [ann, ben] = await people('ann', 'ben');
  await burrow(ann, ben);
  const dm = (await call('/api/dms', { body: { userId: ben.user.id }, token: ann.token })).data;
  const a = await socket(ann.token);
  const b = await socket(ben.token);
  const { channelId } = (await call(`/api/dms/${dm.id}/call`, { body: {}, token: ann.token })).data;
  assert.equal(typeof channelId, 'number');
  assert.deepEqual(await b.next((e) => e.type === 'ring'), { type: 'ring', serverId: dm.id, channelId, from: { id: ann.user.id, username: ann.user.username } });
  // The conversation now has its call room, and the call works like any voice room.
  const updated = await b.next((e) => e.type === 'server_updated' && e.server.id === dm.id);
  assert.equal(updated.server.channels.find((c: any) => c.id === channelId).kind, 'voice');
  assert.equal((await call(`/api/channels/${channelId}/voice`, { body: {}, token: ben.token })).status, 200);
  a.send({ type: 'voice_join', channelId });
  await a.next((e) => e.type === 'voice_state' && e.userIds.includes(ann.user.id));
  // Calling again uses the same room.
  assert.equal((await call(`/api/dms/${dm.id}/call`, { body: {}, token: ann.token })).data.channelId, channelId);
  await call(`/api/dms/${dm.id}/call/decline`, { body: {}, token: ben.token });
  assert.equal((await a.next((e) => e.type === 'ring_declined')).userId, ben.user.id);
  await b.next((e) => e.type === 'ring_stop');
  // Strangers can't ring anyone.
  const [eve] = await people('eve');
  assert.equal((await call(`/api/dms/${dm.id}/call`, { body: {}, token: eve.token })).status, 404);
  a.ws.close();
  b.ws.close();
});

test('sharing a screen posts "is live" in the go-live room, and stopping marks it over', async () => {
  const [host, bob] = await people('host', 'bob');
  const { server, fire } = await burrow(host, bob);
  const general = server.channels.find((c: any) => c.kind === 'text').id;
  // Only text rooms in this burrow, and only by people who can edit the burrow.
  assert.equal((await call(`/api/servers/${server.id}`, { method: 'PATCH', body: { liveChannelId: fire }, token: host.token })).status, 400);
  assert.equal((await call(`/api/servers/${server.id}`, { method: 'PATCH', body: { liveChannelId: general }, token: bob.token })).status, 403);
  const set = await call(`/api/servers/${server.id}`, { method: 'PATCH', body: { liveChannelId: general }, token: host.token });
  assert.equal(set.data.liveChannelId, general);

  const b = await socket(bob.token);
  b.send({ type: 'voice_live', live: true }); // not at a fire: nothing
  b.send({ type: 'voice_join', channelId: fire });
  await b.next((e) => e.type === 'voice_state' && e.userIds.includes(bob.user.id));
  b.send({ type: 'voice_live', live: true });
  const posted = await b.next((e) => e.type === 'message' && e.message.live);
  assert.deepEqual(posted.message.live, { voiceChannelId: fire, endedAt: null });
  assert.equal(posted.message.channelId, general);
  b.send({ type: 'voice_live', live: true }); // already live: no second post
  b.send({ type: 'voice_live', live: false });
  const ended = await b.next((e) => e.type === 'message_updated' && e.message.id === posted.message.id);
  assert.ok(ended.message.live.endedAt > 0);
  // Sharing again soon after picks the same post back up.
  b.send({ type: 'voice_live', live: true });
  const again = await b.next((e) => e.type === 'message_updated' && e.message.id === posted.message.id);
  assert.equal(again.message.live.endedAt, null);
  // Leaving the fire ends it too.
  b.send({ type: 'voice_leave' });
  const left = await b.next((e) => e.type === 'message_updated' && e.message.id === posted.message.id);
  assert.ok(left.message.live.endedAt > 0);
  const lives = (await call(`/api/channels/${general}/messages`, { token: host.token })).data.filter((m: any) => m.live);
  assert.equal(lives.length, 1);
  b.ws.close();

  // Without a go-live room, nothing is posted.
  await call(`/api/servers/${server.id}`, { method: 'PATCH', body: { liveChannelId: null }, token: host.token });
  const b2 = await socket(bob.token);
  b2.send({ type: 'voice_join', channelId: fire });
  await b2.next((e) => e.type === 'voice_state' && e.userIds.includes(bob.user.id));
  b2.send({ type: 'voice_live', live: true });
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!b2.events.some((e) => e.type === 'message'));
  b2.ws.close();
});
