import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';
import { openDb } from '../src/db.ts';
import { createApp } from '../src/app.ts';

// A stand-in for LiveKit's API that records what Burrow asks it to do.
const liveKitCalls: { method: string; body: any; claims: any; valid: boolean }[] = [];
const fakeLiveKit = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const [h, p, sig] = (req.headers.authorization ?? '').replace('Bearer ', '').split('.');
    liveKitCalls.push({
      method: req.url!.split('/').pop()!,
      body: JSON.parse(raw),
      claims: JSON.parse(Buffer.from(p, 'base64url').toString()),
      valid: createHmac('sha256', voice.apiSecret).update(`${h}.${p}`).digest('base64url') === sig,
    });
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
});
const voice = { apiKey: 'devkey', apiSecret: 'a-secret-that-is-at-least-32-characters-long', apiUrl: '' };
const apps: Server[] = [];
const bases: string[] = [];

before(async () => {
  await new Promise<void>((r) => fakeLiveKit.listen(0, r));
  voice.apiUrl = `http://localhost:${(fakeLiveKit.address() as AddressInfo).port}`;
  for (const v of [voice, undefined]) {
    const app = createApp({ db: openDb(':memory:'), publicDir: '/nonexistent', voice: v });
    await new Promise<void>((r) => app.listen(0, r));
    apps.push(app);
    bases.push(`http://localhost:${(app.address() as AddressInfo).port}`);
  }
});
after(() => {
  fakeLiveKit.close();
  for (const app of apps) {
    app.closeAllConnections();
    app.close();
  }
});

async function call(base: string, path: string, opts: { body?: unknown; token?: string } = {}) {
  const res = await fetch(base + path, {
    method: opts.body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, data: (await res.json()) as any };
}

function socket(base: string, token: string) {
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
  return { ws, next };
}

test('voice rooms', async () => {
  const base = bases[0];
  assert.equal((await call(base, '/api/config')).data.voice, true);
  const max = (await call(base, '/api/register', { body: { username: 'max', password: 'password1' } })).data;
  const sam = (await call(base, '/api/register', { body: { username: 'sam', password: 'password2' } })).data;
  const server = (await call(base, '/api/servers', { body: { name: 'Den' }, token: max.token })).data;
  await call(base, '/api/join', { body: { inviteCode: server.inviteCode }, token: sam.token });

  const withVoice = (await call(base, `/api/servers/${server.id}/channels`, { body: { name: 'Game Night', kind: 'voice' }, token: max.token })).data;
  const room = withVoice.channels.find((c: any) => c.kind === 'voice');
  assert.equal(room.name, 'Game Night');
  assert.deepEqual(room.voiceUsers, []);
  const general = withVoice.channels.find((c: any) => c.kind === 'text');

  // The token is a LiveKit JWT signed with our secret, for this room only.
  const { token, url } = (await call(base, `/api/channels/${room.id}/voice`, { body: {}, token: sam.token })).data;
  assert.equal(url, null);
  const [h, p, sig] = token.split('.');
  assert.equal(createHmac('sha256', voice.apiSecret).update(`${h}.${p}`).digest('base64url'), sig);
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  assert.equal(claims.iss, 'devkey');
  assert.equal(claims.name, 'sam');
  assert.equal(claims.video.room, `room-${room.id}`);
  assert.equal(claims.video.roomJoin, true);
  assert.ok(claims.exp > Date.now() / 1000);

  assert.equal((await call(base, `/api/channels/${general.id}/voice`, { body: {}, token: sam.token })).status, 400);
  assert.equal((await call(base, `/api/channels/${room.id}/messages`, { body: { content: 'hi' }, token: sam.token })).status, 400);
  const outsider = (await call(base, '/api/register', { body: { username: 'eve', password: 'password3' } })).data;
  assert.equal((await call(base, `/api/channels/${room.id}/voice`, { body: {}, token: outsider.token })).status, 404);

  // Joining and leaving is broadcast, and shows up in the burrow summary.
  const maxWs = socket(base, max.token);
  await maxWs.next((e) => e.type === 'ready');
  const samWs = socket(base, sam.token);
  await samWs.next((e) => e.type === 'ready');
  samWs.ws.send(JSON.stringify({ type: 'voice_join', channelId: room.id }));
  const joined = await maxWs.next((e) => e.type === 'voice_state');
  assert.deepEqual(joined, { type: 'voice_state', channelId: room.id, userIds: [sam.user.id], muted: [], deafened: [] });
  const listed = (await call(base, '/api/servers', { token: max.token })).data[0];
  assert.deepEqual(listed.channels.find((c: any) => c.id === room.id).voiceUsers, [sam.user.id]);

  // Muting and deafening show for everyone in the burrow, not just the people in the room.
  samWs.ws.send(JSON.stringify({ type: 'voice_status', muted: true, deafened: true }));
  assert.deepEqual(await maxWs.next((e) => e.type === 'voice_state'),
    { type: 'voice_state', channelId: room.id, userIds: [sam.user.id], muted: [sam.user.id], deafened: [sam.user.id] });
  const flagged = (await call(base, '/api/servers', { token: max.token })).data[0].channels.find((c: any) => c.id === room.id);
  assert.deepEqual([flagged.voiceMuted, flagged.voiceDeafened], [[sam.user.id], [sam.user.id]]);
  samWs.ws.send(JSON.stringify({ type: 'voice_status', muted: true, deafened: false }));
  assert.deepEqual((await maxWs.next((e) => e.type === 'voice_state')).deafened, []);
  // Leaving forgets it; joining says it again.
  samWs.ws.send(JSON.stringify({ type: 'voice_leave' }));
  await maxWs.next((e) => e.type === 'voice_state' && e.userIds.length === 0);
  samWs.ws.send(JSON.stringify({ type: 'voice_join', channelId: room.id }));
  assert.deepEqual((await maxWs.next((e) => e.type === 'voice_state')).muted, []);
  // Not in a voice room: nothing to say.
  maxWs.ws.send(JSON.stringify({ type: 'voice_status', muted: true }));

  // Text rooms can't be joined as voice.
  samWs.ws.send(JSON.stringify({ type: 'voice_join', channelId: general.id }));
  await samWs.next((e) => e.type === 'error');

  // Closing the app takes you out of voice.
  samWs.ws.close();
  assert.deepEqual((await maxWs.next((e) => e.type === 'voice_state')).userIds, []);
  maxWs.ws.close();
});

test('fireside chat is only for the people at the fire, and goes out with the fire', async () => {
  const base = bases[0];
  const reg = async (username: string) => (await call(base, '/api/register', { body: { username, password: 'password1' } })).data;
  const [ash, bo, cy] = [await reg('ash'), await reg('bo'), await reg('cy')];
  const server = (await call(base, '/api/servers', { body: { name: 'Fireside' }, token: ash.token })).data;
  for (const u of [bo, cy]) await call(base, '/api/join', { body: { inviteCode: server.inviteCode }, token: u.token });
  const room = (await call(base, `/api/servers/${server.id}/channels`, { body: { name: 'Campfire', kind: 'voice' }, token: ash.token }))
    .data.channels.find((c: any) => c.kind === 'voice');
  const [a, b, c] = [socket(base, ash.token), socket(base, bo.token), socket(base, cy.token)];
  for (const s of [a, b, c]) await s.next((e) => e.type === 'ready');

  // Not at the fire: nothing to say there.
  a.ws.send(JSON.stringify({ type: 'fireside_send', content: 'hello?' }));
  await a.next((e) => e.type === 'error');

  a.ws.send(JSON.stringify({ type: 'voice_join', channelId: room.id }));
  assert.deepEqual(await a.next((e) => e.type === 'fireside_history'), { type: 'fireside_history', channelId: room.id, messages: [] });
  b.ws.send(JSON.stringify({ type: 'voice_join', channelId: room.id }));
  await b.next((e) => e.type === 'fireside_history');
  a.ws.send(JSON.stringify({ type: 'fireside_send', content: '  that jump was not my fault  ' }));
  const heard = await b.next((e) => e.type === 'fireside');
  assert.equal(heard.channelId, room.id);
  assert.deepEqual([heard.message.userId, heard.message.author, heard.message.content], [ash.user.id, 'ash', 'that jump was not my fault']);
  await a.next((e) => e.type === 'fireside'); // the sender gets it back too
  a.ws.send(JSON.stringify({ type: 'fireside_send', content: '   ' }));
  await a.next((e) => e.type === 'error');
  a.ws.send(JSON.stringify({ type: 'fireside_send', content: 'x'.repeat(1001) }));
  await a.next((e) => e.type === 'error');

  // Someone in the burrow but not at the fire never sees it, until they sit down.
  await new Promise((r) => setTimeout(r, 100));
  await assert.rejects(c.next((e) => e.type === 'fireside'));
  c.ws.send(JSON.stringify({ type: 'voice_join', channelId: room.id }));
  const caughtUp = await c.next((e) => e.type === 'fireside_history');
  assert.deepEqual(caughtUp.messages.map((m: any) => m.content), ['that jump was not my fault']);

  // Once everyone has left, the fire's chat is gone.
  for (const s of [a, b, c]) s.ws.send(JSON.stringify({ type: 'voice_leave' }));
  await a.next((e) => e.type === 'voice_state' && e.userIds.length === 0);
  b.ws.send(JSON.stringify({ type: 'voice_join', channelId: room.id }));
  assert.deepEqual((await b.next((e) => e.type === 'fireside_history')).messages, []);
  for (const s of [a, b, c]) s.ws.close();
});

test('removing, leaving or deleting disconnects people from LiveKit', async () => {
  const base = bases[0];
  const reg = async (username: string) => (await call(base, '/api/register', { body: { username, password: 'password1' } })).data;
  const host = await reg('host2');
  const kim = await reg('kim');
  const lee = await reg('lee');
  const server = (await call(base, '/api/servers', { body: { name: 'Camp' }, token: host.token })).data;
  for (const u of [kim, lee]) await call(base, '/api/join', { body: { inviteCode: server.inviteCode }, token: u.token });
  const room = (await call(base, `/api/servers/${server.id}/channels`, { body: { name: 'Talk', kind: 'voice' }, token: host.token })).data.channels.find(
    (c: any) => c.kind === 'voice',
  );
  const hostWs = socket(base, host.token);
  await hostWs.next((e) => e.type === 'ready');
  const kimWs = socket(base, kim.token);
  await kimWs.next((e) => e.type === 'ready');
  kimWs.ws.send(JSON.stringify({ type: 'voice_join', channelId: room.id }));
  await hostWs.next((e) => e.type === 'voice_state' && e.userIds.includes(kim.user.id));

  const waitForCall = async (method: string, identity?: string) => {
    for (let i = 0; i < 100; i++) {
      const i2 = liveKitCalls.findIndex((c) => c.method === method && (identity === undefined || c.body.identity === identity));
      if (i2 >= 0) return liveKitCalls.splice(i2, 1)[0];
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`LiveKit never got ${method}`);
  };

  // Removed: off the room's list for everyone, and disconnected from LiveKit with an admin token.
  await call(base, `/api/servers/${server.id}/members/${kim.user.id}/remove`, { body: {}, token: host.token });
  assert.deepEqual((await hostWs.next((e) => e.type === 'voice_state')).userIds, []);
  const removed = await waitForCall('RemoveParticipant', String(kim.user.id));
  assert.equal(removed.valid, true);
  assert.equal(removed.body.room, `room-${room.id}`);
  assert.deepEqual(removed.claims.video, { room: `room-${room.id}`, roomAdmin: true, roomCreate: true });

  // Leaving does the same, even if the app never said it was in voice.
  await call(base, `/api/servers/${server.id}/leave`, { body: {}, token: lee.token });
  assert.equal((await waitForCall('RemoveParticipant', String(lee.user.id))).body.room, `room-${room.id}`);

  // Deleting the voice room closes it for everyone.
  const res = await fetch(`${base}/api/channels/${room.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${host.token}` } });
  assert.equal(res.status, 200);
  assert.equal((await waitForCall('DeleteRoom')).body.room, `room-${room.id}`);
  hostWs.ws.close();
  kimWs.ws.close();
});

test('voice is off without LiveKit settings', async () => {
  const base = bases[1];
  assert.equal((await call(base, '/api/config')).data.voice, false);
  const max = (await call(base, '/api/register', { body: { username: 'max', password: 'password1' } })).data;
  const server = (await call(base, '/api/servers', { body: { name: 'Den' }, token: max.token })).data;
  const withVoice = (await call(base, `/api/servers/${server.id}/channels`, { body: { name: 'Talk', kind: 'voice' }, token: max.token })).data;
  const room = withVoice.channels.find((c: any) => c.kind === 'voice');
  assert.equal((await call(base, `/api/channels/${room.id}/voice`, { body: {}, token: max.token })).status, 503);
});
