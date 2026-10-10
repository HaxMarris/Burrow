import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { openDb } from '../src/db.ts';
import { createApp } from '../src/app.ts';
import { fetchEmbed, isPrivateAddress, linksIn, parsePage } from '../src/embeds.ts';

const uploadDir = mkdtempSync(join(tmpdir(), 'burrow-extras-'));
const db = openDb(':memory:');
const app = createApp({ db, publicDir: '/nonexistent', uploadDir, linkPreviews: { allowPrivate: true } });
let base = '';
const checkClock = () => (app as unknown as { checkClock: () => void }).checkClock();

// A stand-in website for link previews.
let site: Server;
let siteBase = '';
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

before(async () => {
  await new Promise<void>((r) => app.listen(0, r));
  base = `http://localhost:${(app.address() as AddressInfo).port}`;
  site = createServer((req, res) => {
    if (req.url === '/article') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<html><head><title>Fallback</title>
        <meta property="og:title" content="Moose spotted &amp; photographed" />
        <meta content="A big one, near the lake." property="og:description">
        <meta property="og:site_name" content="Forest News" />
        <meta property="og:image" content="/moose.png" /></head><body>hi</body></html>`);
    } else if (req.url === '/moose.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG);
    } else if (req.url === '/moved') {
      res.writeHead(302, { location: '/article' });
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => site.listen(0, r));
  siteBase = `http://localhost:${(site.address() as AddressInfo).port}`;
});
after(() => {
  app.closeAllConnections();
  app.close();
  site.close();
  rmSync(uploadDir, { recursive: true, force: true });
});

async function call(path: string, opts: { method?: string; body?: unknown; token?: string } = {}) {
  const res = await fetch(base + path, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, data: (await res.json()) as any };
}

function openSocket(token: string) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${token}`);
  const events: any[] = [];
  ws.on('message', (raw) => events.push(JSON.parse(String(raw))));
  const next = (pred: (e: any) => boolean, ms = 3000) =>
    new Promise<any>((resolve, reject) => {
      const started = Date.now();
      const look = () => {
        const found = events.find(pred);
        if (found) return resolve(found);
        if (Date.now() - started > ms) return reject(new Error('timed out waiting for event'));
        setTimeout(look, 10);
      };
      look();
    });
  return { ws, events, next, opened: new Promise((r) => ws.on('open', r)) };
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
  return { server, room: server.channels[0].id as number };
}
const say = (room: number, who: { token: string }, content: string, extra = {}) =>
  call(`/api/channels/${room}/messages`, { body: { content, ...extra }, token: who.token }).then((r) => r.data);

test('pins and edit history', async () => {
  const [max, sam, eve] = await people('max', 'sam', 'eve');
  const { room } = await burrow(max, sam);
  const m = await say(room, max, 'first draft');
  assert.equal(m.pinnedAt, null);
  const pinned = (await call(`/api/messages/${m.id}/pin`, { body: { pinned: true }, token: sam.token })).data;
  assert.ok(pinned.pinnedAt);
  assert.equal((await call(`/api/messages/${m.id}/pin`, { body: { pinned: true }, token: eve.token })).status, 404);
  assert.deepEqual((await call(`/api/channels/${room}/pins`, { token: sam.token })).data.map((x: any) => x.id), [m.id]);
  await call(`/api/messages/${m.id}/pin`, { body: { pinned: false }, token: max.token });
  assert.deepEqual((await call(`/api/channels/${room}/pins`, { token: sam.token })).data, []);

  await call(`/api/messages/${m.id}`, { method: 'PATCH', body: { content: 'second draft' }, token: max.token });
  await call(`/api/messages/${m.id}`, { method: 'PATCH', body: { content: 'second draft' }, token: max.token }); // no change, no history
  await call(`/api/messages/${m.id}`, { method: 'PATCH', body: { content: 'final' }, token: max.token });
  const edits = (await call(`/api/messages/${m.id}/edits`, { token: sam.token })).data;
  assert.deepEqual(edits.map((e: any) => e.content), ['first draft', 'second draft']);
  assert.equal(edits[0].writtenAt, m.createdAt);
  assert.equal((await call(`/api/messages/${m.id}/edits`, { token: eve.token })).status, 404);
});

test('saved messages and reminders', async () => {
  const [max, sam] = await people('max', 'sam');
  const { room } = await burrow(max, sam);
  const m = await say(room, sam, 'remember the milk');
  const sock = openSocket(max.token);
  await sock.opened;
  const saved = (await call(`/api/messages/${m.id}/save`, { body: { saved: true }, token: max.token })).data.saved;
  assert.equal(saved.messageId, m.id);
  const list = (await call('/api/me/saved', { token: max.token })).data;
  assert.equal(list.length, 1);
  assert.equal(list[0].message.content, 'remember the milk');
  assert.equal(list[0].place.channelName, 'general');
  assert.deepEqual((await call('/api/me/saved', { token: sam.token })).data, []);
  assert.equal((await call(`/api/messages/${m.id}/save`, { body: { remindAt: Date.now() - 5 }, token: max.token })).status, 400);

  // A reminder comes over the socket once it's due.
  await call(`/api/messages/${m.id}/save`, { body: { remindAt: Date.now() + 150 }, token: max.token });
  const reminder = await sock.next((e) => e.type === 'reminder');
  assert.equal(reminder.message.id, m.id);
  assert.equal((await call('/api/me/saved', { token: max.token })).data[0].reminded, true);

  // One that came due while you were away arrives when you connect.
  await call(`/api/messages/${m.id}/save`, { body: { remindAt: Date.now() + 100 }, token: sam.token });
  await new Promise((r) => setTimeout(r, 250));
  const late = openSocket(sam.token);
  assert.equal((await late.next((e) => e.type === 'reminder')).message.id, m.id);

  await call(`/api/messages/${m.id}/save`, { body: { saved: false }, token: max.token });
  assert.deepEqual((await call('/api/me/saved', { token: max.token })).data, []);
  sock.ws.close();
  late.ws.close();
});

test('scheduled messages send themselves', async () => {
  const [max, sam] = await people('max', 'sam');
  const { room } = await burrow(max, sam);
  assert.equal((await call(`/api/channels/${room}/scheduled`, { body: { content: 'hi', sendAt: Date.now() + 1000 }, token: max.token })).status, 400);
  const list = (await call(`/api/channels/${room}/scheduled`, { body: { content: 'good morning', sendAt: Date.now() + 60_000 }, token: max.token })).data;
  assert.equal(list.length, 1);
  assert.equal(list[0].place.channelName, 'general');
  await call(`/api/channels/${room}/scheduled`, { body: { content: 'later', sendAt: Date.now() + 120_000 }, token: max.token });
  const sock = openSocket(sam.token);
  await sock.opened;
  // As if the time had come.
  db.prepare('UPDATE scheduled_messages SET send_at = ? WHERE id = ?').run(Date.now() - 1, list[0].id);
  checkClock();
  const ev = await sock.next((e) => e.type === 'message' && e.message.content === 'good morning');
  assert.equal(ev.message.authorId, max.user.id);
  const left = (await call('/api/me/scheduled', { token: max.token })).data;
  assert.deepEqual(left.map((s: any) => s.content), ['later']);
  await call(`/api/scheduled/${left[0].id}`, { method: 'DELETE', token: max.token });
  assert.deepEqual((await call('/api/me/scheduled', { token: max.token })).data, []);
  sock.ws.close();
});

test('forwarding copies the message and its files', async () => {
  const [max, sam] = await people('max', 'sam');
  const { room } = await burrow(max, sam);
  const other = (await call(`/api/servers/${(await call('/api/servers', { token: max.token })).data.at(-1).id}/channels`, { body: { name: 'other' }, token: max.token })).data.channels[1].id;
  const up = await fetch(`${base}/api/channels/${room}/attachments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${sam.token}`, 'content-type': 'image/png', 'x-filename': 'moose.png' },
    body: PNG,
  }).then((r) => r.json() as any);
  const original = await say(room, sam, 'look', { attachmentIds: [up.id], spoilerIds: [up.id] });
  assert.equal(original.attachments[0].spoiler, true);
  const fwd = (await call(`/api/messages/${original.id}/forward`, { body: { channelId: other }, token: max.token })).data;
  assert.equal(fwd.content, 'look');
  assert.equal(fwd.authorId, max.user.id);
  assert.equal(fwd.forwarded.author, sam.user.username);
  assert.match(fwd.forwarded.from, /general/);
  assert.notEqual(fwd.attachments[0].id, up.id);
  assert.equal(fwd.attachments[0].spoiler, true);
  // The copy keeps working after the original goes.
  await call(`/api/messages/${original.id}`, { method: 'DELETE', token: sam.token });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await fetch(base + fwd.attachments[0].url)).status, 200);
});

test('polls', async () => {
  const [max, sam, eve] = await people('max', 'sam', 'eve');
  const { room } = await burrow(max, sam, eve);
  assert.equal((await call(`/api/channels/${room}/polls`, { body: { question: 'Pizza?', options: ['Yes'] }, token: max.token })).status, 400);
  const poll = (await call(`/api/channels/${room}/polls`, { body: { question: 'Pizza or tacos?', options: ['Pizza', 'Tacos'] }, token: max.token })).data;
  assert.equal(poll.poll.question, 'Pizza or tacos?');
  assert.equal(poll.poll.closed, false);
  const vote = (token: string, options: number[]) => call(`/api/messages/${poll.id}/vote`, { body: { options }, token });
  await vote(sam.token, [0]);
  await vote(eve.token, [1]);
  assert.equal((await vote(eve.token, [0, 1])).status, 400); // one answer only
  const now = (await vote(eve.token, [0])).data.poll;
  assert.deepEqual(now.options.map((o: any) => o.userIds.length), [2, 0]);
  assert.equal((await call(`/api/messages/${poll.id}/poll/end`, { body: {}, token: sam.token })).status, 403);
  const ended = (await call(`/api/messages/${poll.id}/poll/end`, { body: {}, token: max.token })).data.poll;
  assert.equal(ended.closed, true);
  assert.equal((await vote(sam.token, [1])).status, 400);

  // Timed polls close on their own and everyone hears.
  const sock = openSocket(sam.token);
  await sock.opened;
  const timed = (await call(`/api/channels/${room}/polls`, { body: { question: 'Quick?', options: ['a', 'b'], multi: true }, token: max.token })).data;
  db.prepare('UPDATE polls SET closes_at = ? WHERE message_id = ?').run(Date.now() - 1, timed.id);
  checkClock();
  const closed = await sock.next((e) => e.type === 'message_updated' && e.message.id === timed.id && e.message.poll.closed);
  assert.equal(closed.message.poll.multi, true);
  sock.ws.close();
});

test('search finds words, people and files in rooms you can see', async () => {
  const [max, sam, eve] = await people('max', 'sam', 'eve');
  const { server, room } = await burrow(max, sam, eve);
  const secret = (await call(`/api/servers/${server.id}/channels`, { body: { name: 'secret', private: true, memberIds: [sam.user.id] }, token: max.token })).data.channels[1].id;
  await say(room, sam, 'Anyone up for pizza tonight?');
  await say(room, max, 'Pizzeria by the lake is great https://example.com');
  await say(secret, sam, 'pizza in secret');
  await say(room, eve, 'tacos');
  const search = (token: string, q: string) => call(`/api/search?in=${server.id}&${q}`, { token }).then((r) => r.data.results);
  assert.equal((await search(sam.token, 'q=pizz')).length, 3);
  assert.equal((await search(eve.token, 'q=pizz')).length, 2); // not the private room
  assert.equal((await search(eve.token, `q=pizza&from=${sam.user.id}`)).length, 1);
  assert.equal((await search(eve.token, 'has=link')).length, 1);
  const hit = (await search(eve.token, 'q=lake'))[0];
  assert.equal(hit.place.channelName, 'general');
  assert.equal((await call(`/api/search?in=${server.id}`, { token: eve.token })).status, 400);
  // Someone outside the burrow finds nothing.
  const [out] = await people('out');
  assert.deepEqual(await search(out.token, 'q=pizza'), []);
});

test('unread counts, mark unread, and seen in DMs', async () => {
  const [max, sam] = await people('max', 'sam');
  const { server, room } = await burrow(max, sam);
  await say(room, max, 'hello');
  await say(room, max, `hey @${sam.user.username}`);
  const third = await say(room, max, 'anyone?');
  const general = (token: string) => call('/api/servers', { token }).then((r) => r.data.find((s: any) => s.id === server.id).channels[0]);
  let g = await general(sam.token);
  assert.equal(g.unread, 3);
  assert.equal(g.mentions, 1);
  assert.equal((await general(max.token)).unread, 0); // your own messages are read

  const sock = openSocket(sam.token);
  await sock.opened;
  const info = (await call(`/api/channels/${room}/read`, { body: { lastReadId: third.id }, token: sam.token })).data;
  assert.deepEqual(info, { lastReadId: third.id, unread: 0, mentions: 0 });
  assert.equal((await sock.next((e) => e.type === 'read')).unread, 0);
  // Reading only moves forward, unless it's marked unread.
  await call(`/api/channels/${room}/read`, { body: { lastReadId: 0 }, token: sam.token });
  assert.equal((await general(sam.token)).unread, 0);
  await call(`/api/channels/${room}/read`, { body: { lastReadId: third.id - 1, unread: true }, token: sam.token });
  g = await general(sam.token);
  assert.equal(g.unread, 1);
  assert.equal(g.lastReadId, third.id - 1);

  // DMs: both see how far the other has read, unless either turns it off.
  const dm = (await call('/api/dms', { body: { userId: sam.user.id }, token: max.token })).data;
  const dmRoom = dm.channels[0].id;
  const hi = await say(dmRoom, max, 'psst');
  assert.equal((await call('/api/dms', { token: sam.token })).data[0].channels[0].mentions, 1);
  const maxSock = openSocket(max.token);
  await maxSock.opened;
  await call(`/api/channels/${dmRoom}/read`, { body: { lastReadId: hi.id }, token: sam.token });
  const seen = await maxSock.next((e) => e.type === 'dm_seen');
  assert.equal(seen.lastReadId, hi.id);
  assert.deepEqual((await call('/api/dms', { token: max.token })).data[0].seen, { userId: sam.user.id, lastReadId: hi.id });
  assert.equal((await call('/api/me', { method: 'PATCH', body: { readReceipts: false }, token: sam.token })).data.readReceipts, false);
  assert.equal((await call('/api/dms', { token: max.token })).data[0].seen, null);
  sock.ws.close();
  maxSock.ws.close();
});

test('threads hang off a message and follow its room', async () => {
  const [max, sam, eve] = await people('max', 'sam', 'eve');
  const { server, room } = await burrow(max, sam, eve);
  const m = await say(room, sam, 'Movie night: what should we watch?\nIdeas below');
  const { threadId, server: after } = (await call(`/api/messages/${m.id}/thread`, { body: {}, token: eve.token })).data;
  assert.equal(after.threads[0].name, 'Movie night: what should we watch?');
  assert.ok(!after.channels.some((c: any) => c.id === threadId)); // not listed as a room
  // Asking again opens the same thread.
  assert.equal((await call(`/api/messages/${m.id}/thread`, { body: {}, token: max.token })).data.threadId, threadId);
  await say(threadId, max, 'Paddington 2');
  const reply = await say(threadId, sam, 'yes!');
  const history = (await call(`/api/channels/${room}/messages`, { token: sam.token })).data;
  assert.equal(history[0].thread.count, 2);
  assert.equal(history[0].thread.lastAt, reply.createdAt);
  const evesView = (await call('/api/servers', { token: eve.token })).data.find((s: any) => s.id === server.id);
  assert.equal(evesView.threads[0].unread, 2);
  assert.equal((await call(`/api/messages/${reply.id}/thread`, { body: {}, token: max.token })).status, 400); // no threads in threads

  // Only the starter (or room managers) can rename it.
  assert.equal((await call(`/api/channels/${threadId}`, { method: 'PATCH', body: { name: 'x' }, token: sam.token })).status, 403);
  assert.equal((await call(`/api/channels/${threadId}`, { method: 'PATCH', body: { name: 'Movies' }, token: eve.token })).data.threads[0].name, 'Movies');

  // Threads in a private room are private too.
  const secret = (await call(`/api/servers/${server.id}/channels`, { body: { name: 'secret', private: true, memberIds: [sam.user.id] }, token: max.token })).data.channels[1].id;
  const hush = await say(secret, sam, 'hush');
  const t2 = (await call(`/api/messages/${hush.id}/thread`, { body: { name: 'Plans' }, token: sam.token })).data.threadId;
  assert.equal((await call(`/api/channels/${t2}/messages`, { token: eve.token })).status, 404);
  assert.equal((await call('/api/servers', { token: eve.token })).data.find((s: any) => s.id === server.id).threads.length, 1);

  // Deleting the thread clears the message's thread line.
  assert.equal((await call(`/api/channels/${threadId}`, { method: 'DELETE', token: eve.token })).status, 200);
  assert.equal((await call(`/api/channels/${room}/messages`, { token: sam.token })).data[0].thread, null);
  // Deleting a room takes its threads with it.
  await call(`/api/channels/${secret}`, { method: 'DELETE', token: max.token });
  assert.equal((await call(`/api/channels/${t2}/messages`, { token: sam.token })).status, 404);
});

test('history around a message, and after one', async () => {
  const [max] = await people('max');
  const { room } = await burrow(max);
  const ids: number[] = [];
  for (let i = 0; i < 30; i++) ids.push((await say(room, max, `m${i}`)).id);
  const around = (await call(`/api/channels/${room}/messages?around=${ids[10]}&limit=10`, { token: max.token })).data;
  assert.deepEqual(around.map((m: any) => m.content), ['m6', 'm7', 'm8', 'm9', 'm10', 'm11', 'm12', 'm13', 'm14', 'm15']);
  const after = (await call(`/api/channels/${room}/messages?after=${ids[27]}`, { token: max.token })).data;
  assert.deepEqual(after.map((m: any) => m.content), ['m28', 'm29']);
});

test('custom emoji, stickers and voice messages', async () => {
  const [max, sam, eve] = await people('max', 'sam', 'eve');
  const { server, room } = await burrow(max, sam);
  const upload = (token: string, query: string) =>
    fetch(`${base}/api/servers/${server.id}/emoji?${query}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'image/png' }, body: PNG });
  assert.equal((await upload(sam.token, 'name=moose')).status, 403); // needs the emoji permission
  assert.equal((await upload(max.token, 'name=a')).status, 400);
  const added = (await (await upload(max.token, 'name=moose')).json()) as any;
  assert.equal(added.emoji[0].name, 'moose');
  assert.equal((await upload(max.token, 'name=moose')).status, 409);
  const emoji = added.emoji[0];
  assert.equal((await fetch(base + emoji.url)).status, 200);

  const m = await say(room, sam, `nice <:moose:${emoji.id}>`);
  const react = (token: string, e: string) => call(`/api/messages/${m.id}/reactions`, { body: { emoji: e }, token });
  assert.equal((await react(sam.token, `<:moose:${emoji.id}>`)).data.reactions[0].userIds.length, 1);
  assert.equal((await react(sam.token, `<:elk:${emoji.id}>`)).status, 400);

  const sticker = ((await (await upload(max.token, 'name=wave&kind=sticker')).json()) as any).emoji.find((e: any) => e.kind === 'sticker');
  const sent = await say(room, sam, '', { stickerId: sticker.id });
  assert.equal(sent.sticker.name, 'wave');
  // Someone from another burrow can't send it.
  const other = await burrow(eve);
  assert.equal((await call(`/api/channels/${other.room}/messages`, { body: { stickerId: sticker.id }, token: eve.token })).status, 400);

  assert.equal((await call(`/api/emoji/${sticker.id}`, { method: 'DELETE', token: max.token })).status, 200);
  assert.deepEqual((await call(`/api/channels/${room}/messages`, { token: sam.token })).data.at(-1).sticker, { id: sticker.id, deleted: true });

  const voice = await fetch(`${base}/api/channels/${room}/attachments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${sam.token}`, 'content-type': 'audio/webm', 'x-filename': 'voice-message.webm', 'x-voice-seconds': '4.26' },
    body: Buffer.from('fake audio'),
  }).then((r) => r.json() as any);
  assert.equal(voice.voiceSeconds, 4.3);
});

test('link previews', async () => {
  const [max, sam] = await people('max', 'sam');
  const { room } = await burrow(max, sam);
  const sock = openSocket(sam.token);
  await sock.opened;
  const m = await say(room, max, `read this ${siteBase}/moved and not this <${siteBase}/article>`);
  const ev = await sock.next((e) => e.type === 'message_updated' && e.message.id === m.id);
  const embed = ev.message.embeds[0];
  assert.equal(ev.message.embeds.length, 1);
  assert.equal(embed.title, 'Moose spotted & photographed');
  assert.equal(embed.description, 'A big one, near the lake.');
  assert.equal(embed.siteName, 'Forest News');
  const img = await fetch(base + embed.image);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(base + embed.image.replace(/\/[\w-]+$/, '/forged'))).status, 404);

  // The author can hide them.
  assert.equal((await call(`/api/messages/${m.id}/embeds`, { body: {}, token: sam.token })).status, 403);
  assert.deepEqual((await call(`/api/messages/${m.id}/embeds`, { body: {}, token: max.token })).data.embeds, []);
  sock.ws.close();
});

test('link previews never reach private addresses', async () => {
  assert.equal(isPrivateAddress('127.0.0.1'), true);
  assert.equal(isPrivateAddress('169.254.169.254'), true);
  assert.equal(isPrivateAddress('10.1.2.3'), true);
  assert.equal(isPrivateAddress('::1'), true);
  assert.equal(isPrivateAddress('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateAddress('fd00::1'), true);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  assert.equal(isPrivateAddress('2606:4700::1111'), false);
  await assert.rejects(fetchEmbed(`${siteBase}/article`), /private/);
  await assert.rejects(fetchEmbed('http://127.0.0.1:1/'), /private/);
  assert.deepEqual(linksIn('see https://a.com/x, `https://code.com` and <https://quiet.com> https://a.com/x'), ['https://a.com/x']);
  assert.equal(parsePage('<title>Just a title</title>', 'https://x.com').title, 'Just a title');
});
