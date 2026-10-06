import { createHmac, randomBytes } from 'node:crypto';

// GIF search goes through Burrow, so the KLIPY key stays on the server and KLIPY never sees
// who is searching: it only gets Burrow's address and an anonymous id per person.

export interface GifOptions {
  apiKey: string;
  /** KLIPY's address; tests point it at a stand-in. */
  baseUrl?: string;
  /** Content rating: g, pg, pg-13 or r. */
  rating?: string;
}

/** A GIF as the app sees it: Burrow links only, never KLIPY's. */
export interface GifItem {
  id: string;
  title: string;
  width: number;
  height: number;
  preview: string;
}

interface Found {
  title: string;
  preview: string;
  full: string;
}

type FileSet = Record<string, Record<string, { url?: string; width?: number; height?: number }> | undefined>;

const PER_PAGE = 24;
const REMEMBER = 5000; // GIFs from recent searches we can still show or send
const TIMEOUT_MS = 8000;

export function gifSearch(opts: GifOptions) {
  const base = (opts.baseUrl ?? 'https://api.klipy.com').replace(/\/$/, '');
  const rating = opts.rating ?? 'pg-13';
  // Search results get short random ids; the app can only ask for (and send) GIFs Burrow found itself.
  const found = new Map<string, Found>();
  const remember = (f: Found) => {
    const id = randomBytes(12).toString('base64url');
    found.set(id, f);
    if (found.size > REMEMBER) found.delete(found.keys().next().value!);
    return id;
  };
  const customerId = (userId: number) => createHmac('sha256', opts.apiKey).update(`burrow-user:${userId}`).digest('hex').slice(0, 32);

  const pick = (files: FileSet, sizes: string[]) => {
    for (const size of sizes)
      for (const format of ['webp', 'gif']) {
        const f = files[size]?.[format];
        if (f?.url) return f;
      }
    return null;
  };

  const list = async (path: string, params: Record<string, string>, userId: number) => {
    const url = new URL(`${base}/api/v1/${encodeURIComponent(opts.apiKey)}/gifs/${path}`);
    for (const [k, v] of Object.entries({ ...params, per_page: String(PER_PAGE), rating, customer_id: customerId(userId) }))
      url.searchParams.set(k, v);
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`KLIPY answered ${res.status}`);
    const body = (await res.json()) as { data?: { data?: unknown[]; has_next?: boolean } };
    const items: GifItem[] = [];
    for (const raw of body.data?.data ?? []) {
      const r = raw as { type?: string; title?: string; file?: FileSet };
      // Ads and anything else that isn't a GIF are left out.
      if (!r.file || (r.type && r.type !== 'gif')) continue;
      const preview = pick(r.file, ['sm', 'xs', 'md']);
      const full = pick(r.file, ['md', 'hd', 'sm']);
      if (!preview?.url || !full?.url) continue;
      const title = String(r.title ?? '').slice(0, 120);
      const id = remember({ title, preview: preview.url, full: full.url });
      items.push({ id, title, width: Number(preview.width) || 1, height: Number(preview.height) || 1, preview: `/api/gifs/preview/${id}` });
    }
    return { items, hasMore: !!body.data?.has_next };
  };

  return {
    search: (q: string, page: number, userId: number) => list('search', { q, page: String(page) }, userId),
    trending: (page: number, userId: number) => list('trending', { page: String(page) }, userId),
    /** The GIF behind an id from a recent search, if Burrow still remembers it. */
    get: (id: string) => found.get(id),
  };
}

export type GifSearch = ReturnType<typeof gifSearch>;

/** Downloads a GIF from KLIPY, refusing anything that isn't an image or is bigger than `max`. */
export async function download(url: string, max: number) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok || !res.body) throw new Error(`KLIPY answered ${res.status}`);
  if (Number(res.headers.get('content-length')) > max) throw new Error('That GIF is too big');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > max) throw new Error('That GIF is too big');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
