// Running Burrow: the admin page for whoever hosts it (people, storage, voice, backups, signup
// links, updates and crash reports), a burrow's bots and webhooks, and slash commands in the
// message box.
// Part of Burrow's client: plain scripts that index.html loads in order, sharing one global scope.
'use strict';

const ago = (t) => {
  if (!t) return 'never';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} minutes ago`;
  if (s < 129600) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86400)} days ago`;
};
const dateText = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    if (button) { const was = button.textContent; button.textContent = 'Copied'; setTimeout(() => (button.textContent = was), 1500); }
  } catch {
    prompt('Copy this:', text);
  }
}

// ---------------------------------------------------------------- the admin page

const ADMIN_TABS = [['overview', 'Overview'], ['people', 'People'], ['signups', 'Signing up'], ['backups', 'Backups'], ['errors', 'Crashes']];
let adminData = null;
let adminTab = 'overview';
let updatePoll = null;

function syncAdminButton() {
  $('#admin-btn').classList.toggle('hidden', !state.me?.admin);
}

async function openAdmin(tab = adminTab) {
  adminTab = tab;
  modal(`<h2>Server admin</h2>
    <div class="tabs" role="tablist">${ADMIN_TABS.map(([id, label]) => `<button type="button" role="tab" data-tab="${id}">${label}</button>`).join('')}</div>
    <div id="admin-pane" class="admin-pane"><p class="muted">Loading…</p></div>
    <div class="modal-row"><button type="button" class="btn secondary" data-close>Close</button></div>`, 'admin-modal');
  onModalClose = () => { clearInterval(updatePoll); updatePoll = null; };
  for (const b of document.querySelectorAll('#modal-card [data-tab]')) b.onclick = () => showAdminTab(b.dataset.tab);
  try {
    adminData = await api('/api/admin');
  } catch (err) {
    $('#admin-pane').textContent = err.message;
    return;
  }
  showAdminTab(adminTab);
}

function showAdminTab(tab) {
  adminTab = tab;
  for (const b of document.querySelectorAll('#modal-card [data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  const pane = $('#admin-pane');
  if (!pane || !adminData) return;
  ({ overview: adminOverview, people: adminPeople, signups: adminSignups, backups: adminBackups, errors: adminErrors })[tab](pane);
}

function adminOverview(pane) {
  const d = adminData;
  const st = d.storage;
  const u = d.updater;
  const people = d.users.filter((x) => !x.bot);
  const online = people.filter((x) => x.online).length;
  const update = !u?.running
    ? `<p class="small muted">Updates are installed over SSH. To install them from here instead, turn on the updater: see "Updating from the admin page" in the README.</p>`
    : u.updating ? '<p><b>Updating…</b> Peiskos restarts by itself when it\'s done; this page reloads.</p>'
    : u.behind ? `<p><b>A new version is out</b> (${u.behind} change${u.behind === 1 ? '' : 's'}).</p>
        <ul class="small update-changes">${u.changes.slice(0, 8).map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>
        <div><button type="button" class="btn" id="admin-update">Update now</button></div>
        <p class="small muted">Peiskos is away for a minute or two while it rebuilds; voice calls reconnect after.</p>`
    : `<p class="small muted">Up to date (${escapeHtml(u.commit)}, ${dateText(u.commitDate * 1000)}). Last checked ${ago(u.checkedAt * 1000)}.</p>`;
  const result = u?.result === 'failed' ? `<p class="error">The last update didn't finish (${ago(u.resultAt * 1000)}). Its log is in the data folder: updater/log.txt.</p>` : '';
  pane.innerHTML = `
    <div class="admin-stats">
      <div><b>${people.length}</b><span>people</span></div>
      <div><b>${online}</b><span>online now</span></div>
      <div><b>${d.counts.burrows}</b><span>hearths</span></div>
      <div><b>${d.counts.messages.toLocaleString()}</b><span>messages</span></div>
    </div>
    <h3>Checks</h3>
    <ul class="admin-checks">${d.checks.map((c) => `<li class="${c.ok ? 'ok' : 'warn'}"><span aria-hidden="true">${c.ok ? '✓' : '!'}</span>${escapeHtml(c.text)}</li>`).join('')}</ul>
    <h3>Updates</h3>${result}${update}
    <h3>Storage</h3>
    <dl class="admin-list">
      <dt>Uploaded files</dt><dd>${formatSize(st.uploads)} (${d.counts.files.toLocaleString()} files)</dd>
      ${st.database != null ? `<dt>Database</dt><dd>${formatSize(st.database)}</dd>` : ''}
      ${st.backups != null ? `<dt>Backups on this server</dt><dd>${formatSize(st.backups)}</dd>` : ''}
      ${st.free != null ? `<dt>Free disk space</dt><dd>${formatSize(st.free)} of ${formatSize(st.total)}${st.free < st.total * 0.1 ? ' <b class="error">(running low)</b>' : ''}</dd>` : ''}
    </dl>
    <div class="admin-row"><button type="button" class="btn secondary" id="admin-cleanup">Clean up unused files</button><span class="small muted" id="admin-cleanup-note">Files from deleted messages, hearths and pictures. This also runs by itself every day.</span></div>
    <h3>In voice now</h3>
    ${d.voice.length ? `<ul class="admin-voice">${d.voice.map((v) => `<li><b>${escapeHtml(v.burrow)}</b> · ${escapeHtml(v.room)}: ${v.people.map(escapeHtml).join(', ')}</li>`).join('')}</ul>` : '<p class="small muted">Nobody.</p>'}
    <p class="small muted">Peiskos started ${ago(d.startedAt)}.</p>`;
  $('#admin-cleanup').onclick = async (e) => {
    e.target.disabled = true;
    try {
      const r = await api('/api/admin/cleanup', { method: 'POST', body: {} });
      $('#admin-cleanup-note').textContent = r.files ? `Removed ${r.files} file${r.files === 1 ? '' : 's'}, ${formatSize(r.bytes)}.` : 'Nothing to clean up.';
    } catch (err) { alertError(err); }
    e.target.disabled = false;
  };
  const go = $('#admin-update');
  if (go) go.onclick = async () => {
    if (!confirm('Update Peiskos now? It goes away for a minute or two while it rebuilds.')) return;
    try {
      adminData.updater = (await api('/api/admin/update', { method: 'POST' })).updater;
      adminData.updater.updating = true;
      showAdminTab('overview');
      watchUpdate();
    } catch (err) { alertError(err); }
  };
  if (u?.updating || u?.requested) watchUpdate();
}

// While updating: check now and then; once Burrow is back on a new version, reload.
function watchUpdate() {
  if (updatePoll) return;
  const from = adminData.updater?.commit;
  updatePoll = setInterval(async () => {
    const r = await api('/api/admin/update').catch(() => null);
    if (!r?.updater) return; // Burrow is restarting
    if (r.updater.commit !== from && !r.updater.updating) { clearInterval(updatePoll); location.reload(); return; }
    if (!r.updater.updating && !r.updater.requested && r.updater.result === 'failed') {
      clearInterval(updatePoll);
      updatePoll = null;
      adminData.updater = r.updater;
      if ($('#admin-pane')) showAdminTab('overview');
    }
  }, 4000);
}

function adminPeople(pane) {
  const rows = adminData.users.map((u) => `<tr data-id="${u.id}">
      <td><b>${escapeHtml(u.displayName || u.username)}</b>${u.bot ? ' <span class="bot-tag">BOT</span>' : ''}${u.admin ? ' <span class="small muted">admin</span>' : ''}<br><span class="small muted">@${escapeHtml(u.username)}${u.twoStep ? ' · two-step' : ''}</span></td>
      <td class="small">${u.online ? '<b>Online</b>' : ago(u.lastSeen)}<br><span class="muted">joined ${dateText(u.createdAt)}</span></td>
      <td class="small">${u.messages.toLocaleString()} msgs<br><span class="muted">${formatSize(u.storage)}</span></td>
      <td>${u.bot ? '' : `<button type="button" class="btn secondary tiny-btn" data-act="reset">Reset link</button>${u.id === state.me.id ? '' : ' <button type="button" class="btn secondary tiny-btn" data-act="out">Log out</button>'}`}</td>
    </tr>`);
  pane.innerHTML = `<p class="small muted">Everyone with an account here. A reset link lets someone who's locked out choose a new password (it works once, for an hour). Log out signs them out on every device.</p>
    <div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Who</th><th>Last seen</th><th>Sent</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  for (const b of pane.querySelectorAll('button[data-act]')) {
    const id = Number(b.closest('tr').dataset.id);
    const u = adminData.users.find((x) => x.id === id);
    b.onclick = async () => {
      try {
        if (b.dataset.act === 'reset') {
          const r = await api(`/api/admin/users/${id}/reset-link`, { method: 'POST' });
          await copyText(r.url);
          toast(`Reset link for ${r.username} copied. Send it to them; it works once, for the next hour.`, { timeout: 8000 });
        } else if (confirm(`Log ${u.username} out on all their devices?`)) {
          await api(`/api/admin/users/${id}/sign-out`, { method: 'POST' });
          toast(`${u.username} is logged out everywhere.`);
        }
      } catch (err) { alertError(err); }
    };
  }
}

const signupUrl = (code) => `${isDesktop ? state.serverUrl : location.origin}/?signup=${code}`;
function adminSignups(pane) {
  const s = adminData.signup;
  const linkRow = (l) => `<li class="${l.used ? 'used' : ''}" data-code="${escapeHtml(l.code)}">
      <span class="signup-text"><b>${escapeHtml(l.note || 'Signup link')}</b><span class="small muted">${l.uses} of ${l.maxUses} used · ${l.expiresAt ? (l.expiresAt > Date.now() ? `runs out ${dateText(l.expiresAt)}` : 'ran out') : 'never runs out'}${l.createdBy ? ` · by ${escapeHtml(l.createdBy)}` : ''}</span></span>
      ${l.used ? '' : '<button type="button" class="btn secondary tiny-btn" data-act="copy">Copy</button>'}
      <button type="button" class="icon-btn" data-act="delete" title="Delete this link">✕</button>
    </li>`;
  pane.innerHTML = `<h3>Who can sign up</h3>
    <label class="check"><input type="radio" name="signup-mode" value="links" ${s.mode === 'links' ? 'checked' : ''} /> Only people with a signup link</label>
    <label class="check"><input type="radio" name="signup-mode" value="code" ${s.mode === 'code' ? 'checked' : ''} ${s.codeSet ? '' : 'disabled'} /> People with the registration code${s.codeSet ? '' : ' (set REGISTRATION_CODE in .env)'}, or a link</label>
    <label class="check"><input type="radio" name="signup-mode" value="open" ${s.mode === 'open' ? 'checked' : ''} /> Anyone who finds this server</label>
    <h3>Signup links</h3>
    <p class="small muted">Each link is for one person (or a few), and stops working once it's used or runs out, so the registration code never has to be shared.</p>
    <form id="signup-new" class="signup-new">
      <input id="signup-note" maxlength="60" placeholder="Who it's for (only you see this)" />
      <select id="signup-uses"><option value="1">1 person</option><option value="5">5 people</option><option value="20">20 people</option></select>
      <select id="signup-days"><option value="7">for a week</option><option value="1">for a day</option><option value="30">for a month</option><option value="">forever</option></select>
      <button type="submit" class="btn">Make a link</button>
    </form>
    <ul class="signup-links">${s.links.map(linkRow).join('') || '<li class="small muted">No links yet.</li>'}</ul>`;
  for (const r of pane.querySelectorAll('[name="signup-mode"]')) r.onchange = async () => {
    try { s.mode = (await api('/api/admin/settings', { method: 'PATCH', body: { signupMode: r.value } })).signupMode; } catch (err) { alertError(err); adminSignups(pane); }
  };
  $('#signup-new').onsubmit = async (e) => {
    e.preventDefault();
    const days = $('#signup-days').value;
    try {
      const r = await api('/api/admin/signup-links', { method: 'POST', body: { note: $('#signup-note').value, uses: Number($('#signup-uses').value), days: days ? Number(days) : null } });
      s.links = r.links;
      adminSignups(pane);
      await copyText(signupUrl(r.links[0].code));
      toast('Signup link copied. Send it to them.');
    } catch (err) { alertError(err); }
  };
  for (const b of pane.querySelectorAll('[data-act]')) {
    const code = b.closest('li').dataset.code;
    b.onclick = async () => {
      if (b.dataset.act === 'copy') return copyText(signupUrl(code), b);
      try { s.links = (await api(`/api/admin/signup-links/${code}`, { method: 'DELETE' })).links; adminSignups(pane); } catch (err) { alertError(err); }
    };
  }
}

function adminBackups(pane) {
  const b = adminData.backups;
  if (!b) return (pane.innerHTML = '<p class="muted">Backups aren\'t available on this server.</p>');
  const off = b.offsite;
  pane.innerHTML = `<p class="small muted">${b.keep > 0 ? `Peiskos copies its database every day and keeps the last ${b.keep}.` : 'Daily backups are off (BACKUP_KEEP is 0).'} Restoring one puts every message, hearth and account back the way it was that day; anything newer is lost (the current database is kept on the server, just in case). Peiskos restarts to do it.</p>
    <ul class="backup-list">${b.local.map((x) => `<li data-name="${escapeHtml(x.name)}"><span><b>${escapeHtml(x.name.slice(7, 17))}</b> <span class="small muted">${formatSize(x.size)}</span></span><button type="button" class="btn secondary tiny-btn">Restore</button></li>`).join('') || '<li class="small muted">No backups yet. The first is made a minute after Peiskos starts.</li>'}</ul>
    <div class="admin-row"><button type="button" class="btn secondary" id="backup-now">Back up now</button></div>
    <h3>Off-site copies</h3>
    ${off ? `<p class="small">Copied to <b>${escapeHtml(off.bucket)}</b>. ${off.lastOk ? `Last copy ${ago(off.lastOk)}, ${off.files ?? 0} uploaded files so far.` : 'Not copied yet.'}</p>
      ${off.lastError && (off.lastErrorAt ?? 0) > (off.lastOk ?? 0) ? `<p class="error small">The last copy failed: ${escapeHtml(off.lastError)}</p>` : ''}`
      : '<p class="small muted">Off. If this server\'s disk dies, the backups go with it. See "Off-site backups" in the README to copy them to Backblaze, Cloudflare R2 or Amazon S3 each day.</p>'}`;
  $('#backup-now').onclick = async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Backing up…';
    try { adminData.backups = await api('/api/admin/backups', { method: 'POST' }); adminBackups(pane); toast('Backed up.'); } catch (err) { alertError(err); e.target.disabled = false; }
  };
  for (const li of pane.querySelectorAll('.backup-list li[data-name]')) {
    li.querySelector('button').onclick = async () => {
      const day = li.dataset.name.slice(7, 17);
      if (!confirm(`Put Peiskos back to ${day}? Everything since then (messages, accounts, hearths) is undone for everyone. Peiskos restarts, and is back in under a minute.`)) return;
      try {
        await api('/api/admin/backups/restore', { method: 'POST', body: { name: li.dataset.name } });
        pane.innerHTML = '<p><b>Restoring…</b> Peiskos is restarting. This page reloads when it\'s back.</p>';
        const wait = setInterval(async () => {
          if (await fetch(state.serverUrl + '/api/health').then((r) => r.ok, () => false)) { clearInterval(wait); setTimeout(() => location.reload(), 1500); }
        }, 2000);
      } catch (err) { alertError(err); }
    };
  }
}

async function adminErrors(pane) {
  pane.innerHTML = '<p class="muted">Loading…</p>';
  let errors = [];
  try { errors = (await api('/api/admin/errors')).errors; } catch (err) { pane.textContent = err.message; return; }
  pane.innerHTML = `<p class="small muted">Crashes in people's apps, the same one counted once. Just the error and where; nothing anyone typed.</p>
    ${errors.length ? `<ul class="error-list">${errors.map((e) => `<li><details><summary><b>${escapeHtml(e.message)}</b><span class="small muted"> · ${e.count}× · last ${ago(e.lastAt)}${e.username ? ` · ${escapeHtml(e.username)}` : ''}</span></summary>
        <pre class="small">${escapeHtml(e.where)}\n${escapeHtml(e.stack)}\n\n${escapeHtml(e.app)}</pre></details></li>`).join('')}</ul>
      <div class="admin-row"><button type="button" class="btn secondary" id="errors-clear">Clear the list</button></div>` : '<p>No crashes reported.</p>'}`;
  $('#errors-clear')?.addEventListener('click', async () => {
    try { await api('/api/admin/errors', { method: 'DELETE' }); adminData.errors = 0; adminErrors(pane); } catch (err) { alertError(err); }
  });
}

$('#admin-btn').onclick = () => openAdmin();

// ---------------------------------------------------------------- bots and webhooks

async function openBots(serverId) {
  const s = state.servers.get(serverId);
  modal(`<h2>Bots and webhooks</h2>
    <p class="small muted"><b>Webhooks</b> let other services post in a room: GitHub, a home server, a script. They send a message to a web address.
      <b>Bots</b> are programs with their own account in this hearth; they use Peiskos's API with a token. See "Bots and webhooks" in the README.</p>
    <h3>Webhooks</h3>
    <ul class="bot-list" id="webhook-list"></ul>
    <form id="webhook-new" class="bot-new">
      <input id="webhook-name" maxlength="32" placeholder="Name, e.g. GitHub" required />
      <select id="webhook-room">${s.channels.filter((c) => c.kind === 'text' && !c.archived).map((c) => `<option value="${c.id}" ${c.id === state.channelId ? 'selected' : ''}>#${escapeHtml(c.name)}</option>`).join('')}</select>
      <button type="submit" class="btn">Add webhook</button>
    </form>
    <h3>Bots</h3>
    <ul class="bot-list" id="bot-list"></ul>
    <form id="bot-new" class="bot-new">
      <input id="bot-name" maxlength="32" placeholder="Name, e.g. Dice bot" required />
      <button type="submit" class="btn">Add bot</button>
    </form>
    <div id="bot-secret" class="bot-secret hidden"></div>
    <div class="modal-row"><button type="button" class="btn secondary" data-close>Close</button></div>`, 'bots-modal');
  const showSecret = (title, value, note) => {
    const box = $('#bot-secret');
    box.classList.remove('hidden');
    box.innerHTML = `<b>${escapeHtml(title)}</b><code>${escapeHtml(value)}</code><span class="small muted">${escapeHtml(note)}</span><button type="button" class="btn secondary tiny-btn">Copy</button>`;
    box.querySelector('button').onclick = (e) => copyText(value, e.target);
  };
  const render = (data) => {
    $('#webhook-list').replaceChildren(...data.webhooks.map((w) => {
      const li = document.createElement('li');
      const room = s.channels.find((c) => c.id === w.channelId);
      li.innerHTML = `<span><span><b>${escapeHtml(w.name)}</b><span class="bot-tag">BOT</span></span><span class="small muted">posts in #${escapeHtml(room?.name ?? '?')}</span></span>`;
      li.append(Object.assign(document.createElement('button'), {
        type: 'button', className: 'btn secondary tiny-btn', textContent: 'Delete',
        onclick: async () => { if (confirm(`Delete the ${w.name} webhook? Anything using its address stops working.`)) try { render(await api(`/api/webhooks/${w.id}`, { method: 'DELETE' })); } catch (err) { alertError(err); } },
      }));
      return li;
    }));
    if (!data.webhooks.length) $('#webhook-list').innerHTML = '<li class="small muted">None yet.</li>';
    $('#bot-list').replaceChildren(...data.bots.map((b) => {
      const li = document.createElement('li');
      li.innerHTML = `<span><span><b>${escapeHtml(b.name)}</b><span class="bot-tag">BOT</span></span><span class="small muted">@${escapeHtml(b.username)} · last used ${ago(b.lastUsed)}</span></span>`;
      li.append(
        Object.assign(document.createElement('button'), {
          type: 'button', className: 'btn secondary tiny-btn', textContent: 'New token',
          onclick: async () => {
            if (!confirm(`Make a new token for ${b.name}? The old one stops working.`)) return;
            try { showSecret(`${b.name}'s new token`, (await api(`/api/servers/${serverId}/bots/${b.id}/token`, { method: 'POST' })).token, 'Shown only now. Keep it secret: it lets a program post as this bot.'); } catch (err) { alertError(err); }
          },
        }),
        Object.assign(document.createElement('button'), {
          type: 'button', className: 'btn secondary tiny-btn', textContent: 'Remove',
          onclick: async () => { if (confirm(`Remove ${b.name}? Its messages stay.`)) try { render(await api(`/api/servers/${serverId}/bots/${b.id}`, { method: 'DELETE' })); } catch (err) { alertError(err); } },
        }),
      );
      return li;
    }));
    if (!data.bots.length) $('#bot-list').innerHTML = '<li class="small muted">None yet.</li>';
  };
  $('#webhook-new').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api(`/api/channels/${$('#webhook-room').value}/webhooks`, { method: 'POST', body: { name: $('#webhook-name').value } });
      render(r);
      $('#webhook-name').value = '';
      showSecret('Webhook address', r.url, 'Shown only now. Anything that has it can post in that room. POST JSON like {"content": "Hello"} to it.');
    } catch (err) { alertError(err); }
  };
  $('#bot-new').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api(`/api/servers/${serverId}/bots`, { method: 'POST', body: { name: $('#bot-name').value } });
      render(r);
      $('#bot-name').value = '';
      showSecret('Bot token', r.token, 'Shown only now. Keep it secret: it lets a program post as this bot. Send it as "Authorization: Bearer <token>".');
    } catch (err) { alertError(err); }
  };
  try { render(await api(`/api/servers/${serverId}/bots`)); } catch (err) { alertError(err); }
}

// ---------------------------------------------------------------- slash commands

const SLASH_COMMANDS = [
  { name: 'roll', args: '2d6', about: 'Roll dice (d20, 3d8+2…)' },
  { name: 'flip', args: '', about: 'Flip a coin' },
  { name: 'poll', args: 'Question | answer | answer', about: 'Make a poll' },
  { name: 'gif', args: 'cats', about: 'Find a GIF', needs: () => state.gifsEnabled },
  { name: 'giphy', args: 'cats', about: 'Find a GIF (same as /gif)', needs: () => state.gifsEnabled, hidden: true },
  { name: 'me', args: 'waves', about: 'Say what you do, in italics' },
  { name: 'shrug', args: '', about: 'Add ¯\\_(ツ)_/¯' },
  { name: 'spoiler', args: 'text', about: 'Hide it until clicked' },
];
const commandBox = $('#command-box');
let commandPick = null; // { matches, index } while the list is open

function updateCommands() {
  const m = /^\/(\w*)$/.exec(input.value);
  if (!m || input.selectionStart !== input.value.length) return closeCommands();
  const q = m[1].toLowerCase();
  const matches = SLASH_COMMANDS.filter((c) => !c.hidden && (!c.needs || c.needs()) && c.name.startsWith(q));
  if (!matches.length) return closeCommands();
  commandPick = { matches, index: Math.min(commandPick?.index ?? 0, matches.length - 1) };
  commandBox.replaceChildren(...matches.map((c, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mention-option' + (i === commandPick.index ? ' active' : '');
    b.innerHTML = `<span class="command-name">/${c.name}${c.args ? ` <span class="muted">${escapeHtml(c.args)}</span>` : ''}</span><span class="small muted">${escapeHtml(c.about)}</span>`;
    b.onpointerdown = (e) => e.preventDefault();
    b.onclick = () => { commandPick.index = i; completeCommand(); };
    return b;
  }));
  commandBox.classList.remove('hidden');
}
function closeCommands() {
  commandPick = null;
  commandBox.classList.add('hidden');
}
function completeCommand() {
  const c = commandPick.matches[commandPick.index];
  input.value = `/${c.name}${c.args ? ' ' : ''}`;
  closeCommands();
  input.focus();
  // Nothing more to type: send it.
  if (!c.args) sendComposer();
}
input.addEventListener('input', updateCommands);
input.addEventListener('blur', () => setTimeout(closeCommands, 100));
input.addEventListener('keydown', (e) => {
  if (commandPick) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopImmediatePropagation();
      commandPick.index = (commandPick.index + (e.key === 'ArrowDown' ? 1 : -1) + commandPick.matches.length) % commandPick.matches.length;
      return updateCommands();
    }
    if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault();
      e.stopImmediatePropagation();
      return completeCommand();
    }
    if (e.key === 'Escape') { e.stopImmediatePropagation(); return closeCommands(); }
  }
  if (e.key !== 'Enter' || e.shiftKey) return;
  // Commands the app does itself: GIF search, and /poll on its own opens the poll maker.
  const gifQuery = /^\/(gif|giphy)(?:\s+(.*))?$/i.exec(input.value.trim());
  if (gifQuery && state.gifsEnabled) {
    e.preventDefault();
    e.stopImmediatePropagation();
    input.value = '';
    autosize();
    if (gifPicker.classList.contains('hidden')) toggleGifPicker();
    gifSearch.value = gifQuery[2] ?? '';
    loadGifs(gifSearch.value.trim());
    return;
  }
  if (/^\/poll\s*$/i.test(input.value)) {
    e.preventDefault();
    e.stopImmediatePropagation();
    input.value = '';
    openPollCreator();
  }
}, true);
