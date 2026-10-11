// Makes a one-hour password reset link for someone locked out of their account.
// Run it where the server runs:
//   docker compose exec burrow node --no-warnings server/src/reset-link.ts <username> [--two-step-off]
// --two-step-off also turns off their two-step login, for when they lost their phone and recovery codes.
import { createHash, randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.ts';

const args = process.argv.slice(2);
const username = args.find((a) => !a.startsWith('--'));
if (!username) {
  console.log('Usage: node server/src/reset-link.ts <username> [--two-step-off]');
  process.exit(1);
}
const here = dirname(fileURLToPath(import.meta.url));
const db = openDb(process.env.DB_FILE ?? resolve(here, '../data/chat.db'));
const user = db.prepare('SELECT id, username FROM users WHERE username = ? AND deleted_at IS NULL').get(username) as { id: number; username: string } | undefined;
if (!user) {
  console.log(`Nobody is called ${username} here.`);
  process.exit(1);
}
const token = randomBytes(24).toString('base64url');
db.prepare('UPDATE users SET reset_link = ?, reset_link_expires = ? WHERE id = ?').run(
  createHash('sha256').update(token).digest('hex'), Date.now() + 60 * 60 * 1000, user.id,
);
if (args.includes('--two-step-off')) {
  db.prepare("UPDATE users SET totp_secret = NULL, totp_pending = NULL, recovery_codes = '[]' WHERE id = ?").run(user.id);
  console.log(`Two-step login is off for ${user.username}. They can turn it back on in their account.`);
}
const base = (process.env.PUBLIC_URL || 'https://your-burrow-address').replace(/\/$/, '');
console.log(`Send this to ${user.username}. It works once, for the next hour:\n\n  ${base}/?reset=${token}\n`);
