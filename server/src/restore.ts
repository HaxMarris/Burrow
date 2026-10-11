// Puts Burrow back the way it was on an earlier day, from a backup. Run it where the server runs:
//
//   docker compose exec burrow node --no-warnings server/src/restore.ts            lists the backups
//   docker compose exec burrow node --no-warnings server/src/restore.ts 2026-10-09 restores that day's
//   docker compose restart burrow                                                  finishes it
//
// The backup is picked up the next time Burrow starts; the database it replaces is kept next to
// it (chat.db.before-restore-…). Off-site copies (BACKUP_S3_…) are listed too and downloaded
// first. On a brand new server, --uploads also brings back every uploaded file from off-site.
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { localBackups, offsiteBackups, queueRestore } from './backup.ts';
import { getFile, listFiles, s3FromEnv } from './s3.ts';

const here = dirname(fileURLToPath(import.meta.url));
const dbFile = process.env.DB_FILE ?? resolve(here, '../data/chat.db');
const backupDir = process.env.BACKUP_DIR ?? join(dirname(dbFile), 'backups');
const uploadDir = process.env.UPLOAD_DIR ?? join(dirname(dbFile), 'uploads');
const cfg = s3FromEnv();
const args = process.argv.slice(2);
const day = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;

const local = localBackups(backupDir);
const remote = cfg ? await offsiteBackups(cfg).catch((err) => { console.log(`Couldn't list the off-site backups: ${err.message}`); return []; }) : [];

if (!day) {
  console.log(local.length ? 'Backups on this machine:' : 'No backups on this machine yet.');
  for (const b of local) console.log(`  ${b.name.slice(7, 17)}  ${mb(b.size)}`);
  if (cfg) {
    console.log(remote.length ? '\nOff-site backups:' : '\nNo off-site backups yet.');
    for (const b of remote) console.log(`  ${b.name.slice(10, 20)}  ${mb(b.size)}`);
  }
  console.log('\nRestore one with:  node --no-warnings server/src/restore.ts YYYY-MM-DD   (then restart Burrow)');
  process.exit(0);
}

const name = `burrow-${day}.db`;
let source = local.find((b) => b.name === name) ? join(backupDir, name) : null;
if (!source && remote.some((b) => b.name === `db/${name}`)) {
  mkdirSync(backupDir, { recursive: true });
  source = join(backupDir, `offsite-${name}`);
  console.log(`Downloading ${name} from off-site…`);
  await getFile(cfg!, `db/${name}`, source);
}
if (!source) {
  console.log(`There's no backup from ${day}. Run this without a date to see the ones there are.`);
  process.exit(1);
}

if (args.includes('--uploads')) {
  if (!cfg) {
    console.log('--uploads needs the BACKUP_S3_ settings.');
    process.exit(1);
  }
  let fetched = 0;
  for (const f of await listFiles(cfg, 'uploads/')) {
    const to = join(uploadDir, f.name.slice('uploads/'.length));
    if (existsSync(to) && statSync(to).size === f.size) continue;
    mkdirSync(dirname(to), { recursive: true });
    await getFile(cfg, f.name, to);
    fetched++;
  }
  console.log(`Brought back ${fetched} uploaded file${fetched === 1 ? '' : 's'}.`);
}

queueRestore(dbFile, source);
console.log(`Ready: Burrow goes back to ${day} the next time it starts. Restart it now with:\n\n  docker compose restart burrow\n`);
