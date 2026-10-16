// Games at the fire: one game per fire, for up to four of the people sitting there.
//
// A game is its own page (client/games/<name>/), shown in a frame on the fire's stage. Whoever
// starts it is the host: their copy runs the match, and the others' copies send it their moves.
// Peiskos's server passes those messages along to the right players (nothing goes peer to peer),
// keeps who's playing, and ends the game when the host leaves.

const FIRE_GAMES = {
  melonbomber: {
    title: 'Melon Bomber',
    blurb: 'Drop melons, break crates, grab power-ups and be the last melon standing. Two to four players; bots fill in if you play alone.',
  },
};
const GAME_MAX_PLAYERS = 4;

let fireGame = null; // { channelId, game: { name, hostId, players, since } } at your fire
let gamePlay = null; // { name, frame, ready, queue } while you're playing, on this device
let gameStarting = false; // you asked to start or join, so the game opens once Peiskos says you're in

const sendGame = (msg) => state.ws?.readyState === WebSocket.OPEN && state.ws.send(JSON.stringify({ type: 'game', ...msg }));
const inFireGame = () => !!fireGame?.game?.players.includes(state.me?.id);
const gamePlayers = (g) => g.players.map((id) => ({ id, name: nameOf(id, 'Player') }));

function openGamePicker() {
  if (fireGame?.game) return joinFireGame();
  modal(`<h2>Play a game together</h2>
    <p class="small muted">Everyone at the fire can join, up to ${GAME_MAX_PLAYERS} players. You can keep talking while you play.</p>
    <div class="game-picks">${Object.entries(FIRE_GAMES).map(([name, g]) => `
      <button type="button" class="game-pick" data-game="${name}">
        <span class="game-pick-icon" aria-hidden="true">🍉</span>
        <span class="game-pick-text"><b>${g.title}</b><span class="small muted">${g.blurb}</span></span>
        <span class="btn">Start</span>
      </button>`).join('')}
    </div>`);
  $('#modal-card').querySelectorAll('[data-game]').forEach((b) => (b.onclick = () => {
    closeModal();
    gameStarting = true;
    sendGame({ action: 'start', game: b.dataset.game });
  }));
}

function joinFireGame() {
  const g = fireGame?.game;
  if (!g) return;
  if (gamePlay) return showGame();
  if (!inFireGame() && g.players.length >= GAME_MAX_PLAYERS) return toast(`The game is full (${GAME_MAX_PLAYERS} players).`);
  gameStarting = true;
  sendGame({ action: 'start', game: g.name }); // joins, or moves your game to this device
}

function onGameState(ev) {
  if (state.voice?.channelId !== ev.channelId) return;
  const before = fireGame?.game;
  fireGame = { channelId: ev.channelId, game: ev.game };
  const g = ev.game;
  if (!g) {
    if (gamePlay) toast(before && before.hostId !== state.me.id ? `${nameOf(before.hostId)} ended the game.` : 'The game ended.');
    closeGame();
  } else if (!before || before.since !== g.since) {
    if (g.hostId !== state.me.id) fireNote(`${nameOf(g.hostId)} started ${FIRE_GAMES[g.name]?.title ?? 'a game'}`);
  }
  if (g && inFireGame()) {
    if (gamePlay) postToGame({ kind: 'players', hostId: g.hostId, players: gamePlayers(g) });
    else if (gameStarting) loadGame(g.name);
  } else if (gamePlay) closeGame(); // out of it (or playing on another device now)
  if (g && inFireGame()) gameStarting = false;
  renderGamePanel();
}

function onGameMessage(ev) {
  if (!gamePlay || state.voice?.channelId !== ev.channelId) return;
  postToGame({ kind: 'msg', from: ev.from, data: ev.data });
}

/** Messages wait until the game's page says it's ready for them. */
function postToGame(msg) {
  if (!gamePlay) return;
  if (!gamePlay.ready) return gamePlay.queue.push(msg);
  gamePlay.frame.contentWindow?.postMessage(msg, '*');
}

function loadGame(name) {
  closeGame();
  const frame = document.createElement('iframe');
  frame.className = 'game-iframe';
  frame.title = FIRE_GAMES[name]?.title ?? 'Game';
  frame.src = `games/${name}/index.html`;
  frame.allow = 'fullscreen';
  gamePlay = { name, frame, ready: false, queue: [] };
  $('#game-frame').replaceChildren(frame);
  $('#game-view-title').textContent = frame.title;
  showGame();
}

function showGame() {
  if (!gamePlay) return;
  if (!state.stageOpen) openStage();
  state.stageShow = 'game';
  renderStage();
  renderGamePanel();
  gamePlay.frame.focus();
}

function closeGame() {
  gamePlay = null;
  $('#game-frame').replaceChildren();
  if (state.stageShow === 'game') {
    state.stageShow = 'fire';
    renderStage();
  }
}

/** Leaving the fire leaves the game (Peiskos's server does that part). */
function stopGame() {
  fireGame = null;
  gameStarting = false;
  closeGame();
  renderGamePanel();
}

/** Peiskos's server lets go of your game when your connection drops; it says what's going on again once you're back. */
function gameConnectionLost() {
  if (gamePlay) toast('Your connection dropped, so you left the game.');
  stopGame();
}

function leaveFireGame() {
  sendGame({ action: 'leave' });
  closeGame();
  renderGamePanel();
}

window.addEventListener('message', (e) => {
  if (!gamePlay || e.source !== gamePlay.frame.contentWindow) return;
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  if (m.kind === 'ready') {
    const g = fireGame?.game;
    if (!g) return;
    gamePlay.ready = true;
    gamePlay.frame.contentWindow.postMessage({ kind: 'init', me: { id: state.me.id, name: nameOf(state.me.id, 'Player') }, hostId: g.hostId, players: gamePlayers(g) }, '*');
    for (const q of gamePlay.queue.splice(0)) postToGame(q);
  } else if (m.kind === 'send') {
    if (m.to === 'all' || Number.isInteger(m.to)) sendGame({ action: 'send', to: m.to, data: m.data });
  } else if (m.kind === 'leave') {
    leaveFireGame();
  }
});

function renderGamePanel() {
  const g = fireGame?.game;
  $('#fire-game').classList.toggle('on', !!g);
  $('#game-panel').classList.toggle('hidden', !g);
  if (!g) return;
  const info = FIRE_GAMES[g.name] ?? { title: 'A game' };
  const playing = inFireGame();
  $('#game-panel-title').textContent = info.title;
  $('#game-panel-sub').textContent = `Started by ${g.hostId === state.me.id ? 'you' : nameOf(g.hostId)} · ${g.players.length} of ${GAME_MAX_PLAYERS} playing`;
  const open = $('#game-panel-open');
  open.textContent = playing ? (gamePlay ? 'Back to the game' : 'Open the game') : g.players.length >= GAME_MAX_PLAYERS ? 'Full' : 'Join';
  open.disabled = !playing && g.players.length >= GAME_MAX_PLAYERS;
  const leave = $('#game-panel-leave');
  leave.classList.toggle('hidden', !playing);
  leave.textContent = g.hostId === state.me.id ? 'End game' : 'Leave';
  leave.title = g.hostId === state.me.id ? 'Ends the game for everyone' : '';
}

$('#fire-game').innerHTML = GAME_ICON;
$('#fire-game').onclick = openGamePicker;
$('#game-panel-open').onclick = joinFireGame;
$('#game-panel-leave').onclick = leaveFireGame;
$('#game-view-back').onclick = () => {
  state.stageShow = 'fire';
  renderStage();
  renderGamePanel();
};
