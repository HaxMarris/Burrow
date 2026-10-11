// Rooms, threads, what you've read, and message formatting.
// Part of Burrow's client: plain scripts that index.html loads in order, sharing one global scope.
'use strict';

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
const mentionsMe = (m) => new RegExp('@' + escapeRegex(state.me.username) + '\\b', 'i').test(m.content) || m.replyTo?.authorId === state.me.id || pingsMe(m);
/** @everyone, @here or one of your roles, from someone allowed to ping those. */
function pingsMe(m) {
  const p = m.pings;
  if (!p || m.authorId === state.me.id) return false;
  if (p.everyone || p.here) return true;
  const mine = roomById(m.channelId)?.s.members.find((x) => x.id === state.me.id)?.roleIds ?? [];
  return !!p.roles?.some((id) => mine.includes(id));
}

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
  renderCallButton();
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
  mark.textContent = `Seen by ${nameOfPerson(partner(where.s))}`;
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
  if (state.ws?.readyState === WebSocket.OPEN) return state.ws.send(JSON.stringify({ type: 'send', channelId, ...body }));
  try {
    await api(`/api/channels/${channelId}/messages`, { method: 'POST', body });
  } catch (err) {
    // No connection: text waits on this device and goes out once it's back.
    if (!(err instanceof TypeError) || !queueMessage(channelId, body)) throw err;
  }
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
  who.textContent = authorName(m);
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
    (isDm(s) || can(s, 'pin')) && { label: m.pinnedAt ? 'Unpin' : 'Pin to this room', run: () => api(`/api/messages/${m.id}/pin`, { method: 'POST', body: { pinned: !m.pinnedAt } }).catch(alertError) },
    where && !where.thread && !isDm(s) && { label: m.thread ? 'Open thread' : 'Start a thread', run: () => startThread(m) },
    { label: 'Forward', run: () => openForward(m) },
    { label: saved ? 'Remove from saved' : 'Save for later', run: () => toggleSaved(m) },
    { label: saved?.remindAt && !saved.reminded ? 'Change reminder' : 'Remind me about this', run: () => openRemind(m) },
    { label: 'Mark unread from here', run: () => markUnreadFrom(m) },
    m.content && navigator.clipboard && { label: 'Copy text', run: () => navigator.clipboard.writeText(emojiToNames(m.content)) },
    m.editedAt && { label: 'Edit history', run: () => openEditHistory(m) },
    mine && m.embeds?.length && { label: 'Remove link previews', run: () => api(`/api/messages/${m.id}/embeds`, { method: 'POST' }).catch(alertError) },
    mine && m.poll && !m.poll.closed && { label: 'End poll now', run: () => api(`/api/messages/${m.id}/poll/end`, { method: 'POST' }).catch(alertError) },
    s && !isDm(s) && !mine && { label: 'Report to moderators', run: () => openReport(m) },
    s && !isDm(s) && can(s, 'messages') && { label: 'Delete from here down', danger: true, run: () => bulkDeleteFrom(m) },
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
    if (c) out.push({ id: c.id, label: s.group ? dmTitle(s) : `Direct message with ${nameOfPerson(partner(s))}` });
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

// ---- moderation: reports, the audit log, bulk delete

function openReport(m) {
  modal(`<h2>Report to moderators</h2><p class="muted small">The people who manage messages in this burrow will see this message and your reason.</p>
    <label>Reason (optional)<input id="report-reason" maxlength="200" placeholder="What's wrong with it?"></label>
    <div class="modal-row"><button class="btn secondary" data-close>Cancel</button><button class="btn danger" id="report-send">Report</button></div>`);
  $('#report-send').onclick = async () => {
    try {
      await api(`/api/messages/${m.id}/report`, { method: 'POST', body: { reason: $('#report-reason').value.trim() } });
      closeModal();
      toast('Reported to the moderators.');
    } catch (err) { alertError(err); }
  };
}

function bulkDeleteFrom(m) {
  modal(`<h2>Delete from here down</h2><p>Delete this message and every message after it in this room? Up to 100 at a time, and it can't be undone.</p>
    <div class="modal-row"><button class="btn secondary" data-close>Cancel</button><button class="btn danger" id="bulk-del">Delete them</button></div>`);
  $('#bulk-del').onclick = async () => {
    closeModal();
    try {
      const { deleted } = await api(`/api/channels/${m.channelId}/bulk-delete`, { method: 'POST', body: { fromId: m.id } });
      toast(`Deleted ${deleted} message${deleted === 1 ? '' : 's'}.`);
    } catch (err) { alertError(err); }
  };
}

async function openReports(serverId) {
  modal(`<h2>Reports</h2><p class="muted small">Messages people reported, and ones the word filter caught. Handled reports stay here for a week.</p>
    <div id="report-list" class="card-list"><p class="muted">Loading…</p></div>
    <div class="modal-row"><button class="btn secondary" data-close>Close</button></div>`);
  try {
    const reports = await api(`/api/servers/${serverId}/reports`);
    const list = $('#report-list');
    if (!list) return;
    if (!reports.length) return (list.innerHTML = '<p class="muted">No reports. All quiet.</p>');
    list.replaceChildren(...reports.map((r) => {
      const who = r.reporter ? `Reported by ${r.reporter}` : 'Caught by the word filter';
      const note = `${who}${r.reporter && r.reason ? `: ${r.reason}` : r.reason && !r.reporter ? ` (${r.reason.replace(/^Word filter: /, '')})` : ''}`
        + (r.resolvedAt ? ` · handled by ${r.resolvedBy ?? 'someone'}` : '');
      const m = { id: r.messageId, channelId: r.channelId, author: r.author ?? 'Someone', authorId: r.authorId, authorAvatar: r.authorAvatar, content: r.content, createdAt: r.createdAt };
      const resolve = (deleteMessage) => (b) => {
        b.disabled = true;
        api(`/api/reports/${r.id}/resolve`, { method: 'POST', body: { deleteMessage } }).then(() => openReports(serverId)).catch(alertError);
      };
      const card = messageCard(m, null, {
        note,
        onOpen: r.messageId && !r.resolvedAt ? () => { closeModal(); jumpTo(r.channelId, r.messageId); } : undefined,
        buttons: r.resolvedAt ? [] : [['Delete message', resolve(true), 'danger'], ['Dismiss', resolve(false)]],
      });
      if (r.resolvedAt) card.classList.add('resolved');
      return card;
    }));
  } catch (err) { $('#report-list') && ($('#report-list').textContent = err.message); }
}

const AUDIT_LABELS = {
  remove: (e) => `removed ${e.target}`,
  ban: (e) => `banned ${e.target}`,
  unban: (e) => `unbanned ${e.target}`,
  timeout: (e) => `timed out ${e.target} for ${e.detail}`,
  timeout_end: (e) => `ended ${e.target}'s timeout`,
  role_create: (e) => `made the role ${e.detail}`,
  role_edit: (e) => `changed the role ${e.detail}`,
  role_delete: (e) => `deleted the role ${e.detail}`,
  role_give: (e) => `gave ${e.target} the role ${e.detail}`,
  role_take: (e) => `took the role ${e.detail} from ${e.target}`,
  room_edit: (e) => `changed the room ${e.detail}`,
  room_delete: (e) => `deleted the room ${e.detail}`,
  message_delete: (e) => `deleted a message from ${e.target} ${e.detail}`,
  bulk_delete: (e) => `deleted ${e.detail}`,
  voice_disconnect: (e) => `disconnected ${e.target} from ${e.detail}`,
  voice_mute: (e) => `muted ${e.target} at the fire`,
  voice_unmute: (e) => `unmuted ${e.target} at the fire`,
  voice_move: (e) => `moved ${e.target} (${e.detail})`,
  burrow_edit: (e) => `changed the burrow's ${e.detail}`,
  invite_reset: () => 'made a new invite code',
  bot_add: (e) => `added the bot ${e.target}`,
  bot_remove: (e) => `removed the bot ${e.target}`,
  webhook_add: (e) => `added the webhook ${e.target} in ${e.detail}`,
  webhook_remove: (e) => `deleted the webhook ${e.target}`,
};

async function openAudit(serverId) {
  modal(`<h2>Audit log</h2><p class="muted small">Who did what in this burrow, newest first.</p>
    <div id="audit-list" class="audit-list"><p class="muted">Loading…</p></div>
    <div class="modal-row"><button class="btn secondary hidden" id="audit-more">Show older</button><button class="btn secondary" data-close>Close</button></div>`);
  const list = $('#audit-list');
  let first = true;
  const load = async (before) => {
    try {
      const { entries, more } = await api(`/api/servers/${serverId}/audit${before ? `?before=${before}` : ''}`);
      if (!$('#audit-list')) return;
      if (first) list.innerHTML = '';
      first = false;
      if (!entries.length && !before) list.innerHTML = '<p class="muted">Nothing yet.</p>';
      for (const e of entries) {
        const row = document.createElement('div');
        row.className = 'audit-row';
        const label = AUDIT_LABELS[e.action]?.({ ...e, target: e.target ?? 'someone' }) ?? e.action;
        row.innerHTML = `<span><b>${escapeHtml(e.actor ?? 'Someone')}</b> ${escapeHtml(label)}</span><span class="muted small">${escapeHtml(formatTime(new Date(e.createdAt)))}</span>`;
        list.append(row);
      }
      const btn = $('#audit-more');
      btn.classList.toggle('hidden', !more);
      btn.onclick = () => load(entries[entries.length - 1].id);
    } catch (err) { list.textContent = err.message; }
  };
  load();
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
