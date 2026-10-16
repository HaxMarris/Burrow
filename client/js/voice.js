// Voice rooms, the camera and screen sharing.
// Part of Burrow's client: plain scripts that index.html loads in order, sharing one global scope.
'use strict';

// ---------------------------------------------------------------- voice rooms
//
// Audio goes through LiveKit, which runs next to the Burrow server. Burrow hands out
// a token for the room, and tells everyone in the burrow who has joined.

const SPEAKER_ICON = '<svg viewBox="0 0 24 24" class="voice-icon"><path d="M4 9h4l5-4v14l-5-4H4V9Zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4Zm-2.5-8.8v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6Z"/></svg>';
const MUTED_ICON = '<svg viewBox="0 0 24 24" class="muted-icon" aria-label="Muted"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm6-3a6 6 0 0 1-.6 2.6l1.5 1.5A8 8 0 0 0 20 11h-2ZM3.3 2 2 3.3l16.7 16.7 1.3-1.3L3.3 2ZM6 11H4a8 8 0 0 0 7 7.9V22h2v-3.1c.8-.1 1.5-.3 2.2-.6l-1.6-1.6A6 6 0 0 1 6 11Z"/></svg>';

let livekitLoading = null;
function loadLivekit() {
  if (window.LivekitClient) return Promise.resolve(window.LivekitClient);
  livekitLoading ??= new Promise((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = 'vendor/livekit-client.umd.js';
    tag.onload = () => resolve(window.LivekitClient);
    tag.onerror = () => { livekitLoading = null; reject(new Error("Couldn't load the voice library.")); };
    document.head.append(tag);
  });
  return livekitLoading;
}

// muted: start with your mic off (moved to the AFK fire). deafened: keep it on when moved.
async function joinVoice(channelId, { muted = false, deafened = false, rejoin = false } = {}) {
  if (state.voice?.channelId === channelId) return;
  if (!state.voiceEnabled) return alert('Voice is not set up on this server yet.');
  if (!rejoin) cancelRejoin();
  leaveVoice(true);
  const voice = { channelId, room: null, muted: muted || deafened, deafened, mutedBeforeDeafen: muted };
  state.voice = voice;
  state.fireside = { channelId, messages: [], unread: 0 };
  // Made now, while the click still counts, or some browsers start it paused.
  if (wantsMicProcessor()) voice.micCtx = newMicContext();
  voice.talkCtx = new AudioContext({ latencyHint: 'interactive' });
  keepAwake(voice.talkCtx);
  renderVoiceBar(rejoin ? 'Reconnecting…' : 'Connecting…');
  if (!rejoin) goToVoice(); // sit down at the fire
  try {
    const LK = await loadLivekit();
    const { url, token, canSpeak = true } = await api(`/api/channels/${channelId}/voice`, { method: 'POST' });
    if (state.voice !== voice) return;
    if (!LK.isE2EESupported()) throw new Error("this app can't encrypt voice. Update Peiskos or use a current browser.");
    // Muted for everyone by a moderator: your mic stays off until they let you speak.
    voice.serverMuted = !canSpeak;
    // What you'd chosen yourself comes back when they let you speak again.
    if (voice.serverMuted) { voice.mutedBeforeServer = muted; voice.muted = true; }
    if (voice.muted) state.mutedInVoice.add(state.me.id);
    const vc = await createVoiceCrypto(LK);
    // Left (or moved on) while it was starting: its worker would otherwise run on.
    if (state.voice !== voice) return vc.worker.terminate();
    voice.crypto = vc;
    const room = new LK.Room({
      // End-to-end encryption: the voice server only ever handles scrambled audio.
      e2ee: { keyProvider: vc.keys, worker: vc.worker },
      audioCaptureDefaults: { ...micConstraints(), deviceId: await deviceIdFor('audioinput') },
      videoCaptureDefaults: { deviceId: await deviceIdFor('videoinput') },
      ...(canPickOutput ? { audioOutput: { deviceId: await deviceIdFor('audiooutput') } } : {}),
      // Opus at a higher bitrate than LiveKit's 48 kbps default; silence still costs almost nothing (DTX).
      publishDefaults: micPublishOptions(),
      // Mixing through Web Audio lets people be turned up past 100%.
      webAudioMix: true,
      // Only download video someone is looking at, at the size it's shown.
      adaptiveStream: true,
      dynacast: true,
    });
    voice.room = room;
    room
      .on(LK.RoomEvent.TrackSubscribed, (track, pub, participant) => {
        if (track.kind !== 'audio') return renderStage();
        const id = Number(participant.identity);
        const volume = heard(pub.source === LK.Track.Source.ScreenShareAudio ? streamVolumeFor(id) : volumeFor(id));
        if (volume === 0) pub.setSubscribed(false); // muted by you
        else {
          $('#voice-audio').append(track.attach());
          participant.setVolume(volume, pub.source);
        }
        renderStage(); // a shared screen with sound gets a volume control
      })
      .on(LK.RoomEvent.TrackUnsubscribed, (track) => {
        if (track.kind !== 'audio') return renderStage();
        track.detach().forEach((el) => el.remove());
      })
      .on(LK.RoomEvent.TrackPublished, (pub, p) => {
        // A mic sent again (after a moderator lets someone speak) can arrive unmuted without saying so.
        if (pub.source === LK.Track.Source.Microphone) setMuted(p, pub.isMuted);
        renderStage();
      })
      .on(LK.RoomEvent.TrackUnpublished, renderStage)
      .on(LK.RoomEvent.LocalTrackPublished, (pub) => {
        if (pub.source === LK.Track.Source.ScreenShare) {
          state.ws?.send(JSON.stringify({ type: 'voice_live', live: true }));
          startThumbs(voice);
        }
        renderStage();
      })
      .on(LK.RoomEvent.LocalTrackUnpublished, (pub) => {
        if (pub.source === LK.Track.Source.ScreenShare) {
          stopAppAudio(voice);
          stopThumbs(voice);
          if (state.voice === voice) state.ws?.send(JSON.stringify({ type: 'voice_live', live: false }));
          strokes.delete(state.me.id);
          window.burrowDesktop?.drawOverlay?.(null);
          sendRoomData(voice, { t: 'thumb', img: null });
        }
        renderStage();
        renderVoiceBar();
      })
      .on(LK.RoomEvent.ParticipantConnected, (p) => {
        renderStage();
        // Two people sitting down at the same moment each see an empty fire and make their own key,
        // so nobody says hello. Greeting each newcomer makes sure the keeper hears about everyone.
        if (voice.crypto && !voice.crypto.pubs.has(p.identity)) sendCrypto(voice, { t: 'hello', pub: voice.crypto.pub }, p.identity);
      })
      .on(LK.RoomEvent.TrackSubscribed, renderFire)
      .on(LK.RoomEvent.ActiveSpeakersChanged, (speakers) => {
        // The voice server's view, which runs most of a second behind; only used for anyone we
        // can't hear ourselves (see watchTalking).
        voice.serverSpeakers = new Set(speakers.map((p) => Number(p.identity)));
        updateSpeaking(voice);
      })
      .on(LK.RoomEvent.TrackMuted, (pub, p) => (pub.kind === 'audio' && pub.source === LK.Track.Source.Microphone ? setMuted(p, true) : renderStage()))
      .on(LK.RoomEvent.TrackUnmuted, (pub, p) => (pub.kind === 'audio' && pub.source === LK.Track.Source.Microphone ? setMuted(p, false) : renderStage()))
      .on(LK.RoomEvent.Reconnecting, () => renderVoiceBar('Reconnecting…'))
      .on(LK.RoomEvent.Reconnected, () => renderVoiceBar())
      .on(LK.RoomEvent.Disconnected, (reason) => {
        if (state.voice !== voice) return;
        // Left, removed, or the room closed: that's final. Anything else (Wi-Fi dropped, the voice
        // server restarted) and you're put back at the same fire once you can be.
        const R = LK.DisconnectReason ?? {};
        const final = [R.CLIENT_INITIATED, R.DUPLICATE_IDENTITY, R.PARTICIPANT_REMOVED, R.ROOM_DELETED].includes(reason);
        if (final) return leaveVoice();
        const again = { channelId: voice.channelId, muted: voice.deafened ? voice.mutedBeforeDeafen : voice.muted, deafened: voice.deafened };
        leaveVoice(true);
        scheduleRejoin(again);
      })
      .on(LK.RoomEvent.DataReceived, (payload, participant, kind, topic) => (topic === ROOM_TOPIC ? onRoomData(voice, payload, participant) : onCryptoMessage(voice, payload, participant, topic)))
      .on(LK.RoomEvent.ParticipantDisconnected, (p) => {
        vc.pubs.delete(p.identity);
        watchersOf(voice).delete(Number(p.identity));
        thumbsOf(voice).delete(Number(p.identity));
        keysChanged(voice);
        renderStage();
      })
      .on(LK.RoomEvent.EncryptionError, (err) => console.warn('Voice encryption:', err?.message ?? err));
    await room.connect(url || state.serverUrl.replace(/^http/, 'ws'), token);
    if (state.voice !== voice) return room.disconnect();
    await room.setE2EEEnabled(true);
    startKeyExchange(voice);
    await room.startAudio();
    if (!voice.serverMuted) await startMic(voice);
    if (state.voice !== voice) return room.disconnect();
    watchTalking(voice);
    if (voice.deafened) applyAllVolumes();
    state.ws?.send(JSON.stringify({ type: 'voice_join', channelId, ...voiceFlags() }));
    renderVoiceBar();
    renderChannels();
    syncHotkeys();
    if (rejoin) cancelRejoin();
    else playSound('join');
  } catch (err) {
    // Left while connecting: LiveKit calls that cancelling an error, but there's nothing to tell.
    if (state.voice !== voice) { voice.room?.disconnect().catch(() => {}); return; }
    leaveVoice(true);
    // Still offline: keep trying quietly rather than showing an error each time.
    if (rejoin && state.rejoin) return scheduleRejoin(state.rejoin);
    const denied = err?.name === 'NotAllowedError' || /permission/i.test(err?.message ?? '');
    alert(denied ? 'Peiskos needs microphone access for voice. Allow it in your system settings and try again.'
                 : `Couldn't join voice: ${err?.message || err}`);
  }
}

/**
 * Turns your microphone on and sends it, through Burrow's noise filter, voice changer and gate
 * (all before it's encrypted). Started muted, it's set up and then turned straight off.
 */
async function startMic(voice) {
  const lp = voice.room.localParticipant;
  await lp.setMicrophoneEnabled(true, micConstraints(), micPublishOptions());
  if (state.voice !== voice) return;
  if (wantsMicProcessor()) await micTrack()?.setProcessor(micProcessor(voice)).catch((err) => console.warn("Couldn't start the noise filter:", err));
  if (voice.muted) await lp.setMicrophoneEnabled(false);
}

// With the screen off or another app in front, a phone can pause the call's sound (iPhones call it
// an interruption, and do the same for a phone call or Siri). Start it again as soon as it lets us,
// and when Peiskos is back on screen, also bring back a microphone the phone took away.
function wakeVoiceAudio() {
  const voice = state.voice;
  if (!voice?.room) return;
  for (const ctx of [voice.micCtx, voice.talkCtx]) if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') ctx.resume().catch(() => {});
  voice.room.startAudio().catch(() => {});
  if (!document.hidden && micTrack()?.mediaStreamTrack?.readyState === 'ended' && !voice.serverMuted) republishMic();
}
document.addEventListener('visibilitychange', wakeVoiceAudio);
function keepAwake(ctx) {
  ctx.addEventListener('statechange', () => { if (ctx.state === 'interrupted' || ctx.state === 'suspended') wakeVoiceAudio(); });
  return ctx;
}

/** Music mode switched mid-call: your mic is sent again, as stereo or as voice. */
async function republishMic() {
  const voice = state.voice;
  const lp = voice?.room?.localParticipant;
  if (!lp || voice.serverMuted) return;
  const pub = lp.getTrackPublication(window.LivekitClient.Track.Source.Microphone);
  try {
    if (pub?.track) await lp.unpublishTrack(pub.track, true);
    voice.room.options.audioCaptureDefaults = { ...voice.room.options.audioCaptureDefaults, ...micConstraints() };
    voice.room.options.publishDefaults = { ...voice.room.options.publishDefaults, ...micPublishOptions() };
    if (wantsMicProcessor()) voice.micCtx ??= newMicContext();
    await startMic(voice);
  } catch (err) {
    console.warn("Couldn't switch music mode:", err);
  }
}

/**
 * Who's talking, heard right here: everyone's voice (yours as it's sent) is measured every 50 ms,
 * and someone counts as talking from the moment they're loud enough until they've been quiet for
 * a third of a second. The voice server also says who's talking, but only after averaging the last
 * half second or so and sending it back, which made the rings light up late and linger.
 */
const TALK_DB = -45; // how loud (RMS over about 40 ms) counts as talking
const TALK_HOLD = 300; // ms the ring stays lit through a pause
function watchTalking(voice) {
  const ctx = voice.talkCtx;
  if (!ctx) return;
  keepRunning(ctx);
  const meters = new Map(); // user id -> { track, source, analyser, until }
  voice.talkMeters = meters;
  const samples = new Float32Array(2048);
  const micOf = (p) => p.getTrackPublication(window.LivekitClient.Track.Source.Microphone)?.track?.mediaStreamTrack ?? null;
  voice.talkTimer = setInterval(() => {
    const room = voice.room;
    if (state.voice !== voice || !room || ctx.state === 'closed') return clearInterval(voice.talkTimer);
    const now = performance.now();
    const present = new Set();
    for (const p of [room.localParticipant, ...room.remoteParticipants.values()]) {
      const id = Number(p.identity);
      const track = micOf(p);
      let m = meters.get(id);
      if (m && m.track !== track) {
        m.source.disconnect();
        meters.delete(id);
        m = null;
      }
      if (!track || track.readyState === 'ended') continue;
      if (!m) {
        try {
          const source = ctx.createMediaStreamSource(new MediaStream([track]));
          const analyser = ctx.createAnalyser();
          analyser.fftSize = samples.length;
          source.connect(analyser);
          m = { track, source, analyser, until: 0 };
          meters.set(id, m);
        } catch { continue; }
      }
      present.add(id);
      m.analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
      if (track.enabled && 10 * Math.log10(sum / samples.length || 1e-12) > TALK_DB) m.until = now + TALK_HOLD;
    }
    for (const [id, m] of meters) if (!present.has(id)) { m.source.disconnect(); meters.delete(id); }
    updateSpeaking(voice);
  }, 50);
}

/** Puts together who's talking: measured here where we can, the voice server's word otherwise. */
function updateSpeaking(voice) {
  if (state.voice !== voice) return;
  const now = performance.now();
  const heardHere = voice.talkCtx?.state === 'running' ? voice.talkMeters ?? new Map() : new Map();
  const speaking = new Set([...heardHere].filter(([, m]) => m.until > now).map(([id]) => id));
  for (const id of voice.serverSpeakers ?? []) if (!heardHere.has(id)) speaking.add(id);
  if (speaking.size === state.speaking.size && [...speaking].every((id) => state.speaking.has(id))) return;
  state.speaking = speaking;
  // Only the seats around the fire show it; the sidebar stays still while people talk.
  renderFire();
  renderStage();
}

function setMuted(participant, muted) {
  const id = Number(participant.identity);
  if (muted) state.mutedInVoice.add(id);
  else state.mutedInVoice.delete(id);
  renderChannels();
}

// quiet: no leave sound, when switching rooms or when joining failed.
function leaveVoice(quiet) {
  if (quiet !== true) cancelRejoin();
  const voice = state.voice;
  if (!voice) return;
  state.voice = null;
  if (quiet !== true) playSound('leave');
  state.speaking.clear();
  state.mutedInVoice.clear();
  state.sharing.clear();
  state.fireside = { channelId: null, messages: [], unread: 0 };
  state.firesideOpen = false;
  renderFireside();
  stopListen();
  pttHeld = false;
  stopAppAudio(voice);
  stopThumbs(voice);
  strokes.clear();
  drawingOn.clear();
  restoreStreamChat();
  hidePeek();
  window.burrowDesktop?.drawOverlay?.(null);
  voice.room?.disconnect();
  clearTimeout(voice.crypto?.retry);
  clearTimeout(voice.crypto?.grace);
  clearTimeout(voice.crypto?.rotateTimer);
  voice.crypto?.worker.terminate();
  voice.micCtx?.close().catch(() => {});
  clearInterval(voice.talkTimer);
  voice.talkCtx?.close().catch(() => {});
  closeVolume();
  closeStage();
  $('#voice-audio').replaceChildren();
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type: 'voice_leave' }));
  renderVoiceBar();
  renderChannels();
  syncHotkeys();
}

function setMicMuted(voice, muted) {
  if (voice.serverMuted) muted = true; // a moderator's mute wins
  voice.muted = muted;
  voice.room.localParticipant.setMicrophoneEnabled(!muted);
  if (muted) state.mutedInVoice.add(state.me.id);
  else state.mutedInVoice.delete(state.me.id);
}

function toggleMute() {
  const voice = state.voice;
  if (!voice?.room) return;
  if (voice.serverMuted) return toast('A moderator muted you here. They can let you speak again.');
  // Unmuting while deafened turns your sound back on too, like Discord.
  if (voice.deafened && voice.muted) setDeafened(voice, false);
  setMicMuted(voice, !voice.muted);
  voiceChanged();
}

/** Deafened: you hear nobody (voices and streams) and your mic is off, and everyone can see it. */
function toggleDeafen() {
  const voice = state.voice;
  if (!voice?.room) return;
  if (voice.deafened) {
    setDeafened(voice, false);
    setMicMuted(voice, voice.mutedBeforeDeafen);
  } else {
    voice.mutedBeforeDeafen = voice.muted;
    setDeafened(voice, true);
    setMicMuted(voice, true);
  }
  voiceChanged();
}

function setDeafened(voice, deafened) {
  voice.deafened = deafened;
  applyAllVolumes();
  syncListen(); // the video you're listening to goes quiet too
}

/** Muted or deafened changed: tell the burrow, and redraw. */
function voiceChanged() {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type: 'voice_status', ...voiceFlags() }));
  renderVoiceBar();
  renderChannels();
}
const voiceFlags = () => ({ muted: !!state.voice?.muted, deafened: !!state.voice?.deafened });

function renderVoiceBar(status) {
  const voice = state.voice;
  $('#voice-bar').classList.toggle('hidden', !voice && !state.rejoin);
  renderVoicePlaces();
  syncPhoneCall();
  if (!voice) {
    // Between tries at getting back into voice after the connection dropped.
    if (state.rejoin) {
      $('#voice-status').textContent = 'Reconnecting…';
      $('#voice-status').classList.remove('ok', 'talking');
      $('#voice-lock').classList.add('hidden');
      $('#voice-room-name').textContent = fireName(roomById(state.rejoin.channelId)?.c);
    }
    return;
  }
  const ch = [...state.servers.values()].flatMap((s) => s.channels).find((c) => c.id === voice.channelId);
  const sealed = voice.crypto?.index >= 0;
  // With push to talk, the status says how to talk, and when you are.
  const ptt = voicePrefs.mode === 'ptt' && !voice.muted && sealed && !status;
  $('#voice-status').textContent = status ?? (!sealed ? 'Securing voice…' : voice.serverMuted ? 'Muted by a moderator'
    : ptt ? (pttHeld ? 'Talking' : `Hold ${keyLabel(voicePrefs.keys.ptt)} to talk`) : 'Voice connected');
  $('#voice-status').classList.toggle('ok', !status && sealed && !voice.serverMuted);
  $('#voice-status').classList.toggle('talking', ptt && pttHeld);
  $('#voice-lock').classList.toggle('hidden', !!status || !sealed);
  $('#voice-room-name').textContent = fireName(ch);
  $('#voice-mute').classList.toggle('on', voice.muted);
  $('#voice-mute').title = voice.serverMuted ? 'A moderator muted you' : voice.muted ? 'Unmute' : 'Mute';
  $('#voice-deafen').classList.toggle('on', voice.deafened);
  $('#voice-deafen').title = voice.deafened ? 'Undeafen' : 'Deafen (hear nobody, and mute)';
  $('#voice-deafen').innerHTML = voice.deafened ? HEADPHONES_OFF : HEADPHONES_ON;
  const lp = voice.room?.localParticipant;
  const camera = !!lp?.isCameraEnabled, screen = !!lp?.isScreenShareEnabled;
  $('#voice-camera').classList.toggle('on', camera);
  $('#voice-camera').title = camera ? 'Turn off camera' : 'Turn on camera';
  $('#voice-screen').classList.toggle('on', screen);
  $('#voice-screen').title = screen ? 'Stop sharing your screen' : 'Share your screen';
  for (const id of ['#voice-camera', '#voice-screen', '#voice-watch']) $(id).disabled = !voice.room || !!status;
  // The same buttons under the fire.
  for (const name of ['mute', 'deafen', 'camera', 'screen']) {
    const from = $(`#voice-${name}`), to = $(`#fire-${name}`);
    to.innerHTML = from.innerHTML;
    to.title = from.title;
    to.setAttribute('aria-label', from.title);
    to.classList.toggle('on', from.classList.contains('on'));
    to.disabled = from.disabled;
  }
  $('#fire-lock').classList.toggle('hidden', !!status || !sealed);
  // Direct-message calls have no soundboard (sounds belong to a burrow).
  $('#fire-board').parentElement.classList.toggle('hidden', !fireServer() || isDm(fireServer()));
  for (const id of ['#fire-board', '#fire-listen']) $(id).disabled = !voice.room || !!status;
  renderFire(status);
}

const HEADPHONES_ON = '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 0 0-9 9v6a3 3 0 0 0 3 3h2v-8H5v-1a7 7 0 0 1 14 0v1h-3v8h2a3 3 0 0 0 3-3v-6a9 9 0 0 0-9-9Z"/></svg>';
const HEADPHONES_OFF = '<svg viewBox="0 0 24 24"><path d="M3.3 2 2 3.3l3.5 3.5A8.9 8.9 0 0 0 3 12v6a3 3 0 0 0 3 3h2v-8H5v-1c0-1.5.5-2.9 1.3-4l9.4 9.4V21h2c.4 0 .8-.1 1.2-.3l.8.8 1.3-1.3L3.3 2ZM12 3c-2 0-3.8.6-5.3 1.7l1.4 1.4A7 7 0 0 1 19 12v1h-3v.2l5 5V12a9 9 0 0 0-9-9Z"/></svg>';
const DEAFENED_ICON = HEADPHONES_OFF.replace('<svg', '<svg class="muted-icon" aria-label="Deafened"');

$('#voice-mute').onclick = toggleMute;
$('#voice-deafen').onclick = toggleDeafen;
$('#voice-settings').onclick = () => openVoiceSettings(); // these two load in later parts
$('#voice-leave').onclick = () => leaveVoice();
$('#voice-camera').onclick = toggleCamera;
$('#voice-screen').onclick = () => chooseShare();
$('#voice-watch').onclick = () => (state.stageOpen ? closeStage() : goToVoice());
$('#stage-close').onclick = () => closeStage();
$('#fire-back').onclick = () => { closeStage(); showView('rooms'); };
$('#fire-mute').onclick = toggleMute;
$('#fire-deafen').onclick = toggleDeafen;
$('#fire-camera').onclick = toggleCamera;
$('#fire-screen').onclick = () => chooseShare();
$('#fire-settings').onclick = () => openVoiceSettings();
$('#fire-settings').innerHTML = $('#voice-settings').innerHTML;
$('#fire-leave').onclick = () => leaveVoice();
$('#fire-leave').innerHTML = $('#voice-leave').innerHTML;
$('#stage-video').onclick = () => openVideo(null);
$('#video-back').onclick = () => { state.stageShow = 'fire'; focusKey = null; sideBySide = false; renderStage(); };
$('#video-layout').onclick = () => { sideBySide = !sideBySide; focusKey = null; renderStage(); };
// Phones and tablets can't share their screen from a browser.
if (!navigator.mediaDevices?.getDisplayMedia && !window.burrowDesktop) $('#fire-screen').parentElement.classList.add('hidden');

// ---------------------------------------------------------------- camera and screen sharing
//
// Video goes through the same voice room, so it's end-to-end encrypted too. It shows on the
// "stage", which covers the chat while it's open. Only video on the stage is downloaded.

const CAMERA_ICON = '<svg viewBox="0 0 24 24"><path d="M4 6h11a2 2 0 0 1 2 2v1.5l4-2.5v10l-4-2.5V16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z"/></svg>';
const SCREEN_ICON = '<svg viewBox="0 0 24 24"><path d="M3 4h18a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-7v2h3v2H7v-2h3v-2H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm1 2v9h16V6H4Z"/></svg>';
const FULLSCREEN_ICON = '<svg viewBox="0 0 24 24" class="enter"><path d="M4 4h6v2H6v4H4V4Zm10 0h6v6h-2V6h-4V4ZM4 14h2v4h4v2H4v-6Zm14 0h2v6h-6v-2h4v-4Z"/></svg>';
const EXIT_FULLSCREEN_ICON = '<svg viewBox="0 0 24 24" class="exit"><path d="M8 4h2v6H4V8h4V4Zm6 0h2v4h4v2h-6V4ZM4 14h6v6H8v-4H4v-2Zm10 0h6v2h-4v4h-2v-6Z"/></svg>';
const tiles = new Map(); // "identity:camera" or "identity:screen" -> { el, track, video }
let focusKey = null;     // the tile shown big, if any
let sideBySide = false;  // every shared screen shown big, next to each other
let poppedKey = null;    // the tile playing in its own picture-in-picture window

function nameOf(userId, fallback = '?') {
  const here = state.servers.get(state.serverId)?.members.find((m) => m.id === userId);
  if (here) return nameOfPerson(here);
  for (const s of state.servers.values()) {
    const m = s.members.find((m) => m.id === userId);
    if (m) return m.displayName || m.username;
  }
  return fallback;
}

function mediaError(err, what) {
  if (err?.name === 'NotAllowedError') return `Peiskos needs permission to use your ${what}. Allow it in your system settings and try again.`;
  if (err?.name === 'NotFoundError') return `No ${what} found.`;
  if (err?.name === 'NotReadableError') return `Your ${what} is busy. Close other apps using it and try again.`;
  return `Couldn't start your ${what}: ${err?.message || err}`;
}

async function toggleCamera() {
  const lp = state.voice?.room?.localParticipant;
  if (!lp) return;
  try {
    const on = !lp.isCameraEnabled;
    const background = on && cameraBackground() !== 'off';
    if (background) await loadSegmenter().catch(() => {}); // so the first frame sent is already changed
    await lp.setCameraEnabled(on, { resolution: window.LivekitClient.VideoPresets.h720.resolution, ...(background ? { processor: backgroundProcessor() } : {}) });
    if (lp.isCameraEnabled && !state.stageOpen) goToVoice(); // so you can see yourself
  } catch (err) {
    alert(mediaError(err, 'camera'));
  }
  renderVoiceBar();
  renderStage();
}

// How a screen share trades off when the connection or computer can't keep up. Both are 1080p.
// Smooth keeps the frame rate up (games, video) and lets the picture soften; sharp keeps
// text crisp and lets the frame rate drop. Picked in the desktop app's share picker.
const SHARE_MODES = {
  smooth: { encoding: { maxBitrate: 6_000_000, maxFramerate: 60, priority: 'high' }, hint: 'motion', degradation: 'maintain-framerate' },
  sharp: { encoding: { maxBitrate: 5_000_000, maxFramerate: 30, priority: 'high' }, hint: 'detail', degradation: 'maintain-resolution' },
};
let shareMode = SHARE_MODES[store.get('shareMode')] ? store.get('shareMode') : 'smooth';

/** Switches the screen being shared to the current mode. */
async function applyShareMode(lp) {
  const track = lp.getTrackPublication(window.LivekitClient.Track.Source.ScreenShare)?.track;
  if (!track) return;
  const mode = SHARE_MODES[shareMode];
  track.mediaStreamTrack.contentHint = mode.hint;
  await track.setDegradationPreference(mode.degradation);
  const sender = track.sender;
  if (!sender) return;
  const params = sender.getParameters();
  for (const enc of params.encodings ?? []) Object.assign(enc, { maxBitrate: mode.encoding.maxBitrate, maxFramerate: mode.encoding.maxFramerate });
  await sender.setParameters(params);
}

/** Starts or stops sharing. On the web, `surface` says whether a tab or a screen was asked for. */
async function toggleScreen(surface) {
  const voice = state.voice;
  const lp = voice?.room?.localParticipant;
  if (!lp) return;
  const starting = !lp.isScreenShareEnabled;
  // The desktop app on Windows shares only the picked program's sound, and adds it itself.
  const appAudio = window.burrowDesktop?.appAudio;
  // Made right on the click, so it's allowed to play.
  const audioContext = starting && appAudio ? new AudioContext({ sampleRate: 48000 }) : null;
  try {
    if (!starting) stopAppAudio(voice);
    const modeName = shareMode, mode = SHARE_MODES[modeName];
    // Captured at up to 60 fps either way, so the mode can still change in the desktop picker.
    await lp.setScreenShareEnabled(
      starting,
      {
        audio: !appAudio, systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include', contentHint: mode.hint,
        resolution: { width: 1920, height: 1080, frameRate: 60 }, ...(typeof surface === 'string' ? { video: { displaySurface: surface } } : {}),
      },
      // One full-size copy only: a second, smaller one would cost the sharer frames.
      { screenShareEncoding: mode.encoding, degradationPreference: mode.degradation, simulcast: false },
    );
    if (starting && shareMode !== modeName) await applyShareMode(lp).catch((err) => console.warn('Share mode:', err));
    // The browser asks whether to share the sound too; say so if it isn't.
    const LK = window.LivekitClient;
    if (starting && !window.burrowDesktop && lp.isScreenShareEnabled && !lp.getTrackPublication(LK.Track.Source.ScreenShareAudio)) {
      const settings = lp.getTrackPublication(LK.Track.Source.ScreenShare)?.track?.mediaStreamTrack.getSettings() ?? {};
      toast(settings.displaySurface === 'browser'
        ? 'The tab is shared without its sound. To share it, share again and leave "Also share tab audio" on.'
        : 'Your screen is shared without sound. To share sound, share a browser tab instead, or on Windows tick "Also share system audio".', { timeout: 9000 });
    }
    if (starting && audioContext && lp.isScreenShareEnabled) {
      await startAppAudio(voice, audioContext).catch((err) => {
        console.warn('Program audio:', err);
        if (voice.appAudio?.context === audioContext) stopAppAudio(voice);
      });
    }
  } catch (err) {
    // Closing the picker without choosing anything is not an error.
    const cancelled = err?.name === 'NotAllowedError' && !/system/i.test(err.message ?? '');
    if (!cancelled && err?.name !== 'AbortError') alert(mediaError(err, 'screen'));
  } finally {
    if (audioContext && voice.appAudio?.context !== audioContext) audioContext.close().catch(() => {});
  }
  renderVoiceBar();
  renderStage();
}

// The shared program's sound arrives from the desktop app in chunks, and plays into a
// track of its own that goes out with the stream.
let appAudioPort = null;
window.burrowDesktop?.appAudio?.onChunk((chunk) => {
  if (!appAudioPort) return;
  const buffer = chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength ? chunk.buffer : chunk.slice().buffer;
  appAudioPort.postMessage(buffer, [buffer]);
});

async function startAppAudio(voice, context) {
  const LK = window.LivekitClient;
  await context.audioWorklet.addModule('app-audio-worklet.js');
  const node = new AudioWorkletNode(context, 'app-audio', { numberOfInputs: 0, outputChannelCount: [2] });
  const out = context.createMediaStreamDestination();
  out.channelCount = 2;
  node.connect(out);
  appAudioPort = node.port;
  voice.appAudio = { context, track: out.stream.getAudioTracks()[0] };
  const sharing = await window.burrowDesktop.appAudio.start();
  const lp = voice.room?.localParticipant;
  if (!sharing || voice.appAudio?.context !== context || state.voice !== voice || !lp?.isScreenShareEnabled) {
    if (voice.appAudio?.context === context) stopAppAudio(voice);
    return;
  }
  await lp.publishTrack(voice.appAudio.track, {
    source: LK.Track.Source.ScreenShareAudio,
    // Music quality in stereo; never cut out during quiet parts.
    audioPreset: { maxBitrate: 128_000 }, forceStereo: true, dtx: false, red: false,
  });
}

function stopAppAudio(voice) {
  const a = voice?.appAudio;
  if (!a) return;
  voice.appAudio = null;
  appAudioPort = null;
  window.burrowDesktop?.appAudio?.stop();
  const lp = voice.room?.localParticipant;
  if (lp && [...lp.trackPublications.values()].some((pub) => pub.track?.mediaStreamTrack === a.track)) {
    lp.unpublishTrack(a.track).catch(() => {});
  }
  a.track.stop();
  a.context.close().catch(() => {});
}

/** Full screen for one tile. iPhones can only show a video itself full screen. */
function toggleFullscreen(t) {
  if (document.fullscreenElement) return document.exitFullscreen().catch(() => {});
  if (t.el.requestFullscreen) return t.el.requestFullscreen().catch(() => {});
  t.media?.webkitEnterFullscreen?.();
}
document.addEventListener('fullscreenchange', () => {
  const el = document.fullscreenElement;
  for (const t of tiles.values()) t.el.querySelector('.vtile-full').title = t.el === el ? 'Exit full screen (Esc)' : 'Full screen';
  if (!el) renderStage(); // put the tiles back in order
});

function openStage() {
  if (!state.voice) return;
  if (!state.stageOpen) state.stageShow = 'fire';
  state.stageOpen = true;
  $('#stage').classList.remove('hidden');
  $('#app').classList.add('watching');
  renderVoicePlaces();
  renderStage();
  renderFireside();
}

function closeStage() {
  if (!state.stageOpen) return;
  state.stageOpen = false;
  focusKey = null;
  state.firesideOpen = false;
  $('#stage').classList.add('hidden');
  $('#app').classList.remove('watching');
  renderVoicePlaces();
  renderStage();
}

/** Swaps the fire for the video grid, with one tile ("id:screen" or "id:camera") shown big. */
function openVideo(key) {
  if (!state.voice?.room) return;
  if (!state.stageOpen) openStage();
  state.stageShow = 'video';
  focusKey = key;
  renderStage();
}

function renderStage() {
  const room = state.voice?.room;
  const LK = window.LivekitClient;
  if (!LK) return;
  const people = room ? [room.localParticipant, ...room.remoteParticipants.values()] : [];
  const showing = (p, source) => {
    const pub = p.getTrackPublication(source);
    return pub && !pub.isMuted ? pub : null;
  };

  // Who's on camera or sharing, for the sidebar.
  const sharing = new Map();
  for (const p of people) {
    const camera = !!showing(p, LK.Track.Source.Camera), screen = !!showing(p, LK.Track.Source.ScreenShare);
    if (camera || screen) sharing.set(Number(p.identity), { camera, screen });
  }
  const others = [...sharing.keys()].some((id) => id !== state.me?.id);
  $('#voice-watch').classList.toggle('has-video', others && !state.stageOpen);
  $('#voice-watch').classList.toggle('on', state.stageOpen);
  $('#voice-watch').title = state.stageOpen ? 'Back to chat' : 'Open the fire';
  $('#stage').dataset.show = state.stageShow;
  $('#stage-video').classList.toggle('hidden', !sharing.size);
  if (JSON.stringify([...sharing]) !== JSON.stringify([...state.sharing])) {
    state.sharing = sharing;
    renderChannels();
  }
  // Joined from a go-live post: open their screen as soon as it arrives.
  if (state.watchOnJoin && sharing.get(state.watchOnJoin)?.screen) {
    const id = state.watchOnJoin;
    state.watchOnJoin = null;
    setTimeout(() => openVideo(`${id}:screen`));
  }

  // Off the video grid, let go of its video so none of it is downloaded. (The fire shows cameras itself.)
  const wanted = [];
  const onVideo = state.stageOpen && state.stageShow === 'video';
  const popped = poppedOutKey();
  if ((onVideo || popped) && room) {
    const ch = [...state.servers.values()].flatMap((s) => s.channels).find((c) => c.id === state.voice.channelId);
    $('#video-title').textContent = ch?.name ?? 'Voice';
    for (const p of people) {
      const id = Number(p.identity);
      const me = p === room.localParticipant;
      const name = nameOf(id, p.name || '?');
      const screen = showing(p, LK.Track.Source.ScreenShare);
      if (screen) wanted.push({ key: `${id}:screen`, id, track: screen.track ?? null, label: me ? 'Your screen' : `${name}'s screen`, icon: SCREEN_ICON, kind: 'screen', audio: !me && !!p.getTrackPublication(LK.Track.Source.ScreenShareAudio) });
      const camera = showing(p, LK.Track.Source.Camera);
      wanted.push({ key: `${id}:camera`, id, track: camera?.track ?? null, label: me ? `${name} (you)` : name, kind: 'camera', mirror: me, name });
    }
    // Back in the chat, only a stream that's popped out keeps playing.
    if (!onVideo) wanted.splice(0, wanted.length, ...wanted.filter((w) => w.key === popped));
  }
  if (focusKey && !wanted.some((w) => w.key === focusKey)) focusKey = null;
  const screens = wanted.filter((w) => w.kind === 'screen');
  if (screens.length < 2) sideBySide = false;
  $('#video-layout').classList.toggle('hidden', screens.length < 2);
  $('#video-layout').textContent = sideBySide ? 'Back to the grid' : 'Screens side by side';
  const isFocus = (w) => (sideBySide ? w.kind === 'screen' : focusKey === w.key);

  for (const [key, t] of tiles) {
    if (wanted.some((w) => w.key === key)) continue;
    if (t.media && document.pictureInPictureElement === t.media) document.exitPictureInPicture().catch(() => {});
    if (t.track && t.media) t.track.detach(t.media);
    if (t.el.contains($('#fire-chat'))) restoreStreamChat();
    stopClips(key);
    tiles.delete(key);
  }
  for (const w of wanted) {
    let t = tiles.get(w.key);
    if (!t) {
      const el = document.createElement('div');
      el.onclick = (e) => {
        if (document.fullscreenElement || e.target.closest('.fire-chat, .vtile-tools, .stream-audio') || el.classList.contains('drawing')) return;
        if (sideBySide) { sideBySide = false; focusKey = w.key; }
        else focusKey = focusKey === w.key ? null : w.key;
        renderStage();
      };
      const label = document.createElement('div');
      label.className = 'vtile-name';
      const tools = document.createElement('div');
      tools.className = 'vtile-tools';
      const full = document.createElement('button');
      full.type = 'button';
      full.className = 'vtile-full';
      full.title = 'Full screen';
      full.innerHTML = FULLSCREEN_ICON + EXIT_FULLSCREEN_ICON;
      t = { key: w.key, id: w.id, kind: w.kind, el, label, tools, track: undefined, media: null, audio: null };
      tools.append(...streamTools(t), full);
      el.append(label, tools);
      if (w.kind === 'screen') {
        t.viewers = document.createElement('div');
        t.viewers.className = 'vtile-viewers hidden';
        t.draw = drawCanvas(t);
        el.append(t.viewers, t.draw);
      }
      full.onclick = (e) => { e.stopPropagation(); toggleFullscreen(t); };
      el.ondblclick = (e) => { if (!e.target.closest('.fire-chat, .vtile-tools') && !el.classList.contains('drawing')) toggleFullscreen(t); };
      tiles.set(w.key, t);
    }
    if (t.track !== w.track) {
      stopClips(w.key);
      if (t.track && t.media) t.track.detach(t.media);
      t.media?.remove();
      if (w.track) {
        t.media = w.track.attach();
        t.media.muted = true; // sound comes through the voice mix
        // Size the enlarged tile to the video, so there are no black bars around it.
        const fit = () => { if (t.media.videoWidth) t.el.style.setProperty('--ar', t.media.videoWidth / t.media.videoHeight); paintStrokes(t); };
        t.media.addEventListener('resize', fit);
        t.media.addEventListener('loadedmetadata', fit);
        t.media.addEventListener('enterpictureinpicture', () => { poppedKey = t.key; renderStage(); });
        t.media.addEventListener('leavepictureinpicture', () => { if (poppedKey === t.key) poppedKey = null; renderStage(); });
      } else {
        t.media = document.createElement('span');
        t.media.className = 'avatar lg';
        setAvatar(t.media, w.name ?? '?', avatarOf(w.id));
        t.el.style.removeProperty('--ar');
      }
      t.el.prepend(t.media);
      t.track = w.track;
    }
    if (w.audio && !t.audio) t.audio = streamAudioControl(w.id, t.el);
    if (!w.audio && t.audio) { t.audio.remove(); t.audio = null; }
    t.label.innerHTML = `${w.icon ?? ''}<span>${escapeHtml(w.label)}</span>${state.mutedInVoice.has(w.id) && w.kind === 'camera' ? MUTED_ICON : ''}`;
    t.el.className = 'vtile ' + w.kind
      + (w.mirror && w.track ? ' mirror' : '')
      + (w.kind === 'camera' && state.speaking.has(w.id) ? ' speaking' : '')
      + (isFocus(w) ? ' focus' : '')
      + (drawingOn.has(w.key) ? ' drawing' : '')
      + (t.el.contains($('#fire-chat')) ? ' chatting' : '');
    t.el.classList.toggle('no-video', !w.track);
    if (t.viewers) renderViewers(t);
    updateStreamTools(t);
    t.el.title = focusKey === w.key ? 'Click to shrink, double-click for full screen' : 'Click to make bigger, double-click for full screen';
  }
  const order = wanted.map((w) => tiles.get(w.key).el);
  const big = order.filter((el) => el.classList.contains('focus'));
  const focused = big[0];
  const grid = $('#stage-grid');
  const next = [...big, ...order.filter((el) => !big.includes(el))];
  // Moving a tile that's full screen would drop it out of full screen, so while one is,
  // tiles only come and go; the order catches up afterwards.
  if (document.fullscreenElement && grid.contains(document.fullscreenElement)) {
    for (const el of [...grid.children]) if (!next.includes(el)) el.remove();
    for (const el of next) if (el.parentNode !== grid) grid.append(el);
  } else if (next.length !== grid.children.length || next.some((el, i) => grid.children[i] !== el)) {
    grid.replaceChildren(...next);
  }
  grid.classList.toggle('focused', !!focused);
  grid.classList.toggle('side-by-side', sideBySide);
  grid.classList.toggle('many', screens.length > 2);
  $('#stage-grid').classList.toggle('solo', !!focused && order.length === 1);
  // The chat over a stream stays only while that stream is big or full screen.
  const chatTile = [...tiles.values()].find((t) => t.el.contains($('#fire-chat')));
  if (chatTile && !chatTile.el.classList.contains('focus') && document.fullscreenElement !== chatTile.el) restoreStreamChat();
  reportWatching();
  renderFire();
}
