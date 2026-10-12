import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createServer as createNetServer } from 'node:net';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';
import { openDb } from '../src/db.ts';
import { createApp } from '../src/app.ts';

// A stand-in push service: it keeps what it's sent, decrypted with the device's own keys.
type Device = { endpoint: string; ecdh: ReturnType<typeof createECDH>; pub: Buffer; auth: Buffer };
const pushes: { path: string; authorization: string; message: any }[] = [];
const devices = new Map<string, Device>();
let pushStatus = 201;
const hkdf = (salt: Buffer, ikm: Buffer, info: string | Buffer, n: number) => {
  const prk = createHmac('sha256', salt).update(ikm).digest();
  return createHmac('sha256', prk).update(Buffer.concat([Buffer.from(info), Buffer.from([1])])).digest().subarray(0, n);
};
const fakePush = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const d = devices.get(req.url!)!;
    const salt = body.subarray(0, 16), idlen = body[20], from = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
    const ikm = hkdf(d.auth, d.ecdh.computeSecret(from), Buffer.concat([Buffer.from('WebPush: info\0'), d.pub, from]), 32);
    const dec = createDecipheriv('aes-128-gcm', hkdf(salt, ikm, 'Content-Encoding: aes128gcm\0', 16), hkdf(salt, ikm, 'Content-Encoding: nonce\0', 12));
    dec.setAuthTag(ct.subarray(ct.length - 16));
    const plain = Buffer.concat([dec.update(ct.subarray(0, ct.length - 16)), dec.final()]);
    pushes.push({ path: req.url!, authorization: String(req.headers.authorization), message: JSON.parse(plain.subarray(0, plain.length - 1).toString()) });
    res.writeHead(pushStatus).end();
  });
});

// A stand-in mail server that keeps every message.
const mails: string[] = [];
const fakeSmtp = createNetServer((sock) => {
  let data = false, buf = '';
  sock.write('220 test\r\n');
  sock.on('data', (d) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (data) {
        if (line === '.') { data = false; sock.write('250 queued\r\n'); } else mails[mails.length - 1] += line + '\n';
      } else if (/^EHLO/.test(line)) sock.write('250-test\r\n250 SIZE 1000000\r\n');
      else if (line === 'DATA') { data = true; mails.push(''); sock.write('354 go\r\n'); }
      else if (line === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
      else sock.write('250 ok\r\n');
    }
  });
});
const mailText = (raw: string) => {
  const [head, body] = raw.split('\n\n');
  return { subject: /Subject: (.*)/.exec(head)![1], text: Buffer.from(body.replace(/\s/g, ''), 'base64').toString() };
};

let app: Server;
let base = '';
let pushHost = '';

before(async () => {
  await new Promise<void>((r) => fakePush.listen(0, r));
  await new Promise<void>((r) => fakeSmtp.listen(0, r));
  pushHost = `localhost:${(fakePush.address() as AddressInfo).port}`;
  app = createApp({
    db: openDb(':memory:'),
    publicDir: '/nonexistent',
    pushHosts: [pushHost],
    mail: { url: `smtp://localhost:${(fakeSmtp.address() as AddressInfo).port}`, from: 'Burrow <burrow@example.com>' },
    publicUrl: 'https://burrow.example.com',
  });
  await new Promise<void>((r) => app.listen(0, r));
  base = `http://localhost:${(app.address() as AddressInfo).port}`;
});
after(() => {
  fakePush.close();
  fakeSmtp.close();
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
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let n = 0;
async function people(...names: string[]) {
  const out: any[] = [];
  for (const name of names) out.push((await call('/api/register', { body: { username: `${name}${++n}`, password: 'password1' } })).data);
  return out;
}
async function burrow(host: any, ...others: any[]) {
  const server = (await call('/api/servers', { body: { name: 'Den' }, token: host.token })).data;
  for (const o of others) await call('/api/join', { body: { inviteCode: server.inviteCode }, token: o.token });
  return { id: server.id, room: server.channels.find((c: any) => c.kind === 'text').id };
}
const say = (token: string, channelId: number, content: string, extra = {}) =>
  call(`/api/channels/${channelId}/messages`, { body: { content, ...extra }, token });
const mentionCount = async (token: string, serverId: number, room: number) =>
  (await call('/api/servers', { token })).data.find((s: any) => s.id === serverId).channels.find((c: any) => c.id === room).mentions;

async function subscribe(token: string) {
  const ecdh = createECDH('prime256v1');
  const pub = ecdh.generateKeys();
  const auth = randomBytes(16);
  const path = `/device-${randomBytes(4).toString('hex')}`;
  devices.set(path, { endpoint: path, ecdh, pub, auth });
  const r = await call('/api/push', { body: { endpoint: `http://${pushHost}${path}`, keys: { p256dh: pub.toString('base64url'), auth: auth.toString('base64url') } }, token });
  assert.equal(r.status, 200);
  return path;
}

test('@everyone, @here and @Role ping people only when the author may', async () => {
  const [host, bob, carol] = await people('host', 'bob', 'carol');
  const b = await burrow(host, bob, carol);
  // Bob has no permission to ping everyone: his @everyone is just text.
  const plain = (await say(bob.token, b.room, '@everyone hello')).data;
  assert.equal(plain.pings, null);
  assert.equal(await mentionCount(carol.token, b.id, b.room), 0);
  // The host can.
  const loud = (await say(host.token, b.room, '@everyone game night!')).data;
  assert.deepEqual(loud.pings, { everyone: 1 });
  assert.equal(await mentionCount(carol.token, b.id, b.room), 1);
  assert.equal(await mentionCount(bob.token, b.id, b.room), 1);
  // A role ping reaches the people in that role only.
  let s = (await call(`/api/servers/${b.id}/roles`, { body: { name: 'Raid Team', color: '#aa3333' }, token: host.token })).data;
  const raid = s.roles.find((r: any) => r.name === 'Raid Team').id;
  await call(`/api/servers/${b.id}/members/${carol.user.id}/roles`, { body: { roleIds: [raid] }, token: host.token });
  const role = (await say(host.token, b.room, 'hey @raid team, tonight')).data;
  assert.deepEqual(role.pings, { roles: [raid] });
  assert.equal(await mentionCount(carol.token, b.id, b.room), 2);
  assert.equal(await mentionCount(bob.token, b.id, b.room), 1);
  // @here is for people who are online right now.
  const carolWs = await socket(carol.token);
  await say(host.token, b.room, '@here quick question');
  assert.equal(await mentionCount(carol.token, b.id, b.room), 3);
  assert.equal(await mentionCount(bob.token, b.id, b.room), 1);
  carolWs.ws.close();
  // The Moderator role new burrows start with may ping everyone.
  s = (await call('/api/servers', { token: host.token })).data.find((x: any) => x.id === b.id);
  assert.match(s.roles.find((r: any) => r.name === 'Moderator').perms.join(','), /everyone/);
});

test('the mentions inbox lists what was for you, newest first, and can be cleared', async () => {
  const [host, bob] = await people('host', 'bob');
  const b = await burrow(host, bob);
  const first = (await say(host.token, b.room, `hi @${bob.user.username}`)).data;
  const mine = (await say(bob.token, b.room, 'my own words')).data;
  const reply = (await say(host.token, b.room, 'answering you', { replyTo: mine.id })).data;
  await say(host.token, b.room, 'nothing for bob here');
  let inbox = (await call('/api/mentions', { token: bob.token })).data;
  assert.deepEqual(inbox.messages.map((m: any) => m.id), [reply.id, first.id]);
  assert.equal(inbox.messages[0].place.channelName, 'general');
  assert.equal(inbox.messages[0].unread, true);
  assert.equal(inbox.more, false);
  await call(`/api/channels/${b.room}/read`, { body: { lastReadId: reply.id }, token: bob.token });
  inbox = (await call('/api/mentions', { token: bob.token })).data;
  assert.equal(inbox.messages[0].unread, false);
  await call(`/api/mentions/${first.id}`, { method: 'DELETE', token: bob.token });
  inbox = (await call('/api/mentions', { token: bob.token })).data;
  assert.deepEqual(inbox.messages.map((m: any) => m.id), [reply.id]);
  // Editing a name in counts for the inbox too.
  const edited = (await say(host.token, b.room, 'later')).data;
  await call(`/api/messages/${edited.id}`, { method: 'PATCH', body: { content: `later @${bob.user.username}` }, token: host.token });
  inbox = (await call('/api/mentions', { token: bob.token })).data;
  assert.equal(inbox.messages[0].id, edited.id);
});

test('away, do not disturb, custom status and what you are playing reach everyone in your burrows', async () => {
  const [ann, bob] = await people('ann', 'bob');
  const b = await burrow(ann, bob);
  const bobWs = await socket(bob.token);
  const annWs = await socket(ann.token);
  await bobWs.next((e) => e.type === 'presence' && e.userId === ann.user.id && e.status === 'online');
  await call('/api/me', { method: 'PATCH', body: { status: 'dnd' }, token: ann.token });
  await bobWs.next((e) => e.type === 'presence' && e.userId === ann.user.id && e.status === 'dnd');
  await call('/api/me', { method: 'PATCH', body: { status: 'online', customStatus: { text: 'Playing Valheim', emoji: '⚔️', until: Date.now() + 300 } }, token: ann.token });
  const custom = await bobWs.next((e) => e.type === 'presence' && e.userId === ann.user.id && e.custom?.text === 'Playing Valheim');
  assert.equal(custom.custom.emoji, '⚔️');
  // It runs out by itself.
  await bobWs.next((e) => e.type === 'presence' && e.userId === ann.user.id && e.custom === null);
  // Idle on every device means away.
  annWs.send({ type: 'idle', idle: true });
  await bobWs.next((e) => e.type === 'presence' && e.userId === ann.user.id && e.status === 'away');
  annWs.send({ type: 'idle', idle: false });
  await bobWs.next((e) => e.type === 'presence' && e.userId === ann.user.id && e.status === 'online');
  annWs.send({ type: 'activity', name: '  Deep   Rock Galactic ' });
  const playing = await bobWs.next((e) => e.type === 'presence' && e.userId === ann.user.id && e.activity);
  assert.equal(playing.activity.name, 'Deep Rock Galactic');
  // The burrow's member list carries it all.
  const s = (await call('/api/servers', { token: bob.token })).data.find((x: any) => x.id === b.id);
  const annThere = s.members.find((m: any) => m.id === ann.user.id);
  assert.equal(annThere.status, 'online');
  assert.equal(annThere.activity.name, 'Deep Rock Galactic');
  // Leaving clears what you were playing.
  annWs.ws.close();
  const gone = await bobWs.next((e) => e.type === 'presence' && e.userId === ann.user.id && e.status === 'offline');
  assert.equal(gone.activity, null);
  const me = (await call('/api/me', { token: ann.token })).data;
  assert.equal(me.status, 'online');
  assert.equal((await call('/api/me', { method: 'PATCH', body: { status: 'invisible' }, token: ann.token })).status, 400);
  bobWs.ws.close();
});

test('push alerts go to people who are away, encrypted, and respect mute, do not disturb and quiet hours', async () => {
  const [ann, bob] = await people('ann', 'bob');
  const b = await burrow(ann, bob);
  const device = await subscribe(bob.token);
  // Only real push services are allowed.
  const bad = await call('/api/push', { body: { endpoint: 'https://example.com/x', keys: { p256dh: randomBytes(65).toString('base64url'), auth: randomBytes(16).toString('base64url') } }, token: bob.token });
  assert.equal(bad.status, 400);

  // Bob's app is closed: a mention reaches his phone.
  pushes.length = 0;
  await say(ann.token, b.room, `@${bob.user.username} you there?`);
  await wait(150);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].path, device);
  assert.match(pushes[0].authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/);
  assert.match(pushes[0].message.title, /^ann\d+ in #general \(Den\)$/);
  assert.equal(pushes[0].message.body, `@${bob.user.username} you there?`);
  assert.equal(pushes[0].message.silent, false);
  assert.equal(pushes[0].message.badge, 1);
  // Ordinary messages don't, unless he asked for every message.
  pushes.length = 0;
  await say(ann.token, b.room, 'just chatting');
  await wait(100);
  assert.equal(pushes.length, 0);

  // With the app open he sees it there; once that device goes idle, the push comes back.
  const bobWs = await socket(bob.token);
  await say(ann.token, b.room, `@${bob.user.username} again`);
  await wait(100);
  assert.equal(pushes.length, 0);
  bobWs.send({ type: 'idle', idle: true });
  await wait(50);
  await say(ann.token, b.room, `@${bob.user.username} and again`);
  await wait(150);
  assert.equal(pushes.length, 1);
  bobWs.ws.close();
  await wait(50);

  // Do not disturb: nothing.
  pushes.length = 0;
  await call('/api/me', { method: 'PATCH', body: { status: 'dnd' }, token: bob.token });
  await say(ann.token, b.room, `@${bob.user.username} hello?`);
  await wait(100);
  assert.equal(pushes.length, 0);
  await call('/api/me', { method: 'PATCH', body: { status: 'online' }, token: bob.token });

  // A muted room: nothing either.
  await call('/api/notify', { body: { serverId: b.id, channelId: b.room, level: null, mutedUntil: -1 }, token: bob.token });
  await say(ann.token, b.room, `@${bob.user.username} muted?`);
  await wait(100);
  assert.equal(pushes.length, 0);
  await call('/api/notify', { body: { serverId: b.id, channelId: b.room, level: 'all', mutedUntil: null }, token: bob.token });
  // "All messages" means every message.
  await say(ann.token, b.room, 'everything now');
  await wait(150);
  assert.equal(pushes.length, 1);

  // Quiet hours (all day here) make it silent.
  pushes.length = 0;
  const bad2 = await call('/api/me', { method: 'PATCH', body: { quietHours: { start: 0, end: 1439, timeZone: 'Mars/Olympus' } }, token: bob.token });
  assert.equal(bad2.status, 400);
  const me = (await call('/api/me', { method: 'PATCH', body: { quietHours: { start: 0, end: 1439, timeZone: 'UTC' } }, token: bob.token })).data;
  assert.deepEqual(me.quietHours, { start: 0, end: 1439, timeZone: 'UTC' });
  await say(ann.token, b.room, 'quiet please');
  await wait(150);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].message.silent, true);

  // A device the push service no longer knows is forgotten.
  pushStatus = 410;
  await say(ann.token, b.room, 'is this phone still there');
  await wait(150);
  pushStatus = 201;
  pushes.length = 0;
  await say(ann.token, b.room, 'and now');
  await wait(150);
  assert.equal(pushes.length, 0);
});

test('a direct message pushes to the other person', async () => {
  const [ann, bob] = await people('ann', 'bob');
  await burrow(ann, bob);
  const dm = (await call('/api/dms', { body: { userId: bob.user.id }, token: ann.token })).data;
  await subscribe(bob.token);
  pushes.length = 0;
  await say(ann.token, dm.channels[0].id, 'psst');
  await wait(150);
  assert.equal(pushes.length, 1);
  assert.match(pushes[0].message.title, /^ann\d+$/);
  assert.equal(pushes[0].message.badge, 1);
});

test('email: confirm an address with a code, then reset a forgotten password with it', async () => {
  const [bob, eve] = await people('bob', 'eve');
  mails.length = 0;
  let me = (await call('/api/me/email', { body: { email: 'bob@example.com' }, token: bob.token })).data;
  assert.equal(me.email, 'bob@example.com');
  assert.equal(me.emailVerified, false);
  assert.equal(mails.length, 1);
  const code = /code: (\d{6})/.exec(mailText(mails[0]).subject)![1];
  assert.equal((await call('/api/me/email/verify', { body: { code: code === '000000' ? '111111' : '000000' }, token: bob.token })).status, 400);
  me = (await call('/api/me/email/verify', { body: { code }, token: bob.token })).data;
  assert.equal(me.emailVerified, true);
  assert.equal((await call('/api/me/email', { body: { email: 'not an email' }, token: bob.token })).status, 400);

  // No confirmed email, or no such person: the same answer, and no email.
  mails.length = 0;
  assert.deepEqual((await call('/api/password/forgot', { body: { username: eve.user.username } })).data, { ok: true, minutes: 30 });
  assert.deepEqual((await call('/api/password/forgot', { body: { username: 'nobody-here' } })).data, { ok: true, minutes: 30 });
  assert.equal(mails.length, 0);

  // Bob forgot his: a code arrives, and a wrong one doesn't work.
  assert.equal((await call('/api/password/forgot', { body: { username: bob.user.username } })).status, 200);
  // The answer doesn't wait for the email (so its timing gives nothing away); it follows shortly.
  for (let i = 0; i < 40 && !mails.length; i++) await wait(50);
  assert.equal(mails.length, 1);
  const mail = mailText(mails[0]);
  const reset = /code: (\d{6})/.exec(mail.subject)![1];
  assert.match(mail.text, /https:\/\/burrow\.example\.com/);
  const wrong = reset === '000000' ? '111111' : '000000';
  assert.equal((await call('/api/password/reset', { body: { username: bob.user.username, code: wrong, newPassword: 'new-password' } })).status, 400);
  assert.equal((await call('/api/password/reset', { body: { username: bob.user.username, code: reset, newPassword: 'short' } })).status, 400);
  const done = await call('/api/password/reset', { body: { username: bob.user.username, code: reset, newPassword: 'new-password' } });
  assert.equal(done.status, 200);
  assert.ok(done.data.token);
  // Signed out everywhere else, the code is used up, and the new password works.
  assert.equal((await call('/api/me', { token: bob.token })).status, 401);
  assert.equal((await call('/api/password/reset', { body: { username: bob.user.username, code: reset, newPassword: 'another-one' } })).status, 400);
  assert.equal((await call('/api/login', { body: { username: bob.user.username, password: 'password1' } })).status, 401);
  assert.equal((await call('/api/login', { body: { username: bob.user.username, password: 'new-password' } })).status, 200);

  // Five wrong guesses and the code stops working.
  await call('/api/password/forgot', { body: { username: bob.user.username } });
  const next = /code: (\d{6})/.exec(mailText(mails.at(-1)!).subject)![1];
  const bad = next === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) await call('/api/password/reset', { body: { username: bob.user.username, code: bad, newPassword: 'whatever-1' } });
  assert.equal((await call('/api/password/reset', { body: { username: bob.user.username, code: next, newPassword: 'whatever-1' } })).status, 400);
});
