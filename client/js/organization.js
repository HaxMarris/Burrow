// Rooms, burrows and organization: headings, events, invites, settings.
// Part of Burrow's client: plain scripts that index.html loads in order, sharing one global scope.
'use strict';

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
  if (s.timeoutUntil && s.timeoutUntil > Date.now())
    return { text: `You're timed out in ${s.name} until ${new Date(s.timeoutUntil).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}. You can still read.` };
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
      <label>Description<textarea id="burrow-desc" maxlength="300" rows="2" placeholder="What's this hearth for?">${escapeHtml(s.description ?? '')}</textarea></label>
      <label>Welcome room
        <select id="burrow-welcome"><option value="">The first room</option>${rooms.map((c) => `<option value="${c.id}" ${c.id === s.welcomeChannelId ? 'selected' : ''}>#${escapeHtml(c.name)}</option>`).join('')}</select>
        <span class="small muted">Where new people land when they first open the hearth.</span>
      </label>
      <label>Rules<textarea id="burrow-rules" maxlength="2000" rows="4" placeholder="Leave empty for no rules">${escapeHtml(s.rules ?? '')}</textarea>
        <span class="small muted">New people accept these before they can chat. Changing them asks everyone again.</span>
      </label>
      ${afkSettings(s)}
      <label>Go-live posts
        <select id="burrow-live"><option value="">Off</option>${s.channels.filter((c) => c.kind === 'text' && !c.archived).map((c) => `<option value="${c.id}" ${c.id === s.liveChannelId ? 'selected' : ''}>#${escapeHtml(c.name)}</option>`).join('')}</select>
        <span class="small muted">When someone shares their screen at a fire, a post here says they're live, with a button to join.</span>
      </label>
      ${state.maxUploadBytes ? `<label>Largest file people can share
        <span class="inline-form"><input type="number" id="burrow-upload" min="0" max="${Math.floor(state.maxUploadBytes / 1048576)}" placeholder="${Math.floor(state.maxUploadBytes / 1048576)}" value="${s.uploadMb ?? ''}" /><span class="muted">MB</span></span>
        <span class="small muted">Empty: the server's ${formatSize(state.maxUploadBytes)}. 0: no files. Roles can allow more (Roles › Edit).</span></label>` : ''}
      <label>Word filter<textarea id="burrow-words" rows="2" placeholder="Words separated by commas">${escapeHtml((s.wordFilter?.words ?? []).join(', '))}</textarea>
        <span class="small muted">Whole words, any capitals. People who can delete messages aren't filtered.</span></label>
      <label>When a message has one<select id="burrow-words-action">
        <option value="block" ${s.wordFilter?.action !== 'flag' ? 'selected' : ''}>Don't send it</option>
        <option value="flag" ${s.wordFilter?.action === 'flag' ? 'selected' : ''}>Send it, and report it to moderators</option></select></label>
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
    ${host && others.length ? `<h3>Hand the hearth over</h3>
    <p class="small muted">Someone else becomes the host and can do everything. You stay in the hearth with your roles.</p>
    <div class="transfer-row"><select id="transfer-to">${others.map((m) => `<option value="${m.id}">${escapeHtml(nameOfPerson(m))}</option>`).join('')}</select>
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
          liveChannelId: $('#burrow-live').value ? Number($('#burrow-live').value) : null,
          ...($('#burrow-upload') ? { uploadMb: $('#burrow-upload').value === '' ? null : Number($('#burrow-upload').value) } : {}),
          wordFilter: { words: $('#burrow-words').value.split(/[,\n]/).map((w) => w.trim()).filter(Boolean), action: $('#burrow-words-action').value },
          ...($('#burrow-afk') ? { afkChannelId: $('#burrow-afk').value ? Number($('#burrow-afk').value) : null, afkMinutes: Number($('#burrow-afk-minutes').value) } : {}),
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
    if (!to || !confirm(`Make ${nameOfPerson(to)} the host of ${s.name}? You can't take this back yourself.`)) return;
    try { done(await api(`/api/servers/${s.id}/transfer`, { method: 'POST', body: { userId: to.id } })); closeModal(); toast(`${nameOfPerson(to)} is now the host.`); }
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
  if (!s.group) return nameOfPerson(partner(s));
  if (s.name) return s.name;
  const names = s.members.filter((m) => m.id !== state.me.id).map(nameOfPerson);
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ') || 'Just you';
}
function groupAvatar(cls = 'xs') {
  const av = document.createElement('span');
  av.className = `avatar ${cls} group-avatar`;
  av.innerHTML = PEOPLE_ICON;
  return av;
}

/** People you can message: your friends and everyone who shares a burrow with you. */
function messageablePeople() {
  const people = new Map();
  for (const f of state.friends?.friends ?? []) people.set(f.id, f);
  for (const id of state.serverOrder)
    for (const m of state.servers.get(id).members) if (m.id !== state.me.id && !people.has(m.id)) people.set(m.id, { ...m, nickname: null });
  return [...people.values()].filter((m) => !m.deleted && !state.me.blockedIds?.includes(m.id)).sort((a, b) => nameOfPerson(a).localeCompare(nameOfPerson(b)));
}

/** A list of people to tick. `done(ids)` gets the ticked ones. */
function peoplePicker({ title, intro = '', list, button, onDone, extra = '', wire }) {
  modal(`<h2>${escapeHtml(title)}</h2>
    ${intro ? `<p class="muted small">${escapeHtml(intro)}</p>` : ''}
    ${list.length ? '<input id="dm-filter" placeholder="Find someone" />' : '<p class="muted">Join a hearth first. You can message anyone who shares one with you.</p>'}
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
      ...list.filter((m) => (m.username + ' ' + nameOfPerson(m)).toLowerCase().includes(q.toLowerCase())).map((m) => {
        const li = document.createElement('li');
        li.classList.toggle('picked', picked.has(m.id));
        li.setAttribute('role', 'checkbox');
        li.setAttribute('aria-checked', String(picked.has(m.id)));
        li.tabIndex = 0;
        const av = document.createElement('span');
        av.className = 'avatar';
        setAvatar(av, m.username, avatarOf(m.id, m.avatar));
        const name = document.createElement('span');
        name.textContent = nameOfPerson(m);
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
      <label>Name<input id="group-name" maxlength="64" placeholder="${escapeHtml(others.map(nameOfPerson).join(', '))}" value="${escapeHtml(s.name ?? '')}" /></label>
      <div class="error" id="modal-error"></div>
      <div class="modal-row"><button type="submit" class="btn secondary">Rename</button></div>
    </form>
    <h3>People · ${s.members.length}</h3>
    <ul class="group-people">${s.members.map((m) => `<li data-avatar="${m.id}"><span class="avatar xs"></span>${escapeHtml(nameOfPerson(m))}${m.id === state.me.id ? ' <span class="muted small">(you)</span>' : ''}</li>`).join('')}</ul>
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
