// "Playing now": every so often, look at which programs are running and pick out a game.
//
// A game is either one Burrow knows by its program name, or anything run from a Steam library
// (…/steamapps/common/<Game name>/…), which covers most PC games without a list. Only the
// game's name ever leaves this computer, and only while you have "Show the game I'm playing" on.
const { execFile } = require('node:child_process');
const path = require('node:path');

// Program names (lowercase, without .exe) of popular games that don't run from Steam's folder.
const KNOWN = {
  'minecraft': 'Minecraft', 'minecraftlauncher': 'Minecraft', 'javaw-minecraft': 'Minecraft',
  'valorant': 'VALORANT', 'valorant-win64-shipping': 'VALORANT', 'league of legends': 'League of Legends',
  'fortniteclient-win64-shipping': 'Fortnite', 'overwatch': 'Overwatch 2', 'r5apex': 'Apex Legends', 'r5apex_dx12': 'Apex Legends',
  'cs2': 'Counter-Strike 2', 'dota2': 'Dota 2', 'gta5': 'Grand Theft Auto V', 'gta5_enhanced': 'Grand Theft Auto V',
  'rocketleague': 'Rocket League', 'robloxplayerbeta': 'Roblox', 'valheim': 'Valheim', 'eldenring': 'ELDEN RING',
  'helldivers2': 'HELLDIVERS 2', 'rainbowsix': 'Rainbow Six Siege', 'destiny2': 'Destiny 2', 'wow': 'World of Warcraft',
  'hearthstone': 'Hearthstone', 'diablo iv': 'Diablo IV', 'cod': 'Call of Duty', 'cod24-cod': 'Call of Duty',
  'genshinimpact': 'Genshin Impact', 'starrail': 'Honkai: Star Rail', 'lethal company': 'Lethal Company',
  'among us': 'Among Us', 'terraria': 'Terraria', 'stardew valley': 'Stardew Valley', 'factorio': 'Factorio',
  'baldursgate3': "Baldur's Gate 3", 'bg3': "Baldur's Gate 3", 'bg3_dx11': "Baldur's Gate 3", 'palworld-win64-shipping': 'Palworld',
  'deadbydaylight-win64-shipping': 'Dead by Daylight', 'phasmophobia': 'Phasmophobia', 'fallguys_client': 'Fall Guys',
  'marvel-win64-shipping': 'Marvel Rivals', 'deadlock': 'Deadlock', 'pathofexile': 'Path of Exile', 'pathofexile2': 'Path of Exile 2',
  'osu!': 'osu!', 'beatsaber': 'Beat Saber', 'vrchat': 'VRChat', 'the sims 4': 'The Sims 4', 'ts4_x64': 'The Sims 4',
};
// Steam folders that hold tools, not games.
const NOT_GAMES = /^(steamworks shared|steamvr|steam controller configs|proton.*|steam ?linux ?runtime.*|wallpaper_engine|wallpaper engine)$/i;

/** Program paths (or names, where the path isn't available) of everything running. */
function running() {
  return new Promise((resolve) => {
    const done = (err, out) => resolve(err ? [] : String(out).split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
    if (process.platform === 'win32') {
      // Paths come with Get-Process; it's run every 30 seconds at low cost.
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Process | ForEach-Object { if ($_.Path) { $_.Path } else { $_.ProcessName } }'],
        { timeout: 15000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, done);
    } else {
      execFile('ps', ['-A', '-o', 'args='], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 }, done);
    }
  });
}

/** The game in a list of running programs, or null. */
function gameIn(programs) {
  for (const line of programs) {
    const steam = /[\\/]steamapps[\\/]common[\\/]([^\\/]+)[\\/]/i.exec(line);
    if (steam && !NOT_GAMES.test(steam[1])) return steam[1];
  }
  for (const line of programs) {
    // The program name: the last part of its path, before any arguments.
    const file = line.split(/\s+-/)[0];
    const name = path.basename(file.replace(/\\/g, '/')).replace(/\.(exe|app|x86_64)$/i, '').toLowerCase();
    if (KNOWN[name]) return KNOWN[name];
    if (/minecraft/i.test(line) && /java/i.test(name)) return 'Minecraft';
  }
  return null;
}

/** Calls onChange with the game's name (or null) whenever it changes, until stop() is called. */
function watch(onChange, every = 30_000) {
  let last;
  let stopped = false;
  let timer = null;
  const check = async () => {
    timer = null;
    const game = gameIn(await running());
    if (stopped) return;
    if (game !== last) onChange((last = game));
    timer = setTimeout(check, every);
  };
  check();
  return {
    stop: () => { stopped = true; clearTimeout(timer); },
    /** Says the current game again (when the page reloads, or the setting is turned back on). */
    repeat: () => { if (last !== undefined) onChange(last); },
  };
}

module.exports = { watch, gameIn };
