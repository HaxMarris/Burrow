import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { brotliCompress, gzip, constants } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg']);

interface Entry {
  mtime: number;
  size: number;
  etag: string;
  raw: Buffer;
  br?: Buffer;
  gzip?: Buffer;
}

/** The encodings the browser accepts, leaving out any it marks q=0. */
function accepted(header: string | string[] | undefined) {
  const out = new Set<string>();
  for (const part of String(header ?? '').split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (!params.some((p) => /^\s*q=0(\.0*)?\s*$/.test(p))) out.add(name.trim());
  }
  return out;
}

/**
 * Serves the web app's files from memory: each is read and compressed once (and again when it
 * changes on disk), and browsers that already have it get a 304 instead of the whole file.
 */
export function staticFiles() {
  const cache = new Map<string, Promise<Entry>>();

  const load = async (file: string): Promise<Entry | null> => {
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) return null;
    const hit = cache.get(file);
    if (hit) {
      const entry = await hit.catch(() => null);
      if (entry && entry.mtime === info.mtimeMs && entry.size === info.size) return entry;
    }
    const next = (async () => {
      const raw = await readFile(file);
      const entry: Entry = {
        mtime: info.mtimeMs,
        size: info.size,
        etag: `W/"${createHash('sha1').update(raw).digest('base64url')}"`,
        raw,
      };
      const ext = file.slice(file.lastIndexOf('.'));
      if (COMPRESSIBLE.has(ext) && raw.length > 1024) {
        [entry.br, entry.gzip] = await Promise.all([
          brotli(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }),
          gzipAsync(raw, { level: 9 }),
        ]);
      }
      return entry;
    })();
    cache.set(file, next);
    next.catch(() => cache.delete(file));
    return next;
  };

  /** Sends `file`, or returns false when there is no such file. */
  return async (req: IncomingMessage, res: ServerResponse, file: string, type: string) => {
    const entry = await load(file);
    if (!entry) return false;
    const headers: Record<string, string | number> = {
      'content-type': type,
      'cache-control': 'no-cache', // always check, but a 304 costs almost nothing
      etag: entry.etag,
      vary: 'accept-encoding',
    };
    if (req.headers['if-none-match'] === entry.etag) {
      res.writeHead(304, headers).end();
      return true;
    }
    const wants = accepted(req.headers['accept-encoding']);
    let body = entry.raw;
    if (entry.br && wants.has('br')) [body, headers['content-encoding']] = [entry.br, 'br'];
    else if (entry.gzip && wants.has('gzip')) [body, headers['content-encoding']] = [entry.gzip, 'gzip'];
    headers['content-length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  };
}
