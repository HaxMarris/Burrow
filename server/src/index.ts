import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.ts';
import { createApp } from './app.ts';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 3000);
const dbFile = process.env.DB_FILE ?? resolve(here, '../data/chat.db');

const app = createApp({
  db: openDb(dbFile),
  publicDir: resolve(process.env.PUBLIC_DIR ?? resolve(here, '../../client')),
  registrationCode: process.env.REGISTRATION_CODE || undefined,
  uploadDir: process.env.UPLOAD_DIR ?? join(dirname(dbFile), 'uploads'),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB ?? 25) * 1024 * 1024,
  voice:
    process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET
      ? {
          apiKey: process.env.LIVEKIT_API_KEY,
          apiSecret: process.env.LIVEKIT_API_SECRET,
          url: process.env.LIVEKIT_URL || undefined,
        }
      : undefined,
});

app.listen(port, () => {
  console.log(`Chat server listening on http://localhost:${port}`);
  console.log(`Database: ${dbFile}`);
  if (!process.env.REGISTRATION_CODE)
    console.log('Warning: REGISTRATION_CODE is not set, so anyone who can reach this server can sign up.');
  if (!process.env.LIVEKIT_API_KEY) console.log('Voice rooms are off (set LIVEKIT_API_KEY and LIVEKIT_API_SECRET to turn them on).');
});
