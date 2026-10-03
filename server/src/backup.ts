import { backup, type DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const NAME = /^burrow-(\d{4}-\d{2}-\d{2})\.db$/;

/** Copies the database to `dir/burrow-YYYY-MM-DD.db` once a day and keeps the newest `keep` copies. */
export async function backupNow(db: DatabaseSync, dir: string, keep: number, today = new Date()) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `burrow-${today.toISOString().slice(0, 10)}.db`);
  if (!existsSync(file)) await backup(db, file);
  const copies = readdirSync(dir).filter((f) => NAME.test(f)).sort();
  for (const old of copies.slice(0, Math.max(0, copies.length - keep))) rmSync(join(dir, old));
  return file;
}

export function scheduleBackups(db: DatabaseSync, dir: string, keep: number) {
  const run = () =>
    backupNow(db, dir, keep).catch((err) => console.error('Backup failed:', err instanceof Error ? err.message : err));
  setTimeout(run, 60_000).unref();
  setInterval(run, 60 * 60_000).unref();
}
