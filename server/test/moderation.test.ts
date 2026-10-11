import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db.ts';
import { createApp } from '../src/app.ts';

const uploadDir = join(mkdtempSync(join(tmpdir(), 'burrow-mod-')), 'uploads');
// Up to 3 MB per file on this server.
const app = createApp({ db: openDb(':memory:'), publicDir: '/nonexistent', uploadDir, maxUploadBytes: 3 * 1024 * 1024 });
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
let n = 0;
async function people(...names: string[]) {
  const out: any[] = [];
  for (const name of names) out.push((await call('/api/register', { body: { username: `${name}${++n}`, password: 'password1' } })).data);
  return out;
}
async function burrow(host: any, ...others: any[]) {
  const server = (await call('/api/servers', { body: { name: 'Den' }, token: host.token })).data;
  for (const o of others) await call('/api/join', { body: { inviteCode: server.inviteCode }, token: o.token });
  return { sid: server.id as number, room: server.channels[0].id as number };
}
const say = (room: number, who: any, content: string) => call(`/api/channels/${room}/messages`, { body: { content }, token: who.token });
const view = async (who: any, sid: number) => (await call('/api/servers', { token: who.token })).data.find((s: any) => s.id === sid);
const makeMod = async (host: any, sid: number, who: any) => {
  const mod = (await view(host, sid)).roles.find((r: any) => r.name === 'Moderator');
  await call(`/api/servers/${sid}/members/${who.user.id}/roles`, { body: { roleIds: [mod.id] }, token: host.token });
  return mod;
};

test('timeouts stop writing until they run out, and land in the audit log', async () => {
  const [host, mod, kim] = await people('host', 'mod', 'kim');
  const { sid, room } = await burrow(host, mod, kim);
  await makeMod(host, sid, mod);
  // Members can't time people out, and nobody can time out the host.
  assert.equal((await call(`/api/servers/${sid}/members/${mod.user.id}/timeout`, { body: { minutes: 10 }, token: kim.token })).status, 403);
  assert.equal((await call(`/api/servers/${sid}/members/${host.user.id}/timeout`, { body: { minutes: 10 }, token: mod.token })).status, 403);
  assert.equal((await call(`/api/servers/${sid}/members/${kim.user.id}/timeout`, { body: { minutes: 99999 }, token: mod.token })).status, 400);
  const t = await call(`/api/servers/${sid}/members/${kim.user.id}/timeout`, { body: { minutes: 10 }, token: mod.token });
  assert.equal(t.status, 200);
  const sent = await say(room, kim, 'hello?');
  assert.equal(sent.status, 403);
  assert.match(sent.data.error, /timed out for 10 more minutes/);
  const mine = await view(kim, sid);
  assert.ok(mine.timeoutUntil > Date.now());
  assert.equal(mine.channels[0].canPost, false);
  assert.ok((await view(host, sid)).members.find((m: any) => m.id === kim.user.id).timeoutUntil);
  // Ended early.
  await call(`/api/servers/${sid}/members/${kim.user.id}/timeout`, { body: { minutes: 0 }, token: mod.token });
  assert.equal((await say(room, kim, 'back')).status, 200);
  // The audit log: only roles allowed to see it, newest first.
  assert.equal((await call(`/api/servers/${sid}/audit`, { token: kim.token })).status, 403);
  const log = (await call(`/api/servers/${sid}/audit`, { token: mod.token })).data.entries;
  assert.deepEqual(log.slice(0, 3).map((e: any) => e.action), ['timeout_end', 'timeout', 'role_give']);
  assert.equal(log[1].actor, mod.user.username);
  assert.equal(log[1].target, kim.user.username);
  assert.equal(log[1].detail, '10 minutes');
});

test('bulk delete, deleting others, and removals are logged', async () => {
  const [host, kim] = await people('host', 'kim');
  const { sid, room } = await burrow(host, kim);
  const ids: number[] = [];
  for (let i = 0; i < 5; i++) ids.push((await say(room, kim, `spam ${i}`)).data.id);
  assert.equal((await call(`/api/channels/${room}/bulk-delete`, { body: { fromId: ids[2] }, token: kim.token })).status, 403);
  assert.equal((await call(`/api/channels/${room}/bulk-delete`, { body: { fromId: ids[2] }, token: host.token })).data.deleted, 3);
  const left = (await call(`/api/channels/${room}/messages`, { token: host.token })).data.messages ?? (await call(`/api/channels/${room}/messages`, { token: host.token })).data;
  assert.deepEqual(left.map((m: any) => m.content).filter((c: string) => c.startsWith('spam')), ['spam 0', 'spam 1']);
  await call(`/api/messages/${ids[0]}`, { method: 'DELETE', token: host.token });
  await call(`/api/servers/${sid}/members/${kim.user.id}/remove`, { body: { ban: true }, token: host.token });
  const log = (await call(`/api/servers/${sid}/audit`, { token: host.token })).data.entries;
  assert.deepEqual(log.slice(0, 3).map((e: any) => [e.action, e.detail]), [
    ['ban', ''],
    ['message_delete', 'in #general: spam 0'],
    ['bulk_delete', '3 messages in #general'],
  ]);
});

test('the word filter blocks or flags, and reports reach moderators', async () => {
  const [host, mod, kim] = await people('host', 'mod', 'kim');
  const { sid, room } = await burrow(host, mod, kim);
  await makeMod(host, sid, mod);
  assert.equal((await call(`/api/servers/${sid}`, { method: 'PATCH', body: { wordFilter: { words: ['Darn'] } }, token: kim.token })).status, 403);
  await call(`/api/servers/${sid}`, { method: 'PATCH', body: { wordFilter: { words: ['Darn', 'heck'], action: 'block' } }, token: host.token });
  assert.deepEqual((await view(host, sid)).wordFilter, { words: ['darn', 'heck'], action: 'block' });
  assert.equal((await view(kim, sid)).wordFilter, undefined);
  assert.equal((await say(room, kim, 'oh DARN it')).status, 400);
  assert.equal((await say(room, kim, 'darning socks')).status, 200); // whole words only
  assert.equal((await say(room, mod, 'darn, says the moderator')).status, 200); // people who manage messages are exempt
  const ok = (await say(room, kim, 'fine')).data;
  assert.equal((await call(`/api/messages/${ok.id}`, { method: 'PATCH', body: { content: 'heck' }, token: kim.token })).status, 400);

  // Flagging lets it through and files a report.
  await call(`/api/servers/${sid}`, { method: 'PATCH', body: { wordFilter: { words: ['heck'], action: 'flag' } }, token: host.token });
  const flagged = (await say(room, kim, 'what the heck')).data;
  assert.ok(flagged.id);
  // A member reports another message.
  const rude = (await say(room, kim, 'you are all bad at this game')).data;
  assert.equal((await call(`/api/messages/${rude.id}/report`, { body: { reason: 'Mean' }, token: host.token })).status, 200);
  assert.equal((await call(`/api/messages/${rude.id}/report`, { body: {}, token: host.token })).status, 409);
  assert.equal((await call(`/api/servers/${sid}/reports`, { token: kim.token })).status, 403);
  assert.equal((await view(mod, sid)).openReports, 2);
  const reports = (await call(`/api/servers/${sid}/reports`, { token: mod.token })).data;
  assert.deepEqual(reports.map((r: any) => [r.reason, r.reporter, r.content]), [
    ['Mean', host.user.username, 'you are all bad at this game'],
    ['Word filter: heck', null, 'what the heck'],
  ]);
  // Resolving with delete removes the message.
  await call(`/api/reports/${reports[0].id}/resolve`, { body: { deleteMessage: true }, token: mod.token });
  await call(`/api/reports/${reports[1].id}/resolve`, { body: {}, token: mod.token });
  assert.equal((await view(mod, sid)).openReports, 0);
  const msgs = (await call(`/api/channels/${room}/messages`, { token: host.token })).data;
  const contents = (msgs.messages ?? msgs).map((m: any) => m.content);
  assert.ok(!contents.includes('you are all bad at this game'));
  assert.ok(contents.includes('what the heck'));
});

test('read-only roles, pin and invite permissions, and upload limits per role', async () => {
  const [host, kim, lee] = await people('host', 'kim', 'lee');
  const { sid, room } = await burrow(host, kim, lee);
  const guests = (await call(`/api/servers/${sid}/roles`, { body: { name: 'Guests' }, token: host.token })).data.roles.find((r: any) => r.name === 'Guests');
  await call(`/api/servers/${sid}/members/${kim.user.id}/roles`, { body: { roleIds: [guests.id] }, token: host.token });
  await call(`/api/channels/${room}`, { method: 'PATCH', body: { readOnlyRoleIds: [guests.id] }, token: host.token });
  assert.deepEqual((await view(host, sid)).channels[0].readOnlyRoleIds, [guests.id]);
  assert.equal((await say(room, kim, 'can I talk?')).status, 403);
  assert.equal((await view(kim, sid)).channels[0].canPost, false);
  assert.equal((await say(room, lee, 'I can')).status, 200);

  // Pinning and seeing everyone's invites are their own switches.
  const msg = (await say(room, lee, 'pin me')).data;
  assert.equal((await call(`/api/messages/${msg.id}/pin`, { body: { pinned: true }, token: lee.token })).status, 403);
  await call(`/api/roles/${guests.id}`, { method: 'PATCH', body: { perms: ['pin', 'invites'] }, token: host.token });
  assert.equal((await call(`/api/messages/${msg.id}/pin`, { body: { pinned: true }, token: kim.token })).status, 200);
  await call(`/api/servers/${sid}/invites`, { body: {}, token: lee.token });
  assert.equal((await call(`/api/servers/${sid}/invites`, { token: kim.token })).data.length, 1);

  // Uploads: 1 MB for everyone, Guests none, the server's 3 MB for the host.
  const upload = (who: any, bytes: number) =>
    fetch(`${base}/api/channels/${room}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${who.token}`, 'content-type': 'text/plain', 'x-filename': 'a.txt' },
      body: Buffer.alloc(bytes, 97),
    }).then((r) => r.status);
  await call(`/api/servers/${sid}`, { method: 'PATCH', body: { uploadMb: 1 }, token: host.token });
  await call(`/api/roles/${guests.id}`, { method: 'PATCH', body: { uploadMb: 0 }, token: host.token });
  assert.equal((await view(lee, sid)).myUploadLimit, 1024 * 1024);
  assert.equal((await view(kim, sid)).myUploadLimit, 1024 * 1024); // a role can't lower what everyone gets
  assert.equal(await upload(lee, 2 * 1024 * 1024), 413);
  assert.equal(await upload(lee, 1000), 200);
  assert.equal(await upload(host, 2 * 1024 * 1024), 200);
  await call(`/api/servers/${sid}`, { method: 'PATCH', body: { uploadMb: 0 }, token: host.token });
  assert.equal(await upload(kim, 10), 403);
  await call(`/api/roles/${guests.id}`, { method: 'PATCH', body: { uploadMb: 2 }, token: host.token });
  assert.equal((await view(kim, sid)).myUploadLimit, 2 * 1024 * 1024);
  assert.equal(await upload(kim, 1500 * 1024), 200);
  assert.equal((await view(host, sid)).roles.find((r: any) => r.id === guests.id).uploadMb, 2);
});
