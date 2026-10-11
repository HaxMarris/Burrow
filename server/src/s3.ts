// Just enough of the S3 protocol to copy backups somewhere else: put, get and list objects.
// Works with Amazon S3 and the services that speak its language (Backblaze B2, Cloudflare R2,
// Wasabi, MinIO and others). Requests are signed with AWS Signature Version 4.
import { createHash, createHmac } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface S3Config {
  bucket: string;
  /** e.g. https://s3.us-west-004.backblazeb2.com; Amazon's own when left out. */
  endpoint?: string;
  region: string;
  keyId: string;
  secret: string;
  /** Put in front of every name, e.g. "burrow/". */
  prefix: string;
}

/** Off-site backup settings from the environment, or null when they aren't all there. */
export function s3FromEnv(env = process.env): S3Config | null {
  const bucket = env.BACKUP_S3_BUCKET, keyId = env.BACKUP_S3_KEY_ID, secret = env.BACKUP_S3_SECRET;
  if (!bucket || !keyId || !secret) return null;
  let prefix = env.BACKUP_S3_PREFIX ?? 'burrow/';
  if (prefix && !prefix.endsWith('/')) prefix += '/';
  return { bucket, keyId, secret, prefix, region: env.BACKUP_S3_REGION || 'us-east-1', endpoint: env.BACKUP_S3_ENDPOINT?.replace(/\/$/, '') || undefined };
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();
// S3 wants every character but these escaped, in names and query values alike.
const encode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function signedRequest(cfg: S3Config, method: string, key: string, query: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const base = cfg.endpoint ?? `https://s3.${cfg.region}.amazonaws.com`;
  const url = new URL(base);
  // Path-style addresses (bucket in the path) work everywhere, including names with dots.
  const path = `${url.pathname.replace(/\/$/, '')}/${encode(cfg.bucket)}/${key.split('/').map(encode).join('/')}`.replace(/\/$/, key ? '' : '/');
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const qs = Object.keys(query).sort().map((k) => `${encode(k)}=${encode(query[k])}`).join('&');
  const all: Record<string, string> = { ...headers, host: url.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' };
  const names = Object.keys(all).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const canonical = [method, path, qs, names.map((h) => `${h}:${lower[h]}\n`).join(''), names.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
  const scope = `${day}/${cfg.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${cfg.secret}`, day), cfg.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(toSign).digest('hex');
  return {
    url: `${url.protocol}//${url.host}${path}${qs ? `?${qs}` : ''}`,
    headers: { ...all, authorization: `AWS4-HMAC-SHA256 Credential=${cfg.keyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` },
  };
}

async function failed(res: Response, what: string) {
  const text = await res.text().catch(() => '');
  const code = text.match(/<Code>([^<]+)<\/Code>/)?.[1];
  const message = text.match(/<Message>([^<]+)<\/Message>/)?.[1];
  return new Error(`${what}: ${res.status}${code ? ` ${code}` : ''}${message ? ` (${message})` : ''}`);
}

/** Copies a local file to `name` (under the prefix). */
export async function putFile(cfg: S3Config, name: string, file: string, type = 'application/octet-stream') {
  const { size } = await stat(file);
  const req = signedRequest(cfg, 'PUT', cfg.prefix + name, {}, { 'content-length': String(size), 'content-type': type });
  const res = await fetch(req.url, {
    method: 'PUT',
    headers: req.headers,
    body: size ? (Readable.toWeb(createReadStream(file)) as ReadableStream) : '',
    duplex: 'half',
  } as RequestInit);
  if (!res.ok) throw await failed(res, `Upload of ${name} failed`);
}

/** Copies `name` (under the prefix) to a local file. */
export async function getFile(cfg: S3Config, name: string, file: string) {
  const req = signedRequest(cfg, 'GET', cfg.prefix + name);
  const res = await fetch(req.url, { headers: req.headers });
  if (!res.ok || !res.body) throw await failed(res, `Download of ${name} failed`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(file));
}

/** Everything stored under `under` (inside the prefix): names without the prefix, and sizes. */
export async function listFiles(cfg: S3Config, under = '') {
  const out: { name: string; size: number; modified: string }[] = [];
  let token: string | undefined;
  do {
    const query: Record<string, string> = { 'list-type': '2', prefix: cfg.prefix + under, 'max-keys': '1000' };
    if (token) query['continuation-token'] = token;
    const req = signedRequest(cfg, 'GET', '', query);
    const res = await fetch(req.url, { headers: req.headers });
    if (!res.ok) throw await failed(res, 'Listing the backups failed');
    const xml = await res.text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = unescapeXml(m[1].match(/<Key>([^<]*)<\/Key>/)?.[1] ?? '');
      out.push({ name: key.slice(cfg.prefix.length), size: Number(m[1].match(/<Size>(\d+)<\/Size>/)?.[1] ?? 0), modified: m[1].match(/<LastModified>([^<]*)</)?.[1] ?? '' });
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? unescapeXml(xml.match(/<NextContinuationToken>([^<]*)</)?.[1] ?? '') : undefined;
  } while (token);
  return out;
}

const unescapeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
