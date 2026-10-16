import { backup, type DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, rmSync, existsSync, statSync, readFileSync, writeFileSync, renameSync, copyFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { putFile, listFiles, type S3Config } from './s3.ts';

const NAME = /^burrow-(\d{4}-\d{2}-\d{2})\.db$/;

/** Copies the database to `dir/burrow-YYYY-MM-DD.db` once a day and keeps the newest `keep` copies. */
export async function backupNow(db: DatabaseSync, dir: string, keep: number, today = new Date(), force = false) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `burrow-${today.toISOString().slice(0, 10)}.db`);
  if (force) rmSync(file, { force: true });
  if (!existsSync(file)) {
    // Copied under another name first: a copy cut off halfway (a restart, a crash) is never taken
    // for that day's backup, and the next run starts it again.
    const part = `${file}.part`;
    for (const f of [part, `${part}-journal`]) rmSync(f, { force: true });
    await backup(db, part);
    renameSync(part, file);
  }
  const copies = readdirSync(dir).filter((f) => NAME.test(f)).sort();
  for (const old of copies.slice(0, Math.max(0, copies.length - keep))) rmSync(join(dir, old));
  return file;
}

/** The backups kept on this machine, newest first. */
export function localBackups(dir: string) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => NAME.test(f))
    .sort()
    .reverse()
    .map((name) => {
      const info = statSync(join(dir, name));
      return { name, size: info.size, at: info.mtimeMs };
    });
}

// ---- off-site copies

export type OffsiteStatus = { lastOk: number | null; lastError: string | null; lastErrorAt: number | null; files: number };

/**
 * Copies the newest database backup, and any uploads not copied yet, to an S3 bucket. Nothing is
 * ever deleted there (set the bucket to delete old versions if you like). What has been copied is
 * remembered in `dir/offsite.json`.
 */
export async function copyOffsite(cfg: S3Config, dir: string, uploadDir: string | undefined, latest: string) {
  const stateFile = join(dir, 'offsite.json');
  let state: { sent: Record<string, number>; status?: OffsiteStatus } = { sent: {} };
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch {}
  const save = () => writeFileSync(stateFile, JSON.stringify(state));
  const status: OffsiteStatus = state.status ?? { lastOk: null, lastError: null, lastErrorAt: null, files: 0 };
  try {
    await putFile(cfg, `db/${latest.split(sep).pop()}`, latest);
    if (uploadDir && existsSync(uploadDir)) {
      for (const file of walk(uploadDir)) {
        const name = relative(uploadDir, file).split(sep).join('/');
        const size = statSync(file).size;
        if (state.sent[name] === size) continue;
        await putFile(cfg, `uploads/${name}`, file);
        state.sent[name] = size;
        // Saved as it goes, so a big first copy picks up where it stopped.
        if (Object.keys(state.sent).length % 50 === 0) save();
      }
    }
    Object.assign(status, { lastOk: Date.now(), files: Object.keys(state.sent).length });
  } catch (err) {
    Object.assign(status, { lastError: err instanceof Error ? err.message : String(err), lastErrorAt: Date.now() });
    throw err;
  } finally {
    state.status = status;
    save();
  }
}

export function offsiteStatus(dir: string): OffsiteStatus | null {
  try { return JSON.parse(readFileSync(join(dir, 'offsite.json'), 'utf8')).status ?? null; } catch { return null; }
}

/** The database copies in the bucket, newest first. */
export async function offsiteBackups(cfg: S3Config) {
  return (await listFiles(cfg, 'db/')).filter((f) => NAME.test(f.name.slice(3))).sort((a, b) => b.name.localeCompare(a.name));
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

export function scheduleBackups(db: DatabaseSync, dir: string, keep: number, offsite?: { cfg: S3Config; uploadDir?: string }) {
  let lastOffsite = '';
  const run = async () => {
    try {
      const file = await backupNow(db, dir, keep);
      // Off-site once a day, after that day's backup.
      // Only marked done once it worked, so a failed copy is tried again on the next hourly run.
      if (offsite && lastOffsite !== file) {
        await copyOffsite(offsite.cfg, dir, offsite.uploadDir, file);
        lastOffsite = file;
      }
    } catch (err) {
      console.error('Backup failed:', err instanceof Error ? err.message : err);
    }
  };
  setTimeout(run, 60_000).unref();
  setInterval(run, 60 * 60_000).unref();
}

// ---- restoring

/** Where a backup waits to replace the database the next time Burrow starts. */
export const pendingRestore = (dbFile: string) => `${dbFile}.restore`;

/** Puts a backup in place to be restored on the next start. */
export function queueRestore(dbFile: string, backupFile: string) {
  copyFileSync(backupFile, pendingRestore(dbFile) + '.part');
  renameSync(pendingRestore(dbFile) + '.part', pendingRestore(dbFile));
}

/**
 * Called before the database opens: swaps in a backup waiting to be restored. The database it
 * replaces is kept next to it as chat.db.before-restore-<time>, in case it's wanted back.
 */
export function finishRestore(dbFile: string) {
  const waiting = pendingRestore(dbFile);
  if (!existsSync(waiting)) return null;
  const kept = `${dbFile}.before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  if (existsSync(dbFile)) renameSync(dbFile, kept);
  // Its write-ahead log goes with it, so the kept copy has everything.
  if (existsSync(dbFile + '-wal')) renameSync(dbFile + '-wal', kept + '-wal');
  rmSync(dbFile + '-shm', { force: true });
  renameSync(waiting, dbFile);
  return kept;
}
