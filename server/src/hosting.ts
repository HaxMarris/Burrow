// Running the server: the admin page for whoever hosts Burrow (people, storage, voice, backups,
// signup links, updates and crash reports), the health check for uptime monitors, and storage
// clean-up. Only the host's admins can use the /api/admin routes.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from './db.ts';
import { backupNow, copyOffsite, localBackups, offsiteBackups, offsiteStatus, queueRestore } from './backup.ts';
import type { S3Config } from './s3.ts';

export interface HostingOptions {
  dbFile: string;
  backupDir: string;
  backupKeep: number;
  offsite?: S3Config;
  /** The data folder, shared with the updater. */
  dataDir: string;
  /** Usernames that can open the admin page; with none, the first account made. */
  admins: string[];
  /** Pinged every five minutes, for a "tell me if this goes quiet" uptime monitor. */
  heartbeatUrl?: string;
}

type Json = Record<string, unknown>;
type Handler = (ctx: { user: { id: number; username: string }; params: string[]; body: Json; url: URL; ip: string; host: string; secure: boolean }) => unknown;

export interface HostingContext {
  db: Db;
  /** The database itself, not the app's caching wrapper: SQLite's backup needs the real thing. */
  rawDb: Db;
  hosting?: HostingOptions;
  registrationCode?: string;
  uploadDir?: string;
  publicUrl?: string;
  route: (method: string, path: string, handler: Handler, auth?: boolean) => void;
  fail: (status: number, message: string) => Error;
  online: Set<number>;
  inVoice: Map<number, number>;
  /** Logs someone out everywhere, closing their open connections. */
  signOut: (userId: number) => void;
  /** Deletes an account the way deleting your own does, handing over burrows they host. */
  deleteAccount: (userId: number, deleteMessages: boolean) => void;
}

export type SignupMode = 'open' | 'code' | 'links';
const SIGNUP_LINK_DAYS = [1, 7, 30];
const MAX_ERRORS = 200;
const UPDATER_FRESH_MS = 3 * 60_000; // the updater says it's there at least this often

export function hosting(ctx: HostingContext) {
  const { db, route, fail } = ctx;
  const now = () => Date.now();
  const startedAt = now();

  // ---- who runs the place

  const firstUserId = () =>
    (db.prepare('SELECT MIN(id) AS id FROM users WHERE bot = 0 AND deleted_at IS NULL').get() as { id: number | null }).id;
  const adminNames = () => (ctx.hosting?.admins ?? []).map((n) => n.toLowerCase());
  /**
   * With ADMIN_USERS, each name listed belongs to the first account seen with it, for good. If
   * that person changes their username, whoever takes the old one doesn't become an admin.
   */
  const isAdmin = (userId: number) => {
    const u = db.prepare('SELECT username, bot, deleted_at FROM users WHERE id = ?').get(userId) as
      | { username: string; bot: number; deleted_at: number | null }
      | undefined;
    if (!u || u.bot || u.deleted_at) return false;
    const names = adminNames();
    if (!names.length) return userId === firstUserId();
    const name = u.username.toLowerCase();
    if (!names.includes(name)) return false;
    const pinned = setting(`admin_pin:${name}`);
    if (pinned === undefined) setSetting(`admin_pin:${name}`, String(userId));
    return pinned === undefined || pinned === String(userId);
  };
  const admin = (handler: Handler): Handler => (c) => {
    if (!isAdmin(c.user.id)) throw fail(403, 'Only whoever runs this Peiskos can do that');
    return handler(c);
  };

  // ---- settings

  const setting = (key: string) => (db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  const setSetting = (key: string, value: string) =>
    db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

  /** Who can make an account: anyone, people with the registration code (or a link), or only people with a link. */
  const signupMode = (): SignupMode => {
    const saved = setting('signup_mode');
    if (saved === 'links' || saved === 'open') return saved;
    if (saved === 'code' && ctx.registrationCode) return 'code';
    return ctx.registrationCode ? 'code' : 'open';
  };

  // ---- signup links

  const linkRow = (code: unknown) => {
    if (typeof code !== 'string' || !/^[\w-]{6,40}$/.test(code)) return undefined;
    return db.prepare('SELECT code, expires_at AS expiresAt, max_uses AS maxUses, uses FROM signup_links WHERE code = ?').get(code) as
      | { code: string; expiresAt: number | null; maxUses: number; uses: number }
      | undefined;
  };
  const linkWorks = (l: ReturnType<typeof linkRow>) => !!l && (l.expiresAt === null || l.expiresAt > now()) && l.uses < l.maxUses;

  /**
   * Checks a signup before the account is made. Returns the signup link used (to count it once
   * the account exists), or null when the registration code (or nothing) let them in.
   * Returns 'code' when the caller still has to check the registration code.
   */
  const checkSignup = (body: Json): string | null | 'code' => {
    if (body.signupLink) {
      const l = linkRow(body.signupLink);
      if (!linkWorks(l)) throw fail(403, 'That signup link has run out. Ask for a new one.');
      return l!.code;
    }
    const mode = signupMode();
    if (mode === 'links') throw fail(403, 'Signing up here needs a signup link from whoever runs this Peiskos.');
    return mode === 'code' ? 'code' : null;
  };
  const useSignupLink = (code: string) => db.prepare('UPDATE signup_links SET uses = uses + 1 WHERE code = ?').run(code);

  route('GET', '/api/signup-links/:code', ({ params }) => {
    const l = linkRow(params[0]);
    return { ok: linkWorks(l), expiresAt: l?.expiresAt ?? null };
  }, false);

  const linkJson = (r: Json) => ({ ...r, used: (r.uses as number) >= (r.maxUses as number) || (r.expiresAt !== null && (r.expiresAt as number) <= now()) });
  const signupLinks = () =>
    (db.prepare(`SELECT code, note, created_at AS createdAt, expires_at AS expiresAt, max_uses AS maxUses, uses,
                   (SELECT username FROM users WHERE id = created_by) AS createdBy
                 FROM signup_links ORDER BY created_at DESC LIMIT 100`).all() as Json[]).map(linkJson);

  route('POST', '/api/admin/signup-links', admin(({ user, body }) => {
    const days = Number(body.days);
    const uses = Math.round(Number(body.uses ?? 1));
    if (body.days != null && !SIGNUP_LINK_DAYS.includes(days)) throw fail(400, 'Links last a day, a week or a month');
    if (!(uses >= 1 && uses <= 50)) throw fail(400, 'A link can be used 1 to 50 times');
    const code = randomBytes(12).toString('base64url');
    db.prepare('INSERT INTO signup_links (code, note, created_by, created_at, expires_at, max_uses) VALUES (?, ?, ?, ?, ?, ?)').run(
      code, String(body.note ?? '').trim().slice(0, 60), user.id, now(), body.days == null ? null : now() + days * 864e5, uses,
    );
    return { links: signupLinks() };
  }));
  route('DELETE', '/api/admin/signup-links/:code', admin(({ params }) => {
    db.prepare('DELETE FROM signup_links WHERE code = ?').run(params[0]);
    return { links: signupLinks() };
  }));
  route('PATCH', '/api/admin/settings', admin(({ body }) => {
    if (body.signupMode !== undefined) {
      if (!['open', 'code', 'links'].includes(body.signupMode as string)) throw fail(400, 'Pick who can sign up');
      if (body.signupMode === 'code' && !ctx.registrationCode) throw fail(400, 'Set REGISTRATION_CODE in .env first');
      setSetting('signup_mode', body.signupMode as string);
    }
    return { signupMode: signupMode() };
  }));

  // ---- storage

  const dirSize = (dir: string): number => {
    if (!existsSync(dir)) return 0;
    let total = 0;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      total += e.isDirectory() ? dirSize(p) : e.isFile() ? statSync(p).size : 0;
    }
    return total;
  };
  const fileSize = (f: string) => (existsSync(f) ? statSync(f).size : 0);

  /**
   * Files no message, profile, burrow, emoji or sound points at any more (left behind by deleted
   * burrows and rooms, for one). Only ones over an hour old, so nothing being uploaded is touched.
   */
  const cleanUpStorage = (dryRun = false) => {
    const dir = ctx.uploadDir;
    if (!dir || !existsSync(dir)) return { files: 0, bytes: 0 };
    const keep = new Map<string, Set<string>>([['', new Set()], ['avatars', new Set()], ['burrow-pictures', new Set()], ['emoji', new Set()], ['sounds', new Set()]]);
    const add = (folder: string, sql: string) => {
      for (const r of db.prepare(sql).all() as { f: string | null }[]) if (r.f) keep.get(folder)!.add(r.f);
    };
    for (const r of db.prepare('SELECT id FROM attachments').all() as { id: string }[]) keep.get('')!.add(r.id).add(`${r.id}.thumb`);
    add('avatars', 'SELECT avatar AS f FROM users UNION SELECT banner FROM users');
    add('burrow-pictures', 'SELECT icon AS f FROM servers UNION SELECT banner FROM servers UNION SELECT picture FROM motd');
    add('emoji', 'SELECT file AS f FROM custom_emoji');
    add('sounds', 'SELECT file AS f FROM sounds');
    const cutoff = now() - 3600_000;
    let files = 0, bytes = 0;
    for (const [folder, names] of keep) {
      const path = join(dir, folder);
      if (!existsSync(path)) continue;
      for (const e of readdirSync(path, { withFileTypes: true })) {
        if (!e.isFile() || names.has(e.name)) continue;
        const f = join(path, e.name);
        const info = statSync(f);
        if (info.mtimeMs > cutoff) continue;
        files++;
        bytes += info.size;
        if (!dryRun) try { unlinkSync(f); } catch {}
      }
    }
    return { files, bytes };
  };
  if (ctx.uploadDir) {
    const daily = () => {
      try {
        const r = cleanUpStorage();
        if (r.files) console.log(`Storage clean-up: removed ${r.files} unused file${r.files === 1 ? '' : 's'} (${Math.round(r.bytes / 1048576)} MB).`);
      } catch (err) {
        console.error('Storage clean-up failed:', err instanceof Error ? err.message : err);
      }
    };
    setTimeout(daily, 5 * 60_000).unref();
    setInterval(daily, 24 * 3600_000).unref();
  }
  route('POST', '/api/admin/cleanup', admin(({ body }) => cleanUpStorage(body.dryRun === true)));

  // ---- backups

  const backupInfo = async () => {
    const h = ctx.hosting;
    if (!h) return null;
    let offsite: Json | null = null;
    if (h.offsite) offsite = { bucket: h.offsite.bucket, ...(offsiteStatus(h.backupDir) ?? {}) };
    return { keep: h.backupKeep, local: localBackups(h.backupDir), offsite };
  };
  route('POST', '/api/admin/backups', admin(async () => {
    const h = ctx.hosting;
    if (!h || h.backupKeep <= 0) throw fail(400, 'Backups are off (BACKUP_KEEP is 0)');
    const file = await backupNow(ctx.rawDb, h.backupDir, h.backupKeep, new Date(), true);
    if (h.offsite) await copyOffsite(h.offsite, h.backupDir, ctx.uploadDir, file).catch(() => {});
    return backupInfo();
  }));
  route('GET', '/api/admin/backups/offsite', admin(async () => {
    const h = ctx.hosting;
    if (!h?.offsite) return { backups: [] };
    return { backups: await offsiteBackups(h.offsite) };
  }));
  // Restoring swaps the database when Burrow next starts, so it stops itself here; Docker starts it again.
  route('POST', '/api/admin/backups/restore', admin(({ body }) => {
    const h = ctx.hosting;
    const name = String(body.name ?? '');
    if (!h || !/^burrow-\d{4}-\d{2}-\d{2}\.db$/.test(name) || !existsSync(join(h.backupDir, name))) throw fail(404, 'That backup is gone');
    queueRestore(h.dbFile, join(h.backupDir, name));
    console.log(`Restoring ${name}: restarting.`);
    setTimeout(() => process.exit(0), 500).unref();
    return { restarting: true };
  }));

  // ---- updates, through the updater container (see docker-compose.yml)

  const updaterDir = () => (ctx.hosting ? join(ctx.hosting.dataDir, 'updater') : null);
  const updaterStatus = () => {
    const dir = updaterDir();
    if (!dir) return null;
    try {
      const s = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8'));
      return { ...s, running: now() - (s.seenAt ?? 0) * 1000 < UPDATER_FRESH_MS, requested: existsSync(join(dir, 'request')) };
    } catch {
      return null;
    }
  };
  route('GET', '/api/admin/update', admin(() => ({ updater: updaterStatus() })));
  route('POST', '/api/admin/update', admin(() => {
    const status = updaterStatus();
    if (!status?.running) throw fail(503, "The updater isn't running. See \"Updating from the admin page\" in the README.");
    mkdirSync(updaterDir()!, { recursive: true });
    writeFileSync(join(updaterDir()!, 'request'), String(now()));
    return { updater: updaterStatus() };
  }));

  // ---- crash reports from people's apps

  const recentReports = new Map<string, { count: number; until: number }>();
  route('POST', '/api/errors', ({ body, ip, user }) => {
    const t = now();
    const r = recentReports.get(ip);
    if (r && r.until > t && r.count >= 20) return { ok: true }; // plenty from this address for now
    if (!r || r.until <= t) recentReports.set(ip, { count: 1, until: t + 3600_000 });
    else r.count++;
    if (recentReports.size > 5000) for (const [k, v] of recentReports) if (v.until <= t) recentReports.delete(k);
    const message = String(body.message ?? '').slice(0, 500);
    if (!message) return { ok: true };
    const stack = String(body.stack ?? '').slice(0, 4000);
    const where = String(body.where ?? '').slice(0, 300);
    const app = String(body.app ?? '').slice(0, 300);
    const hash = createHash('sha256').update(message + '\n' + stack.split('\n').slice(0, 3).join('\n')).digest('hex');
    db.prepare(`INSERT INTO client_errors (hash, message, stack, where_at, app, user_id, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(hash) DO UPDATE SET count = count + 1, last_at = excluded.last_at, app = excluded.app, where_at = excluded.where_at`)
      .run(hash, message, stack, where, app, user?.id ?? null, t, t);
    db.prepare(`DELETE FROM client_errors WHERE id NOT IN (SELECT id FROM client_errors ORDER BY last_at DESC LIMIT ${MAX_ERRORS})`).run();
    return { ok: true };
  }, false);
  const errorList = () =>
    db.prepare(`SELECT id, message, stack, where_at AS "where", app, first_at AS firstAt, last_at AS lastAt, count,
                  (SELECT username FROM users WHERE id = user_id) AS username
                FROM client_errors ORDER BY last_at DESC LIMIT 100`).all();
  route('GET', '/api/admin/errors', admin(() => ({ errors: errorList() })));
  route('DELETE', '/api/admin/errors', admin(() => {
    db.prepare('DELETE FROM client_errors').run();
    return { errors: [] };
  }));

  // ---- people

  route('POST', '/api/admin/users/:id/reset-link', admin(({ params, host, secure }) => {
    const u = db.prepare('SELECT id, username FROM users WHERE id = ? AND deleted_at IS NULL AND bot = 0').get(Number(params[0])) as { id: number; username: string } | undefined;
    if (!u) throw fail(404, 'Nobody by that name');
    const token = randomBytes(24).toString('base64url');
    db.prepare('UPDATE users SET reset_link = ?, reset_link_expires = ? WHERE id = ?').run(createHash('sha256').update(token).digest('hex'), now() + 3600_000, u.id);
    const base = (ctx.publicUrl || `${secure ? 'https' : 'http'}://${host}`).replace(/\/$/, '');
    return { url: `${base}/?reset=${token}`, username: u.username };
  }));
  route('POST', '/api/admin/users/:id/sign-out', admin(({ params, user }) => {
    const id = Number(params[0]);
    if (id === user.id) throw fail(400, "That's you. Use Your devices in your account instead.");
    ctx.signOut(id);
    return { ok: true };
  }));

  route('POST', '/api/admin/users/:id/delete', admin(({ params, user, body }) => {
    const id = Number(params[0]);
    if (id === user.id) throw fail(400, "That's you. Delete your own account from Your data in your account instead.");
    if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND deleted_at IS NULL AND bot = 0').get(id)) throw fail(404, 'Nobody by that name');
    ctx.deleteAccount(id, body.deleteMessages === true);
    return { ok: true };
  }));

  // ---- the overview

  const checks = (secure: boolean) => {
    const https = secure || (ctx.publicUrl ?? '').startsWith('https://');
    const mode = signupMode();
    const h = ctx.hosting;
    const off = h ? offsiteStatus(h.backupDir) : null;
    const updater = updaterStatus();
    // A name in ADMIN_USERS that no account has yet goes to whoever signs up with it first.
    const unclaimed = adminNames().filter((n) => !setting(`admin_pin:${n}`) && !db.prepare('SELECT 1 FROM users WHERE username = ? AND deleted_at IS NULL').get(n));
    return [
      { ok: https, text: https ? 'Reached over https' : 'Not on https yet: passwords and messages cross the internet unprotected', key: 'https' },
      { ok: mode !== 'open', text: mode === 'open' ? 'Anyone who finds this server can sign up' : mode === 'links' ? 'Signing up needs a signup link' : 'Signing up needs the registration code or a signup link', key: 'signup' },
      { ok: mode !== 'code' || (ctx.registrationCode ?? '').length >= 10, text: mode === 'code' && (ctx.registrationCode ?? '').length < 10 ? 'The registration code is short and easy to guess' : 'Registration code is fine', key: 'code', hidden: mode !== 'code' },
      { ok: !!h && h.backupKeep > 0, text: h && h.backupKeep > 0 ? `Daily backups, keeping ${h.backupKeep}` : 'Daily backups are off', key: 'backups' },
      { ok: !!h?.offsite && !off?.lastError, text: !h?.offsite ? 'Backups stay on this server only (set up off-site copies)' : off?.lastError && (off.lastErrorAt ?? 0) > (off.lastOk ?? 0) ? `Off-site copy failed: ${off.lastError}` : 'Backups are copied off-site', key: 'offsite' },
      { ok: !!ctx.hosting?.heartbeatUrl, text: ctx.hosting?.heartbeatUrl ? 'An uptime monitor hears from this server' : 'No uptime monitor (see Uptime alerts in the README)', key: 'uptime' },
      { ok: !unclaimed.length, text: `ADMIN_USERS names ${unclaimed.join(', ')}, which no account has yet: whoever signs up with it first becomes an admin`, key: 'admins', hidden: !unclaimed.length },
      { ok: !!updater?.running, text: updater?.running ? 'Updates can be installed from here' : 'Updating needs SSH (the updater is off)', key: 'updater' },
    ].filter((c) => !c.hidden);
  };

  route('GET', '/api/admin', admin(async ({ secure }) => {
    const users = (db.prepare(`
      SELECT u.id, u.username, u.display_name AS displayName, u.created_at AS createdAt, u.bot,
             (SELECT MAX(COALESCE(s.last_used_at, s.created_at)) FROM sessions s WHERE s.user_id = u.id) AS lastSeen,
             (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id) AS devices,
             (SELECT COALESCE(SUM(size), 0) FROM attachments a WHERE a.uploader_id = u.id) AS storage,
             (SELECT COUNT(*) FROM messages m WHERE m.author_id = u.id) AS messages,
             u.totp_secret IS NOT NULL AS twoStep
      FROM users u WHERE u.deleted_at IS NULL ORDER BY u.bot, u.username COLLATE NOCASE`).all() as Json[])
      .map((u) => ({ ...u, bot: !!u.bot, twoStep: !!u.twoStep, online: ctx.online.has(u.id as number), admin: isAdmin(u.id as number) }));
    // Who's in voice right now, by room.
    const voice = new Map<number, number[]>();
    for (const [userId, channelId] of ctx.inVoice) voice.set(channelId, [...(voice.get(channelId) ?? []), userId]);
    const fires = [...voice].map(([channelId, ids]) => {
      const c = db.prepare('SELECT c.name, s.name AS burrow, s.kind FROM channels c JOIN servers s ON s.id = c.server_id WHERE c.id = ?').get(channelId) as Json | undefined;
      const names = ids.map((id) => (db.prepare('SELECT COALESCE(display_name, username) AS n FROM users WHERE id = ?').get(id) as { n: string } | undefined)?.n ?? '?');
      return { room: c?.kind === 'dm' ? 'A call' : c?.name ?? '?', burrow: c?.kind === 'dm' ? 'Direct messages' : c?.burrow ?? '?', people: names };
    });
    const h = ctx.hosting;
    const disk = h ? await statfs(h.dataDir).catch(() => null) : null;
    const counts = db.prepare(`SELECT (SELECT COUNT(*) FROM servers WHERE kind = 'burrow') AS burrows, (SELECT COUNT(*) FROM messages) AS messages,
                                 (SELECT COUNT(*) FROM attachments WHERE message_id IS NOT NULL) AS files`).get() as Json;
    return {
      startedAt,
      users,
      voice: fires,
      counts,
      storage: {
        database: h ? fileSize(h.dbFile) + fileSize(h.dbFile + '-wal') : null,
        uploads: ctx.uploadDir ? dirSize(ctx.uploadDir) : 0,
        backups: h ? dirSize(h.backupDir) : null,
        free: disk ? disk.bavail * disk.bsize : null,
        total: disk ? disk.blocks * disk.bsize : null,
      },
      backups: await backupInfo(),
      signup: { mode: signupMode(), codeSet: !!ctx.registrationCode, links: signupLinks() },
      updater: updaterStatus(),
      errors: (db.prepare('SELECT COUNT(*) AS n FROM client_errors').get() as { n: number }).n,
      checks: checks(secure),
    };
  }));

  // ---- uptime

  route('GET', '/api/health', () => {
    db.prepare('SELECT 1').get();
    return { ok: true, uptime: Math.round((now() - startedAt) / 1000) };
  }, false);
  const beat = ctx.hosting?.heartbeatUrl;
  if (beat) {
    const ping = () => fetch(beat, { signal: AbortSignal.timeout(10_000) }).catch((err) => console.warn(`Heartbeat failed: ${err.message}`));
    setTimeout(ping, 30_000).unref();
    setInterval(ping, 5 * 60_000).unref();
  }

  return { isAdmin, signupMode, checkSignup, useSignupLink, cleanUpStorage };
}
