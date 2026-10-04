import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db.ts';
import { createApp } from '../src/app.ts';

const dir = mkdtempSync(join(tmpdir(), 'burrow-static-'));
const script = 'console.log("hello burrow");\n'.repeat(200);
writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Burrow</title>');
writeFileSync(join(dir, 'app.js'), script);
const app = createApp({ db: openDb(':memory:'), publicDir: dir });
let port = 0;

before(async () => {
  await new Promise<void>((r) => app.listen(0, r));
  port = (app.address() as AddressInfo).port;
});
after(() => {
  app.closeAllConnections();
  app.close();
});

// fetch() always asks for compression and unpacks it, so this asks with raw headers instead.
function get(path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, any>; body: Buffer }>((resolve, reject) => {
    request({ port, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject).end();
  });
}

test('app files are compressed for browsers that accept it', async () => {
  const br = await get('/app.js', { 'accept-encoding': 'gzip, deflate, br' });
  assert.equal(br.headers['content-encoding'], 'br');
  assert.ok(br.body.length < script.length / 10);
  assert.equal(brotliDecompressSync(br.body).toString(), script);

  const gz = await get('/app.js', { 'accept-encoding': 'gzip' });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.equal(gunzipSync(gz.body).toString(), script);

  const plain = await get('/app.js', { 'accept-encoding': 'br;q=0' });
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(plain.body.toString(), script);
  assert.equal(plain.headers['content-type'], 'text/javascript; charset=utf-8');
});

test('a browser that has the file already gets a 304, until the file changes', async () => {
  const first = await get('/app.js');
  assert.equal(first.headers['cache-control'], 'no-cache');
  const again = await get('/app.js', { 'if-none-match': first.headers.etag });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);

  writeFileSync(join(dir, 'app.js'), script + '// new version\n');
  const changed = await get('/app.js', { 'if-none-match': first.headers.etag });
  assert.equal(changed.status, 200);
  assert.match(changed.body.toString(), /new version/);
});

test('unknown paths get the app shell, and a missing shell is a 404', async () => {
  const page = await get('/some/room');
  assert.equal(page.status, 200);
  assert.match(page.body.toString(), /<title>Burrow/);

  const bare = createApp({ db: openDb(':memory:'), publicDir: join(dir, 'missing') });
  await new Promise<void>((r) => bare.listen(0, r));
  const res = await fetch(`http://localhost:${(bare.address() as AddressInfo).port}/`);
  assert.equal(res.status, 404);
  bare.close();
});
