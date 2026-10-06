// Chat client. Runs both as the web app served by the chat server and inside
// the desktop app (loaded from file://, where the user types the server address).
'use strict';

const $ = (sel) => document.querySelector(sel);
const isDesktop = location.protocol === 'file:';

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

const state = {
  serverUrl: isDesktop ? store.get('serverUrl') || '' : location.origin,
  token: store.get('token'),
  me: null,
  servers: new Map(),       // id -> { id, name, kind, ownerId, inviteCode, channels, members }; DMs are kind 'dm'
  serverOrder: [],          // burrow ids, in the order they're shown
  favorites: [],            // up to 5 burrow ids kept in the top bar, in order
  dmOrder: [],              // direct message conversation ids, most recent first
  inDms: false,             // showing direct messages instead of a burrow
  serverId: Number(store.get('lastServer')) || null,
  channelId: null,
  lastChannel: JSON.parse(store.get('lastChannel') || '{}'), // serverId -> channelId
  messages: [],             // messages in the open channel, oldest first
  reachedStart: false,
  loadingOlder: false,
  unread: new Set(),        // channel ids
  typing: new Map(),        // channelId -> Map(username -> timer)
  ws: null,
  wsRetry: 0,
  voiceEnabled: false,      // the server has LiveKit set up
  maxUploadBytes: 0,        // 0 = uploads are off on this server
  replyTo: null,            // the message the composer is replying to
  pending: [],              // files attached to the composer: { file, previewUrl, progress, attachment, error, done }
  voice: null,              // { channelId, room, muted } while in a voice room
  speaking: new Set(),      // user ids talking right now in our voice room
  mutedInVoice: new Set(),  // user ids muted in our voice room
  sharing: new Map(),       // user id -> { camera, screen } in our voice room
  stageOpen: false,         // showing video instead of the chat
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
  if (isDesktop) store.set('serverUrl', origin);
}

async function resolveServerUrl() {
  if (!isDesktop || !state.serverUrl) return;
  try {
    const res = await fetch(state.serverUrl + '/api/config');
    if (res.redirected) adoptOrigin(res.url);
  } catch {}
}

// ---------------------------------------------------------------- auth screen

let registering = false;

async function showAuth() {
  $('#app').classList.add('hidden');
  $('#auth').classList.remove('hidden');
  $('#server-url-row').classList.toggle('hidden', !isDesktop);
  $('#server-url').value = state.serverUrl;
  renderAuthMode();
}

async function renderAuthMode() {
  $('#auth-title').textContent = registering ? 'Dig in' : 'Welcome back';
  $('#auth-subtitle').textContent = registering ? 'Pick a username your friends will see.' : 'Log in to chat with your friends.';
  $('#auth-submit').textContent = registering ? 'Create account' : 'Log in';
  $('#auth-toggle').textContent = registering ? 'Already have an account? Log in' : 'Need an account? Register';
  $('#password').autocomplete = registering ? 'new-password' : 'current-password';
  $('#auth-error').textContent = '';
  let needsCode = false;
  if (registering && state.serverUrl) {
    try { needsCode = (await api('/api/config')).registrationCodeRequired; } catch {}
  }
  $('#reg-code-row').classList.toggle('hidden', !needsCode);
}

$('#auth-toggle').addEventListener('click', (e) => {
  e.preventDefault();
  registering = !registering;
  renderAuthMode();
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
  if (isDesktop) state.serverUrl = normalizeServerUrl($('#server-url').value);
  if (!state.serverUrl) return ($('#auth-error').textContent = 'Enter the server address.');
  $('#auth-submit').disabled = true;
  try {
    await resolveServerUrl();
    const body = { username: $('#username').value.trim(), password: $('#password').value };
    if (registering) body.registrationCode = $('#reg-code').value.trim();
    const { token, user } = await api(registering ? '/api/register' : '/api/login', { method: 'POST', body });
    state.token = token;
    state.me = user;
    store.set('token', token);
    store.set('serverUrl', state.serverUrl);
    $('#password').value = '';
    await enterApp();
  } catch (err) {
    $('#auth-error').textContent = err.message === 'Failed to fetch' ? "Couldn't reach that server." : err.message;
  } finally {
    $('#auth-submit').disabled = false;
  }
});

async function logout(callServer = true) {
  leaveVoice();
  if (callServer) api('/api/logout', { method: 'POST' }).catch(() => {});
  state.token = null;
  state.me = null;
  store.set('token', null);
  if (state.ws) { state.ws.onclose = null; state.ws.close(); state.ws = null; }
  showAuth();
}
$('#logout').addEventListener('click', () => logout());

// ---------------------------------------------------------------- app bootstrap

async function enterApp() {
  if (!state.me) state.me = await api('/api/me');
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#me-name').textContent = state.me.username;
  state.avatars.set(state.me.id, state.me.avatar ?? null);
  setAvatar($('#me-avatar'), state.me.username, state.me.avatar);
  setAvatar($('#tab-avatar'), state.me.username, state.me.avatar);
  showView('rooms');
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  const config = await api('/api/config').catch(() => ({}));
  state.voiceEnabled = !!config.voice;
  state.maxUploadBytes = config.maxUploadBytes || 0;
  $('#attach-btn').classList.toggle('hidden', !state.maxUploadBytes);
  await loadServers();
  connect();
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

// ---------------------------------------------------------------- websocket

function connect() {
  if (!state.token) return;
  const url = state.serverUrl.replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(state.token);
  const ws = new WebSocket(url);
  state.ws = ws;
  ws.onopen = () => {
    const wasRetry = state.wsRetry > 0;
    state.wsRetry = 0;
    setConnected(true, 'Connected');
    // The server forgets who's in voice when we drop off, so tell it again.
    if (state.voice) ws.send(JSON.stringify({ type: 'voice_join', channelId: state.voice.channelId }));
    // Catch up on anything missed while disconnected.
    if (wasRetry) loadServers().catch(() => {});
  };
  ws.onmessage = (e) => handleEvent(JSON.parse(e.data));
  ws.onclose = (e) => {
    // The password was changed on another device, which signs this one out.
    if (e.code === 4001 && state.ws === ws) {
      logout(false);
      $('#auth-error').textContent = 'Your password was changed, so please log in again.';
      return;
    }
    setConnected(false, 'Reconnecting…');
    if (state.ws !== ws || !state.token) return;
    const delay = Math.min(30000, 1000 * 2 ** state.wsRetry++);
    setTimeout(connect, delay);
  };
}

function handleEvent(ev) {
  switch (ev.type) {
    case 'message': {
      const m = ev.message;
      const dm = state.dmOrder.find((id) => state.servers.get(id).channels.some((c) => c.id === m.channelId));
      if (dm) {
        state.dmOrder = [dm, ...state.dmOrder.filter((id) => id !== dm)];
        if (state.inDms) renderChannels();
      }
      if (m.channelId === state.channelId) {
        state.messages.push(m);
        clearTyping(m.channelId, m.author);
        appendMessage(m, { stick: m.authorId === state.me.id });
      } else {
        state.unread.add(m.channelId);
        renderServers();
        renderChannels();
      }
      if (m.authorId !== state.me.id && (document.hidden || m.channelId !== state.channelId)) {
        notify(m);
        playSound('message');
      }
      break;
    }
    case 'message_updated': {
      const i = state.messages.findIndex((x) => x.id === ev.message.id);
      if (i >= 0) state.messages[i] = ev.message;
      refreshLine(ev.message.id);
      for (const x of state.messages)
        if (x.replyTo?.id === ev.message.id) { x.replyTo.content = ev.message.content.slice(0, 160); refreshLine(x.id); }
      break;
    }
    case 'message_deleted':
      state.messages = state.messages.filter((x) => x.id !== ev.id);
      for (const x of state.messages) if (x.replyTo?.id === ev.id) x.replyTo = { deleted: true };
      if (state.replyTo?.id === ev.id) setReply(null);
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
        if (ev.server.id === state.serverId) renderMembers();
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
        if (!state.inDms && !ev.server.channels.some((c) => c.id === state.channelId)) selectServer(ev.server.id);
        else { renderChannels(); renderMembers(); renderMessages(); }
      }
      break;
    }
    case 'server_deleted':
      // Deleted, or we were removed from it.
      state.servers.delete(ev.serverId);
      state.favorites = state.favorites.filter((id) => id !== ev.serverId);
      state.serverOrder = state.serverOrder.filter((id) => id !== ev.serverId);
      leaveVoiceIfGone();
      if (state.serverId === ev.serverId) selectServer(state.serverOrder[0] ?? null);
      else renderServers();
      break;
    case 'presence':
      for (const s of state.servers.values())
        for (const mem of s.members) if (mem.id === ev.userId) mem.online = ev.online;
      renderMembers();
      break;
    case 'typing':
      showTyping(ev.channelId, ev.username);
      break;
    case 'user_updated':
      applyUser(ev.user);
      break;
    case 'favorites':
      state.favorites = ev.serverIds;
      renderServers();
      break;
    case 'voice_state':
      if (state.voice?.channelId === ev.channelId) voiceSounds(ev.channelId, ev.userIds);
      for (const s of state.servers.values())
        for (const c of s.channels) if (c.id === ev.channelId) c.voiceUsers = ev.userIds;
      renderChannels();
      break;
    case 'error':
      console.warn('Server error:', ev.error);
      break;
  }
}

function notify(m) {
  const server = [...state.servers.values()].find((s) => s.channels.some((c) => c.id === m.channelId));
  const channel = server?.channels.find((c) => c.id === m.channelId);
  // A direct message is always for you, like a mention.
  const mentioned = isDm(server) || new RegExp('@' + escapeRegex(state.me.username) + '\\b', 'i').test(m.content) || m.replyTo?.authorId === state.me.id;
  if (!mentioned && !document.hidden) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const title = isDm(server) ? `${m.author} (direct message)` : `${m.author} in ${channel?.name ?? 'Burrow'}`;
  const n = new Notification(title, { body: m.content.slice(0, 200) || 'Sent a file', silent: !mentioned });
  n.onclick = () => { window.focus(); if (server) selectServer(server.id).then(() => { selectChannel(m.channelId); showView('chat'); }); };
}

// ---------------------------------------------------------------- servers & channels

// The top bar: a named pill per burrow, with the ones that don't fit in a "more" list.
// Phones get one button with the current burrow's name instead, which opens the full list.
function renderServers() {
  const s = state.servers.get(state.serverId);
  const hasUnread = (srv) => srv.channels.some((c) => state.unread.has(c.id));
  const dmUnread = state.dmOrder.some((id) => hasUnread(state.servers.get(id)));

  const dmPill = document.createElement('button');
  dmPill.className = 'pill dm-pill' + (state.inDms ? ' on' : '') + (!state.inDms && dmUnread ? ' unread' : '');
  dmPill.innerHTML = `<span class="tile dm-tile">${CHAT_ICON}</span><span class="pill-name">Messages</span>`;
  dmPill.title = 'Direct messages';
  dmPill.onclick = openDms;
  if (state.inDms) dmPill.setAttribute('aria-current', 'true');

  // With favorites, the bar holds those (plus the burrow you're in), and the rest go under "more".
  const favs = favoriteIds();
  const inBar = favs.length ? [...favs] : [...state.serverOrder];
  if (favs.length && !state.inDms && state.serverOrder.includes(state.serverId) && !favs.includes(state.serverId)) inBar.push(state.serverId);
  notInBar = state.serverOrder.filter((id) => !inBar.includes(id));
  const pills = inBar.map((id) => {
    const srv = state.servers.get(id);
    const b = document.createElement('button');
    const on = id === state.serverId && !state.inDms;
    b.className = 'pill' + (on ? ' on' : '') + (!on && hasUnread(srv) ? ' unread' : '');
    b.dataset.id = id;
    b.title = srv.name;
    b.append(burrowTile(srv));
    const name = document.createElement('span');
    name.className = 'pill-name';
    name.textContent = srv.name;
    b.append(name);
    if (on) b.setAttribute('aria-current', 'true');
    if (favs.includes(id)) b.classList.add('fav');
    b.onclick = () => selectServer(id);
    return b;
  });

  const more = document.createElement('button');
  more.className = 'pill more';
  more.id = 'burrow-more';
  more.hidden = true;
  more.setAttribute('aria-haspopup', 'dialog');
  more.onclick = (e) => { e.stopPropagation(); toggleSwitcher(more, 'more'); };

  const add = document.createElement('button');
  add.className = 'add-burrow';
  add.title = 'Create or join a burrow';
  add.setAttribute('aria-label', 'Create or join a burrow');
  add.textContent = '+';
  add.onclick = openAddServer;

  $('#burrow-nav').replaceChildren(dmPill, ...pills, more, add);
  fitPills();

  // The phone's burrow button.
  const tile = $('#switch-tile');
  if (state.inDms || !s) {
    tile.className = 'tile dm-tile';
    tile.innerHTML = CHAT_ICON;
    tile.style.background = '';
  } else {
    tile.replaceWith(burrowTile(s, 'switch-tile'));
  }
  $('#switch-name').textContent = state.inDms ? 'Messages' : s?.name ?? 'Burrows';
  const elsewhere = state.serverOrder.some((id) => id !== state.serverId && hasUnread(state.servers.get(id)));
  $('#burrow-switch').classList.toggle('unread', elsewhere || (!state.inDms && dmUnread));

  $('#tab-burrows').classList.toggle('on', !state.inDms);
  $('#tab-messages').classList.toggle('on', state.inDms);
  $('#tab-messages').classList.toggle('unread', !state.inDms && dmUnread);

  if ($('#switcher').dataset.open) renderSwitcher();
  $('#empty-state').classList.toggle('hidden', state.serverOrder.length > 0 || state.inDms);
}

function burrowTile(s, id) {
  const t = document.createElement('span');
  t.className = 'tile';
  if (id) t.id = id;
  t.textContent = initials(s.name);
  t.style.background = colorFor(s.name);
  return t;
}

// Hide the pills that don't fit, keeping the current burrow, and count them on the "more" button.
let overflowIds = [];
let notInBar = []; // burrows left out of the bar because they aren't favorites
function fitPills() {
  const nav = $('#burrow-nav');
  const more = $('#burrow-more');
  overflowIds = [];
  if (!more || !nav.offsetParent) return; // not shown on phones
  const pills = [...nav.querySelectorAll('.pill[data-id]')];
  pills.forEach((p) => (p.hidden = false));
  more.hidden = !notInBar.length;
  more.innerHTML = `${CHEVRON_ICON}${notInBar.length} more`;
  markMoreUnread();
  if (nav.scrollWidth <= nav.clientWidth) return;
  more.hidden = false;
  more.innerHTML = `${CHEVRON_ICON}${pills.length + notInBar.length} more`;
  const gap = parseFloat(getComputedStyle(nav).columnGap) || 0;
  const fixed = [...nav.children].filter((el) => !el.dataset.id && !el.hidden).reduce((w, el) => w + el.offsetWidth + gap, 0);
  let room = nav.clientWidth - fixed;
  const active = pills.find((p) => p.classList.contains('on'));
  if (active) room -= active.offsetWidth + gap;
  let full = false;
  for (const p of pills) {
    if (p === active) continue;
    const w = p.offsetWidth + gap;
    if (!full && w <= room) room -= w;
    else { full = true; p.hidden = true; }
  }
  overflowIds = pills.filter((p) => p.hidden).map((p) => Number(p.dataset.id));
  more.innerHTML = `${CHEVRON_ICON}${overflowIds.length + notInBar.length} more`;
  markMoreUnread();
}
function markMoreUnread() {
  const hidden = [...overflowIds, ...notInBar];
  $('#burrow-more').classList.toggle('unread', hidden.some((id) => state.servers.get(id)?.channels.some((c) => state.unread.has(c.id))));
}

// ---- favorites: up to 5 burrows kept in the top bar, saved on the server so every device shows the same ones

const MAX_FAVORITES = 5;
const favoriteIds = () => state.favorites.filter((id) => state.serverOrder.includes(id));

async function toggleFavorite(id) {
  const before = state.favorites;
  const favs = favoriteIds();
  const next = favs.includes(id) ? favs.filter((x) => x !== id) : [...favs, id];
  if (next.length > MAX_FAVORITES) return;
  state.favorites = next;
  renderServers();
  try {
    state.favorites = (await api('/api/me/favorites', { method: 'POST', body: { serverIds: next } })).serverIds;
  } catch (err) {
    state.favorites = before;
    alertError(err);
  }
  renderServers();
}
new ResizeObserver(() => fitPills()).observe($('#burrow-nav'));

// What's going on in a burrow, for the switcher.
function burrowStatus(s) {
  const fire = s.channels.reduce((n, c) => n + (c.kind === 'voice' ? c.voiceUsers?.length ?? 0 : 0), 0);
  if (fire) return { text: `${fire} by the fire`, cls: 'ember' };
  if (s.channels.some((c) => state.unread.has(c.id))) return { text: 'New messages', cls: 'news' };
  return { text: s.channels.some((c) => c.kind === 'voice') ? "Fire's out" : 'All caught up', cls: '' };
}

// The burrow list: under the "more" button on a computer, or a sheet from the top on a phone.
function toggleSwitcher(anchor, from = 'all') {
  const sw = $('#switcher');
  if (!sw.classList.contains('hidden')) return closeSwitcher();
  sw.dataset.open = from;
  sw.anchor = anchor;
  renderSwitcher();
  sw.classList.remove('hidden');
  anchor.setAttribute('aria-expanded', 'true');
  $('#app').classList.add('switching');
  placeSwitcher();
  sw.querySelector('button')?.focus();
}

function placeSwitcher() {
  const sw = $('#switcher');
  if (sw.classList.contains('hidden')) return;
  if (isPhone()) { sw.style.left = sw.style.top = ''; return; }
  const r = sw.anchor.getBoundingClientRect();
  sw.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - sw.offsetWidth - 8))}px`;
  sw.style.top = `${r.bottom + 8}px`;
}

function renderSwitcher() {
  const sw = $('#switcher');
  const favs = favoriteIds();
  const full = favs.length >= MAX_FAVORITES;
  const row = (id) => {
    const s = state.servers.get(id);
    const on = id === state.serverId && !state.inDms;
    const fav = favs.includes(id);
    const el = document.createElement('div');
    el.className = 'switch-row' + (on ? ' on' : '');
    const b = document.createElement('button');
    b.className = 'switch-main';
    const tile = burrowTile(s);
    if (!on && s.channels.some((c) => state.unread.has(c.id))) tile.classList.add('unread');
    const status = burrowStatus(s);
    const text = document.createElement('span');
    text.className = 'switch-text';
    text.innerHTML = `<b></b><span class="switch-status ${status.cls}"></span>`;
    text.firstChild.textContent = s.name;
    text.lastChild.textContent = status.text;
    b.append(tile, text);
    if (on) b.insertAdjacentHTML('beforeend', CHECK_ICON);
    b.onclick = () => { closeSwitcher(); selectServer(id); };
    const star = document.createElement('button');
    star.className = 'star' + (fav ? ' on' : '');
    star.innerHTML = STAR_ICON;
    star.setAttribute('aria-pressed', String(fav));
    star.disabled = !fav && full;
    star.title = fav ? `Take ${s.name} out of your favorites`
      : full ? `You can have up to ${MAX_FAVORITES} favorites. Unstar one first.` : `Keep ${s.name} in your top bar`;
    star.setAttribute('aria-label', star.title);
    star.onclick = () => toggleFavorite(id);
    el.append(b, star);
    return el;
  };
  const heading = (text) => {
    const h = document.createElement('div');
    h.className = 'switch-head';
    h.textContent = text;
    return h;
  };
  const others = state.serverOrder.filter((id) => !favs.includes(id));
  const rows = [];
  if (favs.length) rows.push(heading(`Favorites · ${favs.length} of ${MAX_FAVORITES}`), ...favs.map(row));
  else {
    const hint = document.createElement('p');
    hint.className = 'switch-hint';
    hint.textContent = `Star up to ${MAX_FAVORITES} burrows to keep them in your top bar.`;
    rows.push(hint);
  }
  if (others.length) rows.push(heading(favs.length ? 'Other burrows' : 'Your burrows'), ...others.map(row));
  const foot = document.createElement('div');
  foot.className = 'switch-foot';
  foot.innerHTML = '<button class="btn" data-act="new">New burrow</button><button class="btn secondary" data-act="join">Use an invite</button>';
  foot.querySelectorAll('button').forEach((b) => (b.onclick = () => { closeSwitcher(); openAddServer(b.dataset.act); }));
  // Phones have no room for the burrow's heading, so its settings live here.
  if (sw.dataset.open === 'all' && !state.inDms && state.servers.has(state.serverId)) {
    const settings = document.createElement('button');
    settings.className = 'btn secondary settings';
    settings.textContent = `${state.servers.get(state.serverId).name} settings and invite`;
    settings.onclick = () => { closeSwitcher(); $('#server-menu-btn').click(); };
    foot.prepend(settings);
  }
  sw.replaceChildren(...rows, foot);
}

function closeSwitcher() {
  const sw = $('#switcher');
  if (sw.classList.contains('hidden')) return;
  sw.classList.add('hidden');
  sw.anchor?.setAttribute('aria-expanded', 'false');
  delete sw.dataset.open;
  $('#app').classList.remove('switching');
}
$('#burrow-switch').onclick = (e) => { e.stopPropagation(); toggleSwitcher($('#burrow-switch')); };
$('#switcher').onclick = (e) => e.stopPropagation();
document.addEventListener('click', closeSwitcher);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSwitcher(); });
window.addEventListener('resize', placeSwitcher);

async function selectServer(id, initial = false) {
  const s = state.servers.get(id);
  if (!initial) showView('rooms');
  if (s) state.inDms = isDm(s);
  state.serverId = id;
  store.set('lastServer', id);
  renderServers();
  renderMembers();
  if (!s) { state.channelId = null; renderChannels(); state.messages = []; renderMessages(); return; }
  const remembered = state.lastChannel[id];
  const textRooms = s.channels.filter((c) => c.kind !== 'voice');
  const ch = textRooms.find((c) => c.id === remembered) ?? textRooms[0];
  if (initial && ch && ch.id === state.channelId) return renderChannels();
  await selectChannel(ch?.id ?? null);
}

function renderChannels() {
  // The card's heading and buttons follow the burrow and your role in it, which can change at any time.
  const s = state.servers.get(state.serverId);
  $('#server-name').textContent = state.inDms ? 'Direct messages' : s?.name ?? 'No burrow yet';
  $('#rooms-title').textContent = state.inDms ? 'Conversations' : 'Rooms';
  $('#server-menu-btn').classList.toggle('hidden', !s || state.inDms);
  $('#add-channel').classList.toggle('hidden', !state.inDms && !can(s, 'rooms'));
  $('#add-channel').title = state.inDms ? 'New message' : 'New room';
  if (state.inDms) return renderDmList();
  const channels = s?.channels ?? [];
  const textRooms = channels.filter((c) => c.kind !== 'voice').map((c) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'room-name';
    name.textContent = c.name;
    li.append(name);
    if (c.private) li.insertAdjacentHTML('beforeend', LOCK_ICON);
    if (c.id === state.channelId) li.className = 'active';
    else if (state.unread.has(c.id)) li.className = 'unread';
    li.prepend(roomIcon());
    li.onclick = () => { selectChannel(c.id); showView('chat'); };
    if (can(s, 'rooms')) li.append(roomSettingsButton(c));
    return li;
  });
  // The first voice room is the burrow's Campfire, shown as a card above the rooms. Any others are "other fires".
  const voiceRooms = channels.filter((c) => c.kind === 'voice').map((c, i) => {
    const li = document.createElement('li');
    const joined = state.voice?.channelId === c.id;
    const ids = c.voiceUsers ?? [];
    li.className = (i === 0 ? 'fire-card' : 'voice-room') + (joined ? ' joined' : '');
    const streamer = ids.find((id) => state.voice?.channelId === c.id && state.sharing.get(id)?.screen);
    const sub = !ids.length ? 'Nobody here yet'
      : `${ids.length} gathered` + (streamer ? ` · ${nameOf(streamer)} is sharing` : '');
    li.innerHTML = i === 0
      ? `<div class="voice-room-name"><span class="fire-badge">${FIRE_ICON}</span><span class="fire-text"><span class="room-name">${escapeHtml(c.name)}</span><span class="fire-sub">${escapeHtml(sub)}</span></span>${c.private ? LOCK_ICON : ''}</div>`
      : `<div class="voice-room-name">${FIRE_ICON.replace('<svg', '<svg class="voice-icon"')}<span class="room-name">${escapeHtml(c.name)}</span>${c.private ? LOCK_ICON : ''}</div>`;
    if (can(s, 'rooms')) li.firstChild.append(roomSettingsButton(c));
    li.title = joined ? 'Show video' : 'Join voice';
    li.onclick = () => (joined ? openStage() : joinVoice(c.id));
    const people = ids.map((id) => {
      const name = s.members.find((m) => m.id === id)?.username ?? '?';
      const row = document.createElement('div');
      row.className = 'voice-person' + (state.speaking.has(id) ? ' speaking' : '');
      const av = document.createElement('span');
      av.className = 'avatar xs';
      setAvatar(av, name, avatarOf(id));
      const label = document.createElement('span');
      label.textContent = name;
      row.append(av, label);
      if (state.mutedInVoice.has(id)) row.insertAdjacentHTML('beforeend', MUTED_ICON);
      const sharing = joined ? state.sharing.get(id) : null;
      if (sharing?.camera) row.insertAdjacentHTML('beforeend', `<span class="cam-tag" title="Camera on">${CAMERA_ICON}</span>`);
      if (sharing?.screen) row.insertAdjacentHTML('beforeend', '<span class="live-tag" title="Sharing their screen">LIVE</span>');
      if (id !== state.me.id) {
        const v = volumeFor(id);
        if (v !== 1) row.insertAdjacentHTML('beforeend', `<span class="volume-tag">${Math.round(v * 100)}%</span>`);
        row.classList.add('adjustable');
        row.title = `${name}'s volume`;
        row.onclick = (e) => { e.stopPropagation(); openVolume(row, id, name); };
      }
      return row;
    });
    if (people.length) {
      const list = document.createElement('div');
      list.className = 'voice-people';
      list.append(...people);
      li.append(list);
    }
    if (i === 0) {
      const action = document.createElement('div');
      action.className = 'fire-action';
      action.textContent = joined ? "You're here" : state.voiceEnabled ? 'Join' : '';
      li.append(action);
    }
    return li;
  });
  $('#channel-list').replaceChildren(...textRooms);
  $('#fire-main').replaceChildren(...voiceRooms.slice(0, 1));
  $('#voice-list').replaceChildren(...voiceRooms.slice(1));
  $('#voice-section').classList.toggle('hidden', voiceRooms.length < 2);
  renderVoicePlaces();
}

async function selectChannel(id) {
  closeStage();
  // Files upload into a specific room, so switching rooms drops any not yet sent.
  if (id !== state.channelId && state.pending.length) {
    state.pending.forEach((p) => { p.xhr?.abort(); if (p.previewUrl) URL.revokeObjectURL(p.previewUrl); });
    state.pending = [];
    renderPending();
  }
  if (id !== state.channelId) setReply(null);
  state.channelId = id;
  state.unread.delete(id);
  state.lastChannel[state.serverId] = id;
  store.set('lastChannel', JSON.stringify(state.lastChannel));
  renderChannels();
  renderServers();
  const server = state.servers.get(state.serverId);
  const ch = server?.channels.find((c) => c.id === id);
  const title = isDm(server) ? partner(server).username : ch?.name ?? '';
  $('#channel-name').textContent = title;
  renderChannelSub();
  $('#composer-input').placeholder = !ch ? '' : isDm(server) ? `Message ${title}` : `Say something in ${title}`;
  $('#composer-input').disabled = !ch;
  $('#send-btn').disabled = !ch;
  state.messages = [];
  state.reachedStart = false;
  renderTyping();
  if (!ch) return renderMessages();
  const msgs = await api(`/api/channels/${id}/messages?limit=50`);
  if (state.channelId !== id) return;
  state.messages = msgs;
  state.reachedStart = msgs.length < 50;
  renderMessages({ stick: true });
  $('#composer-input').focus();
}

function renderMembers() {
  const s = state.servers.get(state.serverId);
  // Highest roles first, then by name.
  const members = [...(s?.members ?? [])].sort((a, b) => rankOf(s, a) - rankOf(s, b) || a.username.localeCompare(b.username));
  const section = (title, list) => {
    if (!list.length) return [];
    const h = document.createElement('h3');
    h.textContent = `${title} · ${list.length}`;
    const ul = document.createElement('ul');
    ul.append(
      ...list.map((m) => {
        const li = document.createElement('li');
        li.className = m.online ? 'online' : 'offline';
        const av = document.createElement('span');
        av.className = 'avatar';
        setAvatar(av, m.username, avatarOf(m.id, m.avatar));
        const name = document.createElement('span');
        name.textContent = m.username;
        const color = roleColor(s, m.id);
        if (color) name.style.color = color;
        li.append(av, name);
        if (m.id !== state.me.id) {
          li.classList.add('can-dm');
          li.title = `${m.username}: message, volume and more`;
          li.onclick = () => openPerson(s, m);
        }
        const top = rolesOf(s, m)[0];
        if (isHost(s, m.id) || top) {
          const badge = document.createElement('span');
          badge.className = 'owner-badge';
          if (isHost(s, m.id)) {
            badge.title = 'Created this burrow';
            badge.textContent = 'host';
          } else {
            badge.classList.add('role');
            badge.style.setProperty('--role', top.color);
            badge.title = rolesOf(s, m).map((r) => r.name).join(', ');
            badge.textContent = top.name;
          }
          li.append(badge);
        }
        if (canActOn(s, m)) {
          const more = iconButton('⋯', `Manage ${m.username}`, (e) => { e.stopPropagation(); openMemberMenu(s, m); });
          more.classList.add('member-more');
          // Before the badge, so badges stay lined up on the right.
          li.insertBefore(more, li.querySelector('.owner-badge'));
        }
        return li;
      }),
    );
    return [h, ul];
  };
  $('#member-list').replaceChildren(
    ...section('Around the fire', members.filter((m) => m.online)),
    ...section('Out in the woods', members.filter((m) => !m.online)),
  );
  renderChannelSub();
}

function renderChannelSub() {
  const s = state.servers.get(state.serverId);
  if (!s || !state.channelId) return ($('#channel-sub').textContent = '');
  if (isDm(s)) return ($('#channel-sub').textContent = `Direct message · ${partner(s).online ? 'around' : 'away'}`);
  const here = s.members.filter((m) => m.online).length;
  $('#channel-sub').textContent = `${s.name} · ${here} of ${s.members.length} around`;
}

// ---------------------------------------------------------------- messages

const messagesEl = $('#messages');
const GROUP_WINDOW = 7 * 60 * 1000;

function renderMessages({ stick = false } = {}) {
  const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
  const frag = document.createDocumentFragment();
  const server = state.servers.get(state.serverId);
  const ch = server?.channels.find((c) => c.id === state.channelId);
  if (ch && state.reachedStart) {
    const start = document.createElement('div');
    start.className = 'history-start';
    start.innerHTML = isDm(server)
      ? `<h2>This is the beginning of your conversation with ${escapeHtml(partner(server).username)}</h2>`
      : `<h2>This is the beginning of ${escapeHtml(ch.name)}</h2><div class="muted">Pull up a stump and say hello.</div>`;
    frag.append(start);
  }
  let prev = null;
  let body = null;
  for (const m of state.messages) {
    body = addMessageNodes(frag, m, prev, body);
    prev = m;
  }
  messagesEl.replaceChildren(frag);
  tailBody = body;
  if (stick || nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

// The last author group's message column, so a new message can join it without a redraw.
let tailBody = null;

// Adds message m (and a day divider or a new author group when it needs one) after prev.
// body is prev's group column; returns m's.
function addMessageNodes(parent, m, prev, body) {
  if (!prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString()) {
    const d = document.createElement('div');
    d.className = 'day-divider';
    const label = document.createElement('span');
    label.textContent = new Date(m.createdAt).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    d.append(label);
    parent.append(d);
    prev = null;
  }
  const grouped = prev && !m.replyTo && prev.authorId === m.authorId && m.createdAt - prev.createdAt < GROUP_WINDOW;
  if (!grouped) {
    const group = document.createElement('div');
    group.className = 'group' + (m.authorId === state.me.id ? ' mine' : '');
    const av = document.createElement('span');
    av.className = 'avatar lg';
    setAvatar(av, m.author, avatarOf(m.authorId, m.authorAvatar));
    body = document.createElement('div');
    const time = new Date(m.createdAt);
    const color = roleColor(state.servers.get(state.serverId), m.authorId);
    body.innerHTML = `<div class="head"><span class="author"${color ? ` style="color:${escapeHtml(color)}"` : ''}>${escapeHtml(m.author)}</span>
        <span class="time" title="${escapeHtml(time.toLocaleString())}">${escapeHtml(formatTime(time))}</span></div>`;
    group.append(av, body);
    parent.append(group);
  }
  body.append(renderLine(m));
  return body;
}

// How many messages a room keeps in memory while you follow along at the bottom;
// older ones load again when you scroll up.
const KEEP_MESSAGES = 300;

// Shows a message that just arrived (already pushed to state.messages) without redrawing the others.
function appendMessage(m, { stick = false } = {}) {
  const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
  const prev = state.messages.at(-2);
  if (state.messages.length > KEEP_MESSAGES + 100 && (stick || nearBottom)) {
    state.messages = state.messages.slice(-KEEP_MESSAGES);
    state.reachedStart = false;
    return renderMessages({ stick: true });
  }
  if (!prev || !tailBody?.isConnected) return renderMessages({ stick });
  tailBody = addMessageNodes(messagesEl, m, prev, tailBody);
  if (stick || nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

// Redraws one message after an edit or a reaction.
function refreshLine(id) {
  const m = state.messages.find((x) => x.id === id);
  const old = messagesEl.querySelector(`.line[data-id="${id}"]`);
  if (!m || !old) return;
  const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
  const line = renderLine(m);
  if (old.classList.contains('touched')) line.classList.add('touched');
  old.replaceWith(line);
  if (nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderLine(m) {
  const el = document.createElement('div');
  el.className = 'line';
  el.dataset.id = m.id;
  el.title = new Date(m.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (m.authorId !== state.me.id && (new RegExp('@' + escapeRegex(state.me.username) + '\\b', 'i').test(m.content) || m.replyTo?.authorId === state.me.id))
    el.classList.add('mentions-me');
  if (m.replyTo) el.append(renderReplyQuote(m.replyTo));
  const content = document.createElement('div');
  content.className = 'content';
  content.innerHTML = formatContent(m.content) + (m.editedAt ? ' <span class="edited">(edited)</span>' : '');
  if (!m.content && !m.editedAt) content.classList.add('hidden');
  el.append(content);
  if (m.attachments?.length) el.append(renderAttachments(m.attachments));
  if (m.reactions?.length) el.append(renderReactions(m));

  const actions = document.createElement('div');
  actions.className = 'actions';
  const reactBtn = iconButton('', 'Add reaction', (e) => openEmojiPicker(e.currentTarget, m));
  reactBtn.innerHTML = SMILE_ICON;
  const replyBtn = iconButton('', 'Reply', () => setReply(m));
  replyBtn.innerHTML = REPLY_ICON;
  actions.append(reactBtn, replyBtn);
  if (m.authorId === state.me.id) actions.append(iconButton('Edit', 'Edit message', () => startEdit(m, content)));
  if (m.authorId === state.me.id || can(state.servers.get(state.serverId), 'messages'))
    actions.append(iconButton('Delete', 'Delete message', () => confirmDelete(m)));
  el.append(actions);
  return el;
}

function startEdit(m, contentEl) {
  const ta = document.createElement('textarea');
  ta.className = 'edit';
  ta.value = m.content;
  ta.rows = Math.min(10, m.content.split('\n').length);
  const hint = document.createElement('div');
  hint.className = 'small muted';
  hint.textContent = 'Enter to save · Esc to cancel';
  contentEl.replaceWith(ta);
  ta.after(hint);
  ta.focus();
  const done = () => renderMessages();
  ta.onkeydown = async (e) => {
    if (e.key === 'Escape') return done();
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const content = ta.value.trim();
      if (!content) return confirmDelete(m);
      if (content !== m.content) await api(`/api/messages/${m.id}`, { method: 'PATCH', body: { content } }).catch(alertError);
      done();
    }
  };
}

function confirmDelete(m) {
  modal(`<h2>Delete message</h2><p>Are you sure you want to delete this message?</p>
    <div class="modal-row"><button class="btn secondary" data-close>Cancel</button><button class="btn danger" id="confirm-del">Delete</button></div>`);
  $('#confirm-del').onclick = async () => {
    closeModal();
    await api(`/api/messages/${m.id}`, { method: 'DELETE' }).catch(alertError);
  };
}

// Phones can't hover, so tapping a message shows its buttons.
messagesEl.addEventListener('click', (e) => {
  if (!isPhone() || e.target.closest('button, a, textarea, .att-image')) return;
  const line = e.target.closest('.line');
  messagesEl.querySelectorAll('.line.touched').forEach((l) => l !== line && l.classList.remove('touched'));
  line?.classList.toggle('touched');
});

messagesEl.addEventListener('scroll', async () => {
  if (messagesEl.scrollTop > 100 || state.reachedStart || state.loadingOlder || !state.messages.length) return;
  state.loadingOlder = true;
  const channelId = state.channelId;
  try {
    const older = await api(`/api/channels/${channelId}/messages?limit=50&before=${state.messages[0].id}`);
    if (channelId !== state.channelId) return;
    const prevHeight = messagesEl.scrollHeight;
    state.messages = [...older, ...state.messages];
    state.reachedStart = older.length < 50;
    renderMessages();
    messagesEl.scrollTop = messagesEl.scrollHeight - prevHeight + messagesEl.scrollTop;
  } finally {
    state.loadingOlder = false;
  }
});

// ---------------------------------------------------------------- composer & typing

const input = $('#composer-input');
let lastTypingSent = 0;

async function sendComposer() {
  const content = input.value.trim();
  const channelId = state.channelId;
  const files = state.pending;
  const replyTo = state.replyTo;
  if ((!content && !files.length) || !channelId) return;
  if (files.some((p) => p.error)) return alert('Remove the files that failed to upload first.');
  input.value = '';
  autosize();
  state.pending = [];
  renderPending();
  setReply(null);
  try {
    const attachmentIds = (await Promise.all(files.map((p) => p.done))).map((a) => a.id);
    files.forEach((p) => p.previewUrl && URL.revokeObjectURL(p.previewUrl));
    if (state.ws?.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'send', channelId, content, attachmentIds, replyTo: replyTo?.id }));
    } else {
      await api(`/api/channels/${channelId}/messages`, { method: 'POST', body: { content, attachmentIds, replyTo: replyTo?.id } });
    }
  } catch (err) {
    // Put everything back so nothing is lost.
    if (!input.value) input.value = content;
    state.pending = files.concat(state.pending);
    renderPending();
    if (replyTo && !state.replyTo) setReply(replyTo);
    alertError(err);
  }
  lastTypingSent = 0;
  input.focus();
}

// @mention suggestions: typing @ lists matching people in this burrow; Tab or Enter fills in the
// highlighted one, arrows move, Esc closes, and tapping a name works on phones.
const mentionBox = $('#mention-box');
let mention = null; // { start, matches, index } while the list is open

function updateMentions() {
  const s = state.servers.get(state.serverId);
  const before = input.value.slice(0, input.selectionStart);
  const hit = input.selectionStart === input.selectionEnd && /(^|\s)@([\w.-]*)$/.exec(before);
  if (!s || !hit) return closeMentions();
  const q = hit[2].toLowerCase();
  const matches = s.members
    .filter((m) => m.id !== state.me.id && m.username.toLowerCase().includes(q))
    .sort((a, b) => b.username.toLowerCase().startsWith(q) - a.username.toLowerCase().startsWith(q)
      || !!b.online - !!a.online || a.username.localeCompare(b.username))
    .slice(0, 8);
  if (!matches.length) return closeMentions();
  mention = { start: before.length - hit[2].length - 1, matches, index: 0 };
  renderMentions();
}

function renderMentions() {
  mentionBox.replaceChildren(...mention.matches.map((m, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mention-option' + (i === mention.index ? ' active' : '');
    const av = document.createElement('span');
    av.className = 'avatar xs';
    setAvatar(av, m.username, avatarOf(m.id, m.avatar));
    const name = document.createElement('span');
    name.textContent = m.username;
    b.append(av, name);
    b.onpointerdown = (e) => e.preventDefault(); // keep the keyboard up
    b.onclick = () => { mention.index = i; completeMention(); };
    return b;
  }));
  mentionBox.classList.remove('hidden');
}

function completeMention() {
  const m = mention.matches[mention.index];
  const after = input.value.slice(input.selectionStart).replace(/^[\w.-]*\s?/, '');
  const text = `${input.value.slice(0, mention.start)}@${m.username} `;
  input.value = text + after;
  input.setSelectionRange(text.length, text.length);
  closeMentions();
  autosize();
  input.focus();
}

function closeMentions() {
  mention = null;
  mentionBox.classList.add('hidden');
}

// Returns true when the key was for the suggestion list.
function mentionKey(e) {
  if (!mention || e.isComposing) return false;
  const n = mention.matches.length;
  if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) completeMention();
  else if (e.key === 'ArrowDown') { mention.index = (mention.index + 1) % n; renderMentions(); }
  else if (e.key === 'ArrowUp') { mention.index = (mention.index + n - 1) % n; renderMentions(); }
  else if (e.key === 'Escape') closeMentions();
  else return false;
  e.preventDefault();
  return true;
}

input.addEventListener('click', updateMentions);
input.addEventListener('blur', closeMentions);

$('#composer').addEventListener('submit', (e) => { e.preventDefault(); sendComposer(); });

input.addEventListener('keydown', (e) => {
  if (mentionKey(e)) return;
  if (e.key === 'Escape' && state.replyTo) {
    setReply(null);
  } else if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendComposer();
  } else if (e.key === 'ArrowUp' && !input.value) {
    const mine = [...state.messages].reverse().find((m) => m.authorId === state.me.id);
    const el = mine && messagesEl.querySelector(`.line[data-id="${mine.id}"] .content`);
    if (el) { e.preventDefault(); startEdit(mine, el); }
  }
});

input.addEventListener('input', () => {
  autosize();
  updateMentions();
  if (Date.now() - lastTypingSent > 3000 && input.value && state.ws?.readyState === WebSocket.OPEN) {
    lastTypingSent = Date.now();
    state.ws.send(JSON.stringify({ type: 'typing', channelId: state.channelId }));
  }
});

function autosize() {
  input.style.height = 'auto';
  input.style.height = input.scrollHeight + 'px';
}

function showTyping(channelId, username) {
  let m = state.typing.get(channelId);
  if (!m) state.typing.set(channelId, (m = new Map()));
  clearTimeout(m.get(username));
  m.set(username, setTimeout(() => clearTyping(channelId, username), 5000));
  renderTyping();
}

function clearTyping(channelId, username) {
  const m = state.typing.get(channelId);
  if (!m?.has(username)) return;
  clearTimeout(m.get(username));
  m.delete(username);
  renderTyping();
}

function renderTyping() {
  const names = [...(state.typing.get(state.channelId)?.keys() ?? [])];
  $('#typing').textContent =
    names.length === 0 ? '' :
    names.length === 1 ? `${names[0]} is typing…` :
    names.length <= 3 ? `${names.join(', ')} are typing…` : 'Several people are typing…';
}

// ---------------------------------------------------------------- modals

let onModalClose = null; // run once when the open modal goes away, however it's closed
function modal(html, kind = '') {
  const closing = onModalClose;
  onModalClose = null;
  closing?.();
  $('#modal-card').className = 'modal-card' + (kind ? ' ' + kind : '');
  $('#modal-card').innerHTML = html;
  $('#modal').classList.remove('hidden');
  $('#modal-card').querySelectorAll('[data-close]').forEach((b) => (b.onclick = closeModal));
  $('#modal-card').querySelector('input')?.focus();
}
function closeModal() {
  $('#modal').classList.add('hidden');
  const closing = onModalClose;
  onModalClose = null;
  closing?.();
}
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

function openAddServer(focus) {
  modal(`<h2>Find a burrow</h2>
    <p class="muted">A burrow is a shared space for a group of friends, with its own rooms.</p>
    <form id="create-form">
      <label>Dig a new one<input id="new-server-name" placeholder="e.g. Friday Night Crew" maxlength="64" required /></label>
      <button type="submit" class="btn">Create burrow</button>
    </form>
    <div class="or">or</div>
    <form id="join-form">
      <label>Join with an invite code<input id="invite-code" placeholder="e.g. a1B2c3D4" required /></label>
      <button type="submit" class="btn secondary">Join</button>
    </form>
    <div class="error" id="modal-error"></div>`);
  if (focus === 'join') $('#invite-code').focus();
  $('#create-form').onsubmit = async (e) => {
    e.preventDefault();
    try { addServer(await api('/api/servers', { method: 'POST', body: { name: $('#new-server-name').value } })); }
    catch (err) { $('#modal-error').textContent = err.message; }
  };
  $('#join-form').onsubmit = async (e) => {
    e.preventDefault();
    try { addServer(await api('/api/join', { method: 'POST', body: { inviteCode: $('#invite-code').value } })); }
    catch (err) { $('#modal-error').textContent = err.message; }
  };
}

function addServer(s) {
  rememberAvatars(s);
  if (!state.servers.has(s.id)) state.serverOrder.push(s.id);
  state.servers.set(s.id, s);
  closeModal();
  selectServer(s.id);
}

$('#empty-add').onclick = () => openAddServer();

$('#server-menu-btn').onclick = () => {
  const s = state.servers.get(state.serverId);
  if (!s) return;
  const owner = s.ownerId === state.me.id;
  modal(`<h2>${escapeHtml(s.name)}</h2>
    <label>Invite code: share it with friends
      <div class="invite-box"><input id="invite" readonly value="${escapeHtml(s.inviteCode)}" /><button class="btn" id="copy-invite">Copy</button></div>
    </label>
    <p class="small muted">They'll also need the server address: <b>${escapeHtml(state.serverUrl)}</b></p>
    ${can(s, 'roles') ? `<button class="btn secondary" id="open-roles">Roles${s.roles.length ? ` · ${s.roles.length}` : ''}</button>` : ''}
    ${can(s, 'ban') ? '<div id="ban-list"></div>' : ''}
    <div class="modal-row">
      <button class="btn danger" id="leave-server">${owner ? 'Delete burrow' : 'Leave burrow'}</button>
      <button class="btn secondary" data-close>Close</button>
    </div>`);
  if (can(s, 'ban')) renderBans(s);
  $('#open-roles')?.addEventListener('click', () => openRoles(s.id));
  $('#copy-invite').onclick = () => { navigator.clipboard?.writeText(s.inviteCode); $('#copy-invite').textContent = 'Copied!'; };
  $('#leave-server').onclick = async () => {
    if (owner && !confirm(`Delete "${s.name}" and all its messages for everyone?`)) return;
    try {
      await api(`/api/servers/${s.id}/leave`, { method: 'POST' });
      closeModal();
      state.servers.delete(s.id);
      state.serverOrder = state.serverOrder.filter((id) => id !== s.id);
      leaveVoiceIfGone();
      selectServer(state.serverOrder[0] ?? null);
    } catch (err) { alertError(err); }
  };
};

$('#add-channel').onclick = () => {
  if (state.inDms) return openNewDm();
  modal(`<h2>New room</h2>
    <form id="channel-form">
      <label>Room name<input id="new-channel-name" placeholder="e.g. game-night" maxlength="32" required /></label>
      ${state.voiceEnabled ? `<div class="kind-choice">
        <label><input type="radio" name="kind" value="text" checked /> Text room</label>
        <label><input type="radio" name="kind" value="voice" /> Voice room</label>
      </div>` : ''}
      ${privacyFields(state.servers.get(state.serverId), false, [])}
      <div class="error" id="modal-error"></div>
      <div class="modal-row"><button type="button" class="btn secondary" data-close>Cancel</button><button type="submit" class="btn">Create room</button></div>
    </form>`);
  wirePrivacyFields();
  $('#channel-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const kind = $('input[name="kind"]:checked')?.value ?? 'text';
      const s = await api(`/api/servers/${state.serverId}/channels`, {
        method: 'POST',
        body: { name: $('#new-channel-name').value, kind, ...readPrivacyFields() },
      });
      state.servers.set(s.id, s);
      closeModal();
      if (kind === 'voice') renderChannels();
      else selectChannel(s.channels[s.channels.length - 1].id);
    } catch (err) { $('#modal-error').textContent = err.message; }
  };
};

// ---------------------------------------------------------------- roles: host, moderators, private rooms

const LOCK_ICON = '<svg viewBox="0 0 24 24" class="lock-icon" aria-label="Private"><path d="M7 10V7a5 5 0 0 1 10 0v3h1a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h1Zm2 0h6V7a3 3 0 0 0-6 0v3Z"/></svg>';
const GEAR_ICON = '<svg viewBox="0 0 24 24"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm8.9 3-1.6-.4a7.4 7.4 0 0 0-.7-1.7l.9-1.4-1.9-1.9-1.4.9a7.4 7.4 0 0 0-1.7-.7L13 3.1h-2l-.4 1.7a7.4 7.4 0 0 0-1.7.7l-1.4-.9-1.9 1.9.9 1.4a7.4 7.4 0 0 0-.7 1.7l-1.7.4v2l1.7.4c.2.6.4 1.2.7 1.7l-.9 1.4 1.9 1.9 1.4-.9c.5.3 1.1.5 1.7.7l.4 1.7h2l.4-1.7c.6-.2 1.2-.4 1.7-.7l1.4.9 1.9-1.9-.9-1.4c.3-.5.5-1.1.7-1.7l1.6-.4v-2Z"/></svg>';

// Each burrow has its own roles, highest first. The host can do everything; everyone else
// gets what their roles allow, and can only act on people and roles below their highest role.
const PERMS = [
  ['rooms', 'Manage rooms', 'Add, change and delete rooms, and see every private room'],
  ['messages', 'Delete messages', "Delete other people's messages"],
  ['remove', 'Remove people', 'Take people out of the burrow (they can come back with the invite)'],
  ['ban', 'Ban people', "Remove people for good, and see and lift bans"],
  ['roles', 'Manage roles', 'Make, change and hand out the roles below their own'],
];
const ROLE_COLORS = ['#4f8a5b', '#2f7d74', '#3f6fa8', '#7a5aa6', '#b0527a', '#c2553d', '#c98a2b', '#8a8f87'];

const isHost = (s, id) => s?.ownerId === id && !isDm(s);
const rolesOf = (s, m) => (s?.roles ?? []).filter((r) => m?.roleIds?.includes(r.id));
/** Position of someone's highest role (lower is higher); the host is above everyone. */
const rankOf = (s, m) => (isHost(s, m?.id) ? 0 : Math.min(Infinity, ...rolesOf(s, m).map((r) => r.position)));
const me = (s) => s?.members.find((m) => m.id === state.me.id);
const can = (s, perm) => !!s && !isDm(s) && (isHost(s, state.me.id) || rolesOf(s, me(s)).some((r) => r.perms.includes(perm)));
/** The color someone's name shows in: their highest role's. */
const roleColor = (s, userId) => (isDm(s) ? null : rolesOf(s, s?.members.find((m) => m.id === userId))[0]?.color ?? null);
/** Whether the ⋯ menu has anything for this person. */
const canActOn = (s, m) => {
  if (can(s, 'roles') && (m.id === state.me.id || rankOf(s, m) > rankOf(s, me(s)))) return true;
  return m.id !== state.me.id && (can(s, 'remove') || can(s, 'ban')) && rankOf(s, m) > rankOf(s, me(s));
};

function leaveVoiceIfGone() {
  if (!state.voice) return;
  const stillThere = [...state.servers.values()].some((s) => s.channels.some((c) => c.id === state.voice.channelId));
  if (!stillThere) leaveVoice();
}

function roomSettingsButton(c) {
  const b = iconButton('', 'Room settings', (e) => { e.stopPropagation(); openRoomSettings(c); });
  b.classList.add('room-gear');
  b.innerHTML = GEAR_ICON;
  return b;
}

const roleDot = (color) => `<span class="role-dot" style="background:${escapeHtml(color)}"></span>`;

// The "private" checkbox and, under it, which roles and people get in. People who manage rooms always can.
function privacyFields(s, isPrivate, memberIds, roleIds = []) {
  const managers = (m) => isHost(s, m.id) || rolesOf(s, m).some((r) => r.perms.includes('rooms'));
  const people = s.members.filter((m) => !managers(m));
  const roles = s.roles ?? [];
  return `<label class="check"><input type="checkbox" id="room-private" ${isPrivate ? 'checked' : ''} /> Private room</label>
    <div id="room-access" class="${isPrivate ? '' : 'hidden'}">
      <p class="small muted">The host and anyone who can manage rooms can always see it. Who else can?</p>
      ${roles.length ? `<h4>Roles</h4><ul class="access-list" id="access-roles">${roles.map((r) => `<li><label class="check"><input type="checkbox" value="${r.id}" ${roleIds.includes(r.id) ? 'checked' : ''} /> ${roleDot(r.color)}${escapeHtml(r.name)}</label></li>`).join('')}</ul>` : ''}
      <h4>People</h4>
      ${people.length ? `<ul class="access-list" id="access-people">${people.map((m) => `<li><label class="check"><input type="checkbox" value="${m.id}" ${memberIds.includes(m.id) ? 'checked' : ''} /> ${escapeHtml(m.username)}</label></li>`).join('')}</ul>`
        : '<p class="small muted">Nobody else is in this burrow yet.</p>'}
    </div>`;
}
function wirePrivacyFields() {
  $('#room-private').onchange = (e) => $('#room-access').classList.toggle('hidden', !e.target.checked);
}
function readPrivacyFields() {
  const isPrivate = $('#room-private').checked;
  const checked = (sel) => (isPrivate ? [...document.querySelectorAll(`${sel} input:checked`)].map((i) => Number(i.value)) : []);
  return { private: isPrivate, memberIds: checked('#access-people'), roleIds: checked('#access-roles') };
}

function openRoomSettings(c) {
  const s = state.servers.get(state.serverId);
  modal(`<h2>Room settings</h2>
    <form id="room-form">
      <label>Room name<input id="room-name" maxlength="32" required value="${escapeHtml(c.name)}" /></label>
      ${privacyFields(s, c.private, c.memberIds ?? [], c.roleIds ?? [])}
      <div class="error" id="modal-error"></div>
      <div class="modal-row">
        <button type="button" class="btn danger" id="room-delete">Delete room</button>
        <span class="spacer"></span>
        <button type="button" class="btn secondary" data-close>Cancel</button>
        <button type="submit" class="btn">Save</button>
      </div>
    </form>`);
  wirePrivacyFields();
  $('#room-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const updated = await api(`/api/channels/${c.id}`, { method: 'PATCH', body: { name: $('#room-name').value, ...readPrivacyFields() } });
      state.servers.set(updated.id, updated);
      closeModal();
      renderChannels();
      if (c.id === state.channelId) $('#channel-name').textContent = updated.channels.find((x) => x.id === c.id)?.name ?? '';
    } catch (err) { $('#modal-error').textContent = err.message; }
  };
  $('#room-delete').onclick = async () => {
    if (!confirm(`Delete ${c.name} and everything said in it?`)) return;
    try {
      await api(`/api/channels/${c.id}`, { method: 'DELETE' });
      closeModal();
    } catch (err) { $('#modal-error').textContent = err.message; }
  };
}

function openMemberMenu(s, m) {
  const myRank = rankOf(s, me(s));
  const self = m.id === state.me.id;
  const above = rankOf(s, m) > myRank;
  const roles = s.roles ?? [];
  const editRoles = can(s, 'roles') && (self || above) && roles.length;
  const removable = !self && above;
  const current = rolesOf(s, m);
  modal(`<h2>${escapeHtml(m.username)}</h2>
    <p class="muted">${isHost(s, m.id) ? 'Host of' : current.length ? `${current.map((r) => escapeHtml(r.name)).join(', ')} in` : 'Member of'} ${escapeHtml(s.name)}</p>
    ${editRoles ? `<h4>Roles</h4><ul class="access-list" id="member-roles">${roles.map((r) => `<li><label class="check"><input type="checkbox" value="${r.id}" ${m.roleIds.includes(r.id) ? 'checked' : ''} ${r.position > myRank ? '' : 'disabled'} /> ${roleDot(r.color)}${escapeHtml(r.name)}</label></li>`).join('')}</ul>
      <button class="btn" id="member-save-roles">Save roles</button>` : ''}
    ${removable && can(s, 'remove') ? '<button class="btn secondary" id="member-remove">Remove from burrow</button>' : ''}
    ${removable && can(s, 'ban') ? '<button class="btn danger" id="member-ban">Ban from burrow</button>' : ''}
    ${removable && (can(s, 'remove') || can(s, 'ban')) ? `<p class="small muted">Removed people can come back with the invite code. Banned people can't, until they're unbanned in the burrow's settings.</p>` : ''}
    <div class="error" id="modal-error"></div>
    <div class="modal-row"><button class="btn secondary" data-close>Close</button></div>`);
  const act = async (path, body) => {
    try { await api(`/api/servers/${s.id}/members/${m.id}/${path}`, { method: 'POST', body }); closeModal(); }
    catch (err) { $('#modal-error').textContent = err.message; }
  };
  if (editRoles) $('#member-save-roles').onclick = () =>
    act('roles', { roleIds: [...document.querySelectorAll('#member-roles input:checked')].map((i) => Number(i.value)) });
  $('#member-remove')?.addEventListener('click', () => confirm(`Remove ${m.username} from ${s.name}?`) && act('remove', { ban: false }));
  $('#member-ban')?.addEventListener('click', () => confirm(`Ban ${m.username} from ${s.name}?`) && act('remove', { ban: true }));
}

async function renderBans(s) {
  const bans = await api(`/api/servers/${s.id}/bans`).catch(() => []);
  const el = $('#ban-list');
  if (!el) return;
  if (!bans.length) return (el.innerHTML = '');
  el.innerHTML = `<h3>Banned</h3><ul class="ban-list">${bans
    .map((b) => `<li><span>${escapeHtml(b.username)}</span><button class="btn secondary" data-unban="${b.id}">Unban</button></li>`)
    .join('')}</ul>`;
  el.querySelectorAll('[data-unban]').forEach((b) => (b.onclick = async () => {
    await api(`/api/servers/${s.id}/bans/${b.dataset.unban}`, { method: 'DELETE' }).catch(alertError);
    renderBans(s);
  }));
}

// The list of roles, highest first, with buttons to move them and open each one.
function openRoles(serverId) {
  const s = state.servers.get(serverId);
  if (!s) return closeModal();
  const myRank = rankOf(s, me(s));
  const counts = (r) => s.members.filter((m) => m.roleIds.includes(r.id)).length;
  modal(`<h2>Roles in ${escapeHtml(s.name)}</h2>
    <p class="small muted">Higher roles come first. People can only change roles below their own, and names show in their highest role's color.</p>
    <ul class="role-list">${s.roles.map((r, i) => {
      const mine = r.position > myRank;
      return `<li>
        ${roleDot(r.color)}<span class="role-name" style="color:${escapeHtml(r.color)}">${escapeHtml(r.name)}</span>
        <span class="small muted">${counts(r)} ${counts(r) === 1 ? 'person' : 'people'}</span>
        <span class="spacer"></span>
        ${mine ? `<button class="icon-btn" data-move="up" data-id="${r.id}" title="Move up" ${i === 0 || s.roles[i - 1].position <= myRank ? 'disabled' : ''}>▲</button>
        <button class="icon-btn" data-move="down" data-id="${r.id}" title="Move down" ${i === s.roles.length - 1 ? 'disabled' : ''}>▼</button>
        <button class="btn secondary" data-edit="${r.id}">Edit</button>` : ''}
      </li>`;
    }).join('')}</ul>
    ${s.roles.length ? '' : '<p class="muted">No roles yet.</p>'}
    <div class="error" id="modal-error"></div>
    <div class="modal-row"><button class="btn secondary" data-close>Close</button><button class="btn" id="role-new">New role</button></div>`);
  const refresh = (updated) => { state.servers.set(updated.id, updated); openRoles(serverId); };
  $('#modal-card').querySelectorAll('[data-move]').forEach((b) => (b.onclick = async () => {
    try { refresh(await api(`/api/roles/${b.dataset.id}`, { method: 'PATCH', body: { move: b.dataset.move } })); }
    catch (err) { $('#modal-error').textContent = err.message; }
  }));
  $('#modal-card').querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => openRoleEditor(serverId, Number(b.dataset.edit))));
  $('#role-new').onclick = () => openRoleEditor(serverId, null);
}

function openRoleEditor(serverId, roleId) {
  const s = state.servers.get(serverId);
  const role = s.roles.find((r) => r.id === roleId) ?? { name: '', color: ROLE_COLORS[s.roles.length % ROLE_COLORS.length], perms: [] };
  modal(`<h2>${roleId ? 'Edit role' : 'New role'}</h2>
    <form id="role-form">
      <label>Name<input id="role-name" maxlength="32" required value="${escapeHtml(role.name)}" placeholder="e.g. Admins" /></label>
      <label>Color</label>
      <div class="color-row">
        ${ROLE_COLORS.map((c) => `<button type="button" class="swatch" data-color="${c}" style="background:${c}" title="${c}"></button>`).join('')}
        <input type="color" id="role-color" value="${escapeHtml(role.color)}" title="Pick any color" />
        <span class="role-preview" id="role-preview">${escapeHtml(role.name || state.me.username)}</span>
      </div>
      <h4>What this role can do</h4>
      <ul class="perm-list">${PERMS.map(([key, label, hint]) => `<li><label class="check">
        <input type="checkbox" value="${key}" ${role.perms.includes(key) ? 'checked' : ''} ${can(s, key) ? '' : 'disabled'} />
        <span><b>${label}</b><br /><span class="small muted">${hint}</span></span></label></li>`).join('')}</ul>
      <p class="small muted">A role with nothing ticked is just a colored label, like "Friends".</p>
      <div class="error" id="modal-error"></div>
      <div class="modal-row">
        ${roleId ? '<button type="button" class="btn danger" id="role-delete">Delete role</button>' : ''}
        <span class="spacer"></span>
        <button type="button" class="btn secondary" id="role-back">Back</button>
        <button type="submit" class="btn">${roleId ? 'Save' : 'Create role'}</button>
      </div>
    </form>`);
  const preview = () => {
    $('#role-preview').style.color = $('#role-color').value;
    $('#role-preview').textContent = $('#role-name').value || state.me.username;
  };
  $('#role-name').oninput = preview;
  $('#role-color').oninput = preview;
  $('#modal-card').querySelectorAll('.swatch').forEach((b) => (b.onclick = () => { $('#role-color').value = b.dataset.color; preview(); }));
  preview();
  $('#role-back').onclick = () => openRoles(serverId);
  const done = (updated) => { state.servers.set(updated.id, updated); openRoles(serverId); };
  $('#role-form').onsubmit = async (e) => {
    e.preventDefault();
    const body = {
      name: $('#role-name').value,
      color: $('#role-color').value,
      perms: [...document.querySelectorAll('.perm-list input:checked')].map((i) => i.value),
    };
    try { done(await api(roleId ? `/api/roles/${roleId}` : `/api/servers/${serverId}/roles`, { method: roleId ? 'PATCH' : 'POST', body })); }
    catch (err) { $('#modal-error').textContent = err.message; }
  };
  $('#role-delete')?.addEventListener('click', async () => {
    if (!confirm(`Delete the ${role.name} role? Everyone who has it loses it.`)) return;
    try { done(await api(`/api/roles/${roleId}`, { method: 'DELETE' })); }
    catch (err) { $('#modal-error').textContent = err.message; }
  });
}

// ---------------------------------------------------------------- direct messages

const FIRE_ICON = '<svg viewBox="0 0 24 24"><path d="M12 2c.5 3 2.4 5 4.2 6.8A7.5 7.5 0 0 1 12 22a7.5 7.5 0 0 1-4.6-13.4c.2 1.6 1 2.9 2.3 3.6C9.6 8.5 10.4 5 12 2Z"/></svg>';
const CHEVRON_ICON = '<svg viewBox="0 0 24 24" class="chev"><path d="m6 9 6 6 6-6"/></svg>';
const STAR_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 24 24" class="check" aria-label="Current"><path d="M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6 11-11-1.4-1.4z"/></svg>';
const ROOM_ICON = '<svg viewBox="0 0 24 24" class="room-icon" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
function roomIcon() {
  const t = document.createElement('template');
  t.innerHTML = ROOM_ICON;
  return t.content.firstChild;
}
const CHAT_ICON = '<svg viewBox="0 0 24 24"><path d="M4 4h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9l-5 4V5a1 1 0 0 1 1-1Z" fill="currentColor"/></svg>';

const isDm = (s) => s?.kind === 'dm';
// The other person in a conversation.
const partner = (s) => s.members.find((m) => m.id !== state.me.id) ?? s.members[0];

function addDm(s) {
  rememberAvatars(s);
  state.servers.set(s.id, s);
  if (!state.dmOrder.includes(s.id)) state.dmOrder.unshift(s.id);
}

function openDms() {
  state.inDms = true;
  const last = Number(store.get('lastDm'));
  const id = state.dmOrder.includes(last) ? last : state.dmOrder[0] ?? null;
  selectServer(id);
}

async function openDm(userId) {
  try {
    let id = state.dmOrder.find((d) => partner(state.servers.get(d)).id === userId);
    if (!id) {
      const s = await api('/api/dms', { method: 'POST', body: { userId } });
      addDm(s);
      id = s.id;
    }
    closeModal();
    store.set('lastDm', id);
    selectServer(id);
    showView('chat');
  } catch (err) { alertError(err); }
}

function renderDmList() {
  const items = state.dmOrder.map((id) => {
    const s = state.servers.get(id);
    const p = partner(s);
    const li = document.createElement('li');
    li.className = 'dm' + (id === state.serverId ? ' active' : s.channels.some((c) => state.unread.has(c.id)) ? ' unread' : '');
    const av = document.createElement('span');
    av.className = 'avatar xs';
    setAvatar(av, p.username, avatarOf(p.id, p.avatar));
    const name = document.createElement('span');
    name.textContent = p.username;
    li.append(av, name);
    li.onclick = () => { store.set('lastDm', id); selectServer(id); showView('chat'); };
    return li;
  });
  if (!items.length) {
    const hint = document.createElement('li');
    hint.className = 'hint';
    hint.textContent = 'No conversations yet. Press + or click someone in a burrow\'s member list.';
    items.push(hint);
  }
  $('#channel-list').replaceChildren(...items);
  $('#voice-list').replaceChildren();
  $('#voice-section').classList.add('hidden');
}

// Pick someone you share a burrow with.
function openNewDm() {
  const people = new Map();
  for (const id of state.serverOrder)
    for (const m of state.servers.get(id).members) if (m.id !== state.me.id) people.set(m.id, m);
  const list = [...people.values()].sort((a, b) => a.username.localeCompare(b.username));
  modal(`<h2>New message</h2>
    ${list.length ? '<input id="dm-filter" placeholder="Find someone" />' : '<p class="muted">Join a burrow first. You can message anyone who shares one with you.</p>'}
    <ul class="people-picker" id="dm-people"></ul>
    <div class="modal-row"><button class="btn secondary" data-close>Close</button></div>`);
  const render = (q = '') => {
    $('#dm-people').replaceChildren(
      ...list.filter((m) => m.username.toLowerCase().includes(q.toLowerCase())).map((m) => {
        const li = document.createElement('li');
        const av = document.createElement('span');
        av.className = 'avatar';
        setAvatar(av, m.username, avatarOf(m.id, m.avatar));
        const name = document.createElement('span');
        name.textContent = m.username;
        li.append(av, name);
        li.onclick = () => openDm(m.id);
        return li;
      }),
    );
  };
  render();
  $('#dm-filter')?.addEventListener('input', (e) => render(e.target.value));
}

// ---------------------------------------------------------------- your account

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

function openAccount() {
  modal(`<h2>Your account</h2>
    ${state.maxUploadBytes ? `<div class="account-picture">
      <span class="avatar xl" id="account-avatar"></span>
      <div class="buttons">
        <div>
          <button type="button" class="btn secondary" id="avatar-pick">Upload picture</button>
          <button type="button" class="btn secondary" id="avatar-remove">Remove</button>
        </div>
        <span class="small muted">PNG, JPEG, GIF or WebP. It's cropped to a square.</span>
      </div>
      <input type="file" id="avatar-input" accept="image/png,image/jpeg,image/gif,image/webp" hidden />
    </div>
    <div class="error" id="avatar-error"></div>` : ''}
    ${themeSettings()}
    ${voiceSettings()}
    ${soundSettings()}
    <h3>Change password</h3>
    <form id="password-form">
      <input type="text" autocomplete="username" value="${escapeHtml(state.me.username)}" hidden />
      <label>Current password<input type="password" id="pw-current" autocomplete="current-password" required /></label>
      <label>New password<input type="password" id="pw-new" autocomplete="new-password" minlength="8" required /></label>
      <label>New password again<input type="password" id="pw-confirm" autocomplete="new-password" minlength="8" required /></label>
      <span class="small muted">This logs you out on your other devices.</span>
      <div class="error" id="pw-status"></div>
      <div class="modal-row"><button type="button" class="btn secondary" data-close>Close</button><button type="submit" class="btn">Change password</button></div>
    </form>`);
  wireThemeSettings();
  wireVoiceSettings();
  wireSoundSettings();
  if (state.maxUploadBytes) {
    setAvatar($('#account-avatar'), state.me.username, state.me.avatar);
    $('#avatar-remove').classList.toggle('hidden', !state.me.avatar);
    $('#avatar-pick').onclick = () => $('#avatar-input').click();
    $('#avatar-input').onchange = async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      $('#avatar-error').textContent = '';
      $('#avatar-pick').disabled = true;
      $('#avatar-pick').textContent = 'Uploading…';
      try { applyUser(await uploadAvatar(await squarePicture(file))); }
      catch (err) { $('#avatar-error').textContent = err.message; }
      finally { $('#avatar-pick').disabled = false; $('#avatar-pick').textContent = 'Upload picture'; }
    };
    $('#avatar-remove').onclick = async () => {
      try { applyUser(await api('/api/me/avatar', { method: 'DELETE' })); }
      catch (err) { $('#avatar-error').textContent = err.message; }
    };
  }
  $('#password-form').onsubmit = async (e) => {
    e.preventDefault();
    const status = (text, ok = false) => { $('#pw-status').textContent = text; $('#pw-status').className = ok ? 'success' : 'error'; };
    status('');
    if ($('#pw-new').value !== $('#pw-confirm').value) return status("The new passwords don't match");
    try {
      await api('/api/me/password', { method: 'POST', body: { currentPassword: $('#pw-current').value, newPassword: $('#pw-new').value } });
      e.target.reset();
      status('Password changed.', true);
    } catch (err) { status(err.message); }
  };
}

// Crops to the middle square and shrinks to 256 px, so pictures load fast everywhere.
// Small GIFs go up untouched to keep their animation.
async function squarePicture(file) {
  if (file.type === 'image/gif' && file.size <= MAX_AVATAR_BYTES) return file;
  let img;
  try { img = await createImageBitmap(file); }
  catch { throw new Error("That file doesn't look like a picture"); }
  const side = Math.min(img.width, img.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  canvas.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 256, 256);
  const encode = (type) => new Promise((resolve) => canvas.toBlob(resolve, type, 0.9));
  const webp = await encode('image/webp');
  return webp?.type === 'image/webp' ? webp : encode('image/png');
}

async function uploadAvatar(blob) {
  const res = await fetch(state.serverUrl + '/api/me/avatar', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + state.token, 'content-type': blob.type || 'application/octet-stream' },
    body: blob,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
  return data;
}

// ---------------------------------------------------------------- replies & reactions

const SMILE_ICON = '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16Zm-3.5-9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm7 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM12 17.5c2.3 0 4.3-1.4 5.1-3.5H6.9c.8 2.1 2.8 3.5 5.1 3.5Z"/></svg>';
const REPLY_ICON = '<svg viewBox="0 0 24 24"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11Z"/></svg>';
const EMOJI_CHOICES = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '🎉', '👀', '💯', '😍', '🤔', '😅', '🙌', '👏', '😎',
  '🥲', '😭', '🤣', '😡', '✅', '❌', '⭐', '🌲', '🍕', '☕', '🎮', '🏔️', '🦊', '🐻', '🍄', '👋'];

function setReply(m) {
  state.replyTo = m;
  const bar = $('#reply-bar');
  bar.classList.toggle('hidden', !m);
  if (m) {
    $('#reply-name').textContent = m.author;
    input.focus();
  }
}
$('#reply-cancel').onclick = () => setReply(null);

function renderReplyQuote(r) {
  const q = document.createElement('div');
  q.className = 'reply-quote';
  if (r.deleted) {
    q.innerHTML = '<span class="muted">Original message was deleted</span>';
    return q;
  }
  const snippet = r.content ? r.content.replace(/\s+/g, ' ') : (r.hasAttachments ? 'Sent a file' : '');
  q.innerHTML = `<span class="reply-author" style="color:${colorFor(r.author)}">@${escapeHtml(r.author)}</span><span class="reply-text">${escapeHtml(snippet)}</span>`;
  q.title = 'Jump to message';
  q.onclick = () => {
    const target = messagesEl.querySelector(`.line[data-id="${r.id}"]`);
    if (!target) return;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.classList.remove('flash');
    void target.offsetWidth;
    target.classList.add('flash');
  };
  return q;
}

function renderReactions(m) {
  const row = document.createElement('div');
  row.className = 'reactions';
  for (const r of m.reactions) {
    const b = document.createElement('button');
    b.className = 'reaction' + (r.userIds.includes(state.me.id) ? ' mine' : '');
    const server = state.servers.get(state.serverId);
    b.title = r.userIds.map((id) => server?.members.find((x) => x.id === id)?.username ?? 'someone').join(', ');
    b.innerHTML = `<span class="r-emoji">${escapeHtml(r.emoji)}</span><span class="r-count">${r.userIds.length}</span>`;
    b.onclick = () => toggleReaction(m, r.emoji);
    row.append(b);
  }
  const add = document.createElement('button');
  add.className = 'reaction add';
  add.title = 'Add reaction';
  add.innerHTML = SMILE_ICON;
  add.onclick = (e) => openEmojiPicker(e.currentTarget, m);
  row.append(add);
  return row;
}

function toggleReaction(m, emoji) {
  api(`/api/messages/${m.id}/reactions`, { method: 'POST', body: { emoji } })
    .then(({ reactions }) => { m.reactions = reactions; refreshLine(m.id); })
    .catch(alertError);
}

function openEmojiPicker(anchor, m) {
  closeEmojiPicker();
  const picker = document.createElement('div');
  picker.id = 'emoji-picker';
  picker.className = 'emoji-picker';
  for (const e of EMOJI_CHOICES) {
    const b = document.createElement('button');
    b.textContent = e;
    b.onclick = () => { closeEmojiPicker(); toggleReaction(m, e); };
    picker.append(b);
  }
  document.body.append(picker);
  const r = anchor.getBoundingClientRect();
  const w = picker.offsetWidth, h = picker.offsetHeight;
  picker.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) + 'px';
  picker.style.top = (r.top - h - 6 > 8 ? r.top - h - 6 : r.bottom + 6) + 'px';
  setTimeout(() => document.addEventListener('mousedown', outsidePicker), 0);
}
function outsidePicker(e) { if (!e.target.closest('#emoji-picker')) closeEmojiPicker(); }
function closeEmojiPicker() {
  $('#emoji-picker')?.remove();
  document.removeEventListener('mousedown', outsidePicker);
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeEmojiPicker(); });
messagesEl.addEventListener('scroll', closeEmojiPicker);

// ---------------------------------------------------------------- attachments

const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp|avif)$/;

function addFiles(fileList) {
  if (!state.maxUploadBytes || !state.channelId) return;
  const channelId = state.channelId;
  for (const file of fileList) {
    if (state.pending.length >= 10) { alert('You can attach up to 10 files at a time.'); break; }
    const shrinkable = SHRINKABLE_TYPES.test(file.type);
    // Photos are checked after shrinking, since most get well under the limit.
    if (file.size > state.maxUploadBytes && !shrinkable) {
      alert(`"${file.name}" is too big. Files can be at most ${formatSize(state.maxUploadBytes)}.`);
      continue;
    }
    const p = { file, previewUrl: IMAGE_TYPES.test(file.type) ? URL.createObjectURL(file) : null, progress: 0, error: null };
    p.done = (shrinkable ? shrinkPhoto(file) : Promise.resolve(file)).then((f) => {
      p.file = f;
      if (!state.pending.includes(p)) throw new Error('Upload cancelled');
      if (f.size > state.maxUploadBytes) {
        p.error = `Too big (at most ${formatSize(state.maxUploadBytes)})`;
        renderPending();
        throw new Error(`"${f.name}" is too big. Files can be at most ${formatSize(state.maxUploadBytes)}.`);
      }
      return uploadFile(channelId, p);
    });
    p.done.catch(() => {}); // failures show on the chip
    state.pending.push(p);
  }
  renderPending();
  input.focus();
}

// Photos bigger than this on their long side are scaled down before upload. GIFs are left alone (they may move).
const MAX_PHOTO_SIDE = 2560;
const SHRINKABLE_TYPES = /^image\/(png|jpeg|webp)$/;

// Phone photos are often 4-12 MB; scaled to 2560 px they look the same in chat at a fraction of the size.
// This also drops the photo's hidden details, like where it was taken. Keeps the original if that is smaller.
async function shrinkPhoto(file) {
  let img;
  try { img = await createImageBitmap(file); } catch { return file; }
  const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(img.width, img.height));
  if (scale === 1 && file.size < 1024 * 1024) return file;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  img.close();
  const encode = (type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  let blob = await encode('image/webp', 0.85);
  // Browsers that can't make WebP: JPEG for photos, PNG for anything that might be see-through.
  if (blob?.type !== 'image/webp') blob = file.type === 'image/jpeg' ? await encode('image/jpeg', 0.85) : await encode('image/png');
  if (!blob || blob.size >= file.size) return file;
  const ext = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' }[blob.type];
  const name = (file.name || 'pasted-image').replace(/\.[^.]*$/, '') + '.' + ext;
  return new File([blob], name, { type: blob.type });
}

function uploadFile(channelId, p) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    p.xhr = xhr;
    xhr.open('POST', `${state.serverUrl}/api/channels/${channelId}/attachments`);
    xhr.setRequestHeader('authorization', 'Bearer ' + state.token);
    xhr.setRequestHeader('content-type', p.file.type || 'application/octet-stream');
    xhr.setRequestHeader('x-filename', encodeURIComponent(p.file.name || 'pasted-image.png'));
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) { p.progress = e.loaded / e.total; renderPending(); } };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status === 200) { p.progress = 1; p.attachment = data; renderPending(); resolve(data); }
      else fail(new Error(data.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => fail(new Error("Couldn't upload " + p.file.name));
    xhr.onabort = () => reject(new Error('Upload cancelled'));
    function fail(err) { p.error = err.message; renderPending(); reject(err); }
    xhr.send(p.file);
  });
}

function renderPending() {
  const tray = $('#pending-files');
  tray.classList.toggle('hidden', !state.pending.length);
  tray.replaceChildren(...state.pending.map((p) => {
    const chip = document.createElement('div');
    chip.className = 'pending' + (p.error ? ' failed' : '');
    chip.title = p.error || p.file.name;
    chip.innerHTML = (p.previewUrl ? `<img src="${p.previewUrl}" alt="" />` : `<span class="file-icon">${FILE_ICON}</span>`)
      + `<span class="pending-name">${escapeHtml(p.file.name || 'image')}</span>`
      + `<span class="pending-meta">${p.error ? 'Failed' : p.progress < 1 ? Math.round(p.progress * 100) + '%' : formatSize(p.file.size)}</span>`
      + `<span class="bar" style="width:${p.error ? 0 : Math.round(p.progress * 100)}%"></span>`;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'pending-remove';
    x.title = 'Remove';
    x.textContent = '×';
    x.onclick = () => {
      p.xhr?.abort();
      if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
      state.pending = state.pending.filter((q) => q !== p);
      renderPending();
    };
    chip.append(x);
    return chip;
  }));
}

function renderAttachments(list) {
  const wrap = document.createElement('div');
  wrap.className = 'attachments';
  for (const a of list) {
    const url = state.serverUrl + a.url;
    if (IMAGE_TYPES.test(a.type)) {
      const img = document.createElement('img');
      img.className = 'att-image';
      img.src = url;
      img.alt = a.name;
      img.loading = 'lazy';
      img.onload = () => { if (messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 400) messagesEl.scrollTop = messagesEl.scrollHeight; };
      img.onclick = () => openImage(a, url);
      wrap.append(img);
    } else if (/^video\/(mp4|webm)$/.test(a.type)) {
      const v = document.createElement('video');
      v.className = 'att-video';
      v.src = url;
      v.controls = true;
      v.preload = 'metadata';
      wrap.append(v);
    } else if (/^audio\//.test(a.type)) {
      const au = document.createElement('audio');
      au.src = url;
      au.controls = true;
      wrap.append(au);
    } else {
      const card = document.createElement('a');
      card.className = 'att-file';
      card.href = url;
      card.target = '_blank';
      card.rel = 'noopener';
      card.innerHTML = `<span class="file-icon">${FILE_ICON}</span><span class="att-file-text"><span class="att-file-name">${escapeHtml(a.name)}</span><span class="muted small">${formatSize(a.size)}</span></span>`;
      wrap.append(card);
    }
  }
  return wrap;
}

function openImage(a, url) {
  modal(`<div class="lightbox"><img src="${escapeHtml(url)}" alt="${escapeHtml(a.name)}" />
    <div class="modal-row"><a class="btn secondary" href="${escapeHtml(url)}" target="_blank" rel="noopener">Open original</a><button class="btn" data-close>Close</button></div></div>`);
  $('#modal-card').classList.add('wide');
}

function formatSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return Math.round(n / 1024) + ' KB';
  return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
}

const FILE_ICON = '<svg viewBox="0 0 24 24"><path d="M6 2h8l6 6v14H6V2Zm8 1.5V9h5.5L14 3.5Z"/></svg>';

$('#attach-btn').onclick = () => $('#file-input').click();
$('#file-input').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
input.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (files.length) { e.preventDefault(); addFiles(files); }
});
const chatEl = $('.chat');
let dragDepth = 0;
chatEl.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files') && state.maxUploadBytes) { dragDepth++; chatEl.classList.add('dropping'); } });
chatEl.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; chatEl.classList.remove('dropping'); } });
chatEl.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
chatEl.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  chatEl.classList.remove('dropping');
  if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files);
});

// ---------------------------------------------------------------- voice rooms
//
// Audio goes through LiveKit, which runs next to the Burrow server. Burrow hands out
// a token for the room, and tells everyone in the burrow who has joined.

const SPEAKER_ICON = '<svg viewBox="0 0 24 24" class="voice-icon"><path d="M4 9h4l5-4v14l-5-4H4V9Zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4Zm-2.5-8.8v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6Z"/></svg>';
const MUTED_ICON = '<svg viewBox="0 0 24 24" class="muted-icon" aria-label="Muted"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm6-3a6 6 0 0 1-.6 2.6l1.5 1.5A8 8 0 0 0 20 11h-2ZM3.3 2 2 3.3l16.7 16.7 1.3-1.3L3.3 2ZM6 11H4a8 8 0 0 0 7 7.9V22h2v-3.1c.8-.1 1.5-.3 2.2-.6l-1.6-1.6A6 6 0 0 1 6 11Z"/></svg>';

let livekitLoading = null;
function loadLivekit() {
  if (window.LivekitClient) return Promise.resolve(window.LivekitClient);
  livekitLoading ??= new Promise((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = 'vendor/livekit-client.umd.js';
    tag.onload = () => resolve(window.LivekitClient);
    tag.onerror = () => { livekitLoading = null; reject(new Error("Couldn't load the voice library.")); };
    document.head.append(tag);
  });
  return livekitLoading;
}

async function joinVoice(channelId) {
  if (state.voice?.channelId === channelId) return;
  if (!state.voiceEnabled) return alert('Voice is not set up on this server yet.');
  leaveVoice(true);
  const voice = { channelId, room: null, muted: false };
  state.voice = voice;
  renderVoiceBar('Connecting…');
  try {
    const LK = await loadLivekit();
    const { url, token } = await api(`/api/channels/${channelId}/voice`, { method: 'POST' });
    if (state.voice !== voice) return;
    if (!LK.isE2EESupported()) throw new Error("this app can't encrypt voice. Update Burrow or use a current browser.");
    const quality = VOICE_QUALITY[voicePrefs.quality] ?? VOICE_QUALITY.high;
    const vc = await createVoiceCrypto(LK);
    voice.crypto = vc;
    const room = new LK.Room({
      // End-to-end encryption: the voice server only ever handles scrambled audio.
      e2ee: { keyProvider: vc.keys, worker: vc.worker },
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: voicePrefs.noiseSuppression, autoGainControl: voicePrefs.noiseSuppression },
      // Opus at a higher bitrate than LiveKit's 48 kbps default; silence still costs almost nothing (DTX).
      publishDefaults: { audioPreset: { maxBitrate: quality.bitrate }, dtx: true, red: true },
      // Mixing through Web Audio lets people be turned up past 100%.
      webAudioMix: true,
      // Only download video someone is looking at, at the size it's shown.
      adaptiveStream: true,
      dynacast: true,
    });
    voice.room = room;
    room
      .on(LK.RoomEvent.TrackSubscribed, (track, pub, participant) => {
        if (track.kind !== 'audio') return renderStage();
        const id = Number(participant.identity);
        const volume = pub.source === LK.Track.Source.ScreenShareAudio ? streamVolumeFor(id) : volumeFor(id);
        if (volume === 0) pub.setSubscribed(false); // muted by you
        else {
          $('#voice-audio').append(track.attach());
          participant.setVolume(volume, pub.source);
        }
        renderStage(); // a shared screen with sound gets a volume control
      })
      .on(LK.RoomEvent.TrackUnsubscribed, (track) => {
        if (track.kind !== 'audio') return renderStage();
        track.detach().forEach((el) => el.remove());
      })
      .on(LK.RoomEvent.TrackPublished, renderStage)
      .on(LK.RoomEvent.TrackUnpublished, renderStage)
      .on(LK.RoomEvent.LocalTrackPublished, renderStage)
      .on(LK.RoomEvent.LocalTrackUnpublished, (pub) => {
        if (pub.source === LK.Track.Source.ScreenShare) stopAppAudio(voice);
        renderStage();
        renderVoiceBar();
      })
      .on(LK.RoomEvent.ParticipantConnected, renderStage)
      .on(LK.RoomEvent.ActiveSpeakersChanged, (speakers) => {
        state.speaking = new Set(speakers.map((p) => Number(p.identity)));
        renderChannels();
        renderStage();
      })
      .on(LK.RoomEvent.TrackMuted, (pub, p) => (pub.kind === 'audio' && pub.source === LK.Track.Source.Microphone ? setMuted(p, true) : renderStage()))
      .on(LK.RoomEvent.TrackUnmuted, (pub, p) => (pub.kind === 'audio' && pub.source === LK.Track.Source.Microphone ? setMuted(p, false) : renderStage()))
      .on(LK.RoomEvent.Reconnecting, () => renderVoiceBar('Reconnecting…'))
      .on(LK.RoomEvent.Reconnected, () => renderVoiceBar())
      .on(LK.RoomEvent.Disconnected, () => { if (state.voice === voice) leaveVoice(); })
      .on(LK.RoomEvent.DataReceived, (payload, participant, kind, topic) => onCryptoMessage(voice, payload, participant, topic))
      .on(LK.RoomEvent.ParticipantDisconnected, (p) => { vc.pubs.delete(p.identity); keysChanged(voice); renderStage(); })
      .on(LK.RoomEvent.EncryptionError, (err) => console.warn('Voice encryption:', err?.message ?? err));
    await room.connect(url || state.serverUrl.replace(/^http/, 'ws'), token);
    await room.setE2EEEnabled(true);
    startKeyExchange(voice);
    await room.startAudio();
    await room.localParticipant.setMicrophoneEnabled(true);
    if (state.voice !== voice) return room.disconnect();
    state.ws?.send(JSON.stringify({ type: 'voice_join', channelId }));
    renderVoiceBar();
    playSound('join');
  } catch (err) {
    if (state.voice === voice) leaveVoice(true);
    const denied = err?.name === 'NotAllowedError' || /permission/i.test(err?.message ?? '');
    alert(denied ? 'Burrow needs microphone access for voice. Allow it in your system settings and try again.'
                 : `Couldn't join voice: ${err?.message || err}`);
  }
}

function setMuted(participant, muted) {
  const id = Number(participant.identity);
  if (muted) state.mutedInVoice.add(id);
  else state.mutedInVoice.delete(id);
  renderChannels();
}

// quiet: no leave sound, when switching rooms or when joining failed.
function leaveVoice(quiet) {
  const voice = state.voice;
  if (!voice) return;
  state.voice = null;
  if (quiet !== true) playSound('leave');
  state.speaking.clear();
  state.mutedInVoice.clear();
  state.sharing.clear();
  stopAppAudio(voice);
  voice.room?.disconnect();
  clearTimeout(voice.crypto?.retry);
  clearTimeout(voice.crypto?.grace);
  clearTimeout(voice.crypto?.rotateTimer);
  voice.crypto?.worker.terminate();
  closeVolume();
  closeStage();
  $('#voice-audio').replaceChildren();
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type: 'voice_leave' }));
  renderVoiceBar();
  renderChannels();
}

function toggleMute() {
  const voice = state.voice;
  if (!voice?.room) return;
  voice.muted = !voice.muted;
  voice.room.localParticipant.setMicrophoneEnabled(!voice.muted);
  if (voice.muted) state.mutedInVoice.add(state.me.id);
  else state.mutedInVoice.delete(state.me.id);
  renderVoiceBar();
  renderChannels();
}

function renderVoiceBar(status) {
  const voice = state.voice;
  $('#voice-bar').classList.toggle('hidden', !voice);
  renderVoicePlaces();
  if (!voice) return;
  const ch = [...state.servers.values()].flatMap((s) => s.channels).find((c) => c.id === voice.channelId);
  const sealed = voice.crypto?.index >= 0;
  $('#voice-status').textContent = status ?? (sealed ? 'Voice connected' : 'Securing voice…');
  $('#voice-status').classList.toggle('ok', !status && sealed);
  $('#voice-lock').classList.toggle('hidden', !!status || !sealed);
  $('#voice-room-name').textContent = ch?.name ?? '';
  $('#voice-mute').classList.toggle('on', voice.muted);
  $('#voice-mute').title = voice.muted ? 'Unmute' : 'Mute';
  const lp = voice.room?.localParticipant;
  const camera = !!lp?.isCameraEnabled, screen = !!lp?.isScreenShareEnabled;
  $('#voice-camera').classList.toggle('on', camera);
  $('#voice-camera').title = camera ? 'Turn off camera' : 'Turn on camera';
  $('#voice-screen').classList.toggle('on', screen);
  $('#voice-screen').title = screen ? 'Stop sharing your screen' : 'Share your screen';
  for (const id of ['#voice-camera', '#voice-screen', '#voice-watch']) $(id).disabled = !voice.room || !!status;
}

$('#voice-mute').onclick = toggleMute;
$('#voice-leave').onclick = () => leaveVoice();
$('#voice-camera').onclick = toggleCamera;
$('#voice-screen').onclick = toggleScreen;
$('#voice-watch').onclick = () => (state.stageOpen ? closeStage() : openStage());
$('#stage-close').onclick = () => closeStage();

// ---------------------------------------------------------------- camera and screen sharing
//
// Video goes through the same voice room, so it's end-to-end encrypted too. It shows on the
// "stage", which covers the chat while it's open. Only video on the stage is downloaded.

const CAMERA_ICON = '<svg viewBox="0 0 24 24"><path d="M4 6h11a2 2 0 0 1 2 2v1.5l4-2.5v10l-4-2.5V16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z"/></svg>';
const SCREEN_ICON = '<svg viewBox="0 0 24 24"><path d="M3 4h18a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-7v2h3v2H7v-2h3v-2H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm1 2v9h16V6H4Z"/></svg>';
const FULLSCREEN_ICON = '<svg viewBox="0 0 24 24" class="enter"><path d="M4 4h6v2H6v4H4V4Zm10 0h6v6h-2V6h-4V4ZM4 14h2v4h4v2H4v-6Zm14 0h2v6h-6v-2h4v-4Z"/></svg>';
const EXIT_FULLSCREEN_ICON = '<svg viewBox="0 0 24 24" class="exit"><path d="M8 4h2v6H4V8h4V4Zm6 0h2v4h4v2h-6V4ZM4 14h6v6H8v-4H4v-2Zm10 0h6v2h-4v4h-2v-6Z"/></svg>';
const tiles = new Map(); // "identity:camera" or "identity:screen" -> { el, track, video }
let focusKey = null;     // the tile shown big, if any

function nameOf(userId, fallback = '?') {
  for (const s of state.servers.values()) {
    const m = s.members.find((m) => m.id === userId);
    if (m) return m.username;
  }
  return fallback;
}

function mediaError(err, what) {
  if (err?.name === 'NotAllowedError') return `Burrow needs permission to use your ${what}. Allow it in your system settings and try again.`;
  if (err?.name === 'NotFoundError') return `No ${what} found.`;
  if (err?.name === 'NotReadableError') return `Your ${what} is busy. Close other apps using it and try again.`;
  return `Couldn't start your ${what}: ${err?.message || err}`;
}

async function toggleCamera() {
  const lp = state.voice?.room?.localParticipant;
  if (!lp) return;
  try {
    await lp.setCameraEnabled(!lp.isCameraEnabled, { resolution: window.LivekitClient.VideoPresets.h720.resolution });
    if (lp.isCameraEnabled) openStage(); // so you can see yourself
  } catch (err) {
    alert(mediaError(err, 'camera'));
  }
  renderVoiceBar();
  renderStage();
}

// How a screen share trades off when the connection or computer can't keep up. Both are 1080p.
// Smooth keeps the frame rate up (games, video) and lets the picture soften; sharp keeps
// text crisp and lets the frame rate drop. Picked in the desktop app's share picker.
const SHARE_MODES = {
  smooth: { encoding: { maxBitrate: 6_000_000, maxFramerate: 60, priority: 'high' }, hint: 'motion', degradation: 'maintain-framerate' },
  sharp: { encoding: { maxBitrate: 5_000_000, maxFramerate: 30, priority: 'high' }, hint: 'detail', degradation: 'maintain-resolution' },
};
let shareMode = SHARE_MODES[store.get('shareMode')] ? store.get('shareMode') : 'smooth';

/** Switches the screen being shared to the current mode. */
async function applyShareMode(lp) {
  const track = lp.getTrackPublication(window.LivekitClient.Track.Source.ScreenShare)?.track;
  if (!track) return;
  const mode = SHARE_MODES[shareMode];
  track.mediaStreamTrack.contentHint = mode.hint;
  await track.setDegradationPreference(mode.degradation);
  const sender = track.sender;
  if (!sender) return;
  const params = sender.getParameters();
  for (const enc of params.encodings ?? []) Object.assign(enc, { maxBitrate: mode.encoding.maxBitrate, maxFramerate: mode.encoding.maxFramerate });
  await sender.setParameters(params);
}

async function toggleScreen() {
  const voice = state.voice;
  const lp = voice?.room?.localParticipant;
  if (!lp) return;
  const starting = !lp.isScreenShareEnabled;
  // The desktop app on Windows shares only the picked program's sound, and adds it itself.
  const appAudio = window.burrowDesktop?.appAudio;
  // Made right on the click, so it's allowed to play.
  const audioContext = starting && appAudio ? new AudioContext({ sampleRate: 48000 }) : null;
  try {
    if (!starting) stopAppAudio(voice);
    const modeName = shareMode, mode = SHARE_MODES[modeName];
    // Captured at up to 60 fps either way, so the mode can still change in the desktop picker.
    await lp.setScreenShareEnabled(
      starting,
      { audio: !appAudio, systemAudio: 'include', selfBrowserSurface: 'exclude', contentHint: mode.hint, resolution: { width: 1920, height: 1080, frameRate: 60 } },
      // One full-size copy only: a second, smaller one would cost the sharer frames.
      { screenShareEncoding: mode.encoding, degradationPreference: mode.degradation, simulcast: false },
    );
    if (starting && shareMode !== modeName) await applyShareMode(lp).catch((err) => console.warn('Share mode:', err));
    if (starting && audioContext && lp.isScreenShareEnabled) {
      await startAppAudio(voice, audioContext).catch((err) => {
        console.warn('Program audio:', err);
        if (voice.appAudio?.context === audioContext) stopAppAudio(voice);
      });
    }
  } catch (err) {
    // Closing the picker without choosing anything is not an error.
    const cancelled = err?.name === 'NotAllowedError' && !/system/i.test(err.message ?? '');
    if (!cancelled && err?.name !== 'AbortError') alert(mediaError(err, 'screen'));
  } finally {
    if (audioContext && voice.appAudio?.context !== audioContext) audioContext.close().catch(() => {});
  }
  renderVoiceBar();
  renderStage();
}

// The shared program's sound arrives from the desktop app in chunks, and plays into a
// track of its own that goes out with the stream.
let appAudioPort = null;
window.burrowDesktop?.appAudio?.onChunk((chunk) => {
  if (!appAudioPort) return;
  const buffer = chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength ? chunk.buffer : chunk.slice().buffer;
  appAudioPort.postMessage(buffer, [buffer]);
});

async function startAppAudio(voice, context) {
  const LK = window.LivekitClient;
  await context.audioWorklet.addModule('app-audio-worklet.js');
  const node = new AudioWorkletNode(context, 'app-audio', { numberOfInputs: 0, outputChannelCount: [2] });
  const out = context.createMediaStreamDestination();
  out.channelCount = 2;
  node.connect(out);
  appAudioPort = node.port;
  voice.appAudio = { context, track: out.stream.getAudioTracks()[0] };
  const sharing = await window.burrowDesktop.appAudio.start();
  const lp = voice.room?.localParticipant;
  if (!sharing || voice.appAudio?.context !== context || state.voice !== voice || !lp?.isScreenShareEnabled) {
    if (voice.appAudio?.context === context) stopAppAudio(voice);
    return;
  }
  await lp.publishTrack(voice.appAudio.track, {
    source: LK.Track.Source.ScreenShareAudio,
    // Music quality in stereo; never cut out during quiet parts.
    audioPreset: { maxBitrate: 128_000 }, forceStereo: true, dtx: false, red: false,
  });
}

function stopAppAudio(voice) {
  const a = voice?.appAudio;
  if (!a) return;
  voice.appAudio = null;
  appAudioPort = null;
  window.burrowDesktop?.appAudio?.stop();
  const lp = voice.room?.localParticipant;
  if (lp && [...lp.trackPublications.values()].some((pub) => pub.track?.mediaStreamTrack === a.track)) {
    lp.unpublishTrack(a.track).catch(() => {});
  }
  a.track.stop();
  a.context.close().catch(() => {});
}

/** Full screen for one tile. iPhones can only show a video itself full screen. */
function toggleFullscreen(t) {
  if (document.fullscreenElement) return document.exitFullscreen().catch(() => {});
  if (t.el.requestFullscreen) return t.el.requestFullscreen().catch(() => {});
  t.media?.webkitEnterFullscreen?.();
}
document.addEventListener('fullscreenchange', () => {
  const el = document.fullscreenElement;
  for (const t of tiles.values()) t.el.querySelector('.vtile-full').title = t.el === el ? 'Exit full screen (Esc)' : 'Full screen';
  if (!el) renderStage(); // put the tiles back in order
});

function openStage() {
  if (!state.voice?.room) return;
  state.stageOpen = true;
  $('#stage').classList.remove('hidden');
  $('#app').classList.add('watching');
  renderVoicePlaces();
  renderStage();
}

function closeStage() {
  if (!state.stageOpen) return;
  state.stageOpen = false;
  focusKey = null;
  $('#stage').classList.add('hidden');
  $('#app').classList.remove('watching');
  renderVoicePlaces();
  renderStage();
}

function renderStage() {
  const room = state.voice?.room;
  const LK = window.LivekitClient;
  if (!LK) return;
  const people = room ? [room.localParticipant, ...room.remoteParticipants.values()] : [];
  const showing = (p, source) => {
    const pub = p.getTrackPublication(source);
    return pub && !pub.isMuted ? pub : null;
  };

  // Who's on camera or sharing, for the sidebar.
  const sharing = new Map();
  for (const p of people) {
    const camera = !!showing(p, LK.Track.Source.Camera), screen = !!showing(p, LK.Track.Source.ScreenShare);
    if (camera || screen) sharing.set(Number(p.identity), { camera, screen });
  }
  const others = [...sharing.keys()].some((id) => id !== state.me?.id);
  $('#voice-watch').classList.toggle('has-video', others && !state.stageOpen);
  $('#voice-watch').classList.toggle('on', state.stageOpen);
  $('#voice-watch').title = state.stageOpen ? 'Back to chat' : 'Show video';
  if (JSON.stringify([...sharing]) !== JSON.stringify([...state.sharing])) {
    state.sharing = sharing;
    renderChannels();
  }

  // Off stage, let go of every video so none of it is downloaded.
  const wanted = [];
  if (state.stageOpen && room) {
    const ch = [...state.servers.values()].flatMap((s) => s.channels).find((c) => c.id === state.voice.channelId);
    $('#stage-title').textContent = ch?.name ?? 'Voice';
    for (const p of people) {
      const id = Number(p.identity);
      const me = p === room.localParticipant;
      const name = nameOf(id, p.name || '?');
      const screen = showing(p, LK.Track.Source.ScreenShare);
      if (screen) wanted.push({ key: `${id}:screen`, id, track: screen.track ?? null, label: me ? 'Your screen' : `${name}'s screen`, icon: SCREEN_ICON, kind: 'screen', audio: !me && !!p.getTrackPublication(LK.Track.Source.ScreenShareAudio) });
      const camera = showing(p, LK.Track.Source.Camera);
      wanted.push({ key: `${id}:camera`, id, track: camera?.track ?? null, label: me ? `${name} (you)` : name, kind: 'camera', mirror: me, name });
    }
  }
  if (focusKey && !wanted.some((w) => w.key === focusKey)) focusKey = null;

  for (const [key, t] of tiles) {
    if (wanted.some((w) => w.key === key)) continue;
    if (t.track && t.media) t.track.detach(t.media);
    tiles.delete(key);
  }
  for (const w of wanted) {
    let t = tiles.get(w.key);
    if (!t) {
      const el = document.createElement('div');
      el.onclick = () => {
        if (document.fullscreenElement) return;
        focusKey = focusKey === w.key ? null : w.key;
        renderStage();
      };
      const label = document.createElement('div');
      label.className = 'vtile-name';
      const full = document.createElement('button');
      full.type = 'button';
      full.className = 'vtile-full';
      full.title = 'Full screen';
      full.innerHTML = FULLSCREEN_ICON + EXIT_FULLSCREEN_ICON;
      el.append(label, full);
      t = { el, label, track: undefined, media: null, audio: null };
      full.onclick = (e) => { e.stopPropagation(); toggleFullscreen(t); };
      el.ondblclick = () => toggleFullscreen(t);
      tiles.set(w.key, t);
    }
    if (t.track !== w.track) {
      if (t.track && t.media) t.track.detach(t.media);
      t.media?.remove();
      if (w.track) {
        t.media = w.track.attach();
        t.media.muted = true; // sound comes through the voice mix
        // Size the enlarged tile to the video, so there are no black bars around it.
        const fit = () => { if (t.media.videoWidth) t.el.style.setProperty('--ar', t.media.videoWidth / t.media.videoHeight); };
        t.media.addEventListener('resize', fit);
        t.media.addEventListener('loadedmetadata', fit);
      } else {
        t.media = document.createElement('span');
        t.media.className = 'avatar lg';
        setAvatar(t.media, w.name ?? '?', avatarOf(w.id));
        t.el.style.removeProperty('--ar');
      }
      t.el.prepend(t.media);
      t.track = w.track;
    }
    if (w.audio && !t.audio) t.audio = streamAudioControl(w.id, t.el);
    if (!w.audio && t.audio) { t.audio.remove(); t.audio = null; }
    t.label.innerHTML = `${w.icon ?? ''}<span>${escapeHtml(w.label)}</span>${state.mutedInVoice.has(w.id) && w.kind === 'camera' ? MUTED_ICON : ''}`;
    t.el.className = 'vtile ' + w.kind
      + (w.mirror && w.track ? ' mirror' : '')
      + (w.kind === 'camera' && state.speaking.has(w.id) ? ' speaking' : '')
      + (focusKey === w.key ? ' focus' : '');
    t.el.classList.toggle('no-video', !w.track);
    t.el.title = focusKey === w.key ? 'Click to shrink, double-click for full screen' : 'Click to make bigger, double-click for full screen';
  }
  const order = wanted.map((w) => tiles.get(w.key).el);
  const focused = order.find((el) => el.classList.contains('focus'));
  const grid = $('#stage-grid');
  const next = focused ? [focused, ...order.filter((el) => el !== focused)] : order;
  // Moving a tile that's full screen would drop it out of full screen, so while one is,
  // tiles only come and go; the order catches up afterwards.
  if (document.fullscreenElement && grid.contains(document.fullscreenElement)) {
    for (const el of [...grid.children]) if (!next.includes(el)) el.remove();
    for (const el of next) if (el.parentNode !== grid) grid.append(el);
  } else if (next.length !== grid.children.length || next.some((el, i) => grid.children[i] !== el)) {
    grid.replaceChildren(...next);
  }
  grid.classList.toggle('focused', !!focused);
  $('#stage-grid').classList.toggle('solo', !!focused && order.length === 1);
}

// How loud someone's shared screen is, for you only: 0% (muted) to 200%. Kept on this device.
// Streams start muted until you turn them up; whatever you pick for someone is remembered.
const streamVolumes = (() => { try { return JSON.parse(store.get('streamVolumes')) ?? {}; } catch { return {}; } })();
const streamVolumeFor = (userId) => streamVolumes[userId] ?? 0;

function setStreamVolume(userId, value) {
  if (value === 0) delete streamVolumes[userId];
  else streamVolumes[userId] = value;
  store.set('streamVolumes', JSON.stringify(streamVolumes));
  const p = state.voice?.room?.remoteParticipants.get(String(userId));
  if (p) applyVolume(p, window.LivekitClient.Track.Source.ScreenShareAudio, value);
}

/**
 * Sets how loud one of someone's sounds is. LiveKit forgets a volume of 0 whenever it rebuilds its
 * audio, so silence means not receiving that sound at all, which also saves the download.
 */
function applyVolume(participant, source, value) {
  const pub = participant.getTrackPublication(source);
  if (value === 0) return pub?.setSubscribed(false);
  if (pub && !pub.isSubscribed) pub.setSubscribed(true); // the volume is set again when it arrives
  participant.setVolume(value, source);
}

const SPEAKER_ON = '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4V9Zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4Zm-2.5-8.8v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6Z"/></svg>';
const SPEAKER_OFF = '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4V9Zm12.6 3 2.7-2.7-1.4-1.4-2.7 2.7-2.7-2.7-1.4 1.4 2.7 2.7-2.7 2.7 1.4 1.4 2.7-2.7 2.7 2.7 1.4-1.4-2.7-2.7Z"/></svg>';

/** The mute button and slider on a shared screen that has sound. */
function streamAudioControl(userId, tile) {
  const box = document.createElement('div');
  box.className = 'stream-audio';
  box.innerHTML = '<button type="button"></button><input type="range" min="0" max="200" step="5" aria-label="Stream volume" /><span></span>';
  const [button, slider, readout] = box.children;
  let before = 1; // what unmuting goes back to
  const show = () => {
    const v = streamVolumeFor(userId);
    slider.value = Math.round(v * 100);
    readout.textContent = `${Math.round(v * 100)}%`;
    button.innerHTML = v === 0 ? SPEAKER_OFF : SPEAKER_ON;
    button.title = v === 0 ? 'Unmute the stream' : 'Mute the stream';
    box.classList.toggle('muted', v === 0);
  };
  box.onclick = (e) => e.stopPropagation(); // don't enlarge or shrink the tile
  box.ondblclick = (e) => e.stopPropagation();
  button.onclick = () => {
    const v = streamVolumeFor(userId);
    if (v > 0) before = v;
    setStreamVolume(userId, v > 0 ? 0 : before || 1);
    show();
  };
  slider.oninput = () => { setStreamVolume(userId, Number(slider.value) / 100); show(); };
  show();
  tile.append(box);
  return box;
}

// The desktop app can't show the browser's screen picker, so it asks us to show one.
window.burrowDesktop?.onPickScreen((sources) => {
  let picked = false;
  modal(`<h2>Share your screen</h2>
    <p class="muted small">Pick a whole screen or one window.${window.burrowDesktop.appAudio ? ' A window shares only its own sound.' : ''}</p>
    <div class="kind-choice">
      <label title="60 frames a second. Best for games and video."><input type="radio" name="share-mode" value="smooth" ${shareMode === 'smooth' ? 'checked' : ''} /> Smooth motion</label>
      <label title="Keeps text crisp. Best for documents and code."><input type="radio" name="share-mode" value="sharp" ${shareMode === 'sharp' ? 'checked' : ''} /> Sharp text</label>
    </div>
    <div class="screen-picker"></div>
    <div class="modal-row"><button class="btn secondary" data-close>Cancel</button></div>`);
  // Remembered for next time too.
  for (const r of document.querySelectorAll('#modal-card [name="share-mode"]')) r.onchange = () => { shareMode = r.value; store.set('shareMode', r.value); };
  const grid = $('#modal-card .screen-picker');
  for (const src of sources) {
    const b = document.createElement('button');
    b.type = 'button';
    const img = document.createElement('img');
    img.src = src.thumbnail;
    img.alt = '';
    const label = document.createElement('span');
    label.textContent = src.name;
    b.append(img, label);
    b.onclick = () => { picked = true; window.burrowDesktop.pickedScreen(src.id); closeModal(); };
    grid.append(b);
  }
  onModalClose = () => { if (!picked) window.burrowDesktop.pickedScreen(null); };
});

// ---------------------------------------------------------------- end-to-end encrypted voice
//
// Audio is encrypted on your device and only decrypted by the others in the room, so the
// voice server (and anyone who gets into it) only ever handles scrambled audio.
//
// Each person makes a fresh key pair when they join and announces the public half. Whoever has
// been in the room longest makes the room key and sends it to each person, sealed with a key only
// the two of them can work out (ECDH P-256, then AES-GCM). They make a new room key whenever
// someone joins or leaves, so newcomers can't decode what came before and leavers can't decode
// what comes after. The server passes these messages along but can't open them.
//
// The key keeper only hands keys to people still in the burrow, so someone who's removed can't
// decode anything new even if they stay connected to the voice server.

const E2EE_TOPIC = 'burrow-e2ee';
const KEYRING_SIZE = 16; // LiveKit keeps this many room keys, so audio sealed with the last one still plays
const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

// Started from a Blob, since browsers won't start workers from local files (the desktop app).
let workerSourceLoading = null;
async function e2eeWorker() {
  workerSourceLoading ??= new Promise((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = 'vendor/livekit-client.e2ee.worker.source.js';
    tag.onload = () => resolve(URL.createObjectURL(new Blob([window.LivekitE2EEWorkerSource], { type: 'text/javascript' })));
    tag.onerror = () => { workerSourceLoading = null; reject(new Error("Couldn't load voice encryption.")); };
    document.head.append(tag);
  });
  return new Worker(await workerSourceLoading);
}

async function createVoiceCrypto(LK) {
  class RoomKeys extends LK.BaseKeyProvider {
    constructor() { super({ sharedKey: true, ratchetWindowSize: 0, failureTolerance: -1, keyringSize: KEYRING_SIZE }); }
    async use(raw, index) { this.onSetEncryptionKey(await LK.createKeyMaterialFromBuffer(raw), undefined, index); }
  }
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']);
  return {
    pair,
    pub: toB64(await crypto.subtle.exportKey('raw', pair.publicKey)),
    pubs: new Map(), // identity -> their public key, for everyone else in the room
    keys: new RoomKeys(),
    worker: await e2eeWorker(),
    index: -1, // which room key we're on; -1 until we have one
  };
}

/** The AES key only we and the owner of `theirPub` can work out. */
async function pairKey(vc, theirPub) {
  const theirs = await crypto.subtle.importKey('raw', fromB64(theirPub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  return crypto.subtle.deriveKey({ name: 'ECDH', public: theirs }, vc.pair.privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function sendCrypto(voice, message, to) {
  // Say who it's from: a newcomer's first message can arrive before LiveKit has told the others about them.
  const data = new TextEncoder().encode(JSON.stringify({ ...message, from: voice.room.localParticipant.identity }));
  voice.room.localParticipant.publishData(data, { reliable: true, topic: E2EE_TOPIC, ...(to ? { destinationIdentities: [to] } : {}) }).catch(() => {});
}

/**
 * The person who hands out room keys: whoever joined first, out of the people taking part in the
 * key exchange. Someone on an app from before encryption never answers, so they can't be keeper.
 */
function isKeyKeeper(voice) {
  const room = voice.room;
  const joined = (identity) => (identity === room.localParticipant.identity ? room.localParticipant : room.remoteParticipants.get(identity))?.joinedAt?.getTime() ?? Infinity;
  const keeper = [room.localParticipant.identity, ...voice.crypto.pubs.keys()]
    .sort((a, b) => joined(a) - joined(b) || Number(a) - Number(b))[0];
  return keeper === room.localParticipant.identity;
}

function startKeyExchange(voice) {
  const vc = voice.crypto;
  if (!voice.room.remoteParticipants.size) return keysChanged(voice);
  sendCrypto(voice, { t: 'hello', pub: vc.pub });
  // If nobody hands us a key (everyone here is on an old app, or the keeper just left), we
  // become the keeper. Until then keep asking, in case a message went missing.
  vc.grace = setTimeout(() => { if (vc.index < 0) keysChanged(voice); }, 1500);
  const retry = () => {
    if (state.voice !== voice || vc.index >= 0) return;
    sendCrypto(voice, { t: 'hello', pub: vc.pub });
    vc.retry = setTimeout(retry, 1500);
  };
  vc.retry = setTimeout(retry, 1500);
}

const voiceServer = () => [...state.servers.values()].find((s) => s.channels.some((c) => c.id === state.voice?.channelId));

/** Someone came or went: if we're the key keeper, make a new room key and hand it out. */
function keysChanged(voice) {
  const vc = voice.crypto;
  renderVoiceBar();
  if (!voice.room || !isKeyKeeper(voice)) return;
  clearTimeout(vc.rotateTimer);
  // A short wait gathers people joining at the same time into one new key.
  vc.rotateTimer = setTimeout(async () => {
    if (state.voice !== voice) return;
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const index = (vc.index + 1) % KEYRING_SIZE;
    const members = new Set(voiceServer()?.members.map((m) => String(m.id)) ?? []);
    for (const [identity, pub] of vc.pubs) {
      if (!members.has(identity)) continue; // removed from the burrow: no more keys, even if still connected
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const sealed = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`${index}:${identity}`) },
        await pairKey(vc, pub),
        raw,
      );
      sendCrypto(voice, { t: 'key', index, iv: toB64(iv), key: toB64(sealed), pub: vc.pub }, identity);
    }
    await vc.keys.use(raw.buffer, index);
    vc.index = index;
    renderVoiceBar();
  }, 250);
}

async function onCryptoMessage(voice, payload, participant, topic) {
  const vc = voice.crypto;
  if (topic !== E2EE_TOPIC || state.voice !== voice) return;
  let msg;
  try { msg = JSON.parse(new TextDecoder().decode(payload)); } catch { return; }
  const from = participant?.identity ?? msg.from;
  if (typeof from !== 'string' || from === voice.room.localParticipant.identity) return;
  if ((msg.t === 'hello' || msg.t === 'pub') && typeof msg.pub === 'string') {
    vc.pubs.set(from, msg.pub);
    if (msg.t === 'hello') sendCrypto(voice, { t: 'pub', pub: vc.pub }, from);
    keysChanged(voice);
  } else if (msg.t === 'key') {
    try {
      if (!vc.pubs.has(from)) vc.pubs.set(from, msg.pub);
      const raw = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromB64(msg.iv), additionalData: new TextEncoder().encode(`${msg.index}:${voice.room.localParticipant.identity}`) },
        await pairKey(vc, vc.pubs.get(from)),
        fromB64(msg.key),
      );
      await vc.keys.use(raw, Number(msg.index) % KEYRING_SIZE);
      vc.index = Number(msg.index) % KEYRING_SIZE;
      clearTimeout(vc.retry);
      clearTimeout(vc.grace);
      renderVoiceBar();
    } catch (err) {
      console.warn("Couldn't open a voice key from", from, err);
    }
  }
}

// ---------------------------------------------------------------- volume and sounds
//
// Each person's voice volume is your own setting, kept on this device: 0% to 200%.

const volumes = (() => { try { return JSON.parse(store.get('volumes')) ?? {}; } catch { return {}; } })();
const volumeFor = (userId) => volumes[userId] ?? 1;

function setVolume(userId, value) {
  if (value === 1) delete volumes[userId];
  else volumes[userId] = value;
  store.set('volumes', JSON.stringify(volumes));
  const p = state.voice?.room?.remoteParticipants.get(String(userId));
  if (p) applyVolume(p, window.LivekitClient.Track.Source.Microphone, value);
}

function openVolume(anchor, userId, name) {
  closeVolume();
  const pop = document.createElement('div');
  pop.className = 'volume-pop';
  pop.id = 'volume-pop';
  const pct = Math.round(volumeFor(userId) * 100);
  pop.innerHTML = `<div class="volume-head"><b>${escapeHtml(name)}</b><span id="volume-value">${pct}%</span></div>
    <input type="range" id="volume-range" min="0" max="200" step="5" value="${pct}" aria-label="${escapeHtml(name)}'s volume" />
    <div class="volume-foot"><span class="small muted">Only changes it for you</span><button class="link-btn" id="volume-reset">Reset</button></div>`;
  pop.onclick = (e) => e.stopPropagation();
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)}px`;
  pop.style.top = `${Math.min(r.bottom + 6, window.innerHeight - pop.offsetHeight - 8)}px`;
  const apply = (value) => {
    $('#volume-range').value = value;
    $('#volume-value').textContent = `${value}%`;
    setVolume(userId, value / 100);
  };
  $('#volume-range').oninput = (e) => apply(Number(e.target.value));
  $('#volume-range').onchange = () => renderChannels();
  $('#volume-reset').onclick = () => { apply(100); renderChannels(); };
  $('#volume-range').focus();
}
function closeVolume() { $('#volume-pop')?.remove(); }
document.addEventListener('click', closeVolume);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeVolume(); });

// Short chimes made on the fly, so there are no sound files to ship.
const soundPrefs = (() => {
  const defaults = { messages: true, voice: true, volume: 0.5 };
  try { return { ...defaults, ...JSON.parse(store.get('sounds')) }; } catch { return defaults; }
})();
const saveSoundPrefs = () => store.set('sounds', JSON.stringify(soundPrefs));
const SOUNDS = {
  // [frequency, start, length] in Hz and seconds
  message: { pref: 'messages', notes: [[987.8, 0, 0.12], [1318.5, 0.07, 0.2]] },
  join: { pref: 'voice', notes: [[523.3, 0, 0.14], [784, 0.09, 0.22]] },
  leave: { pref: 'voice', notes: [[784, 0, 0.14], [523.3, 0.09, 0.22]] },
};
let soundCtx = null;
let lastMessageSound = 0;

function playSound(name, force = false) {
  const sound = SOUNDS[name];
  if (!force && (!soundPrefs[sound.pref] || !soundPrefs.volume)) return;
  // A busy room shouldn't turn into a wind chime.
  if (name === 'message' && !force) {
    if (Date.now() - lastMessageSound < 1500) return;
    lastMessageSound = Date.now();
  }
  try {
    soundCtx ??= new AudioContext();
    if (soundCtx.state === 'suspended') soundCtx.resume();
    const t0 = soundCtx.currentTime + 0.01;
    for (const [freq, start, length] of sound.notes) {
      const osc = soundCtx.createOscillator();
      const gain = soundCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + start);
      gain.gain.exponentialRampToValueAtTime(0.25 * soundPrefs.volume, t0 + start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + length);
      osc.connect(gain).connect(soundCtx.destination);
      osc.start(t0 + start);
      osc.stop(t0 + start + length + 0.02);
    }
  } catch {}
}

/** Someone else came into or left the voice room you're in. */
function voiceSounds(channelId, userIds) {
  const before = [...state.servers.values()].flatMap((s) => s.channels).find((c) => c.id === channelId)?.voiceUsers ?? [];
  const others = (ids) => ids.filter((id) => id !== state.me.id);
  if (others(userIds).some((id) => !before.includes(id))) playSound('join');
  else if (others(before).some((id) => !userIds.includes(id))) playSound('leave');
}

// How you sound to others. Kept on this device; takes effect the next time you join a voice room.
const VOICE_QUALITY = {
  standard: { bitrate: 48000, label: 'Standard (48 kbps)' },
  high: { bitrate: 64000, label: 'High (64 kbps)' },
  best: { bitrate: 96000, label: 'Best (96 kbps)' },
};
const voicePrefs = (() => {
  const defaults = { quality: 'high', noiseSuppression: true };
  try { return { ...defaults, ...JSON.parse(store.get('voicePrefs')) }; } catch { return defaults; }
})();

function voiceSettings() {
  return `<h3>Voice</h3>
    <label>Your voice quality
      <select id="voice-quality">${Object.entries(VOICE_QUALITY).map(([k, q]) => `<option value="${k}" ${voicePrefs.quality === k ? 'selected' : ''}>${q.label}</option>`).join('')}</select>
    </label>
    <label class="check"><input type="checkbox" id="voice-ns" ${voicePrefs.noiseSuppression ? 'checked' : ''} /> Noise suppression</label>
    <span class="small muted">Turn noise suppression off to play music or an instrument. Changes apply the next time you join a voice room.</span>`;
}
function wireVoiceSettings() {
  const save = () => store.set('voicePrefs', JSON.stringify(voicePrefs));
  $('#voice-quality').onchange = (e) => { voicePrefs.quality = e.target.value; save(); };
  $('#voice-ns').onchange = (e) => { voicePrefs.noiseSuppression = e.target.checked; save(); };
}

// Your own theme color, on a color wheel: the angle is the hue, the distance from the middle is
// how strong it is. theme.js turns it into the actual colors for light and dark.
const THEME_PRESETS = [
  { name: 'Forest', color: null },
  { name: 'Fjord', color: { h: 205, s: 70 } },
  { name: 'Heather', color: { h: 280, s: 55 } },
  { name: 'Cloudberry', color: { h: 32, s: 85 } },
  { name: 'Lingonberry', color: { h: 355, s: 75 } },
  { name: 'Slate', color: { h: 215, s: 10 } },
];
const savedThemeColor = () => { try { return JSON.parse(store.get('themeColor')); } catch { return null; } };
const FOREST_GREEN = { h: 147, s: 45 }; // where the dot sits for Burrow's own colors

function themeSettings() {
  const chip = (p, i) => {
    const c = p.color ?? FOREST_GREEN;
    return `<button type="button" class="swatch" data-preset="${i}" title="${p.name}" style="background: hsl(${c.h} ${c.s}% 42%)"></button>`;
  };
  return `<h3>Theme color</h3>
    <div class="theme-picker">
      <div class="wheel" id="theme-wheel" tabindex="0" role="slider" aria-label="Theme color"><span class="wheel-dot" id="theme-dot"></span></div>
      <div class="theme-side">
        <div class="color-row">${THEME_PRESETS.map(chip).join('')}</div>
        <span class="small muted">Drag around the wheel to pick a color; nearer the middle is softer. It works with both light and dark, and only changes Burrow for you.</span>
        <div><button type="button" class="btn secondary" id="theme-reset">Back to forest green</button></div>
      </div>
    </div>`;
}

function wireThemeSettings() {
  const wheel = $('#theme-wheel');
  let color = savedThemeColor();
  const show = () => {
    const c = color ?? FOREST_GREEN;
    const r = (c.s / 100) * 50, a = (c.h * Math.PI) / 180;
    $('#theme-dot').style.left = `${50 + Math.sin(a) * r}%`;
    $('#theme-dot').style.top = `${50 - Math.cos(a) * r}%`;
    $('#theme-dot').style.background = `hsl(${c.h} ${c.s}% 50%)`;
    wheel.setAttribute('aria-valuetext', color ? `hue ${Math.round(c.h)}, strength ${Math.round(c.s)}%` : 'forest green');
  };
  const use = (c, save) => {
    color = c;
    window.applyThemeColor(c);
    if (save) store.set('themeColor', c ? JSON.stringify(c) : null);
    show();
  };
  const pick = (e) => {
    const box = wheel.getBoundingClientRect();
    const dx = e.clientX - (box.left + box.width / 2), dy = e.clientY - (box.top + box.height / 2);
    const h = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
    const s = Math.min(1, Math.hypot(dx, dy) / (box.width / 2)) * 100;
    use({ h: Math.round(h), s: Math.round(s) }, false);
  };
  wheel.onpointerdown = (e) => { wheel.setPointerCapture(e.pointerId); pick(e); };
  wheel.onpointermove = (e) => { if (wheel.hasPointerCapture(e.pointerId)) pick(e); };
  wheel.onpointerup = () => use(color, true);
  wheel.onkeydown = (e) => {
    const c = { ...(color ?? FOREST_GREEN) };
    if (e.key === 'ArrowLeft') c.h = (c.h + 355) % 360;
    else if (e.key === 'ArrowRight') c.h = (c.h + 5) % 360;
    else if (e.key === 'ArrowUp') c.s = Math.min(100, c.s + 5);
    else if (e.key === 'ArrowDown') c.s = Math.max(0, c.s - 5);
    else return;
    e.preventDefault();
    use(c, true);
  };
  $('#modal-card').querySelectorAll('[data-preset]').forEach((b) => (b.onclick = () => use(THEME_PRESETS[b.dataset.preset].color, true)));
  $('#theme-reset').onclick = () => use(null, true);
  show();
}

function soundSettings() {
  return `<h3>Sounds</h3>
    <label class="check"><input type="checkbox" id="sound-messages" ${soundPrefs.messages ? 'checked' : ''} /> New messages</label>
    <label class="check"><input type="checkbox" id="sound-voice" ${soundPrefs.voice ? 'checked' : ''} /> People joining and leaving voice</label>
    <label>Sound volume
      <div class="sound-volume"><input type="range" id="sound-volume" min="0" max="100" step="5" value="${Math.round(soundPrefs.volume * 100)}" /><button type="button" class="btn secondary" id="sound-test">Test</button></div>
    </label>`;
}
function wireSoundSettings() {
  $('#sound-messages').onchange = (e) => { soundPrefs.messages = e.target.checked; saveSoundPrefs(); };
  $('#sound-voice').onchange = (e) => { soundPrefs.voice = e.target.checked; saveSoundPrefs(); };
  $('#sound-volume').oninput = (e) => { soundPrefs.volume = Number(e.target.value) / 100; saveSoundPrefs(); };
  $('#sound-volume').onchange = () => playSound('message', true);
  $('#sound-test').onclick = () => playSound('message', true);
}

// ---------------------------------------------------------------- helpers

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Light markdown: ```code blocks```, `inline code`, **bold**, *italic*, links, @mentions.
function formatContent(text) {
  const parts = escapeHtml(text).split(/(```[\s\S]*?```|`[^`\n]+`)/g);
  return parts
    .map((p) => {
      if (p.startsWith('```') && p.endsWith('```') && p.length >= 6) return `<pre><code>${p.slice(3, -3).replace(/^\w*\n/, '')}</code></pre>`;
      if (p.startsWith('`') && p.endsWith('`') && p.length >= 2) return `<code>${p.slice(1, -1)}</code>`;
      return p
        .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
        .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
        .replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)'"]/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`)
        .replace(/(^|\s)@([\w.-]+)/g, '$1<span class="mention">@$2</span>');
    })
    .join('');
}

function formatTime(d) {
  const today = new Date();
  const yesterday = new Date(Date.now() - 864e5);
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `Today at ${t}`;
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday at ${t}`;
  return d.toLocaleDateString() + ' ' + t;
}

function initials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
}

// Forest palette for avatars and burrow tiles: spruce, moss, lingonberry, cloudberry,
// fjord, bark, lichen, heather.
const FOREST = ['#2f5440', '#5f8a5a', '#a8423c', '#c98a2b', '#3f6878', '#7a5a40', '#6b7a3a', '#7b5a7e'];
function colorFor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return FOREST[h % FOREST.length];
}

// Shows the person's picture when they have one, otherwise their first letter on a forest color.
function setAvatar(el, username, picture) {
  el.style.backgroundColor = colorFor(username);
  el.style.backgroundImage = picture ? `url("${state.serverUrl}${picture}")` : '';
  el.classList.toggle('has-picture', !!picture);
  el.textContent = picture ? '' : username[0].toUpperCase();
}

// Members lists carry everyone's current picture; a message only knows its author's picture
// from when it was loaded, so the members list (and live updates) win when we have them.
function avatarOf(userId, fallback = null) {
  return state.avatars.has(userId) ? state.avatars.get(userId) : fallback;
}
function rememberAvatars(server) {
  for (const m of server.members) state.avatars.set(m.id, m.avatar ?? null);
}

// Someone (maybe us) changed their picture.
function applyUser(u) {
  state.avatars.set(u.id, u.avatar);
  for (const s of state.servers.values()) for (const m of s.members) if (m.id === u.id) m.avatar = u.avatar;
  if (u.id === state.me?.id) {
    state.me.avatar = u.avatar;
    setAvatar($('#me-avatar'), state.me.username, u.avatar);
    setAvatar($('#tab-avatar'), state.me.username, u.avatar);
    const preview = $('#account-avatar');
    if (preview) setAvatar(preview, state.me.username, u.avatar);
    $('#avatar-remove')?.classList.toggle('hidden', !u.avatar);
  }
  renderMembers();
  renderChannels();
  renderMessages();
}

function iconButton(label, title, onclick) {
  const b = document.createElement('button');
  b.className = 'icon-btn';
  b.textContent = label;
  b.title = title;
  b.onclick = onclick;
  return b;
}

function alertError(err) { alert(err.message || String(err)); }

// ---------------------------------------------------------------- theme & panes

function currentTheme() {
  return document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}
function renderThemeToggle() {
  $('#theme-toggle').textContent = currentTheme() === 'dark' ? 'Switch to light' : 'Switch to dark';
}
$('#theme-toggle').onclick = () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  store.set('theme', next);
  renderThemeToggle();
};
renderThemeToggle();

const memberPane = $('#member-pane');
if (store.get('membersHidden') === '1') memberPane.classList.add('collapsed');
$('#members-toggle').onclick = () => {
  if (matchMedia('(max-width: 980px)').matches) return memberPane.classList.toggle('open');
  const hidden = memberPane.classList.toggle('collapsed');
  store.set('membersHidden', hidden ? '1' : null);
};
$('#members-close').onclick = () => memberPane.classList.remove('open');

// ---------------------------------------------------------------- the shell: top bar, phone screens, your menu
//
// On a computer everything is on screen at once. A phone shows one screen at a time:
// "rooms" (the burrow's rooms and fires, with the tab bar) or "chat" (one room).

const isPhone = () => matchMedia('(max-width: 760px)').matches;

function showView(view) {
  $('#app').dataset.view = view;
  if (view === 'rooms') memberPane.classList.remove('open');
}
$('#chat-back').onclick = () => showView('rooms');
$('#tab-burrows').onclick = () => {
  if (state.inDms) selectServer(Number(store.get('lastServer')) || state.serverOrder[0] || null);
  showView('rooms');
};
$('#tab-messages').onclick = () => { if (!state.inDms) openDms(); showView('rooms'); };

function toggleMeMenu(anchor) {
  const menu = $('#me-menu');
  if (!menu.classList.contains('hidden')) return closeMeMenu();
  menu.anchor = anchor;
  menu.classList.remove('hidden');
  anchor.setAttribute('aria-expanded', 'true');
  if (!isPhone()) {
    const r = anchor.getBoundingClientRect();
    menu.style.left = `${Math.max(8, r.right - menu.offsetWidth)}px`;
    menu.style.top = `${r.bottom + 8}px`;
  } else menu.style.left = menu.style.top = '';
  menu.querySelector('button').focus();
}
function closeMeMenu() {
  const menu = $('#me-menu');
  if (menu.classList.contains('hidden')) return;
  menu.classList.add('hidden');
  menu.anchor?.setAttribute('aria-expanded', 'false');
}
$('#me-btn').onclick = (e) => { e.stopPropagation(); toggleMeMenu($('#me-btn')); };
$('#tab-you').onclick = (e) => { e.stopPropagation(); toggleMeMenu($('#tab-you')); };
$('#me-menu').onclick = (e) => { if (e.target.closest('button')) closeMeMenu(); else e.stopPropagation(); };
$('#account-btn').onclick = () => openAccount();
document.addEventListener('click', closeMeMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMeMenu(); });

function setConnected(ok, text) {
  $('#conn-status').classList.toggle('ok', ok);
  $('#conn-status').textContent = text;
  $('#me-btn').classList.toggle('offline', !ok);
}

// Where you can get back to the voice room from: the chip in the top bar, and the pill above a phone's chat.
function renderVoicePlaces() {
  const voice = state.voice;
  const ch = voice && [...state.servers.values()].flatMap((s) => s.channels).find((c) => c.id === voice.channelId);
  $('#campfire-chip').classList.toggle('hidden', !ch);
  $('#voice-pill').classList.toggle('hidden', !ch || state.stageOpen);
  if (!ch) return;
  const here = ch.voiceUsers?.length || 1;
  $('#campfire-chip-label').textContent = `${ch.name} · `;
  $('#campfire-chip-count').textContent = here;
  $('#campfire-chip').title = `You're in ${ch.name}. Open it.`;
  const live = [...state.sharing].find(([id, sh]) => id !== state.me.id && sh.screen);
  $('#voice-pill-label').textContent = `In ${ch.name}` + (live ? ` · ${nameOf(live[0])} is live` : ` · ${here} here`);
}
function goToVoice() {
  if (!state.voice) return;
  const s = [...state.servers.values()].find((x) => x.channels.some((c) => c.id === state.voice.channelId));
  if (s && s.id !== state.serverId) selectServer(s.id);
  showView('chat');
  openStage();
}
$('#campfire-chip').onclick = goToVoice;
$('#voice-pill').onclick = goToVoice;

// Someone in a burrow: message them, change how loud they are for you, and manage them.
function openPerson(s, m) {
  const inVoice = state.voice && s.channels.some((c) => c.id === state.voice.channelId && c.voiceUsers?.includes(m.id));
  const sharing = inVoice ? state.sharing.get(m.id) : null;
  const top = rolesOf(s, m)[0];
  const status = sharing?.screen ? 'Sharing their screen' : inVoice ? 'By the fire with you' : m.online ? 'Around' : 'Out in the woods';
  modal(`<div class="person">
      <span class="avatar xl" id="person-avatar"></span>
      <div class="person-meta">
        <h2></h2>
        <span class="person-status${sharing?.screen ? ' live' : ''}">${escapeHtml(status)}</span>
        ${isHost(s, m.id) ? '<span class="owner-badge">host</span>' : top ? `<span class="owner-badge role" style="--role:${escapeHtml(top.color)}">${escapeHtml(top.name)}</span>` : ''}
      </div>
    </div>
    ${sharing?.screen || sharing?.camera ? `<button class="btn" id="person-watch">${sharing.screen ? 'Watch stream' : 'See camera'}</button>` : ''}
    ${inVoice ? `<div class="person-sliders">
      ${sharing?.screen ? `<label>Stream volume <span id="pv-stream-val"></span>
        <input type="range" id="pv-stream" min="0" max="200" step="5" value="${Math.round(streamVolumeFor(m.id) * 100)}" /></label>` : ''}
      <label>Voice volume <span id="pv-voice-val"></span>
        <input type="range" id="pv-voice" min="0" max="200" step="5" value="${Math.round(volumeFor(m.id) * 100)}" /></label>
      <span class="small muted">Only changes it for you.</span>
    </div>` : ''}
    <div class="person-actions">
      ${!isDm(s) ? '<button class="action" id="person-dm">Send a message</button>' : ''}
      ${!isDm(s) ? '<button class="action" id="person-mention">Mention</button>' : ''}
      ${canActOn(s, m) ? `<button class="action" id="person-manage">Manage ${escapeHtml(m.username)}</button>` : ''}
    </div>
    <div class="modal-row"><button class="btn secondary" data-close>Close</button></div>`, 'sheet');
  $('#modal-card .person h2').textContent = m.username;
  const color = roleColor(s, m.id);
  if (color) $('#modal-card .person h2').style.color = color;
  setAvatar($('#person-avatar'), m.username, avatarOf(m.id, m.avatar));
  const pct = (v) => (v === 0 ? 'Muted' : `${Math.round(v * 100)}%`);
  const sliders = [['#pv-stream', streamVolumeFor, setStreamVolume], ['#pv-voice', volumeFor, setVolume]];
  for (const [sel, get, set] of sliders) {
    const r = $(sel);
    if (!r) continue;
    const show = () => ($(sel + '-val').textContent = pct(get(m.id)));
    r.oninput = () => { set(m.id, Number(r.value) / 100); show(); renderStage(); };
    r.onchange = () => renderChannels();
    show();
  }
  $('#person-watch')?.addEventListener('click', () => { closeModal(); goToVoice(); });
  $('#person-dm')?.addEventListener('click', () => openDm(m.id));
  $('#person-mention')?.addEventListener('click', () => {
    closeModal();
    memberPane.classList.remove('open');
    input.value = `${input.value}${input.value && !input.value.endsWith(' ') ? ' ' : ''}@${m.username} `;
    autosize();
    showView('chat');
    input.focus();
  });
  $('#person-manage')?.addEventListener('click', () => openMemberMenu(s, m));
}

// ---------------------------------------------------------------- start

if (state.token && state.serverUrl) resolveServerUrl().then(enterApp).catch(() => showAuth());
else showAuth();
