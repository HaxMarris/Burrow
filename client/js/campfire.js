// Watching streams, the Campfire, encrypted voice, volume and sounds.
// Part of Burrow's client: plain scripts that index.html loads in order, sharing one global scope.
'use strict';

// ---------------------------------------------------------------- watching streams
//
// Extras around the video grid: popping a stream out, the fireside chat over a stream, who's
// watching, a preview of a screen before you open it, drawing on a shared screen and clips.
// What the people at a fire tell each other for these goes through the voice server sealed with
// the room key, like the voice itself, so the server can't see it.

const PIP_ICON = '<svg viewBox="0 0 24 24"><path d="M3 5h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm1 2v10h16V7H4Zm8 4h7v5h-7v-5Z"/></svg>';
const PEN_ICON = '<svg viewBox="0 0 24 24"><path d="m14.1 5.1 4.8 4.8L8.8 20H4v-4.8L14.1 5.1Zm1.4-1.4 1.8-1.8a1.5 1.5 0 0 1 2.1 0l2.7 2.7a1.5 1.5 0 0 1 0 2.1l-1.8 1.8-4.8-4.8Z"/></svg>';
const CLIP_ICON = '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18Zm0 2a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm-1 3h2v4.4l3.2 1.9-1 1.7L11 13.6V8Z"/></svg>';
const TAB_ICON = '<svg viewBox="0 0 24 24"><path d="M3 4h7l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm1 5v9h16V9H4Z"/></svg>';
const EYE_ICON = '<svg viewBox="0 0 24 24"><path d="M12 5c5 0 8.7 3.6 10 7-1.3 3.4-5 7-10 7S3.3 15.4 2 12c1.3-3.4 5-7 10-7Zm0 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z"/></svg>';

const poppedOutKey = () => (poppedKey && document.pictureInPictureElement && tiles.get(poppedKey)?.media === document.pictureInPictureElement ? poppedKey : null);

/** The extra buttons in a video tile's corner. */
function streamTools(t) {
  const button = (cls, title, icon, run) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'vtile-tool ' + cls;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.innerHTML = icon;
    b.onclick = (e) => { e.stopPropagation(); run(); };
    return b;
  };
  const out = [];
  if (t.kind === 'screen') out.push(button('tool-draw', 'Draw on this screen', PEN_ICON, () => toggleDrawing(t)));
  if (t.kind === 'screen' && t.id !== state.me.id && window.MediaRecorder) out.push(button('tool-clip', 'Keep clips of this stream', CLIP_ICON, () => (clips.has(t.key) ? saveClip(t) : startClips(t))));
  out.push(button('tool-chat', 'Fireside chat over the video', CHAT_ICON, () => toggleStreamChat(t)));
  if (document.pictureInPictureEnabled) out.push(button('tool-pip', 'Pop out, to keep watching while you chat', PIP_ICON, () => popOut(t)));
  return out;
}
function updateStreamTools(t) {
  t.tools.querySelector('.tool-draw')?.classList.toggle('on', drawingOn.has(t.key));
  const clip = t.tools.querySelector('.tool-clip');
  if (clip) {
    const on = clips.has(t.key);
    clip.classList.toggle('on', on);
    clip.classList.toggle('hidden', !state.maxUploadBytes);
    clip.title = on ? `Save the last ${CLIP_SECONDS} seconds` : 'Keep clips of this stream';
  }
  t.tools.querySelector('.tool-chat')?.classList.toggle('on', t.el.contains($('#fire-chat')));
  const pip = t.tools.querySelector('.tool-pip');
  if (pip) {
    pip.classList.toggle('on', poppedOutKey() === t.key);
    pip.title = poppedOutKey() === t.key ? 'Put it back' : 'Pop out, to keep watching while you chat';
  }
}

// ---- pop out: the browser's own picture-in-picture window, which stays on top while you chat

async function popOut(t) {
  try {
    if (poppedOutKey() === t.key) return await document.exitPictureInPicture();
    if (t.media?.requestPictureInPicture) await t.media.requestPictureInPicture();
  } catch (err) {
    toast(`Couldn't pop it out: ${err.message}`);
  }
}

// ---- the fireside chat over a stream, so you can read and write while it fills the screen

let chatHome = null; // where the fireside chat usually sits
function toggleStreamChat(t) {
  const chat = $('#fire-chat');
  if (t.el.contains(chat)) return restoreStreamChat(), renderStage();
  chatHome ??= { parent: chat.parentNode, next: chat.nextSibling };
  if (!t.el.classList.contains('focus') && document.fullscreenElement !== t.el) { focusKey = t.key; sideBySide = false; }
  chat.classList.add('overlay');
  t.el.append(chat);
  renderStage();
  renderFireside();
  $('#fire-chat-list').scrollTop = $('#fire-chat-list').scrollHeight;
  $('#fire-chat-input').focus();
}
function restoreStreamChat() {
  const chat = $('#fire-chat');
  if (!chat.classList.contains('overlay') || !chatHome) return;
  chat.classList.remove('overlay');
  chatHome.parent.insertBefore(chat, chatHome.next);
  for (const t of tiles.values()) { t.el.classList.remove('chatting'); updateStreamTools(t); }
  renderFireside();
}

// ---- messages sealed with the room key

const ROOM_TOPIC = 'burrow-room';
/** Keeps a room key the voice uses, so messages can be sealed with it too. */
function rememberRoomKey(vc, index, raw) {
  vc.raws ??= new Map();
  vc.aes ??= new Map();
  vc.raws.set(index, raw);
  vc.aes.delete(index);
}
async function roomAesKey(vc, index) {
  let key = vc.aes?.get(index);
  if (!key) {
    const raw = vc.raws?.get(index);
    if (!raw) return null;
    key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    vc.aes.set(index, key);
  }
  return key;
}
/** Sends something to everyone at the fire. False if it couldn't go (nobody else, or no key yet). */
async function sendRoomData(voice, message) {
  const vc = voice?.crypto, room = voice?.room;
  if (!vc || !room || vc.index < 0 || !room.remoteParticipants.size) return false;
  const index = vc.index;
  const key = await roomAesKey(vc, index);
  if (!key) return false;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(message))));
  const packet = new Uint8Array(13 + sealed.length);
  packet[0] = index;
  packet.set(iv, 1);
  packet.set(sealed, 13);
  try {
    await room.localParticipant.publishData(packet, { reliable: true, topic: ROOM_TOPIC });
    return true;
  } catch {
    return false;
  }
}
async function onRoomData(voice, payload, participant) {
  if (state.voice !== voice || !participant || payload.length < 14) return;
  const key = await roomAesKey(voice.crypto, payload[0]);
  if (!key) return;
  let msg;
  try {
    const opened = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: payload.slice(1, 13) }, key, payload.slice(13));
    msg = JSON.parse(new TextDecoder().decode(opened));
  } catch { return; }
  const from = Number(participant.identity);
  if (msg.t === 'watch' && Array.isArray(msg.ids)) {
    watchersOf(voice).set(from, new Set(msg.ids.map(Number)));
    renderStage();
  } else if (msg.t === 'thumb') {
    if (typeof msg.img === 'string' && msg.img.startsWith('data:image/jpeg;base64,') && msg.img.length < 20000) thumbsOf(voice).set(from, msg.img);
    else thumbsOf(voice).delete(from);
    refreshPeek(from);
  } else if (msg.t === 'draw') onDrawData(from, msg);
}
/** A new room key: tell everyone (newcomers too) what we're watching and showing. */
function roomKeyReady(voice) {
  voice.watchSent = null;
  reportWatching();
  if (voice.thumbTimer) sendThumb(voice);
}
const watchersOf = (voice) => (voice.watching ??= new Map()); // who -> ids of the screens they're watching
const thumbsOf = (voice) => (voice.thumbs ??= new Map());     // who -> a small picture of their screen

// ---- who's watching

/** Tells the others whose screens we have open. */
async function reportWatching() {
  const voice = state.voice;
  if (!voice?.room) return;
  const ids = [...tiles.values()].filter((t) => t.kind === 'screen' && t.track && t.id !== state.me.id).map((t) => t.id).sort((a, b) => a - b);
  const key = ids.join(',');
  if (key === voice.watchSent) return;
  voice.watchSent = key;
  if (!(await sendRoomData(voice, { t: 'watch', ids })) && voice.watchSent === key) voice.watchSent = null;
}
/** Everyone watching someone's screen, ourselves included. */
function viewersOf(id) {
  const voice = state.voice;
  if (!voice) return [];
  const here = new Set([...(voice.room?.remoteParticipants.keys() ?? [])].map(Number));
  const ids = [...watchersOf(voice)].filter(([who, set]) => here.has(who) && set.has(id)).map(([who]) => who);
  if (id !== state.me.id && [...tiles.values()].some((t) => t.kind === 'screen' && t.id === id && t.track)) ids.push(state.me.id);
  return ids;
}
function renderViewers(t) {
  const ids = viewersOf(t.id);
  t.viewers.classList.toggle('hidden', !ids.length);
  t.viewers.innerHTML = `${EYE_ICON}<span>${ids.length}</span>`;
  t.viewers.title = `Watching: ${ids.map((id) => (id === state.me.id ? 'you' : nameOf(id))).join(', ')}`;
}

// ---- a preview of someone's screen, before you open it

const THUMB_MS = 15_000;
function startThumbs(voice) {
  stopThumbs(voice);
  voice.thumbTimer = setInterval(() => sendThumb(voice), THUMB_MS);
  setTimeout(() => sendThumb(voice), 1500);
}
function stopThumbs(voice) {
  if (!voice) return;
  clearInterval(voice.thumbTimer);
  voice.thumbTimer = null;
  voice.myThumb = null;
  if (voice.thumbVideo) voice.thumbVideo.srcObject = null;
  voice.thumbVideo = null;
}
async function sendThumb(voice) {
  const LK = window.LivekitClient;
  const track = voice.room?.localParticipant.getTrackPublication(LK.Track.Source.ScreenShare)?.track?.mediaStreamTrack;
  if (!track || state.voice !== voice) return;
  const video = (voice.thumbVideo ??= Object.assign(document.createElement('video'), { muted: true, playsInline: true }));
  if (video.srcObject?.getVideoTracks()[0] !== track) {
    video.srcObject = new MediaStream([track]);
    await video.play().catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!video.videoWidth) return;
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = Math.round((256 * video.videoHeight) / video.videoWidth);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  // Small enough for one message.
  for (const quality of [0.6, 0.45, 0.3]) {
    const img = canvas.toDataURL('image/jpeg', quality);
    if (img.length > 12_000) continue;
    voice.myThumb = img;
    refreshPeek(state.me.id);
    return sendRoomData(voice, { t: 'thumb', img });
  }
}
/** Shows the preview while the pointer is over something about someone's shared screen. */
function attachPeek(el, id) {
  el.addEventListener('mouseenter', () => showPeek(el, id));
  el.addEventListener('mouseleave', hidePeek);
  el.addEventListener('click', hidePeek);
}
function peekImage(id) {
  const voice = state.voice;
  return id === state.me.id ? voice?.myThumb : voice && thumbsOf(voice).get(id);
}
function showPeek(anchor, id) {
  hidePeek();
  if (!state.sharing.get(id)?.screen) return;
  const peek = document.createElement('div');
  peek.id = 'stream-peek';
  peek.className = 'stream-peek';
  peek.dataset.id = id;
  document.body.append(peek);
  fillPeek(peek, id);
  const r = anchor.getBoundingClientRect();
  const w = 260;
  peek.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
  const above = r.top - peek.offsetHeight - 8;
  peek.style.top = `${above > 8 ? above : r.bottom + 8}px`;
}
function fillPeek(peek, id) {
  const img = peekImage(id);
  const name = id === state.me.id ? 'Your screen' : `${nameOf(id)}'s screen`;
  peek.innerHTML = (img ? `<img src="${img}" alt="" />` : '<div class="peek-wait">The preview shows up in a moment</div>')
    + `<span>${escapeHtml(name)}${viewersOf(id).length ? ` · ${viewersOf(id).length} watching` : ''}</span>`;
}
function refreshPeek(id) {
  const peek = $('#stream-peek');
  if (peek && Number(peek.dataset.id) === id) fillPeek(peek, id);
}
function hidePeek() { $('#stream-peek')?.remove(); }

// ---- drawing on a shared screen: everyone watching sees it, and the sharer too

const drawingOn = new Set(); // tiles you're drawing on
const strokes = new Map();   // whose screen -> its strokes [{ id, from, color, pts: [[x, y], ...], endedAt }]
const DRAW_FADE_MS = 3000;
const DRAW_COLORS = ['#ff5a4e', '#ffd23f', '#3ddc84', '#4fb3ff', '#c77dff', '#ff8fd0', '#ff9f43'];
const drawColor = (userId) => DRAW_COLORS[Math.abs(userId) % DRAW_COLORS.length];

function toggleDrawing(t) {
  if (drawingOn.has(t.key)) drawingOn.delete(t.key);
  else {
    drawingOn.add(t.key);
    if (!t.el.classList.contains('focus') && document.fullscreenElement !== t.el) { focusKey = t.key; sideBySide = false; }
    if (!store.get('drewBefore')) toast('Draw with your mouse or finger. It fades after a few seconds. Press the pen again to stop.');
    store.set('drewBefore', '1');
  }
  renderStage();
}
/** Where the picture sits inside a tile (the video keeps its shape, so there can be bars around it). */
function videoBox(t) {
  const r = t.el.getBoundingClientRect();
  const vw = t.media?.videoWidth, vh = t.media?.videoHeight;
  if (!vw || !vh) return { x: 0, y: 0, w: r.width, h: r.height, r };
  const scale = Math.min(r.width / vw, r.height / vh);
  const w = vw * scale, h = vh * scale;
  return { x: (r.width - w) / 2, y: (r.height - h) / 2, w, h, r };
}
function drawCanvas(t) {
  const canvas = document.createElement('canvas');
  canvas.className = 'vtile-draw';
  let stroke = null, timer = null;
  const at = (e) => {
    const b = videoBox(t);
    const clamp = (n) => Math.round(Math.min(1, Math.max(0, n)) * 10000) / 10000;
    return [clamp((e.clientX - b.r.left - b.x) / b.w), clamp((e.clientY - b.r.top - b.y) / b.h)];
  };
  const flush = (s) => {
    clearTimeout(timer);
    timer = null;
    const pts = s.pts.slice(s.sent);
    s.sent = s.pts.length;
    if (pts.length || s.endedAt) sendRoomData(state.voice, { t: 'draw', on: t.id, id: s.id, pts, done: !!s.endedAt });
    if (t.id === state.me.id) mirrorStrokes();
  };
  canvas.onpointerdown = (e) => {
    if (!drawingOn.has(t.key)) return;
    e.preventDefault();
    e.stopPropagation();
    canvas.setPointerCapture(e.pointerId);
    stroke = { id: `${state.me.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, from: state.me.id, color: drawColor(state.me.id), pts: [at(e)], sent: 0, endedAt: null };
    addStroke(t.id, stroke);
    flush(stroke);
  };
  canvas.onpointermove = (e) => {
    if (!stroke) return;
    stroke.pts.push(at(e));
    if (stroke.pts.length > 4000) return end();
    paintStrokes(t);
    timer ??= setTimeout(() => stroke && flush(stroke), 50);
  };
  const end = () => {
    if (!stroke) return;
    stroke.endedAt = Date.now();
    flush(stroke);
    stroke = null;
    animateStrokes();
  };
  canvas.onpointerup = end;
  canvas.onpointercancel = end;
  canvas.onclick = (e) => { if (drawingOn.has(t.key)) e.stopPropagation(); };
  return canvas;
}
function addStroke(on, stroke) {
  const list = strokes.get(on) ?? [];
  list.push(stroke);
  if (list.length > 200) list.shift();
  strokes.set(on, list);
  animateStrokes();
}
function onDrawData(from, msg) {
  const on = Number(msg.on);
  if (!state.sharing.get(on)?.screen || typeof msg.id !== 'string' || !msg.id.startsWith(`${from}-`) || !Array.isArray(msg.pts)) return;
  let s = strokes.get(on)?.find((x) => x.id === msg.id);
  if (!s) addStroke(on, (s = { id: msg.id, from, color: drawColor(from), pts: [], endedAt: null }));
  for (const p of msg.pts.slice(0, 500)) {
    if (Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && n >= 0 && n <= 1) && s.pts.length < 4000) s.pts.push(p);
  }
  if (msg.done) s.endedAt = Date.now();
  animateStrokes();
  if (on === state.me.id) mirrorStrokes();
}
/** How visible a stroke still is: fully, then fading out over its last second. */
const strokeAlpha = (s, now) => (s.endedAt ? Math.max(0, Math.min(1, (s.endedAt + DRAW_FADE_MS - now) / 1000)) : 1);
function paintStrokes(t) {
  const canvas = t.draw;
  if (!canvas) return;
  const list = strokes.get(t.id) ?? [];
  const dpr = devicePixelRatio || 1;
  const w = Math.round(t.el.clientWidth * dpr), h = Math.round(t.el.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) Object.assign(canvas, { width: w, height: h });
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  if (!list.length) return;
  const b = videoBox(t);
  const now = Date.now();
  ctx.lineCap = ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(3, b.w / 250) * dpr;
  for (const s of list) {
    if (!s.pts.length) continue;
    ctx.globalAlpha = strokeAlpha(s, now);
    ctx.strokeStyle = s.color;
    ctx.beginPath();
    s.pts.forEach(([x, y], i) => ctx[i ? 'lineTo' : 'moveTo']((b.x + x * b.w) * dpr, (b.y + y * b.h) * dpr));
    if (s.pts.length === 1) ctx.lineTo((b.x + s.pts[0][0] * b.w) * dpr + 0.1, (b.y + s.pts[0][1] * b.h) * dpr);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
let strokeFrame = 0;
/** Repaints while there are strokes, and drops the ones that have faded away. */
function animateStrokes() {
  if (strokeFrame) return;
  strokeFrame = requestAnimationFrame(() => {
    strokeFrame = 0;
    const now = Date.now();
    let any = false;
    for (const [on, list] of strokes) {
      const left = list.filter((s) => strokeAlpha(s, now) > 0);
      if (left.length !== list.length && on === state.me.id) mirrorStrokes();
      if (left.length) { strokes.set(on, left); any = true; } else strokes.delete(on);
    }
    for (const t of tiles.values()) if (t.draw) paintStrokes(t);
    if (any) animateStrokes();
  });
}
/** On the desktop app, strokes on your own shared screen also show on that screen itself. */
function mirrorStrokes() {
  const show = window.burrowDesktop?.drawOverlay;
  if (!show) return;
  const now = Date.now();
  show((strokes.get(state.me.id) ?? []).map((s) => ({ color: s.color, pts: s.pts, fadeIn: s.endedAt ? s.endedAt + DRAW_FADE_MS - now : null })));
}

// ---- clips: the last 30 seconds of someone's stream, recorded on your own device

const CLIP_SECONDS = 30;
const CLIP_STAGGER_MS = 15_000; // a new recording starts this often...
const CLIP_KEEP_MS = 45_000;    // ...and each is kept this long, so one always covers the last 30 seconds
const clips = new Map();        // tile key -> { stream, recorders: [{ rec, chunks, started }], timer }
function clipType() {
  return ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find((type) => MediaRecorder.isTypeSupported(type));
}
/** The most a clip may be, in bytes: what you can share in the burrow. */
const clipLimit = () => {
  const s = fireServer();
  return s && !isDm(s) && s.myUploadLimit != null ? s.myUploadLimit : state.maxUploadBytes;
};
function startClips(t, quiet = false) {
  const LK = window.LivekitClient;
  const type = clipType();
  if (!t.track || !type) return toast("This browser can't record clips.");
  if (!clipLimit()) return toast("Your roles can't share files here, so there's nowhere to post a clip.");
  const p = state.voice?.room?.remoteParticipants.get(String(t.id));
  const sound = p?.getTrackPublication(LK.Track.Source.ScreenShareAudio)?.track?.mediaStreamTrack;
  const stream = new MediaStream([t.track.mediaStreamTrack, ...(sound ? [sound] : [])]);
  // A bit rate that keeps the longest clip under the upload limit.
  const bits = Math.round(Math.max(600_000, Math.min(5_000_000, (clipLimit() * 8 * 0.85) / (CLIP_KEEP_MS / 1000) - 128_000)));
  const c = { stream, recorders: [], type, timer: null };
  const begin = () => {
    const now = Date.now();
    for (const r of [...c.recorders]) if (now - r.started > CLIP_KEEP_MS) { dropRecorder(r); c.recorders.splice(c.recorders.indexOf(r), 1); }
    try {
      const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: bits, audioBitsPerSecond: 128_000 });
      const r = { rec, chunks: [], started: now };
      rec.ondataavailable = (e) => { if (e.data.size) r.chunks.push(e.data); };
      rec.start(1000);
      c.recorders.push(r);
    } catch (err) {
      console.warn('Clip recorder:', err);
    }
  };
  c.begin = begin;
  begin();
  c.timer = setInterval(begin, CLIP_STAGGER_MS);
  clips.set(t.key, c);
  if (!quiet) toast(`Keeping clips of ${nameOf(t.id)}'s stream${sound ? '' : ' (without its sound, since you have it turned off)'}. Press the clip button again to save the last ${CLIP_SECONDS} seconds.`);
  updateStreamTools(t);
}
function dropRecorder(r) {
  r.rec.ondataavailable = null;
  try { if (r.rec.state !== 'inactive') r.rec.stop(); } catch {}
  r.chunks = [];
}
function stopClips(key) {
  const c = clips.get(key);
  if (!c) return;
  clearInterval(c.timer);
  c.recorders.forEach(dropRecorder);
  clips.delete(key);
  const t = tiles.get(key);
  if (t) updateStreamTools(t);
}
async function saveClip(t) {
  const c = clips.get(t.key);
  if (!c?.recorders.length) return;
  const now = Date.now();
  // The shortest recording that's at least 30 seconds long, or the longest there is.
  const long = c.recorders.filter((r) => now - r.started >= CLIP_SECONDS * 1000 - 500);
  const r = long.length ? long[long.length - 1] : c.recorders[0];
  c.recorders.splice(c.recorders.indexOf(r), 1);
  if (!c.recorders.length) c.begin(); // keep one going for the next clip
  const blob = await new Promise((resolve) => {
    r.rec.onstop = () => resolve(new Blob(r.chunks, { type: c.type.split(';')[0] }));
    r.rec.requestData?.();
    r.rec.stop();
  });
  openClip(blob, t.id, Math.round((now - r.started) / 1000));
}
function openClip(blob, sharerId, seconds) {
  const s = fireServer();
  const rooms = s
    ? (isDm(s) ? s.channels : s.channels.filter((c) => c.kind === 'text' && !c.archived && c.canPost !== false))
    : [];
  const pick = rooms.find((c) => c.id === state.channelId) ?? rooms.find((c) => c.id === s?.liveChannelId) ?? rooms[0];
  const url = URL.createObjectURL(blob);
  const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
  const name = `${nameOf(sharerId)}-clip-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.${ext}`;
  const tooBig = blob.size > clipLimit();
  modal(`<h2>Your clip</h2>
    <video class="clip-preview" src="${url}" controls playsinline></video>
    <p class="muted small">The last ${seconds} seconds of ${escapeHtml(nameOf(sharerId))}'s stream, ${formatSize(blob.size)}.${tooBig ? ' That is more than you can share here, so you can only save it.' : ''}</p>
    ${rooms.length && !tooBig ? `<label>Post it in<select id="clip-room">${rooms.map((c) => `<option value="${c.id}" ${c === pick ? 'selected' : ''}>${isDm(s) ? escapeHtml(fireName(c)) : '#' + escapeHtml(c.name)}</option>`).join('')}</select></label>
    <label>Say something (optional)<input id="clip-text" maxlength="500" placeholder="Look at this!" /></label>` : ''}
    <div class="error" id="modal-error"></div>
    <div class="modal-row"><button class="btn secondary" id="clip-stop">Stop clipping</button><a class="btn secondary" id="clip-save" href="${url}" download="${escapeHtml(name)}">Download</a>${rooms.length && !tooBig ? '<button class="btn" id="clip-post">Post</button>' : ''}</div>`);
  const closing = onModalClose;
  onModalClose = () => { closing?.(); setTimeout(() => URL.revokeObjectURL(url), 60_000); };
  $('#clip-stop').onclick = () => { stopClips(`${sharerId}:screen`); closeModal(); };
  $('#clip-post')?.addEventListener('click', async (e) => {
    const b = e.currentTarget;
    const channelId = Number($('#clip-room').value);
    b.disabled = true;
    b.textContent = 'Posting…';
    try {
      const attachment = await uploadFile(channelId, { file: new File([blob], name, { type: blob.type }), progress: 0 });
      await api(`/api/channels/${channelId}/messages`, { method: 'POST', body: { content: $('#clip-text').value.trim(), attachmentIds: [attachment.id] } });
      closeModal();
      toast('Clip posted.');
    } catch (err) {
      b.disabled = false;
      b.textContent = 'Post';
      $('#modal-error').textContent = err.message;
    }
  });
}

// ---- going live: a post in the burrow's go-live room while you share your screen

function renderLiveCard(m) {
  const card = document.createElement('div');
  const live = m.live;
  card.className = 'live-card' + (live.endedAt ? ' over' : '');
  const where = roomById(live.voiceChannelId)?.c;
  const place = where ? where.name : 'a fire';
  const minutes = live.endedAt ? Math.max(1, Math.round((live.endedAt - m.createdAt) / 60000)) : 0;
  card.innerHTML = `<span class="live-badge">${live.endedAt ? 'ENDED' : 'LIVE'}</span><span class="live-text"></span>`;
  card.querySelector('.live-text').textContent = live.endedAt
    ? `${authorName(m)} was live at ${place} for ${minutes} minute${minutes === 1 ? '' : 's'}`
    : `${authorName(m)} is sharing their screen at ${place}`;
  if (!live.endedAt && where && m.authorId !== state.me.id) {
    const here = state.voice?.channelId === where.id;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn';
    b.textContent = here ? 'Watch' : 'Join and watch';
    b.onclick = () => {
      if (here) return goToVoice(), openVideo(`${m.authorId}:screen`);
      state.watchOnJoin = m.authorId;
      joinVoice(where.id);
    };
    card.append(b);
  }
  return card;
}

// ---- sharing a browser tab from the web app, with its sound

function chooseShare() {
  const lp = state.voice?.room?.localParticipant;
  if (!lp) return;
  if (lp.isScreenShareEnabled || window.burrowDesktop) return toggleScreen();
  modal(`<h2>Share</h2>
    <div class="share-choices">
      <button class="share-choice" id="share-tab">${TAB_ICON}<b>A browser tab</b><span>With its sound. Pick the tab, and leave "Also share tab audio" on.</span></button>
      <button class="share-choice" id="share-screen">${SCREEN_ICON}<b>Your screen or a window</b><span>Games and programs. Their sound is shared on Windows in Chrome or Edge, when you tick "Also share system audio".</span></button>
    </div>
    <label>Quality<select id="share-mode">
      <option value="smooth" ${shareMode === 'smooth' ? 'selected' : ''}>Smooth (games and video, 60 fps)</option>
      <option value="sharp" ${shareMode === 'sharp' ? 'selected' : ''}>Sharp (text and code)</option></select></label>
    <div class="modal-row"><button class="btn secondary" data-close>Cancel</button></div>`);
  const go = (surface) => {
    shareMode = $('#share-mode').value;
    store.set('shareMode', shareMode);
    closeModal();
    toggleScreen(surface);
  };
  $('#share-tab').onclick = () => go('browser');
  $('#share-screen').onclick = () => go('monitor');
}

// ---------------------------------------------------------------- the Campfire
//
// Everyone in the voice room sits in a circle around the fire: who's talking, muted or
// deafened, their camera if it's on, and a way to watch anyone sharing their screen.
// Next to it is the fireside chat, which only the people at the fire see.

const seats = new Map(); // user id -> { el, face, track }

function clearSeats() {
  for (const seat of seats.values()) if (seat.track && seat.face) seat.track.detach(seat.face);
  seats.clear();
  $('#fire-ring').querySelectorAll('.seat').forEach((el) => el.remove());
}

function renderFire(status) {
  const voice = state.voice;
  if (!voice || !state.stageOpen || state.stageShow !== 'fire') return clearSeats();
  const LK = window.LivekitClient;
  const room = voice.room;
  const ch = [...state.servers.values()].flatMap((s) => s.channels).find((c) => c.id === voice.channelId);
  const ids = [...(ch?.voiceUsers ?? [])];
  if (!ids.includes(state.me.id)) ids.push(state.me.id);
  const s = [...state.servers.values()].find((x) => x.channels.includes(ch));
  $('#stage-title').textContent = ch && s && !isDm(s) ? `${s.name}'s ${ch.name}` : ch ? fireName(ch) : 'Campfire';
  const streamer = ids.find((id) => id !== state.me.id && state.sharing.get(id)?.screen);
  $('#fire-count').textContent = (typeof status === 'string' ? status : !room ? 'Connecting…' : `${ids.length} gathered`)
    + (streamer ? ` · ${nameOf(streamer)} is sharing` : '');

  // Seats are spread evenly around the fire, starting at the top. A small fire keeps a few open
  // seats; one with a seat limit shows all of its seats (up to a dozen).
  const total = Math.max(ch?.userLimit && ch.userLimit <= 12 ? ch.userLimit : 5, ids.length);
  const ring = $('#fire-ring');
  ring.classList.toggle('crowded', total > 8);
  // How far from the fire the seats are, as a share of the circle's width and height (narrower on phones).
  const css = getComputedStyle(ring);
  const rx = Number(css.getPropertyValue('--rx')) || 41, ry = Number(css.getPropertyValue('--ry')) || 40;
  const place = (el, i) => {
    const a = (-90 + (i * 360) / total) * (Math.PI / 180);
    el.style.left = `${50 + rx * Math.cos(a)}%`;
    el.style.top = `${50 + ry * Math.sin(a)}%`;
  };

  for (const [id, seat] of seats) {
    if (ids.includes(id)) continue;
    if (seat.track && seat.face) seat.track.detach(seat.face);
    seat.el.remove();
    seats.delete(id);
  }
  ids.forEach((id, i) => {
    const me = id === state.me.id;
    const name = nameOf(id, me ? state.me.displayName || state.me.username : '?');
    let seat = seats.get(id);
    if (!seat) {
      const el = document.createElement('div');
      el.innerHTML = '<span class="seat-face-wrap"></span><span class="seat-name"></span><span class="seat-status"></span>';
      seat = { el, face: null, track: null };
      seats.set(id, seat);
      ring.append(el);
    }
    place(seat.el, i);
    const participant = !room ? null : me ? room.localParticipant : room.remoteParticipants.get(String(id));
    const camPub = participant && LK ? participant.getTrackPublication(LK.Track.Source.Camera) : null;
    const camTrack = camPub && !camPub.isMuted ? camPub.track ?? null : null;
    const sharing = state.sharing.get(id);
    const deafened = ch?.voiceDeafened?.includes(id);
    const modMuted = ch?.voiceServerMuted?.includes(id);
    const muted = modMuted || state.mutedInVoice.has(id) || ch?.voiceMuted?.includes(id);
    const speaking = state.speaking.has(id) && !muted;

    // The face: their camera if it's on, else their picture. Clicking someone else changes how loud they are.
    if (seat.track !== camTrack || !seat.face) {
      if (seat.track && seat.face) seat.track.detach(seat.face);
      const wrap = seat.el.querySelector('.seat-face-wrap');
      wrap.replaceChildren();
      const button = document.createElement(me && !camTrack ? 'span' : 'button');
      button.className = 'seat-face';
      if (camTrack) {
        const video = camTrack.attach();
        video.muted = true;
        button.append(video);
        button.classList.add('video');
        button.onclick = (e) => { e.stopPropagation(); openVideo(`${id}:camera`); };
        button.title = me ? 'See your camera bigger' : `See ${name}'s camera bigger`;
      } else {
        const av = document.createElement('span');
        av.className = 'avatar';
        setAvatar(av, name, avatarOf(id));
        button.append(av);
        if (!me) {
          button.onclick = (e) => { e.stopPropagation(); openVolume(button, id, name, fireServer(), roomById(state.voice?.channelId)?.c); };
          button.title = `${name}'s volume`;
        }
      }
      wrap.append(button);
      seat.face = camTrack ? button.firstChild : null;
      seat.track = camTrack;
      if (!camTrack) seat.face = button;
    }
    const wrap = seat.el.querySelector('.seat-face-wrap');
    wrap.querySelector('.seat-live')?.remove();
    if (sharing?.screen) wrap.insertAdjacentHTML('beforeend', '<span class="seat-live">LIVE</span>');
    seat.el.className = 'seat' + (me ? ' me' : '') + (speaking ? ' speaking' : '') + (camTrack ? ' has-video' : '');
    seat.el.querySelector('.seat-name').textContent = me ? `${name} (you)` : name;
    const v = me ? 1 : volumeFor(id);
    const statusText = modMuted ? 'Muted by a moderator' : deafened ? 'Deafened' : muted ? 'Muted' : speaking ? 'Talking' : camTrack ? 'Camera on' : v !== 1 ? `${Math.round(v * 100)}% volume` : '';
    const statusEl = seat.el.querySelector('.seat-status');
    statusEl.textContent = statusText;
    statusEl.className = 'seat-status' + (speaking ? ' talking' : '');
    let watch = seat.el.querySelector('.seat-watch');
    if (sharing?.screen && !watch) {
      watch = document.createElement('button');
      watch.className = 'seat-watch';
      watch.innerHTML = `${SCREEN_ICON}<span></span>`;
      watch.onclick = (e) => { e.stopPropagation(); openVideo(`${id}:screen`); };
      attachPeek(watch, id);
      seat.el.append(watch);
    } else if (!sharing?.screen && watch) watch.remove();
    const watchers = sharing?.screen ? viewersOf(id).length : 0;
    if (watch) watch.lastChild.textContent = (me ? 'Your screen' : 'Watch screen') + (watchers ? ` · ${watchers} watching` : '');
  });

  // Open seats fill the rest of a small circle.
  ring.querySelectorAll('.seat.open').forEach((el) => el.remove());
  for (let i = ids.length; i < total; i++) {
    const el = document.createElement('div');
    el.className = 'seat open';
    el.innerHTML = '<span class="seat-face"></span><span class="seat-status">Open seat</span>';
    place(el, i);
    ring.append(el);
  }
}

// The fireside chat is in view: docked beside the fire on a wide screen, or opened over it.
const fireChatDocked = () => matchMedia('(min-width: 1100px)').matches;
let firesideHidden = store.get('firesideHidden') === '1';
const firesideVisible = () => !document.hidden && (($('#fire-chat').classList.contains('overlay') && state.stageOpen && state.stageShow === 'video')
  || (state.stageOpen && state.stageShow === 'fire' && (fireChatDocked() ? !firesideHidden : state.firesideOpen)));

function renderFireside({ added } = {}) {
  const space = $('#stage .fire-space');
  space.classList.toggle('chat-hidden', firesideHidden);
  space.classList.toggle('chat-open', state.firesideOpen);
  if (firesideVisible()) state.fireside.unread = 0;
  const { messages, unread } = state.fireside;
  for (const id of ['#fire-chat-badge', '#fire-chat-bar-badge']) {
    $(id).textContent = unread > 9 ? '9+' : unread;
    $(id).classList.toggle('hidden', !unread);
  }
  $('#campfire-chip').classList.toggle('unread', unread > 0);
  const last = messages.at(-1);
  $('#fire-chat-last').textContent = last ? `${last.author}: ${last.content}` : 'Only people at the fire see it';

  const list = $('#fire-chat-list');
  const stick = list.scrollHeight - list.scrollTop - list.clientHeight < 60 || added?.userId === state.me?.id;
  const line = (m, prev) => {
    const el = document.createElement('div');
    el.className = 'fire-msg' + (m.userId === state.me?.id ? ' mine' : '');
    // Messages from the same person close together share one name.
    if (!prev || prev.userId !== m.userId || m.createdAt - prev.createdAt > 5 * 60_000) {
      const who = document.createElement('b');
      who.textContent = nameOf(m.userId, m.author);
      const srv = fireServer();
      const color = srv && roleColor(srv, m.userId);
      if (color) who.style.color = color;
      el.append(who);
    } else el.classList.add('more');
    const text = document.createElement('div');
    text.textContent = m.content;
    el.append(text);
    el.title = new Date(m.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return el;
  };
  if (added && list.querySelectorAll('.fire-msg').length === messages.length - 1) {
    list.append(line(added, messages.at(-2)));
  } else {
    list.replaceChildren(list.firstElementChild, ...messages.map((m, i) => line(m, messages[i - 1])));
  }
  if (stick) list.scrollTop = list.scrollHeight;
}

/** The burrow whose fire you're at. */
const fireServer = () => [...state.servers.values()].find((s) => s.channels.some((c) => c.id === state.voice?.channelId));

$('#fire-chat-form').onsubmit = (e) => {
  e.preventDefault();
  const content = $('#fire-chat-input').value.trim();
  if (!content || state.ws?.readyState !== WebSocket.OPEN || !state.voice) return;
  state.ws.send(JSON.stringify({ type: 'fireside_send', content }));
  $('#fire-chat-input').value = '';
};
const showFireside = (show) => {
  if (fireChatDocked()) {
    firesideHidden = !show;
    store.set('firesideHidden', show ? null : '1');
  } else state.firesideOpen = show;
  renderFireside();
  if (show) $('#fire-chat-input').focus();
};
$('#fire-chat-open').onclick = () => showFireside(true);
$('#fire-chat-bar').onclick = () => showFireside(true);
$('#fire-chat-close').onclick = () => ($('#fire-chat').classList.contains('overlay') ? restoreStreamChat() : showFireside(false));
document.addEventListener('visibilitychange', () => { if (state.voice) renderFireside(); });

// How loud someone's shared screen is, for you only: 0% (muted) to 200%. Kept on this device.
// Streams start muted until you turn them up; whatever you pick for someone is remembered.
const streamVolumes = (() => { try { return JSON.parse(store.get('streamVolumes')) ?? {}; } catch { return {}; } })();
const streamVolumeFor = (userId) => streamVolumes[userId] ?? 0;

function setStreamVolume(userId, value) {
  if (value === 0) delete streamVolumes[userId];
  else streamVolumes[userId] = value;
  store.set('streamVolumes', JSON.stringify(streamVolumes));
  const p = state.voice?.room?.remoteParticipants.get(String(userId));
  if (p) applyVolume(p, window.LivekitClient.Track.Source.ScreenShareAudio, value);
}

/**
 * Sets how loud one of someone's sounds is. LiveKit forgets a volume of 0 whenever it rebuilds its
 * audio, so silence means not receiving that sound at all, which also saves the download.
 */
function applyVolume(participant, source, value) {
  value = heard(value);
  const pub = participant.getTrackPublication(source);
  if (value === 0) return pub?.setSubscribed(false);
  if (pub && !pub.isSubscribed) pub.setSubscribed(true); // the volume is set again when it arrives
  participant.setVolume(value, source);
}

/** How loud a sound plays: your setting for that person, times everyone's volume. Nothing while deafened. */
const heard = (value) => (state.voice?.deafened ? 0 : value * voicePrefs.outputVolume);

function applyAllVolumes() {
  const LK = window.LivekitClient;
  for (const p of state.voice?.room?.remoteParticipants.values() ?? []) {
    const id = Number(p.identity);
    applyVolume(p, LK.Track.Source.Microphone, volumeFor(id));
    applyVolume(p, LK.Track.Source.ScreenShareAudio, streamVolumeFor(id));
  }
}

const SPEAKER_ON = '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4V9Zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4Zm-2.5-8.8v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6Z"/></svg>';
const SPEAKER_OFF = '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4V9Zm12.6 3 2.7-2.7-1.4-1.4-2.7 2.7-2.7-2.7-1.4 1.4 2.7 2.7-2.7 2.7 1.4 1.4 2.7-2.7 2.7 2.7 1.4-1.4-2.7-2.7Z"/></svg>';

/** The mute button and slider on a shared screen that has sound. */
function streamAudioControl(userId, tile) {
  const box = document.createElement('div');
  box.className = 'stream-audio';
  box.innerHTML = '<button type="button"></button><input type="range" min="0" max="200" step="5" aria-label="Stream volume" /><span></span>';
  const [button, slider, readout] = box.children;
  let before = 1; // what unmuting goes back to
  const show = () => {
    const v = streamVolumeFor(userId);
    slider.value = Math.round(v * 100);
    readout.textContent = `${Math.round(v * 100)}%`;
    button.innerHTML = v === 0 ? SPEAKER_OFF : SPEAKER_ON;
    button.title = v === 0 ? 'Unmute the stream' : 'Mute the stream';
    box.classList.toggle('muted', v === 0);
  };
  box.onclick = (e) => e.stopPropagation(); // don't enlarge or shrink the tile
  box.ondblclick = (e) => e.stopPropagation();
  button.onclick = () => {
    const v = streamVolumeFor(userId);
    if (v > 0) before = v;
    setStreamVolume(userId, v > 0 ? 0 : before || 1);
    show();
  };
  slider.oninput = () => { setStreamVolume(userId, Number(slider.value) / 100); show(); };
  show();
  tile.append(box);
  return box;
}

// The desktop app can't show the browser's screen picker, so it asks us to show one.
window.burrowDesktop?.onPickScreen((sources) => {
  let picked = false;
  modal(`<h2>Share your screen</h2>
    <p class="muted small">Pick a whole screen or one window.${window.burrowDesktop.appAudio ? ' A window shares only its own sound.' : ''}</p>
    <div class="kind-choice">
      <label title="60 frames a second. Best for games and video."><input type="radio" name="share-mode" value="smooth" ${shareMode === 'smooth' ? 'checked' : ''} /> Smooth motion</label>
      <label title="Keeps text crisp. Best for documents and code."><input type="radio" name="share-mode" value="sharp" ${shareMode === 'sharp' ? 'checked' : ''} /> Sharp text</label>
    </div>
    <div class="screen-picker"></div>
    <div class="modal-row"><button class="btn secondary" data-close>Cancel</button></div>`);
  // Remembered for next time too.
  for (const r of document.querySelectorAll('#modal-card [name="share-mode"]')) r.onchange = () => { shareMode = r.value; store.set('shareMode', r.value); };
  const grid = $('#modal-card .screen-picker');
  for (const src of sources) {
    const b = document.createElement('button');
    b.type = 'button';
    const img = document.createElement('img');
    img.src = src.thumbnail;
    img.alt = '';
    const label = document.createElement('span');
    label.textContent = src.name;
    b.append(img, label);
    b.onclick = () => { picked = true; window.burrowDesktop.pickedScreen(src.id); closeModal(); };
    grid.append(b);
  }
  onModalClose = () => { if (!picked) window.burrowDesktop.pickedScreen(null); };
});

// ---------------------------------------------------------------- end-to-end encrypted voice
//
// Audio is encrypted on your device and only decrypted by the others in the room, so the
// voice server (and anyone who gets into it) only ever handles scrambled audio.
//
// Each person makes a fresh key pair when they join and announces the public half. Whoever has
// been in the room longest makes the room key and sends it to each person, sealed with a key only
// the two of them can work out (ECDH P-256, then AES-GCM). They make a new room key whenever
// someone joins or leaves, so newcomers can't decode what came before and leavers can't decode
// what comes after. The server passes these messages along but can't open them.
//
// The key keeper only hands keys to people still in the burrow, so someone who's removed can't
// decode anything new even if they stay connected to the voice server.

const E2EE_TOPIC = 'burrow-e2ee';
const KEYRING_SIZE = 16; // LiveKit keeps this many room keys, so audio sealed with the last one still plays
const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

// Started from a Blob, since browsers won't start workers from local files (the desktop app).
let workerSourceLoading = null;
async function e2eeWorker() {
  workerSourceLoading ??= new Promise((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = 'vendor/livekit-client.e2ee.worker.source.js';
    tag.onload = () => resolve(URL.createObjectURL(new Blob([window.LivekitE2EEWorkerSource], { type: 'text/javascript' })));
    tag.onerror = () => { workerSourceLoading = null; reject(new Error("Couldn't load voice encryption.")); };
    document.head.append(tag);
  });
  return new Worker(await workerSourceLoading);
}

async function createVoiceCrypto(LK) {
  class RoomKeys extends LK.BaseKeyProvider {
    constructor() { super({ sharedKey: true, ratchetWindowSize: 0, failureTolerance: -1, keyringSize: KEYRING_SIZE }); }
    async use(raw, index) { this.onSetEncryptionKey(await LK.createKeyMaterialFromBuffer(raw), undefined, index); }
  }
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']);
  return {
    pair,
    pub: toB64(await crypto.subtle.exportKey('raw', pair.publicKey)),
    pubs: new Map(), // identity -> their public key, for everyone else in the room
    keys: new RoomKeys(),
    worker: await e2eeWorker(),
    index: -1, // which room key we're on; -1 until we have one
  };
}

/** The AES key only we and the owner of `theirPub` can work out. */
async function pairKey(vc, theirPub) {
  const theirs = await crypto.subtle.importKey('raw', fromB64(theirPub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  return crypto.subtle.deriveKey({ name: 'ECDH', public: theirs }, vc.pair.privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function sendCrypto(voice, message, to) {
  // Say who it's from: a newcomer's first message can arrive before LiveKit has told the others about them.
  const data = new TextEncoder().encode(JSON.stringify({ ...message, from: voice.room.localParticipant.identity }));
  voice.room.localParticipant.publishData(data, { reliable: true, topic: E2EE_TOPIC, ...(to ? { destinationIdentities: [to] } : {}) }).catch(() => {});
}

/**
 * The person who hands out room keys: whoever joined first, out of the people taking part in the
 * key exchange. Someone on an app from before encryption never answers, so they can't be keeper.
 */
function isKeyKeeper(voice) {
  const room = voice.room;
  const joined = (identity) => (identity === room.localParticipant.identity ? room.localParticipant : room.remoteParticipants.get(identity))?.joinedAt?.getTime() ?? Infinity;
  const keeper = [room.localParticipant.identity, ...voice.crypto.pubs.keys()]
    .sort((a, b) => joined(a) - joined(b) || Number(a) - Number(b))[0];
  return keeper === room.localParticipant.identity;
}

function startKeyExchange(voice) {
  const vc = voice.crypto;
  if (!voice.room.remoteParticipants.size) return keysChanged(voice);
  sendCrypto(voice, { t: 'hello', pub: vc.pub });
  // If nobody hands us a key (everyone here is on an old app, or the keeper just left), we
  // become the keeper. Until then keep asking, in case a message went missing.
  vc.grace = setTimeout(() => { if (vc.index < 0) keysChanged(voice); }, 1500);
  const retry = () => {
    if (state.voice !== voice || vc.index >= 0) return;
    sendCrypto(voice, { t: 'hello', pub: vc.pub });
    vc.retry = setTimeout(retry, 1500);
  };
  vc.retry = setTimeout(retry, 1500);
}

const voiceServer = () => [...state.servers.values()].find((s) => s.channels.some((c) => c.id === state.voice?.channelId));

/** Someone came or went: if we're the key keeper, make a new room key and hand it out. */
function keysChanged(voice) {
  const vc = voice.crypto;
  renderVoiceBar();
  if (!voice.room || !isKeyKeeper(voice)) return;
  clearTimeout(vc.rotateTimer);
  // A short wait gathers people joining at the same time into one new key.
  vc.rotateTimer = setTimeout(async () => {
    if (state.voice !== voice) return;
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const index = (vc.index + 1) % KEYRING_SIZE;
    const members = new Set(voiceServer()?.members.map((m) => String(m.id)) ?? []);
    for (const [identity, pub] of vc.pubs) {
      if (!members.has(identity)) continue; // removed from the burrow: no more keys, even if still connected
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const sealed = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`${index}:${identity}`) },
        await pairKey(vc, pub),
        raw,
      );
      sendCrypto(voice, { t: 'key', index, iv: toB64(iv), key: toB64(sealed), pub: vc.pub }, identity);
    }
    await vc.keys.use(raw.buffer, index);
    rememberRoomKey(vc, index, raw.buffer);
    vc.index = index;
    renderVoiceBar();
    roomKeyReady(voice);
  }, 250);
}

async function onCryptoMessage(voice, payload, participant, topic) {
  const vc = voice.crypto;
  if (topic !== E2EE_TOPIC || state.voice !== voice) return;
  let msg;
  try { msg = JSON.parse(new TextDecoder().decode(payload)); } catch { return; }
  const from = participant?.identity ?? msg.from;
  if (typeof from !== 'string' || from === voice.room.localParticipant.identity) return;
  if ((msg.t === 'hello' || msg.t === 'pub') && typeof msg.pub === 'string') {
    vc.pubs.set(from, msg.pub);
    if (msg.t === 'hello') sendCrypto(voice, { t: 'pub', pub: vc.pub }, from);
    keysChanged(voice);
  } else if (msg.t === 'key') {
    try {
      if (!vc.pubs.has(from)) vc.pubs.set(from, msg.pub);
      const raw = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromB64(msg.iv), additionalData: new TextEncoder().encode(`${msg.index}:${voice.room.localParticipant.identity}`) },
        await pairKey(vc, vc.pubs.get(from)),
        fromB64(msg.key),
      );
      await vc.keys.use(raw, Number(msg.index) % KEYRING_SIZE);
      rememberRoomKey(vc, Number(msg.index) % KEYRING_SIZE, raw);
      vc.index = Number(msg.index) % KEYRING_SIZE;
      roomKeyReady(voice);
      clearTimeout(vc.retry);
      clearTimeout(vc.grace);
      renderVoiceBar();
    } catch (err) {
      console.warn("Couldn't open a voice key from", from, err);
    }
  }
}

// ---------------------------------------------------------------- volume and sounds
//
// Each person's voice volume is your own setting, kept on this device: 0% to 200%.

const volumes = (() => { try { return JSON.parse(store.get('volumes')) ?? {}; } catch { return {}; } })();
const volumeFor = (userId) => volumes[userId] ?? 1;

function setVolume(userId, value) {
  if (value === 1) delete volumes[userId];
  else volumes[userId] = value;
  store.set('volumes', JSON.stringify(volumes));
  const p = state.voice?.room?.remoteParticipants.get(String(userId));
  if (p) applyVolume(p, window.LivekitClient.Track.Source.Microphone, value);
}

// With the burrow and the voice room they're in, people who manage voice get their tools too.
function openVolume(anchor, userId, name, s = null, c = null) {
  closeVolume();
  const pop = document.createElement('div');
  pop.className = 'volume-pop';
  pop.id = 'volume-pop';
  const pct = Math.round(volumeFor(userId) * 100);
  pop.innerHTML = `<div class="volume-head"><b>${escapeHtml(name)}</b><span id="volume-value">${pct}%</span></div>
    <input type="range" id="volume-range" min="0" max="200" step="5" value="${pct}" aria-label="${escapeHtml(name)}'s volume" />
    <div class="volume-foot"><span class="small muted">Only changes it for you</span><button class="link-btn" id="volume-reset">Reset</button></div>`;
  pop.onclick = (e) => e.stopPropagation();
  voiceModTools(pop, s, c, userId, name);
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)}px`;
  pop.style.top = `${Math.min(r.bottom + 6, window.innerHeight - pop.offsetHeight - 8)}px`;
  const apply = (value) => {
    $('#volume-range').value = value;
    $('#volume-value').textContent = `${value}%`;
    setVolume(userId, value / 100);
  };
  $('#volume-range').oninput = (e) => apply(Number(e.target.value));
  $('#volume-range').onchange = () => renderChannels();
  $('#volume-reset').onclick = () => { apply(100); renderChannels(); };
  $('#volume-range').focus();
}
function closeVolume() { $('#volume-pop')?.remove(); }
document.addEventListener('click', closeVolume);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeVolume(); });

// Short chimes made on the fly, so there are no sound files to ship.
const soundPrefs = (() => {
  const defaults = { messages: true, voice: true, volume: 0.5 };
  try { return { ...defaults, ...JSON.parse(store.get('sounds')) }; } catch { return defaults; }
})();
const saveSoundPrefs = () => store.set('sounds', JSON.stringify(soundPrefs));
const SOUNDS = {
  // [frequency, start, length] in Hz and seconds
  message: { pref: 'messages', notes: [[987.8, 0, 0.12], [1318.5, 0.07, 0.2]] },
  join: { pref: 'voice', notes: [[523.3, 0, 0.14], [784, 0.09, 0.22]] },
  leave: { pref: 'voice', notes: [[784, 0, 0.14], [523.3, 0.09, 0.22]] },
  ring: { pref: 'voice', notes: [[659.3, 0, 0.25], [830.6, 0.3, 0.25], [659.3, 0.6, 0.25], [830.6, 0.9, 0.35]] },
};
let soundCtx = null;
let lastMessageSound = 0;

function playSound(name, force = false) {
  const sound = SOUNDS[name];
  if (!force && (!soundPrefs[sound.pref] || !soundPrefs.volume)) return;
  // A busy room shouldn't turn into a wind chime.
  if (name === 'message' && !force) {
    if (Date.now() - lastMessageSound < 1500) return;
    lastMessageSound = Date.now();
  }
  try {
    if (!soundCtx) {
      soundCtx = new AudioContext();
      setChimeOutput();
    }
    if (soundCtx.state === 'suspended') soundCtx.resume();
    const t0 = soundCtx.currentTime + 0.01;
    for (const [freq, start, length] of sound.notes) {
      const osc = soundCtx.createOscillator();
      const gain = soundCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + start);
      gain.gain.exponentialRampToValueAtTime(0.25 * soundPrefs.volume, t0 + start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + length);
      osc.connect(gain).connect(soundCtx.destination);
      osc.start(t0 + start);
      osc.stop(t0 + start + length + 0.02);
    }
  } catch {}
}

/** Someone else came into or left the voice room you're in. */
function voiceSounds(channelId, userIds) {
  const before = [...state.servers.values()].flatMap((s) => s.channels).find((c) => c.id === channelId)?.voiceUsers ?? [];
  const others = (ids) => ids.filter((id) => id !== state.me.id);
  if (others(userIds).some((id) => !before.includes(id))) playSound('join');
  else if (others(before).some((id) => !userIds.includes(id))) playSound('leave');
}
