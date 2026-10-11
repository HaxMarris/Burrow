import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.ts';
import { createApp } from './app.ts';
import { finishRestore, scheduleBackups } from './backup.ts';
import { s3FromEnv } from './s3.ts';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 3000);
const dbFile = process.env.DB_FILE ?? resolve(here, '../data/chat.db');

// A backup chosen to restore (on the admin page, or with restore.ts) replaces the database now.
const replaced = finishRestore(dbFile);
if (replaced) console.log(`Restored a backup. The database it replaced is kept as ${replaced}.`);

const db = openDb(dbFile);
const backupDir = process.env.BACKUP_DIR ?? join(dirname(dbFile), 'backups');
const backupKeep = Number(process.env.BACKUP_KEEP ?? 7);
const uploadDir = process.env.UPLOAD_DIR ?? join(dirname(dbFile), 'uploads');
const offsite = s3FromEnv();
if (backupKeep > 0) scheduleBackups(db, backupDir, backupKeep, offsite ? { cfg: offsite, uploadDir } : undefined);

const app = createApp({
  db,
  publicDir: resolve(process.env.PUBLIC_DIR ?? resolve(here, '../../client')),
  registrationCode: process.env.REGISTRATION_CODE || undefined,
  uploadDir,
  hosting: {
    dbFile,
    backupDir,
    backupKeep,
    offsite: offsite ?? undefined,
    // The updater (see docker-compose.yml) and Burrow talk through files in the data folder.
    dataDir: dirname(dbFile),
    admins: (process.env.ADMIN_USERS ?? '').split(',').map((n) => n.trim()).filter(Boolean),
    heartbeatUrl: process.env.HEARTBEAT_URL || undefined,
  },
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB ?? 25) * 1024 * 1024,
  mail: process.env.SMTP_URL ? { url: process.env.SMTP_URL, from: process.env.MAIL_FROM || `Peiskos <${decodeURIComponent(new URL(process.env.SMTP_URL).username).includes('@') ? decodeURIComponent(new URL(process.env.SMTP_URL).username) : 'burrow@localhost'}>` } : undefined,
  publicUrl: process.env.PUBLIC_URL || undefined,
  pushContact: process.env.PUSH_CONTACT || undefined,
  gifs: process.env.KLIPY_API_KEY ? { apiKey: process.env.KLIPY_API_KEY, rating: process.env.GIF_RATING || undefined } : undefined,
  voice:
    process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET
      ? {
          apiKey: process.env.LIVEKIT_API_KEY,
          apiSecret: process.env.LIVEKIT_API_SECRET,
          url: process.env.LIVEKIT_URL || undefined,
          apiUrl: process.env.LIVEKIT_API_URL || 'http://localhost:7880',
        }
      : undefined,
});

app.listen(port, () => {
  console.log(`Chat server listening on http://localhost:${port}`);
  console.log(`Database: ${dbFile}`);
  console.log(backupKeep > 0 ? `Daily backups: ${backupDir} (keeping ${backupKeep})` : 'Daily backups are off.');
  if (backupKeep > 0) console.log(offsite ? `Off-site copies: ${offsite.bucket}` : 'Off-site copies are off (set the BACKUP_S3_ settings to turn them on).');
  if (!process.env.REGISTRATION_CODE)
    console.log('Warning: REGISTRATION_CODE is not set, so anyone who can reach this server can sign up.');
  if (!process.env.KLIPY_API_KEY) console.log('The GIF picker is off (set KLIPY_API_KEY to turn it on).');
  if (!process.env.SMTP_URL) console.log("Email is off, so people can't reset a forgotten password themselves (set SMTP_URL to turn it on).");
  if (!process.env.LIVEKIT_API_KEY) console.log('Voice rooms are off (set LIVEKIT_API_KEY and LIVEKIT_API_SECRET to turn them on).');
});
