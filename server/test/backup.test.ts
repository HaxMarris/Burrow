import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.ts';
import { backupNow } from '../src/backup.ts';

test('daily backups are readable copies and only the newest are kept', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'burrow-backup-'));
  const db = openDb(join(dir, 'chat.db'));
  db.prepare("INSERT INTO users (username, password_hash, created_at) VALUES ('max', 'x', 0)").run();
  const backups = join(dir, 'backups');

  for (let day = 1; day <= 5; day++) await backupNow(db, backups, 3, new Date(Date.UTC(2026, 9, day)));
  assert.deepEqual(readdirSync(backups), ['burrow-2026-10-03.db', 'burrow-2026-10-04.db', 'burrow-2026-10-05.db']);

  // A second run on the same day leaves the existing copy alone.
  await backupNow(db, backups, 3, new Date(Date.UTC(2026, 9, 5)));
  assert.equal(readdirSync(backups).length, 3);

  const copy = new DatabaseSync(join(backups, 'burrow-2026-10-05.db'), { readOnly: true });
  assert.equal((copy.prepare('SELECT username FROM users').get() as { username: string }).username, 'max');
  copy.close();
  db.close();
});
