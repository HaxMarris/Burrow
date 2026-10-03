// Copies the shared web client into this app so it ships inside the installer.
const { cpSync, rmSync } = require('node:fs');
const { join } = require('node:path');

const from = join(__dirname, '..', '..', 'client');
const to = join(__dirname, '..', 'app');
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
console.log(`Copied client from ${from} to ${to}`);
