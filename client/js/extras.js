// The fun extras: the seasons around the fire, decorations unlocked by time at the fire, toasting
// marshmallows, birthdays, each hearth's message of the day, and the year in review.
// Part of Peiskos's client: plain scripts that index.html loads in order, sharing one global scope.
'use strict';

// ---------------------------------------------------------------- the seasons

// theme.js puts the season and any holiday on <html> (data-season, data-holiday) before the first
// paint; this fills the fire with whatever is falling or floating this time of year.
function seasonLayer() {
  const layer = $('#season-layer');
  const root = document.documentElement;
  const kind = root.dataset.holiday || root.dataset.season || 'none';
  if (layer.dataset.kind === kind) return;
  layer.dataset.kind = kind;
  const count = { winter: 26, autumn: 16, spring: 14, summer: 12, halloween: 16, yule: 26, newyear: 20, midsummer: 14 }[kind] ?? 0;
  const bits = [];
  for (let i = 0; i < count; i++) {
    // Spread across the circle, at their own speeds and sizes, already partway through so it starts full.
    const dur = 6 + Math.random() * 7;
    bits.push(`<span style="--x:${(Math.random() * 100).toFixed(1)}%;--y:${(Math.random() * 100).toFixed(1)}%;--s:${(0.6 + Math.random() * 0.8).toFixed(2)};--d:${dur.toFixed(1)}s;--delay:${(-Math.random() * dur).toFixed(1)}s;--hue:${Math.floor(Math.random() * 4)}"></span>`);
  }
  layer.innerHTML = bits.join('');
}

// Sparks for hearths whose fire has them.
function sparksLayer(on) {
  const layer = $('#fire-sparks');
  if (!on) return layer.replaceChildren();
  if (layer.childElementCount) return;
  layer.innerHTML = Array.from({ length: 12 }, () => {
    const dur = 1.6 + Math.random() * 1.8;
    return `<span style="--x:${(Math.random() * 0.2 - 0.1).toFixed(3)};--drift:${(Math.random() * 40 - 20).toFixed(0)}px;--d:${dur.toFixed(2)}s;--delay:${(-Math.random() * dur).toFixed(2)}s"></span>`;
  }).join('');
}

// ---------------------------------------------------------------- decorations by the fire

// What can sit by your seat, matching FIRE_ITEMS in server/src/extras.ts (the server decides
// what's unlocked; this is how each one looks): little pixel pictures, 16×16, one letter per
// pixel ('.' is empty). Rows of 8 are the left half, mirrored to make the right.
const FIRE_ITEM_NAMES = {
  cocoa: 'A mug of cocoa', marshmallow: 'Marshmallows', mushroom: 'A forest mushroom', guitar: 'A guitar', hedgehog: 'A hedgehog',
  fox: 'A fox', owl: 'An owl', deer: 'A deer', bear: 'A bear', wolf: 'A wolf',
};
const PIXEL_COLORS = {
  k: '#2b1d16', w: '#fbf3e6', c: '#efd9bd', o: '#e27b30', O: '#b4521b', b: '#8a5a36', B: '#5c3a22', l: '#c99a6b',
  g: '#9a9ca3', G: '#62656d', L: '#d5d7dc', r: '#cf4a33', R: '#982f22', p: '#f2b8b4', y: '#f6cf5a', Y: '#d99a2b',
  m: '#e8ddcf', M: '#b8a690', s: '#a07a5a', e: '#f8f4ec',
};
const PIXEL_ART = {
  cocoa: [
    '................',
    '.....e...e......',
    '......e...e.....',
    '.....e...e......',
    '......e...e.....',
    '................',
    '..mmmmmmmmmm....',
    '..mBbbbbbbBm....',
    '..mmmmmmmmmmMM..',
    '..mmmmmmmmmm.M..',
    '..mmrmrmmmmm.M..',
    '..mmrrrmmmmm.M..',
    '..mmmrmmmmmmMM..',
    '..mmmmmmmmmm....',
    '...MmmmmmmM.....',
    '....MMMMMM......',
  ],
  marshmallow: [
    '................',
    '...........ww...',
    '..........wwww..',
    '..........wcww..',
    '...........ww...',
    '........ww.s....',
    '.......wwwws....',
    '.......wcwws....',
    '........wws.....',
    '.....ww..s......',
    '....wwwws.......',
    '....wcwws.......',
    '.....wws........',
    '.......s........',
    '......s.........',
    '.....s..........',
  ],
  mushroom: [
    '........', '........', '.....rrr', '...rrrrr', '..rrwwrr', '.rrrwwrr', '.rrrrrrr', 'rwwrrrrw',
    'rwwrrrrr', 'RRRRRRRR', '....cccc', '....cccc', '....cccc', '....cccc', '...ccccc', '........',
  ],
  guitar: [
    '......BB', '......Bk', '......BB', '.......b', '.......b', '.......b', '.......b', '....llll',
    '...lllll', '...llllb', '....llkk', '...lllkk', '..llllll', '..llllBB', '...lllll', '.....lll',
  ],
  hedgehog: [
    '........', '........', '.....B.B', '...BBBBB', '..BbBbBb', '.BBBBBBB', '.BbBcccc', 'BBBcckcc',
    'BBBccccc', 'BbBcccck', 'BBBBcccc', '.BBBBccc', '.BBBBBcc', '..BBBBBB', '...cc...', '........',
  ],
  fox: [
    '........', '..O.....', '..OO....', '..OpO...', '..oooooo', '.ooooooo', '.ooookoo', '.wwooooo',
    '..wwwwwk', '...wwwww', '....oooo', '...owwww', '...owwww', '...oowww', '...kkooo', '........',
  ],
  owl: [
    '........', '..b.....', '..bb....', '..bbbbbb', '.bbbbbbb', '.bwwwbbb', 'bwykywbb', 'bwyyywbb',
    'bbwwwbYY', 'bbbbbbbY', 'bbllbllb', 'bblllllb', 'bbllbllb', '.bbllllb', '..YY.YY.', '........',
  ],
  deer: [
    '.B....B.', 'B.B..B..', '.BBB.B..', '..BBB...', '....BB..', '..llllll', '.lllllll', '..llklll',
    '...lllll', '...lllck', '....llll', '...lllww', '...llwww', '...llwww', '...kklll', '........',
  ],
  bear: [
    '........', '.bb.....', '.blbbbbb', '.bbbbbbb', '.bbbbbbb', '.bbbkbbb', '.bbbbbll', '.bbbbllk',
    '..bbblll', '...bbbbb', '..bbbbbb', '.bbbblll', '.bbbblll', '.bbbblll', '.BBbbbbb', '........',
  ],
  wolf: [
    '........', '..G.....', '..GG....', '..GLG...', '..gggggg', '.ggggggg', '.ggggkgg', '.LLggggg',
    '..LLLLLk', '...LLLLL', '....gggg', '...gLLLL', '...gLLLL', '...ggLLL', '...GGggg', '........',
  ],
};
/** Turns one of PIXEL_ART into crisp SVG, a rect per run of one color. */
function pixelSvg(id) {
  const rows = PIXEL_ART[id];
  if (!rows) return '';
  let rects = '';
  rows.forEach((half, y) => {
    const row = half.length === 8 ? half + [...half].reverse().join('') : half;
    for (let x = 0; x < row.length;) {
      const ch = row[x];
      let n = 1;
      while (row[x + n] === ch) n++;
      if (PIXEL_COLORS[ch]) rects += `<rect x="${x}" y="${y}" width="${n}" height="1" fill="${PIXEL_COLORS[ch]}"/>`;
      x += n;
    }
  });
  return `<svg class="pixel-art" viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true">${rects}</svg>`;
}
const FIRE_LOOK_ART = { classic: '🪵', birch: '🤍', sparks: '✨', blue: '💙' };
// The sky above a hearth's fires, matching SKY_LOOKS on the server.
const SKY_ART = { evening: '🌆', stars: '✨', moon: '🌕', aurora: '🌌', meteors: '🌠' };

/** What someone has by their seat, from whichever hearth or conversation knows them. */
function fireItemOf(userId) {
  if (userId === state.me.id) return state.me.fireItem ?? null;
  for (const s of state.servers.values()) {
    const m = s.members?.find((x) => x.id === userId);
    if (m) return m.fireItem ?? null;
  }
  return null;
}

/** Called by renderFire for each seat: the thing by it, and the look of the whole fire. */
function decorateSeat(wrap, userId) {
  const id = fireItemOf(userId);
  const el = wrap.querySelector('.seat-item');
  if (!id || !PIXEL_ART[id]) return el?.remove();
  if (el?.dataset.item === id) return;
  el?.remove();
  wrap.insertAdjacentHTML('beforeend', `<span class="seat-item" data-item="${id}" title="${escapeHtml(FIRE_ITEM_NAMES[id])}">${pixelSvg(id)}</span>`);
}
function decorateFire(s) {
  const hearth = s && !isDm(s);
  const look = hearth ? s.fireLook || 'classic' : 'classic';
  $('#fire-ring').dataset.look = look;
  sparksLayer(look === 'sparks');
  skyLayer(hearth ? s.skyLook || 'evening' : 'evening');
  seasonLayer();
}

// The sky above the fire: stars scattered over it, with a moon, northern lights or shooting stars.
function skyLayer(sky) {
  const wrap = $('.fire-ring-wrap');
  const layer = $('#sky-layer');
  if (sky === 'evening') { delete wrap.dataset.sky; return layer.replaceChildren(); }
  if (wrap.dataset.sky === sky) return;
  wrap.dataset.sky = sky;
  const bits = [];
  for (let i = 0; i < 70; i++) {
    // Thicker towards the top, where the firelight doesn't reach.
    const y = Math.pow(Math.random(), 1.6) * 85;
    const dur = 2.5 + Math.random() * 4;
    bits.push(`<span class="star" style="--x:${(Math.random() * 100).toFixed(1)}%;--y:${y.toFixed(1)}%;--s:${(1 + Math.random() * 1.6).toFixed(1)}px;--d:${dur.toFixed(1)}s;--delay:${(-Math.random() * dur).toFixed(1)}s"></span>`);
  }
  if (sky === 'moon') bits.push('<span class="moon"></span>');
  if (sky === 'aurora') bits.push('<span class="aurora a1"></span><span class="aurora a2"></span><span class="aurora a3"></span>');
  if (sky === 'meteors') {
    for (let i = 0; i < 4; i++) {
      const dur = 5 + Math.random() * 6;
      bits.push(`<span class="meteor" style="--x:${(20 + Math.random() * 75).toFixed(1)}%;--y:${(Math.random() * 30).toFixed(1)}%;--d:${dur.toFixed(1)}s;--delay:${(-Math.random() * dur).toFixed(1)}s"></span>`);
    }
  }
  layer.innerHTML = bits.join('');
}

const hoursText = (h) => (h < 1 ? `${Math.round(h * 60)} minutes` : `${h < 10 ? h.toFixed(1).replace(/\.0$/, '') : Math.floor(h)} hour${h >= 1 && h < 1.05 ? '' : 's'}`);

async function openFireDecor() {
  const s = fireServer();
  const hearth = s && !isDm(s) ? s : null;
  let mine, fire;
  try {
    [mine, fire] = await Promise.all([api('/api/me/fire'), hearth ? api(`/api/servers/${hearth.id}/fire`) : null]);
  } catch (err) { return alertError(err); }
  const item = (it) => {
    const open = mine.hours >= it.hours;
    return `<button type="button" class="decor-pick${mine.item === it.id ? ' chosen' : ''}" data-item="${it.id}" ${open ? '' : 'disabled'} aria-pressed="${mine.item === it.id}">
      <span class="decor-art">${open ? pixelSvg(it.id) || '?' : '🔒'}</span><span>${escapeHtml(it.name)}</span><span class="small muted">${open ? (mine.item === it.id ? 'By your seat' : 'Unlocked') : `At ${it.hours} hours`}</span></button>`;
  };
  const look = (l) => {
    const open = fire.hours >= l.hours;
    return `<button type="button" class="decor-pick${fire.look === l.id ? ' chosen' : ''}" data-look="${l.id}" ${open && fire.canChange ? '' : 'disabled'} aria-pressed="${fire.look === l.id}">
      <span class="decor-art">${open ? FIRE_LOOK_ART[l.id] ?? '🔥' : '🔒'}</span><span>${escapeHtml(l.name)}</span><span class="small muted">${open ? (fire.look === l.id ? 'Burning now' : 'Unlocked') : `At ${l.hours} hours`}</span></button>`;
  };
  const sky = (l) => {
    const open = fire.hours >= l.hours;
    return `<button type="button" class="decor-pick${fire.sky === l.id ? ' chosen' : ''}" data-sky="${l.id}" ${open && fire.canChange ? '' : 'disabled'} aria-pressed="${fire.sky === l.id}">
      <span class="decor-art">${open ? SKY_ART[l.id] ?? '✨' : '🔒'}</span><span>${escapeHtml(l.name)}</span><span class="small muted">${open ? (fire.sky === l.id ? 'Overhead now' : 'Unlocked') : `At ${l.hours} hours`}</span></button>`;
  };
  const canToast = mine.hours >= mine.marshmallowHours;
  modal(`<h2>By the fire</h2>
    <p class="muted">You've spent <b>${hoursText(mine.hours)}</b> at fires. More time there unlocks more to keep by your seat, which everyone at the fire sees.</p>
    <div class="decor-grid" id="decor-items">
      <button type="button" class="decor-pick${mine.item ? '' : ' chosen'}" data-item="" aria-pressed="${!mine.item}"><span class="decor-art">·</span><span>Nothing</span><span class="small muted">Just you</span></button>
      ${mine.items.map(item).join('')}
    </div>
    <div class="admin-row"><button type="button" class="btn secondary" id="decor-toast" ${canToast && state.voice ? '' : 'disabled'}>🍡 Toast a marshmallow</button>
      <span class="small muted">${canToast ? (state.voice ? 'Or click the fire.' : 'Sit down at a fire first.') : `Marshmallows unlock after ${mine.marshmallowHours} hours at the fire.`}</span></div>
    ${fire ? `<h3>${escapeHtml(hearth.name)}'s fire</h3>
      <p class="small muted">Everyone's time around ${escapeHtml(hearth.name)}'s fires together: <b>${hoursText(fire.hours)}</b>. ${fire.canChange ? 'Pick how its fires burn.' : 'People who can edit the hearth pick how its fires burn.'}</p>
      <div class="decor-grid" id="decor-looks">${fire.looks.map(look).join('')}</div>
      <h3>The sky above</h3>
      <div class="decor-grid" id="decor-skies">${fire.skies.map(sky).join('')}</div>` : ''}
    <div class="modal-row"><button type="button" class="btn secondary" data-close>Close</button></div>`, 'decor-modal');
  for (const b of document.querySelectorAll('#decor-items [data-item]')) b.onclick = async () => {
    try {
      const r = await api('/api/me/fire', { method: 'PUT', body: { item: b.dataset.item || null } });
      state.me.fireItem = r.item;
      renderFire();
      openFireDecor();
    } catch (err) { alertError(err); }
  };
  for (const b of document.querySelectorAll('#decor-looks [data-look]')) b.onclick = async () => {
    try {
      await api(`/api/servers/${hearth.id}/fire`, { method: 'PUT', body: { look: b.dataset.look } });
      hearth.fireLook = b.dataset.look;
      renderFire();
      openFireDecor();
    } catch (err) { alertError(err); }
  };
  for (const b of document.querySelectorAll('#decor-skies [data-sky]')) b.onclick = async () => {
    try {
      await api(`/api/servers/${hearth.id}/fire`, { method: 'PUT', body: { sky: b.dataset.sky } });
      hearth.skyLook = b.dataset.sky;
      renderFire();
      openFireDecor();
    } catch (err) { alertError(err); }
  };
  $('#decor-toast').onclick = () => { closeModal(); toastMarshmallow(); };
}
$('#fire-decor').onclick = openFireDecor;

// ---------------------------------------------------------------- marshmallows

async function toastMarshmallow() {
  if (!state.voice) return;
  try {
    await api('/api/voice/marshmallow', { method: 'POST', body: {} });
  } catch (err) {
    fireNote(err.message);
  }
}
$('#fire-ring .fire-core').addEventListener('click', toastMarshmallow);

const MARSHMALLOW_LINES = {
  golden: (n, me) => `${me ? 'You' : n} toasted a golden marshmallow`,
  perfect: (n, me) => `${me ? 'You' : n} toasted a perfect marshmallow ✨`,
  burnt: (n, me) => `${me ? 'Your' : `${n}'s`} marshmallow caught fire 🔥`,
  dropped: (n, me) => `${me ? 'You dropped your' : `${n} dropped their`} marshmallow in the fire`,
  sticky: (n, me) => `${me ? 'You have' : `${n} has`} marshmallow all over ${me ? 'your' : 'their'} fingers`,
};
function onMarshmallow(ev) {
  if (state.voice?.channelId !== ev.channelId) return;
  fireNote((MARSHMALLOW_LINES[ev.outcome] ?? MARSHMALLOW_LINES.golden)(nameOf(ev.userId), ev.userId === state.me.id));
  // A marshmallow on a stick over the flame, toasting to how it turned out.
  const m = $('#marshmallow');
  m.className = `marshmallow ${ev.outcome}`;
  void m.offsetWidth; // start the animation again
  m.classList.add('go');
}

// ---------------------------------------------------------------- birthdays

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const birthdayText = (b) => `${Number(b.slice(3))} ${MONTHS[Number(b.slice(0, 2)) - 1]}`;
/** Whether it's their birthday where you are. 29 February is celebrated on the 28th in other years. */
function isBirthdayToday(b) {
  if (!b) return false;
  const now = new Date();
  const today = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const leap = new Date(now.getFullYear(), 1, 29).getMonth() === 1;
  return b === today || (b === '02-29' && !leap && today === '02-28');
}

/** The birthday picker in your profile. */
function birthdayField(b) {
  const month = b ? Number(b.slice(0, 2)) : 0, day = b ? Number(b.slice(3)) : 0;
  return `<div class="birthday-row">
      <label>Birthday<select id="profile-bday-month"><option value="">Month</option>${MONTHS.map((m, i) => `<option value="${i + 1}" ${month === i + 1 ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
      <label><span class="sr-only">Day</span><select id="profile-bday-day"><option value="">Day</option>${Array.from({ length: 31 }, (_, i) => `<option ${day === i + 1 ? 'selected' : ''}>${i + 1}</option>`).join('')}</select></label>
    </div>
    <span class="small muted">Only the month and day. People in your hearths see a 🎂 by your name that day.</span>`;
}
function readBirthday() {
  const m = $('#profile-bday-month').value, d = $('#profile-bday-day').value;
  return m && d ? `${m.padStart(2, '0')}-${d.padStart(2, '0')}` : null;
}

// ---------------------------------------------------------------- the hearth today: birthdays and the message of the day

const dayNumber = () => {
  const now = new Date();
  return Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 864e5);
};
const todayKey = () => new Date().toDateString();

function renderToday(s) {
  const box = $('#hearth-today');
  if (!s || isDm(s)) return box.classList.add('hidden');
  const parts = [];
  const birthdays = (s.members ?? []).filter((m) => !m.deleted && isBirthdayToday(m.birthday));
  for (const m of birthdays.slice(0, 3)) {
    const mine = m.id === state.me.id;
    parts.push(`<div class="today-birthday"><span class="today-cake" aria-hidden="true">🎂</span><span>${mine ? '<b>Happy birthday!</b> from everyone here' : `It's <b>${escapeHtml(nameOfPerson(m))}</b>'s birthday today`}</span>
      ${mine ? '' : `<button type="button" class="btn secondary tiny-btn" data-wish="${m.id}">Wish them well</button>`}</div>`);
  }
  if (birthdays.length > 3) parts.push(`<div class="small muted">and ${birthdays.length - 3} more birthdays today</div>`);
  const motd = s.motd ?? [];
  const hidden = store.get(`motdHidden:${s.id}`) === todayKey();
  if (motd.length && !hidden) {
    const m = motd[dayNumber() % motd.length];
    parts.push(`<div class="today-motd">
        ${m.picture ? `<button type="button" class="today-photo" title="Open the photo"><img src="${escapeHtml(state.serverUrl + m.picture)}" alt="" loading="lazy" /></button>` : ''}
        ${m.text ? `<p>${escapeHtml(m.text)}</p>` : ''}
        <button type="button" class="icon-btn today-hide" title="Hide until tomorrow" aria-label="Hide until tomorrow">✕</button>
      </div>`);
  }
  const month = new Date().getMonth();
  if (month === 11 || month === 0) {
    const year = month === 11 ? new Date().getFullYear() : new Date().getFullYear() - 1;
    parts.push(`<button type="button" class="today-review" data-year="${year}">✨ ${escapeHtml(s.name)}'s ${year} in review</button>`);
  }
  box.classList.toggle('hidden', !parts.length);
  box.innerHTML = parts.join('');
  for (const b of box.querySelectorAll('[data-wish]')) b.onclick = () => wishHappyBirthday(s, Number(b.dataset.wish));
  box.querySelector('.today-hide')?.addEventListener('click', () => { store.set(`motdHidden:${s.id}`, todayKey()); renderToday(s); });
  box.querySelector('.today-photo')?.addEventListener('click', () => {
    const m = motd[dayNumber() % motd.length];
    window.open(state.serverUrl + m.picture, '_blank', 'noopener');
  });
  box.querySelector('.today-review')?.addEventListener('click', (e) => openYearReview(s.id, Number(e.currentTarget.dataset.year)));
}

/** Goes to the hearth's welcome room (or the first room you can write in) with a wish ready to send. */
async function wishHappyBirthday(s, userId) {
  const m = s.members.find((x) => x.id === userId);
  const writable = s.channels.filter((c) => c.kind === 'text' && !c.archived && c.canPost !== false);
  const room = writable.find((c) => c.id === s.welcomeChannelId) ?? writable[0];
  if (!room || !m) return;
  if (state.channelId !== room.id) await selectChannel(room.id);
  input.value = `Happy birthday @${m.username}! 🎂`;
  autosize();
  input.focus();
}

// Managing the messages of the day, for people who can edit the hearth.
function openMotd(serverId) {
  const s = state.servers.get(serverId);
  if (!s) return closeModal();
  const list = s.motd ?? [];
  modal(`<h2>Message of the day</h2>
    <p class="small muted">A line or a photo at the top of ${escapeHtml(s.name)}, a different one each day, in turn. Everyone sees today's above the rooms.</p>
    <ul class="motd-list">${list.map((m, i) => `<li data-id="${m.id}">
        ${m.picture ? `<img src="${escapeHtml(state.serverUrl + m.picture)}" alt="" />` : ''}
        <span class="motd-text">${m.text ? escapeHtml(m.text) : '<span class="muted">Just the photo</span>'}${i === dayNumber() % list.length ? ' <span class="small muted">· today</span>' : ''}</span>
        <button type="button" class="btn secondary tiny-btn" data-edit="${m.id}">Edit</button>
        <button type="button" class="icon-btn" data-delete="${m.id}" title="Delete" aria-label="Delete">✕</button>
      </li>`).join('') || '<li class="small muted">None yet. Add a joke, a quote, a reminder or a favourite photo.</li>'}</ul>
    <form id="motd-new">
      <input id="motd-text" maxlength="200" placeholder="Write a message of the day" />
      <div class="admin-row">
        <button type="submit" class="btn">Add</button>
        ${state.maxUploadBytes ? '<button type="button" class="btn secondary" id="motd-photo">Add with a photo</button><input type="file" id="motd-file" accept="image/png,image/jpeg,image/gif,image/webp" hidden />' : ''}
      </div>
      <div class="error" id="motd-error"></div>
    </form>
    <div class="modal-row"><button type="button" class="btn secondary" data-close>Close</button></div>`, 'motd-modal');
  const done = (r) => { s.motd = r.motd; renderToday(state.servers.get(state.serverId) === s ? s : null); openMotd(serverId); };
  const fail = (err) => { $('#motd-error').textContent = err.message; };
  $('#motd-new').onsubmit = async (e) => {
    e.preventDefault();
    try { done(await api(`/api/servers/${serverId}/motd`, { method: 'POST', body: { text: $('#motd-text').value } })); } catch (err) { fail(err); }
  };
  $('#motd-photo')?.addEventListener('click', () => $('#motd-file').click());
  $('#motd-file')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    $('#motd-photo').disabled = true;
    $('#motd-photo').textContent = 'Uploading…';
    try {
      done(await uploadPicture(`/api/servers/${serverId}/motd/picture?text=${encodeURIComponent($('#motd-text').value)}`, await fitPicture(file, 1280)));
    } catch (err) {
      fail(err);
      $('#motd-photo').disabled = false;
      $('#motd-photo').textContent = 'Add with a photo';
    }
  });
  for (const b of document.querySelectorAll('.motd-list [data-delete]')) b.onclick = async () => {
    try { done(await api(`/api/motd/${b.dataset.delete}`, { method: 'DELETE' })); } catch (err) { fail(err); }
  };
  for (const b of document.querySelectorAll('.motd-list [data-edit]')) b.onclick = async () => {
    const m = list.find((x) => x.id === Number(b.dataset.edit));
    const text = prompt('Message of the day', m.text);
    if (text === null) return;
    try { done(await api(`/api/motd/${m.id}`, { method: 'PATCH', body: { text } })); } catch (err) { fail(err); }
  };
}

// ---------------------------------------------------------------- the year in review

async function openYearReview(serverId, year = new Date().getFullYear()) {
  const s = state.servers.get(serverId);
  if (!s) return;
  let r;
  try { r = await api(`/api/servers/${serverId}/review/${year}`); } catch (err) { return alertError(err); }
  const n = (x) => Number(x).toLocaleString();
  const day = r.busiestDay ? new Date(`${r.busiestDay.day}T12:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'long' }) : null;
  const list = (items, line) => items.length ? `<ol class="review-list">${items.map(line).join('')}</ol>` : '<p class="small muted">Nothing yet.</p>';
  const empty = !r.messages && r.fireHours < 0.05;
  modal(`<div class="review-head">
      <span class="review-kicker">${escapeHtml(s.name)}</span>
      <h2>${year} in review</h2>
      ${r.years.length > 1 ? `<select id="review-year" aria-label="Year">${r.years.map((y) => `<option ${y === year ? 'selected' : ''}>${y}</option>`).join('')}</select>` : ''}
    </div>
    ${empty ? '<p class="muted">A quiet year by this fire. Nothing to look back on yet.</p>' : `
    <div class="review-stats">
      <div><b>${n(r.messages)}</b><span>messages</span></div>
      <div><b>${r.fireHours < 1 ? Math.round(r.fireHours * 60) : n(Math.round(r.fireHours))}</b><span>${r.fireHours < 1 ? 'minutes' : 'hours'} around the fire</span></div>
      <div><b>${n(r.newPeople)}</b><span>new ${r.newPeople === 1 ? 'face' : 'faces'}</span></div>
    </div>
    <div class="review-grid">
      <section><h3>Busiest rooms</h3>${list(r.topRooms, (x) => `<li><span>#${escapeHtml(x.name)}</span><span class="muted">${n(x.messages)}</span></li>`)}</section>
      <section><h3>Favourite reactions</h3>${r.topReactions.length ? `<div class="review-emoji">${r.topReactions.map((x) => `<span title="${n(x.n)} times">${emojiHtml(x.emoji)}<small>${n(x.n)}</small></span>`).join('')}</div>` : '<p class="small muted">No reactions yet.</p>'}</section>
      <section><h3>Most talkative</h3>${list(r.topPeople, (x) => `<li><span>${escapeHtml(x.name)}</span><span class="muted">${n(x.n)}</span></li>`)}</section>
      <section><h3>Keepers of the fire</h3>${list(r.topFire, (x) => `<li><span>${escapeHtml(x.name)}</span><span class="muted">${hoursText(x.hours)}</span></li>`)}</section>
    </div>
    ${r.mostLoved ? `<section class="review-loved"><h3>Most loved message</h3><blockquote>${escapeHtml(r.mostLoved.content)}</blockquote><span class="small muted">${escapeHtml(r.mostLoved.author)} · ${n(r.mostLoved.reactions)} reactions</span></section>` : ''}
    ${day ? `<p class="small muted">The busiest day was ${escapeHtml(day)}, with ${n(r.busiestDay.n)} messages.</p>` : ''}
    <section class="review-you"><h3>You</h3><p>${n(r.you.messages)} messages, ${n(r.you.reactions)} reactions and ${hoursText(r.you.fireHours)} at the fire.</p></section>`}
    <div class="modal-row"><button type="button" class="btn secondary" data-close>Close</button></div>`, 'review-modal');
  $('#review-year')?.addEventListener('change', (e) => openYearReview(serverId, Number(e.target.value)));
}
