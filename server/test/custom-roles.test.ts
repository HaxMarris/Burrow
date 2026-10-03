import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
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

test('custom roles: permissions, ranks, colors and private rooms', async () => {
  const reg = async (username: string) => (await call('/api/register', { body: { username, password: 'password1' } })).data;
  const host = await reg('chief');
  const lead = await reg('lead');
  const helper = await reg('helper');
  const kim = await reg('kim');
  const burrow = (await call('/api/servers', { body: { name: 'Camp' }, token: host.token })).data;
  for (const u of [lead, helper, kim]) await call('/api/join', { body: { inviteCode: burrow.inviteCode }, token: u.token });
  const sid = burrow.id;
  const view = async (u: any) => (await call('/api/servers', { token: u.token })).data[0];
  const newRole = (u: any, body: any) => call(`/api/servers/${sid}/roles`, { body, token: u.token });
  const give = (u: any, target: any, roleIds: number[]) =>
    call(`/api/servers/${sid}/members/${target.user.id}/roles`, { body: { roleIds }, token: u.token });
  const roleNamed = async (name: string) => (await view(host)).roles.find((r: any) => r.name === name);

  // Only people allowed to manage roles can make them, and colors are checked.
  assert.equal((await newRole(kim, { name: 'Nope' })).status, 403);
  assert.equal((await newRole(host, { name: 'Bad', color: 'red' })).status, 400);
  await newRole(host, { name: 'Lead', color: '#AA3300', perms: ['roles', 'remove', 'rooms', 'bogus'] });
  await newRole(host, { name: 'Helper', color: '#336699', perms: ['messages'] });
  await newRole(host, { name: 'Friends', color: '#22aa44' });
  const names = (await view(kim)).roles.map((r: any) => r.name);
  assert.deepEqual(names, ['Moderator', 'Lead', 'Helper', 'Friends']);
  const leadRole = await roleNamed('Lead');
  assert.deepEqual(leadRole.perms, ['rooms', 'remove', 'roles']);
  assert.equal(leadRole.color, '#aa3300');

  // Move Lead to the top, above Moderator.
  await call(`/api/roles/${leadRole.id}`, { method: 'PATCH', body: { move: 'up' }, token: host.token });
  assert.deepEqual((await view(host)).roles.map((r: any) => r.name), ['Lead', 'Moderator', 'Helper', 'Friends']);

  const helperRole = await roleNamed('Helper');
  const friends = await roleNamed('Friends');
  const modRole = await roleNamed('Moderator');
  assert.equal((await give(host, lead, [leadRole.id])).status, 200);
  assert.equal((await give(host, helper, [helperRole.id, friends.id])).status, 200);
  assert.deepEqual((await view(kim)).members.find((m: any) => m.username === 'helper').roleIds, [helperRole.id, friends.id]);

  // A lead can hand out roles below their own, but not their own role or ones above it.
  assert.equal((await give(lead, kim, [friends.id])).status, 200);
  assert.equal((await give(lead, kim, [leadRole.id])).status, 403);
  assert.equal((await give(lead, host, [])).status, 403);
  // They can't give permissions they don't have, but the ones they lack stay put.
  await call(`/api/roles/${helperRole.id}`, { method: 'PATCH', body: { perms: ['remove', 'ban'] }, token: lead.token });
  assert.deepEqual((await roleNamed('Helper')).perms, ['messages', 'remove']);
  // And they can't touch their own role, or move a role above it.
  assert.equal((await call(`/api/roles/${leadRole.id}`, { method: 'PATCH', body: { name: 'Boss' }, token: lead.token })).status, 403);
  assert.equal((await call(`/api/roles/${modRole.id}`, { method: 'PATCH', body: { move: 'up' }, token: lead.token })).status, 403);

  // Messages: helpers can delete other people's.
  const general = burrow.channels[0].id;
  const kimMsg = (await call(`/api/channels/${general}/messages`, { body: { content: 'oops' }, token: kim.token })).data;
  assert.equal((await call(`/api/messages/${kimMsg.id}`, { method: 'DELETE', token: lead.token })).status, 403);
  assert.equal((await call(`/api/messages/${kimMsg.id}`, { method: 'DELETE', token: helper.token })).status, 200);

  // A private room opened to a role: everyone with the role sees it, and loses it with the role.
  const made = (await call(`/api/servers/${sid}/channels`, { body: { name: 'friends-only', private: true, roleIds: [friends.id, 9999] }, token: lead.token })).data;
  const room = made.channels.find((c: any) => c.name === 'friends-only');
  assert.deepEqual(room.roleIds, [friends.id]);
  const sees = async (u: any) => (await view(u)).channels.some((c: any) => c.id === room.id);
  assert.deepEqual([await sees(helper), await sees(kim)], [true, true]);
  await give(lead, kim, []);
  assert.equal(await sees(kim), false);
  assert.equal((await call(`/api/channels/${room.id}/messages`, { token: kim.token })).status, 404);

  // Removing: a helper can remove kim (no roles) but not the lead above them; banning needs its own permission.
  const remove = (who: any, target: any, ban = false) =>
    call(`/api/servers/${sid}/members/${target.user.id}/remove`, { body: { ban }, token: who.token });
  assert.equal((await remove(helper, lead)).status, 403);
  assert.equal((await remove(helper, kim, true)).status, 403);
  assert.equal((await remove(helper, kim)).status, 200);

  // Deleting a role takes it off everyone and out of private rooms.
  assert.equal((await call(`/api/roles/${friends.id}`, { method: 'DELETE', token: lead.token })).status, 200);
  assert.equal(await sees(helper), false);
  assert.deepEqual((await view(host)).members.find((m: any) => m.username === 'helper').roleIds, [helperRole.id]);
});

test('moderators from before custom roles keep their powers', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'burrow-')), 'old.db');
  const old = openDb(file);
  old.exec(`
    INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'a', 'x', 0), (2, 'b', 'x', 0), (3, 'c', 'x', 0);
    INSERT INTO servers (id, name, owner_id, invite_code, created_at) VALUES (1, 'Old', 1, 'abc', 0);
    INSERT INTO members (server_id, user_id, joined_at, role) VALUES (1, 1, 0, 'member'), (1, 2, 0, 'mod'), (1, 3, 0, 'member');
    DROP TABLE channel_role_access; DROP TABLE member_roles; DROP TABLE roles;
  `);
  old.close();
  const db = openDb(file);
  const roles = db.prepare('SELECT id, name, perms FROM roles WHERE server_id = 1').all() as any[];
  assert.deepEqual(roles.map((r) => [r.name, r.perms]), [['Moderator', 'rooms,messages,remove,ban']]);
  assert.deepEqual(db.prepare('SELECT user_id FROM member_roles').all().map((r: any) => r.user_id), [2]);
  db.close();
});
