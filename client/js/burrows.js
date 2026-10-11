// Burrows and their rooms: the switcher, the room list and the people in it.
// Part of Burrow's client: plain scripts that index.html loads in order, sharing one global scope.
'use strict';

// ---------------------------------------------------------------- servers & channels

// The top bar: a named pill per burrow, with the ones that don't fit in a "more" list.
// Phones get one button with the current burrow's name instead, which opens the full list.
function renderServers() {
  updateBadge();
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
    // Who's talking: straight from the voice server at your own fire, or as the burrow hears it at others.
    const talking = (id) => (joined ? state.speaking.has(id) : !!c.voiceSpeaking?.includes(id));
    const seats = c.userLimit ? ` of ${c.userLimit} seats` : ' gathered';
    const sub = !ids.length ? (c.userLimit ? `${c.userLimit} seats, all open` : 'Nobody here yet')
      : `${ids.length}${seats}` + (streamer ? ` · ${nameOf(streamer)} is sharing` : '');
    if (ids.some((id) => talking(id) && !c.voiceMuted?.includes(id))) li.classList.add('talking');
    li.innerHTML = i === 0
      ? `<div class="voice-room-name"><span class="fire-badge">${FIRE_ICON}</span><span class="fire-text"><span class="room-name">${escapeHtml(c.name)}</span><span class="fire-sub">${escapeHtml(sub)}</span></span>${c.private ? LOCK_ICON : ''}</div>`
      : `<div class="voice-room-name">${FIRE_ICON.replace('<svg', '<svg class="voice-icon"')}<span class="room-name">${escapeHtml(c.name)}</span>${c.userLimit ? `<span class="seat-count">${ids.length}/${c.userLimit}</span>` : ''}${c.private ? LOCK_ICON : ''}</div>`;
    if (can(s, 'rooms')) li.firstChild.append(roomSettingsButton(c));
    li.title = joined ? 'Open the fire' : 'Join voice';
    li.onclick = () => (joined ? goToVoice() : joinVoice(c.id));
    const people = ids.map((id) => {
      const name = nameOfPerson(s.members.find((m) => m.id === id)) ?? '?';
      const row = document.createElement('div');
      row.className = 'voice-person' + (talking(id) ? ' speaking' : '');
      const av = document.createElement('span');
      av.className = 'avatar xs';
      setAvatar(av, name, avatarOf(id));
      const label = document.createElement('span');
      label.textContent = name;
      row.append(av, label);
      // Deafened says more than muted, so it's the one shown.
      if (c.voiceServerMuted?.includes(id)) row.insertAdjacentHTML('beforeend', SERVER_MUTED_ICON);
      else if (c.voiceDeafened?.includes(id)) row.insertAdjacentHTML('beforeend', DEAFENED_ICON);
      else if (state.mutedInVoice.has(id) || c.voiceMuted?.includes(id)) row.insertAdjacentHTML('beforeend', MUTED_ICON);
      const sharing = joined ? state.sharing.get(id) : null;
      if (sharing?.camera) row.insertAdjacentHTML('beforeend', `<span class="cam-tag" title="Camera on">${CAMERA_ICON}</span>`);
      if (sharing?.screen) {
        row.insertAdjacentHTML('beforeend', '<span class="live-tag">LIVE</span>');
        attachPeek(row.lastChild, id);
      }
      if (id !== state.me.id) {
        const v = volumeFor(id);
        if (v !== 1) row.insertAdjacentHTML('beforeend', `<span class="volume-tag">${Math.round(v * 100)}%</span>`);
        row.classList.add('adjustable');
        row.title = `${name}'s volume`;
        row.onclick = (e) => { e.stopPropagation(); openVolume(row, id, name, s, c); };
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
      state.pending.forEach((p) => { p.xhr?.abort(); p.cancelShrink?.(); if (p.previewUrl) URL.revokeObjectURL(p.previewUrl); });
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
    // No connection: what this device saved of the room, if anything.
    msgs = err instanceof TypeError ? cachedRoom(id) : null;
    if (state.channelId !== id) return;
    if (!msgs && err instanceof TypeError) return renderMessages();
    if (!msgs) return alertError(err);
  }
  if (parentLoad) await parentLoad.catch(() => {});
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
  const members = [...(s?.members ?? [])].sort((a, b) => rankOf(s, a) - rankOf(s, b) || nameOfPerson(a).localeCompare(nameOfPerson(b)));
  const section = (title, list) => {
    if (!list.length) return [];
    const h = document.createElement('h3');
    h.textContent = `${title} · ${list.length}`;
    const ul = document.createElement('ul');
    ul.append(
      ...list.map((m) => {
        const li = document.createElement('li');
        li.className = `${m.online ? 'online' : 'offline'} status-${statusOf(m)}`;
        const av = document.createElement('span');
        av.className = 'avatar-wrap';
        av.innerHTML = `<span class="avatar"></span><span class="status-dot ${statusOf(m)}" title="${STATUS_LABELS[statusOf(m)]}"></span>`;
        setAvatar(av.firstChild, m.username, avatarOf(m.id, m.avatar));
        const text = document.createElement('span');
        text.className = 'member-text';
        const name = document.createElement('span');
        name.className = 'member-name';
        name.textContent = nameOfPerson(m);
        const color = roleColor(s, m.id);
        if (color) name.style.color = color;
        text.append(name);
        const sub = presenceLine(m);
        if (sub) {
          const line = document.createElement('span');
          line.className = 'member-sub';
          line.innerHTML = sub;
          text.append(line);
        }
        li.append(av, text);
        if (m.id !== state.me.id) {
          li.classList.add('can-dm');
          li.title = `${nameOfPerson(m)} (@${m.username}): profile, message, volume and more`;
        } else li.title = 'Your profile and nickname';
        li.classList.add('can-dm');
        li.onclick = () => openPerson(s, m);
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
          const more = iconButton('⋯', `Manage ${nameOfPerson(m)}`, (e) => { e.stopPropagation(); openMemberMenu(s, m); });
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
