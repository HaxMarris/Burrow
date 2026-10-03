import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db.ts';
import { createApp } from '../src/app.ts';

const uploadDir = join(mkdtempSync(join(tmpdir(), 'burrow-uploads-')), 'uploads');
const app = createApp({ db: openDb(':memory:'), publicDir: '/nonexistent', uploadDir, maxUploadBytes: 1000 });
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

const upload = (channelId: number, token: string, data: string | Uint8Array, name: string, type: string) =>
  fetch(`${base}/api/channels/${channelId}/attachments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': type, 'x-filename': encodeURIComponent(name) },
    body: data,
  });

test('uploading, sending and downloading files', async () => {
  assert.equal((await call('/api/config')).data.maxUploadBytes, 1000);
  const max = (await call('/api/register', { body: { username: 'max', password: 'password1' } })).data;
  const sam = (await call('/api/register', { body: { username: 'sam', password: 'password2' } })).data;
  const server = (await call('/api/servers', { body: { name: 'Den' }, token: max.token })).data;
  const room = server.channels[0].id;

  // Only members can upload, and size is limited.
  assert.equal((await upload(room, sam.token, 'x', 'a.txt', 'text/plain')).status, 404);
  assert.equal((await upload(room, max.token, 'x'.repeat(1001), 'big.bin', 'application/octet-stream')).status, 413);

  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const pic = await (await upload(room, max.token, png, 'cabin photo.png', 'image/png')).json() as any;
  assert.equal(pic.name, 'cabin photo.png');
  assert.equal(pic.size, png.length);
  const page = await (await upload(room, max.token, '<script>alert(1)</script>', '../evil.html', 'text/html')).json() as any;
  assert.equal(page.name, '.._evil.html');

  // Not downloadable until sent in a message.
  assert.equal((await fetch(base + pic.url)).status, 404);

  // Someone else can't send your upload.
  await call('/api/join', { body: { inviteCode: server.inviteCode }, token: sam.token });
  assert.equal((await call(`/api/channels/${room}/messages`, { body: { attachmentIds: [pic.id] }, token: sam.token })).status, 400);

  // Files keep the order they were attached in, not the order they finished uploading.
  const msg = (await call(`/api/channels/${room}/messages`, { body: { content: '', attachmentIds: [page.id, pic.id] }, token: max.token })).data;
  assert.deepEqual(msg.attachments.map((a: any) => a.name), ['.._evil.html', 'cabin photo.png']);
  // Already used.
  assert.equal((await call(`/api/channels/${room}/messages`, { body: { attachmentIds: [pic.id] }, token: max.token })).status, 400);
  // Plain empty messages are still refused.
  assert.equal((await call(`/api/channels/${room}/messages`, { body: { content: '  ' }, token: max.token })).status, 400);

  const history = (await call(`/api/channels/${room}/messages`, { token: sam.token })).data;
  assert.equal(history[0].attachments.length, 2);

  // Images show inline; anything else is a download that can't run in the page.
  const img = await fetch(base + pic.url);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.match(img.headers.get('content-disposition')!, /^inline/);
  assert.deepEqual(new Uint8Array(await img.arrayBuffer()), png);
  const html = await fetch(base + page.url);
  assert.equal(html.headers.get('content-type'), 'application/octet-stream');
  assert.match(html.headers.get('content-disposition')!, /^attachment/);
  assert.match(html.headers.get('content-security-policy')!, /sandbox/);
  await html.text();

  // Deleting the message deletes its files.
  assert.equal(readdirSync(uploadDir).length, 2);
  await call(`/api/messages/${msg.id}`, { method: 'DELETE', token: max.token });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(readdirSync(uploadDir).length, 0);
  assert.equal((await fetch(base + pic.url)).status, 404);
});
