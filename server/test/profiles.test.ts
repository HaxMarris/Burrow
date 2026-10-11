import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { openDb } from '../src/db.ts';
import { createApp } from '../src/app.ts';
import { encodeCbor, totpCode, totpStep } from '../src/account.ts';

const dir = mkdtempSync(join(tmpdir(), 'burrow-profiles-'));
const dbFile = join(dir, 'chat.db');
const db = openDb(dbFile);
const app = createApp({ db, publicDir: '/nonexistent', uploadDir: join(dir, 'uploads') });
let base = '';
before(async () => {
  await new Promise<void>((r) => app.listen(0, r));
  base = `http://localhost:${(app.address() as AddressInfo).port}`;
});
after(() => {
  app.closeAllConnections();
  app.close();
});

async function call(path: string, opts: { method?: string; body?: unknown; token?: string; ua?: string } = {}) {
  const res = await fetch(base + path, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.ua ? { 'user-agent': opts.ua } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, data: (await res.json()) as any };
}
const register = async (username: string) => (await call('/api/register', { body: { username, password: 'password1' } })).data;
function listen(token: string) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws?token=' + token);
  const events: any[] = [];
  let closeCode = 0;
  ws.on('message', (d) => events.push(JSON.parse(String(d))));
  const closed = new Promise<void>((r) => ws.on('close', (code) => { closeCode = code; r(); }));
  const ready = new Promise<void>((r) => ws.on('message', () => r()));
  return { ws, events, ready, closed, code: () => closeCode };
}
const tick = () => new Promise((r) => setTimeout(r, 100));

test('display names, nicknames and profile cards', async () => {
  const ann = await register('ann');
  const ben = await register('ben');
  const burrow = (await call('/api/servers', { body: { name: 'Lodge' }, token: ann.token })).data;
  await call('/api/join', { body: { inviteCode: burrow.inviteCode }, token: ben.token });
  const room = burrow.channels[0].id;
  const benSocket = listen(ben.token);
  await benSocket.ready;

  const me = await call('/api/me', { method: 'PATCH', body: { displayName: '  Ann  the Bold ', bio: 'Hello there', accent: '#AA3366' }, token: ann.token });
  assert.equal(me.status, 200);
  assert.equal(me.data.displayName, 'Ann the Bold');
  assert.equal(me.data.bio, 'Hello there');
  assert.equal(me.data.accent, '#aa3366');
  assert.equal(me.data.username, 'ann'); // logging in is unchanged
  assert.equal((await call('/api/me', { method: 'PATCH', body: { bio: 'x'.repeat(191) }, token: ann.token })).status, 400);
  assert.equal((await call('/api/me', { method: 'PATCH', body: { accent: 'red' }, token: ann.token })).status, 400);
  await tick();
  const update = benSocket.events.find((e) => e.type === 'user_updated' && e.user.id === ann.user.id);
  assert.equal(update.user.displayName, 'Ann the Bold');

  // Messages carry the name people see; a nickname in a burrow wins there.
  let msg = (await call(`/api/channels/${room}/messages`, { body: { content: 'hi' }, token: ann.token })).data;
  assert.equal(msg.author, 'Ann the Bold');
  assert.equal(msg.authorUsername, 'ann');
  const nick = await call(`/api/servers/${burrow.id}/nickname`, { method: 'PATCH', body: { nickname: 'Boss' }, token: ann.token });
  assert.equal(nick.data.members.find((m: any) => m.id === ann.user.id).nickname, 'Boss');
  msg = (await call(`/api/channels/${room}/messages`, { body: { content: 'again' }, token: ann.token })).data;
  assert.equal(msg.author, 'Boss');

  // Ben can open Ann's card; a stranger can't.
  const card = await call(`/api/users/${ann.user.id}`, { token: ben.token });
  assert.equal(card.data.bio, 'Hello there');
  assert.deepEqual(card.data.mutualBurrows.map((b: any) => b.name), ['Lodge']);
  const stranger = await register('stranger');
  assert.equal((await call(`/api/users/${ann.user.id}`, { token: stranger.token })).status, 404);
  benSocket.ws.close();
});

test('friends: requests, accepting, DMs without a shared burrow, presence', async () => {
  const cat = await register('cat');
  const dan = await register('dan');
  const danSocket = listen(dan.token);
  await danSocket.ready;
  // Not friends and no shared burrow: no DM.
  assert.equal((await call('/api/dms', { body: { userId: dan.user.id }, token: cat.token })).status, 403);
  assert.equal((await call('/api/friends', { body: { username: 'nobody' }, token: cat.token })).status, 404);
  assert.equal((await call('/api/friends', { body: { username: 'cat' }, token: cat.token })).status, 400);
  const sent = await call('/api/friends', { body: { username: '@dan' }, token: cat.token });
  assert.equal(sent.data.outgoing[0].username, 'dan');
  await tick();
  assert.equal(danSocket.events.findLast((e) => e.type === 'friends').incoming[0].username, 'cat');
  // Still pending: no DM yet.
  assert.equal((await call('/api/dms', { body: { userId: dan.user.id }, token: cat.token })).status, 403);
  const accepted = await call(`/api/friends/${cat.user.id}/accept`, { body: {}, token: dan.token });
  assert.equal(accepted.data.friends[0].username, 'cat');
  assert.equal(accepted.data.friends[0].online, false);
  assert.equal((await call('/api/dms', { body: { userId: dan.user.id }, token: cat.token })).status, 200);
  // Friends see each other come online.
  const catSocket = listen(cat.token);
  await catSocket.ready;
  await tick();
  assert.ok(danSocket.events.some((e) => e.type === 'presence' && e.userId === cat.user.id && e.online));
  // Asking someone who already asked you makes you friends; unfriending ends it.
  assert.equal((await call(`/api/friends/${dan.user.id}`, { method: 'DELETE', token: cat.token })).data.friends.length, 0);
  catSocket.ws.close();
  danSocket.ws.close();
});

test('blocking stops DMs, friend requests and pings', async () => {
  const eve = await register('eve');
  const fay = await register('fay');
  const burrow = (await call('/api/servers', { body: { name: 'Glade' }, token: eve.token })).data;
  await call('/api/join', { body: { inviteCode: burrow.inviteCode }, token: fay.token });
  const dm = (await call('/api/dms', { body: { userId: fay.user.id }, token: eve.token })).data;
  await call('/api/friends', { body: { username: 'fay' }, token: eve.token });
  const blocked = await call('/api/blocks', { body: { userId: fay.user.id }, token: eve.token });
  assert.deepEqual(blocked.data.blockedIds, [fay.user.id]);
  // The friend request went with it, and neither side can write in their DM.
  assert.equal((await call('/api/friends', { token: fay.token })).data.incoming.length, 0);
  const dmRoom = dm.channels[0].id;
  assert.equal((await call(`/api/channels/${dmRoom}/messages`, { body: { content: 'hey' }, token: fay.token })).status, 403);
  assert.equal((await call(`/api/channels/${dmRoom}/messages`, { body: { content: 'hey' }, token: eve.token })).status, 403);
  // Fay can't send a friend request; it looks like nobody is there.
  assert.equal((await call('/api/friends', { body: { username: 'eve' }, token: fay.token })).status, 404);
  // An @mention from someone you blocked doesn't reach your inbox.
  await call(`/api/channels/${burrow.channels[0].id}/messages`, { body: { content: '@eve look' }, token: fay.token });
  assert.equal((await call('/api/mentions', { token: eve.token })).data.messages.length, 0);
  await call(`/api/channels/${burrow.channels[0].id}/messages`, { body: { content: '@fay hi' }, token: eve.token });
  assert.equal((await call('/api/mentions', { token: fay.token })).data.messages.length, 1); // only the blocker is spared
  await call(`/api/blocks/${fay.user.id}`, { method: 'DELETE', token: eve.token });
  assert.equal((await call(`/api/channels/${dmRoom}/messages`, { body: { content: 'hey' }, token: fay.token })).status, 200);
});

test('changing your username, and your devices', async () => {
  const gus = await register('gus');
  await register('taken');
  const phone = (await call('/api/login', { body: { username: 'gus', password: 'password1' }, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1' })).data;
  const phoneSocket = listen(phone.token);
  await phoneSocket.ready;
  assert.equal((await call('/api/me/username', { body: { username: 'gus2', password: 'wrong' }, token: gus.token })).status, 403);
  assert.equal((await call('/api/me/username', { body: { username: 'TAKEN', password: 'password1' }, token: gus.token })).status, 409);
  assert.equal((await call('/api/me/username', { body: { username: 'bad name', password: 'password1' }, token: gus.token })).status, 400);
  assert.equal((await call('/api/me/username', { body: { username: 'Gus2', password: 'password1' }, token: gus.token })).data.username, 'Gus2');
  assert.equal((await call('/api/login', { body: { username: 'gus2', password: 'password1' } })).status, 200);
  assert.equal((await call('/api/login', { body: { username: 'gus', password: 'password1' } })).status, 401);

  const list = (await call('/api/me/sessions', { token: gus.token })).data;
  assert.equal(list.length, 3);
  const iphone = list.find((s: any) => s.device === 'Safari on iPhone');
  assert.ok(iphone && iphone.online && !iphone.current);
  assert.equal(list.filter((s: any) => s.current).length, 1);
  assert.equal((await call(`/api/me/sessions/${iphone.id}`, { method: 'DELETE', token: gus.token })).status, 200);
  await phoneSocket.closed;
  assert.equal(phoneSocket.code(), 4001);
  assert.equal((await call('/api/me', { token: phone.token })).status, 401);
  assert.equal((await call('/api/me/sessions', { method: 'DELETE', token: gus.token })).status, 200);
  assert.equal((await call('/api/me/sessions', { token: gus.token })).data.length, 1);
});

test('two-step login is optional, and asks for a code once on', async () => {
  const hal = await register('hal');
  // Off by default: a password is enough.
  assert.ok((await call('/api/login', { body: { username: 'hal', password: 'password1' } })).data.token);
  assert.equal((await call('/api/me', { token: hal.token })).data.twoStep, false);
  const setup = (await call('/api/me/two-step/setup', { body: { password: 'password1' }, token: hal.token })).data;
  assert.match(setup.uri, /^otpauth:\/\/totp\/Peiskos%3Ahal\?secret=/);
  assert.equal((await call('/api/me/two-step/enable', { body: { code: '000000' }, token: hal.token })).status, 400);
  const on = (await call('/api/me/two-step/enable', { body: { code: totpCode(setup.secret, totpStep()) }, token: hal.token })).data;
  assert.equal(on.recoveryCodes.length, 10);
  assert.equal(on.me.twoStep, true);

  const first = (await call('/api/login', { body: { username: 'hal', password: 'password1' } })).data;
  assert.equal(first.token, undefined);
  assert.equal(first.twoStep, true);
  assert.equal((await call('/api/login/two-step', { body: { ticket: first.ticket, code: '123456' } })).status, 401);
  // The code that turned it on was used already; the next one works once.
  const next = totpCode(setup.secret, totpStep() + 1);
  const ok = await call('/api/login/two-step', { body: { ticket: first.ticket, code: next } });
  assert.ok(ok.data.token);
  const again = (await call('/api/login', { body: { username: 'hal', password: 'password1' } })).data;
  assert.equal((await call('/api/login/two-step', { body: { ticket: again.ticket, code: next } })).status, 401);
  // A recovery code works once.
  const rescue = on.recoveryCodes[0].toUpperCase();
  assert.ok((await call('/api/login/two-step', { body: { ticket: again.ticket, code: rescue } })).data.token);
  const third = (await call('/api/login', { body: { username: 'hal', password: 'password1' } })).data;
  assert.equal((await call('/api/login/two-step', { body: { ticket: third.ticket, code: rescue } })).status, 401);
  assert.equal((await call('/api/me', { token: hal.token })).data.recoveryCodesLeft, 9);
  // Turning it off needs the password and a code.
  assert.equal((await call('/api/me/two-step/disable', { body: { password: 'password1' }, token: hal.token })).status, 403);
  assert.equal((await call('/api/me/two-step/disable', { body: { password: 'password1', code: on.recoveryCodes[1] }, token: hal.token })).data.twoStep, false);
  assert.ok((await call('/api/login', { body: { username: 'hal', password: 'password1' } })).data.token);
});

test('passkeys', async () => {
  const ivy = await register('ivy');
  const origin = base;
  const rpIdHash = createHash('sha256').update('localhost').digest();
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credId = randomBytes(16);
  const b64 = (b: Buffer) => b.toString('base64url');
  const clientData = (type: string, challenge: string, from = origin) => b64(Buffer.from(JSON.stringify({ type, challenge, origin: from })));

  assert.equal((await call('/api/me/passkeys/options', { body: { password: 'nope' }, token: ivy.token })).status, 403);
  const opts = (await call('/api/me/passkeys/options', { body: { password: 'password1' }, token: ivy.token })).data;
  assert.equal(opts.rp.id, 'localhost');
  const cose = new Map<any, any>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')]]);
  const counter = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const idLen = Buffer.alloc(2); idLen.writeUInt16BE(credId.length);
  const authData = Buffer.concat([rpIdHash, Buffer.from([0x45]), counter(0), Buffer.alloc(16), idLen, credId, encodeCbor(cose)]);
  const attestationObject = b64(encodeCbor(new Map<any, any>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]])));
  const added = await call('/api/me/passkeys', {
    body: { credential: { id: b64(credId), response: { clientDataJSON: clientData('webauthn.create', opts.challenge), attestationObject } } },
    token: ivy.token,
    ua: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120',
  });
  assert.equal(added.status, 200);
  assert.equal(added.data[0].name, 'Passkey on Windows');

  const login = async (signCount: number, from = origin) => {
    const o = (await call('/api/login/passkey/options', { body: {} })).data;
    const ad = Buffer.concat([rpIdHash, Buffer.from([0x05]), counter(signCount)]);
    const cd = clientData('webauthn.get', o.challenge, from);
    const signature = sign('sha256', Buffer.concat([ad, createHash('sha256').update(Buffer.from(cd, 'base64url')).digest()]), privateKey);
    return call('/api/login/passkey', { body: { id: o.id, credential: { id: b64(credId), response: { clientDataJSON: cd, authenticatorData: b64(ad), signature: b64(signature) } } } });
  };
  const ok = await login(1);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.username, 'ivy');
  assert.equal((await login(1)).status, 401); // the counter has to go up
  assert.equal((await login(5, 'https://evil.example')).status, 401);
  assert.equal((await login(6)).status, 200);
  const list = (await call('/api/me/passkeys', { token: ivy.token })).data;
  assert.equal((await call(`/api/me/passkeys/${list[0].id}`, { method: 'DELETE', token: ivy.token })).data.length, 0);
  assert.equal((await login(7)).status, 401);
});

test('a reset link from whoever runs the server', async () => {
  const jo = await register('jo');
  const out = execFileSync(process.execPath, ['--no-warnings', join(import.meta.dirname, '../src/reset-link.ts'), 'jo'], {
    env: { ...process.env, DB_FILE: dbFile, PUBLIC_URL: 'https://burrow.example/' },
  }).toString();
  const token = out.match(/\?reset=([\w-]+)/)![1];
  assert.match(out, /https:\/\/burrow\.example\/\?reset=/);
  assert.equal((await call(`/api/password/link?token=${token}`)).data.username, 'jo');
  assert.equal((await call('/api/password/link', { body: { token, newPassword: 'short' } })).status, 400);
  const done = await call('/api/password/link', { body: { token, newPassword: 'newpassword' } });
  assert.ok(done.data.token);
  assert.equal((await call('/api/me', { token: jo.token })).status, 401); // signed out elsewhere
  assert.equal((await call('/api/password/link', { body: { token, newPassword: 'another1' } })).status, 400); // used up
  assert.equal((await call('/api/login', { body: { username: 'jo', password: 'newpassword' } })).status, 200);
});

test('export my data', async () => {
  const kim = await register('kim');
  const burrow = (await call('/api/servers', { body: { name: 'Nook' }, token: kim.token })).data;
  await call(`/api/channels/${burrow.channels[0].id}/messages`, { body: { content: 'note to self' }, token: kim.token });
  const up = await fetch(`${base}/api/channels/${burrow.channels[0].id}/attachments`, {
    method: 'POST', headers: { authorization: `Bearer ${kim.token}`, 'x-filename': 'hello.txt', 'content-type': 'text/plain' }, body: 'hello file',
  });
  const att = (await up.json()) as any;
  await call(`/api/channels/${burrow.channels[0].id}/messages`, { body: { content: '', attachmentIds: [att.id] }, token: kim.token });
  const res = await fetch(`${base}/api/me/export`, { headers: { authorization: `Bearer ${kim.token}` } });
  assert.equal(res.headers.get('content-type'), 'application/zip');
  const zip = Buffer.from(await res.arrayBuffer());
  const zipFile = join(dir, 'export.zip');
  (await import('node:fs')).writeFileSync(zipFile, zip);
  // Python's zipfile checks every CRC.
  const listing = execFileSync('python3', ['-c', 'import sys,zipfile,json;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(json.dumps({n:z.read(n).decode("utf8","replace") for n in z.namelist()}))', zipFile]).toString();
  const files = JSON.parse(listing);
  assert.equal(JSON.parse(files['account.json']).username, 'kim');
  const messages = JSON.parse(files['messages.json']);
  assert.equal(messages[0].content, 'note to self');
  assert.equal(messages[0].place, 'Nook › #general');
  assert.equal(files[messages[1].files[0]], 'hello file');
  assert.equal((await fetch(`${base}/api/me/export`)).status, 401);
});

test('deleting your account', async () => {
  const lee = await register('lee');
  const mo = await register('mo');
  const hosted = (await call('/api/servers', { body: { name: 'Lee place' }, token: lee.token })).data;
  const other = (await call('/api/servers', { body: { name: 'Mo place' }, token: mo.token })).data;
  await call('/api/join', { body: { inviteCode: other.inviteCode }, token: lee.token });
  await call('/api/join', { body: { inviteCode: hosted.inviteCode }, token: mo.token });
  await call(`/api/channels/${other.channels[0].id}/messages`, { body: { content: 'kept' }, token: lee.token });
  const dm = (await call('/api/dms', { body: { userId: mo.user.id }, token: lee.token })).data;
  await call(`/api/channels/${dm.channels[0].id}/messages`, { body: { content: 'dm kept' }, token: lee.token });
  await call('/api/friends', { body: { username: 'mo' }, token: lee.token });

  assert.equal((await call('/api/me', { method: 'DELETE', body: { password: 'wrong' }, token: lee.token })).status, 403);
  // Mo is in the burrow Lee hosts, so it has to be handed over first.
  const busy = await call('/api/me', { method: 'DELETE', body: { password: 'password1' }, token: lee.token });
  assert.equal(busy.status, 409);
  assert.match(busy.data.error, /Lee place/);
  await call(`/api/servers/${hosted.id}/transfer`, { body: { userId: mo.user.id }, token: lee.token });
  const leeSocket = listen(lee.token);
  await leeSocket.ready;
  assert.equal((await call('/api/me', { method: 'DELETE', body: { password: 'password1' }, token: lee.token })).status, 200);
  await leeSocket.closed;
  assert.equal((await call('/api/me', { token: lee.token })).status, 401);
  assert.equal((await call('/api/login', { body: { username: 'lee', password: 'password1' } })).status, 401);
  // Messages stay, from "Deleted user"; Lee is out of the burrow; the DM stays but can't be answered.
  const msgs = (await call(`/api/channels/${other.channels[0].id}/messages`, { token: mo.token })).data;
  assert.equal(msgs.find((m: any) => m.content === 'kept').author, 'Deleted user');
  const summary = (await call('/api/servers', { token: mo.token })).data.find((s: any) => s.id === other.id);
  assert.ok(!summary.members.some((m: any) => m.id === lee.user.id));
  assert.equal((await call(`/api/channels/${dm.channels[0].id}/messages`, { body: { content: 'hello?' }, token: mo.token })).status, 403);
  assert.equal((await call('/api/friends', { token: mo.token })).data.incoming.length, 0);
  // The username is free again.
  assert.equal((await call('/api/register', { body: { username: 'lee', password: 'password1' } })).status, 200);

  // Choosing to take your messages with you.
  const ned = await register('ned');
  await call('/api/join', { body: { inviteCode: other.inviteCode }, token: ned.token });
  await call(`/api/channels/${other.channels[0].id}/messages`, { body: { content: 'gone soon' }, token: ned.token });
  assert.equal((await call('/api/me', { method: 'DELETE', body: { password: 'password1', deleteMessages: true }, token: ned.token })).status, 200);
  const after = (await call(`/api/channels/${other.channels[0].id}/messages`, { token: mo.token })).data;
  assert.ok(!after.some((m: any) => m.content === 'gone soon'));
});
