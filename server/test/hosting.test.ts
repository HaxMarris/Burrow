import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { openDb } from '../src/db.ts';
import { createApp } from '../src/app.ts';
import { finishRestore, queueRestore } from '../src/backup.ts';

const dir = mkdtempSync(join(tmpdir(), 'burrow-hosting-'));
const uploadDir = join(dir, 'uploads');
const app = createApp({
  db: openDb(':memory:'),
  publicDir: '/nonexistent',
  uploadDir,
  registrationCode: 'a-long-registration-code',
  hosting: { dbFile: join(dir, 'chat.db'), backupDir: join(dir, 'backups'), backupKeep: 3, dataDir: dir, admins: [] },
});
let base = '';
let max: any, sam: any;
before(async () => {
  await new Promise<void>((r) => app.listen(0, r));
  base = `http://localhost:${(app.address() as AddressInfo).port}`;
  max = (await reg('max')).data;
  sam = (await reg('sam')).data;
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
const reg = (username: string, extra: object = {}) =>
  call('/api/register', { body: { username, password: 'password1', registrationCode: 'a-long-registration-code', ...extra } });


test('the first account runs the server; nobody else gets in', async () => {
  assert.equal((await call('/api/me', { token: max.token })).data.admin, true);
  assert.equal((await call('/api/me', { token: sam.token })).data.admin, undefined);
  assert.equal((await call('/api/admin', { token: sam.token })).status, 403);
  const page = await call('/api/admin', { token: max.token });
  assert.equal(page.status, 200);
  assert.deepEqual(page.data.users.map((u: any) => u.username), ['max', 'sam']);
  assert.equal(page.data.signup.mode, 'code');
  const keys = page.data.checks.map((c: any) => c.key);
  assert.ok(keys.includes('https') && keys.includes('backups') && keys.includes('offsite'));
  assert.equal(page.data.checks.find((c: any) => c.key === 'https').ok, false);
  // Behind a proxy that says https.
  const res = await fetch(base + '/api/admin', { headers: { authorization: `Bearer ${max.token}`, 'x-forwarded-proto': 'https' } });
  assert.equal(((await res.json()) as any).checks.find((c: any) => c.key === 'https').ok, true);
});

test('health check', async () => {
  const r = await call('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
});

test('signup links', async () => {
  // A one-use link gets someone in without the code, once.
  const made = await call('/api/admin/signup-links', { body: { note: 'For Ana', uses: 1, days: 7 }, token: max.token });
  assert.equal(made.status, 200);
  const link = made.data.links[0];
  assert.equal(link.note, 'For Ana');
  assert.equal((await call(`/api/signup-links/${link.code}`)).data.ok, true);
  assert.equal((await call('/api/register', { body: { username: 'ana', password: 'password1', signupLink: link.code } })).status, 200);
  assert.equal((await call(`/api/signup-links/${link.code}`)).data.ok, false);
  assert.equal((await call('/api/register', { body: { username: 'bo', password: 'password1', signupLink: link.code } })).status, 403);
  assert.equal((await call('/api/admin/signup-links', { body: { uses: 99 }, token: max.token })).status, 400);
  assert.equal((await call('/api/admin/signup-links', { body: { uses: 1 }, token: sam.token })).status, 403);

  // Links only: the registration code stops working.
  assert.equal((await call('/api/admin/settings', { method: 'PATCH', body: { signupMode: 'links' }, token: max.token })).data.signupMode, 'links');
  assert.equal((await call('/api/config')).data.signupLinksOnly, true);
  assert.equal((await reg('cy')).status, 403);
  const two = (await call('/api/admin/signup-links', { body: { uses: 2 }, token: max.token })).data.links[0];
  assert.equal((await call('/api/register', { body: { username: 'cy', password: 'password1', signupLink: two.code } })).status, 200);
  // Open: no code needed.
  await call('/api/admin/settings', { method: 'PATCH', body: { signupMode: 'open' }, token: max.token });
  assert.equal((await call('/api/register', { body: { username: 'di', password: 'password1' } })).status, 200);
  await call('/api/admin/settings', { method: 'PATCH', body: { signupMode: 'code' }, token: max.token });
  assert.equal((await call('/api/register', { body: { username: 'ed', password: 'password1' } })).status, 403);
  assert.equal((await call(`/api/admin/signup-links/${two.code}`, { method: 'DELETE', token: max.token })).data.links.some((l: any) => l.code === two.code), false);
});

test('reset links and logging someone out', async () => {
  const r = await call(`/api/admin/users/${sam.user?.id ?? sam.id}/reset-link`, { method: 'POST', token: max.token });
  assert.equal(r.status, 200);
  const token = new URL(r.data.url).searchParams.get('reset');
  assert.ok(token);
  const extra = (await call('/api/login', { body: { username: 'sam', password: 'password1' } })).data.token;
  assert.equal((await call(`/api/admin/users/${sam.user?.id ?? sam.id}/sign-out`, { method: 'POST', token: max.token })).status, 200);
  assert.equal((await call('/api/me', { token: extra })).status, 401);
  sam = (await call('/api/login', { body: { username: 'sam', password: 'password1' } })).data;
});

test('deleting someone from the admin page', async () => {
  const gus = (await reg('gus')).data;
  const kim = (await reg('kim')).data;
  // Gus hosts a hearth Kim and Max are in, and one of his own.
  const shared = (await call('/api/servers', { body: { name: 'Shared' }, token: gus.token })).data;
  const solo = (await call('/api/servers', { body: { name: 'Solo' }, token: gus.token })).data;
  for (const who of [kim, max]) assert.equal((await call('/api/join', { body: { inviteCode: shared.inviteCode }, token: who.token })).status, 200);
  const room = shared.channels[0].id;
  await call(`/api/channels/${room}/messages`, { body: { content: 'hello from gus' }, token: gus.token });

  assert.equal((await call(`/api/admin/users/${gus.user.id}/delete`, { method: 'POST', token: sam.token })).status, 403);
  assert.equal((await call(`/api/admin/users/${max.user?.id ?? max.id}/delete`, { method: 'POST', token: max.token })).status, 400);
  assert.equal((await call(`/api/admin/users/${gus.user.id}/delete`, { method: 'POST', body: { deleteMessages: true }, token: max.token })).status, 200);

  // Signed out, can't log in, gone from the list, his messages gone, and Kim (there first) hosts the shared hearth.
  assert.equal((await call('/api/me', { token: gus.token })).status, 401);
  assert.equal((await call('/api/login', { body: { username: 'gus', password: 'password1' } })).status, 401);
  assert.ok(!(await call('/api/admin', { token: max.token })).data.users.some((u: any) => u.username === 'gus'));
  const msgs = (await call(`/api/channels/${room}/messages`, { token: kim.token })).data;
  assert.ok(!JSON.stringify(msgs).includes('hello from gus'));
  const servers = (await call('/api/servers', { token: kim.token })).data;
  assert.equal(servers.find((x: any) => x.id === shared.id).ownerId, kim.user.id);
  assert.ok(!servers.some((x: any) => x.id === solo.id));
  assert.equal((await call('/api/servers', { token: max.token })).data.some((x: any) => x.id === solo.id), false);
  assert.equal((await call(`/api/admin/users/${gus.user.id}/delete`, { method: 'POST', token: max.token })).status, 404);
});

test('crash reports', async () => {
  for (let i = 0; i < 3; i++) await call('/api/errors', { body: { message: 'x is not a function', stack: 'at a.js:1', where: 'chat' } });
  await call('/api/errors', { body: { message: 'other' } });
  const list = (await call('/api/admin/errors', { token: max.token })).data.errors;
  assert.equal(list.length, 2);
  assert.equal(list.find((e: any) => e.message === 'x is not a function').count, 3);
  assert.equal((await call('/api/admin/errors', { token: sam.token })).status, 403);
  assert.deepEqual((await call('/api/admin/errors', { method: 'DELETE', token: max.token })).data.errors, []);
});

test('storage clean-up leaves files in use alone', async () => {
  const s = (await call('/api/servers', { body: { name: 'Pics' }, token: max.token })).data;
  const room = s.channels[0].id;
  const up = await fetch(`${base}/api/channels/${room}/attachments`, { method: 'POST', headers: { authorization: `Bearer ${max.token}`, 'content-type': 'text/plain', 'x-filename': 'a.txt' }, body: 'hello' });
  const file = ((await up.json()) as any);
  await call(`/api/channels/${room}/messages`, { body: { content: 'file', attachmentIds: [file.id] }, token: max.token });
  mkdirSync(join(uploadDir, 'avatars'), { recursive: true });
  const old = new Date(Date.now() - 2 * 3600_000);
  for (const f of ['orphan', 'avatars/gone.png', 'fresh']) writeFileSync(join(uploadDir, f), 'x');
  for (const f of ['orphan', 'avatars/gone.png', file.id]) utimesSync(join(uploadDir, f), old, old);
  const dry = await call('/api/admin/cleanup', { body: { dryRun: true }, token: max.token });
  assert.deepEqual(dry.data, { files: 2, bytes: 2 });
  assert.ok(existsSync(join(uploadDir, 'orphan')));
  await call('/api/admin/cleanup', { body: {}, token: max.token });
  assert.ok(!existsSync(join(uploadDir, 'orphan')) && !existsSync(join(uploadDir, 'avatars/gone.png')));
  assert.ok(existsSync(join(uploadDir, file.id)) && existsSync(join(uploadDir, 'fresh')));
});

test('backups from the admin page, and restoring one on the next start', async () => {
  const r = await call('/api/admin/backups', { body: {}, token: max.token });
  assert.equal(r.status, 200);
  assert.equal(r.data.local.length, 1);
  const db = join(dir, 'restore-test.db');
  writeFileSync(db, 'now');
  writeFileSync(join(dir, 'old.db'), 'then');
  queueRestore(db, join(dir, 'old.db'));
  const kept = finishRestore(db)!;
  assert.equal(readFileSync(db, 'utf8'), 'then');
  assert.equal(readFileSync(kept, 'utf8'), 'now');
  assert.equal(finishRestore(db), null);
});

test('the updater: off until its container reports in', async () => {
  assert.equal((await call('/api/admin/update', { method: 'POST', token: max.token })).status, 503);
  mkdirSync(join(dir, 'updater'), { recursive: true });
  writeFileSync(join(dir, 'updater/status.json'), JSON.stringify({ seenAt: Math.floor(Date.now() / 1000), commit: 'abc', behind: 2, changes: ['one', 'two'] }));
  const r = await call('/api/admin/update', { method: 'POST', token: max.token });
  assert.equal(r.status, 200);
  assert.equal(r.data.updater.requested, true);
  assert.ok(existsSync(join(dir, 'updater/request')));
});

test('webhooks and bots', async () => {
  const s = (await call('/api/servers', { body: { name: 'Hooks' }, token: max.token })).data;
  const room = s.channels[0].id;
  await call('/api/join', { body: { inviteCode: s.inviteCode }, token: sam.token });
  assert.equal((await call(`/api/channels/${room}/webhooks`, { body: { name: 'GitHub' }, token: sam.token })).status, 403);
  const hook = await call(`/api/channels/${room}/webhooks`, { body: { name: 'GitHub' }, token: max.token });
  assert.equal(hook.status, 200);
  const path = new URL(hook.data.url).pathname;
  assert.equal((await call(path, { body: { content: 'Build passed' } })).status, 200);
  assert.equal((await call(path, { body: { text: 'Slack style' } })).status, 200);
  assert.equal((await call(path.replace(/[^/]+$/, 'wrong-token-here'), { body: { content: 'x' } })).status, 404);
  const msgs = (await call(`/api/channels/${room}/messages`, { token: max.token })).data;
  const list = msgs.messages ?? msgs;
  const posted = list.filter((m: any) => m.authorBot);
  assert.deepEqual(posted.map((m: any) => m.content), ['Build passed', 'Slack style']);

  // A bot has its own token and posts through the normal API, but can't make burrows or DMs.
  const bot = await call(`/api/servers/${s.id}/bots`, { body: { name: 'Dice' }, token: max.token });
  assert.equal(bot.status, 200);
  assert.equal(bot.data.bots.length, 1);
  assert.equal(bot.data.webhooks.length, 1);
  assert.equal((await call(`/api/channels/${room}/messages`, { body: { content: 'beep' }, token: bot.data.token })).status, 200);
  assert.equal((await call('/api/servers', { body: { name: 'Mine' }, token: bot.data.token })).status, 403);
  const members = (await call(`/api/servers`, { token: max.token })).data.find((x: any) => x.id === s.id).members;
  assert.equal(members.find((m: any) => m.id === bot.data.botId).bot, true);
  // A new token retires the old one.
  const fresh = (await call(`/api/servers/${s.id}/bots/${bot.data.botId}/token`, { method: 'POST', token: max.token })).data.token;
  assert.equal((await call('/api/me', { token: bot.data.token })).status, 401);
  assert.equal((await call('/api/me', { token: fresh })).status, 200);
  // Bots never count as the server's admin.
  assert.equal((await call('/api/admin', { token: fresh })).status, 403);

  const removed = await call(`/api/servers/${s.id}/bots/${bot.data.botId}`, { method: 'DELETE', token: max.token });
  assert.equal(removed.data.bots.length, 0);
  assert.equal((await call('/api/me', { token: fresh })).status, 401);
  assert.equal((await call(`/api/webhooks/${hook.data.webhooks[0].id}`, { method: 'DELETE', token: max.token })).data.webhooks.length, 0);
  assert.equal((await call(path, { body: { content: 'gone' } })).status, 404);
  const log = (await call(`/api/servers/${s.id}/audit`, { token: max.token })).data;
  const actions = (log.entries ?? log).map((e: any) => e.action);
  for (const a of ['bot_add', 'bot_remove', 'webhook_add', 'webhook_remove']) assert.ok(actions.includes(a), a);
});

test('slash commands', async () => {
  const s = (await call('/api/servers', { body: { name: 'Games' }, token: max.token })).data;
  const room = s.channels[0].id;
  const send = async (content: string) => (await call(`/api/channels/${room}/messages`, { body: { content }, token: max.token })).data;
  const roll = await send('/roll 2d6+1');
  const m = /^🎲 rolled 2d6\+1: (\d) \+ (\d) \+ 1 = \*\*(\d+)\*\*$/.exec(roll.content);
  assert.ok(m, roll.content);
  assert.equal(Number(m[1]) + Number(m[2]) + 1, Number(m[3]));
  assert.match((await send('/roll')).content, /^🎲 rolled 1d6: \*\*[1-6]\*\*$/);
  assert.match((await send('/flip')).content, /heads|tails/);
  assert.equal((await send('/me waves')).content, '*waves*');
  assert.equal((await send('/shrug')).content, '¯\\_(ツ)_/¯');
  assert.equal((await send('/spoiler the end')).content, '||the end||');
  assert.equal((await send('/nope at all')).content, '/nope at all');
  const poll = await send('/poll Pizza or tacos? | Pizza | Tacos');
  assert.equal(poll.poll.question, 'Pizza or tacos?');
  assert.deepEqual(poll.poll.options.map((o: any) => o.text), ['Pizza', 'Tacos']);
});

test('a bot token works on the live connection', async () => {
  const s = (await call('/api/servers', { body: { name: 'Live' }, token: max.token })).data;
  const token = (await call(`/api/servers/${s.id}/bots`, { body: { name: 'Watcher' }, token: max.token })).data.token;
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws?token=' + token);
  const first = await new Promise<any>((r) => ws.once('message', (d) => r(JSON.parse(String(d)))));
  assert.ok(first.type);
  ws.close();
});
