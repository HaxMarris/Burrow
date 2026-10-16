// The plumbing every route shares: errors with a status, reading and answering requests, who's
// asking (and from where), and the headers the web app is served with.
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BlockList, isIP } from 'node:net';

export type Json = Record<string, unknown>;

/** An error the person asking sees, with the HTTP status to send it with. */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const APP_CSP = [
  "default-src 'self'",
  // Noise suppression runs as WebAssembly.
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  // Voice may live on another address (LIVEKIT_URL).
  "connect-src 'self' https: wss: ws:",
  "worker-src 'self' blob:",
  // Listen together plays YouTube in its privacy-enhanced player; games at the fire are Peiskos's own pages.
  "frame-src 'self' https://www.youtube-nocookie.com",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
};

/** Compares secrets without leaking how much of them matched through timing. */
export function sameText(a: unknown, b: string) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// Where a reverse proxy (Caddy) can reach Peiskos from: this machine, or Docker's own networks.
const PROXIES = new BlockList();
PROXIES.addSubnet('127.0.0.0', 8, 'ipv4');
PROXIES.addSubnet('10.0.0.0', 8, 'ipv4');
PROXIES.addSubnet('172.16.0.0', 12, 'ipv4');
PROXIES.addAddress('::1', 'ipv6');

/** The visitor's address. Behind Caddy on the same machine, Caddy passes it along in X-Forwarded-For. */
export function clientIp(req: IncomingMessage) {
  const direct = req.socket.remoteAddress ?? '';
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').pop()?.trim();
  const v4 = direct.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
  const local = isIP(v4) === 4 ? PROXIES.check(v4, 'ipv4') : PROXIES.check(direct, 'ipv6');
  return local && forwarded ? forwarded : direct;
}

export const readBody = (req: IncomingMessage) =>
  new Promise<Json>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) reject(new HttpError(413, 'Body too large'));
      else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });

export const send = (res: ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
};

/** Reads a raw request body (an upload) into memory, failing with `tooBig` past `max` bytes. */
export async function readLimited(req: IncomingMessage, max: number, tooBig: Error) {
  if (Number(req.headers['content-length']) > max) throw tooBig;
  const chunks: Buffer[] = [];
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        req.pause();
        reject(tooBig);
      } else chunks.push(c);
    });
    req.on('end', resolve);
    req.on('error', reject);
  });
  return Buffer.concat(chunks);
}

/** The login token a request carries, from its Authorization header. */
export const bearer = (req: IncomingMessage) => req.headers.authorization?.replace(/^Bearer /, '');

/**
 * A per-key allowance that refills over time (a token bucket): up to `burst` at once, then
 * `perSecond` more each second. `take` uses one and says whether there was one to use.
 */
export function allowance(burst: number, perSecond: number) {
  const left = new Map<number, { n: number; at: number }>();
  return {
    take(key: number) {
      const t = Date.now();
      const b = left.get(key) ?? { n: burst, at: t };
      b.n = Math.min(burst, b.n + ((t - b.at) / 1000) * perSecond);
      b.at = t;
      left.set(key, b);
      if (b.n < 1) return false;
      b.n -= 1;
      return true;
    },
  };
}
