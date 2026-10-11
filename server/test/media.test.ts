import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db.ts';
import { createApp } from '../src/app.ts';

const uploadDir = join(mkdtempSync(join(tmpdir(), 'burrow-media-')), 'uploads');
const app = createApp({ db: openDb(':memory:'), publicDir: '/nonexistent', uploadDir });
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

const raw = (path: string, token: string, data: Uint8Array, type: string, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': type, ...headers }, body: data as BodyInit });

const webp = () => {
  const b = new Uint8Array(40);
  b.set(new TextEncoder().encode('RIFF'), 0);
  b.set(new TextEncoder().encode('WEBPVP8 '), 8);
  return b;
};

test('picture and video sizes, video thumbnails, and fetching part of a file', async () => {
  const max = (await call('/api/register', { body: { username: 'max', password: 'password1' } })).data;
  const sam = (await call('/api/register', { body: { username: 'sam', password: 'password2' } })).data;
  const server = (await call('/api/servers', { body: { name: 'Den' }, token: max.token })).data;
  await call('/api/join', { body: { inviteCode: server.inviteCode }, token: sam.token });
  const room = server.channels[0].id;

  // Sizes are kept for pictures and videos, when believable.
  const pic = (await (await raw(`/api/channels/${room}/attachments`, max.token, new Uint8Array([1, 2, 3]), 'image/png', { 'x-width': '1600', 'x-height': '900' })).json()) as any;
  assert.equal(pic.width, 1600);
  assert.equal(pic.height, 900);
  const odd = (await (await raw(`/api/channels/${room}/attachments`, max.token, new Uint8Array([1]), 'image/png', { 'x-width': '-5', 'x-height': '900' })).json()) as any;
  assert.equal(odd.width, undefined);
  const doc = (await (await raw(`/api/channels/${room}/attachments`, max.token, new Uint8Array([1]), 'text/plain', { 'x-width': '10', 'x-height': '10' })).json()) as any;
  assert.equal(doc.width, undefined);

  const bytes = new Uint8Array(1000).map((_, i) => i % 256);
  const video = (await (await raw(`/api/channels/${room}/attachments`, max.token, bytes, 'video/mp4', { 'x-width': '1280', 'x-height': '720' })).json()) as any;

  // Only the uploader can add a thumbnail, only to a video, and only as a real picture.
  const thumbAt = `/api/attachments/${video.id}/thumb`;
  assert.equal((await raw(thumbAt, sam.token, webp(), 'image/webp')).status, 404);
  assert.equal((await raw(`/api/attachments/${pic.id}/thumb`, max.token, webp(), 'image/webp')).status, 400);
  assert.equal((await raw(thumbAt, max.token, new TextEncoder().encode('<svg/>'), 'image/webp')).status, 400);
  assert.equal((await raw(thumbAt, max.token, new Uint8Array(400 * 1024), 'image/webp')).status, 413);
  const added = await raw(thumbAt, max.token, webp(), 'image/webp');
  assert.equal(added.status, 200);
  assert.equal(((await added.json()) as any).thumb, thumbAt);
  // Not visible until the video is sent.
  assert.equal((await fetch(base + thumbAt)).status, 404);

  const sent = (await call(`/api/channels/${room}/messages`, { body: { content: '', attachmentIds: [video.id, pic.id] }, token: max.token })).data;
  const [v, p] = sent.attachments;
  assert.equal(v.thumb, thumbAt);
  assert.equal(v.width, 1280);
  assert.equal(p.thumb, undefined);
  const t = await fetch(base + thumbAt);
  assert.equal(t.status, 200);
  assert.equal(t.headers.get('content-type'), 'image/webp');
  // Too late to change it once sent.
  assert.equal((await raw(thumbAt, max.token, webp(), 'image/webp')).status, 404);

  // Videos load a piece at a time.
  const whole = await fetch(base + v.url);
  assert.equal(whole.headers.get('accept-ranges'), 'bytes');
  const part = await fetch(base + v.url, { headers: { range: 'bytes=100-199' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 100-199/1000');
  assert.deepEqual([...new Uint8Array(await part.arrayBuffer())], [...bytes.slice(100, 200)]);
  const tail = await fetch(base + v.url, { headers: { range: 'bytes=-10' } });
  assert.deepEqual([...new Uint8Array(await tail.arrayBuffer())], [...bytes.slice(990)]);
  const open = await fetch(base + v.url, { headers: { range: 'bytes=990-' } });
  assert.equal(open.headers.get('content-range'), 'bytes 990-999/1000');
  await open.arrayBuffer();
  assert.equal((await fetch(base + v.url, { headers: { range: 'bytes=5000-' } })).status, 416);

  // Forwarding copies the thumbnail too; deleting removes it.
  const dm = (await call('/api/dms', { body: { userId: sam.user.id }, token: max.token })).data;
  const fwd = await call(`/api/messages/${sent.id}/forward`, { body: { channelId: dm.channels[0].id }, token: max.token });
  assert.equal(fwd.status, 200, JSON.stringify(fwd.data));
  const copy = fwd.data.attachments[0];
  assert.ok(copy.thumb && copy.thumb !== thumbAt);
  assert.equal(copy.width, 1280);
  assert.equal((await fetch(base + copy.thumb)).status, 200);
  assert.equal((await call(`/api/messages/${sent.id}`, { method: 'DELETE', token: max.token })).status, 200);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(existsSync(join(uploadDir, `${video.id}.thumb`)), false);
});
