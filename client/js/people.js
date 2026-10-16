// Roles, direct messages, your account, replies and reactions.
// Part of Burrow's client: plain scripts that index.html loads in order, sharing one global scope.
'use strict';

// ---------------------------------------------------------------- roles: host, moderators, private rooms

const LOCK_ICON = '<svg viewBox="0 0 24 24" class="lock-icon" aria-label="Private"><path d="M7 10V7a5 5 0 0 1 10 0v3h1a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h1Zm2 0h6V7a3 3 0 0 0-6 0v3Z"/></svg>';
const GEAR_ICON = '<svg viewBox="0 0 24 24"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm8.9 3-1.6-.4a7.4 7.4 0 0 0-.7-1.7l.9-1.4-1.9-1.9-1.4.9a7.4 7.4 0 0 0-1.7-.7L13 3.1h-2l-.4 1.7a7.4 7.4 0 0 0-1.7.7l-1.4-.9-1.9 1.9.9 1.4a7.4 7.4 0 0 0-.7 1.7l-1.7.4v2l1.7.4c.2.6.4 1.2.7 1.7l-.9 1.4 1.9 1.9 1.4-.9c.5.3 1.1.5 1.7.7l.4 1.7h2l.4-1.7c.6-.2 1.2-.4 1.7-.7l1.4.9 1.9-1.9-.9-1.4c.3-.5.5-1.1.7-1.7l1.6-.4v-2Z"/></svg>';

// Each burrow has its own roles, highest first. The host can do everything; everyone else
// gets what their roles allow, and can only act on people and roles below their highest role.
const PERMS = [
  ['rooms', 'Manage rooms', 'Add, change and delete rooms, and see every private room'],
  ['messages', 'Delete messages', "Delete other people's messages, many at once too, and deal with reports"],
  ['pin', 'Pin messages', 'Pin and unpin messages in rooms'],
  ['timeout', 'Time people out', "Stop someone writing and talking for a while, without removing them"],
  ['remove', 'Remove people', 'Take people out of the hearth (they can come back with the invite)'],
  ['ban', 'Ban people', "Remove people for good, and see and lift bans"],
  ['roles', 'Manage roles', 'Make, change and hand out the roles below their own'],
  ['burrow', 'Edit the hearth', "Change its name, pictures, description, welcome room, rules, AFK fire, upload limit and word filter, and manage events"],
  ['invites', 'Manage invites', "See and cancel everyone's invite links, and make a new permanent link"],
  ['emoji', 'Manage emoji and sounds', "Add, rename and remove the hearth's own emoji, stickers and soundboard sounds"],
  ['voice', 'Manage voice', 'Move people between fires, mute them for everyone, disconnect them, and sit at a full fire'],
  ['everyone', 'Mention @everyone and roles', 'Ping everyone in a room with @everyone or @here, or everyone with a role with @role'],
  ['audit', 'See the audit log', 'See who removed, banned, deleted or changed what, and when'],
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
  return m.id !== state.me.id && (can(s, 'remove') || can(s, 'ban') || can(s, 'voice')) && rankOf(s, m) > rankOf(s, me(s));
};

// ---- getting back into voice after the connection drops

/** Tries to rejoin the fire you were at, backing off while offline, until it works or you leave. */
function scheduleRejoin(again) {
  const tries = (state.rejoin?.tries ?? 0) + 1;
  clearTimeout(state.rejoin?.timer);
  // Ten minutes of trying is plenty; by then you've probably moved on.
  if (tries > 14) { cancelRejoin(); return renderVoiceBar(); }
  const delay = Math.min(60000, 1000 * 2 ** Math.min(tries - 1, 6));
  state.rejoin = { ...again, tries, timer: setTimeout(rejoinNow, navigator.onLine === false ? 60000 : delay) };
  renderVoiceBar();
}
function rejoinNow() {
  const r = state.rejoin;
  if (!r || state.voice) return;
  clearTimeout(r.timer);
  // The room may be gone, or you may have lost access, while away.
  if (!roomById(r.channelId)) { cancelRejoin(); return renderVoiceBar(); }
  joinVoice(r.channelId, { muted: r.muted, deafened: r.deafened, rejoin: true });
}
function cancelRejoin() {
  if (!state.rejoin) return;
  clearTimeout(state.rejoin.timer);
  state.rejoin = null;
  renderVoiceBar();
}
// The network's back: don't wait out the backoff.
window.addEventListener('online', () => { if (state.rejoin) rejoinNow(); });

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
        : '<p class="small muted">Nobody else is in this hearth yet.</p>'}
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
        ${s.roles?.length ? `<ul class="access-list" id="post-roles">${s.roles.map((r) => `<li><label class="check"><input type="checkbox" value="${r.id}" ${postRoles.includes(r.id) ? 'checked' : ''} /> ${roleDot(r.color)}${escapeHtml(r.name)}</label></li>`).join('')}</ul>` : '<p class="small muted">This hearth has no roles yet.</p>'}
      </div>
      ${s.roles?.length ? `<h4>Read only</h4><p class="small muted">People with these roles can read this room but not write in it, unless they manage rooms.</p>
        <ul class="access-list" id="read-only-roles">${s.roles.map((r) => `<li><label class="check"><input type="checkbox" value="${r.id}" ${(c.readOnlyRoleIds ?? []).includes(r.id) ? 'checked' : ''} /> ${roleDot(r.color)}${escapeHtml(r.name)}</label></li>`).join('')}</ul>` : ''}` : c.kind === 'voice' ? voiceRoomSettings(c) : ''}
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
      ...($('#read-only-roles') ? { readOnlyRoleIds: [...document.querySelectorAll('#read-only-roles input:checked')].map((i) => Number(i.value)) } : {}),
    } : c.kind === 'voice' ? { userLimit: Number($('#room-seats').value), keepChat: $('#room-keep-chat').checked } : {};
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

const TIMEOUTS = [[5, '5 minutes'], [10, '10 minutes'], [60, '1 hour'], [1440, '1 day'], [10080, '1 week']];
function openMemberMenu(s, m) {
  const myRank = rankOf(s, me(s));
  const self = m.id === state.me.id;
  const above = rankOf(s, m) > myRank;
  const roles = s.roles ?? [];
  const editRoles = can(s, 'roles') && (self || above) && roles.length;
  const removable = !self && above;
  const current = rolesOf(s, m);
  modal(`<h2>${escapeHtml(nameOfPerson(m))}</h2>
    <p class="muted">${isHost(s, m.id) ? 'Host of' : current.length ? `${current.map((r) => escapeHtml(r.name)).join(', ')} in` : 'Member of'} ${escapeHtml(s.name)}</p>
    ${editRoles ? `<h4>Roles</h4><ul class="access-list" id="member-roles">${roles.map((r) => `<li><label class="check"><input type="checkbox" value="${r.id}" ${m.roleIds.includes(r.id) ? 'checked' : ''} ${r.position > myRank ? '' : 'disabled'} /> ${roleDot(r.color)}${escapeHtml(r.name)}</label></li>`).join('')}</ul>
      <button class="btn" id="member-save-roles">Save roles</button>` : ''}
    ${removable && can(s, 'timeout') ? (m.timeoutUntil && m.timeoutUntil > Date.now()
      ? `<p class="muted small">Timed out until ${escapeHtml(new Date(m.timeoutUntil).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }))}.</p><button class="btn secondary" id="member-timeout-end">End timeout</button>`
      : `<div class="inline-form"><select id="member-timeout-for">${TIMEOUTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select><button class="btn secondary" id="member-timeout">Time out</button></div>
        <p class="small muted">They can read, but not write, react with files or talk at a fire until it runs out.</p>`) : ''}
    ${removable && can(s, 'voice') ? `<button class="btn secondary" id="member-voice-mute">${m.voiceMuted ? 'Let them speak in voice' : 'Mute in voice for everyone'}</button>` : ''}
    ${removable && can(s, 'remove') ? '<button class="btn secondary" id="member-remove">Remove from hearth</button>' : ''}
    ${removable && can(s, 'ban') ? '<button class="btn danger" id="member-ban">Ban from hearth</button>' : ''}
    ${removable && (can(s, 'remove') || can(s, 'ban')) ? `<p class="small muted">Removed people can come back with the invite code. Banned people can't, until they're unbanned in the hearth's settings.</p>` : ''}
    <div class="error" id="modal-error"></div>
    <div class="modal-row"><button class="btn secondary" data-close>Close</button></div>`);
  const act = async (path, body) => {
    try { await api(`/api/servers/${s.id}/members/${m.id}/${path}`, { method: 'POST', body }); closeModal(); }
    catch (err) { $('#modal-error').textContent = err.message; }
  };
  if (editRoles) $('#member-save-roles').onclick = () =>
    act('roles', { roleIds: [...document.querySelectorAll('#member-roles input:checked')].map((i) => Number(i.value)) });
  $('#member-voice-mute')?.addEventListener('click', () => act('voice-mute', { muted: !m.voiceMuted }));
  $('#member-timeout')?.addEventListener('click', () => act('timeout', { minutes: Number($('#member-timeout-for').value) }));
  $('#member-timeout-end')?.addEventListener('click', () => act('timeout', { minutes: 0 }));
  $('#member-remove')?.addEventListener('click', () => confirm(`Remove ${nameOfPerson(m)} from ${s.name}?`) && act('remove', { ban: false }));
  $('#member-ban')?.addEventListener('click', () => confirm(`Ban ${nameOfPerson(m)} from ${s.name}?`) && act('remove', { ban: true }));
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
      ${state.maxUploadBytes ? `<label>Largest file this role can share
        <span class="inline-form"><input type="number" id="role-upload" min="0" max="${Math.floor(state.maxUploadBytes / 1048576)}" placeholder="Same as everyone" value="${role.uploadMb ?? ''}" /><span class="muted">MB</span></span>
        <span class="small muted">Empty: the hearth's limit. 0: no files. People get the biggest limit of their roles, up to the server's ${formatSize(state.maxUploadBytes)}.</span></label>` : ''}
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
      ...($('#role-upload') ? { uploadMb: $('#role-upload').value === '' ? null : Number($('#role-upload').value) } : {}),
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
const CLOSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4z"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 24 24" class="check" aria-label="Current"><path d="M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6 11-11-1.4-1.4z"/></svg>';
const ROOM_ICON = '<svg viewBox="0 0 24 24" class="room-icon" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
function roomIcon() {
  const t = document.createElement('template');
  t.innerHTML = ROOM_ICON;
  return t.content.firstChild;
}
const CHAT_ICON = '<svg viewBox="0 0 24 24"><path d="M4 4h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9l-5 4V5a1 1 0 0 1 1-1Z" fill="currentColor"/></svg>';

const isDm = (s) => s?.kind === 'dm';
const FRIENDS_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm7.5 0a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM9 13c-3.3 0-7 1.7-7 4.5V20h14v-2.5C16 14.7 12.3 13 9 13Zm7.5 0c-.6 0-1.2.1-1.8.2 1.4 1 2.3 2.4 2.3 4.3V20h5v-2.5c0-2.6-2.9-4.5-5.5-4.5Z" fill="currentColor"/></svg>';
// The other person in a conversation.
const partner = (s) => s.members.find((m) => m.id !== state.me.id) ?? s.members[0];
// The name someone goes by: their nickname in this burrow, else their display name, else their username.
const nameOfPerson = (m) => m?.nickname || m?.displayName || m?.username || 'Someone';
// A message's author as they're called now (names change), falling back to the name it came with.
const authorName = (m) => {
  let s = state.servers.get(state.serverId);
  if (!s?.channels.some((c) => c.id === m.channelId) && !s?.threads?.some((c) => c.id === m.channelId)) s = roomById(m.channelId)?.s;
  const mem = s?.members.find((x) => x.id === m.authorId);
  return mem ? nameOfPerson(mem) : m.author;
};

// The newest message as one plain line: "You: …" for yours, nothing for someone you've blocked.
function dmPreview(s) {
  const l = s.last;
  if (!l || isBlocked(l.authorId)) return '';
  const text = l.text
    .replace(/\|\|[\s\S]*?\|\|/g, 'spoiler')
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/```[\s\S]*?(```|$)/g, 'code')
    .replace(/[*_~`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim() || (l.files ? 'Sent an attachment' : '');
  if (!text) return '';
  if (l.authorId === state.me.id) return 'You: ' + text;
  return s.group ? `${nameOf(l.authorId, '')}: ${text}`.replace(/^: /, '') : text;
}

// "2:54 AM" today, "Yesterday", the weekday this week, otherwise the date.
function shortTime(d) {
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 864e5);
  if (days <= 0) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function addDm(s) {
  const old = state.servers.get(s.id);
  if (old && !('last' in s)) s.last = old.last; // updates to a conversation don't carry its newest message
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
    // A round picture with who's online, the name over the newest message, and its time and unread count.
    const wrap = document.createElement('span');
    wrap.className = 'dm-avatar';
    if (s.group) wrap.append(groupAvatar());
    else {
      const p = partner(s);
      const av = document.createElement('span');
      av.className = 'avatar';
      setAvatar(av, p.username, avatarOf(p.id, p.avatar));
      const dot = document.createElement('span');
      dot.className = 'status-dot ' + statusOf(p);
      wrap.append(av, dot);
    }
    const text = document.createElement('span');
    text.className = 'dm-text';
    const name = document.createElement('span');
    name.className = 'dm-name';
    name.textContent = dmTitle(s);
    const preview = document.createElement('span');
    preview.className = 'dm-preview';
    preview.textContent = dmPreview(s);
    text.append(name, preview);
    const side = document.createElement('span');
    side.className = 'dm-side';
    if (s.last) side.innerHTML = `<span class="dm-time">${escapeHtml(shortTime(new Date(s.last.at)))}</span>`;
    li.append(wrap, text, side);
    if (notifyState(s, null).muted) li.classList.add('muted-room');
    li.oncontextmenu = (e) => { e.preventDefault(); openNotifyMenu(li, s); };
    const n = id === state.serverId || notifyState(s, null).muted ? 0 : s.channels.reduce((sum, c) => sum + (c.unread ?? 0), 0);
    if (n) side.insertAdjacentHTML('beforeend', `<span class="ping-count">${n > 99 ? '99+' : n}</span>`);
    li.onclick = () => { store.set('lastDm', id); selectServer(id); showView('chat'); };
    const close = iconButton('', `Close conversation with ${dmTitle(s)}`, (e) => { e.stopPropagation(); closeDm(s); });
    close.classList.add('room-gear', 'dm-close');
    close.innerHTML = CLOSE_ICON;
    li.append(close);
    return li;
  });
  if (!items.length) {
    const hint = document.createElement('li');
    hint.className = 'hint';
    hint.textContent = 'No conversations yet. Press + or click someone in a hearth\'s member list.';
    items.push(hint);
  }
  // Friends first: who's online, and requests waiting on you.
  const friends = document.createElement('li');
  friends.className = 'dm friends-row';
  friends.id = 'friends-row';
  const online = state.friends?.friends.filter((f) => f.online).length ?? 0;
  const asks = state.friends?.incoming.length ?? 0;
  friends.innerHTML = `<span class="avatar xs group-avatar">${FRIENDS_ICON}</span><span class="dm-name">Friends${online ? `<span class="small muted"> · ${online} online</span>` : ''}</span>
    <span class="ping-count ${asks ? '' : 'hidden'}">${asks > 99 ? '99+' : asks}</span>`;
  friends.onclick = () => openFriends();
  items.unshift(friends);
  $('#channel-list').replaceChildren(...items);
  // Calls show in the conversation itself, not as a burrow's Campfire.
  $('#fire-main').replaceChildren();
  $('#voice-list').replaceChildren();
  $('#voice-section').classList.add('hidden');
}

// Takes a conversation off your list. Nothing is deleted: it comes back when someone writes.
async function closeDm(s) {
  try {
    await api(`/api/dms/${s.id}/close`, { method: 'POST' });
    handleEvent({ type: 'server_deleted', serverId: s.id });
    toast(`Closed your conversation with ${dmTitle(s)}. It comes back if someone writes in it.`);
  } catch (err) { alertError(err); }
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

// Your account, in four tabs: how others see you, how the app behaves, how you log in, and your data.
const ACCOUNT_TABS = [['profile', 'Profile'], ['settings', 'Settings'], ['security', 'Login and security'], ['data', 'Your data']];
function openAccount(tab = store.get('accountTab') || 'profile') {
  const me = state.me;
  modal(`<h2>Your account</h2>
    <div class="tabs" role="tablist">${ACCOUNT_TABS.map(([id, label]) => `<button type="button" role="tab" data-tab="${id}">${label}</button>`).join('')}</div>
    <section data-pane="profile" class="account-pane">
      <div class="profile-preview" id="profile-preview"></div>
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
      <div class="error" id="avatar-error"></div>
      <div class="banner-row">
        <button type="button" class="btn secondary" id="banner-pick">${me.banner ? 'Change banner' : 'Add a banner'}</button>
        <button type="button" class="btn secondary ${me.banner ? '' : 'hidden'}" id="banner-remove">Remove banner</button>
        <input type="file" id="banner-input" accept="image/png,image/jpeg,image/gif,image/webp" hidden />
      </div>` : ''}
      <form id="profile-form">
        <label>Display name<input id="profile-name" maxlength="32" placeholder="${escapeHtml(me.username)}" value="${escapeHtml(me.displayName ?? '')}" /></label>
        <span class="small muted">What people see. You still log in as ${escapeHtml(me.username)}, and people @mention you as @${escapeHtml(me.username)}.</span>
        <label>About me<textarea id="profile-bio" maxlength="190" rows="3" placeholder="A line or two about you">${escapeHtml(me.bio ?? '')}</textarea></label>
        ${birthdayField(me.birthday)}
        <div class="accent-row">
          <label class="accent-pick">Card colour<input type="color" id="profile-accent" value="${escapeHtml(me.accent || '#4f8a5b')}" /></label>
          <label class="check"><input type="checkbox" id="profile-accent-off" ${me.accent ? '' : 'checked'} /> No colour</label>
        </div>
        <div class="error" id="profile-error"></div>
        <div class="modal-row"><button type="submit" class="btn">Save profile</button></div>
      </form>
      <span class="small muted">A different name in one hearth? Click yourself in its member list and pick "Change nickname".</span>
    </section>
    <section data-pane="settings" class="account-pane">
      ${themeSettings()}
      ${displaySettings()}
      <h3>Direct messages</h3>
      <label class="check"><input type="checkbox" id="read-receipts" ${me.readReceipts !== false ? 'checked' : ''} /> Show when I've read a message</label>
      <span class="small muted">Shows "Seen" under messages in direct messages. You only see it for others while yours is on too.</span>
      ${notificationSettings()}
      ${voiceSettings()}
      ${soundSettings()}
      ${appSettings()}
    </section>
    <section data-pane="security" class="account-pane">
      <h3>Username</h3>
      <div id="username-box"></div>
      ${state.emailEnabled ? `<h3>Email</h3>${emailSettings()}` : ''}
      <h3>Password</h3>
      <form id="password-form">
        <input type="text" autocomplete="username" value="${escapeHtml(me.username)}" hidden />
        <label>Current password<input type="password" id="pw-current" autocomplete="current-password" required /></label>
        <label>New password<input type="password" id="pw-new" autocomplete="new-password" minlength="8" required /></label>
        <label>New password again<input type="password" id="pw-confirm" autocomplete="new-password" minlength="8" required /></label>
        <span class="small muted">This logs you out on your other devices.</span>
        <div class="error" id="pw-status"></div>
        <div class="modal-row"><button type="submit" class="btn">Change password</button></div>
      </form>
      <h3>Two-step login</h3>
      <div id="two-step-box"></div>
      <h3>Passkeys</h3>
      <div id="passkey-box"></div>
      <h3>Your devices</h3>
      <div id="device-box"><span class="small muted">Loading…</span></div>
    </section>
    <section data-pane="data" class="account-pane">
      <p class="small muted">What Peiskos keeps and who can see it: <a href="${escapeHtml(legalUrl('privacy'))}" target="_blank" rel="noopener">Privacy policy</a> · <a href="${escapeHtml(legalUrl('terms'))}" target="_blank" rel="noopener">Terms</a></p>
      <h3>Export my data</h3>
      <p class="small muted">A zip with your account details, every message you've sent (as JSON) and the files you sent.</p>
      <div><button type="button" class="btn secondary" id="export-btn">Download my data</button></div>
      <div class="error" id="export-error"></div>
      <h3>Delete my account</h3>
      <form id="delete-form" class="danger-zone">
        <p class="small muted">You'll leave every hearth and group. Hearths you host with other people in them need a new host first.</p>
        <label class="check"><input type="radio" name="delete-messages" value="keep" checked /> Keep my messages, shown as from "Deleted user"</label>
        <label class="check"><input type="radio" name="delete-messages" value="delete" /> Delete my messages and files too</label>
        <input type="text" autocomplete="username" value="${escapeHtml(me.username)}" hidden />
        <label>Password<input type="password" id="delete-password" autocomplete="current-password" required /></label>
        ${me.twoStep ? '<label>Code from your authenticator app<input id="delete-code" inputmode="numeric" autocomplete="one-time-code" maxlength="11" required /></label>' : ''}
        <div class="error" id="delete-error"></div>
        <div class="modal-row"><button type="submit" class="btn danger">Delete my account</button></div>
      </form>
    </section>
    <div class="modal-row"><button type="button" class="btn secondary" data-close>Close</button></div>`, 'account-modal');
  const show = (id) => {
    if (!ACCOUNT_TABS.some(([t]) => t === id)) id = 'profile';
    store.set('accountTab', id);
    for (const b of document.querySelectorAll('#modal-card [data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === id));
    for (const p of document.querySelectorAll('#modal-card [data-pane]')) p.classList.toggle('hidden', p.dataset.pane !== id);
    if (id === 'security') loadDevices();
  };
  for (const b of document.querySelectorAll('#modal-card [data-tab]')) b.onclick = () => show(b.dataset.tab);
  show(tab);
  wireProfileSettings();
  wireThemeSettings();
  $('#read-receipts').onchange = async (e) => {
    try { state.me.readReceipts = (await api('/api/me', { method: 'PATCH', body: { readReceipts: e.target.checked } })).readReceipts; }
    catch (err) { e.target.checked = !e.target.checked; alertError(err); }
  };
  wireNotificationSettings();
  wireVoiceSettings();
  wireSoundSettings();
  wireDisplaySettings();
  wireAppSettings();
  renderUsernameBox();
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
  renderTwoStepBox();
  renderPasskeyBox();
  $('#export-btn').onclick = exportMyData;
  $('#delete-form').onsubmit = deleteMyAccount;
}

function wireProfileSettings() {
  const me = state.me;
  const preview = () => {
    const box = $('#profile-preview');
    if (!box) return;
    const accent = $('#profile-accent-off').checked ? null : $('#profile-accent').value;
    box.replaceChildren(profileHeader({ ...me, displayName: $('#profile-name').value.trim() || null, bio: $('#profile-bio').value, accent, birthday: readBirthday() }, null));
  };
  preview();
  for (const id of ['#profile-bday-month', '#profile-bday-day']) $(id).addEventListener('change', preview);
  for (const id of ['#profile-name', '#profile-bio', '#profile-accent']) $(id).addEventListener('input', () => {
    if (id === '#profile-accent') $('#profile-accent-off').checked = false;
    preview();
  });
  $('#profile-accent-off').onchange = preview;
  $('#profile-form').onsubmit = async (e) => {
    e.preventDefault();
    $('#profile-error').textContent = '';
    try {
      Object.assign(state.me, await api('/api/me', {
        method: 'PATCH',
        body: { displayName: $('#profile-name').value, bio: $('#profile-bio').value, birthday: readBirthday(), accent: $('#profile-accent-off').checked ? null : $('#profile-accent').value },
      }));
      $('#me-name').textContent = state.me.displayName || state.me.username;
      toast('Profile saved.');
    } catch (err) { $('#profile-error').textContent = err.message; }
  };
  if (!state.maxUploadBytes) return;
  setAvatar($('#account-avatar'), me.username, me.avatar);
  $('#avatar-remove').classList.toggle('hidden', !me.avatar);
  $('#avatar-pick').onclick = () => $('#avatar-input').click();
  $('#avatar-input').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    $('#avatar-error').textContent = '';
    $('#avatar-pick').disabled = true;
    $('#avatar-pick').textContent = 'Uploading…';
    try { applyUser(await uploadPicture('/api/me/avatar', await squarePicture(file))); preview(); }
    catch (err) { $('#avatar-error').textContent = err.message; }
    finally { $('#avatar-pick').disabled = false; $('#avatar-pick').textContent = 'Upload picture'; }
  };
  $('#avatar-remove').onclick = async () => {
    try { applyUser(await api('/api/me/avatar', { method: 'DELETE' })); preview(); }
    catch (err) { $('#avatar-error').textContent = err.message; }
  };
  const bannerDone = (me2) => {
    Object.assign(state.me, me2);
    $('#banner-pick').textContent = state.me.banner ? 'Change banner' : 'Add a banner';
    $('#banner-remove').classList.toggle('hidden', !state.me.banner);
    preview();
  };
  $('#banner-pick').onclick = () => $('#banner-input').click();
  $('#banner-input').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    $('#avatar-error').textContent = '';
    $('#banner-pick').disabled = true;
    try { bannerDone(await uploadPicture('/api/me/banner', await bannerPicture(file))); }
    catch (err) { $('#avatar-error').textContent = err.message; }
    finally { $('#banner-pick').disabled = false; }
  };
  $('#banner-remove').onclick = async () => {
    try { bannerDone(await api('/api/me/banner', { method: 'DELETE' })); } catch (err) { $('#avatar-error').textContent = err.message; }
  };
}

// The fields that need your password (and code, with two-step login on) before a big change.
function confirmFields(prefix) {
  return `<input type="text" autocomplete="username" value="${escapeHtml(state.me.username)}" hidden />
    <label>Your password<input type="password" id="${prefix}-password" autocomplete="current-password" required /></label>
    ${state.me.twoStep ? `<label>Code from your authenticator app<input id="${prefix}-code" inputmode="numeric" autocomplete="one-time-code" maxlength="11" required /></label>` : ''}`;
}
const confirmValues = (prefix) => ({ password: $(`#${prefix}-password`)?.value ?? '', code: $(`#${prefix}-code`)?.value.trim() ?? '' });

function renderUsernameBox(editing = false) {
  const box = $('#username-box');
  if (!box) return;
  if (!editing) {
    box.innerHTML = `<div class="setting-row"><span>You log in as <b>${escapeHtml(state.me.username)}</b></span><button type="button" class="btn secondary" id="username-edit">Change</button></div>`;
    $('#username-edit').onclick = () => renderUsernameBox(true);
    return;
  }
  box.innerHTML = `<form id="username-form">
    <label>New username<input id="username-new" maxlength="32" pattern="[A-Za-z0-9_.\\-]+" value="${escapeHtml(state.me.username)}" required /></label>
    <span class="small muted">Letters, numbers, _ . and -. People will @mention you by the new one; old mentions of the old one stop pinging you.</span>
    ${confirmFields('username')}
    <div class="error" id="username-error"></div>
    <div class="modal-row"><button type="button" class="btn secondary" id="username-cancel">Cancel</button><button type="submit" class="btn">Change username</button></div>
  </form>`;
  $('#username-new').select();
  $('#username-cancel').onclick = () => renderUsernameBox(false);
  $('#username-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      applyUser(await api('/api/me/username', { method: 'POST', body: { username: $('#username-new').value.trim(), ...confirmValues('username') } }));
      renderUsernameBox(false);
      toast(`You now log in as ${state.me.username}.`);
    } catch (err) { $('#username-error').textContent = err.message; }
  };
}

// Two-step login is a choice: off until you turn it on here.
function renderTwoStepBox(step = null) {
  const box = $('#two-step-box');
  if (!box) return;
  const me = state.me;
  if (step?.codes) {
    box.innerHTML = `<p class="small">Two-step login is on. Save these recovery codes somewhere safe. Each one works once, if you ever lose your phone.</p>
      <pre class="recovery-codes">${step.codes.map(escapeHtml).join('\n')}</pre>
      <div class="settings-buttons"><button type="button" class="btn secondary" id="codes-copy">Copy</button><button type="button" class="btn secondary" id="codes-save">Download</button><button type="button" class="btn" id="codes-done">I saved them</button></div>`;
    const text = `Peiskos recovery codes for ${me.username}\n\n${step.codes.join('\n')}\n`;
    $('#codes-copy').onclick = () => navigator.clipboard.writeText(text).then(() => toast('Copied.'), () => toast("Couldn't copy. Select them instead."));
    $('#codes-save').onclick = () => downloadBlob(new Blob([text], { type: 'text/plain' }), 'burrow-recovery-codes.txt');
    $('#codes-done').onclick = () => renderTwoStepBox();
    return;
  }
  if (step?.setup) {
    box.innerHTML = `<p class="small">Scan this with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy and others), then type the 6-digit code it shows.</p>
      <div class="qr-box" id="qr-box"></div>
      <details class="small"><summary>Can't scan it? Type this key instead</summary><code class="secret-key">${escapeHtml(step.setup.secret.replace(/(.{4})/g, '$1 ').trim())}</code></details>
      <form id="two-step-enable"><label>Code from the app<input id="two-step-new-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" required /></label>
      <div class="error" id="two-step-box-error"></div>
      <div class="modal-row"><button type="button" class="btn secondary" id="two-step-cancel">Cancel</button><button type="submit" class="btn">Turn on</button></div></form>`;
    drawQr($('#qr-box'), step.setup.uri);
    $('#two-step-new-code').focus();
    $('#two-step-cancel').onclick = () => renderTwoStepBox();
    $('#two-step-enable').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const r = await api('/api/me/two-step/enable', { method: 'POST', body: { code: $('#two-step-new-code').value.trim() } });
        Object.assign(state.me, r.me);
        renderTwoStepBox({ codes: r.recoveryCodes });
        resetDeleteForm();
      } catch (err) { $('#two-step-box-error').textContent = err.message; }
    };
    return;
  }
  if (step?.confirm) {
    const turningOff = step.confirm === 'off';
    box.innerHTML = `<form id="two-step-confirm">
      ${turningOff || step.confirm === 'codes' ? confirmFields('ts') : `<input type="text" autocomplete="username" value="${escapeHtml(me.username)}" hidden /><label>Your password<input type="password" id="ts-password" autocomplete="current-password" required /></label>`}
      <div class="error" id="two-step-box-error"></div>
      <div class="modal-row"><button type="button" class="btn secondary" id="two-step-cancel">Cancel</button>
      <button type="submit" class="btn ${turningOff ? 'danger' : ''}">${turningOff ? 'Turn off' : step.confirm === 'codes' ? 'Get new codes' : 'Next'}</button></div></form>`;
    $('#ts-password').focus();
    $('#two-step-cancel').onclick = () => renderTwoStepBox();
    $('#two-step-confirm').onsubmit = async (e) => {
      e.preventDefault();
      try {
        if (turningOff) {
          Object.assign(state.me, await api('/api/me/two-step/disable', { method: 'POST', body: confirmValues('ts') }));
          renderTwoStepBox();
          resetDeleteForm();
          toast('Two-step login is off.');
        } else if (step.confirm === 'codes') {
          const r = await api('/api/me/two-step/recovery', { method: 'POST', body: confirmValues('ts') });
          Object.assign(state.me, r.me);
          renderTwoStepBox({ codes: r.recoveryCodes });
        } else {
          renderTwoStepBox({ setup: await api('/api/me/two-step/setup', { method: 'POST', body: confirmValues('ts') }) });
        }
      } catch (err) { $('#two-step-box-error').textContent = err.message; }
    };
    return;
  }
  box.innerHTML = me.twoStep
    ? `<div class="setting-row"><span><b>On.</b> Logging in asks for a code from your authenticator app. ${me.recoveryCodesLeft} recovery code${me.recoveryCodesLeft === 1 ? '' : 's'} left.</span></div>
      <div class="settings-buttons"><button type="button" class="btn secondary" id="two-step-codes">New recovery codes</button><button type="button" class="btn secondary" id="two-step-off">Turn off</button></div>`
    : `<div class="setting-row"><span class="small muted">Optional. With it on, logging in with your password also asks for a code from an app on your phone.</span>
      <button type="button" class="btn secondary" id="two-step-on">Turn on</button></div>`;
  $('#two-step-on')?.addEventListener('click', () => renderTwoStepBox({ confirm: 'on' }));
  $('#two-step-off')?.addEventListener('click', () => renderTwoStepBox({ confirm: 'off' }));
  $('#two-step-codes')?.addEventListener('click', () => renderTwoStepBox({ confirm: 'codes' }));
}

// The delete form asks for a code only while two-step login is on.
function resetDeleteForm() {
  const form = $('#delete-form');
  if (!form) return;
  $('#delete-code')?.closest('label').remove();
  if (state.me.twoStep) $('#delete-password').closest('label').insertAdjacentHTML('afterend', '<label>Code from your authenticator app<input id="delete-code" inputmode="numeric" autocomplete="one-time-code" maxlength="11" required /></label>');
}

let qrLoading = null;
async function drawQr(box, text) {
  try {
    if (!window.qrcode) await (qrLoading ??= loadScript('vendor/qrcode.js'));
    const qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 3, scalable: true });
  } catch {
    box.textContent = "Couldn't draw the code. Type the key below instead.";
  }
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

async function renderPasskeyBox(adding = false) {
  const box = $('#passkey-box');
  if (!box) return;
  if (!passkeysWork()) {
    box.innerHTML = `<span class="small muted">${isApp
      ? 'Add passkeys from Peiskos in your web browser. You can then use them to log in there.'
      : "This browser can't use passkeys here."}</span>`;
    return;
  }
  if (adding) {
    box.innerHTML = `<form id="passkey-form">
      <span class="small muted">Log in with Face ID, Touch ID, Windows Hello, your phone or a security key instead of your password.</span>
      ${confirmFields('pk')}
      <label>Name (optional)<input id="pk-name" maxlength="40" placeholder="e.g. My laptop" /></label>
      <div class="error" id="pk-error"></div>
      <div class="modal-row"><button type="button" class="btn secondary" id="pk-cancel">Cancel</button><button type="submit" class="btn">Add passkey</button></div>
    </form>`;
    $('#pk-password').focus();
    $('#pk-cancel').onclick = () => renderPasskeyBox();
    $('#passkey-form').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const o = await api('/api/me/passkeys/options', { method: 'POST', body: confirmValues('pk') });
        const cred = await navigator.credentials.create({
          publicKey: {
            ...o,
            challenge: b64u.from(o.challenge),
            user: { ...o.user, id: b64u.from(o.user.id) },
            excludeCredentials: o.excludeCredentials.map((c) => ({ ...c, id: b64u.from(c.id) })),
          },
        });
        if (!cred) return;
        await api('/api/me/passkeys', {
          method: 'POST',
          body: { name: $('#pk-name').value, credential: { id: cred.id, response: { clientDataJSON: b64u.to(cred.response.clientDataJSON), attestationObject: b64u.to(cred.response.attestationObject) } } },
        });
        toast('Passkey added. Use "Log in with a passkey" next time.');
        renderPasskeyBox();
      } catch (err) {
        $('#pk-error').textContent = err.name === 'NotAllowedError' ? 'The passkey prompt was closed or timed out.' : err.name === 'InvalidStateError' ? 'This device already has a passkey for you.' : err.message;
      }
    };
    return;
  }
  let list = [];
  try { list = await api('/api/me/passkeys'); } catch {}
  box.innerHTML = `${list.length ? `<ul class="plain-list">${list.map((p) => `<li><span><b>${escapeHtml(p.name)}</b><span class="small muted"> · added ${escapeHtml(formatDay(p.createdAt))}${p.lastUsedAt ? ` · last used ${escapeHtml(formatDay(p.lastUsedAt))}` : ''}</span></span>
      <button type="button" class="link-btn danger-link" data-remove-passkey="${escapeHtml(p.id)}">Remove</button></li>`).join('')}</ul>`
    : '<span class="small muted">Log in with Face ID, Touch ID, Windows Hello, your phone or a security key instead of your password.</span>'}
    <div><button type="button" class="btn secondary" id="passkey-add">Add a passkey</button></div>`;
  $('#passkey-add').onclick = () => renderPasskeyBox(true);
  for (const b of box.querySelectorAll('[data-remove-passkey]')) b.onclick = async () => {
    if (!confirm('Remove this passkey? You can add it again later.')) return;
    try { await api(`/api/me/passkeys/${encodeURIComponent(b.dataset.removePasskey)}`, { method: 'DELETE' }); renderPasskeyBox(); } catch (err) { alertError(err); }
  };
}

const formatDay = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });

async function loadDevices() {
  const box = $('#device-box');
  if (!box) return;
  let list;
  try { list = await api('/api/me/sessions'); } catch (err) { box.innerHTML = `<span class="error">${escapeHtml(err.message)}</span>`; return; }
  const ago = (t) => {
    const m = Math.round((Date.now() - t) / 60000);
    return m < 60 ? 'in the last hour' : m < 1440 ? `${Math.round(m / 60)} hours ago` : formatDay(t);
  };
  box.innerHTML = `<ul class="plain-list device-list">${list.map((d) => `<li>
      <span><span><b>${escapeHtml(d.device)}</b>${d.current ? ' <span class="owner-badge">this device</span>' : ''}</span>
        <span class="small muted">${d.current || d.online ? 'Online now' : `Last used ${escapeHtml(ago(d.lastUsedAt))}`}${d.ip ? ` · ${escapeHtml(d.ip)}` : ''} · logged in ${escapeHtml(formatDay(d.createdAt))}</span></span>
      ${d.current ? '' : `<button type="button" class="link-btn danger-link" data-signout="${escapeHtml(d.id)}">Sign out</button>`}
    </li>`).join('')}</ul>
    ${list.length > 1 ? '<div><button type="button" class="btn secondary" id="signout-others">Sign out everywhere else</button></div>' : ''}`;
  for (const b of box.querySelectorAll('[data-signout]')) b.onclick = async () => {
    try { await api(`/api/me/sessions/${b.dataset.signout}`, { method: 'DELETE' }); loadDevices(); } catch (err) { alertError(err); }
  };
  $('#signout-others')?.addEventListener('click', async () => {
    if (!confirm('Sign out of Peiskos on every other device?')) return;
    try { await api('/api/me/sessions', { method: 'DELETE' }); toast('Signed out everywhere else.'); loadDevices(); } catch (err) { alertError(err); }
  });
}

async function exportMyData() {
  const b = $('#export-btn');
  $('#export-error').textContent = '';
  b.disabled = true;
  b.textContent = 'Packing it up…';
  try {
    const res = await fetch(state.serverUrl + '/api/me/export', { headers: { authorization: 'Bearer ' + state.token } });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Download failed (${res.status})`);
    downloadBlob(await res.blob(), `burrow-${state.me.username}.zip`);
  } catch (err) { $('#export-error').textContent = err.message; }
  finally { b.disabled = false; b.textContent = 'Download my data'; }
}

async function deleteMyAccount(e) {
  e.preventDefault();
  const deleteMessages = document.querySelector('input[name="delete-messages"]:checked').value === 'delete';
  $('#delete-error').textContent = '';
  if (!confirm(`Delete your Peiskos account${deleteMessages ? ' and everything you sent' : ''}? This can't be undone.`)) return;
  try {
    await api('/api/me', { method: 'DELETE', body: { password: $('#delete-password').value, code: $('#delete-code')?.value.trim() ?? '', deleteMessages } });
    closeModal();
    logout(false);
    $('#auth-error').textContent = 'Your account was deleted.';
  } catch (err) { $('#delete-error').textContent = err.message; }
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
    $('#reply-name').textContent = authorName(m);
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
  q.innerHTML = `<span class="reply-author">@${escapeHtml(r.author)}</span><span class="reply-text">${escapeHtml(snippet)}</span>`;
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
    b.title = r.userIds.map((id) => nameOfPerson(server?.members.find((x) => x.id === id))).join(', ');
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
  all.title = 'All emoji, and this hearth\'s own';
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
