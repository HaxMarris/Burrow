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
  servers: new Map(),       // id -> { id, name, ownerId, inviteCode, channels, members }
  serverOrder: [],
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
  pending: [],              // files attached to the composer: { file, previewUrl, progress, attachment, error, done }
  voice: null,              // { channelId, room, muted } while in a voice room
  speaking: new Set(),      // user ids talking right now in our voice room
  mutedInVoice: new Set(),  // user ids muted in our voice room
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
  setAvatar($('#me-avatar'), state.me.username);
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  const config = await api('/api/config').catch(() => ({}));
  state.voiceEnabled = !!config.voice;
  state.maxUploadBytes = config.maxUploadBytes || 0;
  $('#attach-btn').classList.toggle('hidden', !state.maxUploadBytes);
  await loadServers();
  connect();
}

async function loadServers() {
  const list = await api('/api/servers');
  state.servers = new Map(list.map((s) => [s.id, s]));
  state.serverOrder = list.map((s) => s.id);
  if (!state.servers.has(state.serverId)) state.serverId = state.serverOrder[0] ?? null;
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
    $('#conn-status').classList.add('ok');
    $('#conn-status').textContent = 'Connected';
    // The server forgets who's in voice when we drop off, so tell it again.
    if (state.voice) ws.send(JSON.stringify({ type: 'voice_join', channelId: state.voice.channelId }));
    // Catch up on anything missed while disconnected.
    if (wasRetry) loadServers().catch(() => {});
  };
  ws.onmessage = (e) => handleEvent(JSON.parse(e.data));
  ws.onclose = () => {
    $('#conn-status').classList.remove('ok');
    $('#conn-status').textContent = 'Reconnecting…';
    if (state.ws !== ws || !state.token) return;
    const delay = Math.min(30000, 1000 * 2 ** state.wsRetry++);
    setTimeout(connect, delay);
  };
}

function handleEvent(ev) {
  switch (ev.type) {
    case 'message': {
      const m = ev.message;
      if (m.channelId === state.channelId) {
        state.messages.push(m);
        clearTyping(m.channelId, m.author);
        renderMessages({ stick: m.authorId === state.me.id });
      } else {
        state.unread.add(m.channelId);
        renderServers();
        renderChannels();
      }
      if (m.authorId !== state.me.id && (document.hidden || m.channelId !== state.channelId)) notify(m);
      break;
    }
    case 'message_updated': {
      const i = state.messages.findIndex((x) => x.id === ev.message.id);
      if (i >= 0) { state.messages[i] = ev.message; renderMessages(); }
      break;
    }
    case 'message_deleted':
      state.messages = state.messages.filter((x) => x.id !== ev.id);
      renderMessages();
      break;
    case 'server_updated': {
      const isNew = !state.servers.has(ev.server.id);
      state.servers.set(ev.server.id, ev.server);
      if (isNew) state.serverOrder.push(ev.server.id);
      renderServers();
      if (ev.server.id === state.serverId) { renderChannels(); renderMembers(); }
      break;
    }
    case 'server_deleted':
      state.servers.delete(ev.serverId);
      state.serverOrder = state.serverOrder.filter((id) => id !== ev.serverId);
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
    case 'voice_state':
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
  const mentioned = new RegExp('@' + escapeRegex(state.me.username) + '\\b', 'i').test(m.content);
  if (!mentioned && !document.hidden) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const server = [...state.servers.values()].find((s) => s.channels.some((c) => c.id === m.channelId));
  const channel = server?.channels.find((c) => c.id === m.channelId);
  const n = new Notification(`${m.author} in ${channel?.name ?? 'Burrow'}`, { body: m.content.slice(0, 200), silent: !mentioned });
  n.onclick = () => { window.focus(); if (server) selectServer(server.id).then(() => selectChannel(m.channelId)); };
}

// ---------------------------------------------------------------- servers & channels

function renderServers() {
  const tiles = state.serverOrder.map((id) => {
    const s = state.servers.get(id);
    const b = document.createElement('button');
    b.className = 'tile' + (id === state.serverId ? ' active' : '');
    if (id !== state.serverId && s.channels.some((c) => state.unread.has(c.id))) b.classList.add('unread');
    b.title = s.name;
    b.textContent = initials(s.name);
    b.style.background = colorFor(s.name);
    b.onclick = () => selectServer(id);
    return b;
  });
  const add = document.createElement('button');
  add.className = 'tile add';
  add.title = 'Create or join a burrow';
  add.textContent = '+';
  add.onclick = openAddServer;
  $('#server-list').replaceChildren(...tiles, add);
  $('#empty-state').classList.toggle('hidden', state.serverOrder.length > 0);
}

async function selectServer(id, initial = false) {
  state.serverId = id;
  store.set('lastServer', id);
  renderServers();
  const s = state.servers.get(id);
  $('#server-name').textContent = s?.name ?? 'No burrow yet';
  $('#server-menu-btn').classList.toggle('hidden', !s);
  $('#add-channel').classList.toggle('hidden', !s || s.ownerId !== state.me.id);
  renderMembers();
  if (!s) { state.channelId = null; renderChannels(); state.messages = []; renderMessages(); return; }
  const remembered = state.lastChannel[id];
  const textRooms = s.channels.filter((c) => c.kind !== 'voice');
  const ch = textRooms.find((c) => c.id === remembered) ?? textRooms[0];
  if (initial && ch && ch.id === state.channelId) return renderChannels();
  await selectChannel(ch?.id ?? null);
}

function renderChannels() {
  const s = state.servers.get(state.serverId);
  const channels = s?.channels ?? [];
  const textRooms = channels.filter((c) => c.kind !== 'voice').map((c) => {
    const li = document.createElement('li');
    li.textContent = c.name;
    if (c.id === state.channelId) li.className = 'active';
    else if (state.unread.has(c.id)) li.className = 'unread';
    li.onclick = () => selectChannel(c.id);
    return li;
  });
  const voiceRooms = channels.filter((c) => c.kind === 'voice').map((c) => {
    const li = document.createElement('li');
    li.className = 'voice-room' + (state.voice?.channelId === c.id ? ' joined' : '');
    li.innerHTML = `<div class="voice-room-name">${SPEAKER_ICON}<span>${escapeHtml(c.name)}</span></div>`;
    li.title = state.voice?.channelId === c.id ? "You're here" : 'Join voice';
    li.onclick = () => joinVoice(c.id);
    const people = (c.voiceUsers ?? []).map((id) => {
      const name = s.members.find((m) => m.id === id)?.username ?? '?';
      const row = document.createElement('div');
      row.className = 'voice-person' + (state.speaking.has(id) ? ' speaking' : '');
      const av = document.createElement('span');
      av.className = 'avatar xs';
      setAvatar(av, name);
      const label = document.createElement('span');
      label.textContent = name;
      row.append(av, label);
      if (state.mutedInVoice.has(id)) row.insertAdjacentHTML('beforeend', MUTED_ICON);
      return row;
    });
    if (people.length) {
      const list = document.createElement('div');
      list.className = 'voice-people';
      list.append(...people);
      li.append(list);
    }
    return li;
  });
  $('#channel-list').replaceChildren(...textRooms);
  $('#voice-list').replaceChildren(...voiceRooms);
  $('#voice-section').classList.toggle('hidden', !voiceRooms.length && !(state.voiceEnabled && s?.ownerId === state.me?.id));
}

async function selectChannel(id) {
  // Files upload into a specific room, so switching rooms drops any not yet sent.
  if (id !== state.channelId && state.pending.length) {
    state.pending.forEach((p) => { p.xhr?.abort(); if (p.previewUrl) URL.revokeObjectURL(p.previewUrl); });
    state.pending = [];
    renderPending();
  }
  state.channelId = id;
  state.unread.delete(id);
  state.lastChannel[state.serverId] = id;
  store.set('lastChannel', JSON.stringify(state.lastChannel));
  renderChannels();
  renderServers();
  const ch = state.servers.get(state.serverId)?.channels.find((c) => c.id === id);
  $('#channel-name').textContent = ch?.name ?? '';
  renderChannelSub();
  $('#composer-input').placeholder = ch ? `Say something in ${ch.name}` : '';
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
  const members = [...(s?.members ?? [])].sort((a, b) => a.username.localeCompare(b.username));
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
        setAvatar(av, m.username);
        const name = document.createElement('span');
        name.textContent = m.username;
        li.append(av, name);
        if (m.id === s.ownerId) {
          const badge = document.createElement('span');
          badge.className = 'owner-badge';
          badge.title = 'Created this burrow';
          badge.textContent = 'host';
          li.append(badge);
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
  const here = s.members.filter((m) => m.online).length;
  $('#channel-sub').textContent = `${s.name} · ${here} of ${s.members.length} around`;
}

// ---------------------------------------------------------------- messages

const messagesEl = $('#messages');
const GROUP_WINDOW = 7 * 60 * 1000;

function renderMessages({ stick = false } = {}) {
  const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
  const frag = document.createDocumentFragment();
  const ch = state.servers.get(state.serverId)?.channels.find((c) => c.id === state.channelId);
  if (ch && state.reachedStart) {
    const start = document.createElement('div');
    start.className = 'history-start';
    start.innerHTML = `<h2>This is the beginning of ${escapeHtml(ch.name)}</h2><div class="muted">Pull up a stump and say hello.</div>`;
    frag.append(start);
  }
  let prev = null;
  let body = null; // the current author group's message column
  for (const m of state.messages) {
    const day = new Date(m.createdAt).toDateString();
    if (!prev || new Date(prev.createdAt).toDateString() !== day) {
      const d = document.createElement('div');
      d.className = 'day-divider';
      const label = document.createElement('span');
      label.textContent = new Date(m.createdAt).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
      d.append(label);
      frag.append(d);
      prev = null;
    }
    const grouped = prev && prev.authorId === m.authorId && m.createdAt - prev.createdAt < GROUP_WINDOW;
    if (!grouped) {
      const group = document.createElement('div');
      group.className = 'group' + (m.authorId === state.me.id ? ' mine' : '');
      const av = document.createElement('span');
      av.className = 'avatar lg';
      setAvatar(av, m.author);
      body = document.createElement('div');
      const time = new Date(m.createdAt);
      body.innerHTML = `<div class="head"><span class="author">${escapeHtml(m.author)}</span>
        <span class="time" title="${escapeHtml(time.toLocaleString())}">${escapeHtml(formatTime(time))}</span></div>`;
      group.append(av, body);
      frag.append(group);
    }
    body.append(renderLine(m));
    prev = m;
  }
  messagesEl.replaceChildren(frag);
  if (stick || nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderLine(m) {
  const el = document.createElement('div');
  el.className = 'line';
  el.dataset.id = m.id;
  el.title = new Date(m.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (m.authorId !== state.me.id && new RegExp('@' + escapeRegex(state.me.username) + '\\b', 'i').test(m.content))
    el.classList.add('mentions-me');
  const content = document.createElement('div');
  content.className = 'content';
  content.innerHTML = formatContent(m.content) + (m.editedAt ? ' <span class="edited">(edited)</span>' : '');
  if (!m.content && !m.editedAt) content.classList.add('hidden');
  el.append(content);
  if (m.attachments?.length) el.append(renderAttachments(m.attachments));

  if (m.authorId === state.me.id) {
    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(iconButton('Edit', 'Edit message', () => startEdit(m, content)), iconButton('Delete', 'Delete message', () => confirmDelete(m)));
    el.append(actions);
  }
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
  if ((!content && !files.length) || !channelId) return;
  if (files.some((p) => p.error)) return alert('Remove the files that failed to upload first.');
  input.value = '';
  autosize();
  state.pending = [];
  renderPending();
  try {
    const attachmentIds = (await Promise.all(files.map((p) => p.done))).map((a) => a.id);
    files.forEach((p) => p.previewUrl && URL.revokeObjectURL(p.previewUrl));
    if (state.ws?.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'send', channelId, content, attachmentIds }));
    } else {
      await api(`/api/channels/${channelId}/messages`, { method: 'POST', body: { content, attachmentIds } });
    }
  } catch (err) {
    // Put everything back so nothing is lost.
    if (!input.value) input.value = content;
    state.pending = files.concat(state.pending);
    renderPending();
    alertError(err);
  }
  lastTypingSent = 0;
  input.focus();
}

$('#composer').addEventListener('submit', (e) => { e.preventDefault(); sendComposer(); });

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
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

function modal(html) {
  $('#modal-card').className = 'modal-card';
  $('#modal-card').innerHTML = html;
  $('#modal').classList.remove('hidden');
  $('#modal-card').querySelectorAll('[data-close]').forEach((b) => (b.onclick = closeModal));
  $('#modal-card').querySelector('input')?.focus();
}
function closeModal() { $('#modal').classList.add('hidden'); }
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

function openAddServer() {
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
  if (!state.servers.has(s.id)) state.serverOrder.push(s.id);
  state.servers.set(s.id, s);
  closeModal();
  selectServer(s.id);
}

$('#empty-add').onclick = openAddServer;

$('#server-menu-btn').onclick = () => {
  const s = state.servers.get(state.serverId);
  if (!s) return;
  const owner = s.ownerId === state.me.id;
  modal(`<h2>${escapeHtml(s.name)}</h2>
    <label>Invite code: share it with friends
      <div class="invite-box"><input id="invite" readonly value="${escapeHtml(s.inviteCode)}" /><button class="btn" id="copy-invite">Copy</button></div>
    </label>
    <p class="small muted">They'll also need the server address: <b>${escapeHtml(state.serverUrl)}</b></p>
    <div class="modal-row">
      <button class="btn danger" id="leave-server">${owner ? 'Delete burrow' : 'Leave burrow'}</button>
      <button class="btn secondary" data-close>Close</button>
    </div>`);
  $('#copy-invite').onclick = () => { navigator.clipboard?.writeText(s.inviteCode); $('#copy-invite').textContent = 'Copied!'; };
  $('#leave-server').onclick = async () => {
    if (owner && !confirm(`Delete "${s.name}" and all its messages for everyone?`)) return;
    try {
      await api(`/api/servers/${s.id}/leave`, { method: 'POST' });
      closeModal();
      state.servers.delete(s.id);
      state.serverOrder = state.serverOrder.filter((id) => id !== s.id);
      selectServer(state.serverOrder[0] ?? null);
    } catch (err) { alertError(err); }
  };
};

$('#add-channel').onclick = () => {
  modal(`<h2>New room</h2>
    <form id="channel-form">
      <label>Room name<input id="new-channel-name" placeholder="e.g. game-night" maxlength="32" required /></label>
      ${state.voiceEnabled ? `<div class="kind-choice">
        <label><input type="radio" name="kind" value="text" checked /> Text room</label>
        <label><input type="radio" name="kind" value="voice" /> Voice room</label>
      </div>` : ''}
      <div class="error" id="modal-error"></div>
      <div class="modal-row"><button type="button" class="btn secondary" data-close>Cancel</button><button type="submit" class="btn">Create room</button></div>
    </form>`);
  $('#channel-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const kind = $('input[name="kind"]:checked')?.value ?? 'text';
      const s = await api(`/api/servers/${state.serverId}/channels`, { method: 'POST', body: { name: $('#new-channel-name').value, kind } });
      state.servers.set(s.id, s);
      closeModal();
      if (kind === 'voice') renderChannels();
      else selectChannel(s.channels[s.channels.length - 1].id);
    } catch (err) { $('#modal-error').textContent = err.message; }
  };
};

// ---------------------------------------------------------------- attachments

const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp|avif)$/;

function addFiles(fileList) {
  if (!state.maxUploadBytes || !state.channelId) return;
  for (const file of fileList) {
    if (state.pending.length >= 10) { alert('You can attach up to 10 files at a time.'); break; }
    if (file.size > state.maxUploadBytes) {
      alert(`"${file.name}" is too big. Files can be at most ${formatSize(state.maxUploadBytes)}.`);
      continue;
    }
    const p = { file, previewUrl: IMAGE_TYPES.test(file.type) ? URL.createObjectURL(file) : null, progress: 0, error: null };
    p.done = uploadFile(state.channelId, p);
    p.done.catch(() => {}); // failures show on the chip
    state.pending.push(p);
  }
  renderPending();
  input.focus();
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
  leaveVoice();
  const voice = { channelId, room: null, muted: false };
  state.voice = voice;
  renderVoiceBar('Connecting…');
  try {
    const LK = await loadLivekit();
    const { url, token } = await api(`/api/channels/${channelId}/voice`, { method: 'POST' });
    if (state.voice !== voice) return;
    const room = new LK.Room({
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    voice.room = room;
    room
      .on(LK.RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === 'audio') $('#voice-audio').append(track.attach());
      })
      .on(LK.RoomEvent.TrackUnsubscribed, (track) => track.detach().forEach((el) => el.remove()))
      .on(LK.RoomEvent.ActiveSpeakersChanged, (speakers) => {
        state.speaking = new Set(speakers.map((p) => Number(p.identity)));
        renderChannels();
      })
      .on(LK.RoomEvent.TrackMuted, (pub, p) => setMuted(p, true))
      .on(LK.RoomEvent.TrackUnmuted, (pub, p) => setMuted(p, false))
      .on(LK.RoomEvent.Reconnecting, () => renderVoiceBar('Reconnecting…'))
      .on(LK.RoomEvent.Reconnected, () => renderVoiceBar())
      .on(LK.RoomEvent.Disconnected, () => { if (state.voice === voice) leaveVoice(); });
    await room.connect(url || state.serverUrl.replace(/^http/, 'ws'), token);
    await room.startAudio();
    await room.localParticipant.setMicrophoneEnabled(true);
    if (state.voice !== voice) return room.disconnect();
    state.ws?.send(JSON.stringify({ type: 'voice_join', channelId }));
    renderVoiceBar();
  } catch (err) {
    if (state.voice === voice) leaveVoice();
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

function leaveVoice() {
  const voice = state.voice;
  if (!voice) return;
  state.voice = null;
  state.speaking.clear();
  state.mutedInVoice.clear();
  voice.room?.disconnect();
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
  if (!voice) return;
  const ch = [...state.servers.values()].flatMap((s) => s.channels).find((c) => c.id === voice.channelId);
  $('#voice-status').textContent = status ?? 'Voice connected';
  $('#voice-status').classList.toggle('ok', !status);
  $('#voice-room-name').textContent = ch?.name ?? '';
  $('#voice-mute').classList.toggle('on', voice.muted);
  $('#voice-mute').title = voice.muted ? 'Unmute' : 'Mute';
}

$('#voice-mute').onclick = toggleMute;
$('#voice-leave').onclick = leaveVoice;

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

function setAvatar(el, username) {
  el.style.background = colorFor(username);
  el.textContent = username[0].toUpperCase();
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
$('#theme-toggle').onclick = () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  store.set('theme', next);
};

const memberPane = $('#member-pane');
if (store.get('membersHidden') === '1') memberPane.classList.add('collapsed');
$('#members-toggle').onclick = () => {
  if (matchMedia('(max-width: 980px)').matches) return memberPane.classList.toggle('open');
  const hidden = memberPane.classList.toggle('collapsed');
  store.set('membersHidden', hidden ? '1' : null);
};

// ---------------------------------------------------------------- start

if (state.token && state.serverUrl) resolveServerUrl().then(enterApp).catch(() => showAuth());
else showAuth();
