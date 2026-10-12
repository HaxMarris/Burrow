// The chat itself: showing messages, the message box, and the modal windows.
// Part of Burrow's client: plain scripts that index.html loads in order, sharing one global scope.
'use strict';

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
      ? `<h2>This is the beginning of ${server.group ? escapeHtml(dmTitle(server)) : `your conversation with ${escapeHtml(nameOfPerson(partner(server)))}`}</h2>`
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
const revealedBlocked = new Set();
const isBlocked = (userId) => !!state.me?.blockedIds?.includes(userId);
const hiddenByBlock = (m) => isBlocked(m.authorId) && !revealedBlocked.has(m.id);

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
  // Someone you blocked: a folded line, without their name or picture, until you ask to see it.
  if (hiddenByBlock(m)) {
    const line = document.createElement('div');
    line.className = 'blocked-line';
    line.dataset.id = m.id;
    const show = document.createElement('button');
    show.type = 'button';
    show.textContent = 'Message from someone you blocked · Show';
    show.onclick = () => { revealedBlocked.add(m.id); renderMessages(); };
    line.append(show);
    parent.append(line);
    return null;
  }
  const grouped = !newGroup && body && prev && !hiddenByBlock(prev) && !m.replyTo && !m.forwarded && prev.authorId === m.authorId && m.createdAt - prev.createdAt < GROUP_WINDOW;
  if (!grouped) {
    const group = document.createElement('div');
    group.className = 'group' + (m.authorId === state.me.id ? ' mine' : '');
    const av = document.createElement('span');
    av.className = 'avatar lg';
    setAvatar(av, authorName(m), avatarOf(m.authorId, m.authorAvatar));
    body = document.createElement('div');
    const time = new Date(m.createdAt);
    const color = roleColor(state.servers.get(state.serverId), m.authorId);
    body.innerHTML = `<div class="head"><span class="author"${color ? ` style="color:${escapeHtml(color)}"` : ''}>${escapeHtml(authorName(m))}</span>${m.authorBot ? '<span class="bot-tag">BOT</span>' : ''}
        <span class="time" title="${escapeHtml(time.toLocaleString())}">${escapeHtml(formatTime(time))}</span></div>`;
    // Their name and picture open their card.
    av.classList.add('opens-card');
    av.onclick = body.querySelector('.author').onclick = () => openPersonById(m.authorId);
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
  if (m.live) el.append(renderLiveCard(m));
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
  if (m.authorId === state.me.id && !m.poll && !m.forwarded && !m.live) actions.append(iconButton('Edit', 'Edit message', () => startEdit(m, content)));
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
  const people = s.members
    .filter((m) => m.id !== state.me.id && !m.deleted && (m.username.toLowerCase().includes(q) || nameOfPerson(m).toLowerCase().includes(q)))
    .sort((a, b) => b.username.toLowerCase().startsWith(q) - a.username.toLowerCase().startsWith(q)
      || !!b.online - !!a.online || nameOfPerson(a).localeCompare(nameOfPerson(b)));
  // People allowed to can ping everyone, everyone online, or a role.
  const groups = !isDm(s) && can(s, 'everyone') ? [
    { username: 'everyone', ping: 'Everyone who can see this room' },
    { username: 'here', ping: "Everyone who's online now" },
    ...(s.roles ?? []).map((r) => ({ username: r.name, ping: 'Everyone with this role', color: r.color })),
  ].filter((g) => g.username.toLowerCase().startsWith(q)) : [];
  const matches = [...people.slice(0, 8 - Math.min(groups.length, 3)), ...groups.slice(0, 3)];
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
    if (m.ping) {
      av.classList.add('ping-avatar');
      av.textContent = '@';
      if (m.color) av.style.background = m.color;
    } else setAvatar(av, m.username, avatarOf(m.id, m.avatar));
    const name = document.createElement('span');
    name.textContent = m.ping ? m.username : nameOfPerson(m);
    b.append(av, name);
    if (!m.ping && nameOfPerson(m) !== m.username) b.insertAdjacentHTML('beforeend', `<span class="small muted">@${escapeHtml(m.username)}</span>`);
    if (m.ping) b.insertAdjacentHTML('beforeend', `<span class="small muted">${escapeHtml(m.ping)}</span>`);
    b.onpointerdown = (e) => e.preventDefault(); // keep the keyboard up
    b.onclick = () => { mention.index = i; completeMention(); };
    return b;
  }));
  mentionBox.classList.remove('hidden');
}

function completeMention() {
  const m = mention.matches[mention.index];
  const after = input.value.slice(input.selectionStart).replace(/^[\w.-]*\s?/, '');
  if (m.ping && m.username !== 'everyone' && m.username !== 'here') toast(`Everyone with the ${m.username} role will be notified.`);
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
  modal(`<h2>Find a hearth</h2>
    <p class="muted">A hearth is a shared space for a group of friends, with its own rooms.</p>
    <form id="create-form">
      <label>Dig a new one<input id="new-server-name" placeholder="e.g. Friday Night Crew" maxlength="64" required /></label>
      <button type="submit" class="btn">Create hearth</button>
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
      ${can(s, 'burrow') ? '<button class="btn secondary" id="open-edit">Edit hearth</button>' : ''}
      ${can(s, 'messages') ? `<button class="btn secondary" id="open-reports">Reports${s.openReports ? ` · ${s.openReports}` : ''}</button>` : ''}
      ${can(s, 'audit') ? '<button class="btn secondary" id="open-audit">Audit log</button>' : ''}
      ${can(s, 'burrow') ? '<button class="btn secondary" id="open-bots">Bots and webhooks</button>' : ''}
      ${can(s, 'burrow') ? `<button class="btn secondary" id="open-motd">Message of the day${s.motd?.length ? ` · ${s.motd.length}` : ''}</button>` : ''}
      <button class="btn secondary" id="open-review">Year in review</button>
      ${can(s, 'roles') ? `<button class="btn secondary" id="open-roles">Roles${s.roles.length ? ` · ${s.roles.length}` : ''}</button>` : ''}
      ${can(s, 'emoji') && state.maxUploadBytes ? `<button class="btn secondary" id="open-emoji">Emoji and stickers${s.emoji?.length ? ` · ${s.emoji.length}` : ''}</button>
        <button class="btn secondary" id="open-sounds">Soundboard${s.sounds?.length ? ` · ${s.sounds.length}` : ''}</button>` : ''}
    </div>
    ${can(s, 'ban') ? '<div id="ban-list"></div>' : ''}
    <div class="modal-row">
      <button class="btn danger" id="leave-server">${owner ? 'Delete hearth' : 'Leave hearth'}</button>
      <button class="btn secondary" data-close>Close</button>
    </div>`);
  if (can(s, 'ban')) renderBans(s);
  $('#open-invites').onclick = () => openInvites(s.id);
  $('#open-notify').onclick = () => openNotifyMenu($('#open-notify'), s, null);
  $('#open-rules')?.addEventListener('click', () => openRules(s));
  $('#open-edit')?.addEventListener('click', () => openEditBurrow(s.id));
  $('#open-roles')?.addEventListener('click', () => openRoles(s.id));
  $('#open-reports')?.addEventListener('click', () => openReports(s.id));
  $('#open-audit')?.addEventListener('click', () => openAudit(s.id));
  $('#open-bots')?.addEventListener('click', () => openBots(s.id));
  $('#open-motd')?.addEventListener('click', () => openMotd(s.id));
  $('#open-review').onclick = () => openYearReview(s.id);
  $('#open-emoji')?.addEventListener('click', () => openEmojiManager(s.id));
  $('#open-sounds')?.addEventListener('click', () => openSounds(s.id));
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
