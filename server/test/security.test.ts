// The fixes from the October 2026 security review: each test is one way in that's now closed.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { openDb } from '../src/db.ts';
import { clientIp, createApp } from '../src/app.ts';

const app = createApp({
  db: openDb(':memory:'),
  publicDir: '/nonexistent',
  uploadDir: mkdtempSync(join(tmpdir(), 'peiskos-security-')),
  voice: { apiKey: 'key', apiSecret: 'secret-secret-secret-secret-secret', apiUrl: 'http://127.0.0.1:9' },
});
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

async function socket(token: string) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${token}`);
  const events: any[] = [];
  ws.on('message', (raw) => events.push(JSON.parse(String(raw))));
  const next = async (pred: (e: any) => boolean) => {
    for (let i = 0; i < 100; i++) {
      const at = events.findIndex(pred);
      if (at >= 0) return events.splice(at, 1)[0];
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('timed out waiting for event');
  };
  await next((e) => e.type === 'ready');
  return { ws, next, send: (msg: unknown) => ws.send(JSON.stringify(msg)) };
}

let n = 0;
async function people(...names: string[]) {
  const out: any[] = [];
  for (const name of names) out.push((await call('/api/register', { body: { username: `${name}${++n}`, password: 'password1' } })).data);
  return out;
}
async function burrow(host: any, ...others: any[]) {
  const b = (await call('/api/servers', { body: { name: 'Camp' }, token: host.token })).data;
  for (const o of others) await call('/api/join', { body: { inviteCode: b.inviteCode }, token: o.token });
  return b;
}

test("someone removed from a hearth can't edit what they wrote there", async () => {
  const [host, gone] = await people('host', 'gone');
  const b = await burrow(host, gone);
  const room = b.channels[0].id;
  const msg = (await call(`/api/channels/${room}/messages`, { body: { content: 'hello' }, token: gone.token })).data;
  assert.equal((await call(`/api/messages/${msg.id}`, { method: 'PATCH', body: { content: 'edited while here' }, token: gone.token })).status, 200);
  await call(`/api/servers/${b.id}/members/${gone.user.id}/remove`, { body: { ban: true }, token: host.token });
  const after = await call(`/api/messages/${msg.id}`, { method: 'PATCH', body: { content: 'spam from outside' }, token: gone.token });
  assert.equal(after.status, 404);
  const kept = (await call(`/api/channels/${room}/messages`, { token: host.token })).data;
  assert.equal(kept.find((m: any) => m.id === msg.id).content, 'edited while here');
});

test("someone who manages roles can't hand out a role that allows more than they can do", async () => {
  const [host, mod, kim] = await people('host', 'mod', 'kim');
  const b = await burrow(host, mod, kim);
  const sid = b.id;
  const role = async (name: string, perms: string[]) => {
    const roles = (await call(`/api/servers/${sid}/roles`, { body: { name, perms }, token: host.token })).data.roles;
    return roles.find((r: any) => r.name === name).id;
  };
  const roleManager = await role('Role manager', ['roles']);
  const banHammer = await role('Ban hammer', ['ban', 'remove']);
  const friends = await role('Friends', []);
  const give = (who: any, target: any, roleIds: number[]) => call(`/api/servers/${sid}/members/${target.user.id}/roles`, { body: { roleIds }, token: who.token });
  assert.equal((await give(host, mod, [roleManager])).status, 200);

  // A role that allows only what they can do themselves is fine, for others or themselves.
  assert.equal((await give(mod, kim, [friends])).status, 200);
  // One that allows more is not: not to someone else, and not to themselves.
  assert.equal((await give(mod, kim, [friends, banHammer])).status, 403);
  assert.equal((await give(mod, mod, [roleManager, banHammer])).status, 403);
  // The host still can, and then the role manager can't take it away either.
  assert.equal((await give(host, kim, [friends, banHammer])).status, 200);
  assert.equal((await give(mod, kim, [friends])).status, 403);
  const view = (await call('/api/servers', { token: host.token })).data.find((s: any) => s.id === sid);
  assert.deepEqual(view.members.find((m: any) => m.id === kim.user.id).roleIds.sort(), [banHammer, friends].sort());
});

test("a timeout stops fireside chat too", async () => {
  const [host, kim] = await people('host', 'kim');
  const b = await burrow(host, kim);
  const fire = (await call(`/api/servers/${b.id}/channels`, { body: { name: 'Fire', kind: 'voice' }, token: host.token })).data.channels.find((c: any) => c.kind === 'voice');
  const k = await socket(kim.token);
  k.send({ type: 'voice_join', channelId: fire.id });
  await k.next((e) => e.type === 'fireside_history');
  k.send({ type: 'fireside_send', content: 'before' });
  await k.next((e) => e.type === 'fireside' && e.message.content === 'before');
  await call(`/api/servers/${b.id}/members/${kim.user.id}/timeout`, { body: { minutes: 10 }, token: host.token });
  k.send({ type: 'fireside_send', content: 'during' });
  const err = await k.next((e) => e.type === 'error');
  assert.match(err.error, /timed out/);
  k.ws.close();
});

test('a broken frame on the live connection closes it, and the server keeps running', async () => {
  const [kim] = await people('kim');
  const { ws } = await socket(kim.token);
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
  ws.send(Buffer.from([0xff, 0xfe]), { binary: false }); // not valid UTF-8 text
  assert.equal(await closed, 1007);
  assert.equal((await call('/api/me', { token: kim.token })).status, 200);
});

test('the live connection refuses huge messages', async () => {
  const [kim] = await people('kim');
  const { ws } = await socket(kim.token);
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
  ws.send(JSON.stringify({ type: 'typing', pad: 'x'.repeat(200 * 1024) }));
  assert.equal(await closed, 1009); // "message too big"
});

test('files waiting to be sent are limited per person', async () => {
  const [host] = await people('host');
  const b = await burrow(host);
  const upload = () =>
    fetch(`${base}/api/channels/${b.channels[0].id}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${host.token}`, 'content-type': 'text/plain', 'x-filename': 'a.txt' },
      body: 'hello',
    });
  for (let i = 0; i < 30; i++) assert.equal((await upload()).status, 200);
  const res = await upload();
  assert.equal(res.status, 429);
  await res.json();
});

test("a forwarded address is only believed from this machine or Docker's network", () => {
  const ip = (remoteAddress: string, forwarded?: string) =>
    clientIp({ socket: { remoteAddress }, headers: forwarded ? { 'x-forwarded-for': forwarded } : {} } as never);
  // Caddy on this machine, or reaching the container through Docker's network: it says who the visitor is.
  assert.equal(ip('127.0.0.1', '198.51.100.7'), '198.51.100.7');
  assert.equal(ip('::ffff:172.18.0.1', '198.51.100.7'), '198.51.100.7');
  assert.equal(ip('::1', '1.2.3.4, 198.51.100.7'), '198.51.100.7');
  // Anyone else saying who they are is ignored (172.217.x.x is a public address, not Docker's).
  assert.equal(ip('172.217.1.1', '10.9.9.9'), '172.217.1.1');
  assert.equal(ip('203.0.113.5', '10.9.9.9'), '203.0.113.5');
  assert.equal(ip('203.0.113.5'), '203.0.113.5');
});
