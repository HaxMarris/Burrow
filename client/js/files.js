// GIFs, files and pictures: uploading, video thumbnails and shrinking, showing them.
// Part of Burrow's client: plain scripts that index.html loads in order, sharing one global scope.
'use strict';

// ---------------------------------------------------------------- GIFs

// The GIF picker opens above the message box: trending GIFs first, then whatever you search for.
// Searches and previews go through the Burrow server, which keeps the KLIPY key and your address to itself.
// Picking one sends it straight away (as a reply, if you're replying), and leaves what you typed alone.
const gifPicker = $('#gif-picker');
const gifGrid = $('#gif-grid');
const gifSearch = $('#gif-search');
const gif = { query: null, page: 0, hasMore: false, loading: false, seq: 0, timer: 0 };

function toggleGifPicker() {
  if (!gifPicker.classList.contains('hidden')) return closeGifPicker();
  closeMentions();
  gifPicker.classList.remove('hidden');
  $('#gif-btn').setAttribute('aria-expanded', 'true');
  if (gif.query === null) loadGifs('');
  if (!isPhone()) gifSearch.focus();
  document.addEventListener('mousedown', outsideGifPicker);
}
function outsideGifPicker(e) { if (!e.target.closest('#gif-picker, #gif-btn')) closeGifPicker(); }
function closeGifPicker() {
  if (gifPicker.classList.contains('hidden')) return;
  gifPicker.classList.add('hidden');
  $('#gif-btn').setAttribute('aria-expanded', 'false');
  document.removeEventListener('mousedown', outsideGifPicker);
}

async function loadGifs(query, more = false) {
  if (more && (gif.loading || !gif.hasMore)) return;
  const seq = ++gif.seq;
  gif.loading = true;
  if (!more) { gif.query = query; gif.page = 0; gifGrid.replaceChildren(); gifGrid.scrollTop = 0; }
  $('#gif-status').textContent = 'Loading…';
  try {
    const page = gif.page + 1;
    const res = await api(`/api/gifs?${new URLSearchParams({ q: query, page })}`);
    if (seq !== gif.seq) return; // a newer search took over
    gif.page = page;
    gif.hasMore = res.hasMore && res.items.length > 0;
    gifGrid.append(...res.items.map(gifTile));
    $('#gif-status').textContent = gifGrid.children.length ? '' : query ? `No GIFs for "${query}"` : 'No GIFs right now';
  } catch (err) {
    if (seq === gif.seq) $('#gif-status').textContent = err.message;
  } finally {
    if (seq === gif.seq) gif.loading = false;
  }
}

function gifTile(g) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'gif-tile';
  b.title = g.title || 'GIF';
  b.style.aspectRatio = `${g.width} / ${g.height}`;
  const img = document.createElement('img');
  img.src = state.serverUrl + g.preview;
  img.alt = g.title || 'GIF';
  img.loading = 'lazy';
  img.onerror = () => b.remove();
  b.append(img);
  b.onclick = () => sendGif(g);
  return b;
}

async function sendGif(g) {
  const channelId = state.channelId;
  if (!channelId) return;
  const replyTo = state.replyTo;
  closeGifPicker();
  setReply(null);
  try {
    const att = await api(`/api/channels/${channelId}/gifs`, { method: 'POST', body: { id: g.id } });
    const body = { content: '', attachmentIds: [att.id], replyTo: replyTo?.id };
    if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type: 'send', channelId, ...body }));
    else await api(`/api/channels/${channelId}/messages`, { method: 'POST', body });
  } catch (err) {
    if (replyTo && !state.replyTo) setReply(replyTo);
    alertError(err);
  }
  if (!isPhone()) input.focus();
}

$('#gif-btn').onclick = toggleGifPicker;
gifSearch.addEventListener('input', () => {
  clearTimeout(gif.timer);
  gif.timer = setTimeout(() => loadGifs(gifSearch.value.trim()), 350);
});
gifSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); clearTimeout(gif.timer); loadGifs(gifSearch.value.trim()); }
});
gifGrid.addEventListener('scroll', () => {
  if (gifGrid.scrollTop + gifGrid.clientHeight > gifGrid.scrollHeight - 300) loadGifs(gif.query, true);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeGifPicker(); });

// ---------------------------------------------------------------- attachments

const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp|avif)$/;

/** The largest file you can share in the open room: the burrow can set its own, and roles can change it. */
function uploadLimit(channelId = state.channelId) {
  const s = roomById(channelId)?.s;
  return s && !isDm(s) && s.myUploadLimit != null ? s.myUploadLimit : state.maxUploadBytes;
}

function addFiles(fileList) {
  if (!state.maxUploadBytes || !state.channelId) return;
  const channelId = state.channelId;
  const limit = uploadLimit(channelId);
  if (!limit) return alert("Your roles can't share files in this burrow.");
  for (const file of fileList) {
    if (state.pending.length >= 10) { alert('You can attach up to 10 files at a time.'); break; }
    const shrinkable = SHRINKABLE_TYPES.test(file.type);
    const video = VIDEO_TYPES.test(file.type);
    // Photos are checked after shrinking, since most get well under the limit. Big videos can be shrunk by hand.
    if (file.size > limit && !shrinkable && !(video && canShrinkVideo())) {
      alert(`"${file.name}" is too big. Files can be at most ${formatSize(limit)} here.`);
      continue;
    }
    const p = { file, previewUrl: IMAGE_TYPES.test(file.type) ? URL.createObjectURL(file) : null, progress: 0, error: null };
    if (video) {
      state.pending.push(p);
      queueVideo(p, channelId, limit);
      continue;
    }
    p.done = (shrinkable ? shrinkPhoto(file) : Promise.resolve(file)).then(async (f) => {
      p.file = f;
      p.meta = f.dims ?? (p.previewUrl ? await imageSize(p.previewUrl) : null);
      if (!state.pending.includes(p)) throw new Error('Upload cancelled');
      if (f.size > limit) {
        p.error = `Too big (at most ${formatSize(limit)})`;
        renderPending();
        throw new Error(`"${f.name}" is too big. Files can be at most ${formatSize(limit)} here.`);
      }
      return uploadFile(channelId, p);
    });
    p.done.catch(() => {}); // failures show on the chip
    state.pending.push(p);
  }
  renderPending();
  input.focus();
}

// Photos bigger than this on their long side are scaled down before upload. GIFs are left alone (they may move).
const MAX_PHOTO_SIDE = 2560;
const SHRINKABLE_TYPES = /^image\/(png|jpeg|webp)$/;

// Phone photos are often 4-12 MB; scaled to 2560 px they look the same in chat at a fraction of the size.
// This also drops the photo's hidden details, like where it was taken. Keeps the original if that is smaller.
async function shrinkPhoto(file) {
  let img;
  try { img = await createImageBitmap(file); } catch { return file; }
  const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(img.width, img.height));
  // Its size goes up with it, so the chat can keep its space before it loads.
  file.dims = { width: img.width, height: img.height };
  if (scale === 1 && file.size < 1024 * 1024) return file;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  img.close();
  const encode = (type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  let blob = await encode('image/webp', 0.85);
  // Browsers that can't make WebP: JPEG for photos, PNG for anything that might be see-through.
  if (blob?.type !== 'image/webp') blob = file.type === 'image/jpeg' ? await encode('image/jpeg', 0.85) : await encode('image/png');
  if (!blob || blob.size >= file.size) return file;
  const ext = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' }[blob.type];
  const name = (file.name || 'pasted-image').replace(/\.[^.]*$/, '') + '.' + ext;
  const out = new File([blob], name, { type: blob.type });
  out.dims = { width: canvas.width, height: canvas.height };
  return out;
}

/** A picture's size in pixels, or null if it can't be read. */
function imageSize(url) {
  const img = new Image();
  img.src = url;
  return img.decode().then(() => ({ width: img.naturalWidth, height: img.naturalHeight }), () => null);
}

// ---- videos: a thumbnail to show before it plays, and shrinking huge clips before they go up

/** Gets a video ready and uploads it, with its thumbnail. `shrink` re-encodes it smaller first. */
function queueVideo(p, channelId, limit, { shrink = false } = {}) {
  const run = {};
  p.run = run;
  p.error = null;
  p.progress = 0;
  const current = () => p.run === run && state.pending.includes(p);
  p.done = (async () => {
    if (shrink) {
      p.shrinking = 0;
      renderPending();
      try { p.file = await shrinkVideo(p); } finally { p.shrinking = null; }
      p.shrunk = true;
      p.meta = null;
    }
    if (!p.meta) {
      p.meta = await videoStill(p.file);
      if (p.meta?.thumb && !p.previewUrl) p.previewUrl = URL.createObjectURL(p.meta.thumb);
    }
    if (!current()) throw new Error('Upload cancelled');
    if (p.file.size > limit) {
      p.error = `Too big (at most ${formatSize(limit)})`;
      renderPending();
      throw new Error(`"${p.file.name}" is too big. Files can be at most ${formatSize(limit)} here.`);
    }
    renderPending();
    const att = await uploadFile(channelId, p);
    if (p.meta?.thumb) {
      const res = await fetch(`${state.serverUrl}/api/attachments/${att.id}/thumb`, {
        method: 'POST', headers: { authorization: 'Bearer ' + state.token, 'content-type': p.meta.thumb.type }, body: p.meta.thumb,
      }).catch(() => null);
      if (res?.ok) att.thumb = (await res.json()).thumb; // without one it just loads the first frame
    }
    return att;
  })();
  p.done.catch((err) => { if (p.run === run && err?.message !== 'Upload cancelled' && !p.error) { p.error = err?.message || 'Failed'; renderPending(); } });
  p.limit = limit;
  p.channelId = channelId;
  renderPending();
}

/** Size, length and a small still from part way in, read on this device. Null if this browser can't play it. */
async function videoStill(file) {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  const wait = (event) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), 15000);
    v.addEventListener(event, () => { clearTimeout(timer); resolve(); }, { once: true });
    v.addEventListener('error', () => { clearTimeout(timer); reject(new Error("can't play")); }, { once: true });
  });
  try {
    const loaded = wait('loadeddata');
    v.src = url;
    await loaded;
    const width = v.videoWidth, height = v.videoHeight, duration = v.duration;
    if (!width || !height) return null;
    const seeked = wait('seeked');
    v.currentTime = Math.min(1, (Number.isFinite(duration) ? duration : 0) / 3);
    await seeked;
    const scale = Math.min(1, 640 / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
    const encode = (type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));
    let thumb = await encode('image/webp', 0.75);
    if (thumb?.type !== 'image/webp') thumb = await encode('image/jpeg', 0.8);
    return { width, height, duration, thumb: thumb && thumb.size <= 300 * 1024 ? thumb : null };
  } catch {
    return null;
  } finally {
    v.removeAttribute('src');
    v.load();
    URL.revokeObjectURL(url);
  }
}

// Shrinking plays the video through once (in real time) and records it again at 720p.
const SHRINK_OFFER_BYTES = 20 * 1024 * 1024;
function shrinkType() {
  if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) return null;
  return ['video/mp4;codecs=avc1.42E01F,mp4a.40.2', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus']
    .find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
}
function canShrinkVideo() { return !!shrinkType(); }

async function shrinkVideo(p) {
  const file = p.file;
  const type = shrinkType();
  // Made straight away, while the click still lets it play sound.
  const audio = new AudioContext();
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.playsInline = true;
  v.preload = 'auto';
  let recorder = null, timer = null;
  try {
    const loaded = new Promise((resolve, reject) => { v.onloadedmetadata = resolve; v.onerror = () => reject(new Error("This browser can't play that video, so it can't shrink it")); });
    v.src = url;
    await loaded;
    // 720p: the short side at most 720 pixels, both sides even.
    const scale = Math.min(1, 720 / Math.min(v.videoWidth, v.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(2, Math.round((v.videoWidth * scale) / 2) * 2);
    canvas.height = Math.max(2, Math.round((v.videoHeight * scale) / 2) * 2);
    const ctx = canvas.getContext('2d');
    const stream = canvas.captureStream(30);
    // The sound goes into the recording only, not out of your speakers.
    const sound = audio.createMediaStreamDestination();
    audio.createMediaElementSource(v).connect(sound);
    for (const t of sound.stream.getAudioTracks()) stream.addTrack(t);
    recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 2_500_000, audioBitsPerSecond: 128_000 });
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
    const draw = () => {
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      p.shrinking = Number.isFinite(v.duration) && v.duration ? v.currentTime / v.duration : 0;
    };
    // Drawn on a timer rather than per frame, so it carries on (slower) if you switch tabs.
    timer = setInterval(() => { draw(); renderPendingSoon(); }, 1000 / 30);
    draw();
    recorder.start(1000);
    await audio.resume();
    await new Promise((resolve, reject) => {
      v.onended = resolve;
      v.onerror = () => reject(new Error('The video stopped playing part way'));
      p.cancelShrink = () => reject(new Error('Upload cancelled'));
      v.play().catch(reject);
    });
    clearInterval(timer);
    recorder.stop();
    await stopped;
    const blob = new Blob(chunks, { type: type.split(';')[0] });
    if (!blob.size || blob.size >= file.size) return file;
    const ext = blob.type === 'video/mp4' ? 'mp4' : 'webm';
    return new File([blob], (file.name || 'video').replace(/\.[^.]*$/, '') + '.' + ext, { type: blob.type });
  } finally {
    clearInterval(timer);
    if (recorder?.state === 'recording') recorder.stop();
    p.cancelShrink = null;
    v.pause();
    v.removeAttribute('src');
    v.load();
    URL.revokeObjectURL(url);
    audio.close().catch(() => {});
  }
}

let pendingFrame = 0;
function renderPendingSoon() {
  if (pendingFrame) return;
  pendingFrame = setTimeout(() => { pendingFrame = 0; renderPending(); }, 250);
}

function uploadFile(channelId, p) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    p.xhr = xhr;
    xhr.open('POST', `${state.serverUrl}/api/channels/${channelId}/attachments`);
    xhr.setRequestHeader('authorization', 'Bearer ' + state.token);
    xhr.setRequestHeader('content-type', p.file.type || 'application/octet-stream');
    xhr.setRequestHeader('x-filename', encodeURIComponent(p.file.name || 'pasted-image.png'));
    if (p.voiceSeconds) xhr.setRequestHeader('x-voice-seconds', String(p.voiceSeconds));
    if (p.meta?.width && p.meta?.height) {
      xhr.setRequestHeader('x-width', String(p.meta.width));
      xhr.setRequestHeader('x-height', String(p.meta.height));
    }
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) { p.progress = e.loaded / e.total; renderPending(); } };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status === 200) { p.progress = 1; p.attachment = data; renderPending(); resolve(data); }
      else fail(new Error(data.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => fail(new Error("Couldn't upload " + p.file.name));
    xhr.onabort = () => reject(new Error('Upload cancelled'));
    function fail(err) { p.error = err.message; renderPending(); reject(err); }
    xhr.send(p.file);
  });
}

function renderPending() {
  const tray = $('#pending-files');
  tray.classList.toggle('hidden', !state.pending.length);
  tray.replaceChildren(...state.pending.map((p) => {
    const chip = document.createElement('div');
    chip.className = 'pending' + (p.error ? ' failed' : '');
    chip.title = p.error || p.file.name;
    chip.innerHTML = (p.previewUrl ? `<img src="${p.previewUrl}" alt="" />` : `<span class="file-icon">${FILE_ICON}</span>`)
      + `<span class="pending-name">${escapeHtml(p.file.name || 'image')}</span>`
      + `<span class="pending-meta">${p.shrinking != null ? `Shrinking ${Math.round(p.shrinking * 100)}%` : p.error ? (p.error.startsWith('Too big') ? 'Too big' : 'Failed') : p.progress < 1 ? Math.round(p.progress * 100) + '%' : formatSize(p.file.size)}</span>`
      + `<span class="bar" style="width:${p.error ? 0 : Math.round((p.shrinking ?? p.progress) * 100)}%"></span>`;
    if (p.shrinking != null) chip.title = 'Shrinking plays the video through once, so keep Burrow open until it finishes';
    // A big video can be shrunk to 720p before it goes up.
    if (p.run && !p.shrunk && p.shrinking == null && (p.file.size > SHRINK_OFFER_BYTES || p.file.size > p.limit) && canShrinkVideo()) {
      const sh = document.createElement('button');
      sh.type = 'button';
      sh.className = 'pending-shrink';
      sh.textContent = 'Shrink';
      sh.title = `Make it smaller (720p) before sending. Takes as long as the video. It's ${formatSize(p.file.size)} now.`;
      sh.onclick = () => {
        p.xhr?.abort();
        queueVideo(p, p.channelId, p.limit, { shrink: true });
      };
      chip.append(sh);
    }
    if (!p.error && p.shrinking == null) {
      const sp = document.createElement('button');
      sp.type = 'button';
      sp.className = 'pending-spoiler' + (p.spoiler ? ' on' : '');
      sp.textContent = p.spoiler ? 'Spoiler' : 'Mark spoiler';
      sp.title = p.spoiler ? 'Hidden until someone clicks it. Click to show it normally.' : 'Hide it until someone clicks it';
      sp.onclick = () => { p.spoiler = !p.spoiler; renderPending(); };
      chip.append(sp);
      if (p.spoiler) chip.classList.add('spoilered');
    }
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'pending-remove';
    x.title = 'Remove';
    x.textContent = '×';
    x.onclick = () => {
      p.xhr?.abort();
      p.cancelShrink?.();
      if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
      state.pending = state.pending.filter((q) => q !== p);
      renderPending();
    };
    chip.append(x);
    return chip;
  }));
}

/** Sizes a picture or video to how it will show, before it loads, when its size is known. */
function keepSpace(el, a, maxW, maxH) {
  if (!a.width || !a.height) return;
  const scale = Math.min(1, maxW / a.width, maxH / a.height);
  el.style.width = `${Math.max(1, Math.round(a.width * scale))}px`;
  el.style.aspectRatio = `${a.width} / ${a.height}`;
}

function renderAttachments(list) {
  const wrap = document.createElement('div');
  wrap.className = 'attachments';
  for (const a of list) {
    const url = state.serverUrl + a.url;
    let el;
    if (IMAGE_TYPES.test(a.type)) {
      el = document.createElement('img');
      el.className = 'att-image';
      el.src = url;
      el.alt = a.name;
      // Pictures load as they scroll into view, with their space kept so the chat doesn't jump when they arrive.
      el.loading = 'lazy';
      el.decoding = 'async';
      keepSpace(el, a, 400, 300);
      el.onload = () => { if (state.reachedEnd && messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 400) messagesEl.scrollTop = messagesEl.scrollHeight; };
      el.onclick = () => openImage(a, url);
    } else if (VIDEO_TYPES.test(a.type)) {
      el = document.createElement('video');
      el.className = 'att-video';
      el.src = url;
      el.controls = true;
      // With a thumbnail, nothing of the video downloads until you press play.
      if (a.thumb) el.poster = state.serverUrl + a.thumb;
      el.preload = a.thumb ? 'none' : 'metadata';
      el.playsInline = true;
      keepSpace(el, a, 480, 320);
    } else if (/^audio\//.test(a.type) && a.voiceSeconds != null) {
      el = voicePlayer(a, url);
    } else if (/^audio\//.test(a.type)) {
      el = document.createElement('div');
      el.className = 'att-audio';
      el.innerHTML = `<span class="att-audio-name">${escapeHtml(a.name)}</span>`;
      const au = document.createElement('audio');
      au.src = url;
      au.controls = true;
      au.preload = 'metadata';
      el.append(au);
    } else if (TEXT_TYPES.test(a.type) && a.size <= 512 * 1024) {
      el = textPreview(a, url);
    } else {
      el = document.createElement('a');
      el.className = 'att-file';
      el.href = url;
      el.target = '_blank';
      el.rel = 'noopener';
      el.innerHTML = `<span class="file-icon">${FILE_ICON}</span><span class="att-file-text"><span class="att-file-name">${escapeHtml(a.name)}</span><span class="muted small">${formatSize(a.size)}</span></span>`;
    }
    wrap.append(a.spoiler ? spoilerWrap(el) : el);
  }
  return wrap;
}

function openImage(a, url) {
  modal(`<div class="lightbox"><img src="${escapeHtml(url)}" alt="${escapeHtml(a.name)}" />
    <div class="modal-row"><a class="btn secondary" href="${escapeHtml(url)}" target="_blank" rel="noopener">Open original</a><button class="btn" data-close>Close</button></div></div>`);
  $('#modal-card').classList.add('wide');
}

function formatSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return Math.round(n / 1024) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
  return (n / 1073741824).toFixed(n < 10737418240 ? 1 : 0) + ' GB';
}

const FILE_ICON = '<svg viewBox="0 0 24 24"><path d="M6 2h8l6 6v14H6V2Zm8 1.5V9h5.5L14 3.5Z"/></svg>';

$('#file-input').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
input.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (files.length) { e.preventDefault(); addFiles(files); return; }
  // Long text goes up as a file, so it doesn't take over the room (and isn't cut off at 4000 characters).
  const text = e.clipboardData?.getData('text/plain') ?? '';
  const total = input.value.length - (input.selectionEnd - input.selectionStart) + text.length;
  if (text.length > LONG_PASTE || total > 4000) {
    if (!state.maxUploadBytes) {
      if (total > 4000) { e.preventDefault(); alert('That text is too long for one message (at most 4000 characters).'); }
      return;
    }
    e.preventDefault();
    addFiles([new File([text], 'message.txt', { type: 'text/plain' })]);
    toast('Long text was added as a file, message.txt. Remove it from the tray to paste it as a message instead.', { timeout: 6000 });
  }
});
const chatEl = $('.chat');
let dragDepth = 0;
chatEl.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files') && state.maxUploadBytes) { dragDepth++; chatEl.classList.add('dropping'); } });
chatEl.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; chatEl.classList.remove('dropping'); } });
chatEl.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
chatEl.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  chatEl.classList.remove('dropping');
  if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files);
});
