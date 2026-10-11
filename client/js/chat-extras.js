// Emoji and stickers, polls, link previews, threads, voice messages, search.
// Part of Burrow's client: plain scripts that index.html loads in order, sharing one global scope.
'use strict';

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
    b.title = n ? o.userIds.map((id) => nameOfPerson(server?.members.find((x) => x.id === id))).join(', ') : 'No votes yet';
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
  if (file.size > uploadLimit()) return alert(uploadLimit() ? 'That recording is too big to send.' : "Your roles can't share files in this burrow.");
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
    for (const src of sources) for (const m of src?.members ?? []) people.set(m.id, nameOfPerson(m));
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
