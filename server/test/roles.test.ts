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

function listen(token: string) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws?token=' + token);
  const events: any[] = [];
  ws.on('message', (d) => events.push(JSON.parse(String(d))));
  const ready = new Promise<void>((r) => ws.once('message', () => r()));
  return { ws, events, ready };
}
const tick = () => new Promise((r) => setTimeout(r, 100));

test('moderators, private rooms, removing and banning', async () => {
  const reg = async (username: string) => (await call('/api/register', { body: { username, password: 'password1' } })).data;
  const host = await reg('host');
  const mod = await reg('mod');
  const amy = await reg('amy');
  const bob = await reg('bob');
  const burrow = (await call('/api/servers', { body: { name: 'Den' }, token: host.token })).data;
  for (const u of [mod, amy, bob]) await call('/api/join', { body: { inviteCode: burrow.inviteCode }, token: u.token });
  const sid = burrow.id;
  const general = burrow.channels[0].id;
  const myView = async (u: any) => (await call('/api/servers', { token: u.token })).data[0];

  // Every burrow starts with a Moderator role, and the host hands it out.
  const modRole = burrow.roles.find((r: any) => r.name === 'Moderator').id;
  const makeMod = (who: any, target: any) =>
    call(`/api/servers/${sid}/members/${target.user.id}/roles`, { body: { roleIds: [modRole] }, token: who.token });
  assert.equal((await makeMod(amy, amy)).status, 403);
  assert.equal((await makeMod(host, mod)).status, 200);
  const roles = Object.fromEntries((await myView(amy)).members.map((m: any) => [m.username, m.role]));
  assert.deepEqual(roles, { amy: 'member', bob: 'member', host: 'host', mod: 'mod' });
  assert.deepEqual((await myView(amy)).members.find((m: any) => m.username === 'mod').roleIds, [modRole]);
  assert.equal((await makeMod(mod, amy)).status, 403);

  // Moderators can make rooms; members can't.
  assert.equal((await call(`/api/servers/${sid}/channels`, { body: { name: 'nope' }, token: amy.token })).status, 403);
  const made = (await call(`/api/servers/${sid}/channels`, { body: { name: 'Secret Plans', private: true, memberIds: [amy.user.id, 9999] }, token: mod.token })).data;
  const secret = made.channels.find((c: any) => c.name === 'secret-plans');
  assert.equal(secret.private, true);
  assert.deepEqual(secret.memberIds, [amy.user.id]);

  // A private room is only seen by the host, moderators and the people let in.
  const sees = async (u: any) => (await myView(u)).channels.some((c: any) => c.id === secret.id);
  assert.deepEqual([await sees(host), await sees(mod), await sees(amy), await sees(bob)], [true, true, true, false]);
  assert.equal((await myView(amy)).channels.find((c: any) => c.id === secret.id).memberIds, undefined);
  assert.equal((await call(`/api/channels/${secret.id}/messages`, { token: bob.token })).status, 404);
  assert.equal((await call(`/api/channels/${secret.id}/messages`, { body: { content: 'hi' }, token: bob.token })).status, 404);

  const bobSocket = listen(bob.token);
  const amySocket = listen(amy.token);
  await Promise.all([bobSocket.ready, amySocket.ready]);
  await call(`/api/channels/${secret.id}/messages`, { body: { content: 'the plan' }, token: amy.token });
  await tick();
  assert.ok(amySocket.events.some((e) => e.type === 'message' && e.message.content === 'the plan'));
  assert.ok(!bobSocket.events.some((e) => e.type === 'message'));

  // Let bob in, rename it, then make it public again.
  await call(`/api/channels/${secret.id}`, { method: 'PATCH', body: { memberIds: [amy.user.id, bob.user.id], name: 'Plans' }, token: mod.token });
  assert.equal(await sees(bob), true);
  assert.equal((await myView(bob)).channels.find((c: any) => c.id === secret.id).name, 'plans');
  assert.equal((await call(`/api/channels/${secret.id}`, { method: 'PATCH', body: { private: false }, token: amy.token })).status, 403);
  await call(`/api/channels/${secret.id}`, { method: 'PATCH', body: { private: false }, token: host.token });
  assert.equal((await myView(bob)).channels.find((c: any) => c.id === secret.id).private, false);

  // Moderators can delete anyone's message; members only their own.
  const bobMsg = (await call(`/api/channels/${general}/messages`, { body: { content: 'spam' }, token: bob.token })).data;
  assert.equal((await call(`/api/messages/${bobMsg.id}`, { method: 'DELETE', token: amy.token })).status, 403);
  assert.equal((await call(`/api/messages/${bobMsg.id}`, { method: 'DELETE', token: mod.token })).status, 200);

  // Rooms can be deleted, but not the last text room.
  assert.equal((await call(`/api/channels/${secret.id}`, { method: 'DELETE', token: mod.token })).status, 200);
  assert.equal((await call(`/api/channels/${general}`, { method: 'DELETE', token: host.token })).status, 400);

  // Moderators can remove members, but not other moderators or the host.
  const remove = (who: any, target: any, ban = false) =>
    call(`/api/servers/${sid}/members/${target.user.id}/remove`, { body: { ban }, token: who.token });
  assert.equal((await remove(amy, bob)).status, 403);
  assert.equal((await remove(mod, host)).status, 403);
  const mod2 = await reg('mod2');
  await call('/api/join', { body: { inviteCode: burrow.inviteCode }, token: mod2.token });
  await makeMod(host, mod2);
  assert.equal((await remove(mod, mod2)).status, 403);

  // Removed people can come back with the invite; banned people can't until unbanned.
  assert.equal((await remove(mod, amy)).status, 200);
  await tick();
  assert.ok(amySocket.events.some((e) => e.type === 'server_deleted' && e.serverId === sid));
  assert.equal((await call('/api/join', { body: { inviteCode: burrow.inviteCode }, token: amy.token })).status, 200);
  assert.equal((await remove(mod, bob, true)).status, 200);
  assert.equal((await call('/api/join', { body: { inviteCode: burrow.inviteCode }, token: bob.token })).status, 403);
  assert.equal((await call(`/api/servers/${sid}/bans`, { token: amy.token })).status, 403);
  const bans = (await call(`/api/servers/${sid}/bans`, { token: mod.token })).data;
  assert.deepEqual(bans.map((b: any) => b.username), ['bob']);
  await call(`/api/servers/${sid}/bans/${bob.user.id}`, { method: 'DELETE', token: host.token });
  assert.equal((await call('/api/join', { body: { inviteCode: burrow.inviteCode }, token: bob.token })).status, 200);

  // DMs have no moderators.
  const dm = (await call('/api/dms', { body: { userId: amy.user.id }, token: bob.token })).data;
  assert.equal((await call(`/api/servers/${dm.id}/members/${amy.user.id}/remove`, { body: {}, token: bob.token })).status, 404);
  bobSocket.ws.close();
  amySocket.ws.close();
});
