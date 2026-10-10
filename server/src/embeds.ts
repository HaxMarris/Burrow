import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';

// Link previews: when a message has links, Burrow fetches each page itself and keeps its title,
// description and picture. People's apps only ever talk to Burrow, so the sites never see them.
//
// The server makes these requests on someone's say-so, so it refuses to reach anything private:
// its own machine, the home or cloud network it sits in, and the cloud's metadata address.

export interface Embed {
  url: string;
  kind: 'link' | 'video' | 'image';
  siteName?: string;
  title?: string;
  description?: string;
  /** The picture's address on the site; the app gets it through Burrow instead. */
  image?: string;
}

export interface EmbedOptions {
  /** Lets previews reach private addresses. Only for tests. */
  allowPrivate?: boolean;
}

const MAX_PAGE_BYTES = 768 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 4;
const USER_AGENT = 'Mozilla/5.0 (compatible; BurrowLinkPreview/1.0; +https://github.com/HaxMarris/Burrow)';

const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
] as const)
  blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2001:db8::', 32]] as const)
  blocked.addSubnet(net, bits, 'ipv6');

/** Whether an address is somewhere private that previews must not reach. */
export function isPrivateAddress(address: string) {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family !== 6) return true;
  // An IPv4 address written as IPv6 (::ffff:1.2.3.4 or ::ffff:102:304) is checked as IPv4.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return blocked.check(mapped[1], 'ipv4');
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (hex) {
    const [hi, lo] = [parseInt(hex[1], 16), parseInt(hex[2], 16)];
    return blocked.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, 'ipv4');
  }
  return blocked.check(address, 'ipv6');
}

/** Links in a message that should get a preview: not inside code, and not wrapped in <angle brackets>. */
export function linksIn(content: string, max = 3) {
  const text = content.replace(/```[\s\S]*?```|`[^`\n]+`/g, ' ').replace(/<https?:\/\/[^\s>]+>/g, ' ');
  const found: string[] = [];
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)'"\]|*~]/g)) {
    if (!found.includes(m[0])) found.push(m[0]);
    if (found.length >= max) break;
  }
  return found;
}

type Fetched = { status: number; type: string; url: string; body: Buffer };

/** Fetches a public web address, following a few redirects, and reads at most `max` bytes of it. */
export async function safeFetch(rawUrl: string, max: number, opts: EmbedOptions = {}, accept = 'text/html,*/*;q=0.5'): Promise<Fetched> {
  let url = new URL(rawUrl);
  for (let hop = 0; ; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only web links get previews');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && !opts.allowPrivate && isPrivateAddress(host)) throw new Error('That address is private');
    const res = await get(url, accept, opts);
    const location = res.headers.location;
    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && location) {
      res.resume();
      if (hop >= MAX_REDIRECTS) throw new Error('Too many redirects');
      url = new URL(location, url);
      continue;
    }
    const body = await readSome(res, max);
    return { status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase(), url: url.href, body };
  }
}

function get(url: URL, accept: string, opts: EmbedOptions) {
  // Each address the name points at is checked as it's looked up, so a name can't
  // switch to a private address between the check and the connection.
  const lookup = (hostname: string, options: { all?: boolean }, callback: (...args: any[]) => void) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
      if (err) return callback(err);
      if (!opts.allowPrivate && addresses.some((a) => isPrivateAddress(a.address)))
        return callback(Object.assign(new Error('That address is private'), { code: 'EPRIVATE' }));
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });
  };
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<IncomingMessage>((resolve, reject) => {
    const req = request(url, {
      method: 'GET',
      // A fresh connection each time, so every request goes through the address check.
      agent: false,
      lookup: lookup as never,
      timeout: TIMEOUT_MS,
      headers: { 'user-agent': USER_AGENT, accept, 'accept-language': 'en' },
    }, resolve);
    req.on('timeout', () => req.destroy(new Error('Timed out')));
    req.on('error', reject);
    req.end();
  });
}

function readSome(res: IncomingMessage, max: number) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => res.destroy(new Error('Timed out')), TIMEOUT_MS);
    res.on('data', (c: Buffer) => {
      chunks.push(c);
      size += c.length;
      // A page's preview details are near its top, so a cut-off page is still useful.
      if (size >= max) { res.destroy(); finish(); }
    });
    res.on('end', finish);
    res.on('close', finish);
    res.on('error', (err) => { clearTimeout(timer); reject(err); });
    function finish() {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).subarray(0, max));
    }
  });
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function decodeEntities(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[e.toLowerCase()] ?? whole;
  });
}
const clean = (s: string | undefined, max: number) => {
  const v = s && decodeEntities(s).replace(/\s+/g, ' ').trim();
  return v ? (v.length > max ? v.slice(0, max - 1).trimEnd() + '…' : v) : undefined;
};

/** The preview details a page gives about itself (Open Graph and Twitter tags, then its title). */
export function parsePage(html: string, pageUrl: string): Omit<Embed, 'url' | 'kind'> & { type?: string } {
  const head = html.slice(0, MAX_PAGE_BYTES);
  const meta = new Map<string, string>();
  for (const tag of head.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = new Map<string, string>();
    for (const a of tag[0].matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) attrs.set(a[1].toLowerCase(), a[3] ?? a[4] ?? a[5] ?? '');
    const key = (attrs.get('property') ?? attrs.get('name') ?? '').toLowerCase();
    const content = attrs.get('content');
    if (key && content != null && !meta.has(key)) meta.set(key, content);
  }
  const title = meta.get('og:title') ?? meta.get('twitter:title') ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  const image = meta.get('og:image:secure_url') ?? meta.get('og:image') ?? meta.get('twitter:image') ?? meta.get('twitter:image:src');
  let imageUrl: string | undefined;
  try {
    if (image) imageUrl = new URL(decodeEntities(image.trim()), pageUrl).href;
  } catch {}
  return {
    siteName: clean(meta.get('og:site_name'), 80),
    title: clean(title, 200),
    description: clean(meta.get('og:description') ?? meta.get('twitter:description') ?? meta.get('description'), 300),
    image: imageUrl && /^https?:/.test(imageUrl) ? imageUrl : undefined,
    type: meta.get('og:type'),
  };
}

const IMAGE_MAGIC: [string, (b: Buffer) => boolean][] = [
  ['image/png', (b) => b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))],
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/gif', (b) => b.subarray(0, 4).toString('latin1') === 'GIF8'],
  ['image/webp', (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
];
/** The picture's type from its first bytes, or null if it isn't one we show. */
export const imageType = (b: Buffer) => IMAGE_MAGIC.find(([, magic]) => magic(b))?.[0] ?? null;

const isYouTube = (u: URL) => /(^|\.)youtube\.com$|(^|\.)youtu\.be$/i.test(u.hostname);
const isTwitter = (u: URL) => /(^|\.)(twitter|x)\.com$/i.test(u.hostname) && /\/status\/\d+/.test(u.pathname);

async function oembed(endpoint: string, opts: EmbedOptions) {
  const res = await safeFetch(endpoint, 256 * 1024, opts, 'application/json');
  if (res.status !== 200) throw new Error(`oEmbed answered ${res.status}`);
  return JSON.parse(res.body.toString('utf8')) as Record<string, unknown>;
}

/** Works out a link's preview, or null when there's nothing worth showing. */
export async function fetchEmbed(link: string, opts: EmbedOptions = {}): Promise<Embed | null> {
  const url = new URL(link);
  // YouTube and X pages need JavaScript, but both say what a link is through oEmbed.
  if (isYouTube(url)) {
    const data = await oembed(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(link)}`, opts).catch(() => null);
    if (data?.title)
      return { url: link, kind: 'video', siteName: 'YouTube', title: clean(String(data.title), 200), description: clean(String(data.author_name ?? ''), 100), image: typeof data.thumbnail_url === 'string' ? data.thumbnail_url : undefined };
  }
  if (isTwitter(url)) {
    const data = await oembed(`https://publish.twitter.com/oembed?omit_script=true&url=${encodeURIComponent(link)}`, opts).catch(() => null);
    if (data?.html) {
      const text = String(data.html).replace(/<a\b[^>]*>pic\.twitter\.com[^<]*<\/a>/gi, '').replace(/<\/p>[\s\S]*$/i, '').replace(/<[^>]+>/g, ' ');
      return { url: link, kind: 'link', siteName: 'X', title: clean(String(data.author_name ?? ''), 100), description: clean(text, 300) };
    }
  }
  const res = await safeFetch(link, MAX_PAGE_BYTES, opts);
  if (res.status !== 200) return null;
  if (res.type.startsWith('image/')) return imageType(res.body) ? { url: link, kind: 'image', image: res.url } : null;
  if (res.type !== 'text/html' && res.type !== 'application/xhtml+xml') return null;
  const page = parsePage(res.body.toString('utf8'), res.url);
  if (!page.title && !page.description) return null;
  const { type, ...rest } = page;
  return { url: link, kind: type?.startsWith('video') ? 'video' : 'link', siteName: rest.siteName ?? url.hostname.replace(/^www\./, ''), ...rest };
}

/** Downloads a preview's picture, refusing anything that isn't a picture or is too big. */
export async function fetchImage(link: string, opts: EmbedOptions = {}) {
  const res = await safeFetch(link, MAX_IMAGE_BYTES + 1, opts, 'image/*');
  if (res.status !== 200 || res.body.length > MAX_IMAGE_BYTES) throw new Error("Couldn't load that picture");
  const type = imageType(res.body);
  if (!type) throw new Error("Couldn't load that picture");
  return { type, data: res.body };
}
