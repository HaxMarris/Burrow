// Stream sound on Windows: share only the sound of the program you picked, instead of
// everything your computer plays (which would also send your friends' voices back to them).
//
// Uses Windows' per-program audio capture (Windows 10 version 2004 or later) through the
// loopback-capture add-on. Sound arrives as 48 kHz stereo 16-bit chunks and is handed to the
// page, which turns it back into an audio track for the stream.
const { execFile } = require('node:child_process');
const os = require('node:os');

let addon = null;
if (process.platform === 'win32' && Number(os.release().split('.')[2]) >= 19041) {
  try { addon = require('loopback-capture'); } catch (err) { console.warn('Program audio capture unavailable:', err.message); }
}

/** Whether this computer can share one program's sound. */
const supported = () => !!addon;

/** The process that owns a window, from a screen-share source id like "window:132456:0". */
function windowProcess(sourceId) {
  const hwnd = /^window:(\d+):/.exec(sourceId)?.[1];
  if (!hwnd) return Promise.resolve(null);
  // Most windows are their program's main window; the rest are looked up through user32.
  const script = `$h = [int64]${hwnd}
$p = Get-Process | Where-Object { $_.MainWindowHandle.ToInt64() -eq $h } | Select-Object -First 1 -ExpandProperty Id
if (-not $p) {
  Add-Type -Namespace Burrow -Name Win -MemberDefinition '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint pid);'
  $q = [uint32]0
  [void][Burrow.Win]::GetWindowThreadProcessId([IntPtr]$h, [ref]$q)
  $p = $q
}
$p`;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 10000, windowsHide: true }, (err, stdout) => {
      const pid = Number(String(stdout).trim());
      resolve(!err && pid > 0 ? pid : null);
    });
  });
}

let capture = null;
let generation = 0; // a newer start or a stop wins over a start still looking up its window

/**
 * Starts sending the picked source's sound to `send(chunk)`. A window shares its program's
 * sound (with any helper processes it started, like a browser's audio process); a whole
 * screen shares everything except Burrow itself. Resolves to what is being shared.
 */
async function start(sourceId, send) {
  stop();
  if (!addon) return null;
  const mine = generation;
  const pid = await windowProcess(sourceId);
  if (mine !== generation || pid === process.pid) return null; // Burrow's own window has nothing to share
  const c = new addon.LoopbackCapture();
  // Include the program's process tree, or, for a screen (or a window we couldn't trace),
  // everything except Burrow's own.
  if (pid) c.start(pid, true, send);
  else c.start(process.pid, false, send);
  capture = c;
  return pid ? 'program' : 'all-but-burrow';
}

function stop() {
  generation++;
  const c = capture;
  capture = null;
  try { c?.stop(); } catch (err) { console.warn('Stopping program audio:', err.message); }
}

module.exports = { supported, start, stop };
