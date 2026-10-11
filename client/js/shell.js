// Helpers, theme, the shell (top bar and phone screens), friends, and starting the app.
// Part of Burrow's client: plain scripts that index.html loads in order, sharing one global scope.
'use strict';

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
  const fields = { avatar: u.avatar, ...(u.username ? { username: u.username, displayName: u.displayName ?? null } : {}), ...('accent' in u ? { accent: u.accent } : {}) };
  for (const s of state.servers.values()) for (const m of s.members) if (m.id === u.id) Object.assign(m, fields);
  for (const list of Object.values(state.friends ?? {})) for (const f of list) if (f.id === u.id) Object.assign(f, fields);
  if (u.id === state.me?.id) {
    Object.assign(state.me, fields);
    $('#me-name').textContent = state.me.displayName || state.me.username;
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
for (const b of document.querySelectorAll('#me-menu [data-status]')) b.onclick = () => setMyStatus(b.dataset.status);
$('#custom-status-btn').onclick = () => openCustomStatus();
$('#inbox-menu-btn').onclick = () => openInbox();
$('#inbox-btn').onclick = () => openInbox();
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

// The top of someone's card: banner (or their colour), picture, names and about me.
// `s` is the burrow you opened it from, for their nickname and role colour there.
function profileHeader(p, s) {
  const el = document.createElement('div');
  el.className = 'profile-head';
  if (p.accent) el.style.setProperty('--card-accent', p.accent);
  const banner = document.createElement('div');
  banner.className = 'profile-banner' + (p.banner ? ' has-picture' : '');
  if (p.banner) banner.style.backgroundImage = `url("${state.serverUrl}${p.banner}")`;
  const av = document.createElement('span');
  av.className = 'avatar xl profile-avatar';
  setAvatar(av, p.username, avatarOf(p.id, p.avatar));
  const names = document.createElement('div');
  names.className = 'profile-names';
  const h = document.createElement('h2');
  h.textContent = p.deleted ? 'Deleted user' : nameOfPerson(p);
  const color = s && roleColor(s, p.id);
  if (color) h.style.color = color;
  names.append(h);
  if (!p.deleted) {
    const sub = document.createElement('span');
    sub.className = 'profile-username';
    sub.textContent = `@${p.username}${p.nickname && p.displayName && p.nickname !== p.displayName ? ` · ${p.displayName}` : ''}`;
    names.append(sub);
  }
  el.append(banner, av, names);
  if (p.bio) {
    const bio = document.createElement('p');
    bio.className = 'profile-bio';
    bio.textContent = p.bio;
    el.append(bio);
  }
  return el;
}

// Someone's card: who they are, their status, and what you can do: message them, add them as a
// friend, change how loud they are for you, block them, or manage them in this burrow.
// `s` is null when opened from your friends list.
function openPerson(s, m) {
  const me = m.id === state.me.id;
  const inVoice = s && state.voice && s.channels.some((c) => c.id === state.voice.channelId && c.voiceUsers?.includes(m.id));
  const sharing = inVoice ? state.sharing.get(m.id) : null;
  const top = s ? rolesOf(s, m)[0] : null;
  const status = sharing?.screen ? 'Sharing their screen' : inVoice ? 'By the fire with you' : m.online ? STATUS_LABELS[statusOf(m)] : 'Out in the woods';
  modal(`<div class="profile-card" id="profile-card"></div>
    <div class="person-meta">
      ${m.deleted ? '' : `<span class="person-status${sharing?.screen ? ' live' : ''}"><span class="status-dot ${statusOf(m)}"></span>${escapeHtml(status)}</span>`}
      ${presenceLine(m) ? `<span class="person-custom">${presenceLine(m, true)}</span>` : ''}
      ${isHost(s, m.id) ? '<span class="owner-badge">host</span>' : top ? `<span class="owner-badge role" style="--role:${escapeHtml(top.color)}">${escapeHtml(top.name)}</span>` : ''}
      <span class="small muted" id="profile-extra"></span>
    </div>
    ${sharing?.screen || sharing?.camera ? `<button class="btn" id="person-watch">${sharing.screen ? 'Watch stream' : 'See camera'}</button>` : ''}
    ${inVoice && !me ? `<div class="person-sliders">
      ${sharing?.screen ? `<label>Stream volume <span id="pv-stream-val"></span>
        <input type="range" id="pv-stream" min="0" max="200" step="5" value="${Math.round(streamVolumeFor(m.id) * 100)}" /></label>` : ''}
      <label>Voice volume <span id="pv-voice-val"></span>
        <input type="range" id="pv-voice" min="0" max="200" step="5" value="${Math.round(volumeFor(m.id) * 100)}" /></label>
      <span class="small muted">Only changes it for you.</span>
    </div>` : ''}
    <div class="person-actions" id="person-actions"></div>
    <div class="modal-row"><button class="btn secondary" data-close>Close</button></div>`, 'sheet profile-modal');
  const card = $('#profile-card');
  let profile = { ...m };
  const draw = () => card.replaceChildren(profileHeader(profile, s));
  draw();
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

  const actions = (friend) => {
    const box = $('#person-actions');
    if (!box) return;
    const list = [];
    const add = (label, fn, cls = '') => list.push(Object.assign(document.createElement('button'), { className: `action ${cls}`, textContent: label, onclick: fn }));
    if (me) {
      add('Edit your profile', () => openAccount('profile'));
      if (s && !isDm(s)) add(`Change nickname in ${s.name}`, () => openNickname(s));
    } else if (!m.deleted) {
      const blocked = isBlocked(m.id);
      if (!blocked && !(s && isDm(s) && !s.group)) add('Send a message', () => openDm(m.id));
      if (s && !isDm(s) && !blocked) add('Mention', () => {
        closeModal();
        memberPane.classList.remove('open');
        input.value = `${input.value}${input.value && !input.value.endsWith(' ') ? ' ' : ''}@${m.username} `;
        autosize();
        showView('chat');
        input.focus();
      });
      if (!blocked) {
        if (friend === 'friends') add('Remove friend', () => confirm(`Remove ${nameOfPerson(m)} from your friends?`) && friendAction(m.id, 'remove', redraw));
        else if (friend === 'incoming') add('Accept friend request', () => friendAction(m.id, 'accept', redraw));
        else if (friend === 'outgoing') add('Cancel friend request', () => friendAction(m.id, 'remove', redraw));
        else add('Add friend', () => friendAction(m.id, 'add', redraw));
      }
      if (s && canActOn(s, m)) add(`Manage ${nameOfPerson(m)}`, () => openMemberMenu(s, m));
      add(blocked ? 'Unblock' : 'Block', () => toggleBlock(m, redraw), 'danger-item');
    }
    box.replaceChildren(...list);
  };
  const redraw = () => actions(profile.friend ?? friendStateOf(m.id));
  actions(friendStateOf(m.id));
  // The rest of the card (about me, banner, burrows you share) comes from the server.
  api(`/api/users/${m.id}`).then((p) => {
    if (!card.isConnected) return;
    profile = { ...m, ...p, nickname: m.nickname };
    draw();
    const extra = [];
    if (p.joinedAt && !p.deleted) extra.push(`On Burrow since ${formatDay(p.joinedAt)}`);
    if (p.mutualBurrows?.length) extra.push(`Burrows you share: ${p.mutualBurrows.map((b) => b.name).join(', ')}`);
    $('#profile-extra').textContent = extra.join(' · ');
    redraw();
  }).catch(() => {});
}

// The person card for someone you only know by id (a friend, a reply, a reaction).
function openPersonById(userId) {
  const here = state.servers.get(state.serverId);
  const mem = here?.members.find((x) => x.id === userId);
  if (mem) return openPerson(here, mem);
  const f = Object.values(state.friends ?? {}).flat().find((x) => x.id === userId);
  if (f) return openPerson(null, f);
  for (const s of state.servers.values()) {
    const x = s.members.find((y) => y.id === userId);
    if (x) return openPerson(null, { ...x, nickname: null });
  }
}

function openNickname(s) {
  const mine = s.members.find((x) => x.id === state.me.id);
  modal(`<h2>Your nickname in ${escapeHtml(s.name)}</h2>
    <form id="nick-form">
      <label>Nickname<input id="nick-input" maxlength="32" placeholder="${escapeHtml(state.me.displayName || state.me.username)}" value="${escapeHtml(mine?.nickname ?? '')}" /></label>
      <span class="small muted">Only shown in this burrow. Leave it empty to use your display name.</span>
      <div class="error" id="nick-error"></div>
      <div class="modal-row"><button type="button" class="btn secondary" data-close>Cancel</button><button type="submit" class="btn">Save</button></div>
    </form>`);
  $('#nick-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const srv = await api(`/api/servers/${s.id}/nickname`, { method: 'PATCH', body: { nickname: $('#nick-input').value } });
      state.servers.set(srv.id, srv);
      closeModal();
      renderMembers();
      renderMessages();
    } catch (err) { $('#nick-error').textContent = err.message; }
  };
}

// ---------------------------------------------------------------- friends and blocking

function setFriends(f) {
  state.friends = { friends: f.friends ?? [], incoming: f.incoming ?? [], outgoing: f.outgoing ?? [], blocked: f.blocked ?? [] };
  if (state.inDms) renderChannels();
  updateFriendsBadge();
  if ($('#friends-panel')) renderFriendsPanel();
}
async function loadFriends() {
  try { setFriends(await api('/api/friends')); } catch {}
}
const friendStateOf = (id) => {
  const f = state.friends;
  if (!f) return null;
  return f.friends.some((x) => x.id === id) ? 'friends' : f.incoming.some((x) => x.id === id) ? 'incoming' : f.outgoing.some((x) => x.id === id) ? 'outgoing' : null;
};
function updateFriendsBadge() {
  const n = state.friends?.incoming.length ?? 0;
  $('#friends-row .ping-count')?.replaceChildren(n > 99 ? '99+' : String(n));
  $('#friends-row .ping-count')?.classList.toggle('hidden', !n);
}

async function friendAction(userId, what, after) {
  try {
    if (what === 'add') setFriends(await api('/api/friends', { method: 'POST', body: { userId } }));
    else if (what === 'accept') setFriends(await api(`/api/friends/${userId}/accept`, { method: 'POST' }));
    else setFriends(await api(`/api/friends/${userId}`, { method: 'DELETE' }));
    toast(what === 'add' ? (friendStateOf(userId) === 'friends' ? "You're friends now." : 'Friend request sent.') : what === 'accept' ? "You're friends now." : 'Done.');
    after?.();
  } catch (err) { alertError(err); }
}

async function toggleBlock(m, after) {
  const blocked = isBlocked(m.id);
  if (!blocked && !confirm(`Block ${nameOfPerson(m)}? Their messages are folded away, they can't message you or send you friend requests, and you're no longer friends.`)) return;
  try {
    Object.assign(state.me, blocked
      ? await api(`/api/blocks/${m.id}`, { method: 'DELETE' })
      : await api('/api/blocks', { method: 'POST', body: { userId: m.id } }));
    toast(blocked ? `${nameOfPerson(m)} is unblocked.` : `${nameOfPerson(m)} is blocked.`);
    renderMessages();
    loadFriends();
    after?.();
  } catch (err) { alertError(err); }
}

// Friends: who's online across all your burrows, requests both ways, and people you've blocked.
let friendsTab = 'online';
function openFriends(tab) {
  if (tab) friendsTab = tab;
  else if (state.friends?.incoming.length) friendsTab = 'requests';
  modal(`<div id="friends-panel" class="friends-panel">
    <h2>Friends</h2>
    <form id="add-friend" class="inline-form">
      <input id="add-friend-name" placeholder="Add a friend by their username" autocomplete="off" maxlength="40" />
      <button type="submit" class="btn">Send request</button>
    </form>
    <div class="error" id="add-friend-error"></div>
    <div class="tabs" role="tablist" id="friends-tabs"></div>
    <ul class="friend-list" id="friend-list"></ul>
  </div>
  <div class="modal-row"><button type="button" class="btn secondary" data-close>Close</button></div>`, 'sheet');
  $('#add-friend').onsubmit = async (e) => {
    e.preventDefault();
    $('#add-friend-error').textContent = '';
    const username = $('#add-friend-name').value.trim();
    if (!username) return;
    try {
      setFriends(await api('/api/friends', { method: 'POST', body: { username } }));
      $('#add-friend-name').value = '';
      toast(state.friends.friends.some((f) => f.username.toLowerCase() === username.replace(/^@/, '').toLowerCase()) ? "You're friends now." : 'Friend request sent.');
    } catch (err) { $('#add-friend-error').textContent = err.message; }
  };
  renderFriendsPanel();
  loadFriends();
}

function renderFriendsPanel() {
  const f = state.friends ?? { friends: [], incoming: [], outgoing: [], blocked: [] };
  const online = f.friends.filter((x) => x.online);
  const tabs = [['online', `Online · ${online.length}`], ['all', `All · ${f.friends.length}`], ['requests', `Requests${f.incoming.length ? ` · ${f.incoming.length}` : ''}`], ['blocked', 'Blocked']];
  $('#friends-tabs').innerHTML = tabs.map(([id, label]) => `<button type="button" role="tab" data-tab="${id}" aria-selected="${id === friendsTab}">${label}</button>`).join('');
  for (const b of $('#friends-tabs').querySelectorAll('button')) b.onclick = () => { friendsTab = b.dataset.tab; renderFriendsPanel(); };
  const sorted = (list) => [...list].sort((a, b) => !!b.online - !!a.online || nameOfPerson(a).localeCompare(nameOfPerson(b)));
  const rows = [];
  const row = (p, sub, buttons) => {
    const li = document.createElement('li');
    const av = document.createElement('span');
    av.className = 'avatar-wrap';
    av.innerHTML = `<span class="avatar"></span>${'online' in p ? `<span class="status-dot ${statusOf(p)}"></span>` : ''}`;
    setAvatar(av.firstChild, p.username, avatarOf(p.id, p.avatar));
    const text = document.createElement('button');
    text.type = 'button';
    text.className = 'friend-text';
    text.innerHTML = `<b>${escapeHtml(nameOfPerson(p))}</b><span class="small muted">${sub}</span>`;
    text.onclick = () => openPerson(null, p);
    li.append(av, text, ...buttons);
    rows.push(li);
  };
  const btn = (label, fn, cls = 'secondary') => Object.assign(document.createElement('button'), { type: 'button', className: `btn ${cls}`, textContent: label, onclick: fn });
  const heading = (text) => rows.push(Object.assign(document.createElement('li'), { className: 'friend-heading', textContent: text }));
  if (friendsTab === 'online' || friendsTab === 'all') {
    const list = sorted(friendsTab === 'online' ? online : f.friends);
    for (const p of list) row(p, presenceLine(p) || `@${escapeHtml(p.username)} · ${STATUS_LABELS[statusOf(p)]}`, [btn('Message', () => openDm(p.id))]);
    if (!list.length) rows.push(Object.assign(document.createElement('li'), { className: 'hint', textContent: friendsTab === 'online' ? 'None of your friends are online right now.' : 'No friends yet. Add someone by their username above, or from their card in a burrow.' }));
  } else if (friendsTab === 'requests') {
    if (f.incoming.length) heading('Asking to be your friend');
    for (const p of f.incoming) row(p, `@${escapeHtml(p.username)}`, [btn('Accept', () => friendAction(p.id, 'accept'), ''), btn('Decline', () => friendAction(p.id, 'remove'))]);
    if (f.outgoing.length) heading('Waiting on them');
    for (const p of f.outgoing) row(p, `@${escapeHtml(p.username)}`, [btn('Cancel', () => friendAction(p.id, 'remove'))]);
    if (!f.incoming.length && !f.outgoing.length) rows.push(Object.assign(document.createElement('li'), { className: 'hint', textContent: 'No friend requests.' }));
  } else {
    for (const p of f.blocked) row(p, `@${escapeHtml(p.username)}`, [btn('Unblock', () => toggleBlock(p))]);
    if (!f.blocked.length) rows.push(Object.assign(document.createElement('li'), { className: 'hint', textContent: "You haven't blocked anyone." }));
  }
  $('#friend-list').replaceChildren(...rows);
}

// ---------------------------------------------------------------- start

if (resetLinkToken && !isDesktop) showAuth();
else if (state.token && state.serverUrl) resolveServerUrl().then(enterApp).catch(() => showAuth());
else showAuth();
