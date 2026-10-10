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
  if (!isDesktop && !/Android|iPhone|iPad/.test(navigator.userAgent)) showDesktopDownloads();
  renderAuthMode();
  showAuthInvite();
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
  for (const a of box.querySelectorAll('a')) a.classList.toggle('mine', a.dataset.os === mine);
  if (desktopLinksLoaded) return;
  desktopLinksLoaded = true;
  fetch('https://api.github.com/repos/HaxMarris/Burrow/releases/latest')
    .then((r) => (r.ok ? r.json() : null))
    .then((release) => {
      const ends = { win: '.exe', mac: '.dmg', linux: '.AppImage' };
      for (const a of box.querySelectorAll('a')) {
        const file = release?.assets?.find((f) => f.name.endsWith(ends[a.dataset.os]));
        if (file) a.href = file.browser_download_url;
      }
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
  state.me = await api('/api/me');
  state.folders = state.me.folders ?? [];
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
  $('#mic-btn').classList.toggle('hidden', !state.maxUploadBytes || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined');
  state.gifsEnabled = !!config.gifs;
  $('#gif-btn').classList.toggle('hidden', !state.gifsEnabled);
  await loadServers();
  connect();
  loadSavedAndScheduled();
  openPendingInvite();
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
    if (state.voice) ws.send(JSON.stringify({ type: 'voice_join', channelId: state.voice.channelId, ...voiceFlags() }));
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
      const mine = m.authorId === state.me.id;
      const where = roomById(m.channelId);
      if (where) {
        const c = where.c;
        if (mine) Object.assign(c, { lastReadId: Math.max(c.lastReadId ?? 0, m.id), unread: 0, mentions: 0 });
        else if (m.id > (c.lastReadId ?? 0)) {
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
      if (!mine && (document.hidden || m.channelId !== state.channelId) && !quietFor(m)) {
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
      for (const x of state.messages)
        if (x.replyTo?.id === ev.message.id) { x.replyTo.content = ev.message.content.slice(0, 160); refreshLine(x.id); }
      break;
    }
    case 'message_deleted':
      if (state.threadParent?.id === ev.id) state.threadParent = { deleted: true };
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
        for (const c of s.channels) if (c.id === ev.channelId) Object.assign(c, { voiceUsers: ev.userIds, voiceMuted: ev.muted, voiceDeafened: ev.deafened });
      renderChannels();
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
    case 'error':
      // Usually a message that couldn't be sent: slow mode, an archived room, and so on.
      toast(ev.error);
      break;
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
  const title = isDm(server) ? (server.group ? `${m.author} in ${dmTitle(server)}` : `${m.author} (direct message)`) : `${m.author} in ${channel?.name ?? 'Burrow'}`;
  const body = plainText(m.content).slice(0, 200) || (m.poll ? `Poll: ${m.poll.question}` : m.sticker ? 'Sent a sticker' : 'Sent a file');
  const n = new Notification(title, { body, silent: !mentioned });
  n.onclick = () => { window.focus(); jumpTo(m.channelId, m.id); };
}

// ---------------------------------------------------------------- servers & channels

// The top bar: a named pill per burrow, with the ones that don't fit in a "more" list.
// Phones get one button with the current burrow's name instead, which opens the full list.
function renderServers() {
  const s = state.servers.get(state.serverId);
  const hasUnread = serverUnread;
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
    const pings = serverMentions(srv);
    if (pings && !on) b.insertAdjacentHTML('beforeend', `<span class="ping-count" title="${pings} for you">${pings > 99 ? '99+' : pings}</span>`);
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

// The burrow's picture, or its initials on a forest color.
function burrowTile(s, id) {
  const t = document.createElement('span');
  t.className = 'tile';
  if (id) t.id = id;
  t.style.background = colorFor(s.name);
  if (s.icon) {
    const img = document.createElement('img');
    img.src = state.serverUrl + s.icon;
    img.alt = '';
    img.onerror = () => img.replaceWith(initials(s.name));
    t.append(img);
    t.classList.add('has-picture');
  } else t.textContent = initials(s.name);
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
  $('#burrow-more').classList.toggle('unread', hidden.some((id) => serverUnread(state.servers.get(id))));
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
  if (serverUnread(s)) return { text: 'New messages', cls: 'news' };
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
    if (!on && serverUnread(s)) tile.classList.add('unread');
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
    const folder = document.createElement('button');
    folder.className = 'icon-btn folder-btn';
    folder.innerHTML = FOLDER_ICON;
    folder.title = folderOf(id) ? `In ${folderOf(id).name}. Move it` : 'Put in a folder';
    folder.setAttribute('aria-label', folder.title);
    folder.onclick = () => openFolderMenu(folder, id);
    el.append(b, folder, star);
    return el;
  };
  const heading = (text) => {
    const h = document.createElement('div');
    h.className = 'switch-head';
    h.textContent = text;
    return h;
  };
  // Burrows in one of your folders show there (favorites too); the rest come last.
  const inFolders = new Set(state.folders.flatMap((f) => f.serverIds));
  const others = state.serverOrder.filter((id) => !favs.includes(id) && !inFolders.has(id));
  const rows = [];
  if (favs.length) rows.push(heading(`Favorites · ${favs.length} of ${MAX_FAVORITES}`), ...favs.map(row));
  else {
    const hint = document.createElement('p');
    hint.className = 'switch-hint';
    hint.textContent = `Star up to ${MAX_FAVORITES} burrows to keep them in your top bar.`;
    rows.push(hint);
  }
  for (const f of state.folders) {
    const { el, folded } = folderHeading(f);
    rows.push(el);
    if (!folded) rows.push(...f.serverIds.filter((id) => state.servers.has(id)).map(row));
  }
  if (others.length) rows.push(heading(favs.length || state.folders.length ? 'Other burrows' : 'Your burrows'), ...others.map(row));
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
// Menus and windows opened from the list (folders, for one) leave it open.
document.addEventListener('click', (e) => { if (!e.target.closest('#pop-menu, #modal')) closeSwitcher(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSwitcher(); });
window.addEventListener('resize', placeSwitcher);

async function selectServer(id, initial = false, open = null) {
  const s = state.servers.get(id);
  if (!initial) showView('rooms');
  if (s) state.inDms = isDm(s);
  state.serverId = id;
  store.set('lastServer', id);
  renderServers();
  renderMembers();
  if (!s) { state.channelId = null; renderChannels(); state.messages = []; renderMessages(); return; }
  maybeShowRules(s);
  if (open) return selectChannel(open.channelId, open);
  const remembered = state.lastChannel[id];
  const textRooms = s.channels.filter((c) => c.kind !== 'voice');
  // New here: the welcome room, if the burrow has one.
  const ch = textRooms.find((c) => c.id === remembered) ?? s.threads?.find((t) => t.id === remembered)
    ?? textRooms.find((c) => c.id === s.welcomeChannelId) ?? textRooms.find((c) => !c.archived) ?? textRooms[0];
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
  $('#add-channel').title = state.inDms ? 'New message' : 'New room, heading or order';
  renderBurrowHead(state.inDms ? null : s);
  renderEvents(state.inDms ? null : s);
  if (state.inDms) {
    $('#archived-section').classList.add('hidden');
    return renderDmList();
  }
  const channels = s?.channels ?? [];
  const manager = can(s, 'rooms');
  const roomRow = (c) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'room-name';
    name.textContent = c.name;
    li.append(name);
    if (c.private) li.insertAdjacentHTML('beforeend', LOCK_ICON);
    const n = notifyState(s, c);
    if (n.muted || n.level === 'none') li.classList.add('muted-room');
    if (c.id === state.channelId) li.classList.add('active');
    else if (isUnread(c) && (roomLoud(s, c) || c.mentions)) li.classList.add('unread');
    li.prepend(roomIcon());
    if (c.id !== state.channelId && c.mentions && n.level !== 'none') li.append(pingCount(c.mentions));
    li.onclick = () => { selectChannel(c.id); showView('chat'); };
    li.oncontextmenu = (e) => { e.preventDefault(); openNotifyMenu(li, s, c); };
    if (manager) li.append(roomSettingsButton(c));
    if (manager && !c.archived && !isPhone()) makeDraggable(li, s, c);
    return [li, ...threadRows(s, c)];
  };
  // Rooms without a heading come first, then each heading with its rooms.
  const groups = s?.groups ?? [];
  const live = channels.filter((c) => c.kind !== 'voice' && !c.archived);
  const textRooms = live.filter((c) => !groups.some((g) => g.id === c.groupId)).flatMap(roomRow);
  for (const g of groups) {
    const rooms = live.filter((c) => c.groupId === g.id);
    textRooms.push(groupHeading(s, g, rooms));
    // A folded heading still shows the room you're in.
    textRooms.push(...rooms.filter((c) => !isFolded(g.id) || c.id === state.channelId).flatMap(roomRow));
  }
  const archived = channels.filter((c) => c.kind === 'text' && c.archived);
  $('#archived-section').classList.toggle('hidden', !archived.length);
  $('#archived-title').textContent = `Archived · ${archived.length}`;
  $('#archived-list').replaceChildren(...archived.flatMap(roomRow));
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
    li.title = joined ? 'Open the fire' : 'Join voice';
    li.onclick = () => (joined ? goToVoice() : joinVoice(c.id));
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
      // Deafened says more than muted, so it's the one shown.
      if (c.voiceDeafened?.includes(id)) row.insertAdjacentHTML('beforeend', DEAFENED_ICON);
      else if (state.mutedInVoice.has(id) || c.voiceMuted?.includes(id)) row.insertAdjacentHTML('beforeend', MUTED_ICON);
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
  renderFire();
}

// Opens a room or thread. With `around`, it opens at that message instead of the newest;
// with `present`, at the newest even if there's a lot you haven't read.
async function selectChannel(id, { around = null, present = false } = {}) {
  closeStage();
  const changing = id !== state.channelId;
  if (changing) {
    saveDraft();
    // Files upload into a specific room, so switching rooms drops any not yet sent.
    if (state.pending.length) {
      state.pending.forEach((p) => { p.xhr?.abort(); if (p.previewUrl) URL.revokeObjectURL(p.previewUrl); });
      state.pending = [];
      renderPending();
    }
    setReply(null);
    cancelRecording();
    state.holdUnread = null;
  }
  state.channelId = id;
  state.lastChannel[state.serverId] = id;
  store.set('lastChannel', JSON.stringify(state.lastChannel));
  const where = roomById(id);
  const ch = where?.c;
  // Where you'd read up to, for the "New" line. It stays put while you're in the room.
  if (changing || present) {
    state.newFrom = ch?.unread ? ch.lastReadId ?? 0 : null;
    state.unreadAtOpen = ch?.unread ? { count: ch.unread, mentions: ch.mentions ?? 0 } : null;
  }
  renderChannels();
  renderServers();
  renderChatHeader();
  $('#composer-input').disabled = !ch;
  $('#send-btn').disabled = !ch;
  if (changing) loadDraft();
  renderScheduledNote();
  state.messages = [];
  state.reachedStart = false;
  state.reachedEnd = true;
  state.threadParent = null;
  renderTyping();
  updateUnreadBar();
  renderPresentBar();
  if (!ch) return renderMessages();
  // Lots unread: start where you left off rather than at the bottom.
  let target = around;
  if (target == null && !present && (ch.unread ?? 0) > 40) target = (ch.lastReadId ?? 0) + 1;
  const parentLoad = where.thread ? loadThreadParent(ch) : null;
  let msgs;
  try {
    msgs = await api(`/api/channels/${id}/messages?limit=50${target != null ? `&around=${target}` : ''}`);
  } catch (err) {
    if (state.channelId === id) alertError(err);
    return;
  }
  if (parentLoad) await parentLoad;
  if (state.channelId !== id) return;
  state.messages = msgs;
  // In slow mode, your last message here decides when you can send the next.
  const lastMine = msgs.findLast((m) => m.authorId === state.me.id);
  if (lastMine) startSlowWait(id, lastMine.createdAt);
  if (target != null) {
    state.reachedStart = msgs.filter((m) => m.id <= target).length < 25;
    state.reachedEnd = msgs.filter((m) => m.id > target).length < 25;
  } else {
    state.reachedStart = msgs.length < 50;
    state.reachedEnd = true;
  }
  renderMessages({ stick: target == null });
  if (around != null) flashMessage(msgs.find((m) => m.id >= around)?.id ?? around);
  else if (target != null) scrollToNewLine();
  else {
    // A few unread: show them from the "New" line down, if they don't all fit.
    const line = messagesEl.querySelector('.new-divider');
    if (line && line.getBoundingClientRect().top < messagesEl.getBoundingClientRect().top) scrollToNewLine();
  }
  renderPresentBar();
  updateUnreadBar();
  markReadSoon();
  if (!isPhone()) $('#composer-input').focus();
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
  const where = roomById(state.channelId);
  if (where?.thread) {
    const parent = roomById(where.c.parentId)?.c;
    const sub = $('#channel-sub');
    sub.replaceChildren('Thread in ');
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'link-btn';
    back.textContent = `#${parent?.name ?? 'a room'}`;
    back.onclick = () => parent && selectChannel(parent.id);
    sub.append(back);
    return;
  }
  if (s.group) return ($('#channel-sub').textContent = `Group · ${s.members.length} people, ${s.members.filter((m) => m.online).length} around`);
  if (isDm(s)) return ($('#channel-sub').textContent = `Direct message · ${partner(s).online ? 'around' : 'away'}`);
  const here = s.members.filter((m) => m.online).length;
  const topic = where?.c.topic;
  $('#channel-sub').textContent = topic || `${s.name} · ${here} of ${s.members.length} around`;
  $('#channel-sub').title = topic || '';
}

// ---------------------------------------------------------------- messages

const messagesEl = $('#messages');
const GROUP_WINDOW = 7 * 60 * 1000;

function renderMessages({ stick = false } = {}) {
  const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
  const scrollTop = messagesEl.scrollTop;
  const frag = document.createDocumentFragment();
  const where = roomById(state.channelId);
  const server = where?.s;
  const ch = where?.c;
  if (ch && state.reachedStart) {
    const start = document.createElement('div');
    start.className = 'history-start';
    if (where.thread) {
      start.innerHTML = `<h2>${escapeHtml(ch.name)}</h2><div class="muted">A thread in #${escapeHtml(roomById(ch.parentId)?.c.name ?? 'a room')}</div>`;
      const p = state.threadParent;
      if (p?.deleted) start.insertAdjacentHTML('beforeend', '<p class="muted small">The message this thread started from was deleted.</p>');
      else if (p) start.append(messageCard(p, null, { onOpen: () => jumpTo(ch.parentId, p.id) }));
    } else start.innerHTML = isDm(server)
      ? `<h2>This is the beginning of ${server.group ? escapeHtml(dmTitle(server)) : `your conversation with ${escapeHtml(partner(server).username)}`}</h2>`
      : `<h2>This is the beginning of ${escapeHtml(ch.name)}</h2><div class="muted">${ch.topic ? escapeHtml(ch.topic) : 'Pull up a stump and say hello.'}</div>`;
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
  if (stick || (nearBottom && state.reachedEnd)) messagesEl.scrollTop = messagesEl.scrollHeight;
  else messagesEl.scrollTop = scrollTop;
  renderSeen();
}

// The last author group's message column, so a new message can join it without a redraw.
let tailBody = null;

// Adds message m (and a day divider or a new author group when it needs one) after prev.
// body is prev's group column; returns m's.
function addMessageNodes(parent, m, prev, body) {
  let newGroup = false;
  if (!prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString()) {
    const d = document.createElement('div');
    d.className = 'day-divider';
    const label = document.createElement('span');
    label.textContent = new Date(m.createdAt).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    d.append(label);
    parent.append(d);
    newGroup = true;
  }
  if (state.newFrom != null && m.id > state.newFrom && (prev ? prev.id <= state.newFrom : state.reachedStart)) {
    const d = document.createElement('div');
    d.className = 'new-divider';
    d.innerHTML = '<span>New</span>';
    parent.append(d);
    newGroup = true;
  }
  const grouped = !newGroup && prev && !m.replyTo && !m.forwarded && prev.authorId === m.authorId && m.createdAt - prev.createdAt < GROUP_WINDOW;
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
  el.className = 'line' + (m.pinnedAt ? ' pinned' : '');
  el.dataset.id = m.id;
  el.title = new Date(m.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (m.authorId !== state.me.id && mentionsMe(m)) el.classList.add('mentions-me');
  if (m.pinnedAt) el.insertAdjacentHTML('beforeend', `<span class="pin-mark" title="Pinned">${PIN_ICON}</span>`);
  if (m.forwarded) el.append(renderForwarded(m.forwarded));
  if (m.replyTo) el.append(renderReplyQuote(m.replyTo));
  const content = document.createElement('div');
  content.className = 'content' + (isJumbo(m.content) ? ' jumbo' : '');
  content.innerHTML = formatContent(m.content);
  if (m.editedAt) {
    const edited = document.createElement('button');
    edited.type = 'button';
    edited.className = 'edited';
    edited.textContent = '(edited)';
    edited.title = `Edited ${new Date(m.editedAt).toLocaleString()}. See earlier versions.`;
    edited.onclick = () => openEditHistory(m);
    content.append(' ', edited);
  }
  if (!m.content && !m.editedAt) content.classList.add('hidden');
  el.append(content);
  if (m.sticker) el.append(renderSticker(m.sticker));
  if (m.poll) el.append(renderPoll(m));
  if (m.attachments?.length) el.append(renderAttachments(m.attachments));
  if (m.embeds?.length) el.append(renderEmbeds(m));
  if (m.thread) el.append(renderThreadChip(m.thread));
  if (m.reactions?.length) el.append(renderReactions(m));

  const actions = document.createElement('div');
  actions.className = 'actions';
  const reactBtn = iconButton('', 'Add reaction', (e) => openEmojiPicker(e.currentTarget, m));
  reactBtn.innerHTML = SMILE_ICON;
  const replyBtn = iconButton('', 'Reply', () => setReply(m));
  replyBtn.innerHTML = REPLY_ICON;
  actions.append(reactBtn, replyBtn);
  if (m.authorId === state.me.id && !m.poll && !m.forwarded) actions.append(iconButton('Edit', 'Edit message', () => startEdit(m, content)));
  const more = iconButton('', 'More', (e) => openMessageMenu(e.currentTarget, m));
  more.innerHTML = MORE_ICON;
  more.setAttribute('aria-haspopup', 'menu');
  actions.append(more);
  el.append(actions);
  return el;
}

function startEdit(m, contentEl) {
  const ta = document.createElement('textarea');
  ta.className = 'edit';
  ta.value = emojiToNames(m.content);
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
      const content = namesToEmoji(ta.value.trim());
      if (!content && !m.attachments?.length && !m.sticker) return confirmDelete(m);
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
  if (!isPhone() || e.target.closest('button, a, textarea, input, .att-image, .spoiler, .att-spoiler')) return;
  const line = e.target.closest('.line');
  messagesEl.querySelectorAll('.line.touched').forEach((l) => l !== line && l.classList.remove('touched'));
  line?.classList.toggle('touched');
});

messagesEl.addEventListener('scroll', () => {
  updateUnreadBar();
  if (messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 200) loadNewer();
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
  const content = namesToEmoji(input.value.trim());
  const channelId = state.channelId;
  const files = state.pending;
  const replyTo = state.replyTo;
  if ((!content && !files.length) || !channelId) return;
  if ((slowWaits.get(channelId) ?? 0) > Date.now()) return renderSlowNote(); // slow mode: what you typed stays put
  if (files.some((p) => p.error)) return alert('Remove the files that failed to upload first.');
  if (content.length > 4000) return alert('Messages can be at most 4000 characters. Paste long text and it goes up as a file instead.');
  input.value = '';
  autosize();
  clearDraft(channelId);
  state.pending = [];
  renderPending();
  setReply(null);
  try {
    const uploaded = await Promise.all(files.map((p) => p.done));
    const attachmentIds = uploaded.map((a) => a.id);
    const spoilerIds = uploaded.filter((a, i) => files[i].spoiler).map((a) => a.id);
    files.forEach((p) => p.previewUrl && URL.revokeObjectURL(p.previewUrl));
    await sendMessage(channelId, { content, attachmentIds, spoilerIds, replyTo: replyTo?.id });
  } catch (err) {
    // Put everything back so nothing is lost.
    if (!input.value) input.value = emojiToNames(content);
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

$('#composer').addEventListener('submit', (e) => { e.preventDefault(); if (recording) finishRecording(true); else sendComposer(); });

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
  saveDraftSoon();
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
      <label>Join with an invite link or code<input id="invite-code" placeholder="e.g. a1B2c3D4" required /></label>
      <div id="join-preview" class="invite-card small-card hidden"></div>
      <button type="submit" class="btn secondary">Join</button>
    </form>
    <div class="error" id="modal-error"></div>`);
  if (focus === 'join') $('#invite-code').focus();
  // Shows what the code opens as soon as it's typed or pasted.
  let previewTimer = 0;
  $('#invite-code').oninput = (e) => {
    clearTimeout(previewTimer);
    const code = inviteCodeFrom(e.target.value);
    const box = $('#join-preview');
    if (code.length < 6) return box.classList.add('hidden');
    previewTimer = setTimeout(async () => {
      try {
        const p = await invitePreview(code);
        if (inviteCodeFrom($('#invite-code')?.value) !== code) return;
        box.innerHTML = inviteCardHtml(p);
        fillInviteTile(box, p);
      } catch (err) { box.innerHTML = `<p class="small">${escapeHtml(err.message)}</p>`; }
      box.classList.remove('hidden');
    }, 300);
  };
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
  const n = notifyState(s, null);
  modal(`<h2>${escapeHtml(s.name)}</h2>
    ${s.description ? `<p class="muted">${escapeHtml(s.description)}</p>` : ''}
    <div class="settings-buttons">
      <button class="btn" id="open-invites">Invite people</button>
      <button class="btn secondary" id="open-notify" aria-haspopup="menu">Notifications: ${n.muted ? 'muted' : { all: 'all messages', mentions: 'only @mentions', none: 'nothing' }[n.level]}</button>
      ${s.rules ? '<button class="btn secondary" id="open-rules">Rules</button>' : ''}
      ${can(s, 'burrow') ? '<button class="btn secondary" id="open-edit">Edit burrow</button>' : ''}
      ${can(s, 'roles') ? `<button class="btn secondary" id="open-roles">Roles${s.roles.length ? ` · ${s.roles.length}` : ''}</button>` : ''}
      ${can(s, 'emoji') && state.maxUploadBytes ? `<button class="btn secondary" id="open-emoji">Emoji and stickers${s.emoji?.length ? ` · ${s.emoji.length}` : ''}</button>` : ''}
    </div>
    ${can(s, 'ban') ? '<div id="ban-list"></div>' : ''}
    <div class="modal-row">
      <button class="btn danger" id="leave-server">${owner ? 'Delete burrow' : 'Leave burrow'}</button>
      <button class="btn secondary" data-close>Close</button>
    </div>`);
  if (can(s, 'ban')) renderBans(s);
  $('#open-invites').onclick = () => openInvites(s.id);
  $('#open-notify').onclick = () => openNotifyMenu($('#open-notify'), s, null);
  $('#open-rules')?.addEventListener('click', () => openRules(s));
  $('#open-edit')?.addEventListener('click', () => openEditBurrow(s.id));
  $('#open-roles')?.addEventListener('click', () => openRoles(s.id));
  $('#open-emoji')?.addEventListener('click', () => openEmojiManager(s.id));
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

// Changing the burrow's picture, from its settings.
function wireBurrowPicture(s) {
  const show = (srv) => {
    const tile = burrowTile(srv, 'burrow-picture-tile');
    tile.classList.add('xl');
    $('#burrow-picture-tile').replaceWith(tile);
    $('#burrow-picture-remove').classList.toggle('hidden', !srv.icon);
  };
  const done = (srv) => {
    state.servers.set(srv.id, srv);
    renderServers();
    show(srv);
  };
  show(s);
  const pick = $('#burrow-picture-pick');
  pick.onclick = () => $('#burrow-picture-input').click();
  $('#burrow-picture-input').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    $('#burrow-picture-error').textContent = '';
    pick.disabled = true;
    pick.textContent = 'Uploading…';
    try { done(await uploadPicture(`/api/servers/${s.id}/picture`, await squarePicture(file))); }
    catch (err) { $('#burrow-picture-error').textContent = err.message; }
    finally { pick.disabled = false; pick.textContent = 'Change picture'; }
  };
  $('#burrow-picture-remove').onclick = async () => {
    try { done(await api(`/api/servers/${s.id}/picture`, { method: 'DELETE' })); }
    catch (err) { $('#burrow-picture-error').textContent = err.message; }
  };
}

$('#add-channel').onclick = () => {
  if (state.inDms) return openNewDm();
  openRoomsMenu();
};

function openNewRoom() {
  const s = state.servers.get(state.serverId);
  modal(`<h2>New room</h2>
    <form id="channel-form">
      <label>Room name<input id="new-channel-name" placeholder="e.g. game-night" maxlength="32" required /></label>
      ${state.voiceEnabled ? `<div class="kind-choice">
        <label><input type="radio" name="kind" value="text" checked /> Text room</label>
        <label><input type="radio" name="kind" value="voice" /> Voice room</label>
      </div>` : ''}
      ${s.groups?.length ? `<label>Under heading<select id="new-channel-group"><option value="">No heading</option>${s.groups.map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('')}</select></label>` : ''}
      ${privacyFields(s, false, [])}
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
        body: { name: $('#new-channel-name').value, kind, groupId: $('#new-channel-group')?.value ? Number($('#new-channel-group').value) : null, ...readPrivacyFields() },
      });
      const known = new Set(state.servers.get(s.id).channels.map((c) => c.id));
      state.servers.set(s.id, s);
      closeModal();
      if (kind === 'voice') renderChannels();
      else selectChannel(s.channels.find((c) => !known.has(c.id))?.id ?? s.channels[s.channels.length - 1].id);
    } catch (err) { $('#modal-error').textContent = err.message; }
  };
}

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
  ['burrow', 'Edit the burrow', "Change its name, pictures, description, welcome room and rules, and manage invites and events"],
  ['emoji', 'Manage emoji', "Add, rename and remove the burrow's own emoji and stickers"],
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
  const text = c.kind === 'text';
  const postRoles = c.postRoleIds ?? [];
  modal(`<h2>Room settings</h2>
    <form id="room-form">
      <label>Room name<input id="room-name" maxlength="32" required value="${escapeHtml(c.name)}" /></label>
      ${text ? `<label>Topic<input id="room-topic" maxlength="200" placeholder="What's this room for?" value="${escapeHtml(c.topic ?? '')}" /></label>
      <label>Slow mode<select id="room-slow">${SLOW_CHOICES.map(([v, l]) => `<option value="${v}" ${v === (c.slow ?? 0) ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <span class="small muted">How long people wait between messages. People who manage rooms or messages don't wait.</span></label>
      <label class="check"><input type="checkbox" id="room-announce" ${c.announce ? 'checked' : ''} /> Announcement room: only some roles can post</label>
      <div id="room-posters" class="${c.announce ? '' : 'hidden'}">
        <p class="small muted">The host and people who manage rooms can always post. Which roles can too?</p>
        ${s.roles?.length ? `<ul class="access-list" id="post-roles">${s.roles.map((r) => `<li><label class="check"><input type="checkbox" value="${r.id}" ${postRoles.includes(r.id) ? 'checked' : ''} /> ${roleDot(r.color)}${escapeHtml(r.name)}</label></li>`).join('')}</ul>` : '<p class="small muted">This burrow has no roles yet.</p>'}
      </div>` : ''}
      ${privacyFields(s, c.private, c.memberIds ?? [], c.roleIds ?? [])}
      <div class="error" id="modal-error"></div>
      <div class="modal-row">
        <button type="button" class="btn danger" id="room-delete">Delete room</button>
        ${text ? `<button type="button" class="btn secondary" id="room-archive">${c.archived ? 'Unarchive' : 'Archive'}</button>` : ''}
        <span class="spacer"></span>
        <button type="button" class="btn secondary" data-close>Cancel</button>
        <button type="submit" class="btn">Save</button>
      </div>
    </form>`);
  wirePrivacyFields();
  $('#room-announce')?.addEventListener('change', (e) => $('#room-posters').classList.toggle('hidden', !e.target.checked));
  $('#room-archive')?.addEventListener('click', async () => {
    if (!c.archived && !confirm(`Archive ${c.name}? It moves to the bottom of the list, keeps everything said in it, and takes no new messages.`)) return;
    try {
      handleEvent({ type: 'server_updated', server: await api(`/api/channels/${c.id}`, { method: 'PATCH', body: { archived: !c.archived } }) });
      closeModal();
    } catch (err) { $('#modal-error').textContent = err.message; }
  });
  $('#room-form').onsubmit = async (e) => {
    e.preventDefault();
    const extra = text ? {
      topic: $('#room-topic').value,
      slow: Number($('#room-slow').value),
      announce: $('#room-announce').checked,
      postRoleIds: [...document.querySelectorAll('#post-roles input:checked')].map((i) => Number(i.value)),
    } : {};
    try {
      const updated = await api(`/api/channels/${c.id}`, { method: 'PATCH', body: { name: $('#room-name').value, ...extra, ...readPrivacyFields() } });
      state.servers.set(updated.id, updated);
      closeModal();
      renderChannels();
      if (c.id === state.channelId) renderChatHeader();
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
    let id = state.dmOrder.find((d) => !state.servers.get(d).group && partner(state.servers.get(d)).id === userId);
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
    const li = document.createElement('li');
    li.className = 'dm' + (id === state.serverId ? ' active' : serverUnread(s) ? ' unread' : '');
    let av;
    if (s.group) av = groupAvatar();
    else {
      const p = partner(s);
      av = document.createElement('span');
      av.className = 'avatar xs';
      setAvatar(av, p.username, avatarOf(p.id, p.avatar));
    }
    const name = document.createElement('span');
    name.className = 'dm-name';
    name.textContent = dmTitle(s);
    li.append(av, name);
    if (notifyState(s, null).muted) li.classList.add('muted-room');
    li.oncontextmenu = (e) => { e.preventDefault(); openNotifyMenu(li, s); };
    const n = id === state.serverId || notifyState(s, null).muted ? 0 : s.channels.reduce((sum, c) => sum + (c.unread ?? 0), 0);
    if (n) li.insertAdjacentHTML('beforeend', `<span class="ping-count">${n > 99 ? '99+' : n}</span>`);
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

// Pick someone you share a burrow with, or several for a group conversation.
function openNewDm() {
  peoplePicker({
    title: 'New message',
    intro: 'Pick one person, or a few for a group conversation.',
    list: messageablePeople(),
    button: (n) => (n > 1 ? `Start a group of ${n + 1}` : 'Message'),
    extra: '<label id="group-name-row" class="hidden">Group name (optional)<input id="new-group-name" maxlength="64" placeholder="e.g. Road trip" /></label>',
    wire: (picked) => $('#group-name-row').classList.toggle('hidden', picked.size < 2),
    onDone: async (ids) => {
      if (ids.length === 1) return openDm(ids[0]);
      const s = await api('/api/dms', { method: 'POST', body: { userIds: ids, name: $('#new-group-name').value } });
      addDm(s);
      closeModal();
      store.set('lastDm', s.id);
      selectServer(s.id);
      showView('chat');
    },
  });
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
    <h3>Direct messages</h3>
    <label class="check"><input type="checkbox" id="read-receipts" ${state.me.readReceipts !== false ? 'checked' : ''} /> Show when I've read a message</label>
    <span class="small muted">Shows "Seen" under messages in direct messages. You only see it for others while yours is on too.</span>
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
  $('#read-receipts').onchange = async (e) => {
    try { state.me.readReceipts = (await api('/api/me', { method: 'PATCH', body: { readReceipts: e.target.checked } })).readReceipts; }
    catch (err) { e.target.checked = !e.target.checked; alertError(err); }
  };
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
      try { applyUser(await uploadPicture('/api/me/avatar', await squarePicture(file))); }
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

async function uploadPicture(path, blob) {
  const res = await fetch(state.serverUrl + path, {
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
    b.innerHTML = `<span class="r-emoji">${emojiHtml(r.emoji)}</span><span class="r-count">${r.userIds.length}</span>`;
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
    b.onclick = () => { closeEmojiPicker(); toggleReaction(m, e); rememberEmoji(e); };
    picker.append(b);
  }
  const all = document.createElement('button');
  all.className = 'more-emoji';
  all.title = 'All emoji, and this burrow\'s own';
  all.textContent = '+';
  all.onclick = () => { closeEmojiPicker(); openEmojiPanel(anchor, (text) => toggleReaction(m, text)); };
  picker.append(all);
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

// ---------------------------------------------------------------- GIFs

// The GIF picker opens above the message box: trending GIFs first, then whatever you search for.
// Searches and previews go through the Burrow server, which keeps the KLIPY key and your address to itself.
// Picking one sends it straight away (as a reply, if you're replying), and leaves what you typed alone.
const gifPicker = $('#gif-picker');
const gifGrid = $('#gif-grid');
const gifSearch = $('#gif-search');
const gif = { query: null, page: 0, hasMore: false, loading: false, seq: 0, timer: 0 };

function toggleGifPicker() {
  if (!gifPicker.classList.contains('hidden')) return closeGifPicker();
  closeMentions();
  gifPicker.classList.remove('hidden');
  $('#gif-btn').setAttribute('aria-expanded', 'true');
  if (gif.query === null) loadGifs('');
  if (!isPhone()) gifSearch.focus();
  document.addEventListener('mousedown', outsideGifPicker);
}
function outsideGifPicker(e) { if (!e.target.closest('#gif-picker, #gif-btn')) closeGifPicker(); }
function closeGifPicker() {
  if (gifPicker.classList.contains('hidden')) return;
  gifPicker.classList.add('hidden');
  $('#gif-btn').setAttribute('aria-expanded', 'false');
  document.removeEventListener('mousedown', outsideGifPicker);
}

async function loadGifs(query, more = false) {
  if (more && (gif.loading || !gif.hasMore)) return;
  const seq = ++gif.seq;
  gif.loading = true;
  if (!more) { gif.query = query; gif.page = 0; gifGrid.replaceChildren(); gifGrid.scrollTop = 0; }
  $('#gif-status').textContent = 'Loading…';
  try {
    const page = gif.page + 1;
    const res = await api(`/api/gifs?${new URLSearchParams({ q: query, page })}`);
    if (seq !== gif.seq) return; // a newer search took over
    gif.page = page;
    gif.hasMore = res.hasMore && res.items.length > 0;
    gifGrid.append(...res.items.map(gifTile));
    $('#gif-status').textContent = gifGrid.children.length ? '' : query ? `No GIFs for "${query}"` : 'No GIFs right now';
  } catch (err) {
    if (seq === gif.seq) $('#gif-status').textContent = err.message;
  } finally {
    if (seq === gif.seq) gif.loading = false;
  }
}

function gifTile(g) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'gif-tile';
  b.title = g.title || 'GIF';
  b.style.aspectRatio = `${g.width} / ${g.height}`;
  const img = document.createElement('img');
  img.src = state.serverUrl + g.preview;
  img.alt = g.title || 'GIF';
  img.loading = 'lazy';
  img.onerror = () => b.remove();
  b.append(img);
  b.onclick = () => sendGif(g);
  return b;
}

async function sendGif(g) {
  const channelId = state.channelId;
  if (!channelId) return;
  const replyTo = state.replyTo;
  closeGifPicker();
  setReply(null);
  try {
    const att = await api(`/api/channels/${channelId}/gifs`, { method: 'POST', body: { id: g.id } });
    const body = { content: '', attachmentIds: [att.id], replyTo: replyTo?.id };
    if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type: 'send', channelId, ...body }));
    else await api(`/api/channels/${channelId}/messages`, { method: 'POST', body });
  } catch (err) {
    if (replyTo && !state.replyTo) setReply(replyTo);
    alertError(err);
  }
  if (!isPhone()) input.focus();
}

$('#gif-btn').onclick = toggleGifPicker;
gifSearch.addEventListener('input', () => {
  clearTimeout(gif.timer);
  gif.timer = setTimeout(() => loadGifs(gifSearch.value.trim()), 350);
});
gifSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); clearTimeout(gif.timer); loadGifs(gifSearch.value.trim()); }
});
gifGrid.addEventListener('scroll', () => {
  if (gifGrid.scrollTop + gifGrid.clientHeight > gifGrid.scrollHeight - 300) loadGifs(gif.query, true);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeGifPicker(); });

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
    if (p.voiceSeconds) xhr.setRequestHeader('x-voice-seconds', String(p.voiceSeconds));
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
    if (!p.error) {
      const sp = document.createElement('button');
      sp.type = 'button';
      sp.className = 'pending-spoiler' + (p.spoiler ? ' on' : '');
      sp.textContent = p.spoiler ? 'Spoiler' : 'Mark spoiler';
      sp.title = p.spoiler ? 'Hidden until someone clicks it. Click to show it normally.' : 'Hide it until someone clicks it';
      sp.onclick = () => { p.spoiler = !p.spoiler; renderPending(); };
      chip.append(sp);
      if (p.spoiler) chip.classList.add('spoilered');
    }
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
    let el;
    if (IMAGE_TYPES.test(a.type)) {
      el = document.createElement('img');
      el.className = 'att-image';
      el.src = url;
      el.alt = a.name;
      el.loading = 'lazy';
      el.onload = () => { if (state.reachedEnd && messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 400) messagesEl.scrollTop = messagesEl.scrollHeight; };
      el.onclick = () => openImage(a, url);
    } else if (VIDEO_TYPES.test(a.type)) {
      el = document.createElement('video');
      el.className = 'att-video';
      el.src = url;
      el.controls = true;
      el.preload = 'metadata';
      el.playsInline = true;
    } else if (/^audio\//.test(a.type) && a.voiceSeconds != null) {
      el = voicePlayer(a, url);
    } else if (/^audio\//.test(a.type)) {
      el = document.createElement('div');
      el.className = 'att-audio';
      el.innerHTML = `<span class="att-audio-name">${escapeHtml(a.name)}</span>`;
      const au = document.createElement('audio');
      au.src = url;
      au.controls = true;
      au.preload = 'metadata';
      el.append(au);
    } else if (TEXT_TYPES.test(a.type) && a.size <= 512 * 1024) {
      el = textPreview(a, url);
    } else {
      el = document.createElement('a');
      el.className = 'att-file';
      el.href = url;
      el.target = '_blank';
      el.rel = 'noopener';
      el.innerHTML = `<span class="file-icon">${FILE_ICON}</span><span class="att-file-text"><span class="att-file-name">${escapeHtml(a.name)}</span><span class="muted small">${formatSize(a.size)}</span></span>`;
    }
    wrap.append(a.spoiler ? spoilerWrap(el) : el);
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

$('#file-input').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
input.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (files.length) { e.preventDefault(); addFiles(files); return; }
  // Long text goes up as a file, so it doesn't take over the room (and isn't cut off at 4000 characters).
  const text = e.clipboardData?.getData('text/plain') ?? '';
  const total = input.value.length - (input.selectionEnd - input.selectionStart) + text.length;
  if (text.length > LONG_PASTE || total > 4000) {
    if (!state.maxUploadBytes) {
      if (total > 4000) { e.preventDefault(); alert('That text is too long for one message (at most 4000 characters).'); }
      return;
    }
    e.preventDefault();
    addFiles([new File([text], 'message.txt', { type: 'text/plain' })]);
    toast('Long text was added as a file, message.txt. Remove it from the tray to paste it as a message instead.', { timeout: 6000 });
  }
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
  const voice = { channelId, room: null, muted: false, deafened: false };
  state.voice = voice;
  state.fireside = { channelId, messages: [], unread: 0 };
  // Made now, while the click still counts, or some browsers start it paused.
  if (wantsMicProcessor()) voice.micCtx = newMicContext();
  renderVoiceBar('Connecting…');
  goToVoice(); // sit down at the fire
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
      audioCaptureDefaults: { ...micConstraints(), deviceId: await deviceIdFor('audioinput') },
      videoCaptureDefaults: { deviceId: await deviceIdFor('videoinput') },
      ...(canPickOutput ? { audioOutput: { deviceId: await deviceIdFor('audiooutput') } } : {}),
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
        const volume = heard(pub.source === LK.Track.Source.ScreenShareAudio ? streamVolumeFor(id) : volumeFor(id));
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
      .on(LK.RoomEvent.TrackSubscribed, renderFire)
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
    // Burrow's noise filter works on your voice before it's encrypted and sent.
    if (wantsMicProcessor()) await micTrack()?.setProcessor(micProcessor(voice)).catch((err) => console.warn("Couldn't start the noise filter:", err));
    state.ws?.send(JSON.stringify({ type: 'voice_join', channelId, ...voiceFlags() }));
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
  state.fireside = { channelId: null, messages: [], unread: 0 };
  state.firesideOpen = false;
  renderFireside();
  stopAppAudio(voice);
  voice.room?.disconnect();
  clearTimeout(voice.crypto?.retry);
  clearTimeout(voice.crypto?.grace);
  clearTimeout(voice.crypto?.rotateTimer);
  voice.crypto?.worker.terminate();
  voice.micCtx?.close().catch(() => {});
  closeVolume();
  closeStage();
  $('#voice-audio').replaceChildren();
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type: 'voice_leave' }));
  renderVoiceBar();
  renderChannels();
}

function setMicMuted(voice, muted) {
  voice.muted = muted;
  voice.room.localParticipant.setMicrophoneEnabled(!muted);
  if (muted) state.mutedInVoice.add(state.me.id);
  else state.mutedInVoice.delete(state.me.id);
}

function toggleMute() {
  const voice = state.voice;
  if (!voice?.room) return;
  // Unmuting while deafened turns your sound back on too, like Discord.
  if (voice.deafened && voice.muted) setDeafened(voice, false);
  setMicMuted(voice, !voice.muted);
  voiceChanged();
}

/** Deafened: you hear nobody (voices and streams) and your mic is off, and everyone can see it. */
function toggleDeafen() {
  const voice = state.voice;
  if (!voice?.room) return;
  if (voice.deafened) {
    setDeafened(voice, false);
    setMicMuted(voice, voice.mutedBeforeDeafen);
  } else {
    voice.mutedBeforeDeafen = voice.muted;
    setDeafened(voice, true);
    setMicMuted(voice, true);
  }
  voiceChanged();
}

function setDeafened(voice, deafened) {
  voice.deafened = deafened;
  applyAllVolumes();
}

/** Muted or deafened changed: tell the burrow, and redraw. */
function voiceChanged() {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type: 'voice_status', ...voiceFlags() }));
  renderVoiceBar();
  renderChannels();
}
const voiceFlags = () => ({ muted: !!state.voice?.muted, deafened: !!state.voice?.deafened });

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
  $('#voice-deafen').classList.toggle('on', voice.deafened);
  $('#voice-deafen').title = voice.deafened ? 'Undeafen' : 'Deafen (hear nobody, and mute)';
  $('#voice-deafen').innerHTML = voice.deafened ? HEADPHONES_OFF : HEADPHONES_ON;
  const lp = voice.room?.localParticipant;
  const camera = !!lp?.isCameraEnabled, screen = !!lp?.isScreenShareEnabled;
  $('#voice-camera').classList.toggle('on', camera);
  $('#voice-camera').title = camera ? 'Turn off camera' : 'Turn on camera';
  $('#voice-screen').classList.toggle('on', screen);
  $('#voice-screen').title = screen ? 'Stop sharing your screen' : 'Share your screen';
  for (const id of ['#voice-camera', '#voice-screen', '#voice-watch']) $(id).disabled = !voice.room || !!status;
  // The same buttons under the fire.
  for (const name of ['mute', 'deafen', 'camera', 'screen']) {
    const from = $(`#voice-${name}`), to = $(`#fire-${name}`);
    to.innerHTML = from.innerHTML;
    to.title = from.title;
    to.setAttribute('aria-label', from.title);
    to.classList.toggle('on', from.classList.contains('on'));
    to.disabled = from.disabled;
  }
  $('#fire-lock').classList.toggle('hidden', !!status || !sealed);
  renderFire(status);
}

const HEADPHONES_ON = '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 0 0-9 9v6a3 3 0 0 0 3 3h2v-8H5v-1a7 7 0 0 1 14 0v1h-3v8h2a3 3 0 0 0 3-3v-6a9 9 0 0 0-9-9Z"/></svg>';
const HEADPHONES_OFF = '<svg viewBox="0 0 24 24"><path d="M3.3 2 2 3.3l3.5 3.5A8.9 8.9 0 0 0 3 12v6a3 3 0 0 0 3 3h2v-8H5v-1c0-1.5.5-2.9 1.3-4l9.4 9.4V21h2c.4 0 .8-.1 1.2-.3l.8.8 1.3-1.3L3.3 2ZM12 3c-2 0-3.8.6-5.3 1.7l1.4 1.4A7 7 0 0 1 19 12v1h-3v.2l5 5V12a9 9 0 0 0-9-9Z"/></svg>';
const DEAFENED_ICON = HEADPHONES_OFF.replace('<svg', '<svg class="muted-icon" aria-label="Deafened"');

$('#voice-mute').onclick = toggleMute;
$('#voice-deafen').onclick = toggleDeafen;
$('#voice-settings').onclick = openVoiceSettings;
$('#voice-leave').onclick = () => leaveVoice();
$('#voice-camera').onclick = toggleCamera;
$('#voice-screen').onclick = toggleScreen;
$('#voice-watch').onclick = () => (state.stageOpen ? closeStage() : goToVoice());
$('#stage-close').onclick = () => closeStage();
$('#fire-back').onclick = () => { closeStage(); showView('rooms'); };
$('#fire-mute').onclick = toggleMute;
$('#fire-deafen').onclick = toggleDeafen;
$('#fire-camera').onclick = toggleCamera;
$('#fire-screen').onclick = toggleScreen;
$('#fire-settings').onclick = openVoiceSettings;
$('#fire-settings').innerHTML = $('#voice-settings').innerHTML;
$('#fire-leave').onclick = () => leaveVoice();
$('#fire-leave').innerHTML = $('#voice-leave').innerHTML;
$('#stage-video').onclick = () => openVideo(null);
$('#video-back').onclick = () => { state.stageShow = 'fire'; focusKey = null; renderStage(); };
// Phones and tablets can't share their screen from a browser.
if (!navigator.mediaDevices?.getDisplayMedia && !window.burrowDesktop) $('#fire-screen').parentElement.classList.add('hidden');

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
    if (lp.isCameraEnabled && !state.stageOpen) goToVoice(); // so you can see yourself
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
  if (!state.voice) return;
  if (!state.stageOpen) state.stageShow = 'fire';
  state.stageOpen = true;
  $('#stage').classList.remove('hidden');
  $('#app').classList.add('watching');
  renderVoicePlaces();
  renderStage();
  renderFireside();
}

function closeStage() {
  if (!state.stageOpen) return;
  state.stageOpen = false;
  focusKey = null;
  state.firesideOpen = false;
  $('#stage').classList.add('hidden');
  $('#app').classList.remove('watching');
  renderVoicePlaces();
  renderStage();
}

/** Swaps the fire for the video grid, with one tile ("id:screen" or "id:camera") shown big. */
function openVideo(key) {
  if (!state.voice?.room) return;
  if (!state.stageOpen) openStage();
  state.stageShow = 'video';
  focusKey = key;
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
  $('#voice-watch').title = state.stageOpen ? 'Back to chat' : 'Open the fire';
  $('#stage').dataset.show = state.stageShow;
  $('#stage-video').classList.toggle('hidden', !sharing.size);
  if (JSON.stringify([...sharing]) !== JSON.stringify([...state.sharing])) {
    state.sharing = sharing;
    renderChannels();
  }

  // Off the video grid, let go of its video so none of it is downloaded. (The fire shows cameras itself.)
  const wanted = [];
  if (state.stageOpen && state.stageShow === 'video' && room) {
    const ch = [...state.servers.values()].flatMap((s) => s.channels).find((c) => c.id === state.voice.channelId);
    $('#video-title').textContent = ch?.name ?? 'Voice';
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
  renderFire();
}

// ---------------------------------------------------------------- the Campfire
//
// Everyone in the voice room sits in a circle around the fire: who's talking, muted or
// deafened, their camera if it's on, and a way to watch anyone sharing their screen.
// Next to it is the fireside chat, which only the people at the fire see.

const seats = new Map(); // user id -> { el, face, track }

function clearSeats() {
  for (const seat of seats.values()) if (seat.track && seat.face) seat.track.detach(seat.face);
  seats.clear();
  $('#fire-ring').querySelectorAll('.seat').forEach((el) => el.remove());
}

function renderFire(status) {
  const voice = state.voice;
  if (!voice || !state.stageOpen || state.stageShow !== 'fire') return clearSeats();
  const LK = window.LivekitClient;
  const room = voice.room;
  const ch = [...state.servers.values()].flatMap((s) => s.channels).find((c) => c.id === voice.channelId);
  const ids = [...(ch?.voiceUsers ?? [])];
  if (!ids.includes(state.me.id)) ids.push(state.me.id);
  const s = [...state.servers.values()].find((x) => x.channels.includes(ch));
  $('#stage-title').textContent = ch && s && !isDm(s) ? `${s.name}'s ${ch.name}` : ch?.name ?? 'Campfire';
  const streamer = ids.find((id) => id !== state.me.id && state.sharing.get(id)?.screen);
  $('#fire-count').textContent = (typeof status === 'string' ? status : !room ? 'Connecting…' : `${ids.length} gathered`)
    + (streamer ? ` · ${nameOf(streamer)} is sharing` : '');

  // Seats are spread evenly around the fire, starting at the top. A small fire keeps a few open seats.
  const total = Math.max(5, ids.length);
  const ring = $('#fire-ring');
  ring.classList.toggle('crowded', total > 8);
  // How far from the fire the seats are, as a share of the circle's width and height (narrower on phones).
  const css = getComputedStyle(ring);
  const rx = Number(css.getPropertyValue('--rx')) || 41, ry = Number(css.getPropertyValue('--ry')) || 40;
  const place = (el, i) => {
    const a = (-90 + (i * 360) / total) * (Math.PI / 180);
    el.style.left = `${50 + rx * Math.cos(a)}%`;
    el.style.top = `${50 + ry * Math.sin(a)}%`;
  };

  for (const [id, seat] of seats) {
    if (ids.includes(id)) continue;
    if (seat.track && seat.face) seat.track.detach(seat.face);
    seat.el.remove();
    seats.delete(id);
  }
  ids.forEach((id, i) => {
    const me = id === state.me.id;
    const name = nameOf(id, me ? state.me.username : '?');
    let seat = seats.get(id);
    if (!seat) {
      const el = document.createElement('div');
      el.innerHTML = '<span class="seat-face-wrap"></span><span class="seat-name"></span><span class="seat-status"></span>';
      seat = { el, face: null, track: null };
      seats.set(id, seat);
      ring.append(el);
    }
    place(seat.el, i);
    const participant = !room ? null : me ? room.localParticipant : room.remoteParticipants.get(String(id));
    const camPub = participant && LK ? participant.getTrackPublication(LK.Track.Source.Camera) : null;
    const camTrack = camPub && !camPub.isMuted ? camPub.track ?? null : null;
    const sharing = state.sharing.get(id);
    const deafened = ch?.voiceDeafened?.includes(id);
    const muted = state.mutedInVoice.has(id) || ch?.voiceMuted?.includes(id);
    const speaking = state.speaking.has(id) && !muted;

    // The face: their camera if it's on, else their picture. Clicking someone else changes how loud they are.
    if (seat.track !== camTrack || !seat.face) {
      if (seat.track && seat.face) seat.track.detach(seat.face);
      const wrap = seat.el.querySelector('.seat-face-wrap');
      wrap.replaceChildren();
      const button = document.createElement(me && !camTrack ? 'span' : 'button');
      button.className = 'seat-face';
      if (camTrack) {
        const video = camTrack.attach();
        video.muted = true;
        button.append(video);
        button.classList.add('video');
        button.onclick = (e) => { e.stopPropagation(); openVideo(`${id}:camera`); };
        button.title = me ? 'See your camera bigger' : `See ${name}'s camera bigger`;
      } else {
        const av = document.createElement('span');
        av.className = 'avatar';
        setAvatar(av, name, avatarOf(id));
        button.append(av);
        if (!me) {
          button.onclick = (e) => { e.stopPropagation(); openVolume(button, id, name); };
          button.title = `${name}'s volume`;
        }
      }
      wrap.append(button);
      seat.face = camTrack ? button.firstChild : null;
      seat.track = camTrack;
      if (!camTrack) seat.face = button;
    }
    const wrap = seat.el.querySelector('.seat-face-wrap');
    wrap.querySelector('.seat-live')?.remove();
    if (sharing?.screen) wrap.insertAdjacentHTML('beforeend', '<span class="seat-live">LIVE</span>');
    seat.el.className = 'seat' + (me ? ' me' : '') + (speaking ? ' speaking' : '') + (camTrack ? ' has-video' : '');
    seat.el.querySelector('.seat-name').textContent = me ? `${name} (you)` : name;
    const v = me ? 1 : volumeFor(id);
    const statusText = deafened ? 'Deafened' : muted ? 'Muted' : speaking ? 'Talking' : camTrack ? 'Camera on' : v !== 1 ? `${Math.round(v * 100)}% volume` : '';
    const statusEl = seat.el.querySelector('.seat-status');
    statusEl.textContent = statusText;
    statusEl.className = 'seat-status' + (speaking ? ' talking' : '');
    let watch = seat.el.querySelector('.seat-watch');
    if (sharing?.screen && !watch) {
      watch = document.createElement('button');
      watch.className = 'seat-watch';
      watch.innerHTML = `${SCREEN_ICON}<span></span>`;
      watch.onclick = (e) => { e.stopPropagation(); openVideo(`${id}:screen`); };
      seat.el.append(watch);
    } else if (!sharing?.screen && watch) watch.remove();
    if (watch) watch.lastChild.textContent = me ? 'Your screen' : 'Watch screen';
  });

  // Open seats fill the rest of a small circle.
  ring.querySelectorAll('.seat.open').forEach((el) => el.remove());
  for (let i = ids.length; i < total; i++) {
    const el = document.createElement('div');
    el.className = 'seat open';
    el.innerHTML = '<span class="seat-face"></span><span class="seat-status">Open seat</span>';
    place(el, i);
    ring.append(el);
  }
}

// The fireside chat is in view: docked beside the fire on a wide screen, or opened over it.
const fireChatDocked = () => matchMedia('(min-width: 1100px)').matches;
let firesideHidden = store.get('firesideHidden') === '1';
const firesideVisible = () => state.stageOpen && state.stageShow === 'fire' && !document.hidden
  && (fireChatDocked() ? !firesideHidden : state.firesideOpen);

function renderFireside({ added } = {}) {
  const space = $('#stage .fire-space');
  space.classList.toggle('chat-hidden', firesideHidden);
  space.classList.toggle('chat-open', state.firesideOpen);
  if (firesideVisible()) state.fireside.unread = 0;
  const { messages, unread } = state.fireside;
  for (const id of ['#fire-chat-badge', '#fire-chat-bar-badge']) {
    $(id).textContent = unread > 9 ? '9+' : unread;
    $(id).classList.toggle('hidden', !unread);
  }
  $('#campfire-chip').classList.toggle('unread', unread > 0);
  const last = messages.at(-1);
  $('#fire-chat-last').textContent = last ? `${last.author}: ${last.content}` : 'Only people at the fire see it';

  const list = $('#fire-chat-list');
  const stick = list.scrollHeight - list.scrollTop - list.clientHeight < 60 || added?.userId === state.me?.id;
  const line = (m, prev) => {
    const el = document.createElement('div');
    el.className = 'fire-msg' + (m.userId === state.me?.id ? ' mine' : '');
    // Messages from the same person close together share one name.
    if (!prev || prev.userId !== m.userId || m.createdAt - prev.createdAt > 5 * 60_000) {
      const who = document.createElement('b');
      who.textContent = nameOf(m.userId, m.author);
      const srv = fireServer();
      const color = srv && roleColor(srv, m.userId);
      if (color) who.style.color = color;
      el.append(who);
    } else el.classList.add('more');
    const text = document.createElement('div');
    text.textContent = m.content;
    el.append(text);
    el.title = new Date(m.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return el;
  };
  if (added && list.querySelectorAll('.fire-msg').length === messages.length - 1) {
    list.append(line(added, messages.at(-2)));
  } else {
    list.replaceChildren(list.firstElementChild, ...messages.map((m, i) => line(m, messages[i - 1])));
  }
  if (stick) list.scrollTop = list.scrollHeight;
}

/** The burrow whose fire you're at. */
const fireServer = () => [...state.servers.values()].find((s) => s.channels.some((c) => c.id === state.voice?.channelId));

$('#fire-chat-form').onsubmit = (e) => {
  e.preventDefault();
  const content = $('#fire-chat-input').value.trim();
  if (!content || state.ws?.readyState !== WebSocket.OPEN || !state.voice) return;
  state.ws.send(JSON.stringify({ type: 'fireside_send', content }));
  $('#fire-chat-input').value = '';
};
const showFireside = (show) => {
  if (fireChatDocked()) {
    firesideHidden = !show;
    store.set('firesideHidden', show ? null : '1');
  } else state.firesideOpen = show;
  renderFireside();
  if (show) $('#fire-chat-input').focus();
};
$('#fire-chat-open').onclick = () => showFireside(true);
$('#fire-chat-bar').onclick = () => showFireside(true);
$('#fire-chat-close').onclick = () => showFireside(false);
document.addEventListener('visibilitychange', () => { if (state.voice) renderFireside(); });

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
  value = heard(value);
  const pub = participant.getTrackPublication(source);
  if (value === 0) return pub?.setSubscribed(false);
  if (pub && !pub.isSubscribed) pub.setSubscribed(true); // the volume is set again when it arrives
  participant.setVolume(value, source);
}

/** How loud a sound plays: your setting for that person, times everyone's volume. Nothing while deafened. */
const heard = (value) => (state.voice?.deafened ? 0 : value * voicePrefs.outputVolume);

function applyAllVolumes() {
  const LK = window.LivekitClient;
  for (const p of state.voice?.room?.remoteParticipants.values() ?? []) {
    const id = Number(p.identity);
    applyVolume(p, LK.Track.Source.Microphone, volumeFor(id));
    applyVolume(p, LK.Track.Source.ScreenShareAudio, streamVolumeFor(id));
  }
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
    if (!soundCtx) {
      soundCtx = new AudioContext();
      setChimeOutput();
    }
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

// ---------------------------------------------------------------- your voice and video settings
//
// Which microphone, speakers and camera to use, how loud you are, how loud everyone else is, and
// how much background noise to take out. All kept on this device. Everything but voice quality
// changes straight away, even in the middle of a call.

const VOICE_QUALITY = {
  standard: { bitrate: 48000, label: 'Standard (48 kbps)' },
  high: { bitrate: 64000, label: 'High (64 kbps)' },
  best: { bitrate: 96000, label: 'Best (96 kbps)' },
};
// "strong" and "strongest" run a small noise-removal model on your device (RNNoise and GTCRN,
// in vendor/noise), on your voice before it's encrypted, so they work with end-to-end encryption.
const NOISE_LEVELS = {
  off: { label: 'Off', hint: 'Nothing is filtered. Best for music or an instrument.' },
  light: { label: 'Light', hint: "Your browser's own filter. Takes out steady hums and hiss." },
  strong: { label: 'Strong', model: 'rnnoise', hint: 'Takes out fans, typing, clicks and chatter behind you.' },
  strongest: { label: 'Strongest', model: 'gtcrn', hint: 'Takes out even more noise, but your voice sounds a little flatter.' },
};
const voicePrefs = (() => {
  const defaults = { quality: 'high', noise: 'strong', inputVolume: 1, outputVolume: 1 };
  try {
    const saved = JSON.parse(store.get('voicePrefs')) ?? {};
    // Noise suppression used to be just on or off.
    if (saved.noiseSuppression === false && !saved.noise) saved.noise = 'off';
    delete saved.noiseSuppression;
    return { ...defaults, ...saved };
  } catch { return defaults; }
})();
const saveVoicePrefs = () => store.set('voicePrefs', JSON.stringify(voicePrefs));

/** What the browser itself does to your microphone. The stronger filters replace its noise filter rather than stack on it. */
function micConstraints() {
  const level = voicePrefs.noise;
  return { echoCancellation: true, noiseSuppression: level === 'light', autoGainControl: level !== 'off' };
}
const wantsMicProcessor = () => !!NOISE_LEVELS[voicePrefs.noise]?.model || voicePrefs.inputVolume !== 1;

// ---- devices

const DEVICE_NAMES = { audioinput: 'Microphone', audiooutput: 'Speakers', videoinput: 'Camera' };
const savedDevices = (() => { try { return JSON.parse(store.get('devices')) ?? {}; } catch { return {}; } })();
// Burrow mixes voices with Web Audio, which can only be sent to another output where AudioContext
// has setSinkId: Chrome, Edge and the desktop app. Safari, every iPhone browser and Firefox can't.
const canPickOutput = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
const isAppleMobile = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

async function listDevices() {
  try {
    // "default" and "communications" are Chrome's aliases for real devices; "System default" covers them.
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
  } catch { return []; }
}

/** The device you picked: by its id, or by its name, since some browsers change ids between visits. */
async function deviceIdFor(kind) {
  const saved = savedDevices[kind];
  if (!saved) return undefined;
  const list = (await listDevices()).filter((d) => d.kind === kind);
  const found = list.find((d) => d.deviceId === saved.id) ?? list.find((d) => saved.label && d.label === saved.label);
  // A microphone or camera that isn't listed yet (no permission) is still worth asking for: the browser falls back if it's gone.
  return found?.deviceId ?? (kind === 'audiooutput' ? undefined : saved.id);
}

async function pickDevice(kind, id, label) {
  if (id) savedDevices[kind] = { id, label };
  else delete savedDevices[kind];
  store.set('devices', JSON.stringify(savedDevices));
  if (kind === 'audiooutput') setChimeOutput();
  const room = state.voice?.room;
  if (!room) return;
  try {
    await room.switchActiveDevice(kind, id || 'default', !!id);
  } catch (err) {
    alert(mediaError(err, DEVICE_NAMES[kind].toLowerCase()));
  }
}

/** Chimes play through the speakers you picked too. */
async function setChimeOutput() {
  if (!soundCtx?.setSinkId) return;
  try { await soundCtx.setSinkId((await deviceIdFor('audiooutput')) ?? ''); } catch {}
}

// ---- your microphone, through the noise filter

const newMicContext = () => new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' }); // both filters want 48 kHz

/** Browsers start audio paused until you've clicked; if that happened, the next click starts it. */
function keepRunning(ctx) {
  if (ctx.state === 'running') return;
  ctx.resume().catch(() => {});
  const resume = () => ctx.state !== 'closed' && ctx.resume().catch(() => {});
  document.addEventListener('pointerdown', resume, { once: true });
  document.addEventListener('keydown', resume, { once: true });
}

const noiseWasm = new Map(); // model -> Promise<ArrayBuffer>, downloaded once
async function noiseFilter(ctx, model) {
  if (!noiseWasm.has(model)) {
    const loading = fetch(`vendor/noise/${model}.wasm`).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.arrayBuffer();
    });
    loading.catch(() => noiseWasm.delete(model));
    noiseWasm.set(model, loading);
  }
  const [wasmBinary] = await Promise.all([noiseWasm.get(model), ctx.audioWorklet.addModule(`vendor/noise/${model}.worklet.js`)]);
  const node = new AudioWorkletNode(ctx, `@sapphi-red/web-noise-suppressor/${model}`, {
    channelCount: 1, channelCountMode: 'explicit', processorOptions: { maxChannels: 1, wasmBinary },
  });
  node.onprocessorerror = () => console.warn(`The ${model} noise filter stopped working.`);
  return node;
}

/**
 * Microphone in, filtered and turned up or down, out as a new track. If the filter can't load,
 * your voice still goes through, just unfiltered.
 */
async function micChain(ctx, track) {
  const model = NOISE_LEVELS[voicePrefs.noise]?.model;
  let filter = null;
  if (model) {
    try { filter = await noiseFilter(ctx, model); } catch (err) { console.warn(`Couldn't load the ${model} noise filter:`, err); }
  }
  const gain = ctx.createGain();
  gain.gain.value = voicePrefs.inputVolume;
  const out = ctx.createMediaStreamDestination();
  out.channelCount = 1;
  filter?.connect(gain);
  gain.connect(out);
  let source = null;
  const chain = {
    track: out.stream.getAudioTracks()[0],
    filtered: !!filter,
    gain,
    setInput(t) {
      source?.disconnect();
      source = ctx.createMediaStreamSource(new MediaStream([t]));
      source.connect(filter ?? gain);
    },
    setVolume(v) { gain.gain.setTargetAtTime(v, ctx.currentTime, 0.02); },
    destroy() {
      source?.disconnect();
      filter?.port.postMessage('destroy');
      filter?.disconnect();
      gain.disconnect();
      chain.track.stop();
    },
  };
  chain.setInput(track);
  return chain;
}

/** The same chain as a LiveKit track processor, so what's sent (and encrypted) is the filtered voice. */
function micProcessor(voice) {
  let chain = null;
  const proc = {
    name: 'burrow-mic',
    processedTrack: undefined,
    async init({ track }) {
      voice.micCtx ??= newMicContext();
      keepRunning(voice.micCtx);
      chain?.destroy();
      chain = await micChain(voice.micCtx, track);
      proc.processedTrack = chain.track;
      voice.micChain = chain;
    },
    // A new microphone: same filter, new input, so nothing needs re-sending.
    async restart({ track }) { if (chain) chain.setInput(track); else await proc.init({ track }); },
    async destroy() {
      chain?.destroy();
      if (voice.micChain === chain) voice.micChain = null;
      chain = null;
    },
  };
  return proc;
}

const micTrack = () => state.voice?.room?.localParticipant.getTrackPublication(window.LivekitClient.Track.Source.Microphone)?.audioTrack;

/** The noise level changed mid-call: new browser settings, and the filter swapped. */
async function applyNoiseLevel() {
  const voice = state.voice, track = micTrack();
  if (!voice || !track) return;
  try {
    const deviceId = voice.room.getActiveDevice('audioinput');
    voice.room.options.audioCaptureDefaults = { ...voice.room.options.audioCaptureDefaults, ...micConstraints() };
    await track.restartTrack({ ...micConstraints(), ...(deviceId ? { deviceId } : {}) });
    if (wantsMicProcessor()) await track.setProcessor(micProcessor(voice));
    else if (track.getProcessor()) await track.stopProcessor();
  } catch (err) {
    console.warn("Couldn't change noise isolation:", err);
  }
}

function applyInputVolume() {
  const track = micTrack();
  if (!track) return;
  if (state.voice.micChain) state.voice.micChain.setVolume(voicePrefs.inputVolume);
  else if (wantsMicProcessor()) track.setProcessor(micProcessor(state.voice)).catch((err) => console.warn("Couldn't change your volume:", err));
}

// ---- trying your microphone and camera

let micTest = null; // { stream, ctx, chain, audio, frame }

async function startMicTest() {
  stopMicTest();
  const test = {};
  micTest = test;
  test.ctx = newMicContext(); // made during the click, so it isn't paused
  try {
    const deviceId = await deviceIdFor('audioinput');
    test.stream = await navigator.mediaDevices.getUserMedia({ audio: { ...micConstraints(), ...(deviceId ? { deviceId } : {}) } });
    if (micTest !== test) return test.stream.getTracks().forEach((t) => t.stop());
    test.chain = await micChain(test.ctx, test.stream.getAudioTracks()[0]);
    if (micTest !== test) return stopMicTest(test);
    const analyser = test.ctx.createAnalyser();
    analyser.fftSize = 1024;
    test.ctx.createMediaStreamSource(new MediaStream([test.chain.track])).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const draw = () => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const v of samples) sum += v * v;
      const db = 20 * Math.log10(Math.sqrt(sum / samples.length) || 1e-8);
      const bar = $('#vs-level');
      if (bar) bar.style.width = `${Math.max(0, Math.min(100, (db + 60) * (100 / 60)))}%`;
      test.frame = requestAnimationFrame(draw);
    };
    draw();
    // "Hear yourself": played back through the speakers you picked.
    test.audio = new Audio();
    test.audio.srcObject = new MediaStream([test.chain.track]);
    test.audio.muted = !$('#vs-loopback')?.checked;
    const out = await deviceIdFor('audiooutput');
    if (out && test.audio.setSinkId) await test.audio.setSinkId(out).catch(() => {});
    test.audio.play().catch(() => {});
    $('#vs-test-status').textContent = test.chain.filtered || !NOISE_LEVELS[voicePrefs.noise].model ? '' : "This device couldn't load the noise filter, so it's off.";
  } catch (err) {
    if (micTest === test) {
      stopMicTest();
      $('#vs-test-status').textContent = mediaError(err, 'microphone');
    }
    return;
  }
  fillDeviceLists(); // names show once there's permission
  renderMicTest();
}

function stopMicTest(test = micTest) {
  if (!test) return;
  if (micTest === test) micTest = null;
  cancelAnimationFrame(test.frame);
  test.audio?.pause();
  test.chain?.destroy();
  test.stream?.getTracks().forEach((t) => t.stop());
  test.ctx?.close().catch(() => {});
  if ($('#vs-level')) $('#vs-level').style.width = '0';
  renderMicTest();
}
function renderMicTest() {
  if ($('#vs-test')) $('#vs-test').textContent = micTest ? 'Stop' : 'Test';
}

let cameraPreview = null;
async function startCameraPreview() {
  stopCameraPreview();
  const preview = {};
  cameraPreview = preview;
  try {
    const deviceId = await deviceIdFor('videoinput');
    preview.stream = await navigator.mediaDevices.getUserMedia({ video: deviceId ? { deviceId } : true });
    if (cameraPreview !== preview) return preview.stream.getTracks().forEach((t) => t.stop());
    $('#vs-preview').srcObject = preview.stream;
    $('#vs-preview').classList.remove('hidden');
    $('#vs-cam').textContent = 'Stop preview';
    fillDeviceLists();
  } catch (err) {
    if (cameraPreview === preview) stopCameraPreview();
    $('#vs-cam-status').textContent = mediaError(err, 'camera');
  }
}
function stopCameraPreview() {
  cameraPreview?.stream?.getTracks().forEach((t) => t.stop());
  cameraPreview = null;
  if (!$('#vs-preview')) return;
  $('#vs-preview').srcObject = null;
  $('#vs-preview').classList.add('hidden');
  $('#vs-cam').textContent = 'Preview camera';
}

// ---- the settings themselves: in your account, and from the gear on the voice bar

function voiceSettings() {
  const pct = (v) => Math.round(v * 100);
  const outputNote = isAppleMobile
    ? 'Sound plays wherever your iPhone or iPad sends it. To switch to AirPods or a speaker, use Control Center.'
    : "This browser can't pick where sound plays, so it uses your system's choice. Chrome, Edge and the Burrow desktop app can pick.";
  return `<h3>Voice and video</h3>
    <div class="voice-settings">
      <label>Microphone<select id="vs-audioinput"></select></label>
      <div class="mic-test">
        <div class="level-meter" title="How loud you are, after the noise filter"><span id="vs-level"></span></div>
        <button type="button" class="btn secondary" id="vs-test">Test</button>
      </div>
      <label class="check"><input type="checkbox" id="vs-loopback" /> Hear yourself while testing (wear headphones)</label>
      <span class="small muted" id="vs-test-status"></span>
      <label>Your volume <span class="range-value" id="vs-in-val">${pct(voicePrefs.inputVolume)}%</span>
        <input type="range" id="vs-in" min="0" max="200" step="5" value="${pct(voicePrefs.inputVolume)}" /></label>
      <label>Noise isolation
        <select id="vs-noise">${Object.entries(NOISE_LEVELS).map(([k, n]) => `<option value="${k}" ${voicePrefs.noise === k ? 'selected' : ''}>${n.label}</option>`).join('')}</select></label>
      <span class="small muted" id="vs-noise-hint">${NOISE_LEVELS[voicePrefs.noise]?.hint ?? ''}</span>
      ${canPickOutput ? '<label>Speakers or headset<select id="vs-audiooutput"></select></label>' : `<span class="small muted">${outputNote}</span>`}
      <label>Everyone's volume <span class="range-value" id="vs-out-val">${pct(voicePrefs.outputVolume)}%</span>
        <input type="range" id="vs-out" min="0" max="200" step="5" value="${pct(voicePrefs.outputVolume)}" /></label>
      <button type="button" class="link-btn" id="vs-chime">Play a test sound</button>
      <label>Camera<select id="vs-videoinput"></select></label>
      <video id="vs-preview" class="cam-preview hidden" autoplay muted playsinline></video>
      <div class="mic-test"><button type="button" class="btn secondary" id="vs-cam">Preview camera</button><span class="small muted" id="vs-cam-status"></span></div>
      <label>Your voice quality
        <select id="voice-quality">${Object.entries(VOICE_QUALITY).map(([k, q]) => `<option value="${k}" ${voicePrefs.quality === k ? 'selected' : ''}>${q.label}</option>`).join('')}</select>
      </label>
      <span class="small muted">Voice quality changes the next time you join a voice room. Everything else changes straight away.</span>
    </div>`;
}

/** Fills in the device lists. Before Burrow may use your microphone, browsers hide the names. */
async function fillDeviceLists() {
  const devices = await listDevices();
  let unnamed = false;
  for (const kind of Object.keys(DEVICE_NAMES)) {
    const select = $(`#vs-${kind}`);
    if (!select) continue;
    const list = devices.filter((d) => d.kind === kind);
    const saved = savedDevices[kind];
    const chosen = saved && (list.find((d) => d.deviceId === saved.id) ?? list.find((d) => saved.label && d.label === saved.label));
    select.replaceChildren(new Option('System default', ''), ...list.map((d, i) => {
      unnamed ||= !d.label;
      const o = new Option(d.label || `${DEVICE_NAMES[kind]} ${i + 1}`, d.deviceId);
      o.dataset.label = d.label;
      return o;
    }));
    if (saved && !chosen) {
      const o = new Option(`${saved.label || DEVICE_NAMES[kind]} (not found)`, saved.id);
      o.dataset.label = saved.label ?? '';
      select.append(o);
    }
    select.value = chosen?.deviceId ?? saved?.id ?? '';
  }
  const status = $('#vs-test-status');
  if (status && unnamed && !micTest && !status.textContent) status.textContent = 'Press Test to see your devices by name.';
  if (status && !unnamed && status.textContent.startsWith('Press Test')) status.textContent = '';
}

function wireVoiceSettings() {
  fillDeviceLists();
  navigator.mediaDevices?.addEventListener('devicechange', fillDeviceLists);
  for (const kind of Object.keys(DEVICE_NAMES)) {
    const select = $(`#vs-${kind}`);
    if (!select) continue;
    select.onchange = async () => {
      await pickDevice(kind, select.value, select.selectedOptions[0]?.dataset.label ?? '');
      if (kind === 'audioinput' && micTest) startMicTest();
      if (kind === 'audiooutput' && micTest?.audio?.setSinkId) micTest.audio.setSinkId((await deviceIdFor('audiooutput')) ?? '').catch(() => {});
      if (kind === 'videoinput' && cameraPreview) startCameraPreview();
    };
  }
  $('#vs-test').onclick = () => (micTest ? stopMicTest() : startMicTest());
  $('#vs-loopback').onchange = (e) => { if (micTest?.audio) micTest.audio.muted = !e.target.checked; };
  const slider = (sel, key, apply) => {
    $(sel).oninput = (e) => {
      voicePrefs[key] = Number(e.target.value) / 100;
      $(`${sel}-val`).textContent = `${e.target.value}%`;
      apply();
    };
    $(sel).onchange = saveVoicePrefs;
  };
  slider('#vs-in', 'inputVolume', () => { micTest?.chain?.setVolume(voicePrefs.inputVolume); applyInputVolume(); });
  slider('#vs-out', 'outputVolume', applyAllVolumes);
  $('#vs-noise').onchange = (e) => {
    voicePrefs.noise = e.target.value;
    saveVoicePrefs();
    $('#vs-noise-hint').textContent = NOISE_LEVELS[voicePrefs.noise].hint;
    if (state.voice && wantsMicProcessor()) state.voice.micCtx ??= newMicContext(); // during the click, so it isn't paused
    applyNoiseLevel();
    if (micTest) startMicTest();
  };
  $('#vs-chime').onclick = () => playSound('join', true);
  $('#vs-cam').onclick = () => (cameraPreview ? stopCameraPreview() : startCameraPreview());
  $('#voice-quality').onchange = (e) => { voicePrefs.quality = e.target.value; saveVoicePrefs(); };
  // Whatever closes the settings stops the test and the preview.
  const closing = onModalClose;
  onModalClose = () => {
    closing?.();
    stopMicTest();
    stopCameraPreview();
    navigator.mediaDevices?.removeEventListener('devicechange', fillDeviceLists);
  };
}

function openVoiceSettings() {
  modal(`${voiceSettings().replace('<h3>Voice and video</h3>', '<h2>Voice and video</h2>')}
    <div class="modal-row"><button class="btn secondary" data-close>Done</button></div>`, 'sheet');
  wireVoiceSettings();
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

// ---------------------------------------------------------------- rooms, threads and what you've read

const PIN_ICON = '<svg viewBox="0 0 24 24"><path d="M15 3l6 6-2 1-3 3 .5 5.5L15 20l-4-4-5.5 5.5-1-1L10 15l-4-4 1.5-1.5L13 10l3-3 1-2-2-2Z"/></svg>';
const MORE_ICON = '<svg viewBox="0 0 24 24"><path d="M6 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z"/></svg>';
const THREAD_ICON = '<svg viewBox="0 0 24 24" class="thread-icon" aria-hidden="true"><path d="M6 3v9a4 4 0 0 0 4 4h8.2l-3 3 1.4 1.4L22 15l-5.4-5.4-1.4 1.4 3 3H10a2 2 0 0 1-2-2V3H6Z"/></svg>';
const FORWARD_ICON = '<svg viewBox="0 0 24 24"><path d="M14 5v4C7 10 4 15 3 20c2.5-3.5 6-5.1 11-5.1V19l7-7-7-7Z"/></svg>';

/** A room or thread by id, with the burrow (or DM) it's in. */
function roomById(id) {
  if (id == null) return null;
  for (const s of state.servers.values()) {
    const c = s.channels.find((x) => x.id === id);
    if (c) return { s, c, thread: false };
    const t = s.threads?.find((x) => x.id === id);
    if (t) return { s, c: t, thread: true };
  }
  return null;
}
const isUnread = (c) => !!c && c.kind !== 'voice' && (c.unread ?? 0) > 0 && c.id !== state.channelId;
// Muted rooms, and ones set to @mentions or nothing, don't light up the burrow. Mentions still count unless it's nothing.
const serverUnread = (s) => !!s && [...s.channels, ...(s.threads ?? [])].some((c) => isUnread(c) && roomLoud(s, c));
const serverMentions = (s) =>
  [...s.channels, ...(s.threads ?? [])].reduce((n, c) => n + (c.id === state.channelId || notifyState(s, c).level === 'none' ? 0 : c.mentions ?? 0), 0);
function pingCount(n) {
  const b = document.createElement('span');
  b.className = 'ping-count';
  b.title = `${n} for you`;
  b.textContent = n > 99 ? '99+' : n;
  return b;
}
const mentionsMe = (m) => new RegExp('@' + escapeRegex(state.me.username) + '\\b', 'i').test(m.content) || m.replyTo?.authorId === state.me.id;

/** Message text without markup, for notifications and previews. */
function plainText(text) {
  return emojiToNames(text ?? '').replace(/\|\|(.+?)\|\|/g, '(spoiler)').replace(/[*_~`>#]/g, '').replace(/\s+/g, ' ').trim();
}

// Threads show under the room they hang off: the open one, unread ones, and ones active in the last few days.
function threadRows(s, c) {
  const recent = Date.now() - 3 * 864e5;
  return (s.threads ?? [])
    .filter((t) => t.parentId === c.id && (t.id === state.channelId || isUnread(t) || t.lastAt > recent))
    .slice(0, 6)
    .map((t) => {
      const li = document.createElement('li');
      li.className = 'thread-row' + (t.id === state.channelId ? ' active' : isUnread(t) ? ' unread' : '');
      li.insertAdjacentHTML('beforeend', THREAD_ICON);
      const name = document.createElement('span');
      name.className = 'room-name';
      name.textContent = t.name;
      li.append(name);
      if (t.id !== state.channelId && t.mentions) li.append(pingCount(t.mentions));
      li.title = `${t.name}: thread in #${c.name}`;
      li.onclick = () => { selectChannel(t.id); showView('chat'); };
      return li;
    });
}

// The header's title, subtitle and buttons for the open room.
function renderChatHeader() {
  const where = roomById(state.channelId);
  const s = where?.s ?? state.servers.get(state.serverId);
  const ch = where?.c;
  const title = !ch ? '' : isDm(s) ? dmTitle(s) : ch.name;
  $('#channel-name').textContent = title;
  renderChannelSub();
  const slow = !where?.thread && ch?.slow && !slowExempt(s) ? ` (slow mode: ${slowLabel(ch.slow)})` : '';
  input.placeholder = !ch ? '' : isDm(s) ? `Message ${title}` : where.thread ? `Reply in ${title}` : `Say something in ${title}${slow}`;
  $('#pins-btn').classList.toggle('hidden', !ch);
  // The gear is for a thread's settings, or a group conversation's.
  const manage = (where?.thread && (ch.createdBy === state.me.id || can(s, 'rooms'))) || (ch && s?.group);
  $('#thread-btn').classList.toggle('hidden', !manage);
  $('#thread-btn').innerHTML = GEAR_ICON;
  $('#thread-btn').title = s?.group ? 'Conversation settings' : 'Thread settings';
  renderNotifyButton();
  renderComposerLock();
  renderSlowNote();
}

// ---- reading: the room you're looking at is read up to its newest message

let readTimer = 0;
function markReadSoon() {
  clearTimeout(readTimer);
  readTimer = setTimeout(markReadNow, 300);
}
function markReadNow() {
  const id = state.channelId;
  const where = roomById(id);
  const newest = state.messages.at(-1);
  if (!where || !newest || !state.reachedEnd || document.hidden || state.holdUnread === id || state.stageOpen) return;
  if (isPhone() && $('#app').dataset.view !== 'chat') return;
  const c = where.c;
  if (newest.id <= (c.lastReadId ?? 0) && !c.unread) return;
  Object.assign(c, { lastReadId: Math.max(c.lastReadId ?? 0, newest.id), unread: 0, mentions: 0 });
  renderServers();
  renderChannels();
  api(`/api/channels/${id}/read`, { method: 'POST', body: { lastReadId: newest.id } }).catch(() => {});
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) markReadSoon(); });

// "Mark unread": this message and everything after it count as new again, until you leave the room.
async function markUnreadFrom(m) {
  state.holdUnread = state.channelId;
  state.newFrom = m.id - 1;
  const after = state.messages.filter((x) => x.id >= m.id && x.authorId !== state.me.id).length;
  state.unreadAtOpen = { count: Math.max(1, after), mentions: 0 };
  renderMessages();
  updateUnreadBar();
  try {
    const info = await api(`/api/channels/${m.channelId}/read`, { method: 'POST', body: { lastReadId: m.id - 1, unread: true } });
    const where = roomById(m.channelId);
    if (where) Object.assign(where.c, info);
    if (state.unreadAtOpen) state.unreadAtOpen.count = info.unread || state.unreadAtOpen.count;
    updateUnreadBar();
    renderServers();
    renderChannels();
  } catch (err) { alertError(err); }
}

// The bar at the top says how much is new since you were last here, while the "New" line is out of view.
function updateUnreadBar() {
  const bar = $('#unread-bar');
  const info = state.unreadAtOpen;
  if (!info) return bar.classList.add('hidden');
  const line = messagesEl.querySelector('.new-divider');
  const above = !line || line.getBoundingClientRect().bottom < messagesEl.getBoundingClientRect().top + 4;
  bar.classList.toggle('hidden', !above);
  const first = state.messages.find((m) => m.id > state.newFrom);
  const since = first && line ? ` since ${new Date(first.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '';
  $('#unread-jump').textContent = `${info.count}${info.count >= 99 ? '+' : ''} new message${info.count === 1 ? '' : 's'}${since}${info.mentions ? `, ${info.mentions} for you` : ''} · Jump`;
}
$('#unread-jump').onclick = () => {
  if (messagesEl.querySelector('.new-divider')) scrollToNewLine(true);
  else if (state.newFrom != null) selectChannel(state.channelId, { around: state.newFrom + 1 });
};
$('#unread-clear').onclick = () => {
  state.unreadAtOpen = null;
  state.newFrom = null;
  state.holdUnread = null;
  renderMessages();
  updateUnreadBar();
  if (state.reachedEnd) markReadNow();
  else {
    const where = roomById(state.channelId);
    api(`/api/channels/${state.channelId}/read`, { method: 'POST', body: { lastReadId: Number.MAX_SAFE_INTEGER } })
      .then((info) => { if (where) Object.assign(where.c, info); renderServers(); renderChannels(); })
      .catch(() => {});
  }
};

function scrollToNewLine(smooth = false) {
  const line = messagesEl.querySelector('.new-divider');
  if (!line) return;
  const top = messagesEl.scrollTop + line.getBoundingClientRect().top - messagesEl.getBoundingClientRect().top - 12;
  messagesEl.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
}

function flashMessage(id) {
  const target = messagesEl.querySelector(`.line[data-id="${id}"]`);
  if (!target) return;
  target.scrollIntoView({ block: 'center' });
  target.classList.remove('flash');
  void target.offsetWidth;
  target.classList.add('flash');
}

// ---- jumping to a message anywhere: search results, pins, saved messages, notifications

async function jumpTo(channelId, messageId) {
  closeModal();
  const where = roomById(channelId);
  if (!where) return alert("That message is in a room you can't see any more.");
  showView('chat');
  if (where.s.id !== state.serverId) {
    if (isDm(where.s)) store.set('lastDm', where.s.id);
    return selectServer(where.s.id, false, { channelId, around: messageId }).then(() => showView('chat'));
  }
  if (channelId === state.channelId && state.messages.some((m) => m.id === messageId)) return flashMessage(messageId);
  await selectChannel(channelId, { around: messageId });
}

// After jumping back in time, newer messages load as you scroll down, and the bar takes you back to the present.
function renderPresentBar() {
  $('#present-bar').classList.toggle('hidden', state.reachedEnd || !state.channelId);
}
function loadPresent() {
  if (state.channelId) selectChannel(state.channelId, { present: true });
}
$('#present-bar').onclick = loadPresent;

async function loadNewer() {
  if (state.reachedEnd || state.loadingNewer || !state.messages.length) return;
  state.loadingNewer = true;
  const channelId = state.channelId;
  try {
    const newer = await api(`/api/channels/${channelId}/messages?limit=50&after=${state.messages.at(-1).id}`);
    if (channelId !== state.channelId) return;
    state.messages.push(...newer);
    state.reachedEnd = newer.length < 50;
    renderMessages();
    renderPresentBar();
    if (state.reachedEnd) markReadSoon();
  } catch {} finally {
    state.loadingNewer = false;
  }
}

async function loadThreadParent(t) {
  try {
    const list = await api(`/api/channels/${t.parentId}/messages?limit=1&around=${t.parentMessageId}`);
    state.threadParent = list.find((m) => m.id === t.parentMessageId) ?? { deleted: true };
  } catch { state.threadParent = { deleted: true }; }
}

// ---- read receipts in direct messages: "Seen" under your last message they've read

function renderSeen() {
  messagesEl.querySelector('.seen-mark')?.remove();
  const where = roomById(state.channelId);
  const seen = where && isDm(where.s) ? where.s.seen : null;
  if (!seen || !state.reachedEnd) return;
  const last = state.messages.findLast((m) => m.authorId === state.me.id);
  if (!last || last.id > seen.lastReadId) return;
  const line = messagesEl.querySelector(`.line[data-id="${last.id}"]`);
  if (!line) return;
  const mark = document.createElement('div');
  mark.className = 'seen-mark';
  mark.textContent = `Seen by ${partner(where.s).username}`;
  line.after(mark);
}

// ---- drafts: what you'd typed stays with each room until you send it

const draftKey = (id) => `draft:${id}`;
let draftTimer = 0;
function saveDraft() {
  clearTimeout(draftTimer);
  if (state.channelId) store.set(draftKey(state.channelId), input.value.trim() ? input.value : null);
}
function saveDraftSoon() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 400);
}
function loadDraft() {
  input.value = (state.channelId && store.get(draftKey(state.channelId))) || '';
  autosize();
}
function clearDraft(id) {
  clearTimeout(draftTimer);
  store.set(draftKey(id), null);
}
window.addEventListener('beforeunload', saveDraft);

// ---- sending

/** Sends a message over the live connection, or the slower way if it's down. */
async function sendMessage(channelId, body) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type: 'send', channelId, ...body }));
  else await api(`/api/channels/${channelId}/messages`, { method: 'POST', body });
}

// ---- small pop-up menus and notes

function openMenu(anchor, items) {
  closeMenu();
  const menu = document.createElement('div');
  menu.id = 'pop-menu';
  menu.className = 'pop-menu';
  menu.setAttribute('role', 'menu');
  for (const item of items.filter(Boolean)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.textContent = item.label;
    if (item.danger) b.classList.add('danger-item');
    b.onclick = () => { closeMenu(); item.run(); };
    menu.append(b);
  }
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) + 'px';
  menu.style.top = (r.bottom + 6 + h < window.innerHeight - 8 ? r.bottom + 6 : Math.max(8, r.top - h - 6)) + 'px';
  menu.querySelector('button')?.focus({ preventScroll: true });
  setTimeout(() => document.addEventListener('mousedown', outsideMenu), 0);
}
function outsideMenu(e) { if (!e.target.closest('#pop-menu')) closeMenu(); }
function closeMenu() {
  $('#pop-menu')?.remove();
  document.removeEventListener('mousedown', outsideMenu);
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
messagesEl.addEventListener('scroll', closeMenu);

function toast(text, { action, onAction, timeout = 5000 } = {}) {
  const t = document.createElement('div');
  t.className = 'toast';
  const span = document.createElement('span');
  span.textContent = text;
  t.append(span);
  if (action) {
    const b = document.createElement('button');
    b.className = 'btn secondary';
    b.textContent = action;
    b.onclick = () => { t.remove(); onAction(); };
    t.append(b);
  }
  const x = document.createElement('button');
  x.className = 'icon-btn';
  x.title = 'Dismiss';
  x.textContent = '×';
  x.onclick = () => t.remove();
  t.append(x);
  $('#toasts').append(t);
  if (timeout) setTimeout(() => t.remove(), timeout);
}

/** Where a message is, in words: "Burrow › #room" or "Direct message with Sam". */
function placeLabel(place) {
  if (!place) return '';
  if (place.kind === 'dm') return `Direct message with ${place.serverName}`;
  return `${place.serverName} › #${place.channelName}${place.threadName ? ` › ${place.threadName}` : ''}`;
}

// A compact copy of a message, for lists like pins, search results and saved messages.
function messageCard(m, place, { onOpen, buttons = [], note = '' } = {}) {
  const card = document.createElement('div');
  card.className = 'msg-card';
  const head = document.createElement('div');
  head.className = 'msg-card-head';
  const av = document.createElement('span');
  av.className = 'avatar xs';
  setAvatar(av, m.author, avatarOf(m.authorId, m.authorAvatar));
  const who = document.createElement('b');
  who.textContent = m.author;
  const when = document.createElement('span');
  when.className = 'muted small';
  when.textContent = formatTime(new Date(m.createdAt)) + (place ? ` · ${placeLabel(place)}` : '');
  head.append(av, who, when);
  card.append(head);
  if (note) card.insertAdjacentHTML('beforeend', `<div class="small msg-card-note">${escapeHtml(note)}</div>`);
  if (m.content) {
    const body = document.createElement('div');
    body.className = 'content';
    body.innerHTML = formatContent(m.content.length > 600 ? m.content.slice(0, 600) + '…' : m.content);
    card.append(body);
  }
  const extras = [
    m.attachments?.length && `${m.attachments.length} file${m.attachments.length === 1 ? '' : 's'}`,
    m.poll && `Poll: ${m.poll.question}`,
    m.sticker && !m.sticker.deleted && `Sticker: ${m.sticker.name}`,
  ].filter(Boolean);
  if (extras.length) card.insertAdjacentHTML('beforeend', `<div class="muted small">${escapeHtml(extras.join(' · '))}</div>`);
  if (buttons.length || onOpen) {
    const row = document.createElement('div');
    row.className = 'msg-card-actions';
    if (onOpen) {
      const jump = document.createElement('button');
      jump.className = 'btn secondary';
      jump.textContent = 'Jump';
      jump.onclick = (e) => { e.stopPropagation(); onOpen(); };
      row.append(jump);
      card.classList.add('openable');
      card.onclick = (e) => { if (!e.target.closest('button, a, .spoiler')) onOpen(); };
    }
    for (const [label, run, cls = 'secondary'] of buttons) {
      const b = document.createElement('button');
      b.className = `btn ${cls}`;
      b.textContent = label;
      b.onclick = (e) => { e.stopPropagation(); run(b); };
      row.append(b);
    }
    card.append(row);
  }
  return card;
}

// ---- the ⋯ menu on a message

function openMessageMenu(anchor, m) {
  const where = roomById(m.channelId);
  const s = where?.s;
  const mine = m.authorId === state.me.id;
  const saved = state.saved.get(m.id);
  openMenu(anchor, [
    { label: m.pinnedAt ? 'Unpin' : 'Pin to this room', run: () => api(`/api/messages/${m.id}/pin`, { method: 'POST', body: { pinned: !m.pinnedAt } }).catch(alertError) },
    where && !where.thread && !isDm(s) && { label: m.thread ? 'Open thread' : 'Start a thread', run: () => startThread(m) },
    { label: 'Forward', run: () => openForward(m) },
    { label: saved ? 'Remove from saved' : 'Save for later', run: () => toggleSaved(m) },
    { label: saved?.remindAt && !saved.reminded ? 'Change reminder' : 'Remind me about this', run: () => openRemind(m) },
    { label: 'Mark unread from here', run: () => markUnreadFrom(m) },
    m.content && navigator.clipboard && { label: 'Copy text', run: () => navigator.clipboard.writeText(emojiToNames(m.content)) },
    m.editedAt && { label: 'Edit history', run: () => openEditHistory(m) },
    mine && m.embeds?.length && { label: 'Remove link previews', run: () => api(`/api/messages/${m.id}/embeds`, { method: 'POST' }).catch(alertError) },
    mine && m.poll && !m.poll.closed && { label: 'End poll now', run: () => api(`/api/messages/${m.id}/poll/end`, { method: 'POST' }).catch(alertError) },
    (mine || can(s, 'messages')) && { label: 'Delete', danger: true, run: () => confirmDelete(m) },
  ]);
}

// ---- pinned messages

$('#pins-btn').onclick = async () => {
  const channelId = state.channelId;
  if (!channelId) return;
  modal(`<h2>Pinned messages</h2><div id="pin-list" class="card-list"><p class="muted">Loading…</p></div>
    <div class="modal-row"><button class="btn secondary" data-close>Close</button></div>`);
  try {
    const pins = await api(`/api/channels/${channelId}/pins`);
    const list = $('#pin-list');
    if (!list) return;
    if (!pins.length) return (list.innerHTML = '<p class="muted">Nothing pinned yet. Pin a message from its ⋯ menu so everyone can find it again.</p>');
    list.replaceChildren(...pins.map((m) => messageCard(m, null, {
      onOpen: () => jumpTo(channelId, m.id),
      buttons: [['Unpin', (b) => { b.disabled = true; api(`/api/messages/${m.id}/pin`, { method: 'POST', body: { pinned: false } }).then(() => b.closest('.msg-card').remove()).catch(alertError); }]],
    })));
  } catch (err) { $('#pin-list') && ($('#pin-list').textContent = err.message); }
};

// ---- edit history

async function openEditHistory(m) {
  modal(`<h2>Edit history</h2><div id="edit-list" class="card-list"><p class="muted">Loading…</p></div>
    <div class="modal-row"><button class="btn secondary" data-close>Close</button></div>`);
  try {
    const edits = await api(`/api/messages/${m.id}/edits`);
    const list = $('#edit-list');
    if (!list) return;
    const versions = [...edits.map((e) => ({ ...e, label: 'Earlier' })), { content: m.content, writtenAt: m.editedAt, label: 'Now' }];
    if (edits.length) versions[0].writtenAt = m.createdAt;
    list.replaceChildren(...versions.reverse().map((v) => {
      const el = document.createElement('div');
      el.className = 'msg-card';
      el.innerHTML = `<div class="msg-card-head"><b>${v.label}</b><span class="muted small">${escapeHtml(v.writtenAt ? new Date(v.writtenAt).toLocaleString() : '')}</span></div>
        <div class="content">${formatContent(v.content) || '<span class="muted">(empty)</span>'}</div>`;
      return el;
    }));
    if (!edits.length) list.insertAdjacentHTML('beforeend', '<p class="muted small">Earlier versions are kept from now on.</p>');
  } catch (err) { $('#edit-list') && ($('#edit-list').textContent = err.message); }
}

// ---- forwarding

function forwardTargets() {
  const out = [];
  for (const id of state.serverOrder) {
    const s = state.servers.get(id);
    for (const c of s.channels) if (c.kind !== 'voice') out.push({ id: c.id, label: `${s.name} › #${c.name}` });
  }
  for (const id of state.dmOrder) {
    const s = state.servers.get(id);
    const c = s.channels[0];
    if (c) out.push({ id: c.id, label: s.group ? dmTitle(s) : `Direct message with ${partner(s).username}` });
  }
  return out;
}
function openForward(m) {
  const targets = forwardTargets();
  modal(`<h2>Forward message</h2>
    <p class="muted small">A copy goes to the room you pick, saying who wrote it and where.</p>
    <input id="fwd-filter" placeholder="Find a room or person" />
    <ul class="people-picker" id="fwd-list"></ul>
    <div class="error" id="modal-error"></div>
    <div class="modal-row"><button class="btn secondary" data-close>Cancel</button></div>`);
  const render = (q = '') => {
    $('#fwd-list').replaceChildren(...targets.filter((t) => t.label.toLowerCase().includes(q.toLowerCase())).slice(0, 60).map((t) => {
      const li = document.createElement('li');
      li.textContent = t.label;
      li.onclick = async () => {
        try {
          await api(`/api/messages/${m.id}/forward`, { method: 'POST', body: { channelId: t.id } });
          closeModal();
          toast(`Forwarded to ${t.label}`, { action: 'Go there', onAction: () => { const w = roomById(t.id); if (w) selectServer(w.s.id, false, { channelId: t.id }).then(() => showView('chat')); } });
        } catch (err) { $('#modal-error').textContent = err.message; }
      };
      return li;
    }));
  };
  render();
  $('#fwd-filter').oninput = (e) => render(e.target.value);
}
function renderForwarded(f) {
  const el = document.createElement('div');
  el.className = 'forwarded';
  el.innerHTML = `${FORWARD_ICON}<span>Forwarded · <b></b> wrote this ${f.from ? 'in ' : ''}<span class="fwd-from"></span></span>`;
  el.querySelector('b').textContent = f.author;
  el.querySelector('.fwd-from').textContent = f.from ?? '';
  el.title = `Originally sent ${new Date(f.createdAt).toLocaleString()}`;
  return el;
}

// ---- saved messages and reminders

async function loadSavedAndScheduled() {
  try {
    const [saved, scheduled] = await Promise.all([api('/api/me/saved'), api('/api/me/scheduled')]);
    state.saved = new Map(saved.map((x) => [x.messageId, x]));
    state.scheduled = scheduled;
    renderScheduledNote();
  } catch {}
}

function toggleSaved(m) {
  const saved = state.saved.has(m.id);
  api(`/api/messages/${m.id}/save`, { method: 'POST', body: saved ? { saved: false } : {} })
    .then(() => toast(saved ? 'Removed from saved messages' : 'Saved. Find it under your menu, in Saved messages.'))
    .catch(alertError);
}

/** Times people usually want: soon, later today, tomorrow morning, next week. */
function quickTimes() {
  const at = (days, hour) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0); return d.getTime(); };
  const times = [['In 20 minutes', Date.now() + 20 * 60e3], ['In 1 hour', Date.now() + 3600e3], ['In 3 hours', Date.now() + 3 * 3600e3]];
  if (new Date().getHours() < 18) times.push(['This evening', at(0, 19)]);
  times.push(['Tomorrow morning', at(1, 9)]);
  const toMonday = ((8 - new Date().getDay()) % 7) || 7;
  times.push(['Next week', at(toMonday, 9)]);
  return times;
}
const localInputValue = (t) => { const d = new Date(t - new Date(t).getTimezoneOffset() * 60e3); return d.toISOString().slice(0, 16); };

/** A modal with quick times and a date and time box. `pick(time)` does the work and may throw. */
function timeModal(title, intro, pick, extra = '') {
  modal(`<h2>${escapeHtml(title)}</h2>
    ${intro ? `<p class="muted small">${escapeHtml(intro)}</p>` : ''}
    ${extra}
    <div class="quick-times">${quickTimes().map(([label, t]) => `<button type="button" class="btn secondary" data-t="${t}" title="${escapeHtml(new Date(t).toLocaleString())}">${label}</button>`).join('')}</div>
    <form id="time-form"><label>Or pick a time<input type="datetime-local" id="time-pick" required value="${localInputValue(Date.now() + 3600e3)}" min="${localInputValue(Date.now())}" /></label>
      <div class="error" id="modal-error"></div>
      <div class="modal-row"><button type="button" class="btn secondary" data-close>Cancel</button><button type="submit" class="btn">Set</button></div>
    </form>`);
  const go = async (t) => {
    try { await pick(t); closeModal(); } catch (err) { $('#modal-error').textContent = err.message; }
  };
  $('#modal-card').querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => go(Number(b.dataset.t))));
  $('#time-form').onsubmit = (e) => { e.preventDefault(); go(new Date($('#time-pick').value).getTime()); };
}

function openRemind(m) {
  timeModal('Remind me', "It's saved, and Burrow brings it back at the time you pick.", async (remindAt) => {
    await api(`/api/messages/${m.id}/save`, { method: 'POST', body: { remindAt } });
    toast(`I'll remind you ${formatTime(new Date(remindAt)).replace(/^(Today|Yesterday)/, (w) => w.toLowerCase())}.`);
  });
}

function showReminder(ev) {
  const m = ev.message;
  const text = `Reminder: ${m.author}${ev.place ? ` in ${placeLabel(ev.place)}` : ''}: ${plainText(m.content).slice(0, 120) || 'a message'}`;
  toast(text, { action: 'Jump', onAction: () => jumpTo(m.channelId, m.id), timeout: 0 });
  playSound('message');
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
    const n = new Notification('Reminder', { body: text });
    n.onclick = () => { window.focus(); jumpTo(m.channelId, m.id); };
  }
}

async function openSaved() {
  modal(`<h2>Saved messages</h2><p class="muted small">Only you see these. Save a message from its ⋯ menu.</p>
    <div id="saved-list" class="card-list"><p class="muted">Loading…</p></div>
    <div class="modal-row"><button class="btn secondary" data-close>Close</button></div>`);
  try {
    const items = await api('/api/me/saved');
    const list = $('#saved-list');
    if (!list) return;
    if (!items.length) return (list.innerHTML = '<p class="muted">Nothing saved yet.</p>');
    list.replaceChildren(...items.map((it) => messageCard(it.message, it.place, {
      note: it.remindAt ? (it.reminded ? `Reminded ${new Date(it.remindAt).toLocaleString()}` : `Reminder ${new Date(it.remindAt).toLocaleString()}`) : '',
      onOpen: () => jumpTo(it.message.channelId, it.message.id),
      buttons: [
        ['Remind me', () => openRemind(it.message)],
        ['Remove', (b) => { b.disabled = true; api(`/api/messages/${it.messageId}/save`, { method: 'POST', body: { saved: false } }).then(() => b.closest('.msg-card').remove()).catch(alertError); }],
      ],
    })));
  } catch (err) { $('#saved-list') && ($('#saved-list').textContent = err.message); }
}

// ---- scheduled messages: written now, sent later (text only)

function openSchedule() {
  const channelId = state.channelId;
  const content = namesToEmoji(input.value.trim());
  if (!channelId) return;
  if (!content) return toast('Type the message first, then pick Send later.');
  if (state.pending.length) return toast("Scheduled messages are text only. Send the files now, or remove them first.");
  const replyTo = state.replyTo;
  timeModal('Send later', '', async (sendAt) => {
    await api(`/api/channels/${channelId}/scheduled`, { method: 'POST', body: { content, sendAt, replyTo: replyTo?.id } });
    if (state.channelId === channelId) { input.value = ''; autosize(); setReply(null); }
    clearDraft(channelId);
    toast(`Scheduled for ${new Date(sendAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' })}.`);
  }, `<div class="msg-card"><div class="content">${formatContent(content.length > 300 ? content.slice(0, 300) + '…' : content)}</div></div>`);
}

function renderScheduledNote() {
  const here = state.scheduled.filter((s) => s.channelId === state.channelId);
  const note = $('#scheduled-note');
  note.classList.toggle('hidden', !here.length);
  if (here.length) note.textContent = here.length === 1
    ? `1 message scheduled here for ${new Date(here[0].sendAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })} · See it`
    : `${here.length} messages scheduled here · See them`;
}
$('#scheduled-note').onclick = () => openScheduledList();

function openScheduledList() {
  const render = () => {
    const list = $('#sched-list');
    if (!list) return;
    if (!state.scheduled.length) return (list.innerHTML = '<p class="muted">Nothing waiting to send. Type a message and pick Send later from the + menu.</p>');
    list.replaceChildren(...state.scheduled.map((item) => {
      const el = document.createElement('div');
      el.className = 'msg-card';
      el.innerHTML = `<div class="msg-card-head"><b>${escapeHtml(new Date(item.sendAt).toLocaleString())}</b><span class="muted small">${escapeHtml(placeLabel(item.place))}</span></div>
        <div class="content">${formatContent(item.content)}</div><div class="msg-card-actions"><button class="btn secondary">Don't send</button></div>`;
      el.querySelector('button').onclick = async () => {
        try { state.scheduled = await api(`/api/scheduled/${item.id}`, { method: 'DELETE' }); renderScheduledNote(); render(); }
        catch (err) { alertError(err); }
      };
      return el;
    }));
  };
  modal(`<h2>Scheduled messages</h2><div id="sched-list" class="card-list"></div>
    <div class="modal-row"><button class="btn secondary" data-close>Close</button></div>`);
  render();
}

// ---------------------------------------------------------------- formatting
//
// Markdown-ish: **bold**, *italic*, __underline__, ~~strikethrough~~, ||spoilers||, `code`, ```code blocks```
// (coloured when they name a language), # headings, > quotes, - and 1. lists, links, @mentions and :custom: emoji.

const LONG_PASTE = 2000; // pasting more than this many characters attaches it as a file
const VIDEO_TYPES = /^video\/(mp4|webm|quicktime)$/;
const TEXT_TYPES = /^(text\/(plain|markdown|csv|x-log)|application\/(json|x-ndjson))(;|$)/;
const LINK_RE = /\bhttps?:\/\/(?:(?!&(?:lt|gt|quot|#39);)[^\s<])*[^\s<.,;:!?)'"&]/g;

const CODE_KEYWORDS = new Set(`abstract and as async await break case catch char class const continue def default defer del delete do elif else enum
  export extends false final finally fn for from func function global go if impl import in instanceof interface is lambda let loop match
  mod mut new nil none None not null of or package pass private protected pub public raise return self Self static struct super switch
  this throw throws true True False try type typeof undefined use var void where while with yield int long float double bool boolean
  string str echo then fi done esac local SELECT FROM WHERE INSERT INTO UPDATE DELETE CREATE TABLE JOIN ON AND OR NOT NULL ORDER BY GROUP
  LIMIT VALUES SET AS select from where insert into update delete create table join on order by group limit values`.split(/\s+/));
const HASH_COMMENTS = /^(py|python|sh|bash|zsh|shell|console|rb|ruby|ya?ml|toml|r|pl|perl|ps1|powershell|ini|conf|dockerfile|make(file)?|nix|ex|elixir|gd|gdscript)$/i;

/** Colours code that's already HTML-escaped: strings, comments, numbers and keywords. */
function highlight(code, lang) {
  if (!lang) return code;
  const comment = HASH_COMMENTS.test(lang) ? '#.*' : /^(sql|lua|hs|haskell)$/i.test(lang) ? '--.*' : String.raw`\/\/.*|\/\*[\s\S]*?\*\/`;
  const re = new RegExp([
    String.raw`(&quot;(?:\\.|(?!&quot;)[^\\\n])*&quot;|&#39;(?:\\.|(?!&#39;)[^\\\n])*&#39;)`,
    String.raw`(&(?:#\d+|\w+);)`,
    `(${comment})`,
    String.raw`(\b(?:0x[\da-fA-F]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b)`,
    String.raw`([A-Za-z_$][\w$]*)`,
  ].join('|'), 'g');
  return code.replace(re, (t, str, entity, com, num) =>
    str ? `<span class="tok-s">${t}</span>`
      : entity ? t
      : com ? `<span class="tok-c">${t}</span>`
      : num ? `<span class="tok-n">${t}</span>`
      : CODE_KEYWORDS.has(t) ? `<span class="tok-k">${t}</span>` : t);
}

function formatContent(text) {
  if (!text) return '';
  const keep = [];
  const stash = (html) => `\u0000${keep.push(html) - 1}\u0001`;
  const link = (u) => stash(`<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
  const inline = (t) => t
    .replace(/&lt;:(\w{2,32}):(\d+)&gt;/g, (_, name, id) => stash(customEmojiImg(name, Number(id))))
    .replace(/&lt;(https?:\/\/[^\s<]+?)&gt;/g, (_, u) => link(u))
    .replace(LINK_RE, link)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/__(.+?)__/g, '<u>$1</u>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/~~(.+?)~~/g, '<s>$1</s>')
    .replace(/\|\|(.+?)\|\|/g, '<span class="spoiler" tabindex="0" title="Spoiler: click to show">$1</span>')
    .replace(/(^|\s)@([\w.-]+)/g, '$1<span class="mention">@$2</span>');
  const escaped = escapeHtml(text)
    .replace(/```(?:([\w+#.-]{1,20})\n|\n)?([\s\S]*?)```/g, (_, lang, code) => stash(`<pre><code>${highlight(code.replace(/\n$/, ''), lang)}</code></pre>`))
    .replace(/`([^`\n]+)`/g, (_, code) => stash(`<code>${code}</code>`));
  const lines = escaped.split('\n');
  const out = []; // [html, isBlock]
  const listItems = (re) => {
    const items = [];
    while (lines.length && re.test(lines[0])) items.push(`<li>${inline(lines.shift().replace(re, ''))}</li>`);
    return items.join('');
  };
  while (lines.length) {
    const line = lines[0];
    let m;
    if ((m = /^(#{1,3}) (.+)$/.exec(line))) { lines.shift(); out.push([`<div class="md-h md-h${m[1].length}">${inline(m[2])}</div>`, true]); }
    else if (/^&gt; ?/.test(line)) {
      const quote = [];
      while (lines.length && /^&gt; ?/.test(lines[0])) quote.push(inline(lines.shift().replace(/^&gt; ?/, '')));
      out.push([`<blockquote>${quote.join('\n')}</blockquote>`, true]);
    } else if (/^ {0,3}[-*•] \S/.test(line)) out.push([`<ul>${listItems(/^ {0,3}[-*•] /)}</ul>`, true]);
    else if ((m = /^ {0,3}(\d{1,3})[.)] \S/.exec(line))) out.push([`<ol start="${Number(m[1])}">${listItems(/^ {0,3}\d{1,3}[.)] /)}</ol>`, true]);
    else { lines.shift(); out.push([inline(line), /^\u0000\d+\u0001$/.test(line) && keep[line.slice(1, -1)].startsWith('<pre')]); }
  }
  let html = '';
  out.forEach(([h, block], i) => { if (i && !block && !out[i - 1][1]) html += '\n'; html += h; });
  return html.replace(/\u0000(\d+)\u0001/g, (_, i) => keep[i]);
}

/** A message that's only a few emoji shows them big. */
function isJumbo(text) {
  if (!text || text.length > 200) return false;
  const rest = text
    .replace(/<:\w{2,32}:\d+>/g, 'E')
    .replace(/\p{Extended_Pictographic}(?:\u{FE0F}|\u{20E3}|[\u{1F3FB}-\u{1F3FF}]|\u{200D}\p{Extended_Pictographic})*/gu, 'E')
    .replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu, 'E')
    .replace(/\s+/g, '');
  return /^E{1,10}$/.test(rest);
}

// Spoilers stay hidden until clicked (links inside them don't open on that first click).
document.addEventListener('click', (e) => {
  const sp = e.target.closest?.('.spoiler');
  if (sp && !sp.classList.contains('shown')) { e.preventDefault(); e.stopPropagation(); sp.classList.add('shown'); }
}, true);
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList?.contains('spoiler')) { e.preventDefault(); e.target.classList.add('shown'); }
});

function spoilerWrap(el) {
  const w = document.createElement('div');
  w.className = 'att-spoiler';
  const cover = document.createElement('button');
  cover.type = 'button';
  cover.className = 'spoiler-cover';
  cover.textContent = 'Spoiler';
  cover.onclick = (e) => { e.stopPropagation(); w.classList.add('shown'); cover.remove(); };
  w.append(el, cover);
  return w;
}

// ---------------------------------------------------------------- emoji: the full picker, and each burrow's own

function customEmojiById(id) {
  for (const s of state.servers.values()) {
    const e = s.emoji?.find((x) => x.id === id && x.kind === 'emoji');
    if (e) return e;
  }
  return null;
}
function findEmojiByName(name) {
  const here = state.servers.get(state.serverId)?.emoji?.find((e) => e.kind === 'emoji' && e.name === name);
  if (here) return here;
  for (const id of state.serverOrder) {
    const e = state.servers.get(id)?.emoji?.find((x) => x.kind === 'emoji' && x.name === name);
    if (e) return e;
  }
  return null;
}
function customEmojiImg(name, id) {
  const e = customEmojiById(id);
  return e ? `<img class="cemoji" src="${escapeHtml(state.serverUrl + e.url)}" alt=":${name}:" title=":${name}:" draggable="false" />` : `:${name}:`;
}
/** A reaction or recent emoji: a plain emoji, or a custom one written <:name:id>. */
function emojiHtml(text) {
  const m = /^<:(\w{2,32}):(\d+)>$/.exec(text);
  return m ? customEmojiImg(m[1], Number(m[2])) : escapeHtml(text);
}
// In the message box, custom emoji are written :name:, and turned into <:name:id> when sent.
const emojiToNames = (text) => text.replace(/<:(\w{2,32}):\d+>/g, ':$1:');
const namesToEmoji = (text) => text.replace(/(?<![\w<]):(\w{2,32}):(?!\w)/g, (all, name) => {
  const e = findEmojiByName(name);
  return e ? `<:${name}:${e.id}>` : all;
});

let emojiData = null;
function loadEmojiData() {
  emojiData ??= new Promise((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = 'vendor/emoji.js';
    tag.onload = () => resolve(window.BURROW_EMOJI.map(([group, list]) => [group, list.split('|').map((x) => {
      const i = x.indexOf(' ');
      return [x.slice(0, i), x.slice(i + 1)];
    })]));
    tag.onerror = () => { emojiData = null; reject(new Error("Couldn't load the emoji.")); };
    document.head.append(tag);
  });
  return emojiData;
}
const recentEmoji = () => { try { return JSON.parse(store.get('recentEmoji')) ?? []; } catch { return []; } };
function rememberEmoji(text) {
  store.set('recentEmoji', JSON.stringify([text, ...recentEmoji().filter((x) => x !== text)].slice(0, 24)));
}

// The full emoji picker, for the message box and for reactions. onPick gets the emoji, or <:name:id> for a custom one.
async function openEmojiPanel(anchor, onPick) {
  closeEmojiPanel();
  const panel = document.createElement('div');
  panel.id = 'emoji-panel';
  panel.className = 'emoji-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Emoji');
  panel.innerHTML = '<input type="search" placeholder="Find an emoji" autocomplete="off" /><div class="emoji-tabs"></div><div class="emoji-scroll"><p class="muted small">Loading…</p></div>';
  panel.anchor = anchor;
  document.body.append(panel);
  const r = anchor.getBoundingClientRect();
  if (isPhone()) { panel.style.left = '8px'; panel.style.right = '8px'; panel.style.width = 'auto'; }
  else panel.style.left = Math.max(8, Math.min(window.innerWidth - panel.offsetWidth - 8, r.right - panel.offsetWidth)) + 'px';
  const h = panel.offsetHeight;
  panel.style.top = (r.top - h - 8 > 8 ? r.top - h - 8 : Math.min(window.innerHeight - h - 8, r.bottom + 8)) + 'px';
  anchor.setAttribute?.('aria-expanded', 'true');
  setTimeout(() => document.addEventListener('mousedown', outsideEmojiPanel), 0);
  const search = panel.querySelector('input');
  const scroll = panel.querySelector('.emoji-scroll');
  if (!isPhone()) search.focus();
  let data;
  try { data = await loadEmojiData(); } catch (err) { scroll.textContent = err.message; return; }
  if (!panel.isConnected) return;

  const customGroups = [state.serverId, ...state.serverOrder.filter((id) => id !== state.serverId)]
    .map((id) => state.servers.get(id))
    .filter((s) => s && !isDm(s) && s.emoji?.some((e) => e.kind === 'emoji'))
    .map((s) => [s.name, s.emoji.filter((e) => e.kind === 'emoji').map((e) => [`<:${e.name}:${e.id}>`, e.name, e])]);
  const recent = recentEmoji().filter((t) => !t.startsWith('<:') || customEmojiById(Number(/:(\d+)>$/.exec(t)?.[1]))).map((t) => [t, '']);
  const button = ([text, name, custom]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = name ? `:${name.replace(/ /g, '_')}:` : '';
    if (custom || text.startsWith('<:')) b.innerHTML = emojiHtml(text);
    else b.textContent = text;
    b.onclick = (e) => {
      rememberEmoji(text);
      onPick(text);
      if (!e.shiftKey) closeEmojiPanel();
    };
    return b;
  };
  const sections = [
    ...(recent.length ? [['Recent', recent]] : []),
    ...customGroups,
    ...data,
  ];
  const render = (q) => {
    if (q) {
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      const hits = sections.slice(recent.length ? 1 : 0).flatMap(([, list]) => list).filter(([, name]) => words.every((w) => name.toLowerCase().includes(w))).slice(0, 240);
      const grid = document.createElement('div');
      grid.className = 'emoji-grid';
      grid.append(...hits.map(button));
      scroll.replaceChildren(hits.length ? grid : Object.assign(document.createElement('p'), { className: 'muted small', textContent: 'No emoji found' }));
      return;
    }
    scroll.replaceChildren(...sections.flatMap(([title, list], i) => {
      const h = document.createElement('h4');
      h.textContent = title;
      h.id = `emoji-sec-${i}`;
      const grid = document.createElement('div');
      grid.className = 'emoji-grid';
      grid.append(...list.map(button));
      return [h, grid];
    }));
  };
  const tabs = panel.querySelector('.emoji-tabs');
  tabs.replaceChildren(...sections.map(([title, list], i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = title;
    const first = list[0];
    if (title === 'Recent') b.textContent = '🕘';
    else if (first?.[2]) b.innerHTML = emojiHtml(first[0]);
    else b.textContent = first?.[0] ?? '?';
    b.onclick = () => { search.value = ''; render(''); panel.querySelector(`#emoji-sec-${i}`)?.scrollIntoView(); };
    return b;
  }));
  render('');
  search.oninput = () => render(search.value.trim());
  search.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); scroll.querySelector('button')?.click(); } };
}
function outsideEmojiPanel(e) {
  const panel = $('#emoji-panel');
  if (panel && !e.target.closest('#emoji-panel') && !panel.anchor?.contains(e.target)) closeEmojiPanel();
}
function closeEmojiPanel() {
  const panel = $('#emoji-panel');
  panel?.anchor?.setAttribute?.('aria-expanded', 'false');
  panel?.remove();
  document.removeEventListener('mousedown', outsideEmojiPanel);
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeEmojiPanel(); });

function insertAtCursor(text) {
  const a = input.selectionStart ?? input.value.length;
  const b = input.selectionEnd ?? a;
  const before = input.value.slice(0, a);
  const pad = text.startsWith(':') && before && !/\s$/.test(before) ? ' ' : '';
  input.setRangeText(pad + text, a, b, 'end');
  autosize();
  saveDraftSoon();
  if (!isPhone()) input.focus();
}
$('#emoji-btn').onclick = () => {
  if ($('#emoji-panel')?.anchor === $('#emoji-btn')) return closeEmojiPanel();
  closeGifPicker();
  openEmojiPanel($('#emoji-btn'), (text) => insertAtCursor(text.startsWith('<:') ? emojiToNames(text) + ' ' : text));
};

// ---- managing a burrow's emoji and stickers

/** Scales a picture down to fit max px on its long side. Small GIFs stay as they are, to keep moving. */
async function fitPicture(file, max) {
  if (file.type === 'image/gif' && file.size <= MAX_AVATAR_BYTES) return file;
  let img;
  try { img = await createImageBitmap(file); } catch { throw new Error("That file doesn't look like a picture"); }
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  const encode = (type) => new Promise((resolve) => canvas.toBlob(resolve, type, 0.92));
  const webp = await encode('image/webp');
  return webp?.type === 'image/webp' ? webp : encode('image/png');
}

function openEmojiManager(serverId) {
  const s = state.servers.get(serverId);
  if (!s) return closeModal();
  const list = (kind) => (s.emoji ?? []).filter((e) => e.kind === kind);
  const rows = (kind) => list(kind).map((e) => `<li data-id="${e.id}"><img src="${escapeHtml(state.serverUrl + e.url)}" alt="" class="${kind === 'sticker' ? 'em-sticker' : 'cemoji'}" />
      <span class="em-name">:${escapeHtml(e.name)}:</span><span class="spacer"></span>
      <button type="button" class="btn secondary" data-rename="${e.id}">Rename</button><button type="button" class="btn danger" data-delete="${e.id}">Delete</button></li>`).join('');
  modal(`<h2>Emoji and stickers</h2>
    <p class="small muted">Everyone in ${escapeHtml(s.name)} can use these. Emoji go in messages and reactions as :name:; stickers are sent on their own, big.</p>
    <form id="emoji-form">
      <div class="emoji-add">
        <label>Name<input id="emoji-name" placeholder="e.g. partyfox" maxlength="32" required /></label>
        <label>Kind<select id="emoji-kind"><option value="emoji">Emoji</option><option value="sticker">Sticker</option></select></label>
      </div>
      <input type="file" id="emoji-file" accept="image/png,image/jpeg,image/gif,image/webp" hidden />
      <button type="submit" class="btn" id="emoji-add-btn">Choose a picture and add it</button>
      <span class="small muted">PNG, JPEG, GIF or WebP. Emoji are shrunk to 128 px and stickers to 320 px; small GIFs keep moving.</span>
    </form>
    <div class="error" id="modal-error"></div>
    <h3>Emoji · ${list('emoji').length} of 50</h3>
    ${list('emoji').length ? `<ul class="emoji-manage">${rows('emoji')}</ul>` : '<p class="muted small">None yet.</p>'}
    <h3>Stickers · ${list('sticker').length} of 20</h3>
    ${list('sticker').length ? `<ul class="emoji-manage">${rows('sticker')}</ul>` : '<p class="muted small">None yet.</p>'}
    <div class="modal-row"><button class="btn secondary" data-close>Close</button></div>`);
  const fail = (err) => { $('#modal-error').textContent = err.message; };
  const done = (updated) => { state.servers.set(updated.id, updated); openEmojiManager(serverId); };
  $('#emoji-name').oninput = (e) => (e.target.value = e.target.value.replace(/[^\w]/g, ''));
  $('#emoji-form').onsubmit = (e) => {
    e.preventDefault();
    if (!/^\w{2,32}$/.test($('#emoji-name').value)) return fail(new Error('Names use 2 to 32 letters, numbers or underscores'));
    $('#emoji-file').click();
  };
  $('#emoji-file').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const kind = $('#emoji-kind').value;
    $('#emoji-add-btn').disabled = true;
    $('#emoji-add-btn').textContent = 'Adding…';
    try {
      const blob = await fitPicture(file, kind === 'sticker' ? 320 : 128);
      done(await uploadPicture(`/api/servers/${serverId}/emoji?${new URLSearchParams({ name: $('#emoji-name').value, kind })}`, blob));
    } catch (err) {
      fail(err);
      $('#emoji-add-btn').disabled = false;
      $('#emoji-add-btn').textContent = 'Choose a picture and add it';
    }
  };
  $('#modal-card').querySelectorAll('[data-rename]').forEach((b) => (b.onclick = async () => {
    const e = s.emoji.find((x) => x.id === Number(b.dataset.rename));
    const name = prompt('New name', e.name);
    if (!name || name === e.name) return;
    try { done(await api(`/api/emoji/${e.id}`, { method: 'PATCH', body: { name } })); } catch (err) { fail(err); }
  }));
  $('#modal-card').querySelectorAll('[data-delete]').forEach((b) => (b.onclick = async () => {
    const e = s.emoji.find((x) => x.id === Number(b.dataset.delete));
    if (!confirm(`Delete :${e.name}:? Messages that used it show its name instead.`)) return;
    try { done(await api(`/api/emoji/${e.id}`, { method: 'DELETE' })); } catch (err) { fail(err); }
  }));
}

// ---- stickers

function stickerGroups() {
  return [state.serverId, ...state.serverOrder.filter((id) => id !== state.serverId)]
    .map((id) => state.servers.get(id))
    .filter((s) => s && !isDm(s) && s.emoji?.some((e) => e.kind === 'sticker'));
}
function openStickers() {
  const channelId = state.channelId;
  const groups = stickerGroups();
  modal(`<h2>Stickers</h2>
    ${groups.length ? '' : `<p class="muted">No stickers yet. People who can manage emoji add them in a burrow's settings.</p>`}
    <div id="sticker-groups"></div>
    <div class="modal-row"><button class="btn secondary" data-close>Close</button></div>`);
  $('#sticker-groups').replaceChildren(...groups.flatMap((s) => {
    const h = document.createElement('h4');
    h.textContent = s.name;
    const grid = document.createElement('div');
    grid.className = 'sticker-grid';
    grid.append(...s.emoji.filter((e) => e.kind === 'sticker').map((st) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.title = st.name;
      b.innerHTML = `<img src="${escapeHtml(state.serverUrl + st.url)}" alt="${escapeHtml(st.name)}" loading="lazy" />`;
      b.onclick = async () => {
        const replyTo = state.replyTo;
        closeModal();
        setReply(null);
        try { await sendMessage(channelId, { content: '', stickerId: st.id, replyTo: replyTo?.id }); }
        catch (err) { alertError(err); }
      };
      return b;
    }));
    return [h, grid];
  }));
}
function renderSticker(st) {
  if (st.deleted) {
    const el = document.createElement('div');
    el.className = 'muted small';
    el.textContent = 'Sent a sticker that has since been removed';
    return el;
  }
  const img = document.createElement('img');
  img.className = 'sticker';
  img.src = state.serverUrl + st.url;
  img.alt = st.name;
  img.title = st.name;
  img.loading = 'lazy';
  return img;
}

// ---------------------------------------------------------------- polls

function openPollCreator() {
  const channelId = state.channelId;
  if (!channelId) return;
  modal(`<h2>New poll</h2>
    <form id="poll-form">
      <label>Question<input id="poll-q" maxlength="300" required placeholder="e.g. Game night on Friday or Saturday?" /></label>
      <div class="poll-edit" id="poll-opts"></div>
      <button type="button" class="btn secondary" id="poll-add">Add an answer</button>
      <label class="check"><input type="checkbox" id="poll-multi" /> People can pick more than one</label>
      <label>Voting closes<select id="poll-hours">
        <option value="1">In an hour</option><option value="4">In 4 hours</option><option value="24" selected>In a day</option>
        <option value="72">In 3 days</option><option value="168">In a week</option><option value="0">When I end it</option></select></label>
      <div class="error" id="modal-error"></div>
      <div class="modal-row"><button type="button" class="btn secondary" data-close>Cancel</button><button type="submit" class="btn">Post poll</button></div>
    </form>`);
  const box = $('#poll-opts');
  const addOption = (value = '') => {
    if (box.children.length >= 10) return;
    const row = document.createElement('div');
    row.className = 'poll-edit-row';
    row.innerHTML = `<input maxlength="80" placeholder="Answer ${box.children.length + 1}" /><button type="button" class="icon-btn" title="Remove">×</button>`;
    row.querySelector('input').value = value;
    row.querySelector('button').onclick = () => { if (box.children.length > 2) row.remove(); };
    box.append(row);
    $('#poll-add').disabled = box.children.length >= 10;
  };
  addOption();
  addOption();
  $('#poll-add').onclick = () => { addOption(); box.lastChild.querySelector('input').focus(); };
  $('#poll-form').onsubmit = async (e) => {
    e.preventDefault();
    const options = [...box.querySelectorAll('input')].map((i) => i.value.trim()).filter(Boolean);
    const replyTo = state.replyTo;
    try {
      await api(`/api/channels/${channelId}/polls`, { method: 'POST', body: {
        question: $('#poll-q').value, options, multi: $('#poll-multi').checked, hours: Number($('#poll-hours').value), replyTo: replyTo?.id,
      } });
      closeModal();
      setReply(null);
    } catch (err) { $('#modal-error').textContent = err.message; }
  };
}

function renderPoll(m) {
  const p = m.poll;
  const server = roomById(m.channelId)?.s;
  const voters = new Set(p.options.flatMap((o) => o.userIds)).size;
  const mine = p.options.flatMap((o, i) => (o.userIds.includes(state.me.id) ? [i] : []));
  const most = Math.max(1, ...p.options.map((o) => o.userIds.length));
  const box = document.createElement('div');
  box.className = 'poll' + (p.closed ? ' closed' : '');
  const q = document.createElement('div');
  q.className = 'poll-q';
  q.textContent = p.question;
  box.append(q);
  box.insertAdjacentHTML('beforeend', `<div class="muted small">${p.closed ? 'Voting has closed' : p.multi ? 'Pick as many as you like' : 'Pick one'}</div>`);
  p.options.forEach((o, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    const n = o.userIds.length;
    const pct = voters ? Math.round((n / voters) * 100) : 0;
    b.className = 'poll-option' + (mine.includes(i) ? ' mine' : '') + (p.closed && n === most && n ? ' winner' : '');
    b.disabled = p.closed;
    b.title = n ? o.userIds.map((id) => server?.members.find((x) => x.id === id)?.username ?? 'someone').join(', ') : 'No votes yet';
    b.innerHTML = `<span class="poll-fill" style="width:${voters ? (n / voters) * 100 : 0}%"></span><span class="poll-text"></span><span class="poll-count">${n} · ${pct}%</span>`;
    b.querySelector('.poll-text').textContent = o.text;
    b.onclick = () => {
      const next = p.multi ? (mine.includes(i) ? mine.filter((x) => x !== i) : [...mine, i]) : mine.includes(i) ? [] : [i];
      api(`/api/messages/${m.id}/vote`, { method: 'POST', body: { options: next } }).catch(alertError);
    };
    box.append(b);
  });
  const foot = document.createElement('div');
  foot.className = 'muted small';
  foot.textContent = `${voters} ${voters === 1 ? 'person' : 'people'} voted · ` + (p.closed ? 'Final results' : p.closesAt ? `Closes ${new Date(p.closesAt).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : 'Open until ended');
  box.append(foot);
  return box;
}

// ---------------------------------------------------------------- link previews

function renderEmbeds(m) {
  const wrap = document.createElement('div');
  wrap.className = 'embeds';
  for (const e of m.embeds) {
    const card = document.createElement('div');
    card.className = 'embed' + (e.kind !== 'link' ? ' big' : '');
    const text = document.createElement('div');
    text.className = 'embed-text';
    if (e.siteName) text.insertAdjacentHTML('beforeend', `<div class="embed-site">${escapeHtml(e.siteName)}</div>`);
    if (e.title || e.kind === 'link') {
      const a = document.createElement('a');
      a.className = 'embed-title';
      a.href = e.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = e.title || e.url;
      text.append(a);
    }
    if (e.description) {
      const d = document.createElement('div');
      d.className = 'embed-desc';
      d.textContent = e.description;
      text.append(d);
    }
    if (text.childElementCount) card.append(text);
    if (e.image) {
      const a = document.createElement('a');
      a.className = 'embed-image' + (e.kind === 'video' ? ' video' : '');
      a.href = e.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.title = e.kind === 'video' ? 'Play (opens the video)' : e.title || e.url;
      const img = document.createElement('img');
      img.src = state.serverUrl + e.image;
      img.alt = '';
      img.loading = 'lazy';
      img.onerror = () => a.remove();
      a.append(img);
      card.append(a);
    }
    if (m.authorId === state.me.id) {
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'embed-remove';
      x.title = 'Remove link previews from this message';
      x.textContent = '×';
      x.onclick = () => api(`/api/messages/${m.id}/embeds`, { method: 'POST' }).catch(alertError);
      card.append(x);
    }
    wrap.append(card);
  }
  return wrap;
}

// ---------------------------------------------------------------- threads

function renderThreadChip(t) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'thread-chip';
  const where = roomById(t.id);
  const unread = where && isUnread(where.c);
  b.innerHTML = `${THREAD_ICON}<b></b><span class="muted">${t.count} ${t.count === 1 ? 'reply' : 'replies'}${t.lastAt ? ` · ${escapeHtml(formatTime(new Date(t.lastAt)))}` : ''}</span>${unread ? '<span class="dot"></span>' : ''}`;
  b.querySelector('b').textContent = t.name;
  b.onclick = () => selectChannel(t.id);
  return b;
}

async function startThread(m) {
  if (m.thread) return selectChannel(m.thread.id);
  try {
    const { threadId, server } = await api(`/api/messages/${m.id}/thread`, { method: 'POST', body: {} });
    rememberAvatars(server);
    state.servers.set(server.id, server);
    await selectChannel(threadId);
    showView('chat');
  } catch (err) { alertError(err); }
}

$('#thread-btn').onclick = () => {
  const where = roomById(state.channelId);
  if (where?.s.group) return openGroupSettings(where.s);
  if (!where?.thread) return;
  const t = where.c;
  modal(`<h2>Thread settings</h2>
    <form id="thread-form">
      <label>Thread name<input id="thread-name" maxlength="60" required value="${escapeHtml(t.name)}" /></label>
      <div class="error" id="modal-error"></div>
      <div class="modal-row">
        <button type="button" class="btn danger" id="thread-delete">Delete thread</button>
        <span class="spacer"></span>
        <button type="button" class="btn secondary" data-close>Cancel</button>
        <button type="submit" class="btn">Save</button>
      </div>
    </form>`);
  $('#thread-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const updated = await api(`/api/channels/${t.id}`, { method: 'PATCH', body: { name: $('#thread-name').value } });
      state.servers.set(updated.id, updated);
      closeModal();
      renderChannels();
      renderChatHeader();
    } catch (err) { $('#modal-error').textContent = err.message; }
  };
  $('#thread-delete').onclick = async () => {
    if (!confirm(`Delete the thread "${t.name}" and everything said in it?`)) return;
    try {
      await api(`/api/channels/${t.id}`, { method: 'DELETE' });
      closeModal();
      if (state.channelId === t.id) selectChannel(t.parentId);
    } catch (err) { $('#modal-error').textContent = err.message; }
  };
};

// ---------------------------------------------------------------- voice messages

let recording = null; // { rec, stream, chunks, started, channelId, timer }
const MAX_RECORDING_SECONDS = 300;
const clock = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

async function startRecording() {
  if (recording || !state.channelId) return;
  const channelId = state.channelId;
  let stream;
  try {
    const deviceId = await deviceIdFor('audioinput').catch(() => undefined);
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(deviceId ? { deviceId: { ideal: deviceId } } : {}) } });
  } catch (err) { return alert(mediaError(err, 'microphone')); }
  if (state.channelId !== channelId) return stream.getTracks().forEach((t) => t.stop());
  const mimeType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported?.(t));
  const rec = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 48000 } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const tick = () => {
    const sec = (Date.now() - recording.started) / 1000;
    $('#rec-time').textContent = clock(sec);
    if (sec >= MAX_RECORDING_SECONDS) finishRecording(true);
  };
  recording = { rec, stream, chunks, started: Date.now(), channelId, timer: setInterval(() => recording && tick(), 250) };
  rec.start(1000);
  closeEmojiPanel();
  closeGifPicker();
  $('#composer').classList.add('recording');
  $('#recorder').classList.remove('hidden');
  $('#rec-time').textContent = '0:00';
  $('#send-btn').title = 'Send voice message';
}

function finishRecording(send) {
  const r = recording;
  if (!r) return;
  recording = null;
  clearInterval(r.timer);
  $('#composer').classList.remove('recording');
  $('#recorder').classList.add('hidden');
  $('#send-btn').title = 'Send';
  const seconds = (Date.now() - r.started) / 1000;
  r.rec.onstop = () => {
    r.stream.getTracks().forEach((t) => t.stop());
    if (send && seconds >= 0.8) sendVoice(r, seconds);
  };
  r.rec.stop();
}
function cancelRecording() { finishRecording(false); }

async function sendVoice(r, seconds) {
  const type = (r.rec.mimeType || r.chunks[0]?.type || 'audio/webm').split(';')[0];
  const ext = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a' }[type] ?? 'webm';
  const file = new File(r.chunks, `voice-message.${ext}`, { type });
  if (file.size > state.maxUploadBytes) return alert('That recording is too big to send.');
  const replyTo = state.channelId === r.channelId ? state.replyTo : null;
  if (replyTo) setReply(null);
  try {
    const att = await uploadFile(r.channelId, { file, voiceSeconds: Math.round(seconds * 10) / 10, progress: 0 });
    await sendMessage(r.channelId, { content: '', attachmentIds: [att.id], replyTo: replyTo?.id });
  } catch (err) { alertError(err); }
}

$('#mic-btn').onclick = startRecording;
$('#rec-cancel').onclick = cancelRecording;

let playingVoice = null;
function voicePlayer(a, url) {
  const box = document.createElement('div');
  box.className = 'voice-msg';
  box.innerHTML = `<button type="button" class="voice-play" title="Play">${PLAY_ICON}</button>
    <div class="voice-track"><div class="voice-fill"></div></div><span class="voice-time">${clock(a.voiceSeconds)}</span>`;
  const audio = new Audio();
  audio.preload = 'none';
  audio.src = url;
  const play = box.querySelector('.voice-play');
  const fill = box.querySelector('.voice-fill');
  const time = box.querySelector('.voice-time');
  const length = () => (Number.isFinite(audio.duration) ? audio.duration : a.voiceSeconds);
  const show = () => {
    fill.style.width = `${Math.min(100, (audio.currentTime / length()) * 100)}%`;
    time.textContent = audio.paused && !audio.currentTime ? clock(a.voiceSeconds) : clock(audio.currentTime);
  };
  play.onclick = () => {
    if (audio.paused) {
      if (playingVoice && playingVoice !== audio) playingVoice.pause();
      playingVoice = audio;
      audio.play().catch(alertError);
    } else audio.pause();
  };
  audio.onplay = () => { play.innerHTML = PAUSE_ICON; play.title = 'Pause'; };
  audio.onpause = () => { play.innerHTML = PLAY_ICON; play.title = 'Play'; };
  audio.ontimeupdate = show;
  audio.onended = () => { audio.currentTime = 0; show(); };
  box.querySelector('.voice-track').onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const at = ((e.clientX - r.left) / r.width) * length();
    audio.currentTime = at;
    if (audio.paused) play.click();
  };
  return box;
}
const PLAY_ICON = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7L8 5Z"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7V5Zm6 0h4v14h-4V5Z"/></svg>';

// ---------------------------------------------------------------- text files show what's in them

const textCache = new Map(); // url -> Promise<string>
function textPreview(a, url) {
  const box = document.createElement('div');
  box.className = 'att-text collapsed';
  box.innerHTML = `<div class="att-text-head"><span class="file-icon">${FILE_ICON}</span><span class="att-file-name"></span>
    <span class="muted small">${formatSize(a.size)}</span><span class="spacer"></span><a class="btn secondary" target="_blank" rel="noopener">Open</a></div>
    <pre class="att-text-body muted">Loading…</pre><button type="button" class="att-text-more hidden">Show all</button>`;
  box.querySelector('.att-file-name').textContent = a.name;
  box.querySelector('a').href = url;
  const body = box.querySelector('pre');
  const more = box.querySelector('.att-text-more');
  if (!textCache.has(url)) textCache.set(url, fetch(url).then((r) => (r.ok ? r.text() : Promise.reject(new Error()))));
  textCache.get(url).then((text) => {
    body.classList.remove('muted');
    body.textContent = text.length > 100000 ? text.slice(0, 100000) + '\n…' : text;
    const long = text.split('\n').length > 14 || text.length > 1400;
    more.classList.toggle('hidden', !long);
    if (!long) box.classList.remove('collapsed');
  }).catch(() => { textCache.delete(url); body.textContent = "Couldn't load a preview. Open the file to see it."; });
  more.onclick = () => {
    const open = box.classList.toggle('collapsed');
    more.textContent = open ? 'Show all' : 'Show less';
  };
  return box;
}

// ---------------------------------------------------------------- search

function openSearch() {
  const here = state.servers.get(state.serverId);
  modal(`<h2>Search</h2>
    <form id="search-form" class="search-form">
      <input type="search" id="search-q" placeholder="Words to find" autocomplete="off" enterkeyhint="search" />
      <div class="search-filters">
        <select id="search-in" aria-label="Where">
          ${here ? `<option value="${here.id}">${isDm(here) ? 'This conversation' : `In ${escapeHtml(here.name)}`}</option>` : ''}
          <option value="dms">Direct messages</option><option value="">Everywhere</option>
        </select>
        <select id="search-room" aria-label="Room"></select>
        <select id="search-from" aria-label="From"></select>
        <select id="search-has" aria-label="Kind">
          <option value="">Any kind</option><option value="image">Pictures</option><option value="video">Videos</option>
          <option value="audio">Audio and voice</option><option value="file">Files</option><option value="link">Links</option><option value="poll">Polls</option>
        </select>
        <label class="search-date">After<input type="date" id="search-after" /></label>
        <label class="search-date">Before<input type="date" id="search-before" /></label>
      </div>
    </form>
    <div id="search-status" class="muted small">Type a word, or pick a person or a kind of message.</div>
    <div id="search-results" class="card-list"></div>
    <div class="modal-row"><button class="btn secondary hidden" id="search-more">More results</button><span class="spacer"></span><button class="btn secondary" data-close>Close</button></div>`, 'search-modal');
  const scope = () => $('#search-in').value;
  const fillFilters = () => {
    const s = state.servers.get(Number(scope()));
    const rooms = s && !isDm(s) ? [...s.channels.filter((c) => c.kind !== 'voice'), ...(s.threads ?? [])] : [];
    $('#search-room').innerHTML = '<option value="">Any room</option>' + rooms.map((c) => `<option value="${c.id}">${c.parentId ? '↳ ' : '#'}${escapeHtml(c.name)}</option>`).join('');
    $('#search-room').classList.toggle('hidden', !rooms.length);
    const people = new Map();
    const sources = s ? [s] : scope() === 'dms' ? state.dmOrder.map((id) => state.servers.get(id)) : [...state.servers.values()];
    for (const src of sources) for (const m of src?.members ?? []) people.set(m.id, m.username);
    $('#search-from').innerHTML = '<option value="">From anyone</option>' + [...people].sort((a, b) => a[1].localeCompare(b[1]))
      .map(([id, name]) => `<option value="${id}">From ${escapeHtml(name)}${id === state.me.id ? ' (you)' : ''}</option>`).join('');
  };
  fillFilters();
  let offset = 0;
  let seq = 0;
  const run = async (more = false) => {
    offset = more ? offset + 25 : 0;
    const q = $('#search-q').value.trim();
    const params = new URLSearchParams({ q });
    if (scope()) params.set('in', scope());
    for (const [key, sel] of [['room', '#search-room'], ['from', '#search-from'], ['has', '#search-has']]) if ($(sel).value) params.set(key, $(sel).value);
    if ($('#search-after').value) params.set('after', new Date($('#search-after').value + 'T00:00').getTime());
    if ($('#search-before').value) params.set('before', new Date($('#search-before').value + 'T00:00').getTime());
    if (offset) params.set('offset', offset);
    const list = $('#search-results');
    if (!q && !params.has('from') && !params.has('has')) {
      list.replaceChildren();
      $('#search-more').classList.add('hidden');
      $('#search-status').textContent = 'Type a word, or pick a person or a kind of message.';
      return;
    }
    const mine = ++seq;
    $('#search-status').textContent = 'Searching…';
    try {
      const { results, more: hasMore } = await api(`/api/search?${params}`);
      if (mine !== seq || !list.isConnected) return;
      const words = q.match(/[\p{L}\p{N}_]+/gu) ?? [];
      const cards = results.map(({ message, place }) => {
        const card = messageCard(message, place, { onOpen: () => jumpTo(message.channelId, message.id) });
        markWords(card.querySelector('.content'), words);
        return card;
      });
      if (more) list.append(...cards);
      else list.replaceChildren(...cards);
      $('#search-more').classList.toggle('hidden', !hasMore);
      const count = list.children.length;
      $('#search-status').textContent = count ? `${count}${hasMore ? '+' : ''} message${count === 1 ? '' : 's'}, newest first` : 'Nothing found.';
    } catch (err) {
      if (mine === seq) $('#search-status').textContent = err.message;
    }
  };
  let timer = 0;
  $('#search-q').oninput = () => { clearTimeout(timer); timer = setTimeout(() => run(), 300); };
  $('#search-form').onsubmit = (e) => { e.preventDefault(); clearTimeout(timer); run(); };
  $('#search-in').onchange = () => { fillFilters(); run(); };
  for (const sel of ['#search-room', '#search-from', '#search-has', '#search-after', '#search-before']) $(sel).onchange = () => run();
  $('#search-more').onclick = () => run(true);
  $('#search-q').focus();
}

/** Highlights where the searched words start, in a message's text. */
function markWords(el, words) {
  if (!el || !words.length) return;
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])(${words.map(escapeRegex).join('|')})`, 'giu');
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (!re.test(node.data)) continue;
    re.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of node.data.matchAll(re)) {
      frag.append(node.data.slice(last, m.index));
      const mark = document.createElement('mark');
      mark.textContent = m[0];
      frag.append(mark);
      last = m.index + m[0].length;
    }
    frag.append(node.data.slice(last));
    node.replaceWith(frag);
  }
}

$('#search-btn').onclick = openSearch;
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && state.me && !$('#app').classList.contains('hidden')) {
    e.preventDefault();
    openSearch();
  }
});

// ---------------------------------------------------------------- the + menu in the message box

$('#plus-btn').onclick = (e) => {
  if (!state.channelId) return;
  openMenu(e.currentTarget, [
    state.maxUploadBytes && { label: 'Upload files', run: () => $('#file-input').click() },
    { label: 'Create a poll', run: openPollCreator },
    stickerGroups().length && { label: 'Send a sticker', run: openStickers },
    { label: 'Send later…', run: openSchedule },
  ]);
};

// ---------------------------------------------------------------- rooms, burrows and organization

const BELL_ICON = '<svg viewBox="0 0 24 24"><path d="M12 22a2.5 2.5 0 0 0 2.5-2.5h-5A2.5 2.5 0 0 0 12 22Zm7-6v-5a7 7 0 0 0-5.5-6.8V3a1.5 1.5 0 0 0-3 0v1.2A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2Z"/></svg>';
const BELL_OFF_ICON = '<svg viewBox="0 0 24 24"><path d="M12 22a2.5 2.5 0 0 0 2.5-2.5h-5A2.5 2.5 0 0 0 12 22Zm7-6v-5a7 7 0 0 0-5.5-6.8V3a1.5 1.5 0 0 0-3 0v1.2c-1 .2-1.9.7-2.7 1.3L19 16.7V16ZM3.3 2.3 2 3.6l4.1 4.1A7 7 0 0 0 5 11v5l-2 2v1h14.4l3 3 1.3-1.3L3.3 2.3Z"/></svg>';
const CALENDAR_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 2h2v2h6V2h2v2h2a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2V2Zm12 8H5v9h14v-9Z"/></svg>';
const FOLDER_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5Z"/></svg>';
const PEOPLE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-6 9c0-3.3 2.7-6 6-6s6 2.7 6 6H3Zm13-9a3 3 0 1 0 0-6 3 3 0 0 1 0 6Zm1 3c2.5.4 4 2.6 4 6h-4.5c0-2.4-.8-4.5-2.2-6H17Z"/></svg>';

// ---- notifications: rooms and burrows can be muted for a while, or set to all messages, @mentions only, or nothing

const isMutedPref = (p) => !!p?.mutedUntil && (p.mutedUntil === -1 || p.mutedUntil > Date.now());
/** Threads follow the room they hang off. */
const settingsRoom = (s, c) => (c?.parentId ? s?.channels.find((x) => x.id === c.parentId) ?? c : c);
/** How loudly a room tells you about messages: its own setting, else the burrow's, else everything. */
function notifyState(s, c) {
  const own = settingsRoom(s, c)?.notify;
  return { muted: isMutedPref(s?.notify) || isMutedPref(own), level: own?.level ?? s?.notify?.level ?? 'all' };
}
/** New messages here light up the room and the burrow. */
const roomLoud = (s, c) => { const n = notifyState(s, c); return !n.muted && n.level === 'all'; };
/** No sound or notification for this message. */
function quietFor(m) {
  const where = roomById(m.channelId);
  if (!where) return false;
  const n = notifyState(where.s, where.c);
  return n.muted || n.level === 'none' || (n.level === 'mentions' && !isDm(where.s) && !mentionsMe(m));
}

const muteLabel = (until) => (until === -1 ? 'until you turn it back on' : `until ${formatTime(new Date(until)).replace(/^(Today|Yesterday)/, (w) => w.toLowerCase())}`);

// The menu for a room (c) or a whole burrow or conversation (c null).
function openNotifyMenu(anchor, s, c = null) {
  const pref = (c ? c.notify : s.notify) ?? { level: null, mutedUntil: null };
  const muted = isMutedPref(pref);
  const level = pref.level ?? null;
  const tick = (on, label) => (on ? `✓ ${label}` : label);
  const set = (change) => setNotify(s, c, { level, mutedUntil: muted ? pref.mutedUntil : null, ...change });
  const levels = isDm(s) ? [] : [
    c && { label: tick(level === null, `Same as ${s.name}`), run: () => set({ level: null }) },
    { label: tick(level === 'all' || (!c && level === null), 'All messages'), run: () => set({ level: 'all' }) },
    { label: tick(level === 'mentions', 'Only @mentions'), run: () => set({ level: 'mentions' }) },
    { label: tick(level === 'none', 'Nothing'), run: () => set({ level: 'none' }) },
  ];
  const later = (ms) => Date.now() + ms;
  openMenu(anchor, [
    ...levels,
    muted
      ? { label: `Unmute (muted ${muteLabel(pref.mutedUntil)})`, run: () => set({ mutedUntil: null }) }
      : null,
    ...(muted ? [] : [
      { label: 'Mute for 1 hour', run: () => set({ mutedUntil: later(3600e3) }) },
      { label: 'Mute for 8 hours', run: () => set({ mutedUntil: later(8 * 3600e3) }) },
      { label: 'Mute for 24 hours', run: () => set({ mutedUntil: later(24 * 3600e3) }) },
      { label: 'Mute until I turn it back on', run: () => set({ mutedUntil: -1 }) },
    ]),
  ]);
}

async function setNotify(s, c, body) {
  try {
    const server = await api('/api/notify', { method: 'POST', body: { serverId: s.id, channelId: c?.id ?? null, ...body } });
    handleEvent({ type: 'server_updated', server });
  } catch (err) { alertError(err); }
}

$('#notify-btn').onclick = () => {
  const where = roomById(state.channelId);
  if (!where) return;
  // In a DM the whole conversation is muted; in a burrow, the room (or the room a thread is in).
  openNotifyMenu($('#notify-btn'), where.s, isDm(where.s) ? null : settingsRoom(where.s, where.c));
};

function renderNotifyButton() {
  const where = roomById(state.channelId);
  const btn = $('#notify-btn');
  btn.classList.toggle('hidden', !where);
  if (!where) return;
  const n = notifyState(where.s, where.c);
  const quiet = n.muted || n.level === 'none';
  btn.innerHTML = quiet ? BELL_OFF_ICON : BELL_ICON;
  btn.classList.toggle('on', quiet || n.level === 'mentions');
  btn.title = n.muted ? 'Muted. Click to change.' : n.level === 'mentions' ? 'Only @mentions notify you' : n.level === 'none' ? 'Nothing here notifies you' : 'Notifications';
}

// Mutes run out on their own; check every minute so the dots come back.
setInterval(() => {
  if (!state.me) return;
  const timed = [...state.servers.values()].some((s) => [s.notify, ...s.channels.map((c) => c.notify)].some((p) => p?.mutedUntil > 0 && p.mutedUntil <= Date.now()));
  if (timed) { renderServers(); renderChannels(); renderNotifyButton(); }
}, 60e3);

// ---- room headings, order and archive

const foldKey = (id) => `fold:${id}`;
const isFolded = (id) => store.get(foldKey(id)) === '1';

/** Text rooms in the order they're shown: those without a heading, then each heading's rooms. */
function shownTextRooms(s) {
  const live = s.channels.filter((c) => c.kind !== 'voice' && !c.archived);
  const groups = s.groups ?? [];
  const known = (c) => groups.some((g) => g.id === c.groupId);
  return [...live.filter((c) => !known(c)).map((c) => ({ id: c.id, groupId: null })),
    ...groups.flatMap((g) => live.filter((c) => c.groupId === g.id).map((c) => ({ id: c.id, groupId: g.id })))];
}

/** Saves the rooms in this order (text rooms as given, then archived and voice rooms as they are). */
async function saveLayout(s, order, groups = (s.groups ?? []).map((g) => g.id)) {
  const rest = s.channels.filter((c) => c.kind === 'voice' || c.archived).map((c) => ({ id: c.id, groupId: c.groupId ?? null }));
  const updated = await api(`/api/servers/${s.id}/layout`, { method: 'POST', body: { rooms: [...order, ...rest], groups } });
  state.servers.set(updated.id, updated);
  renderChannels();
  return updated;
}

/** Moves a room before another one (taking its heading), or to the end of a heading's rooms. */
function moveRoom(s, id, { beforeId = null, groupId = null }) {
  const order = shownTextRooms(s).filter((x) => x.id !== id);
  const i = beforeId ? order.findIndex((x) => x.id === beforeId) : -1;
  if (i >= 0) order.splice(i, 0, { id, groupId: order[i].groupId });
  else {
    const last = order.map((x) => x.groupId).lastIndexOf(groupId);
    order.splice(last >= 0 ? last + 1 : groupId === null ? 0 : order.length, 0, { id, groupId });
  }
  return saveLayout(s, order).catch(alertError);
}

// Dragging rooms in the list, for people who manage rooms (on a computer; phones use "Arrange rooms").
let draggingRoom = null;
function makeDraggable(li, s, c) {
  li.draggable = true;
  li.addEventListener('dragstart', (e) => { draggingRoom = c.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', c.name); li.classList.add('dragging'); });
  li.addEventListener('dragend', () => { draggingRoom = null; li.classList.remove('dragging'); clearDropMarks(); });
  dropTarget(li, () => draggingRoom !== c.id && moveRoom(s, draggingRoom, { beforeId: c.id }));
}
function dropTarget(el, drop) {
  el.addEventListener('dragover', (e) => {
    if (draggingRoom === null) return;
    e.preventDefault();
    clearDropMarks();
    el.classList.add('drop-here');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-here'));
  el.addEventListener('drop', (e) => { e.preventDefault(); clearDropMarks(); if (draggingRoom !== null) drop(); });
}
const clearDropMarks = () => document.querySelectorAll('.drop-here').forEach((x) => x.classList.remove('drop-here'));

/** A heading in the room list. Clicking folds it; a folded heading shows a dot when a room under it has news. */
function groupHeading(s, g, rooms) {
  const li = document.createElement('li');
  const folded = isFolded(g.id);
  li.className = 'room-group' + (folded ? ' folded' : '');
  li.innerHTML = CHEVRON_ICON;
  const name = document.createElement('span');
  name.textContent = g.name;
  li.append(name);
  li.setAttribute('role', 'button');
  li.setAttribute('aria-expanded', String(!folded));
  if (folded && rooms.some((c) => isUnread(c) && roomLoud(s, c))) li.classList.add('unread');
  li.onclick = () => { store.set(foldKey(g.id), folded ? null : '1'); renderChannels(); };
  if (can(s, 'rooms') && !isPhone()) dropTarget(li, () => moveRoom(s, draggingRoom, { groupId: g.id }));
  return li;
}

$('#archived-toggle').onclick = () => {
  const open = $('#archived-list').classList.toggle('hidden') === false;
  $('#archived-toggle').setAttribute('aria-expanded', String(open));
};

// The + by "Rooms": people who manage rooms also get headings and arranging.
function openRoomsMenu() {
  const s = state.servers.get(state.serverId);
  openMenu($('#add-channel'), [
    { label: 'New room', run: openNewRoom },
    { label: 'New heading', run: () => openHeadingEditor(s, null) },
    { label: 'Arrange rooms', run: () => openArrange(s.id) },
  ]);
}

function openHeadingEditor(s, g, back = null) {
  modal(`<h2>${g ? 'Rename heading' : 'New heading'}</h2>
    <p class="muted small">Headings group rooms in the list, like "Games" or "Hangout". Anyone can fold them away.</p>
    <form id="heading-form">
      <label>Heading<input id="heading-name" maxlength="32" required value="${escapeHtml(g?.name ?? '')}" placeholder="e.g. Games" /></label>
      <div class="error" id="modal-error"></div>
      <div class="modal-row"><button type="button" class="btn secondary" id="heading-cancel">Cancel</button><button type="submit" class="btn">${g ? 'Save' : 'Add heading'}</button></div>
    </form>`);
  $('#heading-cancel').onclick = () => (back ? back() : closeModal());
  $('#heading-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const body = { name: $('#heading-name').value };
      const updated = await api(g ? `/api/groups/${g.id}` : `/api/servers/${s.id}/groups`, { method: g ? 'PATCH' : 'POST', body });
      state.servers.set(updated.id, updated);
      renderChannels();
      back ? back() : closeModal();
    } catch (err) { $('#modal-error').textContent = err.message; }
  };
}

// Moving rooms with buttons, and managing headings. Works the same on phones.
function openArrange(serverId) {
  const s = state.servers.get(serverId);
  if (!s) return closeModal();
  const groups = s.groups ?? [];
  const order = shownTextRooms(s);
  const voice = s.channels.filter((c) => c.kind === 'voice');
  const roomName = (id) => s.channels.find((c) => c.id === id)?.name ?? '';
  const options = (sel) => `<option value="">No heading</option>${groups.map((g) => `<option value="${g.id}" ${g.id === sel ? 'selected' : ''}>${escapeHtml(g.name)}</option>`).join('')}`;
  const roomRow = (x) => {
    const same = order.filter((o) => o.groupId === x.groupId);
    const i = same.findIndex((o) => o.id === x.id);
    return `<li data-room="${x.id}"><span class="arrange-name">#${escapeHtml(roomName(x.id))}</span>
      <button class="icon-btn" data-up="${x.id}" title="Move up" ${i === 0 ? 'disabled' : ''}>▲</button>
      <button class="icon-btn" data-down="${x.id}" title="Move down" ${i === same.length - 1 ? 'disabled' : ''}>▼</button>
      ${groups.length ? `<select data-group="${x.id}" aria-label="Heading for ${escapeHtml(roomName(x.id))}">${options(x.groupId)}</select>` : ''}</li>`;
  };
  const section = (g, i) => `<li class="arrange-head"><b>${escapeHtml(g.name)}</b>
      <button class="icon-btn" data-gup="${g.id}" title="Move heading up" ${i === 0 ? 'disabled' : ''}>▲</button>
      <button class="icon-btn" data-gdown="${g.id}" title="Move heading down" ${i === groups.length - 1 ? 'disabled' : ''}>▼</button>
      <button class="btn secondary" data-rename="${g.id}">Rename</button><button class="btn danger" data-gdel="${g.id}">Delete</button></li>
    ${order.filter((o) => o.groupId === g.id).map(roomRow).join('') || '<li class="muted small">No rooms here yet.</li>'}`;
  modal(`<h2>Arrange rooms</h2>
    <p class="muted small">This is the order everyone sees. On a computer you can also drag rooms in the list.</p>
    <ul class="arrange-list">
      ${order.filter((o) => o.groupId === null).map(roomRow).join('')}
      ${groups.map(section).join('')}
    </ul>
    ${voice.length > 1 ? `<h3>Voice rooms</h3><p class="muted small">The first one is the Campfire.</p>
      <ul class="arrange-list">${voice.map((c, i) => `<li><span class="arrange-name">${escapeHtml(c.name)}</span>
        <button class="icon-btn" data-vup="${c.id}" ${i === 0 ? 'disabled' : ''} title="Move up">▲</button>
        <button class="icon-btn" data-vdown="${c.id}" ${i === voice.length - 1 ? 'disabled' : ''} title="Move down">▼</button></li>`).join('')}</ul>` : ''}
    <div class="error" id="modal-error"></div>
    <div class="modal-row"><button class="btn secondary" id="arrange-heading">New heading</button><span class="spacer"></span><button class="btn" data-close>Done</button></div>`);
  const card = $('#modal-card');
  const run = async (work) => {
    try { await work(); openArrange(serverId); } catch (err) { $('#modal-error').textContent = err.message; }
  };
  const swap = (list, id, dir) => {
    const i = list.findIndex((x) => (x.id ?? x) === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return list;
    [list[i], list[j]] = [list[j], list[i]];
    return list;
  };
  const moveWithin = (id, dir) => {
    const x = order.find((o) => o.id === id);
    const same = order.filter((o) => o.groupId === x.groupId);
    const j = same.findIndex((o) => o.id === id) + dir;
    if (!same[j]) return;
    const a = order.indexOf(x), b = order.indexOf(same[j]);
    [order[a], order[b]] = [order[b], order[a]];
    return saveLayout(s, order);
  };
  card.querySelectorAll('[data-up]').forEach((b) => (b.onclick = () => run(() => moveWithin(Number(b.dataset.up), -1))));
  card.querySelectorAll('[data-down]').forEach((b) => (b.onclick = () => run(() => moveWithin(Number(b.dataset.down), 1))));
  card.querySelectorAll('[data-group]').forEach((sel) => (sel.onchange = () => run(() => moveRoom(s, Number(sel.dataset.group), { groupId: sel.value ? Number(sel.value) : null }))));
  const groupIds = groups.map((g) => g.id);
  card.querySelectorAll('[data-gup]').forEach((b) => (b.onclick = () => run(() => saveLayout(s, order, swap(groupIds, Number(b.dataset.gup), -1)))));
  card.querySelectorAll('[data-gdown]').forEach((b) => (b.onclick = () => run(() => saveLayout(s, order, swap(groupIds, Number(b.dataset.gdown), 1)))));
  card.querySelectorAll('[data-rename]').forEach((b) => (b.onclick = () => openHeadingEditor(s, groups.find((g) => g.id === Number(b.dataset.rename)), () => openArrange(serverId))));
  card.querySelectorAll('[data-gdel]').forEach((b) => (b.onclick = () => run(async () => {
    const g = groups.find((x) => x.id === Number(b.dataset.gdel));
    if (!confirm(`Delete the ${g.name} heading? Its rooms stay, without a heading.`)) return;
    state.servers.set(s.id, await api(`/api/groups/${g.id}`, { method: 'DELETE' }));
    renderChannels();
  })));
  // Voice rooms keep their own order, after the text rooms.
  const moveVoice = (id, dir) => {
    const ids = swap(voice.map((c) => c.id), id, dir);
    const archived = s.channels.filter((c) => c.kind === 'text' && c.archived).map((c) => ({ id: c.id, groupId: c.groupId ?? null }));
    return api(`/api/servers/${s.id}/layout`, { method: 'POST', body: { rooms: [...order, ...archived, ...ids.map((id) => ({ id }))], groups: groupIds } })
      .then((u) => { state.servers.set(u.id, u); renderChannels(); });
  };
  card.querySelectorAll('[data-vup]').forEach((b) => (b.onclick = () => run(() => moveVoice(Number(b.dataset.vup), -1))));
  card.querySelectorAll('[data-vdown]').forEach((b) => (b.onclick = () => run(() => moveVoice(Number(b.dataset.vdown), 1))));
  $('#arrange-heading').onclick = () => openHeadingEditor(s, null, () => openArrange(serverId));
}

// ---- writing in a room: archived rooms, announcement rooms, rules and slow mode

/** Why you can't write in the open room, or null. */
function postBlock(where) {
  if (!where || isDm(where.s)) return null;
  const { s, c } = where;
  if (settingsRoom(s, c)?.archived) return { text: 'This room is archived. You can read it, but nobody can write in it.' };
  if (!s.rulesAccepted) return { text: `Accept ${s.name}'s rules to start chatting.`, button: 'Read the rules', run: () => openRules(s) };
  if (!where.thread && c.canPost === false) return { text: 'Only some people can post in this room. You can still react and reply in threads.' };
  return null;
}

function renderComposerLock() {
  const block = postBlock(roomById(state.channelId));
  const lock = $('#composer-lock');
  lock.classList.toggle('hidden', !block);
  $('#composer').classList.toggle('hidden', !!block);
  if (!block) return;
  lock.replaceChildren(block.text);
  if (block.button) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn';
    b.textContent = block.button;
    b.onclick = block.run;
    lock.append(b);
  }
}

const slowExempt = (s) => can(s, 'rooms') || can(s, 'messages');
const slowWaits = new Map(); // channel id -> when you can send again
const SLOW_CHOICES = [[0, 'Off'], [5, '5 seconds'], [10, '10 seconds'], [30, '30 seconds'], [60, '1 minute'], [300, '5 minutes'], [900, '15 minutes'], [3600, '1 hour'], [21600, '6 hours']];
const slowLabel = (sec) => SLOW_CHOICES.find(([v]) => v === sec)?.[1] ?? `${sec} seconds`;

/** After you send in a slow room, the send button waits it out. */
function startSlowWait(channelId, sentAt = Date.now()) {
  const where = roomById(channelId);
  const slow = where?.c.slow ?? 0;
  if (!slow || slowExempt(where.s) || where.thread || sentAt + slow * 1000 <= Date.now()) return;
  slowWaits.set(channelId, sentAt + slow * 1000);
  renderSlowNote();
}
let slowTimer = 0;
function renderSlowNote() {
  clearTimeout(slowTimer);
  const note = $('#slow-note');
  const left = Math.ceil(((slowWaits.get(state.channelId) ?? 0) - Date.now()) / 1000);
  note.classList.toggle('hidden', left <= 0);
  $('#send-btn').disabled = left > 0 || !state.channelId;
  if (left <= 0) return slowWaits.delete(state.channelId);
  note.textContent = `Slow mode is on. You can send again in ${left >= 60 ? `${Math.ceil(left / 60)} min` : `${left}s`}.`;
  slowTimer = setTimeout(renderSlowNote, 1000);
}

// ---- burrow banner, description, rules and welcome room

function renderBurrowHead(s) {
  const show = s && !isDm(s);
  const banner = $('#burrow-banner');
  banner.classList.toggle('hidden', !show || !s.banner);
  if (show && s.banner && banner.dataset.src !== s.banner) {
    banner.dataset.src = s.banner;
    const img = document.createElement('img');
    img.src = state.serverUrl + s.banner;
    img.alt = '';
    img.onerror = () => banner.classList.add('hidden');
    banner.replaceChildren(img);
  }
  const desc = $('#server-desc');
  desc.textContent = show ? s.description ?? '' : '';
  desc.title = desc.textContent;
  desc.classList.toggle('hidden', !desc.textContent);
}

const rulesShown = new Set(); // burrows whose rules popped up this visit
function openRules(s) {
  modal(`<h2>${escapeHtml(s.name)}'s rules</h2>
    <div class="rules-text">${formatContent(s.rules)}</div>
    <p class="muted small">${s.rulesAccepted ? 'You accepted these.' : 'Agree to them to start chatting here.'}</p>
    <div class="error" id="modal-error"></div>
    <div class="modal-row"><button class="btn secondary" data-close>${s.rulesAccepted ? 'Close' : 'Not now'}</button>${s.rulesAccepted ? '' : '<button class="btn" id="rules-accept">I agree</button>'}</div>`);
  $('#rules-accept')?.addEventListener('click', async () => {
    try {
      handleEvent({ type: 'server_updated', server: await api(`/api/servers/${s.id}/rules/accept`, { method: 'POST' }) });
      closeModal();
      toast(`Welcome to ${s.name}!`);
    } catch (err) { $('#modal-error').textContent = err.message; }
  });
}
function maybeShowRules(s) {
  if (!s || isDm(s) || s.rulesAccepted || rulesShown.has(s.id)) return;
  rulesShown.add(s.id);
  openRules(s);
}

// A wide banner: cropped to 3:1 from the middle and shrunk, so it loads fast.
async function bannerPicture(file) {
  let img;
  try { img = await createImageBitmap(file); }
  catch { throw new Error("That file doesn't look like a picture"); }
  const w = Math.min(img.width, img.height * 3), h = w / 3;
  const canvas = document.createElement('canvas');
  canvas.width = 960;
  canvas.height = 320;
  canvas.getContext('2d').drawImage(img, (img.width - w) / 2, (img.height - h) / 2, w, h, 0, 0, 960, 320);
  const encode = (type) => new Promise((resolve) => canvas.toBlob(resolve, type, 0.85));
  const webp = await encode('image/webp');
  return webp?.type === 'image/webp' ? webp : encode('image/jpeg');
}

// Name, description, pictures, welcome room, rules and handing the burrow over.
function openEditBurrow(serverId) {
  const s = state.servers.get(serverId);
  if (!s) return closeModal();
  const host = isHost(s, state.me.id);
  const rooms = s.channels.filter((c) => c.kind === 'text' && !c.private && !c.archived);
  const others = s.members.filter((m) => m.id !== state.me.id);
  modal(`<h2>Edit ${escapeHtml(s.name)}</h2>
    <form id="burrow-form">
      <label>Name<input id="burrow-name" maxlength="64" required value="${escapeHtml(s.name)}" /></label>
      <label>Description<textarea id="burrow-desc" maxlength="300" rows="2" placeholder="What's this burrow for?">${escapeHtml(s.description ?? '')}</textarea></label>
      <label>Welcome room
        <select id="burrow-welcome"><option value="">The first room</option>${rooms.map((c) => `<option value="${c.id}" ${c.id === s.welcomeChannelId ? 'selected' : ''}>#${escapeHtml(c.name)}</option>`).join('')}</select>
        <span class="small muted">Where new people land when they first open the burrow.</span>
      </label>
      <label>Rules<textarea id="burrow-rules" maxlength="2000" rows="4" placeholder="Leave empty for no rules">${escapeHtml(s.rules ?? '')}</textarea>
        <span class="small muted">New people accept these before they can chat. Changing them asks everyone again.</span>
      </label>
      <div class="error" id="modal-error"></div>
      <div class="modal-row"><button type="button" class="btn secondary" data-close>Cancel</button><button type="submit" class="btn">Save</button></div>
    </form>
    ${state.maxUploadBytes ? `<h3>Picture</h3>
    <div class="account-picture burrow-picture">
      <span id="burrow-picture-tile"></span>
      <div class="buttons">
        <div>
          <button type="button" class="btn secondary" id="burrow-picture-pick">Change picture</button>
          <button type="button" class="btn secondary ${s.icon ? '' : 'hidden'}" id="burrow-picture-remove">Remove</button>
        </div>
        <span class="small muted">Shows in everyone's top bar. PNG, JPEG, GIF or WebP, cropped to a square.</span>
      </div>
      <input type="file" id="burrow-picture-input" accept="image/png,image/jpeg,image/gif,image/webp" hidden />
    </div>
    <div class="error" id="burrow-picture-error"></div>
    <h3>Banner</h3>
    <div class="banner-edit">
      <div class="banner-preview" id="banner-preview">${s.banner ? `<img src="${escapeHtml(state.serverUrl + s.banner)}" alt="" />` : '<span class="muted small">No banner</span>'}</div>
      <div>
        <button type="button" class="btn secondary" id="banner-pick">${s.banner ? 'Change banner' : 'Add a banner'}</button>
        <button type="button" class="btn secondary ${s.banner ? '' : 'hidden'}" id="banner-remove">Remove</button>
      </div>
      <span class="small muted">Shows above the rooms and on invite links. Cropped to a wide strip.</span>
      <input type="file" id="banner-input" accept="image/png,image/jpeg,image/gif,image/webp" hidden />
      <div class="error" id="banner-error"></div>
    </div>` : ''}
    ${host && others.length ? `<h3>Hand the burrow over</h3>
    <p class="small muted">Someone else becomes the host and can do everything. You stay in the burrow with your roles.</p>
    <div class="transfer-row"><select id="transfer-to">${others.map((m) => `<option value="${m.id}">${escapeHtml(m.username)}</option>`).join('')}</select>
      <button type="button" class="btn danger" id="transfer-go">Hand over</button></div>` : ''}`);
  const done = (updated) => { handleEvent({ type: 'server_updated', server: updated }); };
  $('#burrow-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      done(await api(`/api/servers/${s.id}`, {
        method: 'PATCH',
        body: {
          name: $('#burrow-name').value,
          description: $('#burrow-desc').value,
          welcomeChannelId: $('#burrow-welcome').value ? Number($('#burrow-welcome').value) : null,
          rules: $('#burrow-rules').value,
        },
      }));
      closeModal();
    } catch (err) { $('#modal-error').textContent = err.message; }
  };
  if ($('#burrow-picture-tile')) wireBurrowPicture(s);
  // The banner saves straight away, leaving the rest of the form as it is.
  const showBanner = (updated) => {
    done(updated);
    $('#banner-preview').innerHTML = updated.banner ? `<img src="${escapeHtml(state.serverUrl + updated.banner)}" alt="" />` : '<span class="muted small">No banner</span>';
    $('#banner-remove').classList.toggle('hidden', !updated.banner);
  };
  if ($('#banner-pick')) {
    const pick = $('#banner-pick');
    pick.onclick = () => $('#banner-input').click();
    $('#banner-input').onchange = async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      pick.disabled = true;
      pick.textContent = 'Uploading…';
      $('#banner-error').textContent = '';
      try { showBanner(await uploadPicture(`/api/servers/${s.id}/banner`, await bannerPicture(file))); }
      catch (err) { $('#banner-error').textContent = err.message; }
      pick.disabled = false;
      pick.textContent = 'Change banner';
    };
    $('#banner-remove').onclick = async () => {
      try { showBanner(await api(`/api/servers/${s.id}/banner`, { method: 'DELETE' })); }
      catch (err) { $('#banner-error').textContent = err.message; }
    };
  }
  $('#transfer-go')?.addEventListener('click', async () => {
    const to = others.find((m) => m.id === Number($('#transfer-to').value));
    if (!to || !confirm(`Make ${to.username} the host of ${s.name}? You can't take this back yourself.`)) return;
    try { done(await api(`/api/servers/${s.id}/transfer`, { method: 'POST', body: { userId: to.id } })); closeModal(); toast(`${to.username} is now the host.`); }
    catch (err) { alertError(err); }
  });
}

// ---- invites: the permanent code, and links that run out

const inviteLink = (code) => `${state.serverUrl}/invite/${code}`;
const EXPIRES = [[1800, '30 minutes'], [3600, '1 hour'], [6 * 3600, '6 hours'], [86400, '1 day'], [7 * 86400, '7 days'], [30 * 86400, '30 days'], [0, 'Never']];
const USES = [[0, 'No limit'], [1, '1 use'], [5, '5 uses'], [10, '10 uses'], [25, '25 uses'], [100, '100 uses']];

function copyButton(btn, text) {
  btn.onclick = () => { navigator.clipboard?.writeText(text).catch(() => {}); btn.textContent = 'Copied!'; setTimeout(() => (btn.textContent = 'Copy'), 1500); };
}

function openInvites(serverId) {
  const s = state.servers.get(serverId);
  if (!s) return closeModal();
  modal(`<h2>Invite people to ${escapeHtml(s.name)}</h2>
    <label>Invite link
      <div class="invite-box"><input id="invite" readonly value="${escapeHtml(inviteLink(s.inviteCode))}" /><button class="btn" id="copy-invite">Copy</button></div>
    </label>
    <p class="small muted">It never runs out. In the desktop app, people can paste the link or just the code <b>${escapeHtml(s.inviteCode)}</b>.
      ${can(s, 'burrow') ? '<button type="button" class="link-btn" id="new-code">Make a new one</button> if it got out.' : ''}</p>
    <h3>A link that runs out</h3>
    <div class="invite-make">
      <label>Expires after<select id="inv-expires">${EXPIRES.map(([v, l]) => `<option value="${v}" ${v === 86400 ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>Can be used<select id="inv-uses">${USES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
      <button class="btn secondary" id="inv-make">Make link</button>
    </div>
    <div id="inv-new"></div>
    <div id="inv-list"></div>
    <div class="error" id="modal-error"></div>
    <div class="modal-row"><button class="btn secondary" data-close>Close</button></div>`);
  copyButton($('#copy-invite'), inviteLink(s.inviteCode));
  $('#new-code')?.addEventListener('click', async () => {
    if (!confirm('Make a new permanent link? The old link and code stop working.')) return;
    try { handleEvent({ type: 'server_updated', server: await api(`/api/servers/${s.id}/invite-code`, { method: 'POST' }) }); openInvites(s.id); }
    catch (err) { $('#modal-error').textContent = err.message; }
  });
  const showList = (invites) => {
    const box = $('#inv-list');
    if (!box) return;
    if (!invites.length) return box.replaceChildren();
    box.innerHTML = `<h3>Links still working</h3><ul class="invite-list">${invites.map((i) => `<li>
      <span><code>${escapeHtml(i.code)}</code><span class="small muted"> · ${i.maxUses ? `${i.uses} of ${i.maxUses} used` : `${i.uses} used`}${i.expiresAt ? ` · until ${escapeHtml(formatTime(new Date(i.expiresAt)))}` : ''}${i.createdBy && i.createdBy !== state.me.username ? ` · by ${escapeHtml(i.createdBy)}` : ''}</span></span>
      <button class="btn secondary" data-copy="${escapeHtml(i.code)}">Copy</button><button class="btn danger" data-cancel="${escapeHtml(i.code)}">Cancel</button></li>`).join('')}</ul>`;
    box.querySelectorAll('[data-copy]').forEach((b) => copyButton(b, inviteLink(b.dataset.copy)));
    box.querySelectorAll('[data-cancel]').forEach((b) => (b.onclick = async () => {
      try { showList(await api(`/api/invites/${b.dataset.cancel}`, { method: 'DELETE' })); }
      catch (err) { $('#modal-error').textContent = err.message; }
    }));
  };
  api(`/api/servers/${s.id}/invites`).then(showList).catch(() => {});
  $('#inv-make').onclick = async () => {
    const expiresIn = Number($('#inv-expires').value) || null;
    const maxUses = Number($('#inv-uses').value) || null;
    try {
      const { code, invites } = await api(`/api/servers/${s.id}/invites`, { method: 'POST', body: { expiresIn, maxUses } });
      $('#inv-new').innerHTML = `<div class="invite-box"><input readonly value="${escapeHtml(inviteLink(code))}" /><button class="btn" id="inv-copy">Copy</button></div>`;
      copyButton($('#inv-copy'), inviteLink(code));
      $('#inv-copy').click();
      showList(invites);
    } catch (err) { $('#modal-error').textContent = err.message; }
  };
}

/** A small card for what an invite opens: picture, name, blurb and how many are in it. */
function inviteCardHtml(p) {
  return `${p.banner ? `<div class="invite-banner"><img src="${escapeHtml(state.serverUrl + p.banner)}" alt="" /></div>` : ''}
    <div class="invite-body">
      <span class="invite-tile"></span>
      <div><div class="muted small">You're invited to</div><b>${escapeHtml(p.name)}</b>
      <div class="muted small">${p.members} member${p.members === 1 ? '' : 's'} · ${p.online} around</div></div>
    </div>
    ${p.description ? `<p class="small">${escapeHtml(p.description)}</p>` : ''}`;
}
function fillInviteTile(el, p) {
  const tile = el.querySelector('.invite-tile');
  if (tile) tile.replaceWith(burrowTile({ name: p.name, icon: p.icon }));
}
async function invitePreview(code) {
  const res = await fetch(`${state.serverUrl}/api/invites/${encodeURIComponent(code)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "That invite doesn't work");
  return data;
}
const inviteCodeFrom = (text) => String(text ?? '').trim().split('/').pop();

// Opening an invite link on the web shows the burrow first. Logged out, it sits above the login form.
// (The server sends /invite/<code> links here as /?invite=<code>.)
const linkInvite = new URLSearchParams(location.search).get('invite')?.match(/^[\w-]{1,32}$/)?.[0] ?? null;
if (linkInvite) {
  state.pendingInvite = linkInvite;
  history.replaceState(null, '', '/');
}
async function showAuthInvite() {
  const card = $('#invite-card');
  if (!state.pendingInvite || !state.serverUrl) return card.classList.add('hidden');
  try {
    const p = await invitePreview(state.pendingInvite);
    card.innerHTML = inviteCardHtml(p) + '<p class="muted small">Log in or make an account to join.</p>';
    fillInviteTile(card, p);
  } catch (err) {
    card.innerHTML = `<p class="small">${escapeHtml(err.message)}. Ask for a new link.</p>`;
    state.pendingInvite = null;
  }
  card.classList.remove('hidden');
}
async function openPendingInvite() {
  const code = state.pendingInvite;
  if (!code) return;
  state.pendingInvite = null;
  modal('<h2>Invite</h2><p class="muted">Looking it up…</p>');
  let p;
  try { p = await invitePreview(code); }
  catch (err) {
    return modal(`<h2>That invite doesn't work</h2><p class="muted">${escapeHtml(err.message)}. Ask whoever sent it for a new one.</p>
      <div class="modal-row"><button class="btn secondary" data-close>Close</button></div>`);
  }
  modal(`<div class="invite-card">${inviteCardHtml(p)}</div>
    <div class="error" id="modal-error"></div>
    <div class="modal-row"><button class="btn secondary" data-close>Not now</button><button class="btn" id="invite-join">Join ${escapeHtml(p.name)}</button></div>`);
  fillInviteTile($('#modal-card'), p);
  $('#invite-join').onclick = async () => {
    try { addServer(await api('/api/join', { method: 'POST', body: { inviteCode: code } })); }
    catch (err) { $('#modal-error').textContent = err.message; }
  };
}

// ---- events

const RSVP_LABELS = { going: 'Going', maybe: 'Maybe', no: "Can't go" };
function eventWhen(t) {
  if (t <= Date.now()) return 'Happening now';
  const d = new Date(t);
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 864e5);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days < 7) return `${d.toLocaleDateString([], { weekday: 'long' })} ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`;
}
const going = (e) => e.rsvps.filter((r) => r.status === 'going').length;

function renderEvents(s) {
  const section = $('#events-section');
  section.classList.toggle('hidden', !s || isDm(s));
  if (!s || isDm(s)) return;
  const events = s.events ?? [];
  const rows = events.slice(0, 4).map((e) => {
    const li = document.createElement('li');
    li.className = 'event-row' + (e.startsAt <= Date.now() ? ' now' : '');
    li.innerHTML = `${CALENDAR_ICON}<span class="event-text"><b></b><span class="small muted"></span></span>`;
    li.querySelector('b').textContent = e.title;
    const mine = e.rsvps.find((r) => r.userId === state.me.id)?.status;
    li.querySelector('.muted').textContent = `${eventWhen(e.startsAt)} · ${going(e)} going${mine === 'going' ? ', you too' : ''}`;
    li.onclick = () => openEvent(s.id, e.id);
    return li;
  });
  if (events.length > 4) {
    const more = document.createElement('li');
    more.className = 'event-more';
    more.textContent = `${events.length - 4} more`;
    more.onclick = () => openEventList(s.id);
    rows.push(more);
  }
  if (!rows.length) {
    const hint = document.createElement('li');
    hint.className = 'hint';
    hint.textContent = 'Nothing planned. Press + to plan a game night.';
    rows.push(hint);
  }
  $('#event-list').replaceChildren(...rows);
}
$('#add-event').onclick = () => openEventEditor(state.serverId, null);

function openEventList(serverId) {
  const s = state.servers.get(serverId);
  modal(`<h2>Events in ${escapeHtml(s.name)}</h2>
    <ul class="event-list big">${s.events.map((e) => `<li class="event-row" data-ev="${e.id}">${CALENDAR_ICON}<span class="event-text"><b>${escapeHtml(e.title)}</b><span class="small muted">${escapeHtml(eventWhen(e.startsAt))} · ${going(e)} going</span></span></li>`).join('')}</ul>
    <div class="modal-row"><button class="btn secondary" data-close>Close</button><button class="btn" id="ev-new">Plan an event</button></div>`);
  $('#modal-card').querySelectorAll('[data-ev]').forEach((li) => (li.onclick = () => openEvent(serverId, Number(li.dataset.ev))));
  $('#ev-new').onclick = () => openEventEditor(serverId, null);
}

function openEvent(serverId, eventId) {
  const s = state.servers.get(serverId);
  const e = s?.events?.find((x) => x.id === eventId);
  if (!e) return modal('<h2>Event</h2><p class="muted">This event is over or was cancelled.</p><div class="modal-row"><button class="btn secondary" data-close>Close</button></div>');
  const room = e.channelId ? s.channels.find((c) => c.id === e.channelId) : null;
  const mine = e.rsvps.find((r) => r.userId === state.me.id)?.status ?? null;
  const names = (status) => e.rsvps.filter((r) => r.status === status).map((r) => nameOf(r.userId, 'someone'));
  const editable = e.createdBy === state.me.id || can(s, 'burrow');
  modal(`<h2>${escapeHtml(e.title)}</h2>
    <p class="event-when">${CALENDAR_ICON}<span>${escapeHtml(new Date(e.startsAt).toLocaleString([], { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}${e.startsAt <= Date.now() ? ' · happening now' : ''}</span></p>
    ${room ? `<p class="small">Where: <button type="button" class="link-btn" id="ev-room">${room.kind === 'voice' ? escapeHtml(room.name) : '#' + escapeHtml(room.name)}</button></p>` : ''}
    ${e.details ? `<div class="event-details">${formatContent(e.details)}</div>` : ''}
    <p class="small muted">Planned by ${escapeHtml(nameOf(e.createdBy, 'someone'))}</p>
    <div class="rsvp-row">${Object.entries(RSVP_LABELS).map(([k, l]) => `<button class="btn ${mine === k ? '' : 'secondary'}" data-rsvp="${k}" aria-pressed="${mine === k}">${l}${k !== 'no' ? ` · ${names(k).length}` : ''}</button>`).join('')}</div>
    ${names('going').length ? `<p class="small"><b>Going:</b> ${names('going').map(escapeHtml).join(', ')}</p>` : ''}
    ${names('maybe').length ? `<p class="small"><b>Maybe:</b> ${names('maybe').map(escapeHtml).join(', ')}</p>` : ''}
    <p class="small muted">People going or maybe going get a reminder 15 minutes before.</p>
    <div class="error" id="modal-error"></div>
    <div class="modal-row">
      ${editable ? '<button class="btn danger" id="ev-delete">Cancel event</button><button class="btn secondary" id="ev-edit">Edit</button>' : ''}
      <span class="spacer"></span><button class="btn secondary" data-close>Close</button>
    </div>`);
  const card = $('#modal-card');
  card.querySelectorAll('[data-rsvp]').forEach((b) => (b.onclick = async () => {
    try {
      handleEvent({ type: 'server_updated', server: await api(`/api/events/${e.id}/rsvp`, { method: 'POST', body: { status: mine === b.dataset.rsvp ? null : b.dataset.rsvp } }) });
      openEvent(serverId, eventId);
    } catch (err) { $('#modal-error').textContent = err.message; }
  }));
  $('#ev-room')?.addEventListener('click', () => {
    closeModal();
    if (room.kind === 'voice') joinVoice(room.id);
    else { selectChannel(room.id); showView('chat'); }
  });
  $('#ev-edit')?.addEventListener('click', () => openEventEditor(serverId, e));
  $('#ev-delete')?.addEventListener('click', async () => {
    if (!confirm(`Cancel ${e.title}?`)) return;
    try { handleEvent({ type: 'server_updated', server: await api(`/api/events/${e.id}`, { method: 'DELETE' }) }); closeModal(); }
    catch (err) { $('#modal-error').textContent = err.message; }
  });
}

function openEventEditor(serverId, e) {
  const s = state.servers.get(serverId);
  if (!s) return;
  const rooms = s.channels.filter((c) => !c.archived);
  const start = e?.startsAt ?? (() => { const d = new Date(Date.now() + 864e5); d.setHours(20, 0, 0, 0); return d.getTime(); })();
  modal(`<h2>${e ? 'Edit event' : 'Plan an event'}</h2>
    <form id="event-form">
      <label>What<input id="ev-title" maxlength="100" required placeholder="e.g. Game night" value="${escapeHtml(e?.title ?? '')}" /></label>
      <label>When<input type="datetime-local" id="ev-when" required value="${localInputValue(start)}" min="${localInputValue(Date.now())}" /></label>
      <label>Where<select id="ev-room"><option value="">Nowhere in particular</option>${rooms.map((c) => `<option value="${c.id}" ${c.id === e?.channelId ? 'selected' : ''}>${c.kind === 'voice' ? escapeHtml(c.name) + ' (voice)' : '#' + escapeHtml(c.name)}</option>`).join('')}</select></label>
      <label>Details<textarea id="ev-details" maxlength="1000" rows="3" placeholder="Anything people should know">${escapeHtml(e?.details ?? '')}</textarea></label>
      <div class="error" id="modal-error"></div>
      <div class="modal-row"><button type="button" class="btn secondary" data-close>Cancel</button><button type="submit" class="btn">${e ? 'Save' : 'Plan it'}</button></div>
    </form>`);
  $('#event-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const body = {
      title: $('#ev-title').value,
      startsAt: new Date($('#ev-when').value).getTime(),
      channelId: $('#ev-room').value ? Number($('#ev-room').value) : null,
      details: $('#ev-details').value,
    };
    try {
      const updated = await api(e ? `/api/events/${e.id}` : `/api/servers/${serverId}/events`, { method: e ? 'PATCH' : 'POST', body });
      handleEvent({ type: 'server_updated', server: updated });
      const saved = e ?? updated.events.filter((x) => x.title === body.title.trim()).sort((a, b) => b.id - a.id)[0];
      saved ? openEvent(serverId, saved.id) : closeModal();
    } catch (err) { $('#modal-error').textContent = err.message; }
  };
}

function showEventReminder(ev) {
  const s = state.servers.get(ev.serverId);
  const e = ev.event;
  const text = `${e.title} starts ${e.startsAt <= Date.now() ? 'now' : `at ${new Date(e.startsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`}${s ? ` in ${s.name}` : ''}.`;
  const open = () => { if (s) { selectServer(s.id); openEvent(s.id, e.id); } };
  toast(text, { action: 'Open', onAction: open, timeout: 0 });
  playSound('message');
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
    const n = new Notification(e.title, { body: text });
    n.onclick = () => { window.focus(); open(); };
  }
}

// ---- group conversations

/** What a conversation is called: the other person, or a group's name (or its people). */
function dmTitle(s) {
  if (!s.group) return partner(s).username;
  if (s.name) return s.name;
  const names = s.members.filter((m) => m.id !== state.me.id).map((m) => m.username);
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ') || 'Just you';
}
function groupAvatar(cls = 'xs') {
  const av = document.createElement('span');
  av.className = `avatar ${cls} group-avatar`;
  av.innerHTML = PEOPLE_ICON;
  return av;
}

/** People you can message: everyone who shares a burrow with you. */
function messageablePeople() {
  const people = new Map();
  for (const id of state.serverOrder)
    for (const m of state.servers.get(id).members) if (m.id !== state.me.id) people.set(m.id, m);
  return [...people.values()].sort((a, b) => a.username.localeCompare(b.username));
}

/** A list of people to tick. `done(ids)` gets the ticked ones. */
function peoplePicker({ title, intro = '', list, button, onDone, extra = '', wire }) {
  modal(`<h2>${escapeHtml(title)}</h2>
    ${intro ? `<p class="muted small">${escapeHtml(intro)}</p>` : ''}
    ${list.length ? '<input id="dm-filter" placeholder="Find someone" />' : '<p class="muted">Join a burrow first. You can message anyone who shares one with you.</p>'}
    <ul class="people-picker" id="dm-people"></ul>
    ${extra}
    <div class="error" id="modal-error"></div>
    <div class="modal-row"><button class="btn secondary" data-close>Close</button><button class="btn" id="people-go" disabled>${escapeHtml(button(0))}</button></div>`);
  const picked = new Set();
  const update = () => {
    $('#people-go').disabled = !picked.size;
    $('#people-go').textContent = button(picked.size);
    wire?.(picked);
  };
  const render = (q = '') => {
    $('#dm-people').replaceChildren(
      ...list.filter((m) => m.username.toLowerCase().includes(q.toLowerCase())).map((m) => {
        const li = document.createElement('li');
        li.classList.toggle('picked', picked.has(m.id));
        li.setAttribute('role', 'checkbox');
        li.setAttribute('aria-checked', String(picked.has(m.id)));
        li.tabIndex = 0;
        const av = document.createElement('span');
        av.className = 'avatar';
        setAvatar(av, m.username, avatarOf(m.id, m.avatar));
        const name = document.createElement('span');
        name.textContent = m.username;
        const tick = document.createElement('span');
        tick.className = 'pick-tick';
        li.append(av, name, tick);
        li.onclick = () => {
          picked.has(m.id) ? picked.delete(m.id) : picked.add(m.id);
          li.classList.toggle('picked', picked.has(m.id));
          li.setAttribute('aria-checked', String(picked.has(m.id)));
          update();
        };
        li.onkeydown = (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); li.click(); } };
        return li;
      }),
    );
  };
  render();
  update();
  $('#dm-filter')?.addEventListener('input', (e) => render(e.target.value));
  $('#people-go').onclick = async () => {
    try { await onDone([...picked]); } catch (err) { $('#modal-error').textContent = err.message; }
  };
}

function openGroupSettings(s) {
  const others = s.members.filter((m) => m.id !== state.me.id);
  modal(`<h2>${escapeHtml(dmTitle(s))}</h2>
    <form id="group-form">
      <label>Name<input id="group-name" maxlength="64" placeholder="${escapeHtml(others.map((m) => m.username).join(', '))}" value="${escapeHtml(s.name ?? '')}" /></label>
      <div class="error" id="modal-error"></div>
      <div class="modal-row"><button type="submit" class="btn secondary">Rename</button></div>
    </form>
    <h3>People · ${s.members.length}</h3>
    <ul class="group-people">${s.members.map((m) => `<li data-avatar="${m.id}"><span class="avatar xs"></span>${escapeHtml(m.username)}${m.id === state.me.id ? ' <span class="muted small">(you)</span>' : ''}</li>`).join('')}</ul>
    <div class="modal-row">
      <button class="btn danger" id="group-leave">Leave conversation</button>
      <span class="spacer"></span>
      <button class="btn secondary" id="group-add">Add people</button>
      <button class="btn secondary" data-close>Close</button>
    </div>`);
  $('#modal-card').querySelectorAll('[data-avatar]').forEach((li) => {
    const m = s.members.find((x) => x.id === Number(li.dataset.avatar));
    setAvatar(li.querySelector('.avatar'), m.username, avatarOf(m.id, m.avatar));
  });
  $('#group-form').onsubmit = async (e) => {
    e.preventDefault();
    try { handleEvent({ type: 'server_updated', server: await api(`/api/servers/${s.id}`, { method: 'PATCH', body: { name: $('#group-name').value } }) }); closeModal(); }
    catch (err) { $('#modal-error').textContent = err.message; }
  };
  $('#group-add').onclick = () => peoplePicker({
    title: `Add people to ${dmTitle(s)}`,
    intro: 'They can read everything already said here.',
    list: messageablePeople().filter((m) => !s.members.some((x) => x.id === m.id)),
    button: (n) => (n ? `Add ${n}` : 'Add'),
    onDone: async (ids) => {
      handleEvent({ type: 'server_updated', server: await api(`/api/dms/${s.id}/members`, { method: 'POST', body: { userIds: ids } }) });
      openGroupSettings(state.servers.get(s.id));
    },
  });
  $('#group-leave').onclick = async () => {
    if (!confirm(`Leave ${dmTitle(s)}? You won't see it any more.`)) return;
    try {
      await api(`/api/servers/${s.id}/leave`, { method: 'POST' });
      closeModal();
      handleEvent({ type: 'server_deleted', serverId: s.id });
    } catch (err) { alertError(err); }
  };
}

// ---- folders of burrows, in the burrow list

async function saveFolders(next) {
  const before = state.folders;
  state.folders = next;
  renderSwitcher();
  try { state.folders = (await api('/api/me/folders', { method: 'POST', body: { folders: next } })).folders; }
  catch (err) { state.folders = before; alertError(err); }
  renderSwitcher();
}
const folderOf = (id) => state.folders.find((f) => f.serverIds.includes(id));

function openFolderMenu(anchor, serverId) {
  const current = folderOf(serverId);
  const without = state.folders.map((f) => ({ ...f, serverIds: f.serverIds.filter((x) => x !== serverId) }));
  openMenu(anchor, [
    ...state.folders.filter((f) => f !== current).map((f) => ({
      label: `Move to ${f.name}`,
      run: () => saveFolders(without.map((x) => (x.id === f.id ? { ...x, serverIds: [...x.serverIds, serverId] } : x))),
    })),
    current && { label: `Take out of ${current.name}`, run: () => saveFolders(without) },
    { label: 'New folder…', run: () => openFolderName(null, (name) => saveFolders([...without, { id: `f${Date.now().toString(36)}`, name, serverIds: [serverId] }])) },
  ]);
}

function openFolderName(folder, done) {
  modal(`<h2>${folder ? 'Rename folder' : 'New folder'}</h2>
    <form id="folder-form"><label>Folder name<input id="folder-name" maxlength="32" required value="${escapeHtml(folder?.name ?? '')}" placeholder="e.g. Gaming" /></label>
      <p class="muted small">Only you see your folders.</p>
      <div class="modal-row"><button type="button" class="btn secondary" data-close>Cancel</button><button type="submit" class="btn">${folder ? 'Save' : 'Make folder'}</button></div></form>`);
  $('#folder-form').onsubmit = (e) => { e.preventDefault(); closeModal(); done($('#folder-name').value.trim()); };
}

function folderHeading(f) {
  const h = document.createElement('div');
  h.className = 'switch-head folder-head';
  const folded = store.get(`folder:${f.id}`) === '1';
  const toggle = document.createElement('button');
  toggle.className = 'folder-toggle' + (folded ? ' folded' : '');
  toggle.innerHTML = `${CHEVRON_ICON}${FOLDER_ICON}<span></span>`;
  toggle.querySelector('span').textContent = `${f.name} · ${f.serverIds.length}`;
  toggle.setAttribute('aria-expanded', String(!folded));
  if (folded && f.serverIds.some((id) => serverUnread(state.servers.get(id)))) toggle.classList.add('unread');
  toggle.onclick = () => { store.set(`folder:${f.id}`, folded ? null : '1'); renderSwitcher(); };
  const more = document.createElement('button');
  more.className = 'icon-btn folder-more';
  more.innerHTML = MORE_ICON;
  more.title = `${f.name} folder`;
  more.onclick = () => openMenu(more, [
    { label: 'Rename folder', run: () => openFolderName(f, (name) => saveFolders(state.folders.map((x) => (x.id === f.id ? { ...x, name } : x)))) },
    { label: 'Delete folder', danger: true, run: () => saveFolders(state.folders.filter((x) => x.id !== f.id)) },
  ]);
  h.append(toggle, more);
  return { el: h, folded };
}

// ---------------------------------------------------------------- helpers

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

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
  if (view === 'chat') markReadSoon();
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
$('#saved-btn').onclick = () => openSaved();
$('#scheduled-btn').onclick = () => openScheduledList();
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
  if (state.stageOpen && state.stageShow === 'video') { state.stageShow = 'fire'; focusKey = null; renderStage(); }
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
  $('#person-watch')?.addEventListener('click', () => { closeModal(); goToVoice(); openVideo(`${m.id}:${sharing?.screen ? 'screen' : 'camera'}`); });
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
