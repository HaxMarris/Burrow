// Copies the shared web client into this app so it ships inside the phone app.
const { cpSync, rmSync } = require('node:fs');
const { join } = require('node:path');

const from = join(__dirname, '..', '..', 'client');
const to = join(__dirname, '..', 'app');
rmSync(to, { recursive: true, force: true });
// The service worker and install manifest are for the web; the phone app has its own copy of everything.
cpSync(from, to, { recursive: true, filter: (src) => !/[\\/](sw\.js|manifest\.webmanifest)$/.test(src) });
console.log(`Copied client from ${from} to ${to}`);
