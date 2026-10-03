import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { WebSocket } from 'ws';
import { openDb } from '../src/db.ts';
import { createApp } from '../src/app.ts';

const voice = { apiKey: 'devkey', apiSecret: 'a-secret-that-is-at-least-32-characters-long' };
const apps: Server[] = [];
const bases: string[] = [];

before(async () => {
  for (const v of [voice, undefined]) {
    const app = createApp({ db: openDb(':memory:'), publicDir: '/nonexistent', voice: v });
    await new Promise<void>((r) => app.listen(0, r));
    apps.push(app);
    bases.push(`http://localhost:${(app.address() as AddressInfo).port}`);
  }
});
after(() => {
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
  assert.deepEqual(joined, { type: 'voice_state', channelId: room.id, userIds: [sam.user.id] });
  const listed = (await call(base, '/api/servers', { token: max.token })).data[0];
  assert.deepEqual(listed.channels.find((c: any) => c.id === room.id).voiceUsers, [sam.user.id]);

  // Text rooms can't be joined as voice.
  samWs.ws.send(JSON.stringify({ type: 'voice_join', channelId: general.id }));
  await samWs.next((e) => e.type === 'error');

  // Closing the app takes you out of voice.
  samWs.ws.close();
  assert.deepEqual((await maxWs.next((e) => e.type === 'voice_state')).userIds, []);
  maxWs.ws.close();
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
