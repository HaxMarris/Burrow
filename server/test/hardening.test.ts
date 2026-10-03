import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db.ts';
import { createApp } from '../src/app.ts';

const db = openDb(':memory:');
const app = createApp({ db, publicDir: new URL('../../client', import.meta.url).pathname, registrationCode: 'secret-code' });
let base = '';
before(async () => {
  await new Promise<void>((r) => app.listen(0, r));
  base = `http://localhost:${(app.address() as AddressInfo).port}`;
});
after(() => {
  app.closeAllConnections();
  app.close();
});

async function call(path: string, opts: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {}) {
  const res = await fetch(base + path, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...opts.headers },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, headers: res.headers, data: (await res.json().catch(() => null)) as any };
}

test('wrong passwords are limited per person', async () => {
  const reg = await call('/api/register', { body: { username: 'pat', password: 'password1', registrationCode: 'secret-code' } });
  assert.equal(reg.status, 200);
  const login = (password: string, ip = '203.0.113.1') =>
    call('/api/login', { body: { username: 'Pat', password }, headers: { 'x-forwarded-for': ip } });
  for (let i = 0; i < 10; i++) assert.equal((await login('nope')).status, 401);
  // Locked, even with the right password and from somewhere else.
  const locked = await login('password1', '203.0.113.2');
  assert.equal(locked.status, 429);
  assert.match(locked.data.error, /Too many tries/);
});

test('a good login clears earlier mistakes', async () => {
  await call('/api/register', { body: { username: 'sky', password: 'password1', registrationCode: 'secret-code' } });
  const login = (password: string) => call('/api/login', { body: { username: 'sky', password }, headers: { 'x-forwarded-for': '198.51.100.7' } });
  for (let i = 0; i < 9; i++) await login('nope');
  assert.equal((await login('password1')).status, 200);
  for (let i = 0; i < 9; i++) assert.equal((await login('nope')).status, 401);
});

test('guessing the registration code is limited per address', async () => {
  const tryCode = (code: string) =>
    call('/api/register', { body: { username: `x${Math.random().toString(36).slice(2, 8)}`, password: 'password1', registrationCode: code }, headers: { 'x-forwarded-for': '192.0.2.9' } });
  for (let i = 0; i < 10; i++) assert.equal((await tryCode('guess')).status, 403);
  assert.equal((await tryCode('secret-code')).status, 429);
});

test('wrong current passwords are limited too', async () => {
  const me = (await call('/api/register', { body: { username: 'lee', password: 'password1', registrationCode: 'secret-code' } })).data;
  const change = (currentPassword: string) => call('/api/me/password', { body: { currentPassword, newPassword: 'password2' }, token: me.token });
  for (let i = 0; i < 10; i++) assert.equal((await change('nope')).status, 403);
  assert.equal((await change('password1')).status, 429);
});

test('logins expire after 30 days unused', async () => {
  const me = (await call('/api/register', { body: { username: 'old', password: 'password1', registrationCode: 'secret-code' } })).data;
  assert.equal((await call('/api/me', { token: me.token })).status, 200);
  db.prepare('UPDATE sessions SET last_used_at = ? WHERE token = ?').run(Date.now() - 31 * 24 * 60 * 60 * 1000, me.token);
  assert.equal((await call('/api/me', { token: me.token })).status, 401);
  assert.equal(db.prepare('SELECT 1 FROM sessions WHERE token = ?').get(me.token), undefined);
});

test('security headers', async () => {
  const page = await fetch(base + '/', { headers: { 'x-forwarded-proto': 'https' } });
  assert.match(page.headers.get('content-security-policy')!, /script-src 'self'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('strict-transport-security'), 'max-age=31536000');
  assert.doesNotMatch(await page.text(), /<script>/);
  const plain = await fetch(base + '/api/config');
  assert.equal(plain.headers.get('strict-transport-security'), null);
  assert.equal(plain.headers.get('x-content-type-options'), 'nosniff');
});
