import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db.ts';
import { createApp } from '../src/app.ts';

const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(40, 1)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(30, 2)]);
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

// A stand-in for KLIPY: two GIFs and an ad for every search.
const klipyRequests: URL[] = [];
const klipy = createServer((req, res) => {
  const url = new URL(req.url!, 'http://x');
  klipyRequests.push(url);
  if (url.pathname.startsWith('/media/')) {
    if (url.pathname.startsWith('/media/bad')) return res.writeHead(200, { 'content-type': 'image/gif' }).end('<script>alert(1)</script>');
    if (url.pathname.endsWith('.webp')) return res.writeHead(200, { 'content-type': 'image/webp' }).end(WEBP);
    if (url.pathname.endsWith('.gif')) return res.writeHead(200, { 'content-type': 'image/gif' }).end(GIF);
    return res.writeHead(404).end();
  }
  const m = url.pathname.match(/^\/api\/v1\/([^/]+)\/gifs\/(search|trending)$/);
  if (!m || m[1] !== 'test-key') return res.writeHead(401).end('{}');
  const media = (name: string) => `${klipyBase}/media/${name}`;
  const file = (name: string, ext: string) => ({
    hd: { [ext]: { url: media(`${name}-hd.${ext}`), width: 498, height: 280 } },
    md: { [ext]: { url: media(`${name}-md.${ext}`), width: 320, height: 180 } },
    sm: { [ext]: { url: media(`${name}-sm.${ext}`), width: 220, height: 124 } },
  });
  res.writeHead(200, { 'content-type': 'application/json' }).end(
    JSON.stringify({
      result: true,
      data: {
        data: [
          { id: 1, slug: 'cat', type: 'gif', title: m[2] === 'search' ? `Cat ${url.searchParams.get('q')}!` : 'Trending fox', file: file('cat', 'webp') },
          { type: 'ad', content: '<iframe></iframe>' },
          { id: 2, slug: 'dog', type: 'gif', title: 'Dog', file: file('dog', 'gif') },
          { id: 3, slug: 'bad', type: 'gif', title: 'Not a picture', file: file('bad', 'gif') },
        ],
        has_next: true,
      },
    }),
  );
});
let klipyBase = '';

const uploadDir = join(mkdtempSync(join(tmpdir(), 'burrow-gifs-')), 'uploads');
let app: ReturnType<typeof createApp>;
let base = '';
before(async () => {
  await new Promise<void>((r) => klipy.listen(0, r));
  klipyBase = `http://localhost:${(klipy.address() as AddressInfo).port}`;
  app = createApp({ db: openDb(':memory:'), publicDir: '/nonexistent', uploadDir, gifs: { apiKey: 'test-key', baseUrl: klipyBase } });
  await new Promise<void>((r) => app.listen(0, r));
  base = `http://localhost:${(app.address() as AddressInfo).port}`;
});
after(() => {
  for (const s of [app, klipy]) {
    s.closeAllConnections();
    s.close();
  }
});

async function call(path: string, opts: { method?: string; body?: unknown; token?: string } = {}) {
  const res = await fetch(base + path, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, data: (await res.json()) as any };
}
const register = async (username: string) =>
  (await call('/api/register', { body: { username, password: 'password1' } })).data as { token: string; user: { id: number } };

test('searching, previewing and sending GIFs', async () => {
  assert.equal((await call('/api/config')).data.gifs, true);
  const max = await register('max');
  const sam = await register('sam');
  const burrow = (await call('/api/servers', { body: { name: 'Den' }, token: max.token })).data;
  const room = burrow.channels[0].id;

  assert.equal((await call('/api/gifs')).status, 401);
  const trending = (await call('/api/gifs', { token: max.token })).data;
  assert.equal(trending.items[0].title, 'Trending fox');
  assert.ok(klipyRequests.some((u) => u.pathname.endsWith('/gifs/trending')));

  const found = (await call('/api/gifs?q=' + encodeURIComponent('so happy') + '&page=2', { token: max.token })).data;
  const sent = klipyRequests.findLast((u) => u.pathname.endsWith('/gifs/search'))!;
  assert.equal(sent.searchParams.get('q'), 'so happy');
  assert.equal(sent.searchParams.get('page'), '2');
  assert.equal(sent.searchParams.get('rating'), 'pg-13');
  // KLIPY gets an anonymous id, not who you are.
  assert.match(sent.searchParams.get('customer_id')!, /^[0-9a-f]{32}$/);
  assert.equal(found.hasMore, true);
  // The ad is left out. Links all point at Burrow, and nothing gives away the key or KLIPY's addresses.
  assert.deepEqual(found.items.map((g: any) => g.title), ['Cat so happy!', 'Dog', 'Not a picture']);
  assert.ok(!JSON.stringify(found).includes('test-key') && !JSON.stringify(found).includes(klipyBase));
  const [cat, dog, bad] = found.items;
  assert.deepEqual([cat.width, cat.height], [220, 124]);

  // Previews come through Burrow, and only real pictures do.
  const preview = await fetch(base + cat.preview);
  assert.equal(preview.headers.get('content-type'), 'image/webp');
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), WEBP);
  assert.ok(klipyRequests.some((u) => u.pathname === '/media/cat-sm.webp'));
  assert.equal((await fetch(base + bad.preview)).status, 502);
  assert.equal((await fetch(base + '/api/gifs/preview/nope')).status, 404);

  // Sending one saves the medium-size file into the room, like an upload.
  assert.equal((await call(`/api/channels/${room}/gifs`, { body: { id: cat.id }, token: sam.token })).status, 404);
  assert.equal((await call(`/api/channels/${room}/gifs`, { body: { id: 'made-up' }, token: max.token })).status, 404);
  assert.equal((await call(`/api/channels/${room}/gifs`, { body: { id: bad.id }, token: max.token })).status, 502);
  const att = (await call(`/api/channels/${room}/gifs`, { body: { id: cat.id }, token: max.token })).data;
  assert.equal(att.name, 'Cat so happy.webp');
  assert.equal(att.type, 'image/webp');
  const att2 = (await call(`/api/channels/${room}/gifs`, { body: { id: dog.id }, token: max.token })).data;
  assert.equal(att2.type, 'image/gif');
  const msg = (await call(`/api/channels/${room}/messages`, { body: { content: '', attachmentIds: [att.id] }, token: max.token })).data;
  assert.equal(msg.attachments[0].id, att.id);
  const img = await fetch(base + msg.attachments[0].url);
  assert.equal(img.headers.get('content-type'), 'image/webp');
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), WEBP);
});

test('the GIF picker is off without a key', async () => {
  const off = createApp({ db: openDb(':memory:'), publicDir: '/nonexistent', uploadDir });
  await new Promise<void>((r) => off.listen(0, r));
  const url = `http://localhost:${(off.address() as AddressInfo).port}`;
  try {
    assert.equal(((await (await fetch(url + '/api/config')).json()) as any).gifs, false);
    const { token } = (await (await fetch(url + '/api/register', { method: 'POST', body: JSON.stringify({ username: 'kit', password: 'password1' }) })).json()) as any;
    assert.equal((await fetch(url + '/api/gifs', { headers: { authorization: `Bearer ${token}` } })).status, 503);
  } finally {
    off.closeAllConnections();
    off.close();
  }
});

const uploadPicture = (serverId: number, token: string, data: Buffer, type = 'image/png') =>
  fetch(`${base}/api/servers/${serverId}/picture`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': type }, body: new Uint8Array(data) });

test('burrow pictures', async () => {
  const host = await register('host');
  const helper = await register('helper');
  const guest = await register('guest');
  const burrow = (await call('/api/servers', { body: { name: 'Pines' }, token: host.token })).data;
  assert.equal(burrow.icon, null);
  for (const p of [helper, guest]) await call('/api/join', { body: { inviteCode: burrow.inviteCode }, token: p.token });

  // Only the host and roles allowed to edit the burrow can change it.
  assert.equal((await uploadPicture(burrow.id, guest.token, PNG)).status, 403);
  assert.equal((await uploadPicture(burrow.id, host.token, Buffer.from('<svg/>'), 'image/svg+xml')).status, 400);
  const first = (await (await uploadPicture(burrow.id, host.token, PNG)).json()) as any;
  assert.match(first.icon, /^\/api\/burrow-pictures\/[\w-]+\.png$/);
  const img = await fetch(base + first.icon);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);
  // Everyone in the burrow sees it.
  const seen = (await call('/api/servers', { token: guest.token })).data.find((s: any) => s.id === burrow.id);
  assert.equal(seen.icon, first.icon);

  const role = (await call(`/api/servers/${burrow.id}/roles`, { body: { name: 'Decorator', color: '#336699', perms: ['burrow'] }, token: host.token })).data;
  const roleId = role.roles.find((r: any) => r.name === 'Decorator').id;
  await call(`/api/servers/${burrow.id}/members/${helper.user.id}/roles`, { body: { roleIds: [roleId] }, token: host.token });
  const second = (await (await uploadPicture(burrow.id, helper.token, GIF, 'image/gif')).json()) as any;
  assert.match(second.icon, /\.gif$/);
  // The old picture is gone.
  assert.equal((await fetch(base + first.icon)).status, 404);
  assert.deepEqual(readdirSync(join(uploadDir, 'burrow-pictures')), [second.icon.split('/').pop()]);

  assert.equal((await call(`/api/servers/${burrow.id}/picture`, { method: 'DELETE', token: guest.token })).status, 403);
  assert.equal((await call(`/api/servers/${burrow.id}/picture`, { method: 'DELETE', token: helper.token })).data.icon, null);
  assert.deepEqual(readdirSync(join(uploadDir, 'burrow-pictures')), []);

  // Deleting the burrow deletes its picture.
  await uploadPicture(burrow.id, host.token, PNG);
  assert.equal(readdirSync(join(uploadDir, 'burrow-pictures')).length, 1);
  await call(`/api/servers/${burrow.id}/leave`, { method: 'POST', token: host.token });
  assert.deepEqual(readdirSync(join(uploadDir, 'burrow-pictures')), []);
});
