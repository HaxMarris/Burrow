/* ============================================================
   MELON BOMBER — played by friends at a Peiskos fire.
   Peiskos frames this page and passes the players' messages
   through its own server (nothing goes peer to peer).
   ============================================================ */

(function(){

// ---------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------
function $(id){ return document.getElementById(id); }
function rand(n){ return Math.floor(Math.random()*n); }
function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }
function showToast(msg){
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(()=> t.remove(), 2600);
}
// names longer than this don't fit the HUD
function shortName(name){ return String(name||'Player').slice(0,12); }

// decorative seed field
(function seedBg(){
  const field = $('seedField');
  for(let i=0;i<26;i++){
    const d = document.createElement('div');
    d.className='seed-dot';
    d.style.left = (rand(100))+'%';
    d.style.top = (rand(100))+'%';
    d.style.transform = `rotate(${rand(360)}deg)`;
    field.appendChild(d);
  }
})();

// ---------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------
const TILE = 50;
let COLS = 13, ROWS = 11;                 // set per match from player count
let CANVAS_W = COLS*TILE, CANVAS_H = ROWS*TILE;

// Board grows with the player count so 2p isn't a marathon and 4p isn't a knife fight.
// Both dimensions stay odd so the pillar pattern and corner spawns line up.
const MAP_SIZES = { 2:[11,9], 3:[13,11], 4:[15,13] };

function applyBoardSize(cols, rows){
  COLS = cols; ROWS = rows;
  CANVAS_W = COLS*TILE; CANVAS_H = ROWS*TILE;
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  if(typeof R3 !== 'undefined' && R3.renderer){
    R3.renderer.setSize(CANVAS_W, CANVAS_H, false);
    // orthographic: refit the frustum rather than setting an aspect
    if(R3.camera) r3PlaceCamera(0,0);
  }
}

function boardSizeFor(playerCount){
  return MAP_SIZES[clamp(playerCount,2,4)] || MAP_SIZES[4];
}

// Map rotation. Every layout only ever places walls on (even,even) tiles, which
// guarantees the board stays fully connected: odd rows and odd columns are never
// blocked, so every open tile has a route to every other.
const MAPS = [
  { name:'Melon Grove',  wall:(x,y)=> x%2===0 && y%2===0,                 crate:0.68 },
  { name:'Open Orchard', wall:()=> false,                                  crate:0.52 },
  { name:'Seed Rows',    wall:(x,y)=> x%2===0 && y%2===0 && y%4!==0,       crate:0.64 },
  { name:'Split Rind',   wall:(x,y)=> x%2===0 && y%2===0 && (x+y)%4===0,   crate:0.62 },
];
let mapRotation = 0;   // advances each match so layouts cycle
const TICK_MS = 1000/30;           // simulation runs at 30hz on host
const BROADCAST_MS = 1000/30;      // host -> clients state broadcast rate
const BOMB_FUSE = 2600;            // ms
const EXPLOSION_LIFE = 480;        // ms explosion tile stays dangerous/visible
const PLAYER_SPEED_BASE = 3.0;     // tiles/sec base
const KICK_SPEED = 6.5;            // tiles/sec a kicked bomb slides
const MAX_KICK_TILES = 6;          // furthest a bomb travels from one kick
const STORM_DROP_MS = 850;         // gap between sudden-death melon drops
const STORM_FUSE = 1400;           // shorter fuse than a placed bomb
const STORM_BOMB_RANGE = 2;
let suddenDeathSetting = 120;      // seconds until the storm; 0 = off
const PLAYER_COLORS = [
  {name:'Watermelon', body:'#ff5c7a', dark:'#c9264a', light:'#ffb3c1'},
  {name:'Honeydew',   body:'#9ef01a', dark:'#5a8f0c', light:'#dcf7a3'},
  {name:'Cantaloupe', body:'#ffb703', dark:'#c97e00', light:'#ffe08a'},
  {name:'Galia',      body:'#7fd8be', dark:'#2e9c78', light:'#c7f2e4'},
];
const TILE_EMPTY=0, TILE_WALL=1, TILE_CRATE=2;
const DIR_VEC = { up:[0,-1], down:[0,1], left:[-1,0], right:[1,0] };
const DIR_CODE = { up:1, down:2, left:3, right:4 };
const DIR_NAME = { 1:'up', 2:'down', 3:'left', 4:'right' };
const POWERUP_BOMB='bomb', POWERUP_RANGE='range', POWERUP_SPEED='speed', POWERUP_KICK='kick';

// ---------------------------------------------------------------
// GLOBAL STATE
// ---------------------------------------------------------------
let myId = null;                 // local player slot id (0-3)
let isHost = false;
let me = null;                   // {id, name}: who you are in Peiskos
let hostUid = null;              // the Peiskos id of whoever started the game
let conns = [];                  // host: a connection-like object per player (see connFor)
let hostConn = null;             // client: the same, to the host
let matchOn = false;             // host: a round is being played
let lobbyPlayers = [];           // {slot, name, color, uid, hat} — used pre-match
let botMode = false;
let myName = 'Player';
let myHat = 'none';

function populateHatSelect(){
  const sel = $('hatSelect');
  if(!sel || sel.options.length) return;
  HATS.forEach(h=>{
    const o = document.createElement('option');
    o.value = h.id; o.textContent = h.name;
    sel.appendChild(o);
  });
  try{ const saved = localStorage.getItem('melonbomberHat'); if(saved && HATS.some(h=>h.id===saved)) sel.value = saved; }catch(e){}
}
let lobbyScores = {};   // slot -> round wins, persists across matches in a lobby

function resetScores(){ lobbyScores = {}; }

function buildScoreboard(){
  const wrap = document.createElement('div');
  wrap.className = 'scoreboard';
  const head = document.createElement('div');
  head.className = 'scoreboard-title';
  head.textContent = 'Round wins';
  wrap.appendChild(head);

  const roster = (game && game.roster) ? [...game.roster] : [];
  roster
    .map(rp=>({rp, wins: lobbyScores[rp.slot] || 0}))
    .sort((a,b)=> b.wins - a.wins || a.rp.slot - b.rp.slot)
    .forEach(({rp, wins})=>{
      const row = document.createElement('div');
      row.className = 'score-row' + (rp.slot===myId ? ' me' : '');
      const dot = document.createElement('span');
      dot.className = 'score-dot';
      dot.style.background = PLAYER_COLORS[rp.colorIdx%4].body;
      row.appendChild(dot);
      const nm = document.createElement('span');
      nm.className = 'score-name';
      nm.textContent = (rp.slot===myId ? 'You' : rp.name);
      row.appendChild(nm);
      const w = document.createElement('span');
      w.className = 'score-wins';
      w.textContent = wins;
      row.appendChild(w);
      wrap.appendChild(row);
    });
  return wrap;
}

function readMenuSettings(){
  myName = me ? me.name : 'Player';
  const sel = parseInt($('stormSelect').value, 10);
  suddenDeathSetting = isNaN(sel) ? 120 : sel;
  myHat = $('hatSelect').value || 'none';
}

let game = null;                 // active Game instance
let localInput = {up:false,down:false,left:false,right:false,bomb:false,kick:false};
let lastBombPress = false;

const canvas = $('gameCanvas');
// no 2D context here — the canvas is owned by the WebGL renderer

// ---------------------------------------------------------------
// SCREEN MANAGEMENT
// ---------------------------------------------------------------
function showScreen(name){
  $('menuScreen').classList.add('hidden');
  $('lobbyScreen').classList.add('hidden');
  $('gameWrap').classList.add('hidden');
  if(name==='menu') $('menuScreen').classList.remove('hidden');
  if(name==='lobby') $('lobbyScreen').classList.remove('hidden');
  if(name==='game') $('gameWrap').classList.remove('hidden');
}

// ================================================================
// NETWORKING — through Peiskos
// The Peiskos page around this one says who you are and who's playing,
// and carries messages to and from the other players' games. Whoever
// started the game is its host and runs the match, as before.
// ================================================================

function toPeiskos(msg){ window.parent.postMessage(msg, '*'); }

// Stands in for a peer connection: sending goes through Peiskos.
function connFor(uid){
  return {
    uid, peer:'u'+uid, open:true,
    send(data){ if(this.open) toPeiskos({kind:'send', to:uid, data}); },
    close(){ this.open = false; },
  };
}

function hostGame(players){
  readMenuSettings();
  resetScores();
  isHost = true;
  myId = 0;
  botMode = false;
  conns = [];
  lobbyPlayers = [{slot:0, name:myName, colorIdx:0, isHost:true, connId:null, uid:me.id, hat:myHat}];
  syncPlayers(players);
  $('btnQuit').title = 'End the game for everyone';
  renderLobby(true);
  showScreen('lobby');
}

// Host: Peiskos says who's in the game now. Newcomers get a free slot;
// anyone missing has left.
function syncPlayers(players){
  const ids = new Set(players.map(p=>p.id));
  conns.filter(c=>!ids.has(c.uid)).forEach(c=>onClientDisconnected(c));
  players.forEach(p=>{
    if(p.id===me.id || conns.some(c=>c.uid===p.id) || lobbyPlayers.length >= 4) return;
    const conn = connFor(p.id);
    const slot = nextFreeSlot();
    conns.push(conn);
    lobbyPlayers.push({slot, name:shortName(p.name), colorIdx:slot, isHost:false, connId:conn.peer, uid:p.id, hat:'none'});
    broadcastLobby();
    renderLobby();
    showToast(shortName(p.name)+' joined!');
  });
}

function nextFreeSlot(){
  for(let i=0;i<4;i++){
    if(!lobbyPlayers.find(p=>p.slot===i)) return i;
  }
  return lobbyPlayers.length;
}

function onClientDisconnected(conn){
  conn.close();
  conns = conns.filter(c=>c!==conn);
  const idx = lobbyPlayers.findIndex(p=>p.connId===conn.peer);
  if(idx>=0){
    const removedSlot = lobbyPlayers[idx].slot;
    lobbyPlayers.splice(idx,1);
    // whoever takes this slot next starts from zero wins
    if(!(game && game.running)) delete lobbyScores[removedSlot];
    broadcastLobby();
    renderLobby();
    showToast('A player left.');
    if(game && game.running){
      game.markDisconnected(removedSlot);
    }
  }
}

function onHostReceiveData(conn, data){
  if(data.type==='input'){
    // a player only ever steers their own melon
    const p = lobbyPlayers.find(pp=>pp.connId===conn.peer);
    if(game && p) game.setRemoteInput(p.slot, data.input);
  } else if(data.type==='joinInfo'){
    // the name always comes from Peiskos; the hat is the player's pick
    const p = lobbyPlayers.find(pp=>pp.connId===conn.peer);
    if(p){ p.hat = hatById(data.hat).id; broadcastLobby(); renderLobby(); }
  }
}

function broadcastLobby(){
  broadcastToAll({type:'lobby', inMatch:matchOn, players: lobbyPlayers.map(p=>({slot:p.slot,name:p.name,colorIdx:p.colorIdx,isHost:p.isHost,hat:p.hat,uid:p.uid}))});
}

// One message for everyone; the Peiskos server hands it to each player.
function broadcastToAll(payload){
  if(conns.length) toPeiskos({kind:'send', to:'all', data:payload});
}

function joinGame(){
  readMenuSettings();
  resetScores();
  isHost = false;
  botMode = false;
  hostConn = connFor(hostUid);
  hostConn.send({type:'joinInfo', hat:myHat});
  showScreen('lobby');
  $('btnStartMatch').classList.add('hidden');
  $('lobbyStatus').textContent = 'Waiting for host to start…';
  renderLobby();
}

let lobbyInMatch = false;        // client: the host is in the middle of a round
function onClientReceiveData(data){
  if(data.type==='lobby'){
    lobbyPlayers = data.players;
    lobbyInMatch = !!data.inMatch;
    const mine = lobbyPlayers.find(p=>p.uid===me.id);
    if(mine && !(game && game.running)) myId = mine.slot;
    renderLobby();
  } else if(data.type==='youAre'){
    myId = data.slot;
    renderLobby();
  } else if(data.type==='startMatch'){
    if(typeof data.storm === 'number') suddenDeathSetting = data.storm;
    beginMatch(data.seed, data.players, false, data.mapIndex, data.cols, data.rows);
  } else if(data.type==='scores'){
    lobbyScores = data.scores || {};
    if(overlayShown && game){ overlayShown = false; renderGameOverOverlay(); }
    renderLobby();
  } else if(data.type==='toLobby'){
    backToLobby();
  } else if(data.type==='state'){
    if(game) game.applyHostState(data.state);
  } else if(data.type==='event'){
    if(game) game.applyHostEvent(data.event);
  }
}

// ---------------------------------------------------------------
// LOBBY RENDERING
// ---------------------------------------------------------------
function renderLobby(isFreshHost){
  $('stormRow').classList.toggle('hidden', !isHost);
  if(isHost){
    $('btnStartMatch').classList.remove('hidden');
    $('btnStartMatch').disabled = false;
    $('lobbyStatus').textContent = lobbyPlayers.length>1 ? '' : 'Waiting for friends at the fire to join… you can start solo vs bots too.';
  } else {
    $('lobbyStatus').textContent = lobbyInMatch ? "A round is going. You'll play in the next one." : 'Waiting for host to start…';
  }
  const list = $('lobbyPlayerList');
  list.innerHTML = '';
  const sorted = [...lobbyPlayers].sort((a,b)=>a.slot-b.slot);
  sorted.forEach(p=>{
    const row = document.createElement('div');
    row.className='player-row';
    const sw = document.createElement('div');
    sw.className='swatch';
    sw.style.background = PLAYER_COLORS[p.colorIdx % 4].body;
    row.appendChild(sw);
    const label = document.createElement('span');
    label.textContent = p.name + ' — ' + PLAYER_COLORS[p.colorIdx%4].name;
    row.appendChild(label);
    const wins = lobbyScores[p.slot] || 0;
    if(wins > 0){
      const wtag = document.createElement('span');
      wtag.className='score-wins';
      wtag.style.marginLeft='auto';
      wtag.textContent = '🏆 ' + wins;
      row.appendChild(wtag);
    }
    if(p.isHost){
      const tag=document.createElement('span'); tag.className='host-tag'; tag.textContent='HOST'; row.appendChild(tag);
    } else if(me && p.uid===me.id){
      const tag=document.createElement('span'); tag.className='you-tag'; tag.textContent='YOU'; row.appendChild(tag);
    }
    list.appendChild(row);
  });
}


// ---------------------------------------------------------------
// LOBBY BUTTON WIRING
// ---------------------------------------------------------------
// Leaving goes through Peiskos, which closes this page. When the host
// leaves, the game is over for everyone.
function leaveGame(){
  toPeiskos({kind:'leave'});
}

$('btnQuit').addEventListener('click', ()=> leaveGame());
$('btnLeaveLobby').addEventListener('click', ()=> leaveGame());
$('hatSelect').addEventListener('change', ()=>{
  myHat = hatById($('hatSelect').value).id;
  try{ localStorage.setItem('melonbomberHat', myHat); }catch(e){}
  if(isHost){
    const mine = lobbyPlayers.find(p=>p.slot===0);
    if(mine) mine.hat = myHat;
    broadcastLobby();
    renderLobby();
  } else if(hostConn){
    hostConn.send({type:'joinInfo', hat:myHat});
  }
});
$('btnStartMatch').addEventListener('click', ()=>{
  if(!isHost) return;
  readMenuSettings();
  startNewMatch();
});

// Host: everyone in the lobby now plays (bots fill in for a solo host).
function startNewMatch(){
  const seed = Date.now();
  let rosterForMatch = lobbyPlayers;
  if(lobbyPlayers.length < 2){
    rosterForMatch = addBotsToRoster(lobbyPlayers, 3); // fill with bots if solo host wants to start
  }
  // tell each client their slot id
  conns.forEach(c=>{
    const p = lobbyPlayers.find(pp=>pp.connId===c.peer);
    if(p){ try{ c.send({type:'youAre', slot:p.slot}); }catch(e){} }
  });
  const mapIndex = mapRotation++;
  const size = boardSizeFor(rosterForMatch.length);
  rosterForMatch = rosterForMatch.map(p=>({slot:p.slot, name:p.name, colorIdx:p.colorIdx, isHost:!!p.isHost, isBot:!!p.isBot, hat:p.hat}));
  matchOn = true;
  broadcastToAll({type:'startMatch', seed, players: rosterForMatch, mapIndex, cols:size[0], rows:size[1], storm:suddenDeathSetting});
  broadcastLobby();
  beginMatch(seed, rosterForMatch, false, mapIndex, size[0], size[1]);
}

// Back from a finished round to the lobby, where newcomers wait and the
// host can change the storm timer.
function backToLobby(){
  if(simTimer){ clearInterval(simTimer); simTimer = null; }
  const overlay = $('overlay');
  overlay.classList.add('hidden');
  overlay.innerHTML='';
  overlayShown = false;
  game = null;
  matchOn = false;
  localInput = {up:false,down:false,left:false,right:false,bomb:false,kick:false};
  if(isHost){ broadcastToAll({type:'toLobby'}); broadcastLobby(); }
  else lobbyInMatch = false;
  const mine = lobbyPlayers.find(p=>me && p.uid===me.id);
  if(mine) myId = mine.slot;
  renderLobby();
  showScreen('lobby');
}

function addBotsToRoster(roster, botCount){
  const result = [...roster];
  const used = new Set(result.map(p=>p.slot));
  let bots = 0;
  const maxBots = botCount!==undefined ? botCount : (4 - roster.length);
  for(let i=0;i<4 && bots<maxBots;i++){
    if(!used.has(i)){
      result.push({slot:i, name:'Bot '+(bots+1), colorIdx:i, isHost:false, isBot:true,
                   hat: HATS[1 + rand(HATS.length-1)].id});
      used.add(i);
      bots++;
    }
  }
  return result;
}

// ================================================================
// GAME ENGINE
// ================================================================

class Game{
  constructor(seed, roster, localOnly, mapIndex){
    this.seed = seed;
    this.rngState = seed >>> 0;
    this.mapIndex = mapIndex || 0;
    this.roster = roster; // list of {slot,name,colorIdx,isBot,isHost}
    this.localOnly = localOnly; // true = practice vs bots, fully local sim, no networking
    this.running = true;
    this.startTime = performance.now();
    this.remoteInputs = {}; // slot -> input obj (host only)
    this.pressLatch = {};   // slot -> {bomb, kick} pressed since the last tick (host only)
    this.players = {};      // slot -> player state
    this.bombs = [];        // {id,x,y,slot,fuseAt,range,exploded}
    this.explosions = [];   // {x,y,until}
    this.powerups = {};     // "x,y" -> type
    this.grid = [];
    this.nextBombId = 1;
    this.matchOver = false;
    this.winnerSlot = null;
    this.lastTick = performance.now();
    this.accumulator = 0;
    this.broadcastAccum = 0;
    this.botTimers = {};
    this.particles = [];
    this.scatterGlow = [];
    this.gridDelta = [];        // tile changes awaiting broadcast
    this.powerupV = 0;          // bumped whenever powerups change
    this._sentPowerupV = -1;
    this.predicting = false;
    this.stormActive = false;
    this.stormCountdown = 0;
    this.nextStormDrop = 0;
    this.suddenDeathMs = (typeof suddenDeathSetting === 'number' && suddenDeathSetting > 0)
      ? suddenDeathSetting * 1000 : Infinity;
    this.shakeUntil = 0; this.shakeMag = 0;

    this.buildGrid();
    this.spawnPlayers();
  }

  rand(){
    // simple deterministic LCG so host+solo bots behave consistently
    this.rngState = (this.rngState * 1664525 + 1013904223) >>> 0;
    return this.rngState / 4294967296;
  }
  randInt(n){ return Math.floor(this.rand()*n); }

  buildGrid(){
    this.grid = [];
    const map = MAPS[this.mapIndex % MAPS.length];
    this.mapName = map.name;
    for(let y=0;y<ROWS;y++){
      const row=[];
      for(let x=0;x<COLS;x++){
        if(x===0||y===0||x===COLS-1||y===ROWS-1) row.push(TILE_WALL);
        else if(map.wall(x,y)) row.push(TILE_WALL);
        else row.push(TILE_EMPTY);
      }
      this.grid.push(row);
    }
    // corner safe zones (spawn + adjacent tiles kept clear)
    const corners = [[1,1],[COLS-2,1],[1,ROWS-2],[COLS-2,ROWS-2]];
    const safe = new Set();
    corners.forEach(([cx,cy])=>{
      safe.add(cx+','+cy);
      safe.add((cx+ (cx===1?1:-1))+','+cy);
      safe.add(cx+','+(cy+(cy===1?1:-1)));
    });
    for(let y=1;y<ROWS-1;y++){
      for(let x=1;x<COLS-1;x++){
        if(this.grid[y][x]===TILE_EMPTY && !safe.has(x+','+y)){
          if(this.rand() < map.crate) this.grid[y][x] = TILE_CRATE;
        }
      }
    }
  }

  spawnPlayers(){
    const corners = [
      {x:1,y:1}, {x:COLS-2,y:1}, {x:1,y:ROWS-2}, {x:COLS-2,y:ROWS-2}
    ];
    this.roster.forEach(p=>{
      const c = corners[p.slot % 4];
      this.players[p.slot] = {
        slot:p.slot, name:p.name, colorIdx:p.colorIdx, isBot:!!p.isBot,
        x: c.x*TILE + TILE/2, y: c.y*TILE + TILE/2,
        gx:c.x, gy:c.y,
        alive:true, speed:PLAYER_SPEED_BASE, maxBombs:1, bombsPlaced:0,
        range:1, kick:false, dir:'down', moving:false,
        animT:0, disconnected:false,
        respawnInvuln: 1500,
      };
    });
  }

  markDisconnected(slot){
    if(this.players[slot]){
      this.players[slot].disconnected = true;
      this.players[slot].alive = false;
    }
    this.checkWinCondition();
  }

  // ---- input handling ----
  setRemoteInput(slot, input){
    this.notePress(slot, input, this.remoteInputs[slot]);
    this.remoteInputs[slot] = input;
  }

  // A quick tap can come and go between two ticks (or arrive in the same
  // network packet as its release), so presses are remembered until a tick
  // has seen them.
  notePress(slot, input, before){
    const latch = this.pressLatch[slot] || (this.pressLatch[slot] = {bomb:false, kick:false});
    if(input.bomb && !(before && before.bomb)) latch.bomb = true;
    if(input.kick && !(before && before.kick)) latch.kick = true;
  }

  getInputFor(slot){
    if(this.localOnly || isHost){
      if(slot === myId) return localInput;
      if(this.players[slot] && this.players[slot].isBot) return this.botInput(slot);
      return this.remoteInputs[slot] || {up:false,down:false,left:false,right:false,bomb:false,kick:false};
    }
    return {up:false,down:false,left:false,right:false,bomb:false,kick:false};
  }

  // simple-ish bot AI: wander, avoid danger tiles, drop bombs near crates/enemies
  botInput(slot){
    const p = this.players[slot];
    if(!p || !p.alive) return {up:false,down:false,left:false,right:false,bomb:false,kick:false};
    if(!this.botTimers[slot]) this.botTimers[slot] = {nextDecision:0, dir:null, wantBomb:false};
    const bt = this.botTimers[slot];
    const now = performance.now();

    const dangerAt = (gx,gy)=> this.isDangerTile(gx,gy);

    if(now > bt.nextDecision){
      bt.nextDecision = now + 260 + this.randInt(220);
      const gx = Math.round((p.x - TILE/2)/TILE);
      const gy = Math.round((p.y - TILE/2)/TILE);

      // if standing in danger, run to nearest safe-ish neighbor
      if(dangerAt(gx,gy)){
        const opts = [[0,-1],[0,1],[-1,0],[1,0]].filter(([dx,dy])=>{
          const nx=gx+dx, ny=gy+dy;
          return this.isWalkable(nx,ny) && !dangerAt(nx,ny);
        });
        if(opts.length){
          const [dx,dy] = opts[this.randInt(opts.length)];
          bt.dir = dx===1?'right':dx===-1?'left':dy===1?'down':'up';
        } else {
          bt.dir = ['up','down','left','right'][this.randInt(4)];
        }
        bt.wantBomb = false;
      } else {
        // occasionally drop a bomb if near a crate or enemy and not already fleeing
        let dropBomb = false;
        if(this.rand() < 0.22){
          const activeBombsForP = this.bombs.filter(b=>b.slot===slot && !b.exploded).length;
          if(activeBombsForP < p.maxBombs){
            [[0,-1],[0,1],[-1,0],[1,0]].forEach(([dx,dy])=>{
              if(this.grid[gy+dy] && this.grid[gy+dy][gx+dx]===TILE_CRATE) dropBomb=true;
            });
            Object.values(this.players).forEach(op=>{
              if(op.alive && op.slot!==slot){
                const ogx = Math.round((op.x-TILE/2)/TILE), ogy=Math.round((op.y-TILE/2)/TILE);
                if(Math.abs(ogx-gx)+Math.abs(ogy-gy) <= 2) dropBomb = true;
              }
            });
          }
        }
        bt.wantBomb = dropBomb;
        // random wander biased to open directions
        const opts = [[0,-1],[0,1],[-1,0],[1,0]].filter(([dx,dy])=> this.isWalkable(gx+dx,gy+dy) && !dangerAt(gx+dx,gy+dy));
        if(opts.length && (this.rand()<0.7 || !bt.dir)){
          const [dx,dy] = opts[this.randInt(opts.length)];
          bt.dir = dx===1?'right':dx===-1?'left':dy===1?'down':'up';
        }
      }
    }
    const input = {up:false,down:false,left:false,right:false,bomb:false,kick:false};
    if(bt.dir) input[bt.dir]=true;
    input.bomb = !!bt.wantBomb;
    if(input.bomb) bt.wantBomb=false; // one-shot press
    return input;
  }

  isWalkable(gx,gy){
    if(gy<0||gy>=ROWS||gx<0||gx>=COLS) return false;
    const t = this.grid[gy][gx];
    if(t===TILE_WALL||t===TILE_CRATE) return false;
    if(this.bombs.some(b=>!b.exploded && b.gx===gx && b.gy===gy)) return false;
    return true;
  }

  isDangerTile(gx,gy){
    const now = performance.now();
    return this.explosions.some(e=> e.gx===gx && e.gy===gy && e.until>now) ||
      this.bombs.some(b=>!b.exploded && b.gx===gx && b.gy===gy && (b.fuseAt-now) < 700);
  }

  // ---- simulation tick (host / local only) ----
  tick(dt){
    if(this.matchOver) return;
    const now = performance.now();

    this.roster.forEach(rp=>{
      const p = this.players[rp.slot];
      if(!p || !p.alive) return;
      const input = this.getInputFor(rp.slot);
      this.movePlayer(p, input, dt);
      if(p.respawnInvuln>0) p.respawnInvuln -= dt*1000;

      const latch = this.pressLatch[rp.slot] || {};
      if((input.bomb && !p._prevBomb) || latch.bomb){
        this.tryPlaceBomb(p);
      }
      p._prevBomb = input.bomb;

      if((input.kick && !p._prevKick) || latch.kick){
        this.tryKickBomb(p);
      }
      p._prevKick = input.kick;
      this.pressLatch[rp.slot] = {bomb:false, kick:false};
    });

    // bombs
    this.bombs.forEach(b=>{
      if(!b.exploded && b.kickDir) this.slideBomb(b, dt);
    });
    this.bombs.forEach(b=>{
      if(!b.exploded && now >= b.fuseAt) this.explodeBomb(b);
    });
    this.bombs = this.bombs.filter(b=> !(b.exploded && now - b.explodedAt > 260));

    // explosions -> damage check (continuous while active, but only need one hit)
    this.explosions.forEach(e=>{
      if(now < e.until){
        Object.values(this.players).forEach(p=>{
          if(p.alive && p.respawnInvuln<=0){
            const pgx = Math.round((p.x-TILE/2)/TILE), pgy = Math.round((p.y-TILE/2)/TILE);
            if(pgx===e.gx && pgy===e.gy){
              this.killPlayer(p);
            }
          }
        });
      }
    });
    this.explosions = this.explosions.filter(e=> now < e.until + 50);

    // particles
    this.stepEffects(dt);

    // sudden death: once the timer runs out, melons start raining on the board
    const elapsed = now - this.startTime;
    if(elapsed >= this.suddenDeathMs){
      if(!this.stormActive){ this.stormActive = true; this.nextStormDrop = now; }
      if(now >= this.nextStormDrop){
        this.nextStormDrop = now + STORM_DROP_MS;
        this.dropStormBomb();
      }
    } else {
      this.stormCountdown = this.suddenDeathMs - elapsed;
    }

    this.checkWinCondition();
  }

  // Drop an unowned bomb on a random open tile. slot -1 means it belongs to
  // nobody, so it never counts against a player's bomb limit.
  dropStormBomb(){
    const open = [];
    for(let y=1;y<ROWS-1;y++){
      for(let x=1;x<COLS-1;x++){
        if(this.grid[y][x]!==TILE_EMPTY) continue;
        if(this.bombs.some(b=>!b.exploded && b.gx===x && b.gy===y)) continue;
        open.push([x,y]);
      }
    }
    if(!open.length) return;
    const [gx,gy] = open[this.randInt(open.length)];
    this.bombs.push({
      id:this.nextBombId++, gx, gy, slot:-1, range:STORM_BOMB_RANGE,
      px: gx*TILE + TILE/2, py: gy*TILE + TILE/2, kickDir:null,
      kickFromGx:gx, kickFromGy:gy,
      placedAt: performance.now(), fuseAt: performance.now()+STORM_FUSE,
      exploded:false, justPlacedBy:-1, storm:true
    });
  }

  // Cosmetic-only updates (particles, scatter glow). Safe to run on clients,
  // which never call tick().
  stepEffects(dt){
    this.particles.forEach(pt=>{ pt.x+=pt.vx*dt; pt.y+=pt.vy*dt; pt.vy+=280*dt; pt.life-=dt; });
    this.particles = this.particles.filter(pt=>pt.life>0);
    this.scatterGlow = this.scatterGlow.filter(g=> performance.now() < g.until);
  }

  movePlayer(p, input, dt){
    let dx=0, dy=0;
    if(input.left){dx=-1; p.dir='left';}
    else if(input.right){dx=1; p.dir='right';}
    else if(input.up){dy=-1; p.dir='up';}
    else if(input.down){dy=1; p.dir='down';}
    p.moving = (dx!==0||dy!==0);
    if(p.moving) p.animT += dt;

    const speed = p.speed * TILE;
    let nx = p.x + dx*speed*dt;
    let ny = p.y + dy*speed*dt;

    // axis-aligned collision against grid, with a little corner forgiveness
    const r = TILE*0.32;
    if(dx!==0){
      const gy = Math.floor(p.y/TILE);
      const targetGx = Math.floor((nx + Math.sign(dx)*r)/TILE);
      if(this.blockedAt(targetGx, gy, p)) nx = p.x;
    }
    if(dy!==0){
      const gx = Math.floor(p.x/TILE);
      const targetGy = Math.floor((ny + Math.sign(dy)*r)/TILE);
      if(this.blockedAt(gx, targetGy, p)) ny = p.y;
    }
    p.x = clamp(nx, TILE, CANVAS_W-TILE);
    p.y = clamp(ny, TILE, CANVAS_H-TILE);
    p.gx = Math.round((p.x-TILE/2)/TILE);
    p.gy = Math.round((p.y-TILE/2)/TILE);

    // powerup pickup (skipped during client-side prediction — the host decides)
    const key = p.gx+','+p.gy;
    if(!this.predicting && this.powerups[key]){
      this.applyPowerup(p, this.powerups[key]);
      delete this.powerups[key];
      this.powerupV++;
    }
  }

  blockedAt(gx,gy,p){
    if(gy<0||gy>=ROWS||gx<0||gx>=COLS) return true;
    const t = this.grid[gy][gx];
    if(t===TILE_WALL||t===TILE_CRATE) return true;
    const bomb = this.bombs.find(b=>!b.exploded && b.gx===gx && b.gy===gy);
    if(bomb){
      // allow standing bomb (the one you just placed under you) to be walked off of,
      // but block walking into an active bomb tile from outside
      if(bomb.justPlacedBy===p.slot && performance.now()-bomb.placedAt < 400) return false;
      return true;
    }
    return false;
  }

  tryPlaceBomb(p){
    const activeCount = this.bombs.filter(b=>b.slot===p.slot && !b.exploded).length;
    if(activeCount >= p.maxBombs) return;
    const gx = p.gx, gy = p.gy;
    if(this.bombs.some(b=>!b.exploded && b.gx===gx && b.gy===gy)) return;
    if(this.grid[gy][gx]!==TILE_EMPTY) return;
    this.bombs.push({
      id:this.nextBombId++, gx, gy, slot:p.slot, range:p.range,
      px: gx*TILE + TILE/2, py: gy*TILE + TILE/2, kickDir:null,
      placedAt: performance.now(), fuseAt: performance.now()+BOMB_FUSE,
      exploded:false, justPlacedBy:p.slot
    });
  }

  // Kick the bomb on the tile the player is facing (requires the kick powerup).
  tryKickBomb(p){
    if(!p.kick) return;
    const d = DIR_VEC[p.dir];
    if(!d) return;
    const tgx = p.gx + d[0], tgy = p.gy + d[1];
    const bomb = this.bombs.find(b=>!b.exploded && !b.kickDir && b.gx===tgx && b.gy===tgy);
    if(!bomb) return;
    // only kick if there's somewhere for it to go
    if(!this.isBombSlideOpen(tgx + d[0], tgy + d[1], bomb)) return;
    bomb.kickDir = p.dir;
    bomb.kickFromGx = tgx;
    bomb.kickFromGy = tgy;
    bomb.px = bomb.gx*TILE + TILE/2;
    bomb.py = bomb.gy*TILE + TILE/2;
  }

  isBombSlideOpen(gx, gy, bomb){
    if(gy<0||gy>=ROWS||gx<0||gx>=COLS) return false;
    if(this.grid[gy][gx] !== TILE_EMPTY) return false;
    if(this.bombs.some(b=>b!==bomb && !b.exploded && b.gx===gx && b.gy===gy)) return false;
    // stop against players so nobody gets trapped inside a bomb
    if(Object.values(this.players).some(p=>p.alive && p.gx===gx && p.gy===gy)) return false;
    return true;
  }

  slideBomb(b, dt){
    const d = DIR_VEC[b.kickDir];
    if(!d){ b.kickDir=null; return; }
    const centerX = b.gx*TILE + TILE/2;
    const centerY = b.gy*TILE + TILE/2;
    const step = KICK_SPEED * TILE * dt;

    const travelled = Math.abs(b.gx - b.kickFromGx) + Math.abs(b.gy - b.kickFromGy);
    const atLimit = travelled >= MAX_KICK_TILES;

    if(atLimit || !this.isBombSlideOpen(b.gx + d[0], b.gy + d[1], b)){
      // out of road (or out of range) — glide to the middle of this tile and stop
      const remaining = d[0]!==0 ? (centerX - b.px)*d[0] : (centerY - b.py)*d[1];
      if(remaining <= step){
        b.px = centerX; b.py = centerY; b.kickDir = null;
      } else {
        b.px += d[0]*step; b.py += d[1]*step;
      }
      return;
    }

    b.px += d[0]*step;
    b.py += d[1]*step;
    b.gx = Math.round((b.px - TILE/2)/TILE);
    b.gy = Math.round((b.py - TILE/2)/TILE);
  }

  explodeBomb(bomb){
    bomb.exploded = true;
    bomb.explodedAt = performance.now();
    bomb.kickDir = null;
    bomb.px = bomb.gx*TILE + TILE/2;
    bomb.py = bomb.gy*TILE + TILE/2;
    this.grid[bomb.gy][bomb.gx] = this.grid[bomb.gy][bomb.gx]; // no-op, tile stays empty
    const until = performance.now() + EXPLOSION_LIFE;
    const cells = [{gx:bomb.gy!==undefined?bomb.gx:0, gy:bomb.gy}];
    this.addExplosionCell(bomb.gx, bomb.gy, until);
    this.spawnBurst(bomb.gx, bomb.gy);

    const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
    dirs.forEach(([dx,dy])=>{
      for(let i=1;i<=bomb.range;i++){
        const gx = bomb.gx+dx*i, gy = bomb.gy+dy*i;
        if(gy<0||gy>=ROWS||gx<0||gx>=COLS) break;
        const t = this.grid[gy][gx];
        if(t===TILE_WALL) break;
        this.addExplosionCell(gx,gy,until);
        this.spawnBurst(gx,gy);
        if(t===TILE_CRATE){
          this.grid[gy][gx] = TILE_EMPTY;
          this.gridDelta.push([gx,gy,TILE_EMPTY]);
          this.maybeDropPowerup(gx,gy);
          break; // crate stops the blast after breaking
        }
        // chain react other bombs
        const chained = this.bombs.find(b=>!b.exploded && b.gx===gx && b.gy===gy);
        if(chained){ chained.fuseAt = performance.now()+1; }
      }
    });

    this.shakeUntil = performance.now()+220;
    this.shakeMag = 6;
  }

  addExplosionCell(gx,gy,until){
    const existing = this.explosions.find(e=>e.gx===gx&&e.gy===gy);
    if(existing){ existing.until = Math.max(existing.until, until); }
    else this.explosions.push({gx,gy,until, start:performance.now()});
  }

  spawnBurst(gx,gy){
    for(let i=0;i<6;i++){
      this.particles.push({
        x: gx*TILE+TILE/2, y: gy*TILE+TILE/2,
        vx: (Math.random()-0.5)*160, vy: -Math.random()*160-40,
        life: 0.4+Math.random()*0.3, color: Math.random()<0.5?'#ff5c7a':'#9ef01a', size: 3+Math.random()*3
      });
    }
  }

  maybeDropPowerup(gx,gy){
    if(this.rand() < 0.32){
      const types=[POWERUP_BOMB,POWERUP_RANGE,POWERUP_SPEED,POWERUP_KICK];
      const type = types[this.randInt(types.length)];
      this.powerups[gx+','+gy] = type;
      this.powerupV++;
    }
  }

  applyPowerup(p, type){
    if(type===POWERUP_BOMB) p.maxBombs = Math.min(p.maxBombs+1, 8);
    if(type===POWERUP_RANGE) p.range = Math.min(p.range+1, 8);
    if(type===POWERUP_SPEED) p.speed = Math.min(p.speed+0.6, 6);
    if(type===POWERUP_KICK) p.kick = true;
  }

  killPlayer(p){
    if(!p.alive) return;
    p.alive = false;
    p.deathAt = performance.now();
    for(let i=0;i<14;i++){
      this.particles.push({
        x:p.x, y:p.y,
        vx:(Math.random()-0.5)*220, vy:-Math.random()*200-60,
        life:0.6+Math.random()*0.4, color: PLAYER_COLORS[p.colorIdx%4].body, size:4+Math.random()*4
      });
    }
    this.scatterPowerups(p);
  }

  // On death, everything the player collected spills back onto the map.
  // Runs only in the authoritative sim (host / local), so the resulting
  // powerups reach clients via the normal state sync.
  scatterPowerups(p){
    const tokens = [];
    for(let i=0;i<p.maxBombs-1;i++) tokens.push(POWERUP_BOMB);
    for(let i=0;i<p.range-1;i++) tokens.push(POWERUP_RANGE);
    const speedLevels = Math.round((p.speed - PLAYER_SPEED_BASE)/0.6);
    for(let i=0;i<speedLevels;i++) tokens.push(POWERUP_SPEED);
    if(p.kick) tokens.push(POWERUP_KICK);
    if(!tokens.length) return;

    // cap the spill so a maxed-out player doesn't carpet the board
    const MAX_SCATTER = 8;
    while(tokens.length > MAX_SCATTER) tokens.splice(this.randInt(tokens.length), 1);

    const dgx = clamp(Math.round((p.x - TILE/2)/TILE), 1, COLS-2);
    const dgy = clamp(Math.round((p.y - TILE/2)/TILE), 1, ROWS-2);
    const spots = this.findScatterTiles(dgx, dgy, tokens.length);

    tokens.forEach((type, i)=>{
      const cell = spots[i];
      if(!cell) return; // board too full — token is simply lost
      this.powerups[cell.gx+','+cell.gy] = type;
      this.powerupV++;
      this.spawnScatterFx(cell.gx, cell.gy);
    });
  }

  // Ring-search outward from the death tile for valid drop spots.
  findScatterTiles(cgx, cgy, count){
    const out = [];
    const seen = new Set();
    const maxR = Math.max(COLS, ROWS);
    for(let r=0; r<=maxR && out.length<count; r++){
      const ring = [];
      for(let dy=-r; dy<=r; dy++){
        for(let dx=-r; dx<=r; dx++){
          if(Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const gx = cgx+dx, gy = cgy+dy;
          const key = gx+','+gy;
          if(seen.has(key)) continue;
          seen.add(key);
          if(this.isScatterTarget(gx,gy)) ring.push({gx,gy});
        }
      }
      // shuffle the ring so drops don't bias to one direction
      for(let i=ring.length-1;i>0;i--){
        const j = this.randInt(i+1);
        const t = ring[i]; ring[i]=ring[j]; ring[j]=t;
      }
      ring.forEach(c=>{ if(out.length<count) out.push(c); });
    }
    return out;
  }

  isScatterTarget(gx,gy){
    if(gy<1||gy>=ROWS-1||gx<1||gx>=COLS-1) return false;
    if(this.grid[gy][gx] !== TILE_EMPTY) return false;
    if(this.powerups[gx+','+gy]) return false;
    if(this.bombs.some(b=>!b.exploded && b.gx===gx && b.gy===gy)) return false;
    return true;
  }

  spawnScatterFx(gx,gy){
    for(let i=0;i<7;i++){
      this.particles.push({
        x: gx*TILE+TILE/2, y: gy*TILE+TILE/2,
        vx:(Math.random()-0.5)*120, vy:-Math.random()*130-30,
        life:0.45+Math.random()*0.3, color:'#ffb703', size:2.5+Math.random()*2.5
      });
    }
    this.scatterGlow.push({gx, gy, until: performance.now()+900});
  }

  checkWinCondition(){
    if(this.matchOver) return;
    const alive = Object.values(this.players).filter(p=>p.alive);
    const totalReal = this.roster.length;
    if(totalReal>1 && alive.length<=1){
      this.matchOver = true;
      this.winnerSlot = alive.length===1 ? alive[0].slot : null;
      this.running=false;
    } else if(totalReal===1 && alive.length===0){
      this.matchOver = true; this.winnerSlot=null; this.running=false;
    }
  }

  // ---- serialize for network broadcast (host->clients) ----
  // Compact snapshot. Two rules matter here:
  //  - never resend data the client can derive or already has (the grid is
  //    generated deterministically from seed+map, so only send tile changes)
  //  - never send absolute timestamps; performance.now() has a different origin
  //    on every machine, so send remaining durations instead
  serializeState(){
    const now = performance.now();
    const state = {
      t: Math.round(now - this.startTime),
      p: Object.values(this.players).map(p=>[
        p.slot, Math.round(p.x), Math.round(p.y),
        (p.alive?1:0) | (p.moving?2:0) | (p.disconnected?4:0) | (p.respawnInvuln>0?8:0),
        DIR_CODE[p.dir]||0, p.maxBombs, p.range, Math.round(p.speed*10), p.kick?1:0
      ]),
      b: this.bombs.map(b=>[
        b.gx, b.gy, Math.round(b.px), Math.round(b.py),
        DIR_CODE[b.kickDir]||0, Math.max(0, Math.round(b.fuseAt-now)),
        b.exploded?1:0, b.slot, b.storm?1:0
      ]),
      e: this.explosions.map(e=>[e.gx, e.gy, Math.max(0, Math.round(e.until-now))]),
      mo: this.matchOver?1:0,
      w: this.winnerSlot,
      sd: this.stormActive ? -1 : Math.max(0, Math.round(this.suddenDeathMs - (now-this.startTime)))
    };
    // tile changes since the last snapshot (usually empty)
    if(this.gridDelta.length){ state.gd = this.gridDelta; this.gridDelta = []; }
    // powerups only when they actually changed
    if(this.powerupV !== this._sentPowerupV){
      state.pu = this.powerups;
      this._sentPowerupV = this.powerupV;
    }
    return state;
  }

  applyHostState(state){
    const now = performance.now();

    state.p.forEach(a=>{
      const p = this.players[a[0]];
      if(!p) return;
      const flags = a[3];
      const hx = a[1], hy = a[2];
      p.alive = !!(flags & 1);
      p.moving = !!(flags & 2);
      p.disconnected = !!(flags & 4);
      // driven by the host — clients don't run tick(), so a locally counted
      // invulnerability timer would never expire and the sprite would blink forever
      p.respawnInvuln = (flags & 8) ? 1 : 0;
      p.dir = DIR_NAME[a[4]] || p.dir;
      p.maxBombs = a[5]; p.range = a[6]; p.speed = a[7]/10; p.kick = !!a[8];

      if(a[0] === myId){
        // our own player is predicted locally — only correct it when the
        // prediction has drifted too far to quietly reconcile
        const err = Math.hypot(p.x-hx, p.y-hy);
        if(err > 46 || !p.alive){ p.x = hx; p.y = hy; }
        else if(err > 1.5){ p.x += (hx-p.x)*0.25; p.y += (hy-p.y)*0.25; }
        p.gx = Math.round((p.x-TILE/2)/TILE);
        p.gy = Math.round((p.y-TILE/2)/TILE);
      } else {
        // remote players are interpolated toward the latest snapshot
        if(p.netX === undefined || Math.hypot(p.x-hx, p.y-hy) > 90){ p.x=hx; p.y=hy; }
        p.netX = hx; p.netY = hy;
      }
    });

    this.bombs = state.b.map(a=>({
      gx:a[0], gy:a[1], px:a[2], py:a[3],
      kickDir: DIR_NAME[a[4]] || null,
      kickFromGx:a[0], kickFromGy:a[1],
      fuseAt: now + a[5],
      exploded: !!a[6], slot:a[7], storm: !!a[8],
      explodedAt: a[6] ? now : undefined
    }));

    this.explosions = state.e.map(a=>({gx:a[0], gy:a[1], until: now + a[2], start:now}));

    if(state.gd) state.gd.forEach(([x,y,v])=>{ if(this.grid[y]) this.grid[y][x]=v; });

    if(state.pu){
      const prev = this.powerups || {};
      Object.keys(state.pu).forEach(key=>{
        if(!prev[key]){
          const [gx,gy] = key.split(',').map(Number);
          this.spawnScatterFx(gx,gy);
        }
      });
      this.powerups = state.pu;
    }

    this.stormActive = state.sd === -1;
    this.stormCountdown = state.sd === -1 ? 0 : state.sd;

    this.scatterGlow = this.scatterGlow.filter(g=> now < g.until);
    this.particles = this.particles.filter(pt=>pt.life>0);
    if(state.mo && !this.matchOver){
      this.matchOver = true; this.winnerSlot = state.w; this.running=false;
    }
    this._elapsedFromHost = state.t;
  }

  // Client-only: run our own movement immediately instead of waiting a full
  // round trip, and smooth everyone else between snapshots.
  clientStep(dt){
    const me = myId!=null ? this.players[myId] : null;
    if(me && me.alive){
      this.predicting = true;
      this.movePlayer(me, localInput, dt);
      this.predicting = false;
    }
    Object.values(this.players).forEach(p=>{
      if(p.slot===myId || p.netX===undefined) return;
      const k = Math.min(1, dt*16);
      p.x += (p.netX - p.x)*k;
      p.y += (p.netY - p.y)*k;
      p.gx = Math.round((p.x-TILE/2)/TILE);
      p.gy = Math.round((p.y-TILE/2)/TILE);
    });
    // keep kicked bombs gliding between snapshots
    this.bombs.forEach(b=>{ if(!b.exploded && b.kickDir) this.slideBomb(b, dt); });
    this.stepEffects(dt);
  }

  applyHostEvent(ev){
    if(ev.type==='burst') this.spawnBurst(ev.gx, ev.gy);
    if(ev.type==='death'){
      const p = this.players[ev.slot];
      if(p) this.killPlayer(p);
    }
    if(ev.type==='shake'){ this.shakeUntil=performance.now()+220; this.shakeMag=6; }
  }
}

// ================================================================
// MATCH LIFECYCLE
// ================================================================
function beginMatch(seed, roster, localOnly, mapIndex, cols, rows){
  const size = (cols && rows) ? [cols, rows] : boardSizeFor(roster.length);
  applyBoardSize(size[0], size[1]);
  // clear any game-over overlay from the previous round, otherwise clients
  // starting a rematch end up with the new match hidden behind it
  const overlay = $('overlay');
  overlay.classList.add('hidden');
  overlay.innerHTML = '';
  overlayShown = false;
  game = new Game(seed, roster, localOnly, mapIndex || 0);
  showScreen('game');
  $('hudMapName').textContent = game.mapName || '';
  renderHudPlayers();
  r3BuildScene();
  // The host's match runs on a timer rather than on animation frames, which stop while the
  // Peiskos window is in the background: the others keep playing when the host looks away.
  if(simTimer) clearInterval(simTimer);
  simTimer = null;
  if(game.localOnly || isHost){
    lastSim = performance.now();
    simTimer = setInterval(hostStep, TICK_MS);
  }
  requestAnimationFrame(gameLoop);
  attachInputHandlers();
  // keys go to the game, not to whatever button started it
  if(document.activeElement && document.activeElement.blur) document.activeElement.blur();
  window.focus();
}

const PERK_DEFS = [
  {key:'maxBombs', icon:'🍉', base:1, label:'bombs'},
  {key:'range',    icon:'💥', base:1, label:'range'},
  {key:'speed',    icon:'⚡', base:PLAYER_SPEED_BASE, label:'speed'},
  {key:'kick',     icon:'🦵', base:false, label:'kick'},
];

function renderHudPlayers(){
  const wrap = $('hudPlayers');
  wrap.innerHTML='';
  game.roster.forEach(rp=>{
    const p = game.players[rp.slot];
    const el = document.createElement('div');
    el.className='hud-player' + (rp.slot===myId ? ' me' : '');
    el.id = 'hudp-'+rp.slot;

    const row1 = document.createElement('div');
    row1.className='row1';
    const dot = document.createElement('div');
    dot.className='dot';
    dot.style.background = PLAYER_COLORS[rp.colorIdx%4].body;
    row1.appendChild(dot);
    const label = document.createElement('span');
    label.textContent = (rp.slot===myId ? 'You' : rp.name);
    row1.appendChild(label);
    el.appendChild(row1);

    const perksRow = document.createElement('div');
    perksRow.className='perks';
    perksRow.id = 'hudperks-'+rp.slot;
    PERK_DEFS.forEach(def=>{
      const pill = document.createElement('span');
      pill.className='perk-pill perk-'+def.key;
      pill.id = 'hudperk-'+rp.slot+'-'+def.key;
      const icon = document.createElement('span');
      icon.className='perk-icon';
      icon.textContent = def.icon;
      pill.appendChild(icon);
      const val = document.createElement('span');
      val.className='perk-val';
      pill.appendChild(val);
      perksRow.appendChild(pill);
    });
    el.appendChild(perksRow);

    wrap.appendChild(el);
  });
}

function updatePerkPills(rp, p){
  PERK_DEFS.forEach(def=>{
    const pill = $('hudperk-'+rp.slot+'-'+def.key);
    if(!pill) return;
    const valEl = pill.querySelector('.perk-val');
    if(def.key==='kick'){
      const on = !!p.kick;
      pill.classList.toggle('perk-off', !on);
      pill.classList.toggle('perk-kick-on', on);
      valEl.textContent = '';
    } else if(def.key==='maxBombs'){
      const upgraded = p.maxBombs > def.base;
      pill.classList.toggle('perk-off', !upgraded);
      valEl.textContent = 'x' + p.maxBombs;
    } else if(def.key==='range'){
      const upgraded = p.range > def.base;
      pill.classList.toggle('perk-off', !upgraded);
      valEl.textContent = 'x' + p.range;
    } else if(def.key==='speed'){
      const upgraded = p.speed > def.base + 0.01;
      pill.classList.toggle('perk-off', !upgraded);
      const lvl = Math.round((p.speed - def.base) / 0.6);
      valEl.textContent = lvl>0 ? '+'+lvl : '';
    }
  });
}

function updateHud(){
  game.roster.forEach(rp=>{
    const p = game.players[rp.slot];
    const el = $('hudp-'+rp.slot);
    if(el){ el.classList.toggle('dead', !p.alive); }
    updatePerkPills(rp, p);
  });
  const elapsed = (game.localOnly||isHost) ? (performance.now()-game.startTime) : (game._elapsedFromHost||0);
  const secs = Math.floor(elapsed/1000);
  $('hudTimer').textContent = `⏱ ${Math.floor(secs/60)}:${(secs%60).toString().padStart(2,'0')}`;

  const stormEl = $('hudStorm');
  if(game.stormActive){
    stormEl.textContent = '🌩 MELON STORM';
    stormEl.classList.add('active');
  } else if(game.suddenDeathMs === Infinity && (game.localOnly || isHost)){
    stormEl.textContent = '';
    stormEl.classList.remove('active');
  } else {
    const left = (game.localOnly||isHost)
      ? Math.max(0, game.suddenDeathMs - elapsed)
      : (game.stormCountdown||0);
    if(left > 0){
      const s = Math.ceil(left/1000);
      stormEl.textContent = `🌩 ${Math.floor(s/60)}:${(s%60).toString().padStart(2,'0')}`;
      stormEl.classList.remove('active');
    } else {
      stormEl.textContent = '';
      stormEl.classList.remove('active');
    }
  }
}

// ---------------------------------------------------------------
// MAIN LOOP
// ---------------------------------------------------------------
let lastFrame = performance.now();
let simTimer = null, lastSim = 0;

// Host only: advance the match and send everyone the board.
function hostStep(){
  if(!game || !(game.localOnly || isHost)){ clearInterval(simTimer); simTimer = null; return; }
  const now = performance.now();
  const dt = Math.min((now-lastSim)/1000, 0.25);
  lastSim = now;
  game.accumulator += dt;
  while(game.accumulator > TICK_MS/1000 && !game.matchOver){
    game.tick(TICK_MS/1000);
    game.accumulator -= TICK_MS/1000;
  }
  if(!game.localOnly){
    game.broadcastAccum += dt*1000;
    // the last board always goes out, so everyone sees how it ended
    if(game.broadcastAccum >= BROADCAST_MS || game.matchOver){
      game.broadcastAccum = 0;
      broadcastToAll({type:'state', state: game.serializeState()});
    }
  }
  if(game.matchOver){
    clearInterval(simTimer); simTimer = null;
    if(!game._scored){
      game._scored = true;
      matchOn = false;
      if(game.winnerSlot !== null && game.winnerSlot !== undefined){
        lobbyScores[game.winnerSlot] = (lobbyScores[game.winnerSlot]||0) + 1;
      }
      if(!game.localOnly){ broadcastToAll({type:'scores', scores:lobbyScores}); broadcastLobby(); }
    }
  }
}

function gameLoop(now){
  if(!game){ return; }
  const dt = Math.min((now-lastFrame)/1000, 0.05);
  lastFrame = now;

  if(!(game.localOnly || isHost)){
    // client: send local input to host each frame (throttled)
    sendInputToHostThrottled();
    // clients predict their own movement and interpolate everyone else
    game.clientStep(dt);
  }

  render();
  updateHud();

  if(game.matchOver){
    renderGameOverOverlay();
  } else {
    requestAnimationFrame(gameLoop);
  }
}

let lastInputSend = 0;
let lastInputSent = '';
function sendInputToHostThrottled(){
  const now = performance.now();
  if(!hostConn || !hostConn.open) return;
  // send the moment the input changes; otherwise a light heartbeat
  const sig = (localInput.up?1:0)+''+(localInput.down?1:0)+(localInput.left?1:0)
            + (localInput.right?1:0)+(localInput.bomb?1:0)+(localInput.kick?1:0);
  const changed = sig !== lastInputSent;
  if(!changed && now-lastInputSend < 120) return;
  lastInputSend = now;
  lastInputSent = sig;
  try{ hostConn.send({type:'input', slot:myId, input:{...localInput}}); }catch(e){}
}

// ================================================================
// RENDERING — Three.js
// The simulation stays grid-based and 2D; this layer only draws it.
// World units: 1 tile = 1 unit. Sim pixel coords convert via /TILE.
// ================================================================
const R3 = {
  ready:false, scene:null, camera:null, renderer:null,
  walls:null, crates:{}, players:{}, bombs:{}, powerups:{},
  explosions:[], sparks:null, sparkData:[],
  geo:{}, mat:{}, tex:{}, boardKey:''
};

// sim pixel space -> world space
function wx(px){ return px/TILE - COLS/2; }
function wz(py){ return py/TILE - ROWS/2; }

function r3Init(){
  if(R3.renderer) return;
  R3.renderer = new THREE.WebGLRenderer({canvas, antialias:true, alpha:false});
  R3.renderer.setPixelRatio(Math.min(window.devicePixelRatio||1, 2));
  R3.renderer.shadowMap.enabled = true;
  R3.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // correct colour pipeline — without these, PBR materials look flat and muddy
  if(THREE.sRGBEncoding !== undefined) R3.renderer.outputEncoding = THREE.sRGBEncoding;
  if(THREE.ACESFilmicToneMapping !== undefined){
    R3.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    R3.renderer.toneMappingExposure = 1.15;
  }

  // shared geometry/materials, created once
  R3.geo.box    = new THREE.BoxGeometry(1,1,1);
  R3.geo.crate  = new THREE.BoxGeometry(0.9,0.9,0.9);
  R3.geo.body   = new THREE.SphereGeometry(0.34, 28, 22);
  R3.geo.bomb   = new THREE.SphereGeometry(0.32, 24, 18);
  R3.geo.eye    = new THREE.SphereGeometry(0.055, 10, 10);
  R3.geo.seed   = new THREE.SphereGeometry(0.038, 8, 8);
  R3.geo.blast  = new THREE.SphereGeometry(0.5, 18, 14);
  R3.geo.pu     = new THREE.OctahedronGeometry(0.25);
  R3.geo.tile   = new THREE.PlaneGeometry(1, 1);
  R3.geo.ring   = new THREE.RingGeometry(0.30, 0.44, 28);
  R3.geo.shock  = new THREE.RingGeometry(0.30, 0.50, 32);

  const Std = THREE.MeshStandardMaterial || THREE.MeshLambertMaterial;
  const std = (o)=> new Std(o);

  // Near-top-down means the TOP face of everything is what players actually
  // read, so walls and crates get a distinct lighter cap.
  r3WorldTextures();
  R3.mat.wallSide = std({map:R3.tex.stoneSide, roughness:0.92, metalness:0.02});
  R3.mat.wallTop  = std({map:R3.tex.stoneTop,  roughness:0.85, metalness:0.03});
  R3.mat.crateSide= std({map:R3.tex.crateSide, roughness:0.88, metalness:0.0});
  R3.mat.crateTop = std({map:R3.tex.crateTop,  roughness:0.85, metalness:0.0});
  R3.mat.floorA   = std({map:R3.tex.grassA,    roughness:0.98, metalness:0.0});
  R3.mat.floorB   = std({map:R3.tex.grassB,    roughness:0.98, metalness:0.0});
  R3.mat.plinth   = std({color:0x2a1d10, roughness:0.9, metalness:0.02});
  R3.mat.dark     = new THREE.MeshBasicMaterial({color:0x140d0b});
  R3.mat.bomb     = std({color:0x7fbe19, roughness:0.45, metalness:0.1});
  R3.mat.blast    = new THREE.MeshBasicMaterial({
    color:0xffb37a, transparent:true, opacity:0.85,
    blending: THREE.AdditiveBlending !== undefined ? THREE.AdditiveBlending : undefined,
    depthWrite:false
  });
  R3.mat.shock    = new THREE.MeshBasicMaterial({
    color:0xffe3a3, transparent:true, opacity:0.8, side:THREE.DoubleSide, depthWrite:false
  });

  // per-face arrays: BoxGeometry order is [px, nx, py(top), ny, pz, nz]
  R3.mat.wallFaces  = [R3.mat.wallSide, R3.mat.wallSide, R3.mat.wallTop,
                       R3.mat.wallSide, R3.mat.wallSide, R3.mat.wallSide];
  R3.mat.crateFaces = [R3.mat.crateSide, R3.mat.crateSide, R3.mat.crateTop,
                       R3.mat.crateSide, R3.mat.crateSide, R3.mat.crateSide];
}

function r3Dispose(){
  if(!R3.scene) return;
  R3.scene.traverse(o=>{
    if(o.isMesh && o.geometry && !Object.values(R3.geo).includes(o.geometry)) o.geometry.dispose();
  });
  R3.scene = null;
  R3.walls = null;
  R3.crates = {}; R3.players = {}; R3.bombs = {}; R3.powerups = {};
  R3.explosions = []; R3.sparks = null; R3.sparkData = [];
}

// Build the static board + actors for a fresh match.
function r3BuildScene(){
  r3Init();
  r3EntityTextures();
  r3Dispose();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x121a2a);
  // no fog: with an orthographic camera there's no depth falloff to reinforce,
  // and it would just wash out the board edges
  R3.scene = scene;

  // lighting — hemisphere gives a soft sky/ground gradient, key light does shape
  const hemi = new THREE.HemisphereLight(0xcfe4ff, 0x2f4a22, 0.58);
  scene.add(hemi);
  scene.add(new THREE.AmbientLight(0xffffff, 0.18));
  const key = new THREE.DirectionalLight(0xfff1d6, 1.25);
  key.position.set(COLS*0.42, Math.max(COLS,ROWS)*1.15, ROWS*0.34);
  key.castShadow = true;
  key.shadow.mapSize.width = 2048;
  key.shadow.mapSize.height = 2048;
  key.shadow.bias = -0.0006;
  key.shadow.normalBias = 0.02;
  const span = Math.max(COLS,ROWS)*0.75;
  key.shadow.camera.left = -span; key.shadow.camera.right = span;
  key.shadow.camera.top = span;   key.shadow.camera.bottom = -span;
  key.shadow.camera.near = 0.5;   key.shadow.camera.far = Math.max(COLS,ROWS)*3.5;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x9ef01a, 0.35);
  rim.position.set(-COLS*0.45, 4.5, -ROWS*0.5);
  scene.add(rim);

  // plinth: the board sits on a solid slab so it reads as a diorama from above
  const plinth = new THREE.Mesh(new THREE.BoxGeometry(COLS+0.7, 0.6, ROWS+0.7), R3.mat.plinth);
  plinth.position.y = -0.31;
  plinth.receiveShadow = true;
  scene.add(plinth);

  // checkerboard floor tiles (replaces the old flat plane + grid helper)
  for(let y=0;y<ROWS;y++){
    for(let x=0;x<COLS;x++){
      const t = new THREE.Mesh(R3.geo.tile, (x+y)%2 ? R3.mat.floorA : R3.mat.floorB);
      t.rotation.x = -Math.PI/2;
      t.position.set(x-COLS/2+0.5, 0.001, y-ROWS/2+0.5);
      t.receiveShadow = true;
      scene.add(t);
    }
  }

  // walls with a lighter top cap
  const wallGroup = new THREE.Group();
  for(let y=0;y<ROWS;y++){
    for(let x=0;x<COLS;x++){
      if(game.grid[y][x] !== TILE_WALL) continue;
      const m = new THREE.Mesh(R3.geo.box, R3.mat.wallFaces);
      m.position.set(x - COLS/2 + 0.5, 0.5, y - ROWS/2 + 0.5);
      m.castShadow = true; m.receiveShadow = true;
      wallGroup.add(m);
    }
  }
  scene.add(wallGroup);
  R3.walls = wallGroup;

  // crates
  for(let y=0;y<ROWS;y++){
    for(let x=0;x<COLS;x++){
      if(game.grid[y][x] !== TILE_CRATE) continue;
      r3AddCrate(x,y);
    }
  }

  // players
  game.roster.forEach(rp=>{
    const p = game.players[rp.slot];
    if(!p) return;
    R3.players[rp.slot] = r3MakePlayer(rp, p);
    scene.add(R3.players[rp.slot].group);
  });

  // spark particle cloud
  const sparkGeo = new THREE.BufferGeometry();
  const MAXSPARK = 400;
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAXSPARK*3), 3));
  sparkGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAXSPARK*3), 3));
  const sparkMat = new THREE.PointsMaterial({size:0.16, vertexColors:true, transparent:true, opacity:0.95});
  R3.sparks = new THREE.Points(sparkGeo, sparkMat);
  R3.sparks.frustumCulled = false;
  scene.add(R3.sparks);

  // camera
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 300);
  R3.camera = cam;
  r3PlaceCamera(0,0);

  R3.renderer.setSize(CANVAS_W, CANVAS_H, false);
  r3PlaceCamera(0,0);
  R3.ready = true;
}

// Camera framing — 2.5D: an orthographic projection at a fixed tilt.
// No perspective divide, so every tile is the same size and shape wherever it
// sits on the board, and walls stay axis-aligned instead of leaning outward.
const CAM_TILT_DEG = 80;   // 90 = straight down
const CAM_MARGIN = 1.10;

function r3PlaceCamera(shakeX, shakeZ){
  const cam = R3.camera;
  if(!cam) return;
  const t = CAM_TILT_DEG*Math.PI/180;

  // Board footprint as seen down the camera axis. The board's depth (ROWS)
  // foreshortens by sin(tilt); tall pieces add a little on top of that.
  const WALL_H = 1;
  let halfW = (COLS/2) * CAM_MARGIN;
  let halfH = ((ROWS*Math.sin(t) + WALL_H*Math.cos(t))/2) * CAM_MARGIN;

  // grow the smaller axis so the frustum matches the canvas aspect
  const aspect = CANVAS_W/CANVAS_H;
  if(halfW/halfH < aspect) halfW = halfH*aspect;
  else halfH = halfW/aspect;

  cam.left = -halfW; cam.right = halfW;
  cam.top  =  halfH; cam.bottom = -halfH;

  // In an orthographic view the distance doesn't affect scale, only clipping —
  // so sit well back and use a generous far plane.
  const dist = Math.max(COLS, ROWS) * 2.2;
  cam.position.set(
    (shakeX||0),
    dist*Math.sin(t),
    dist*Math.cos(t) + (shakeZ||0)
  );
  cam.lookAt(0,0,0);
  cam.near = 0.1;
  cam.far  = dist*3;
  cam.updateProjectionMatrix();
  R3._camDist = dist;
  R3._halfW = halfW; R3._halfH = halfH;
}

function r3AddCrate(x,y){
  const m = new THREE.Mesh(R3.geo.crate, R3.mat.crateFaces);
  m.position.set(x - COLS/2 + 0.5, 0.45, y - ROWS/2 + 0.5);
  m.castShadow = true; m.receiveShadow = true;
  R3.scene.add(m);
  R3.crates[x+','+y] = m;
}

// ---------------- sprite plumbing ----------------
// All actors are flat billboards. Their art is drawn procedurally onto
// offscreen canvases at load, then uploaded once as textures — no image files.
const SPR = 160;   // texture resolution per sprite

function makeCanvas(size){
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  return c;
}
function canvasTexture(drawFn, size){
  const c = makeCanvas(size||SPR);
  const g = c.getContext('2d');
  drawFn(g, c.width);
  const tex = new THREE.CanvasTexture(c);
  if(THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
  tex.needsUpdate = true;
  return tex;
}
function spriteFrom(tex, w, h){
  const mat = new THREE.SpriteMaterial({map:tex, transparent:true, depthWrite:false});
  const s = new THREE.Sprite(mat);
  s.scale.set(w, h||w, 1);
  return s;
}

// ---------------- hats (2D art) ----------------
// Each hat draws into the sprite canvas above the melon's head.
// cx/cy is the crown of the head; r is the head radius.
const HATS = [
  { id:'none', name:'No hat', draw:()=>{} },

  { id:'top', name:'Top hat', draw:(g,cx,cy,r)=>{
      g.fillStyle='#141014';
      g.fillRect(cx-r*0.95, cy-r*0.10, r*1.9, r*0.16);          // brim
      g.fillRect(cx-r*0.58, cy-r*0.92, r*1.16, r*0.84);          // crown
      g.fillStyle='#ff5c7a';
      g.fillRect(cx-r*0.58, cy-r*0.34, r*1.16, r*0.20);          // band
    }},

  { id:'crown', name:'Crown', draw:(g,cx,cy,r)=>{
      g.fillStyle='#ffb703';
      g.beginPath();
      g.moveTo(cx-r*0.78, cy+r*0.06);
      g.lineTo(cx-r*0.78, cy-r*0.42);
      for(let i=0;i<4;i++){
        const x0=cx-r*0.78+(i*r*1.56/4), x1=x0+r*1.56/8, x2=x0+r*1.56/4;
        g.lineTo(x1, cy-r*0.92);
        g.lineTo(x2, cy-r*0.42);
      }
      g.lineTo(cx+r*0.78, cy+r*0.06);
      g.closePath(); g.fill();
      g.fillStyle='#e8890a';
      g.fillRect(cx-r*0.78, cy-r*0.16, r*1.56, r*0.20);
    }},

  { id:'cap', name:'Ball cap', draw:(g,cx,cy,r,col)=>{
      g.fillStyle=col;
      g.beginPath(); g.arc(cx, cy, r*0.80, Math.PI, 0); g.fill();
      g.fillRect(cx-r*0.80, cy-r*0.04, r*1.6, r*0.16);
      g.beginPath();
      g.ellipse(cx, cy+r*0.06, r*1.05, r*0.20, 0, 0, Math.PI);   // brim
      g.fill();
      g.fillStyle='rgba(0,0,0,0.22)';
      g.beginPath(); g.ellipse(cx, cy+r*0.06, r*1.05, r*0.20, 0, 0, Math.PI); g.fill();
    }},

  { id:'cowboy', name:'Cowboy hat', draw:(g,cx,cy,r)=>{
      g.fillStyle='#8a5a28';
      g.beginPath(); g.ellipse(cx, cy, r*1.18, r*0.26, 0, 0, Math.PI*2); g.fill();
      g.beginPath();
      g.moveTo(cx-r*0.52, cy);
      g.quadraticCurveTo(cx-r*0.44, cy-r*0.92, cx, cy-r*0.86);
      g.quadraticCurveTo(cx+r*0.44, cy-r*0.92, cx+r*0.52, cy);
      g.closePath(); g.fill();
      g.fillStyle='#3d2510';
      g.fillRect(cx-r*0.52, cy-r*0.26, r*1.04, r*0.18);
    }},

  { id:'party', name:'Party hat', draw:(g,cx,cy,r)=>{
      g.fillStyle='#ff5c7a';
      g.beginPath();
      g.moveTo(cx, cy-r*1.20);
      g.lineTo(cx-r*0.52, cy+r*0.08);
      g.lineTo(cx+r*0.52, cy+r*0.08);
      g.closePath(); g.fill();
      g.fillStyle='#9ef01a';
      g.beginPath(); g.arc(cx, cy-r*1.22, r*0.20, 0, Math.PI*2); g.fill();
      g.fillStyle='#ffe9b8';
      for(let i=0;i<3;i++){
        g.beginPath(); g.arc(cx-r*0.18+i*r*0.18, cy-r*0.30-i*r*0.22, r*0.09, 0, Math.PI*2); g.fill();
      }
    }},

  { id:'chef', name:'Chef hat', draw:(g,cx,cy,r)=>{
      g.fillStyle='#fffaf2';
      g.fillRect(cx-r*0.60, cy-r*0.34, r*1.2, r*0.42);
      g.beginPath(); g.arc(cx-r*0.36, cy-r*0.62, r*0.40, 0, Math.PI*2); g.fill();
      g.beginPath(); g.arc(cx+r*0.36, cy-r*0.62, r*0.40, 0, Math.PI*2); g.fill();
      g.beginPath(); g.arc(cx, cy-r*0.84, r*0.46, 0, Math.PI*2); g.fill();
      g.strokeStyle='rgba(0,0,0,0.15)'; g.lineWidth=r*0.05;
      g.strokeRect(cx-r*0.60, cy-r*0.34, r*1.2, r*0.42);
    }},

  { id:'halo', name:'Halo', draw:(g,cx,cy,r)=>{
      g.strokeStyle='#ffe08a'; g.lineWidth=r*0.16;
      g.beginPath(); g.ellipse(cx, cy-r*0.60, r*0.62, r*0.22, 0, 0, Math.PI*2); g.stroke();
      g.strokeStyle='rgba(255,240,170,0.45)'; g.lineWidth=r*0.30;
      g.beginPath(); g.ellipse(cx, cy-r*0.60, r*0.62, r*0.22, 0, 0, Math.PI*2); g.stroke();
    }},

  { id:'propeller', name:'Propeller cap', draw:(g,cx,cy,r,col)=>{
      g.fillStyle=col;
      g.beginPath(); g.arc(cx, cy, r*0.74, Math.PI, 0); g.fill();
      g.fillRect(cx-r*0.74, cy-r*0.04, r*1.48, r*0.14);
      g.strokeStyle='#141014'; g.lineWidth=r*0.09;
      g.beginPath(); g.moveTo(cx, cy-r*0.72); g.lineTo(cx, cy-r*1.02); g.stroke();
      g.fillStyle='#ffb703';
      g.beginPath(); g.ellipse(cx, cy-r*1.06, r*0.80, r*0.11, 0, 0, Math.PI*2); g.fill();
      g.fillStyle='#e8890a';
      g.beginPath(); g.arc(cx, cy-r*1.06, r*0.11, 0, Math.PI*2); g.fill();
    }},
];
function hatById(id){ return HATS.find(h=>h.id===id) || HATS[0]; }

// ---------------- melon character art ----------------
// dir picks the facing; frame 0/1 is the walk bob.
function drawMelon(g, size, col, dir, frame, hatId){
  g.clearRect(0,0,size,size);
  const r  = size*0.30;
  const cx = size/2;
  const cy = size*0.60 - (frame? size*0.03 : 0);

  // soft contact shadow baked under the body
  g.fillStyle='rgba(0,0,0,0.28)';
  g.beginPath(); g.ellipse(cx, size*0.90, r*0.80, r*0.24, 0, 0, Math.PI*2); g.fill();

  // body
  const grad = g.createRadialGradient(cx-r*0.35, cy-r*0.40, r*0.12, cx, cy, r);
  grad.addColorStop(0, col.light);
  grad.addColorStop(0.55, col.body);
  grad.addColorStop(1, col.dark);
  g.fillStyle = grad;
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI*2); g.fill();

  // rind band around the lower half
  g.strokeStyle = '#0e3b1f';
  g.lineWidth = r*0.26;
  g.beginPath(); g.arc(cx, cy, r*0.90, 0.16*Math.PI, 0.84*Math.PI); g.stroke();

  // seeds
  g.fillStyle = '#140d0b';
  [[-0.34,-0.10],[0.34,-0.10],[0,0.20],[-0.52,0.22],[0.52,0.22]].forEach(([sx,sy])=>{
    g.save();
    g.translate(cx+sx*r, cy+sy*r);
    g.rotate(0.4);
    g.beginPath(); g.ellipse(0,0, r*0.09, r*0.15, 0, 0, Math.PI*2); g.fill();
    g.restore();
  });

  // face — facing away hides the eyes
  if(dir !== 'up'){
    let ox = 0;
    if(dir==='left')  ox = -r*0.26;
    if(dir==='right') ox =  r*0.26;
    g.fillStyle = '#140d0b';
    const eR = r*0.13;
    g.beginPath(); g.arc(cx+ox-r*0.28, cy-r*0.24, eR, 0, Math.PI*2); g.fill();
    g.beginPath(); g.arc(cx+ox+r*0.28, cy-r*0.24, eR, 0, Math.PI*2); g.fill();
    g.fillStyle = '#fffaf2';
    g.beginPath(); g.arc(cx+ox-r*0.24, cy-r*0.29, eR*0.36, 0, Math.PI*2); g.fill();
    g.beginPath(); g.arc(cx+ox+r*0.32, cy-r*0.29, eR*0.36, 0, Math.PI*2); g.fill();
  }

  // hat sits on the crown
  const hat = hatById(hatId);
  if(hat && hat.draw) hat.draw(g, cx, cy - r*0.92, r, col.body);
}

function r3MakePlayer(rp, p){
  const col = PLAYER_COLORS[rp.colorIdx%4];
  const dirs = ['down','up','left','right'];
  const tex = {};
  dirs.forEach(d=>{
    tex[d] = [0,1].map(f=> canvasTexture(g=> drawMelon(g, SPR, col, d, f, rp.hat), SPR));
  });

  const sprite = spriteFrom(tex.down[0], 1.30, 1.30);
  sprite.position.y = 0.62;

  const group = new THREE.Group();
  group.add(sprite);

  // round blob shadow keeps the billboard anchored to its tile
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.34, 20),
    new THREE.MeshBasicMaterial({color:0x000000, transparent:true, opacity:0.30, depthWrite:false})
  );
  shadow.rotation.x = -Math.PI/2;
  shadow.position.y = 0.02;
  group.add(shadow);

  return {group, sprite, shadow, tex, curDir:'down', curFrame:0, hatId:rp.hat};
}

// ---------------- world surface textures ----------------
// Drawn procedurally so walls read as masonry, crates as planked boxes, and
// the floor as grass — no external image files.

// small deterministic PRNG so textures look the same every run
function texRand(seedObj){
  seedObj.s = (seedObj.s * 1664525 + 1013904223) >>> 0;
  return seedObj.s / 4294967296;
}

function drawStoneSide(g, size){
  const R = {s: 20240};
  g.fillStyle = '#2b3540';                 // mortar
  g.fillRect(0,0,size,size);

  const rows = 4, bh = size/rows;
  for(let r=0; r<rows; r++){
    const offset = (r%2) ? -size/6 : 0;    // running bond
    const cols = 3;
    const bw = size/cols;
    for(let c=-1; c<=cols; c++){
      const x = c*bw + offset + size*0.02;
      const y = r*bh + size*0.02;
      const w = bw - size*0.04;
      const h = bh - size*0.04;
      const v = 0.82 + texRand(R)*0.30;
      const base = [Math.round(96*v), Math.round(112*v), Math.round(104*v)];
      g.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`;
      g.fillRect(x, y, w, h);
      // bevel: lit top-left, shaded bottom-right
      g.fillStyle = 'rgba(255,255,255,0.20)';
      g.fillRect(x, y, w, h*0.16);
      g.fillRect(x, y, w*0.07, h);
      g.fillStyle = 'rgba(0,0,0,0.30)';
      g.fillRect(x, y+h*0.84, w, h*0.16);
      g.fillRect(x+w*0.93, y, w*0.07, h);
      // speckle
      for(let i=0;i<7;i++){
        g.fillStyle = texRand(R)>0.5 ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.14)';
        const px = x + texRand(R)*w, py = y + texRand(R)*h;
        g.fillRect(px, py, size*0.015, size*0.015);
      }
    }
  }
  // moss creeping up from the base, ties the stone to the grass floor
  g.fillStyle = 'rgba(90,150,60,0.30)';
  for(let i=0;i<26;i++){
    const px = texRand(R)*size;
    const h  = size*(0.05 + texRand(R)*0.16);
    g.fillRect(px, size-h, size*0.035, h);
  }
}

function drawStoneTop(g, size){
  const R = {s: 777};
  g.fillStyle = '#8fa096';
  g.fillRect(0,0,size,size);
  // single capstone slab with a bevelled rim
  g.fillStyle = '#9fb0a4';
  g.fillRect(size*0.04, size*0.04, size*0.92, size*0.92);
  g.fillStyle = 'rgba(255,255,255,0.28)';
  g.fillRect(size*0.04, size*0.04, size*0.92, size*0.08);
  g.fillRect(size*0.04, size*0.04, size*0.08, size*0.92);
  g.fillStyle = 'rgba(0,0,0,0.26)';
  g.fillRect(size*0.04, size*0.88, size*0.92, size*0.08);
  g.fillRect(size*0.88, size*0.04, size*0.08, size*0.92);
  // weathering
  for(let i=0;i<60;i++){
    g.fillStyle = texRand(R)>0.5 ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.11)';
    g.fillRect(texRand(R)*size, texRand(R)*size, size*0.03, size*0.03);
  }
  // a couple of cracks
  g.strokeStyle = 'rgba(0,0,0,0.22)';
  g.lineWidth = size*0.012;
  for(let i=0;i<2;i++){
    g.beginPath();
    let x = size*0.2 + texRand(R)*size*0.6, y = size*0.1;
    g.moveTo(x,y);
    for(let k=0;k<4;k++){ x += (texRand(R)-0.5)*size*0.2; y += size*0.2; g.lineTo(x,y); }
    g.stroke();
  }
}

function drawCrateSide(g, size){
  const R = {s: 991};
  // planks
  g.fillStyle = '#8a5a2b';
  g.fillRect(0,0,size,size);
  const planks = 4, pw = size/planks;
  for(let i=0;i<planks;i++){
    const v = 0.88 + texRand(R)*0.24;
    g.fillStyle = `rgb(${Math.round(186*v)},${Math.round(126*v)},${Math.round(62*v)})`;
    g.fillRect(i*pw + size*0.012, 0, pw - size*0.024, size);
    // grain
    g.strokeStyle = 'rgba(90,55,20,0.30)';
    g.lineWidth = size*0.008;
    for(let k=0;k<3;k++){
      const gx = i*pw + pw*(0.25+0.25*k);
      g.beginPath();
      g.moveTo(gx, size*0.05);
      g.bezierCurveTo(gx+size*0.02, size*0.35, gx-size*0.02, size*0.65, gx, size*0.95);
      g.stroke();
    }
    // plank shading
    g.fillStyle='rgba(255,255,255,0.12)';
    g.fillRect(i*pw + size*0.012, 0, pw*0.16, size);
    g.fillStyle='rgba(0,0,0,0.20)';
    g.fillRect(i*pw + pw - size*0.024 - pw*0.14, 0, pw*0.14, size);
  }
  // frame rails top and bottom
  g.fillStyle = '#6d431f';
  g.fillRect(0, 0, size, size*0.15);
  g.fillRect(0, size*0.85, size, size*0.15);
  g.fillStyle = 'rgba(255,255,255,0.16)';
  g.fillRect(0, 0, size, size*0.035);
  g.fillRect(0, size*0.85, size, size*0.03);
  g.fillStyle = 'rgba(0,0,0,0.24)';
  g.fillRect(0, size*0.115, size, size*0.035);
  g.fillRect(0, size*0.965, size, size*0.035);
  // nails
  g.fillStyle = '#3a2410';
  [[0.10,0.075],[0.90,0.075],[0.10,0.925],[0.90,0.925]].forEach(([nx,ny])=>{
    g.beginPath(); g.arc(size*nx, size*ny, size*0.022, 0, Math.PI*2); g.fill();
  });
  // outer edge darkening so cubes read as separate boxes
  g.strokeStyle = 'rgba(0,0,0,0.45)';
  g.lineWidth = size*0.05;
  g.strokeRect(size*0.025, size*0.025, size*0.95, size*0.95);
}

function drawCrateTop(g, size){
  const R = {s: 5150};
  g.fillStyle = '#a8702f';
  g.fillRect(0,0,size,size);
  // planks running the other way from the sides
  const planks = 4, ph = size/planks;
  for(let i=0;i<planks;i++){
    const v = 0.9 + texRand(R)*0.22;
    g.fillStyle = `rgb(${Math.round(214*v)},${Math.round(156*v)},${Math.round(88*v)})`;
    g.fillRect(0, i*ph + size*0.014, size, ph - size*0.028);
    g.strokeStyle = 'rgba(110,68,26,0.28)';
    g.lineWidth = size*0.007;
    for(let k=0;k<2;k++){
      const gy = i*ph + ph*(0.35+0.3*k);
      g.beginPath();
      g.moveTo(size*0.05, gy);
      g.bezierCurveTo(size*0.35, gy+size*0.015, size*0.65, gy-size*0.015, size*0.95, gy);
      g.stroke();
    }
    g.fillStyle='rgba(255,255,255,0.14)';
    g.fillRect(0, i*ph + size*0.014, size, ph*0.14);
    g.fillStyle='rgba(0,0,0,0.16)';
    g.fillRect(0, i*ph + ph - size*0.028 - ph*0.12, size, ph*0.12);
  }
  // frame border
  g.strokeStyle = '#6d431f';
  g.lineWidth = size*0.09;
  g.strokeRect(size*0.045, size*0.045, size*0.91, size*0.91);
  g.strokeStyle = 'rgba(255,255,255,0.16)';
  g.lineWidth = size*0.02;
  g.strokeRect(size*0.045, size*0.045, size*0.91, size*0.91);
  // nails in the corners
  g.fillStyle = '#3a2410';
  [[0.10,0.10],[0.90,0.10],[0.10,0.90],[0.90,0.90]].forEach(([nx,ny])=>{
    g.beginPath(); g.arc(size*nx, size*ny, size*0.026, 0, Math.PI*2); g.fill();
  });
  // melon stamp so it still reads as a melon crate
  g.fillStyle = 'rgba(255,92,122,0.85)';
  g.beginPath(); g.arc(size*0.5, size*0.5, size*0.12, 0, Math.PI*2); g.fill();
  g.strokeStyle = 'rgba(14,59,31,0.9)';
  g.lineWidth = size*0.022;
  g.beginPath(); g.arc(size*0.5, size*0.5, size*0.12, 0, Math.PI*2); g.stroke();
}

function drawGrass(g, size, light){
  const R = {s: light ? 4242 : 8484};
  const base  = light ? [88,168,66]  : [46,110,44];
  const blade = light ? [116,200,84] : [66,140,58];
  const dark  = light ? [64,132,50]  : [32,84,34];
  g.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`;
  g.fillRect(0,0,size,size);
  // mottling
  for(let i=0;i<90;i++){
    const v = texRand(R);
    const c = v>0.5 ? blade : dark;
    g.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${0.20+texRand(R)*0.25})`;
    const w = size*(0.05+texRand(R)*0.14);
    g.fillRect(texRand(R)*size, texRand(R)*size, w, size*0.035);
  }
  // blades
  g.lineWidth = size*0.012;
  for(let i=0;i<50;i++){
    const c = texRand(R)>0.45 ? blade : dark;
    g.strokeStyle = `rgba(${c[0]},${c[1]},${c[2]},0.55)`;
    const x = texRand(R)*size, y = texRand(R)*size;
    const h = size*(0.03+texRand(R)*0.06);
    g.beginPath();
    g.moveTo(x, y);
    g.quadraticCurveTo(x + (texRand(R)-0.5)*size*0.03, y-h*0.6, x + (texRand(R)-0.5)*size*0.05, y-h);
    g.stroke();
  }
  // subtle inner edge so the checker grid stays legible
  g.strokeStyle = 'rgba(0,0,0,0.10)';
  g.lineWidth = size*0.02;
  g.strokeRect(0,0,size,size);
}

function r3WorldTextures(){
  if(R3.tex.stoneSide) return;
  R3.tex.stoneSide = canvasTexture(g=>drawStoneSide(g,256), 256);
  R3.tex.stoneTop  = canvasTexture(g=>drawStoneTop(g,256), 256);
  R3.tex.crateSide = canvasTexture(g=>drawCrateSide(g,256), 256);
  R3.tex.crateTop  = canvasTexture(g=>drawCrateTop(g,256), 256);
  R3.tex.grassA    = canvasTexture(g=>drawGrass(g,192,true), 192);
  R3.tex.grassB    = canvasTexture(g=>drawGrass(g,192,false), 192);
}

// ---------------- entity sprite art ----------------
function drawBombSprite(g, size, hot, storm){
  g.clearRect(0,0,size,size);
  const r = size*0.30, cx = size/2, cy = size*0.58;
  g.fillStyle='rgba(0,0,0,0.28)';
  g.beginPath(); g.ellipse(cx, size*0.86, r*0.78, r*0.22, 0, 0, Math.PI*2); g.fill();

  const grad = g.createRadialGradient(cx-r*0.35, cy-r*0.40, r*0.10, cx, cy, r);
  if(hot){ grad.addColorStop(0,'#fff3e0'); grad.addColorStop(0.5,'#ff8fa3'); grad.addColorStop(1,'#c9264a'); }
  else if(storm){ grad.addColorStop(0,'#ffe08a'); grad.addColorStop(0.55,'#ffb703'); grad.addColorStop(1,'#a86f00'); }
  else { grad.addColorStop(0,'#c8f06a'); grad.addColorStop(0.6,'#8fce1f'); grad.addColorStop(1,'#4f7d0c'); }
  g.fillStyle=grad;
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI*2); g.fill();

  // melon stripes
  g.strokeStyle = hot ? 'rgba(120,10,30,0.55)' : 'rgba(30,60,8,0.5)';
  g.lineWidth = r*0.13;
  for(let i=-1;i<=1;i++){
    g.beginPath();
    g.moveTo(cx+i*r*0.46, cy-r*0.92);
    g.quadraticCurveTo(cx+i*r*0.66, cy, cx+i*r*0.46, cy+r*0.92);
    g.stroke();
  }
  // stem + spark
  g.strokeStyle = hot ? '#ff5c7a' : '#5a3a20';
  g.lineWidth = r*0.14;
  g.beginPath(); g.moveTo(cx, cy-r); g.quadraticCurveTo(cx+r*0.30, cy-r*1.30, cx+r*0.12, cy-r*1.52); g.stroke();
  g.fillStyle = hot ? '#fff3e0' : '#ffb703';
  g.beginPath(); g.arc(cx+r*0.12, cy-r*1.56, r*(hot?0.26:0.16), 0, Math.PI*2); g.fill();
}

function drawPowerupSprite(g, size, type){
  g.clearRect(0,0,size,size);
  const cx=size/2, cy=size*0.54, r=size*0.26;
  const COLORS={bomb:'#9ef01a', range:'#ff5c7a', speed:'#ffb703', kick:'#7fd8be'};
  const c = COLORS[type]||'#ffffff';
  // glow
  const glow=g.createRadialGradient(cx,cy,r*0.2,cx,cy,r*1.7);
  glow.addColorStop(0, c); glow.addColorStop(1, 'rgba(0,0,0,0)');
  g.globalAlpha=0.45; g.fillStyle=glow;
  g.beginPath(); g.arc(cx,cy,r*1.7,0,Math.PI*2); g.fill();
  g.globalAlpha=1;
  // capsule
  g.fillStyle=c;
  g.beginPath(); g.arc(cx,cy,r,0,Math.PI*2); g.fill();
  g.strokeStyle='rgba(0,0,0,0.35)'; g.lineWidth=r*0.16; g.stroke();
  // glyph
  g.fillStyle='#141014';
  g.font='bold '+Math.round(r*1.15)+'px sans-serif';
  g.textAlign='center'; g.textBaseline='middle';
  g.fillText({bomb:'+', range:'✷', speed:'»', kick:'▸'}[type]||'?', cx, cy+r*0.04);
}

function drawBlastSprite(g, size){
  g.clearRect(0,0,size,size);
  const cx=size/2, cy=size/2;
  const grad=g.createRadialGradient(cx,cy,size*0.04,cx,cy,size*0.48);
  grad.addColorStop(0,'rgba(255,250,235,1)');
  grad.addColorStop(0.35,'rgba(255,170,110,0.9)');
  grad.addColorStop(0.7,'rgba(232,62,92,0.55)');
  grad.addColorStop(1,'rgba(232,62,92,0)');
  g.fillStyle=grad;
  g.beginPath(); g.arc(cx,cy,size*0.48,0,Math.PI*2); g.fill();
  // seed shrapnel
  g.fillStyle='#140d0b';
  for(let i=0;i<6;i++){
    const a=(i/6)*Math.PI*2;
    g.save();
    g.translate(cx+Math.cos(a)*size*0.26, cy+Math.sin(a)*size*0.26);
    g.rotate(a);
    g.beginPath(); g.ellipse(0,0,size*0.022,size*0.036,0,0,Math.PI*2); g.fill();
    g.restore();
  }
}

function r3EntityTextures(){
  if(R3.tex.bomb) return;
  R3.tex.bomb  = canvasTexture(g=>drawBombSprite(g,SPR,false,false), SPR);
  R3.tex.bombHot = canvasTexture(g=>drawBombSprite(g,SPR,true,false), SPR);
  R3.tex.bombStorm = canvasTexture(g=>drawBombSprite(g,SPR,false,true), SPR);
  R3.tex.blast = canvasTexture(g=>drawBlastSprite(g,SPR), SPR);
  R3.tex.pu = {};
  ['bomb','range','speed','kick'].forEach(t=>{
    R3.tex.pu[t] = canvasTexture(g=>drawPowerupSprite(g,SPR,t), SPR);
  });
}

// ---------------- per-frame ----------------
function render(){
  if(!R3.ready || !R3.scene) return;
  const now = performance.now();
  const dt = Math.min(0.05, (now - (R3._last||now))/1000);
  R3._last = now;

  // --- crates: drop any that were destroyed ---
  for(const key in R3.crates){
    const [x,y] = key.split(',').map(Number);
    if(game.grid[y] && game.grid[y][x] !== TILE_CRATE){
      R3.scene.remove(R3.crates[key]);
      delete R3.crates[key];
    }
  }
  // (and add any that somehow appeared, e.g. a late client grid sync)
  for(let y=0;y<ROWS;y++){
    for(let x=0;x<COLS;x++){
      if(game.grid[y][x]===TILE_CRATE && !R3.crates[x+','+y]) r3AddCrate(x,y);
    }
  }

  // --- players ---
  game.roster.forEach(rp=>{
    const p = game.players[rp.slot];
    const v = R3.players[rp.slot];
    if(!p || !v) return;

    const visible = p.alive || (now - (p.deathAt||0) < 700);
    v.group.visible = visible && !p.disconnected;
    if(!visible) return;

    v.group.position.x = wx(p.x);
    v.group.position.z = wz(p.y);

    // swap the billboard frame for facing + walk cycle
    const dir = (p.dir==='up'||p.dir==='down'||p.dir==='left'||p.dir==='right') ? p.dir : 'down';
    const frame = p.moving ? (Math.floor(now/130)%2) : 0;
    if(dir !== v.curDir || frame !== v.curFrame){
      v.curDir = dir; v.curFrame = frame;
      v.sprite.material.map = v.tex[dir][frame];
      v.sprite.material.needsUpdate = true;
    }

    // hop while moving
    const bob = p.moving ? Math.abs(Math.sin(now/110)) * 0.10 : 0;
    v.group.position.y = 0;
    v.sprite.position.y = 0.62 + bob;
    v.shadow.material.opacity = 0.30 - bob*0.8;

    // squash on death
    if(!p.alive){
      const t = Math.min(1, (now-(p.deathAt||now))/700);
      v.sprite.scale.set(1.30*(1+t*0.6), 1.30*Math.max(0.05,1-t), 1);
      v.sprite.material.opacity = Math.max(0, 1-t);
      v.shadow.material.opacity = Math.max(0, 0.30*(1-t));
    } else {
      v.sprite.scale.set(1.30, 1.30, 1);
      // spawn invulnerability blink
      const blink = p.respawnInvuln>0 && Math.floor(now/100)%2===0;
      v.sprite.material.opacity = blink ? 0.35 : 1;
    }
  });

  // --- bombs ---
  const liveBombs = {};
  game.bombs.forEach(b=>{
    if(b.exploded) return;
    const id = b.id !== undefined ? b.id : (b.gx+'_'+b.gy+'_'+b.slot);
    liveBombs[id] = true;
    let m = R3.bombs[id];
    if(!m){
      m = spriteFrom(R3.tex.bomb, 0.95, 0.95);
      R3.scene.add(m);
      R3.bombs[id] = m;
    }
    const px = b.px!==undefined ? b.px : b.gx*TILE+TILE/2;
    const py = b.py!==undefined ? b.py : b.gy*TILE+TILE/2;
    const left = b.fuseAt - now;
    const hot = left < 800;
    m.position.set(wx(px), 0.48, wz(py));
    const pulse = 1 + Math.sin(now/(hot?70:180))*0.12;
    m.scale.set(0.95*pulse, 0.95*pulse, 1);
    const want = hot ? R3.tex.bombHot : (b.storm ? R3.tex.bombStorm : R3.tex.bomb);
    if(m.material.map !== want){ m.material.map = want; m.material.needsUpdate = true; }
  });
  for(const id in R3.bombs){
    if(!liveBombs[id]){ R3.scene.remove(R3.bombs[id]); delete R3.bombs[id]; }
  }

  // --- explosions ---
  R3.explosions = R3.explosions.filter(e=>{
    if(now > e.until){
      R3.scene.remove(e.mesh);
      if(e.ring) R3.scene.remove(e.ring);
      return false;
    }
    const t = 1 - (e.until-now)/EXPLOSION_LIFE;
    const ease = 1 - Math.pow(1-t, 3);
    const sc = 0.9 + ease*0.85;
    e.mesh.scale.set(sc, sc, 1);
    e.mesh.material.opacity = Math.max(0, 0.95*(1-t*t));
    e.mesh.position.y = 0.55 + t*0.25;
    if(e.ring){
      e.ring.scale.setScalar(0.5 + ease*1.7);
      e.ring.material.opacity = Math.max(0, 0.75*(1-t));
    }
    return true;
  });
  game.explosions.forEach(ex=>{
    if(now > ex.until) return;
    const key = ex.gx+','+ex.gy+','+Math.round(ex.until);
    if(R3.explosions.some(e=>e.key===key)) return;
    const mesh = spriteFrom(R3.tex.blast, 1.0, 1.0);
    mesh.position.set(ex.gx-COLS/2+0.5, 0.55, ex.gy-ROWS/2+0.5);
    R3.scene.add(mesh);
    // flat shockwave on the ground — the part that actually reads from overhead
    const ring = new THREE.Mesh(R3.geo.shock, R3.mat.shock.clone());
    ring.rotation.x = -Math.PI/2;
    ring.position.set(ex.gx-COLS/2+0.5, 0.03, ex.gy-ROWS/2+0.5);
    R3.scene.add(ring);
    R3.explosions.push({key, mesh, ring, until:ex.until});
  });

  // --- powerups ---
  const livePU = {};
  const PU_COLOR = {bomb:0x9ef01a, range:0xff5c7a, speed:0xffb703, kick:0x7fd8be};
  Object.entries(game.powerups).forEach(([k,type])=>{
    livePU[k] = true;
    let m = R3.powerups[k];
    if(!m){
      const [gx,gy] = k.split(',').map(Number);
      m = spriteFrom(R3.tex.pu[type] || R3.tex.pu.bomb, 0.70, 0.70);
      m.position.set(gx-COLS/2+0.5, 0.50, gy-ROWS/2+0.5);
      // floor glow so pickups are obvious from directly above
      const halo = new THREE.Mesh(R3.geo.ring, new THREE.MeshBasicMaterial({
        color: PU_COLOR[type]||0xffffff, transparent:true, opacity:0.45,
        side:THREE.DoubleSide, depthWrite:false
      }));
      halo.rotation.x = -Math.PI/2;
      halo.position.set(gx-COLS/2+0.5, 0.02, gy-ROWS/2+0.5);
      R3.scene.add(halo);
      m.userData.halo = halo;
      R3.scene.add(m);
      R3.powerups[k] = m;
    }
    m.position.y = 0.50 + Math.sin(now/300 + m.position.x)*0.07;
    if(m.userData.halo){
      const pulse = 0.35 + Math.abs(Math.sin(now/420 + m.position.x))*0.35;
      m.userData.halo.material.opacity = pulse;
      m.userData.halo.rotation.z += dt*0.6;
    }
  });
  for(const k in R3.powerups){
    if(!livePU[k]){
      if(R3.powerups[k].userData.halo) R3.scene.remove(R3.powerups[k].userData.halo);
      R3.scene.remove(R3.powerups[k]); delete R3.powerups[k];
    }
  }

  // --- sparks (reuse the sim's 2D particles) ---
  const pos = R3.sparks.geometry.attributes.position.array;
  const col = R3.sparks.geometry.attributes.color.array;
  const n = Math.min(game.particles.length, pos.length/3);
  for(let i=0;i<n;i++){
    const pt = game.particles[i];
    pos[i*3]   = wx(pt.x);
    pos[i*3+1] = 0.35 + (pt.life)*0.5;
    pos[i*3+2] = wz(pt.y);
    const c = new THREE.Color(pt.color);
    col[i*3]=c.r; col[i*3+1]=c.g; col[i*3+2]=c.b;
  }
  for(let i=n;i<pos.length/3;i++){ pos[i*3+1] = -50; }
  R3.sparks.geometry.attributes.position.needsUpdate = true;
  R3.sparks.geometry.attributes.color.needsUpdate = true;
  R3.sparks.geometry.setDrawRange(0, Math.max(n,1));

  // --- camera shake ---
  let sx=0, sz=0;
  if(now < game.shakeUntil){
    sx = (Math.random()-0.5)*game.shakeMag*0.06;
    sz = (Math.random()-0.5)*game.shakeMag*0.06;
  }
  r3PlaceCamera(sx, sz);

  R3.renderer.render(R3.scene, R3.camera);
}

// ================================================================
// GAME OVER
// ================================================================
let overlayShown=false;
function renderGameOverOverlay(){
  if(overlayShown) return;
  overlayShown = true;
  const overlay = $('overlay');
  overlay.classList.remove('hidden');
  overlay.innerHTML='';

  const box = document.createElement('div');
  box.className='panel fade-in';
  box.style.width='min(90vw,420px)';

  let title, sub;
  if(game.winnerSlot===null){
    title = "It's a splat-out!"; sub='Nobody survived the melon carnage.';
  } else if(game.winnerSlot===myId){
    title = 'You win! 🍉'; sub='Last melon standing.';
  } else {
    const wp = game.players[game.winnerSlot];
    title = (wp?wp.name:'Opponent') + ' wins'; sub='Better luck next round.';
  }

  // built from elements: player names come from other people
  const trophy = document.createElement('div');
  trophy.className = 'melon-emoji-row';
  trophy.textContent = '🏆';
  const h = document.createElement('h1');
  h.className = 'logo';
  h.style.fontSize = '1.8rem';
  h.textContent = title;
  const tag = document.createElement('div');
  tag.className = 'tagline';
  tag.style.textTransform = 'none';
  tag.style.letterSpacing = '0.5px';
  tag.textContent = sub;
  box.append(trophy, h, tag);

  box.appendChild(buildScoreboard());

  const btnMenu = document.createElement('button');
  btnMenu.className='btn secondary';
  btnMenu.textContent= isHost ? 'Back to Lobby' : 'Leave Game';
  btnMenu.onclick = ()=> (isHost ? backToLobby() : leaveGame());

  if(isHost || game.localOnly){
    const btnAgain = document.createElement('button');
    btnAgain.className='btn lime';
    btnAgain.textContent='Play Again';
    btnAgain.onclick = ()=> startNewMatch();
    box.appendChild(btnAgain);
  } else {
    const waiting = document.createElement('div');
    waiting.className='status-line';
    waiting.textContent = 'Waiting for the host to start the next round…';
    box.appendChild(waiting);
  }

  box.appendChild(btnMenu);

  overlay.appendChild(box);
}

// ================================================================
// INPUT HANDLING (keyboard + touch)
// ================================================================
let inputAttached=false;
// A player's key goes to the host right away, not on the next frame.
let lastLocalInput = null;
function inputChanged(){
  if(!game) return;
  if(game.localOnly || isHost){
    if(myId !== null) game.notePress(myId, localInput, lastLocalInput);
    lastLocalInput = {...localInput};
  } else sendInputToHostThrottled();
}
function attachInputHandlers(){
  if(inputAttached) return;
  inputAttached=true;

  const keyMap = {
    'ArrowUp':'up','KeyW':'up',
    'ArrowDown':'down','KeyS':'down',
    'ArrowLeft':'left','KeyA':'left',
    'ArrowRight':'right','KeyD':'right',
    'Space':'bomb',
    'ShiftLeft':'kick'
  };

  window.addEventListener('keydown', e=>{
    const k = keyMap[e.code];
    if(k){ localInput[k]=true; e.preventDefault(); inputChanged(); }
  });
  window.addEventListener('keyup', e=>{
    const k = keyMap[e.code];
    if(k){ localInput[k]=false; e.preventDefault(); inputChanged(); }
  });

  // touch dpad
  document.querySelectorAll('.dpad button').forEach(btn=>{
    const dir = btn.dataset.dir;
    const on = (e)=>{ e.preventDefault(); localInput[dir]=true; inputChanged(); };
    const off = (e)=>{ e.preventDefault(); localInput[dir]=false; inputChanged(); };
    btn.addEventListener('touchstart', on, {passive:false});
    btn.addEventListener('touchend', off, {passive:false});
    btn.addEventListener('touchcancel', off, {passive:false});
    btn.addEventListener('mousedown', on);
    btn.addEventListener('mouseup', off);
    btn.addEventListener('mouseleave', off);
  });
  const bombBtn = $('bombBtn');
  const bombOn = (e)=>{ e.preventDefault(); localInput.bomb=true; inputChanged(); };
  const bombOff = (e)=>{ e.preventDefault(); localInput.bomb=false; inputChanged(); };
  bombBtn.addEventListener('touchstart', bombOn, {passive:false});
  bombBtn.addEventListener('touchend', bombOff, {passive:false});
  bombBtn.addEventListener('mousedown', bombOn);
  bombBtn.addEventListener('mouseup', bombOff);

  const kickBtn = $('kickBtn');
  const kickOn = (e)=>{ e.preventDefault(); localInput.kick=true; inputChanged(); };
  const kickOff = (e)=>{ e.preventDefault(); localInput.kick=false; inputChanged(); };
  kickBtn.addEventListener('touchstart', kickOn, {passive:false});
  kickBtn.addEventListener('touchend', kickOff, {passive:false});
  kickBtn.addEventListener('touchcancel', kickOff, {passive:false});
  kickBtn.addEventListener('mousedown', kickOn);
  kickBtn.addEventListener('mouseup', kickOff);
  kickBtn.addEventListener('mouseleave', kickOff);
}

populateHatSelect();

// ---------------------------------------------------------------
// PEISKOS
// ---------------------------------------------------------------
window.addEventListener('message', e=>{
  if(e.source !== window.parent) return;
  const m = e.data;
  if(!m || typeof m !== 'object') return;
  if(m.kind==='init'){
    me = {id:m.me.id, name:shortName(m.me.name)};
    hostUid = m.hostId;
    if(me.id===hostUid) hostGame(m.players || []);
    else joinGame();
  } else if(m.kind==='players'){
    if(isHost && me) syncPlayers(m.players || []);
  } else if(m.kind==='msg'){
    if(!me || !m.data || typeof m.data !== 'object') return;
    if(isHost){
      const c = conns.find(cc=>cc.uid===m.from);
      if(c) onHostReceiveData(c, m.data);
    } else if(m.from===hostUid){
      onClientReceiveData(m.data);
    }
  }
});
toPeiskos({kind:'ready'});

// prevent page scroll/zoom while playing
document.addEventListener('touchmove', e=>{
  if(!$('gameWrap').classList.contains('hidden')) e.preventDefault();
}, {passive:false});

})();
