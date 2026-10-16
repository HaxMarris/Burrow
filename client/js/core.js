// Chat client. Runs as the web app served by the chat server, inside the desktop app (loaded
// from file://) and inside the Android and iPhone apps (from the app's own files). The apps
// connect to peiskos.app unless told otherwise.
//
// State, talking to the server, logging in, starting up, and the live connection.
// Part of Burrow's client: plain scripts that index.html loads in order, sharing one global scope.
'use strict';

const $ = (sel) => document.querySelector(sel);
const isDesktop = location.protocol === 'file:';
// The Android and iPhone apps carry their own copy of this page too, so like the desktop app
// they talk to a server somewhere else.
const isPhoneApp = !!window.Capacitor?.isNativePlatform?.();
const isApp = isDesktop || isPhoneApp;

// Crashes in the app are sent to the server (a few per visit), where whoever runs it sees them
// on the admin page. Just the error and where it happened; nothing you typed.
let errorsSent = 0;
function reportError(error, where) {
  let base = '';
  try { base = state.serverUrl; } catch {} // not set up yet
  if (errorsSent >= 5 || !base) return;
  const message = String(error?.message ?? error ?? '').slice(0, 500);
  if (!message || /ResizeObserver loop|Script error\.?$/.test(message)) return; // harmless browser noise
  errorsSent++;
  fetch(base + '/api/errors', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(state.token ? { authorization: 'Bearer ' + state.token } : {}) },
    body: JSON.stringify({ message, stack: String(error?.stack ?? '').slice(0, 4000), where, app: `${isDesktop ? 'Desktop app' : isPhoneApp ? 'Phone app' : 'Web'} · ${navigator.userAgent}` }),
  }).catch(() => {});
}
window.addEventListener('error', (e) => reportError(e.error ?? e.message, `${e.filename?.split('/').pop() ?? ''}:${e.lineno ?? ''}`));
window.addEventListener('unhandledrejection', (e) => {
  // Failed requests already show their own message, and a dropped connection isn't a crash.
  if (e.reason instanceof TypeError && /fetch|network/i.test(e.reason.message)) return;
  if (e.reason?.handled) return;
  reportError(e.reason, 'promise');
});

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

// The desktop and phone apps connect to Peiskos's own server without asking; "Use a different server" on
// the login screen picks another. Logins saved under the server's old address move to the new one.
const DEFAULT_SERVER = 'https://peiskos.app';
const OLD_ADDRESS = 'https://newburrow.duckdns.org';
if (isApp) {
  if (store.get('serverUrl') === OLD_ADDRESS) store.set('serverUrl', DEFAULT_SERVER);
  const saved = store.get('accounts');
  if (saved?.includes(OLD_ADDRESS)) store.set('accounts', saved.replaceAll(`"${OLD_ADDRESS}"`, `"${DEFAULT_SERVER}"`));
}

const state = {
  serverUrl: isApp ? store.get('serverUrl') || DEFAULT_SERVER : location.origin,
  token: store.get('token'),
  me: null,
  servers: new Map(),       // id -> { id, name, kind, ownerId, inviteCode, channels, members }; DMs are kind 'dm'
  serverOrder: [],          // burrow ids, in the order they're shown
  favorites: [],            // up to 5 burrow ids kept in the top bar, in order
  folders: [],              // your own folders of burrows: { id, name, serverIds }
  pendingInvite: null,      // an invite link this page was opened with, shown once you're in
  dmOrder: [],              // direct message conversation ids, most recent first
  inDms: false,             // showing direct messages instead of a burrow
  serverId: Number(store.get('lastServer')) || null,
  channelId: null,
  lastChannel: JSON.parse(store.get('lastChannel') || '{}'), // serverId -> channelId
  messages: [],             // messages in the open channel, oldest first
  reachedStart: false,
  reachedEnd: true,         // the newest message is loaded (false after jumping back to an old one)
  loadingOlder: false,
  loadingNewer: false,
  newFrom: null,            // the "New" line goes after this message id (where you'd read up to when you opened the room)
  unreadAtOpen: null,       // { count, mentions } unread when you opened the room, for the bar at the top
  holdUnread: null,         // a room you marked unread: it stays unread while you're still in it
  threadParent: null,       // the message an open thread started from
  saved: new Map(),         // message id -> { savedAt, remindAt, reminded }: your saved messages
  scheduled: [],            // your messages waiting to be sent
  typing: new Map(),        // channelId -> Map(username -> timer)
  ws: null,
  wsRetry: 0,
  voiceEnabled: false,      // the server has LiveKit set up
  maxUploadBytes: 0,        // 0 = uploads are off on this server
  gifsEnabled: false,       // the server has a KLIPY key for the GIF picker
  replyTo: null,            // the message the composer is replying to
  pending: [],              // files attached to the composer: { file, previewUrl, progress, attachment, error, done }
  voice: null,              // { channelId, room, muted } while in a voice room
  rejoin: null,             // { channelId, muted, deafened, tries, timer } while getting back into voice
  speaking: new Set(),      // user ids talking right now in our voice room
  mutedInVoice: new Set(),  // user ids muted in our voice room
  sharing: new Map(),       // user id -> { camera, screen } in our voice room
  stageOpen: false,         // showing the Campfire (or its video) instead of the chat
  stageShow: 'fire',        // 'fire': everyone around the fire; 'video': the video grid
  fireside: { channelId: null, messages: [], unread: 0 }, // the voice room's own chat, while you're in it
  firesideOpen: false,      // on narrow screens the fireside chat opens over the fire
  avatars: new Map(),       // user id -> profile picture path (or null), kept current by user_updated events
};

// ---------------------------------------------------------------- API

async function api(path, { method = 'GET', body } = {}, retried = false) {
  const res = await fetch(state.serverUrl + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(state.token ? { authorization: 'Bearer ' + state.token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.redirected) adoptOrigin(res.url);
  if (res.redirected && res.status === 401 && !retried) return api(path, { method, body }, true);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token && path !== '/api/login') logout(false);
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// The server can move us, usually from http:// to https:// behind Caddy. Browsers drop
// the login header on that hop and refuse it entirely for JSON requests, so follow it
// once with a plain request and remember where we landed.
function adoptOrigin(url) {
  const origin = new URL(url).origin;
  if (!state.serverUrl || origin === new URL(state.serverUrl).origin) return;
  state.serverUrl = origin;
  if (isApp) store.set('serverUrl', origin);
}

async function resolveServerUrl() {
  if (!isApp || !state.serverUrl) return;
  try {
    const res = await fetch(state.serverUrl + '/api/config');
    if (res.redirected) adoptOrigin(res.url);
  } catch {}
}

// ---------------------------------------------------------------- auth screen

// A signup link from whoever runs the server: /?signup=… opens the register form, no code needed.
let signupLink = isApp ? null : new URLSearchParams(location.search).get('signup');
let registering = !!signupLink;

async function showAuth() {
  $('#app').classList.add('hidden');
  $('#auth').classList.remove('hidden');
  const otherServer = isApp && state.serverUrl !== DEFAULT_SERVER;
  $('#server-url-row').classList.toggle('hidden', !otherServer);
  $('#other-server-row').classList.toggle('hidden', !isApp || otherServer);
  $('#server-url').value = state.serverUrl;
  if (!isApp && !/Android|iPhone|iPad/.test(navigator.userAgent)) showDesktopDownloads();
  if (!isApp && /Android/.test(navigator.userAgent)) showAndroidDownload();
  renderAuthMode();
  showAuthInvite();
  showAccountsOnLogin();
  if (resetLinkToken && !isApp) showResetLink();
}

// Download buttons for the desktop app, on the web only. They open the latest release page,
// and point straight at each installer once GitHub says what the files are called.
let desktopLinksLoaded = false;
function showDesktopDownloads() {
  const box = $('#get-desktop');
  box.classList.remove('hidden');
  const ua = navigator.userAgent;
  const mine = /Windows/.test(ua) ? 'win' : /Mac/.test(ua) && !/iPhone|iPad/.test(ua) && navigator.maxTouchPoints < 2 ? 'mac'
    : /Linux/.test(ua) && !/Android/.test(ua) ? 'linux' : null;
  for (const a of box.querySelectorAll('a[data-os]')) a.classList.toggle('mine', a.dataset.os === mine);
  if (desktopLinksLoaded) return;
  desktopLinksLoaded = true;
  fetch('https://api.github.com/repos/HaxMarris/Burrow/releases/latest')
    .then((r) => (r.ok ? r.json() : null))
    .then((release) => {
      // Macs: Apple chips (M1 and later) by default, and a separate build for older Intel Macs.
      const ends = { win: '.exe', mac: '-arm64.dmg', intel: '-x64.dmg', linux: '.AppImage' };
      const find = (os) => release?.assets?.find((f) => f.name.endsWith(ends[os])) ?? (os === 'mac' ? release?.assets?.find((f) => f.name.endsWith('.dmg')) : null);
      for (const a of box.querySelectorAll('a[data-os]')) {
        const file = find(a.dataset.os);
        if (file) a.href = file.browser_download_url;
      }
      const intel = find('intel');
      $('#get-intel-mac').classList.toggle('hidden', !intel || mine !== 'mac');
      if (intel) $('#get-intel-mac a').href = intel.browser_download_url;
    })
    .catch(() => {});
}

// On an Android phone, the Android app instead, once a release has one.
let androidLinkLoaded = false;
function showAndroidDownload() {
  if (androidLinkLoaded) return;
  androidLinkLoaded = true;
  fetch('https://api.github.com/repos/HaxMarris/Burrow/releases/latest')
    .then((r) => (r.ok ? r.json() : null))
    .then((release) => {
      const apk = release?.assets?.find((f) => f.name.endsWith('.apk'));
      if (!apk) return;
      $('#get-android a').href = apk.browser_download_url;
      $('#get-android').classList.remove('hidden');
    })
    .catch(() => {});
}

async function renderAuthMode() {
  $('#auth-title').textContent = registering ? 'Dig in' : 'Welcome back';
  $('#auth-subtitle').textContent = registering ? 'Pick a username your friends will see.' : 'Log in to chat with your friends.';
  $('#auth-submit').textContent = registering ? 'Create account' : 'Log in';
  $('#auth-toggle').textContent = registering ? 'Already have an account? Log in' : 'Need an account? Register';
  $('#password').autocomplete = registering ? 'new-password' : 'current-password';
  $('#auth-error').textContent = '';
  let needsCode = false;
  let linksOnly = false;
  let canEmail = false;
  if (state.serverUrl) {
    try {
      const config = await api('/api/config');
      canEmail = !!config.email;
      if (registering && !signupLink) ({ registrationCodeRequired: needsCode, signupLinksOnly: linksOnly } = config);
    } catch {}
  }
  // A signup link can be pasted here too (the desktop app can't be opened by one).
  $('#reg-code-row').classList.toggle('hidden', !needsCode && !linksOnly);
  $('#reg-code').placeholder = linksOnly ? 'Paste your signup link' : 'Ask whoever runs the server, or paste a signup link';
  if (registering && signupLink) $('#auth-subtitle').textContent = "You've been invited. Pick a username your friends will see.";
  if (linksOnly) $('#auth-subtitle').textContent = 'Signing up here needs a signup link from whoever runs this Peiskos.';
  // Where the server can send email: an address when signing up, and "Forgot your password?" when logging in.
  $('#email-row').classList.toggle('hidden', !registering || !canEmail);
  $('#signup-email').required = registering && canEmail;
  $('#forgot-row').classList.toggle('hidden', registering || !canEmail);
  $('#passkey-login').classList.toggle('hidden', registering || !passkeysWork());
  renderLegalRow();
}

// The privacy policy and terms live on the server (they name whoever runs it), so app stores and
// people signing up can read them.
const legalUrl = (page) => `${state.serverUrl.replace(/\/$/, '')}/${page}`;
function renderLegalRow() {
  const row = $('#legal-row');
  row.classList.toggle('hidden', !state.serverUrl);
  if (!state.serverUrl) return;
  const href = (page) => legalUrl(page).replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);
  const link = (page, text) => `<a href="${href(page)}" target="_blank" rel="noopener">${text}</a>`;
  row.innerHTML = registering
    ? `By creating an account you agree to the ${link('terms', 'Terms')} and ${link('privacy', 'Privacy policy')}, and confirm you're 13 or older.`
    : `${link('privacy', 'Privacy policy')} · ${link('terms', 'Terms')}`;
}

// ---- forgot your password: a code to your confirmed email, then a new password

let resetSent = false;
function showReset(on) {
  showAuthCard(on ? 'reset-form' : 'auth-form');
  resetSent = false;
  $('#reset-step2').classList.add('hidden');
  $('#reset-resend').classList.add('hidden');
  $('#reset-submit').textContent = 'Email me a code';
  $('#reset-subtitle').textContent = 'Peiskos emails a code to the address you confirmed in your account settings.';
  $('#reset-error').textContent = '';
  if (on) {
    $('#reset-username').value = $('#username').value.trim();
    ($('#reset-username').value ? $('#reset-submit') : $('#reset-username')).focus();
  }
}
$('#forgot-link').addEventListener('click', (e) => { e.preventDefault(); showReset(true); });
$('#reset-back').addEventListener('click', (e) => { e.preventDefault(); showReset(false); });
async function sendResetCode() {
  const { minutes } = await api('/api/password/forgot', { method: 'POST', body: { username: $('#reset-username').value.trim() } });
  resetSent = true;
  $('#reset-step2').classList.remove('hidden');
  $('#reset-resend').classList.remove('hidden');
  $('#reset-submit').textContent = 'Set new password';
  $('#reset-subtitle').textContent = `If that account has a confirmed email, a code is on its way. It works for ${minutes} minutes. Check your spam folder too.`;
  $('#reset-code').focus();
}
$('#reset-resend').addEventListener('click', async (e) => {
  e.preventDefault();
  try { await sendResetCode(); $('#reset-error').textContent = ''; } catch (err) { $('#reset-error').textContent = err.message; }
});
$('#reset-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#reset-error').textContent = '';
  $('#reset-submit').disabled = true;
  try {
    if (!resetSent) return await sendResetCode();
    const result = await api('/api/password/reset', {
      method: 'POST',
      body: { username: $('#reset-username').value.trim(), code: $('#reset-code').value.trim(), newPassword: $('#reset-password').value },
    });
    $('#reset-code').value = $('#reset-password').value = '';
    showReset(false);
    if (await finishLogin(result)) toast('Password changed. Your other devices were logged out.');
  } catch (err) {
    $('#reset-error').textContent = err.message === 'Failed to fetch' ? "Couldn't reach that server." : err.message;
  } finally {
    $('#reset-submit').disabled = false;
  }
});

$('#auth-toggle').addEventListener('click', (e) => {
  e.preventDefault();
  registering = !registering;
  renderAuthMode();
});

$('#other-server').addEventListener('click', (e) => {
  e.preventDefault();
  $('#other-server-row').classList.add('hidden');
  $('#server-url-row').classList.remove('hidden');
  $('#server-url').select();
  $('#server-url').focus();
});

$('#server-url').addEventListener('change', () => {
  state.serverUrl = normalizeServerUrl($('#server-url').value);
  renderAuthMode();
});

// Typed without http:// or https://? Public names get https://; local addresses
// (localhost, an IP, a .local name, or anything with a :port) get http://.
function normalizeServerUrl(v) {
  v = v.trim().replace(/\/+$/, '');
  if (!v || /^https?:\/\//i.test(v)) return v;
  const host = v.split('/')[0];
  const local = /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?$/i.test(host) || /\.local(:\d+)?$/i.test(host) || /:\d+$/.test(host);
  return (local ? 'http://' : 'https://') + v;
}

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (isApp) state.serverUrl = normalizeServerUrl($('#server-url').value) || DEFAULT_SERVER;
  $('#auth-submit').disabled = true;
  try {
    await resolveServerUrl();
    const body = { username: $('#username').value.trim(), password: $('#password').value };
    if (registering) body.registrationCode = $('#reg-code').value.trim();
    if (registering && !$('#email-row').classList.contains('hidden')) body.email = $('#signup-email').value.trim();
    const pasted = /[?&]signup=([\w-]+)/.exec(body.registrationCode ?? '')?.[1];
    if (registering && (signupLink || pasted)) body.signupLink = signupLink || pasted;
    const result = await api(registering ? '/api/register' : '/api/login', { method: 'POST', body });
    $('#password').value = '';
    if (registering && signupLink) { signupLink = null; history.replaceState(null, '', location.pathname); }
    await finishLogin(result);
  } catch (err) {
    $('#auth-error').textContent = err.message === 'Failed to fetch' ? "Couldn't reach that server." : err.message;
  } finally {
    $('#auth-submit').disabled = false;
  }
});

// A login that passed: straight in, or on to the code from their authenticator app first.
// Returns true once they're in.
let twoStepTicket = null;
async function finishLogin(result) {
  if (result.twoStep) {
    twoStepTicket = result.ticket;
    showAuthCard('two-step-form');
    $('#two-step-code').value = '';
    $('#two-step-error').textContent = '';
    $('#two-step-code').focus();
    return false;
  }
  state.token = result.token;
  state.me = result.user;
  store.set('token', result.token);
  store.set('serverUrl', state.serverUrl);
  showAuthCard('auth-form');
  await enterApp();
  return true;
}
// One card on the login screen at a time.
function showAuthCard(id) {
  for (const f of ['auth-form', 'reset-form', 'two-step-form', 'link-form']) $('#' + f).classList.toggle('hidden', f !== id);
}
$('#two-step-back').addEventListener('click', (e) => { e.preventDefault(); twoStepTicket = null; showAuthCard('auth-form'); });
$('#two-step-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#two-step-error').textContent = '';
  $('#two-step-submit').disabled = true;
  try {
    const result = await api('/api/login/two-step', { method: 'POST', body: { ticket: twoStepTicket, code: $('#two-step-code').value.trim() } });
    twoStepTicket = null;
    await finishLogin(result);
  } catch (err) {
    $('#two-step-error').textContent = err.message;
    if (/Log in again/.test(err.message)) setTimeout(() => showAuthCard('auth-form'), 1500);
  } finally {
    $('#two-step-submit').disabled = false;
  }
});

// Passkeys: Face ID, Windows Hello, a phone or a security key. Web only: the desktop app
// runs from a file, which passkeys can't belong to.
const b64u = {
  from: (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)).buffer,
  to: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
};
const passkeysWork = () => !isApp && !!window.PublicKeyCredential && window.isSecureContext;
$('#passkey-login').addEventListener('click', async () => {
  $('#auth-error').textContent = '';
  try {
    const o = await api('/api/login/passkey/options', { method: 'POST', body: {} });
    const cred = await navigator.credentials.get({
      publicKey: { challenge: b64u.from(o.challenge), rpId: o.rpId, userVerification: o.userVerification, timeout: o.timeout, allowCredentials: [] },
    });
    if (!cred) return;
    const r = cred.response;
    const result = await api('/api/login/passkey', {
      method: 'POST',
      body: { id: o.id, credential: { id: cred.id, response: { clientDataJSON: b64u.to(r.clientDataJSON), authenticatorData: b64u.to(r.authenticatorData), signature: b64u.to(r.signature) } } },
    });
    await finishLogin(result);
  } catch (err) {
    if (err.name === 'NotAllowedError' || err.name === 'AbortError') return; // closed the prompt
    $('#auth-error').textContent = err.message === 'Failed to fetch' ? "Couldn't reach that server." : err.message;
  }
});

// A reset link from whoever runs the server: /?reset=…
let resetLinkToken = new URLSearchParams(location.search).get('reset');
async function showResetLink() {
  showAuthCard('link-form');
  $('#link-error').textContent = '';
  try {
    const { username } = await api(`/api/password/link?token=${encodeURIComponent(resetLinkToken)}`);
    $('#link-username').value = username;
    $('#link-subtitle').textContent = `Choose a new password for ${username}. You'll be logged out everywhere else.`;
    $('#link-password').focus();
  } catch (err) {
    $('#link-subtitle').textContent = err.message;
    $('#link-submit').disabled = true;
  }
}
const forgetResetLink = () => { resetLinkToken = null; history.replaceState(null, '', location.pathname); };
$('#link-back').addEventListener('click', (e) => { e.preventDefault(); forgetResetLink(); showAuthCard('auth-form'); });
$('#link-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#link-error').textContent = '';
  $('#link-submit').disabled = true;
  try {
    const result = await api('/api/password/link', { method: 'POST', body: { token: resetLinkToken, newPassword: $('#link-password').value } });
    forgetResetLink();
    $('#link-password').value = '';
    if (await finishLogin(result)) toast('Password changed. Your other devices were logged out.');
  } catch (err) {
    $('#link-error').textContent = err.message;
  } finally {
    $('#link-submit').disabled = false;
  }
});

async function logout(callServer = true) {
  leaveVoice();
  // This device stops getting alerts for the account. The server drops it once the push service says it's gone.
  pushSubscription().then((sub) => sub?.unsubscribe()).catch(() => {});
  if (callServer) api('/api/logout', { method: 'POST' }).catch(() => {});
  forgetAccount();
  forgetOffline();
  state.token = null;
  state.me = null;
  store.set('token', null);
  // A reconnect that was waiting would open a second connection after the next login.
  clearTimeout(wsTimer);
  wsTimer = null;
  if (state.ws) { state.ws.onclose = null; state.ws.close(); state.ws = null; }
  // Whoever logs in next starts fresh, not in this account's room.
  state.channelId = null;
  state.messages = [];
  setReply(null);
  $('#messages').replaceChildren();
  showAuth();
}
$('#logout').addEventListener('click', () => logout());

// ---------------------------------------------------------------- app bootstrap

async function enterApp() {
  state.me = await api('/api/me');
  state.folders = state.me.folders ?? [];
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#me-name').textContent = state.me.displayName || state.me.username;
  state.avatars.set(state.me.id, state.me.avatar ?? null);
  setAvatar($('#me-avatar'), state.me.username, state.me.avatar);
  setAvatar($('#tab-avatar'), state.me.username, state.me.avatar);
  showView('rooms');
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  const config = await api('/api/config').catch(() => ({}));
  state.voiceEnabled = !!config.voice;
  state.maxUploadBytes = config.maxUploadBytes || 0;
  $('#mic-btn').classList.toggle('hidden', !state.maxUploadBytes || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined');
  state.gifsEnabled = !!config.gifs;
  state.emailEnabled = !!config.email;
  $('#gif-btn').classList.toggle('hidden', !state.gifsEnabled);
  nudgeForEmail();
  renderMyStatus();
  syncAdminButton();
  await loadServers();
  connect();
  loadSavedAndScheduled();
  loadFriends();
  openPendingInvite();
  startPush();
  openLinkedMessage();
  afterEnter();
}

async function loadServers() {
  const [list, dms, favs] = await Promise.all([
    api('/api/servers'), api('/api/dms'),
    api('/api/me/favorites').catch(() => ({ serverIds: [] })), // servers from before favorites
  ]);
  state.favorites = favs.serverIds;
  [...list, ...dms].forEach(rememberAvatars);
  state.servers = new Map([...list, ...dms].map((s) => [s.id, s]));
  state.serverOrder = list.map((s) => s.id);
  state.dmOrder = dms.map((s) => s.id);
  if (state.servers.has(state.serverId)) state.inDms = isDm(state.servers.get(state.serverId));
  else state.serverId = state.inDms ? state.dmOrder[0] ?? null : state.serverOrder[0] ?? null;
  renderServers();
  await selectServer(state.serverId, true);
}

/**
 * Back online in the same room: fetch the messages sent while you were away and add them below
 * the ones already on screen, instead of reloading the room and losing your place. The newest
 * ones already on screen come again too, so edits, deletions and reactions you missed show up.
 */
async function catchUpRoom() {
  const id = state.channelId;
  if (!id || !state.reachedEnd || !state.messages.length) return;
  const LIMIT = 100;
  const last = state.messages.at(-1).id;
  const from = state.messages.at(-Math.min(state.messages.length, 50)).id;
  const got = await api(`/api/channels/${id}/messages?limit=${LIMIT}&after=${from - 1}`);
  if (state.channelId !== id || state.messages.at(-1)?.id !== last) return;
  const byId = new Map(got.map((m) => [m.id, m]));
  // Everything from `from` up to the last one fetched is now known: missing means deleted.
  const upTo = got.length === LIMIT ? got.at(-1).id : Infinity;
  const before = state.messages.length;
  let changed = false;
  state.messages = state.messages.flatMap((m) => {
    if (m.id < from || m.id > upTo) return [m];
    const now = byId.get(m.id);
    if (!now) { changed = true; return []; }
    if (JSON.stringify(now) !== JSON.stringify(m)) changed = true;
    return [now];
  });
  if (state.messages.length !== before) changed = true;
  const fresh = got.filter((m) => m.id > last);
  if (changed) renderMessages();
  // Added one by one below what's there, so where you were reading stays put.
  for (const m of fresh) {
    state.messages.push(m);
    appendMessage(m);
  }
  // A long time away: the rest loads as you scroll down, like after jumping back in time.
  state.reachedEnd = got.length < LIMIT;
  renderPresentBar();
  updateUnreadBar();
  if (state.reachedEnd) markReadSoon();
}

// ---------------------------------------------------------------- websocket

function connect() {
  wsTimer = null;
  if (!state.token) return;
  const url = state.serverUrl.replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(state.token);
  // Never two at once: an older one still open would deliver every event twice.
  if (state.ws) { state.ws.onclose = null; state.ws.onmessage = null; state.ws.close(); }
  const ws = new WebSocket(url);
  state.ws = ws;
  ws.onopen = () => {
    const wasRetry = state.wsRetry > 0;
    state.wsRetry = 0;
    setConnected(true, 'Connected');
    // The server forgets who's in voice when we drop off, so tell it again.
    if (state.voice) ws.send(JSON.stringify({ type: 'voice_join', channelId: state.voice.channelId, ...voiceFlags() }));
    // Dropping off ended your "is live" post; still sharing, it picks back up.
    if (state.voice?.room?.localParticipant?.isScreenShareEnabled) ws.send(JSON.stringify({ type: 'voice_live', live: true }));
    // So is whether you're away from this device, and what you're playing.
    if (idleSent) ws.send(JSON.stringify({ type: 'idle', idle: true }));
    if (sharedActivity) ws.send(JSON.stringify({ type: 'activity', name: sharedActivity }));
    flushOutbox();
    // Catch up on anything missed while disconnected.
    if (wasRetry) { loadServers().then(catchUpRoom).catch(() => {}); loadFriends(); }
  };
  ws.onmessage = (e) => {
    ws.heard = Date.now();
    const ev = JSON.parse(e.data);
    if (ev.type !== 'pong') handleEvent(ev);
  };
  ws.onclose = (e) => {
    // The password was changed on another device, which signs this one out.
    if (e.code === 4001 && state.ws === ws) {
      logout(false);
      $('#auth-error').textContent = e.reason === 'Account deleted' ? 'Your account was deleted.'
        : e.reason === 'Signed out' ? 'This device was signed out from another one.' : 'Your password was changed, so please log in again.';
      return;
    }
    setConnected(false, 'Reconnecting…');
    if (state.ws !== ws || !state.token) return;
    const delay = Math.min(30000, 1000 * 2 ** state.wsRetry++);
    clearTimeout(wsTimer);
    wsTimer = setTimeout(connect, delay);
  };
}
let wsTimer = null;

// A connection can die without closing (Wi-Fi switched, laptop slept), so the app checks it's still
// there now and then, and as soon as you come back to it. No answer in time and it reconnects.
function checkConnection() {
  const ws = state.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN || ws.checking) return;
  const asked = Date.now();
  ws.checking = true;
  ws.send(JSON.stringify({ type: 'ping' }));
  setTimeout(() => {
    ws.checking = false;
    if (state.ws !== ws || ws.readyState !== WebSocket.OPEN || ws.heard >= asked) return;
    // Closing a dead connection can hang, so don't wait for it to say it's closed.
    const closed = ws.onclose;
    ws.onclose = null;
    ws.close();
    closed?.({ code: 1006 });
  }, 8000);
}
setInterval(() => { if (Date.now() - (state.ws?.heard ?? 0) > 25000) checkConnection(); }, 25000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkConnection(); });
// The network's back (Wi-Fi rejoined, laptop woke up): reconnect now rather than waiting out the backoff.
window.addEventListener('online', () => {
  if (state.ws?.readyState === WebSocket.OPEN) return checkConnection();
  if (!wsTimer || !state.token) return;
  clearTimeout(wsTimer);
  wsTimer = null;
  connect();
});

function handleEvent(ev) {
  switch (ev.type) {
    case 'message': {
      const m = ev.message;
      const dm = state.dmOrder.find((id) => state.servers.get(id).channels.some((c) => c.id === m.channelId));
      if (dm) {
        const s = state.servers.get(dm);
        if (!m.parentId && !(s.last?.id > m.id))
          s.last = { id: m.id, authorId: m.authorId, text: (m.content ?? '').slice(0, 120), at: m.createdAt, files: m.attachments?.length ? 1 : 0 };
        state.dmOrder = [dm, ...state.dmOrder.filter((id) => id !== dm)];
        if (state.inDms) renderChannels();
      }
      const mine = m.authorId === state.me.id;
      const where = roomById(m.channelId);
      if (where) {
        const c = where.c;
        if (mine) Object.assign(c, { lastReadId: Math.max(c.lastReadId ?? 0, m.id), unread: 0, mentions: 0 });
        else if (m.id > (c.lastReadId ?? 0) && !isBlocked(m.authorId)) {
          c.unread = (c.unread ?? 0) + 1;
          if (isDm(where.s) || mentionsMe(m)) c.mentions = (c.mentions ?? 0) + 1;
        }
        if (where.thread) Object.assign(c, { count: (c.count ?? 0) + 1, lastAt: m.createdAt });
      }
      if (m.channelId === state.channelId) {
        clearTyping(m.channelId, m.author);
        if (state.reachedEnd) {
          state.messages.push(m);
          appendMessage(m, { stick: mine });
          renderSeen();
        } else if (mine) loadPresent();
        if (mine) { state.holdUnread = null; state.newFrom = null; state.unreadAtOpen = null; updateUnreadBar(); }
        markReadSoon();
      }
      if (m.channelId !== state.channelId || where?.thread) {
        renderServers();
        renderChannels();
      }
      if (mine) startSlowWait(m.channelId);
      if (!mine && !isBlocked(m.authorId) && (document.hidden || m.channelId !== state.channelId) && !quietFor(m) && !hushed()) {
        notify(m);
        playSound('message');
      }
      break;
    }
    case 'message_updated': {
      const i = state.messages.findIndex((x) => x.id === ev.message.id);
      if (i >= 0) state.messages[i] = ev.message;
      if (state.threadParent?.id === ev.message.id) { state.threadParent = ev.message; renderMessages(); }
      refreshLine(ev.message.id);
      for (const id of state.dmOrder) {
        const s = state.servers.get(id);
        if (s.last?.id === ev.message.id) { s.last.text = ev.message.content.slice(0, 120); if (state.inDms) renderChannels(); }
      }
      for (const x of state.messages)
        if (x.replyTo?.id === ev.message.id) { x.replyTo.content = ev.message.content.slice(0, 160); refreshLine(x.id); }
      break;
    }
    case 'message_deleted':
      for (const id of state.dmOrder) {
        const s = state.servers.get(id);
        if (s.last?.id === ev.id) { s.last = null; if (state.inDms) renderChannels(); }
      }
      if (state.replyTo?.id === ev.id) setReply(null);
      // Deleted somewhere else: nothing on screen changes, so nothing is redrawn.
      if (state.threadParent?.id !== ev.id && !state.messages.some((x) => x.id === ev.id || x.replyTo?.id === ev.id)) break;
      if (state.threadParent?.id === ev.id) state.threadParent = { deleted: true };
      state.messages = state.messages.filter((x) => x.id !== ev.id);
      for (const x of state.messages) if (x.replyTo?.id === ev.id) x.replyTo = { deleted: true };
      renderMessages();
      break;
    case 'reactions': {
      const m = state.messages.find((x) => x.id === ev.messageId);
      if (m) { m.reactions = ev.reactions; refreshLine(m.id); }
      break;
    }
    case 'server_updated': {
      rememberAvatars(ev.server);
      if (isDm(ev.server)) {
        addDm(ev.server);
        renderServers();
        if (state.inDms) renderChannels();
        if (ev.server.id === state.serverId) { renderMembers(); renderSeen(); }
        break;
      }
      const isNew = !state.servers.has(ev.server.id);
      state.servers.set(ev.server.id, ev.server);
      if (isNew) state.serverOrder.push(ev.server.id);
      renderServers();
      leaveVoiceIfGone();
      // Someone in our voice room was removed from the burrow: new key, without them.
      if (state.voice?.crypto && ev.server.channels.some((c) => c.id === state.voice.channelId)
        && [...state.voice.crypto.pubs.keys()].some((id) => !ev.server.members.some((m) => String(m.id) === id))) keysChanged(state.voice);
      if (ev.server.id === state.serverId) {
        // The room we're in was deleted or made private without us.
        if (!state.inDms && !ev.server.channels.some((c) => c.id === state.channelId) && !ev.server.threads?.some((t) => t.id === state.channelId))
          selectServer(ev.server.id);
        else { renderChannels(); renderMembers(); renderMessages(); renderChatHeader(); }
      }
      break;
    }
    case 'server_deleted':
      // Deleted, or we were removed from it.
      state.servers.delete(ev.serverId);
      state.favorites = state.favorites.filter((id) => id !== ev.serverId);
      state.serverOrder = state.serverOrder.filter((id) => id !== ev.serverId);
      state.dmOrder = state.dmOrder.filter((id) => id !== ev.serverId);
      leaveVoiceIfGone();
      if (state.serverId === ev.serverId) state.inDms ? openDms() : selectServer(state.serverOrder[0] ?? null);
      else { renderServers(); if (state.inDms) renderChannels(); }
      break;
    case 'presence':
      for (const s of state.servers.values())
        for (const mem of s.members) if (mem.id === ev.userId) Object.assign(mem, { online: ev.online, status: ev.status, custom: ev.custom, activity: ev.activity });
      for (const list of Object.values(state.friends ?? {})) for (const f of list) if (f.id === ev.userId) Object.assign(f, { online: ev.online, status: ev.status, custom: ev.custom, activity: ev.activity });
      if (state.inDms) renderChannels(); // the online dots in the list of conversations
      if ($('#friends-panel')) renderFriendsPanel();
      if (ev.userId === state.me.id) Object.assign(state.me, { customStatus: ev.custom });
      renderMembers();
      break;
    case 'me_updated': {
      const blockedBefore = String(state.me.blockedIds ?? []);
      Object.assign(state.me, ev.me);
      renderMyStatus();
      syncAdminButton();
      $('#me-name').textContent = state.me.displayName || state.me.username;
      if (String(state.me.blockedIds ?? []) !== blockedBefore) renderMessages();
      break;
    }
    case 'typing':
      showTyping(ev.channelId, ev.username);
      break;
    case 'user_updated':
      applyUser(ev.user);
      break;
    case 'friends':
      setFriends(ev);
      break;
    case 'messages_purged':
      // Someone deleted their account and took their messages with them.
      if (ev.channelId === state.channelId) {
        state.messages = state.messages.filter((m) => m.authorId !== ev.userId);
        renderMessages();
      }
      break;
    case 'favorites':
      state.favorites = ev.serverIds;
      renderServers();
      break;
    case 'voice_state':
      if (state.voice?.channelId === ev.channelId) voiceSounds(ev.channelId, ev.userIds);
      for (const s of state.servers.values())
        for (const c of s.channels)
          if (c.id === ev.channelId)
            Object.assign(c, { voiceUsers: ev.userIds, voiceMuted: ev.muted, voiceDeafened: ev.deafened, voiceServerMuted: ev.serverMuted ?? [] });
      checkRinging(ev.channelId, ev.userIds);
      renderChannels();
      renderCallButton();
      break;
    case 'voice_move': {
      if (!state.voice) break;
      const to = roomById(ev.channelId)?.c;
      // Deafened counts as muted, so what you'd chosen before deafening is what's carried over.
      const { muted, deafened, mutedBeforeDeafen } = state.voice;
      joinVoice(ev.channelId, { muted: (deafened ? mutedBeforeDeafen : muted) || !!ev.afk, deafened });
      toast(ev.afk ? `You were away for a while, so you were moved to ${to?.name ?? 'the AFK fire'}.` : `${ev.by} moved you to ${to?.name ?? 'another fire'}.`);
      break;
    }
    case 'voice_kicked':
      if (state.voice) leaveVoice();
      toast(`${ev.by} took you out of the fire.`);
      break;
    case 'reports': {
      const s = state.servers.get(ev.serverId);
      if (s) s.openReports = ev.open;
      break;
    }
    case 'server_muted': {
      const s = state.servers.get(ev.serverId);
      if (s) s.serverMuted = ev.muted;
      if (state.voice && fireServer()?.id === ev.serverId) applyServerMute(ev.muted);
      toast(ev.muted ? `A moderator muted you in ${s?.name ?? 'a hearth'}.` : `You can speak again in ${s?.name ?? 'the hearth'}.`);
      break;
    }
    case 'marshmallow':
      onMarshmallow(ev);
      break;
    case 'soundboard':
      onBoardSound(ev);
      break;
    case 'listen_state':
      onListenState(ev);
      break;
    case 'ring':
      onRing(ev);
      break;
    case 'ring_stop':
      if (ringing?.serverId === ev.serverId) stopRinging();
      break;
    case 'ring_declined':
      if (state.voice && roomById(state.voice.channelId)?.s?.id === ev.serverId) toast(`${ev.username} can't talk right now.`);
      break;
    case 'fireside_history':
      if (state.voice?.channelId !== ev.channelId) break;
      state.fireside = { channelId: ev.channelId, messages: ev.messages, unread: 0 };
      renderFireside();
      break;
    case 'fireside':
      if (state.voice?.channelId !== ev.channelId) break;
      if (state.fireside.channelId !== ev.channelId) state.fireside = { channelId: ev.channelId, messages: [], unread: 0 };
      state.fireside.messages.push(ev.message);
      if (state.fireside.messages.length > 100) state.fireside.messages.shift();
      if (ev.message.userId !== state.me.id && !firesideVisible()) state.fireside.unread++;
      renderFireside({ added: ev.message });
      break;
    case 'read': {
      const where = roomById(ev.channelId);
      if (!where) break;
      Object.assign(where.c, { lastReadId: ev.lastReadId, unread: ev.unread, mentions: ev.mentions });
      renderServers();
      renderChannels();
      break;
    }
    case 'dm_seen': {
      const s = state.servers.get(ev.serverId);
      if (s) s.seen = { userId: ev.userId, lastReadId: ev.lastReadId };
      if (ev.channelId === state.channelId) renderSeen();
      break;
    }
    case 'saved':
      if (ev.saved) state.saved.set(ev.messageId, ev.saved);
      else state.saved.delete(ev.messageId);
      break;
    case 'reminder':
      state.saved.set(ev.saved.messageId, ev.saved);
      showReminder(ev);
      break;
    case 'scheduled':
      state.scheduled = ev.items;
      renderScheduledNote();
      break;
    case 'scheduled_failed':
      toast(`A scheduled message couldn't be sent: ${ev.error}`, { timeout: 0 });
      break;
    case 'error': {
      // Usually a message that couldn't be sent: slow mode, an archived room, and so on.
      const onFail = ev.nonce && unconfirmed.get(ev.nonce);
      if (!onFail) { toast(ev.error); break; }
      unconfirmed.delete(ev.nonce);
      onFail(new Error(ev.error));
      break;
    }
    case 'folders':
      state.folders = ev.folders;
      if ($('#switcher').dataset.open) renderSwitcher();
      break;
    case 'event_reminder':
      showEventReminder(ev);
      break;
  }
}

function notify(m) {
  const where = roomById(m.channelId);
  const server = where?.s;
  const channel = where?.c;
  // A direct message is always for you, like a mention.
  const mentioned = isDm(server) || mentionsMe(m);
  if (!mentioned && !document.hidden) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const who = authorName(m);
  const title = isDm(server) ? (server.group ? `${who} in ${dmTitle(server)}` : `${who} (direct message)`) : `${who} in ${channel?.name ?? 'Peiskos'}`;
  const body = plainText(m.content).slice(0, 200) || (m.poll ? `Poll: ${m.poll.question}` : m.live ? 'Is live, sharing their screen' : m.sticker ? 'Sent a sticker' : 'Sent a file');
  const n = new Notification(title, { body, silent: !mentioned });
  n.onclick = () => { window.focus(); jumpTo(m.channelId, m.id); };
}
