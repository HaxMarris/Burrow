// Presence and notifications, hotkeys, managing voice, the soundboard, listening together, calls.
// Part of Burrow's client: plain scripts that index.html loads in order, sharing one global scope.
'use strict';

// ---------------------------------------------------------------- presence, status and notifications
//
// Your status (online, away or do not disturb), a custom status, what the desktop app sees you
// playing, the mentions inbox, the number on the app icon, quiet hours, alerts while Burrow is
// closed (push), and the email address that resets a forgotten password.

const STATUS_LABELS = { online: 'Online', away: 'Away', dnd: 'Do not disturb', offline: 'Offline' };
const statusOf = (m) => (!m.online ? 'offline' : m.status && m.status !== 'offline' ? m.status : 'online');
const customLive = (c) => !!c && (c.text || c.emoji) && (!c.until || c.until > Date.now());

/** The line under someone's name: their custom status, else what they're playing. */
function presenceLine(m, both = false) {
  const parts = [];
  if (customLive(m.custom)) parts.push(`${m.custom.emoji ? `<span class="status-emoji">${emojiHtml(m.custom.emoji)}</span>` : ''}${escapeHtml(m.custom.text)}`);
  if (m.online && m.activity && (both || !parts.length)) parts.push(`<span class="playing">${GAME_ICON}Playing <b>${escapeHtml(m.activity.name)}</b></span>`);
  return parts.join(both ? '<br>' : '');
}
const GAME_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10a5 5 0 0 1 4.9 6l-.7 3.4a2.6 2.6 0 0 1-4.5 1.2L14.5 15h-5l-2.2 2.6a2.6 2.6 0 0 1-4.5-1.2L2.1 13A5 5 0 0 1 7 7Zm0 3v1.5H5.5v1.5H7v1.5h1.5V13H10v-1.5H8.5V10H7Zm9 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm2 2a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z"/></svg>';

function renderMyStatus() {
  if (!state.me) return;
  const mine = state.me.status ?? 'online';
  for (const id of ['#me-dot', '#tab-dot']) $(id).className = `status-dot ${mine}`;
  for (const b of document.querySelectorAll('#me-menu [data-status]')) b.setAttribute('aria-checked', String(b.dataset.status === mine));
  const c = state.me.customStatus;
  $('#custom-status-btn').innerHTML = customLive(c)
    ? `<span class="custom-now">${c.emoji ? emojiHtml(c.emoji) : ''} ${escapeHtml(c.text)}</span><span class="small muted">Change or clear your status</span>`
    : 'Set a custom status';
  $('#me-btn').title = `You · ${STATUS_LABELS[mine]}`;
}

async function setMyStatus(status) {
  try { Object.assign(state.me, await api('/api/me', { method: 'PATCH', body: { status } })); renderMyStatus(); }
  catch (err) { alertError(err); }
}

const CLEAR_AFTER = [['', "Don't clear"], ['30', '30 minutes'], ['60', '1 hour'], ['240', '4 hours'], ['today', 'Today'], ['week', 'This week']];
function clearTime(choice) {
  if (!choice) return null;
  if (choice === 'today') { const d = new Date(); d.setHours(23, 59, 59, 0); return d.getTime(); }
  if (choice === 'week') { const d = new Date(); d.setDate(d.getDate() + ((7 - d.getDay()) % 7)); d.setHours(23, 59, 59, 0); return d.getTime(); }
  return Date.now() + Number(choice) * 60_000;
}

function openCustomStatus() {
  const c = customLive(state.me.customStatus) ? state.me.customStatus : null;
  let emoji = c?.emoji ?? '';
  modal(`<h2>Custom status</h2>
    <form id="status-form">
      <div class="status-row">
        <button type="button" class="btn secondary status-emoji-btn" id="status-emoji" title="Pick an emoji" aria-label="Pick an emoji"></button>
        <input id="status-text" maxlength="80" placeholder="What's happening?" autocomplete="off" value="${escapeHtml(c?.text ?? '')}" />
      </div>
      <div class="status-ideas">${['🎮 Playing games', '📚 Studying', '🍕 Eating', '😴 Sleeping', '🏃 Out and about'].map((t) => `<button type="button" class="chip">${t}</button>`).join('')}</div>
      <label>Clear after<select id="status-clear">${CLEAR_AFTER.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
      <div class="error" id="modal-error"></div>
      <div class="modal-row">
        ${c ? '<button type="button" class="btn danger" id="status-remove">Clear status</button>' : ''}
        <span class="spacer"></span>
        <button type="button" class="btn secondary" data-close>Cancel</button><button type="submit" class="btn">Save</button>
      </div>
    </form>`);
  const showEmoji = () => ($('#status-emoji').innerHTML = emoji ? emojiHtml(emoji) : '🙂');
  showEmoji();
  $('#status-emoji').onclick = () => openEmojiPanel($('#status-emoji'), (e) => { emoji = e; showEmoji(); });
  for (const chip of document.querySelectorAll('#status-form .chip')) chip.onclick = () => {
    const [e, ...words] = chip.textContent.split(' ');
    emoji = e;
    $('#status-text').value = words.join(' ');
    showEmoji();
  };
  $('#status-text').focus();
  const save = async (customStatus) => {
    try {
      Object.assign(state.me, await api('/api/me', { method: 'PATCH', body: { customStatus } }));
      renderMyStatus();
      closeModal();
    } catch (err) { $('#modal-error').textContent = err.message; }
  };
  $('#status-remove')?.addEventListener('click', () => save(null));
  $('#status-form').onsubmit = (e) => {
    e.preventDefault();
    const text = $('#status-text').value.trim();
    if (!text && !emoji) return save(null);
    save({ text, emoji, until: clearTime($('#status-clear').value) });
  };
}

// ---- away: nobody's touched Burrow on this device for a while

const IDLE_AFTER = 10 * 60_000;
let lastTouch = Date.now();
let idleSent = false;
const touched = () => {
  lastTouch = Date.now();
  if (idleSent) checkIdle();
};
for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) document.addEventListener(type, touched, { capture: true, passive: true });
document.addEventListener('visibilitychange', () => { if (!document.hidden) touched(); });
function checkIdle() {
  // The desktop app knows how long the whole computer has been left alone.
  const systemIdle = window.burrowDesktop?.idleSeconds?.();
  const idle = typeof systemIdle === 'number' ? systemIdle * 1000 >= IDLE_AFTER : Date.now() - lastTouch >= IDLE_AFTER;
  if (idle === idleSent || state.ws?.readyState !== WebSocket.OPEN) return;
  idleSent = idle;
  state.ws.send(JSON.stringify({ type: 'idle', idle }));
}
setInterval(checkIdle, 30_000);

// ---- playing now: the desktop app says which game is running

let sharedActivity = null;
const activityOn = () => store.get('shareActivity') !== '0';
window.burrowDesktop?.activity?.onChange((name) => {
  const next = activityOn() ? name || null : null;
  if (next === sharedActivity) return;
  sharedActivity = next;
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type: 'activity', name: next ?? '' }));
});

// ---- quiet hours and do not disturb

function inQuietHours(q = state.me?.quietHours) {
  if (!q) return false;
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  return q.start < q.end ? minutes >= q.start && minutes < q.end : minutes >= q.start || minutes < q.end;
}
/** No sounds or pop-ups for messages: do not disturb, or quiet hours. */
const hushed = () => state.me?.status === 'dnd' || inQuietHours();

// ---- the number on the app icon (and in the tab title)

let lastBadge = -1;
function updateBadge() {
  // The @ button counts mentions and replies in burrows; the app icon adds unread direct messages.
  let count = 0;
  let pings = 0;
  for (const s of state.servers.values()) {
    for (const c of [...s.channels, ...(s.threads ?? [])]) {
      if (c.kind === 'voice' || notifyState(s, c).muted) continue;
      count += c.mentions ?? 0;
      if (!isDm(s)) pings += c.mentions ?? 0;
    }
  }
  count = Math.min(count, 99);
  $('#inbox-badge').textContent = pings > 9 ? '9+' : String(pings);
  $('#inbox-badge').classList.toggle('hidden', !pings);
  if (count === lastBadge) return;
  lastBadge = count;
  document.title = count ? `(${count}) Burrow` : 'Burrow';
  if (navigator.setAppBadge) (count ? navigator.setAppBadge(count) : navigator.clearAppBadge()).catch(() => {});
  window.burrowDesktop?.setBadge?.(count, count ? badgeImage(count) : null);
}
/** A red circle with the count, for the Windows taskbar. */
function badgeImage(count) {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const x = c.getContext('2d');
  x.fillStyle = '#c4473a';
  x.beginPath();
  x.arc(16, 16, 16, 0, Math.PI * 2);
  x.fill();
  x.fillStyle = '#fff';
  x.font = `bold ${count > 9 ? 16 : 20}px sans-serif`;
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillText(count > 9 ? '9+' : String(count), 16, 17);
  return c.toDataURL('image/png');
}

// ---- the mentions inbox

async function openInbox() {
  modal(`<h2>Mentions and replies</h2>
    <p class="muted small">Everything that @mentioned you, replied to you, or pinged @everyone or one of your roles.</p>
    <div id="inbox-list" class="card-list"><p class="muted">Loading…</p></div>
    <div class="modal-row"><button class="btn secondary" id="inbox-more" hidden>Show older</button><span class="spacer"></span><button class="btn secondary" data-close>Close</button></div>`);
  let before = 0;
  const load = async () => {
    const list = $('#inbox-list');
    const page = await api(`/api/mentions${before ? `?before=${before}` : ''}`);
    if (!$('#inbox-list')) return;
    if (!before) list.replaceChildren();
    if (!page.messages.length && !before) list.innerHTML = '<p class="muted">Nothing yet. When someone mentions you, it shows up here.</p>';
    for (const m of page.messages) {
      const card = messageCard(m, m.place, {
        note: m.unread ? 'Unread' : '',
        onOpen: () => { closeModal(); jumpTo(m.channelId, m.id); },
        buttons: [['Clear', (b) => {
          b.disabled = true;
          api(`/api/mentions/${m.id}`, { method: 'DELETE' }).then(() => card.remove()).catch(alertError);
        }]],
      });
      if (m.unread) card.classList.add('unread');
      list.append(card);
    }
    before = page.messages.at(-1)?.id ?? before;
    $('#inbox-more').hidden = !page.more;
  };
  $('#inbox-more').onclick = () => load().catch(alertError);
  try { await load(); } catch (err) { $('#inbox-list') && ($('#inbox-list').textContent = err.message); }
}

// ---- alerts while Burrow is closed: a service worker and the browser's push service

const pushSupported = () => !window.burrowDesktop && window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
// iPhones and iPads only allow it once Burrow is on the Home Screen.
const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
let swReady = null;

async function startPush() {
  if (window.burrowDesktop || !window.isSecureContext || !('serviceWorker' in navigator)) return;
  swReady = navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready).catch(() => null);
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'open' && e.data.channelId) jumpTo(e.data.channelId, e.data.messageId);
  });
  // Keep the server's copy current: browsers sometimes replace a subscription.
  if (store.get('push') === '1' && Notification.permission === 'granted') turnOnPush(false).catch(() => {});
}

async function pushSubscription() {
  const reg = await swReady;
  return reg ? reg.pushManager.getSubscription() : null;
}

async function turnOnPush(ask = true) {
  if (!pushSupported()) throw new Error(isIos() && !isStandalone()
    ? 'On an iPhone or iPad, add Burrow to your Home Screen first (Share › Add to Home Screen), then turn this on there.'
    : "This browser can't show alerts while Burrow is closed.");
  if (ask && Notification.permission !== 'granted' && (await Notification.requestPermission()) !== 'granted')
    throw new Error('Alerts are blocked for Burrow. Allow notifications for this site in your browser settings.');
  const reg = await swReady;
  if (!reg) throw new Error("Burrow couldn't set up alerts in this browser.");
  const { key } = await api('/api/push/key');
  let sub = await reg.pushManager.getSubscription();
  // A subscription made for another server key won't work; start over.
  const current = sub && btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey ?? []))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (sub && current && current !== key) { await sub.unsubscribe(); sub = null; }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)) });
  await api('/api/push', { method: 'POST', body: sub.toJSON() });
  store.set('push', '1');
}

async function turnOffPush() {
  store.set('push', '0');
  const sub = await pushSubscription();
  if (!sub) return;
  await api('/api/push', { method: 'DELETE', body: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

// A tapped alert opens Burrow at ?channel=…&message=…
function openLinkedMessage() {
  const params = new URLSearchParams(location.search);
  const channelId = Number(params.get('channel'));
  if (!channelId) return;
  history.replaceState(null, '', location.pathname);
  jumpTo(channelId, Number(params.get('message')) || undefined);
}

// ---- the Notifications part of your account settings

const minutesToTime = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const timeToMinutes = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

function notificationSettings() {
  const q = state.me.quietHours;
  const pushOn = store.get('push') === '1' && pushSupported() && Notification.permission === 'granted';
  return `<h3>Notifications</h3>
    ${window.burrowDesktop ? '' : `<label class="check"><input type="checkbox" id="push-on" ${pushOn ? 'checked' : ''} /> Alert me when Burrow is closed</label>
    <span class="small muted" id="push-note">${pushSupported() ? 'Direct messages, @mentions and replies, on this device, while Burrow isn\'t open.' : isIos() && !isStandalone() ? 'On an iPhone or iPad, add Burrow to your Home Screen (Share › Add to Home Screen) and turn this on there.' : "This browser can't show alerts while Burrow is closed."}</span>`}
    <label class="check"><input type="checkbox" id="quiet-on" ${q ? 'checked' : ''} /> Quiet hours</label>
    <div class="quiet-times ${q ? '' : 'hidden'}" id="quiet-times">
      <label>From<input type="time" id="quiet-start" value="${minutesToTime(q?.start ?? 22 * 60)}" /></label>
      <label>To<input type="time" id="quiet-end" value="${minutesToTime(q?.end ?? 7 * 60)}" /></label>
    </div>
    <span class="small muted">No sounds or pop-ups then, and alerts on your phone arrive silently. Do not disturb (click your picture) silences everything until you switch it off.</span>
    ${window.burrowDesktop?.activity ? `<label class="check"><input type="checkbox" id="share-activity" ${activityOn() ? 'checked' : ''} /> Show the game I'm playing</label>
    <span class="small muted">The desktop app spots games you run and shows "Playing …" under your name.</span>` : ''}`;
}

function emailSettings() {
  const me = state.me;
  return `<div class="email-settings" id="email-settings">
    <label>Your email, for resetting a forgotten password
      <div class="inline-form"><input type="email" id="email-address" placeholder="you@example.com" autocomplete="email" value="${escapeHtml(me.email ?? '')}" />
      <button type="button" class="btn secondary" id="email-send">${me.email ? (me.emailVerified ? 'Change' : 'Send code again') : 'Send code'}</button></div>
    </label>
    ${me.email && !me.emailVerified ? `<label>Code from the email<div class="inline-form"><input id="email-code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="123456" /><button type="button" class="btn" id="email-verify">Confirm</button></div></label>` : ''}
    ${me.email && me.emailVerified ? `<span class="small muted">Confirmed. If you forget your password, "Forgot your password?" on the login screen emails a code here.</span>
      <button type="button" class="link-btn danger-link" id="email-remove">Remove my email</button>` : ''}
    <div class="error" id="email-error"></div>
  </div>`;
}

function wireEmailSettings() {
  const box = $('#email-settings');
  if (!box) return;
  const redraw = (me) => { Object.assign(state.me, me); box.outerHTML = emailSettings(); wireEmailSettings(); };
  const fail = (err) => ($('#email-error').textContent = err.message);
  $('#email-send').onclick = async () => {
    $('#email-send').disabled = true;
    try { redraw(await api('/api/me/email', { method: 'POST', body: { email: $('#email-address').value } })); toast('Code sent. Check your email.'); }
    catch (err) { fail(err); $('#email-send').disabled = false; }
  };
  $('#email-verify')?.addEventListener('click', async () => {
    try { redraw(await api('/api/me/email/verify', { method: 'POST', body: { code: $('#email-code').value } })); toast('Email confirmed.'); }
    catch (err) { fail(err); }
  });
  $('#email-code')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#email-verify').click(); } });
  $('#email-remove')?.addEventListener('click', async () => {
    try { redraw(await api('/api/me/email', { method: 'DELETE' })); } catch (err) { fail(err); }
  });
}

function wireNotificationSettings() {
  $('#push-on')?.addEventListener('change', async (e) => {
    const box = e.target;
    box.disabled = true;
    try { box.checked ? await turnOnPush() : await turnOffPush(); }
    catch (err) { box.checked = false; $('#push-note').textContent = err.message; }
    finally { box.disabled = false; }
  });
  const saveQuiet = async () => {
    const on = $('#quiet-on').checked;
    $('#quiet-times').classList.toggle('hidden', !on);
    const quietHours = on ? { start: timeToMinutes($('#quiet-start').value || '22:00'), end: timeToMinutes($('#quiet-end').value || '07:00'), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } : null;
    try { Object.assign(state.me, await api('/api/me', { method: 'PATCH', body: { quietHours } })); }
    catch (err) { alertError(err); }
  };
  $('#quiet-on').onchange = saveQuiet;
  $('#quiet-start').onchange = saveQuiet;
  $('#quiet-end').onchange = saveQuiet;
  wireEmailSettings();
  $('#share-activity')?.addEventListener('change', (e) => {
    store.set('shareActivity', e.target.checked ? '1' : '0');
    window.burrowDesktop?.activity?.refresh?.();
    if (!e.target.checked && sharedActivity) {
      sharedActivity = null;
      state.ws?.send(JSON.stringify({ type: 'activity', name: '' }));
    }
  });
}

// ---------------------------------------------------------------- push to talk and hotkeys
//
// A key is kept as where it sits on the keyboard (KeyboardEvent.code, so it works with any
// layout) plus any Ctrl, Shift, Alt or Cmd held with it; the mouse's side buttons count too.
// In a browser they work while Burrow is in front. The desktop app hears them everywhere, even in
// a game, but only while you're in a voice room.

const isMac = /Mac/.test(navigator.platform);
const KEY_NAMES = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'",
  Comma: ',', Period: '.', Slash: '/', Space: 'Space', CapsLock: 'Caps Lock', Mouse4: 'Mouse back', Mouse5: 'Mouse forward',
  ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl', ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift',
  AltLeft: isMac ? 'Left Option' : 'Left Alt', AltRight: isMac ? 'Right Option' : 'Right Alt', MetaLeft: isMac ? 'Left Cmd' : 'Left Win', MetaRight: isMac ? 'Right Cmd' : 'Right Win',
};
function keyLabel(k) {
  if (!k) return 'Not set';
  const name = /^Key[A-Z]$/.test(k.code) ? k.code.slice(3) : /^Digit\d$/.test(k.code) ? k.code.slice(5) : KEY_NAMES[k.code] ?? k.code.replace(/^Numpad/, 'Num ');
  return [k.ctrl && 'Ctrl', k.alt && (isMac ? 'Option' : 'Alt'), k.shift && 'Shift', k.meta && (isMac ? 'Cmd' : 'Win'), name].filter(Boolean).join('+');
}
const MODIFIER_CODES = /^(Control|Shift|Alt|Meta)(Left|Right)$/;
function keyFromEvent(e) {
  if (e.type.startsWith('mouse')) return { code: `Mouse${e.button + 1}` };
  // A modifier on its own (say Left Ctrl as push to talk) is a key by itself.
  if (MODIFIER_CODES.test(e.code)) return { code: e.code };
  return { code: e.code, ...(e.ctrlKey && { ctrl: true }), ...(e.altKey && { alt: true }), ...(e.shiftKey && { shift: true }), ...(e.metaKey && { meta: true }) };
}
const sameKey = (a, b) => !!a && !!b && a.code === b.code && !!a.ctrl === !!b.ctrl && !!a.alt === !!b.alt && !!a.shift === !!b.shift && !!a.meta === !!b.meta;

const desktopHotkeys = window.burrowDesktop?.hotkeys ?? null;
let hotkeyStatus = { global: false, needsPermission: false }; // from the desktop app
let capturingKey = null; // which key is being picked in the settings

/** Hands your keys to the desktop app while you're in voice (and takes them back after). */
async function syncHotkeys() {
  if (!desktopHotkeys) return;
  const binds = state.voice && !capturingKey
    ? { ptt: voicePrefs.mode === 'ptt' ? voicePrefs.keys.ptt : null, mute: voicePrefs.keys.mute, deafen: voicePrefs.keys.deafen }
    : null;
  try { hotkeyStatus = (await desktopHotkeys.set(binds)) ?? { global: false }; } catch { hotkeyStatus = { global: false }; }
  renderHotkeyNote();
}
desktopHotkeys?.onKey((name, down) => {
  if (capturingKey) return;
  if (name === 'ptt') setPtt(down);
  else if (down && name === 'mute') toggleMute();
  else if (down && name === 'deafen') toggleDeafen();
});

function setPtt(down) {
  if (pttHeld === down) return;
  pttHeld = down;
  updateGate();
  if (down) markActive();
  if (state.voice) renderVoiceBar();
}

const typingInto = (el) => !!el?.closest?.('input, textarea, select, [contenteditable="true"]');
function onHotkey(e, down) {
  if (capturingKey || hotkeyStatus.global) return; // the desktop app hears them itself
  const key = keyFromEvent(e);
  const { keys } = voicePrefs;
  if (voicePrefs.mode === 'ptt' && keys.ptt && key.code === keys.ptt.code && (state.voice || micTest)) {
    // Letting go counts whatever else is held; pressing needs the same combination.
    if (down && !sameKey(key, keys.ptt)) return;
    // A plain typing key still types in a text box.
    if (typingInto(e.target) && !keys.ptt.ctrl && !keys.ptt.alt && !keys.ptt.meta && e.key?.length === 1) return;
    e.preventDefault();
    if (!e.repeat) setPtt(down);
    return;
  }
  if (!down || !state.voice || e.repeat) return;
  if (sameKey(key, keys.mute)) { e.preventDefault(); toggleMute(); }
  else if (sameKey(key, keys.deafen)) { e.preventDefault(); toggleDeafen(); }
}
document.addEventListener('keydown', (e) => onHotkey(e, true), true);
document.addEventListener('keyup', (e) => onHotkey(e, false), true);
// The side buttons would otherwise go back and forward in the browser.
const sideButton = (e) => e.button >= 3 && voicePrefs.mode === 'ptt' && voicePrefs.keys.ptt?.code === `Mouse${e.button + 1}` && (state.voice || micTest);
document.addEventListener('mousedown', (e) => { if (e.button >= 3) onHotkey(e, true); }, true);
document.addEventListener('mouseup', (e) => { if (sideButton(e)) e.preventDefault(); if (e.button >= 3) onHotkey(e, false); }, true);
document.addEventListener('auxclick', (e) => { if (sideButton(e)) e.preventDefault(); }, true);
// A browser can't tell when a key is let go somewhere else.
window.addEventListener('blur', () => { if (!hotkeyStatus.global) setPtt(false); });

/** The key picker in the settings: press any key, or Escape to keep the old one. */
function captureKey(name, button) {
  capturingKey = name;
  syncHotkeys();
  button.textContent = 'Press a key…';
  button.classList.add('capturing');
  const done = (key) => {
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('mousedown', onMouse, true);
    capturingKey = null;
    if (key) {
      voicePrefs.keys[name] = key;
      saveVoicePrefs();
    }
    button.textContent = keyLabel(voicePrefs.keys[name]);
    button.classList.remove('capturing');
    syncHotkeys();
  };
  const onKeyDown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') return done(null);
    // Ctrl, Shift and friends wait for the key they go with, unless that's the whole thing (push to talk).
    if (MODIFIER_CODES.test(e.code) && name !== 'ptt') return;
    done(keyFromEvent(e));
  };
  const onMouse = (e) => {
    if (e.button < 3) return;
    e.preventDefault();
    done(keyFromEvent(e));
  };
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('mousedown', onMouse, true);
}

function renderHotkeyNote() {
  const note = $('#vs-hotkey-note');
  if (!note) return;
  if (!desktopHotkeys) note.textContent = 'These work while Burrow is in front. In the desktop app they work everywhere, even in games.';
  else if (hotkeyStatus.needsPermission) {
    note.innerHTML = 'To hear your keys in other apps, allow Burrow in System Settings › Privacy &amp; Security › Accessibility. <button type="button" class="link-btn" id="vs-allow-keys">Open it</button>';
    $('#vs-allow-keys').onclick = () => desktopHotkeys.askPermission?.();
  } else note.textContent = hotkeyStatus.global ? 'These work everywhere while you\'re in voice, even in games.'
    : state.voice ? 'These work while Burrow is in front.' : 'These work everywhere while you\'re in voice, even in games.';
}

// Talking or touching the app counts as being here, for the AFK fire.
let lastActiveSent = 0;
function markActive() {
  if (!state.voice || Date.now() - lastActiveSent < 60_000 || state.ws?.readyState !== WebSocket.OPEN) return;
  lastActiveSent = Date.now();
  state.ws.send(JSON.stringify({ type: 'voice_active' }));
}
document.addEventListener('pointerdown', markActive, true);
document.addEventListener('keydown', markActive, true);

// ---------------------------------------------------------------- managing voice: moving people, muting them for everyone, the AFK fire

const SEAT_CHOICES = [0, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 50, 99];
const AFK_CHOICES = [[1, '1 minute'], [5, '5 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 hour']];
const SERVER_MUTED_ICON = MUTED_ICON.replace('class="muted-icon"', 'class="muted-icon server-muted"').replace('aria-label="Muted"', 'aria-label="Muted by a moderator"');

/** The name a voice room goes by: its own, or "Call with Sam" in a direct message. */
function fireName(c) {
  const s = c && [...state.servers.values()].find((x) => x.channels.includes(c));
  return s && isDm(s) ? `Call with ${dmTitle(s)}` : c?.name ?? '';
}

/** Whether you can move, mute or disconnect this person in this burrow. */
const canManageVoice = (s, userId) => {
  if (!can(s, 'voice')) return false;
  const m = s.members.find((x) => x.id === userId);
  return !!m && (userId === state.me.id || (!isHost(s, userId) && rankOf(s, m) > rankOf(s, me(s))));
};

/** The moderator part of someone's volume pop-up. */
function voiceModTools(pop, s, c, userId, name) {
  if (!s || !c || !canManageVoice(s, userId)) return;
  const muted = c.voiceServerMuted?.includes(userId);
  const fires = s.channels.filter((x) => x.kind === 'voice' && x.id !== c.id);
  const box = document.createElement('div');
  box.className = 'volume-mod';
  box.innerHTML = `${userId !== state.me.id ? `<button type="button" class="btn secondary" data-act="mute">${muted ? 'Let them speak' : 'Mute for everyone'}</button>` : ''}
    ${fires.length ? `<label class="small">Move to<select data-act="move"><option value="">Pick a fire</option>${fires.map((f) => `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join('')}</select></label>` : ''}
    ${userId !== state.me.id ? '<button type="button" class="btn danger" data-act="kick">Disconnect</button>' : ''}`;
  const run = async (f) => { try { await f(); closeVolume(); } catch (err) { alertError(err); } };
  box.querySelector('[data-act="mute"]')?.addEventListener('click', () => run(() => api(`/api/servers/${s.id}/members/${userId}/voice-mute`, { method: 'POST', body: { muted: !muted } })));
  box.querySelector('[data-act="move"]')?.addEventListener('change', (e) => {
    if (!e.target.value) return;
    const to = Number(e.target.value);
    run(() => (userId === state.me.id ? joinVoice(to) : api('/api/voice/move', { method: 'POST', body: { userId, channelId: to } })));
  });
  box.querySelector('[data-act="kick"]')?.addEventListener('click', () => run(() => api('/api/voice/disconnect', { method: 'POST', body: { userId } })));
  if (box.children.length) pop.append(box);
}

/** Muted (or let speak again) by a moderator, while you're at one of the burrow's fires. */
function applyServerMute(muted) {
  const voice = state.voice;
  if (!voice?.room) return;
  if (muted) {
    voice.mutedBeforeServer = voice.muted;
    voice.serverMuted = true;
    setMicMuted(voice, true);
  } else {
    voice.serverMuted = false;
    const hasMic = !!voice.room.localParticipant.getTrackPublication(window.LivekitClient.Track.Source.Microphone)?.track;
    voice.muted = !!voice.mutedBeforeServer || voice.deafened;
    if (hasMic) setMicMuted(voice, voice.muted);
    else startMic(voice).catch((err) => console.warn("Couldn't turn your mic back on:", err));
  }
  voiceChanged();
}

function voiceRoomSettings(c) {
  return `<label>Seats<select id="room-seats">${SEAT_CHOICES.map((n) => `<option value="${n}" ${n === (c.userLimit ?? 0) ? 'selected' : ''}>${n ? `${n} people` : 'No limit'}</option>`).join('')}</select>
      <span class="small muted">When it's full, only people who manage voice can sit down, or move others in.</span></label>
    <label class="check"><input type="checkbox" id="room-keep-chat" ${c.keepChat ? 'checked' : ''} /> Keep the fireside chat after everyone leaves</label>`;
}

function afkSettings(s) {
  const fires = s.channels.filter((c) => c.kind === 'voice');
  if (fires.length < 2) return '';
  return `<label>AFK fire
      <select id="burrow-afk"><option value="">None</option>${fires.map((c) => `<option value="${c.id}" ${c.id === s.afkChannelId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}</select>
      <span class="small muted">People who haven't talked or touched Burrow for a while are moved here, muted.</span></label>
    <label>Move them after<select id="burrow-afk-minutes">${AFK_CHOICES.map(([v, l]) => `<option value="${v}" ${v === (s.afkMinutes ?? 15) ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
}

// ---------------------------------------------------------------- the soundboard
//
// Each burrow's short clips. Anyone at one of its fires can play one; everyone there hears it.
// Each app fetches the clip and plays it itself, at your own soundboard volume.

const SOUND_ICON = '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 0 0-9 9v5a3 3 0 0 0 3 3h1v-7H5v-1a7 7 0 0 1 14 0v1h-2v7h1a3 3 0 0 0 3-3v-5a9 9 0 0 0-9-9Zm-1 7h2v8h-2v-8Zm-3 3h2v5H8v-5Zm6 0h2v5h-2v-5Z"/></svg>';
const MAX_SOUND_SECONDS = 10;
const soundBuffers = new Map(); // url -> Promise<AudioBuffer>

function audioOut() {
  if (!soundCtx) {
    soundCtx = new AudioContext();
    setChimeOutput();
  }
  if (soundCtx.state === 'suspended') soundCtx.resume().catch(() => {});
  return soundCtx;
}

async function playClip(url, volume) {
  const ctx = audioOut();
  if (!soundBuffers.has(url)) {
    const loading = fetch(state.serverUrl + url)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
      .then((b) => ctx.decodeAudioData(b));
    loading.catch(() => soundBuffers.delete(url));
    soundBuffers.set(url, loading);
  }
  const source = ctx.createBufferSource();
  source.buffer = await soundBuffers.get(url);
  const gain = ctx.createGain();
  gain.gain.value = volume;
  source.connect(gain).connect(ctx.destination);
  source.start();
}

function onBoardSound(ev) {
  if (state.voice?.channelId !== ev.channelId) return;
  const sound = fireServer()?.sounds?.find((x) => x.id === ev.soundId);
  fireNote(`${nameOf(ev.userId)} played ${sound ? `${sound.emoji ? sound.emoji + ' ' : ''}${sound.name}` : 'a sound'}`);
  // Not while deafened, and not from someone you've turned all the way down.
  if (!voicePrefs.soundboard || state.voice.deafened || volumeFor(ev.userId) === 0) return;
  playClip(ev.url, voicePrefs.soundboardVolume * voicePrefs.outputVolume).catch((err) => console.warn("Couldn't play the sound:", err));
}

/** A line that floats up over the fire for a few seconds. */
function fireNote(text) {
  const note = document.createElement('div');
  note.className = 'fire-note';
  note.textContent = text;
  $('#fire-notes').append(note);
  setTimeout(() => note.remove(), 4000);
}

function openBoard(anchor) {
  const s = fireServer();
  if (!s || isDm(s)) return;
  closeVolume();
  const pop = document.createElement('div');
  pop.className = 'volume-pop board-pop';
  pop.id = 'volume-pop';
  const sounds = s.sounds ?? [];
  pop.innerHTML = `<div class="volume-head"><b>Soundboard</b><span class="small muted">${escapeHtml(s.name)}</span></div>
    ${sounds.length ? '<div class="board-grid"></div>' : `<p class="small muted">No sounds yet.${can(s, 'emoji') ? '' : ' Someone who manages emoji can add some.'}</p>`}
    <label class="small">Your soundboard volume <span id="board-vol-val">${Math.round(voicePrefs.soundboardVolume * 100)}%</span>
      <input type="range" id="board-vol" min="0" max="100" step="5" value="${Math.round(voicePrefs.soundboardVolume * 100)}" /></label>
    ${can(s, 'emoji') && state.maxUploadBytes ? '<button type="button" class="link-btn" id="board-manage">Add or change sounds</button>' : ''}`;
  pop.onclick = (e) => e.stopPropagation();
  for (const sound of sounds) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'board-sound';
    b.innerHTML = `<span class="board-emoji">${sound.emoji ? emojiHtml(sound.emoji, s) : SOUND_ICON}</span><span></span>`;
    b.lastChild.textContent = sound.name;
    b.disabled = !!state.voice?.serverMuted;
    b.title = state.voice?.serverMuted ? "You've been muted here" : `Play ${sound.name} for everyone at the fire`;
    b.onclick = () => state.ws?.send(JSON.stringify({ type: 'soundboard', soundId: sound.id }));
    pop.querySelector('.board-grid').append(b);
  }
  document.body.append(pop);
  placePop(pop, anchor);
  $('#board-vol').oninput = (e) => {
    voicePrefs.soundboardVolume = Number(e.target.value) / 100;
    $('#board-vol-val').textContent = `${e.target.value}%`;
  };
  $('#board-vol').onchange = saveVoicePrefs;
  $('#board-manage')?.addEventListener('click', () => { closeVolume(); openSounds(s.id); });
}

/** Puts a pop-up next to what opened it, inside the window. */
function placePop(pop, anchor) {
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8))}px`;
  const below = r.bottom + 6 + pop.offsetHeight < window.innerHeight - 8;
  pop.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - pop.offsetHeight - 6)}px`;
}

function openSounds(serverId) {
  const s = state.servers.get(serverId);
  if (!s) return closeModal();
  const sounds = s.sounds ?? [];
  modal(`<h2>Soundboard</h2>
    <p class="small muted">Short clips anyone at ${escapeHtml(s.name)}'s fires can play for everyone there. Up to ${MAX_SOUND_SECONDS} seconds and 1 MB each; MP3, OGG, WAV, WebM or M4A.</p>
    <h3>Sounds · ${sounds.length} of 30</h3>
    ${sounds.length ? `<ul class="emoji-manage sound-manage">${sounds.map((x) => `<li data-id="${x.id}">
        <button type="button" class="icon-btn" data-act="play" title="Hear it">${SPEAKER_ON}</button>
        <input class="sound-emoji" maxlength="16" value="${escapeHtml(x.emoji)}" aria-label="Emoji" placeholder="🔊" />
        <input class="sound-name" maxlength="32" value="${escapeHtml(x.name)}" aria-label="Name" />
        <button type="button" class="btn secondary" data-act="save">Save</button>
        <button type="button" class="btn danger" data-act="delete">Delete</button>
      </li>`).join('')}</ul>` : '<p class="muted small">None yet.</p>'}
    <h3>Add a sound</h3>
    <form id="sound-form" class="sound-add">
      <input type="file" id="sound-file" accept="audio/*" required />
      <div class="sound-add-row"><input id="sound-new-emoji" maxlength="16" placeholder="🔊" aria-label="Emoji" /><input id="sound-new-name" maxlength="32" placeholder="Name" required /></div>
      <div class="error" id="modal-error"></div>
      <div class="modal-row"><button type="button" class="btn secondary" data-close>Done</button><button type="submit" class="btn">Add</button></div>
    </form>`);
  const done = (updated) => { handleEvent({ type: 'server_updated', server: updated }); openSounds(serverId); };
  for (const li of document.querySelectorAll('#modal-card .sound-manage li')) {
    const id = Number(li.dataset.id);
    const sound = sounds.find((x) => x.id === id);
    li.querySelector('[data-act="play"]').onclick = () => playClip(sound.url, voicePrefs.soundboardVolume).catch(alertError);
    li.querySelector('[data-act="save"]').onclick = async () => {
      try { done(await api(`/api/sounds/${id}`, { method: 'PATCH', body: { name: li.querySelector('.sound-name').value, emoji: li.querySelector('.sound-emoji').value } })); } catch (err) { alertError(err); }
    };
    li.querySelector('[data-act="delete"]').onclick = async () => {
      if (!confirm(`Delete ${sound.name}?`)) return;
      try { done(await api(`/api/sounds/${id}`, { method: 'DELETE' })); } catch (err) { alertError(err); }
    };
  }
  $('#sound-file').onchange = () => {
    const f = $('#sound-file').files[0];
    if (f && !$('#sound-new-name').value) $('#sound-new-name').value = f.name.replace(/\.[^.]+$/, '').slice(0, 32);
  };
  $('#sound-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = $('#sound-file').files[0];
    $('#modal-error').textContent = '';
    try {
      if (!f) throw new Error('Pick a sound');
      if (f.size > 1024 * 1024) throw new Error('Sounds can be at most 1 MB');
      // Checked here, since the server can't play it to see how long it is.
      const decoded = await audioOut().decodeAudioData(await f.arrayBuffer()).catch(() => { throw new Error("That file isn't audio Burrow can play"); });
      if (decoded.duration > MAX_SOUND_SECONDS + 0.5) throw new Error(`Sounds can be up to ${MAX_SOUND_SECONDS} seconds (that one is ${Math.round(decoded.duration)})`);
      const query = new URLSearchParams({ name: $('#sound-new-name').value, emoji: $('#sound-new-emoji').value });
      done(await uploadPicture(`/api/servers/${serverId}/sounds?${query}`, f));
    } catch (err) { $('#modal-error').textContent = err.message; }
  };
}

// ---------------------------------------------------------------- listen together
//
// One YouTube video per fire, played in step for everyone there. Anyone can start, pause, skip
// or stop it. Burrow keeps what's playing and where it was at a moment in time; each app works
// out where it should be now and nudges its player there. The player is YouTube's own, in a
// frame, controlled with the messages its embed understands (no YouTube script runs in Burrow).

const LISTEN_ICON = '<svg viewBox="0 0 24 24"><path d="M12 3v10.6A4 4 0 1 0 14 17V7h4V3h-6Z"/></svg>';
let listen = null; // { channelId, state, at, frame, ready, time, playerState, hidden }

/** The video id from a YouTube link (watch, youtu.be, shorts, music, embed) or a bare id. */
function youtubeId(text) {
  const t = text.trim();
  if (/^[\w-]{11}$/.test(t)) return t;
  try {
    const u = new URL(t);
    const host = u.hostname.replace(/^(www|m|music)\./, '');
    if (host === 'youtu.be') return u.pathname.slice(1, 12);
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      const v = u.searchParams.get('v');
      if (v) return v;
      return /^\/(?:shorts|embed|live)\/([\w-]{11})/.exec(u.pathname)?.[1] ?? null;
    }
  } catch {}
  return null;
}
/** Where in the video, from a link's ?t=90 or ?t=1m30s. */
function youtubeStart(text) {
  try {
    const t = new URL(text.trim()).searchParams.get('t') ?? '';
    const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(t);
    return m ? (Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) : 0;
  } catch { return 0; }
}

const sendListen = (msg) => state.ws?.readyState === WebSocket.OPEN && state.ws.send(JSON.stringify({ type: 'listen', ...msg }));

function openListen() {
  modal(`<h2>Listen together</h2>
    <p class="small muted">Paste a YouTube link. It plays for everyone at the fire, in step, and anyone can pause or change it.</p>
    <form id="listen-form">
      <input id="listen-link" placeholder="https://www.youtube.com/watch?v=…" autocomplete="off" required />
      <div class="error" id="modal-error"></div>
      <div class="modal-row"><button type="button" class="btn secondary" data-close>Cancel</button><button type="submit" class="btn">Play</button></div>
    </form>`);
  $('#listen-link').focus();
  $('#listen-form').onsubmit = (e) => {
    e.preventDefault();
    const id = youtubeId($('#listen-link').value);
    if (!id) return ($('#modal-error').textContent = "That doesn't look like a YouTube link");
    sendListen({ action: 'start', videoId: id, position: youtubeStart($('#listen-link').value) });
    closeModal();
  };
}

/** Where the video should be now, in seconds. */
const listenTarget = () => {
  const st = listen?.state;
  if (!st) return 0;
  return st.position + (st.playing ? (performance.now() - listen.at) / 1000 : 0);
};

function onListenState(ev) {
  if (state.voice?.channelId !== ev.channelId) return;
  const before = listen?.state;
  if (!ev.state) return stopListen();
  if (!listen || listen.channelId !== ev.channelId) listen = { channelId: ev.channelId, hidden: store.get('listenHidden') === '1' };
  listen.state = ev.state;
  listen.at = performance.now(); // what Burrow says is where it is as of now
  if (before?.videoId !== ev.state.videoId) {
    if (before) fireNote(`${nameOf(ev.state.by)} put on something new`);
    loadListenFrame();
  } else syncListen(true);
  renderListen();
}

function loadListenFrame() {
  const st = listen.state;
  listen.ready = false;
  listen.time = null;
  listen.titleSent = false;
  const frame = document.createElement('iframe');
  frame.className = 'listen-frame';
  frame.allow = 'autoplay; encrypted-media';
  // YouTube wants to know which site it's in; Burrow otherwise sends no referrer anywhere.
  frame.referrerPolicy = 'strict-origin-when-cross-origin';
  frame.title = 'Listen together';
  const start = Math.floor(listenTarget());
  frame.src = `https://www.youtube-nocookie.com/embed/${st.videoId}?enablejsapi=1&controls=0&disablekb=1&playsinline=1&rel=0&autoplay=${st.playing ? 1 : 0}&start=${start}`;
  frame.onload = () => {
    // Asks the player to start sending its state.
    frame.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 'burrow', channel: 'widget' }), '*');
    setTimeout(() => syncListen(true), 500);
  };
  listen.frame = frame;
  $('#listen-video').replaceChildren(frame);
}

function playerCommand(func, args = []) {
  listen?.frame?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args, id: 'burrow', channel: 'widget' }), '*');
}

/** Lines the player up with everyone else: playing or not, the same spot (within a second and a half), your volume. */
function syncListen(force = false) {
  if (!listen?.frame) return;
  const st = listen.state;
  const target = listenTarget();
  playerCommand('setVolume', [Math.round((state.voice?.deafened ? 0 : voicePrefs.listenVolume * voicePrefs.outputVolume) * 100)]);
  if (st.playing && listen.playerState !== 1 && listen.playerState !== 3) playerCommand('playVideo');
  if (!st.playing && listen.playerState === 1) playerCommand('pauseVideo');
  if (listen.time !== null && (force || st.playing) && Math.abs(listen.time - target) > 1.5) playerCommand('seekTo', [target, true]);
}

window.addEventListener('message', (e) => {
  if (!listen?.frame || e.source !== listen.frame.contentWindow) return;
  let data;
  try { data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
  const info = data?.info;
  if (data?.event === 'onReady') { listen.ready = true; syncListen(true); }
  if (!info || typeof info !== 'object') return;
  if (typeof info.currentTime === 'number') listen.time = info.currentTime;
  if (typeof info.playerState === 'number' && info.playerState !== listen.playerState) {
    listen.playerState = info.playerState;
    // At the end it stops for everyone, rather than starting over.
    if (info.playerState === 0 && listen.state.playing) sendListen({ action: 'ended' });
    else syncListen();
  }
  const title = info.videoData?.title;
  if (title && !listen.state.title && !listen.titleSent && listen.state.by === state.me.id) {
    listen.titleSent = true;
    sendListen({ action: 'title', title });
  }
  if (title) listen.title = title;
  renderListen();
});
setInterval(() => { if (listen?.state?.playing) { syncListen(); renderListen(); } }, 1000);

function renderListen() {
  const panel = $('#listen-panel');
  panel.classList.toggle('hidden', !listen?.state);
  $('#fire-listen').classList.toggle('on', !!listen?.state);
  if (!listen?.state) return;
  const st = listen.state;
  panel.classList.toggle('video-hidden', !!listen.hidden);
  $('#listen-title').textContent = st.title || listen.title || 'YouTube video';
  $('#listen-by').textContent = `Put on by ${st.by === state.me.id ? 'you' : nameOf(st.by)}`;
  $('#listen-time').textContent = clock(listenTarget());
  $('#listen-toggle').innerHTML = st.playing ? PAUSE_ICON : PLAY_ICON;
  $('#listen-toggle').title = st.playing ? 'Pause for everyone' : 'Play for everyone';
  $('#listen-hide').textContent = listen.hidden ? 'Show video' : 'Hide video';
}

function stopListen() {
  listen = null;
  $('#listen-video').replaceChildren();
  renderListen();
}

$('#fire-board').innerHTML = SOUND_ICON;
$('#fire-board').onclick = (e) => { e.stopPropagation(); openBoard(e.currentTarget); };
$('#fire-listen').innerHTML = LISTEN_ICON;
$('#fire-listen').onclick = () => (listen?.state ? $('#listen-panel').scrollIntoView({ block: 'nearest' }) : openListen());
$('#listen-toggle').onclick = () => sendListen({ action: listen?.state?.playing ? 'pause' : 'play' });
$('#listen-back').onclick = () => sendListen({ action: 'seek', position: Math.max(0, listenTarget() - 10) });
$('#listen-forward').onclick = () => sendListen({ action: 'seek', position: listenTarget() + 10 });
$('#listen-stop').onclick = () => sendListen({ action: 'stop' });
$('#listen-change').onclick = openListen;
$('#listen-hide').onclick = () => {
  listen.hidden = !listen.hidden;
  store.set('listenHidden', listen.hidden ? '1' : null);
  renderListen();
};
$('#listen-volume').value = Math.round(voicePrefs.listenVolume * 100);
$('#listen-volume').oninput = (e) => { voicePrefs.listenVolume = Number(e.target.value) / 100; syncListen(); };
$('#listen-volume').onchange = saveVoicePrefs;

// ---------------------------------------------------------------- calls in direct messages
//
// A conversation gets its own voice room the first time someone calls. Calling rings everyone
// else in it: their app shows who's calling, with a ringtone, until they answer or say no, the
// caller gives up, or half a minute goes by.

const PHONE_ICON = '<svg viewBox="0 0 24 24"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1L6.6 10.8Z"/></svg>';
let ringing = null; // { serverId, channelId, from, timer, tone }

const callRoomOf = (s) => s?.channels.find((c) => c.kind === 'voice') ?? null;

async function startCall(s) {
  try {
    const { channelId } = await api(`/api/dms/${s.id}/call`, { method: 'POST' });
    await joinVoice(channelId);
  } catch (err) { alertError(err); }
}

function onRing(ev) {
  const s = state.servers.get(ev.serverId);
  if (!s || state.voice?.channelId === ev.channelId) return;
  stopRinging();
  const who = ev.from.username;
  ringing = { serverId: ev.serverId, channelId: ev.channelId, from: ev.from };
  const card = $('#ring');
  card.classList.remove('hidden');
  setAvatar($('#ring-avatar'), who, avatarOf(ev.from.id));
  $('#ring-name').textContent = s.group ? `${who} in ${dmTitle(s)}` : who;
  // A ring every two seconds, for up to half a minute.
  const ring = () => { if (!state.voice) playSound('ring', true); };
  ring();
  ringing.tone = setInterval(ring, 2000);
  ringing.timer = setTimeout(() => stopRinging(), 30_000);
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    const n = new Notification(`${who} is calling`, { body: 'Open Burrow to answer', requireInteraction: true, tag: `ring-${ev.serverId}` });
    n.onclick = () => { window.focus(); n.close(); };
    ringing.notification = n;
  }
}
function stopRinging() {
  if (!ringing) return;
  clearInterval(ringing.tone);
  clearTimeout(ringing.timer);
  ringing.notification?.close();
  ringing = null;
  $('#ring').classList.add('hidden');
}
$('#ring-answer').onclick = () => {
  const r = ringing;
  stopRinging();
  if (!r) return;
  selectServer(r.serverId);
  joinVoice(r.channelId);
};
$('#ring-decline').onclick = () => {
  const r = ringing;
  stopRinging();
  if (r) api(`/api/dms/${r.serverId}/call/decline`, { method: 'POST' }).catch(() => {});
};
/** Whoever called gave up, or you picked up somewhere else: stop ringing. */
function checkRinging(channelId, userIds) {
  if (!ringing || ringing.channelId !== channelId) return;
  if (!userIds.length || userIds.includes(state.me.id)) stopRinging();
}

/** In a direct message: the call button, and a way into a call that's going on. */
function renderCallButton() {
  const s = state.servers.get(state.serverId);
  const dm = isDm(s) && state.voiceEnabled;
  const room = dm ? callRoomOf(s) : null;
  const inCall = !!room && state.voice?.channelId === room.id;
  const going = !!room && !inCall && (room.voiceUsers?.length ?? 0) > 0;
  $('#call-btn').classList.toggle('hidden', !dm || inCall);
  $('#call-btn').classList.toggle('live', going);
  $('#call-btn').title = going ? 'Join the call' : 'Call';
  $('#call-btn').setAttribute('aria-label', $('#call-btn').title);
  $('#call-bar').classList.toggle('hidden', !going);
  if (going) $('#call-bar-text').textContent = `${room.voiceUsers.map((id) => nameOf(id)).join(', ')} ${room.voiceUsers.length === 1 ? 'is' : 'are'} in a call`;
}
$('#call-btn').innerHTML = PHONE_ICON;
$('#call-btn').onclick = () => {
  const s = state.servers.get(state.serverId);
  const room = callRoomOf(s);
  if (room?.voiceUsers?.length) joinVoice(room.id);
  else if (s) startCall(s);
};
$('#call-join').onclick = () => { const room = callRoomOf(state.servers.get(state.serverId)); if (room) joinVoice(room.id); };
