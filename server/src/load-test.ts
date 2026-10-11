// How many people can chat on this server at once? Starts a throwaway Burrow server next to
// the real one (its own empty database, removed afterwards), then adds people in steps. Everyone
// sits in one busy room, sending a message every few seconds, and the test measures how long
// messages take to reach everyone and how long loading a room takes, until it gets slow.
//
//   docker compose exec burrow node --no-warnings server/src/load-test.ts
//   node --no-warnings src/load-test.ts --steps 10,50,100,200 --seconds 20 --every 5
//
// Options:
//   --steps 10,25,50,100,200,300   how many people at each step
//   --seconds 20                   how long each step lasts
//   --every 5                      seconds between one person's messages
//   --url http://localhost:3000    test a server that's already running instead (it adds
//                                  accounts named lt-…; needs --code if signups need one)
//
// Voice seats are tested with LiveKit's own tool; see "Load test" in the README.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { cpus, tmpdir, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1] ?? '');
const steps = (args.get('steps') ?? '10,25,50,100,200,300').split(',').map(Number).filter((n) => n > 0);
const seconds = Number(args.get('seconds') ?? 20);
const every = Number(args.get('every') ?? 5);
const code = args.get('code') ?? process.env.REGISTRATION_CODE ?? '';

type Person = { token: string; id: number; ws?: WebSocket };
type Sample = { at: number; ms: number };

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

// ---- the server under test

let child: ChildProcess | null = null;
let scratch = '';
let base = args.get('url')?.replace(/\/$/, '') ?? '';
if (!base) {
  scratch = mkdtempSync(join(tmpdir(), 'burrow-load-'));
  const port = await freePort();
  child = spawn(process.execPath, ['--no-warnings', join(dirname(fileURLToPath(import.meta.url)), 'index.ts')], {
    env: { ...process.env, PORT: String(port), DB_FILE: join(scratch, 'load.db'), UPLOAD_DIR: join(scratch, 'uploads'), BACKUP_KEEP: '0', REGISTRATION_CODE: code, LIVEKIT_API_KEY: '', SMTP_URL: '' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  base = `http://localhost:${port}`;
  for (let i = 0; i < 100; i++) {
    if (await fetch(base + '/api/config').then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
}
const cleanUp = () => {
  child?.kill();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
};
process.on('SIGINT', () => {
  cleanUp();
  process.exit(130);
});

// CPU and memory of the test server, read from /proc (Linux only).
const ticksPerSecond = 100;
const usage = () => {
  if (!child?.pid) return null;
  try {
    const stat = readFileSync(`/proc/${child.pid}/stat`, 'utf8').split(') ')[1].split(' ');
    const rss = Number(readFileSync(`/proc/${child.pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)?.[1] ?? 0) * 1024;
    return { cpu: (Number(stat[11]) + Number(stat[12])) / ticksPerSecond, rss, at: performance.now() };
  } catch {
    return null;
  }
};

const call = async (path: string, token?: string, body?: unknown) => {
  const res = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json()) as any;
  if (!res.ok) throw new Error(`${path}: ${data.error ?? res.status}`);
  return data;
};

// ---- people

const run = Math.random().toString(36).slice(2, 7);
const people: Person[] = [];
const host = await call('/api/register', undefined, { username: `lt-${run}-host`, password: `load-test-${run}`, registrationCode: code });
const burrow = await call('/api/servers', host.token, { name: `Load test ${run}` });
const room = burrow.channels.find((c: any) => c.kind !== 'voice').id as number;

const latencies: Sample[] = [];
let expected = 0;
let delivered = 0;
let sendErrors = 0;

const connect = (p: Person) =>
  new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(p.token)}`);
    p.ws = ws;
    ws.on('open', () => resolve());
    ws.on('error', reject);
    ws.on('message', (raw) => {
      const ev = JSON.parse(String(raw));
      if (ev.type === 'message' && ev.message?.channelId === room) {
        const sent = Number(String(ev.message.content).split(' ')[1]);
        if (sent) {
          latencies.push({ at: Date.now(), ms: Date.now() - sent });
          delivered++;
        }
      } else if (ev.type === 'error') sendErrors++;
    });
  });

const addPeople = async (count: number) => {
  // A few at a time: signing up hashes a password, which is slow on purpose.
  while (people.length < count) {
    const batch = Array.from({ length: Math.min(8, count - people.length) }, (_, i) => people.length + i);
    const made = await Promise.all(
      batch.map(async (n) => {
        const r = await call('/api/register', undefined, { username: `lt-${run}-${n}`, password: `load-test-${run}`, registrationCode: code });
        await call('/api/join', r.token, { inviteCode: burrow.inviteCode });
        const p: Person = { token: r.token, id: r.user.id };
        await connect(p);
        return p;
      }),
    );
    people.push(...made);
  }
};

const pct = (sorted: number[], q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);
const mb = (b: number) => `${Math.round(b / 1048576)} MB`;

console.log(`Peiskos load test against ${child ? 'a throwaway server' : base}. ${cpus().length} CPU, ${mb(totalmem())} memory.`);
console.log(`Everyone in one room, each sending a message every ${every}s; ${seconds}s per step.\n`);
console.log('people  msgs/s  delivered  reach p50  p95    p99    room load p95  server CPU  server memory');

const results: { people: number; p95: number; ok: boolean }[] = [];
try {
  for (const count of steps) {
    await addPeople(count);
    await new Promise((r) => setTimeout(r, 1000));
    latencies.length = 0;
    expected = delivered = sendErrors = 0;
    const loads: number[] = [];
    const before = usage();
    const end = Date.now() + seconds * 1000;
    let sent = 0;
    // Each person's messages are spread out, so they don't all land at once.
    const timers: ReturnType<typeof setTimeout>[] = [];
    people.forEach((p, i) => {
      const tick = () => {
        if (Date.now() >= end) return;
        p.ws!.send(JSON.stringify({ type: 'send', channelId: room, content: `lt ${Date.now()} ${'x'.repeat(40)}` }));
        sent++;
        expected += people.length;
        timers[i] = setTimeout(tick, every * 1000);
      };
      timers[i] = setTimeout(tick, Math.random() * every * 1000);
    });
    // Now and then someone opens the room, loading its latest 50 messages.
    const loader = setInterval(async () => {
      const p = people[Math.floor(Math.random() * people.length)];
      const t = performance.now();
      await call(`/api/channels/${room}/messages?limit=50`, p.token).catch(() => sendErrors++);
      loads.push(performance.now() - t);
    }, 250);
    await new Promise((r) => setTimeout(r, seconds * 1000));
    clearInterval(loader);
    timers.forEach((t) => clearTimeout(t));
    await new Promise((r) => setTimeout(r, 2000)); // the last messages arrive
    const after = usage();
    const ms = latencies.map((l) => l.ms).sort((a, b) => a - b);
    const share = expected ? delivered / expected : 1;
    const loadP95 = pct(loads.sort((a, b) => a - b), 0.95);
    const cpu = before && after ? `${Math.round(((after.cpu - before.cpu) / ((after.at - before.at) / 1000)) * 100)}%` : '-';
    const ok = share > 0.99 && pct(ms, 0.95) < 500 && loadP95 < 1000 && !sendErrors;
    results.push({ people: count, p95: pct(ms, 0.95), ok });
    console.log(
      [
        String(count).padEnd(6),
        (sent / seconds).toFixed(1).padEnd(6),
        `${(share * 100).toFixed(1)}%`.padEnd(9),
        `${pct(ms, 0.5)} ms`.padEnd(9),
        `${pct(ms, 0.95)} ms`.padEnd(6),
        `${pct(ms, 0.99)} ms`.padEnd(6),
        `${Math.round(loadP95)} ms`.padEnd(13),
        cpu.padEnd(10),
        after ? mb(after.rss) : '-',
      ].join('  '),
    );
    if (!ok) break;
  }
} finally {
  for (const p of people) p.ws?.close();
  cleanUp();
}

const good = results.filter((r) => r.ok).at(-1);
console.log(
  good
    ? `\nComfortable up to at least ${good.people} people chatting at once${results.at(-1)!.ok ? ' (the largest step tried)' : ''}: messages reach everyone within ${good.p95} ms for 95% of deliveries.`
    : '\nEven the first step was slow: messages took over half a second to reach people, or some never did.',
);
process.exit(0);
