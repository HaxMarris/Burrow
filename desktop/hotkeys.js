// Voice hotkeys that work while another program is in front (a game, say): push to talk,
// mute and deafen.
//
// Holding a key down and letting it go can only be heard everywhere through the uiohook-napi
// add-on. Where it's missing (or, on a Mac, until Burrow is allowed under Accessibility),
// mute and deafen still work through Electron's own shortcuts, which only hear presses.
const { globalShortcut, systemPreferences, shell } = require('electron');

let uiohook = null;
let UiohookKey = {};
try { ({ uIOhook: uiohook, UiohookKey } = require('uiohook-napi')); } catch (err) { console.warn('Global hotkeys unavailable:', err.message); }

// The page names keys the way browsers do (KeyboardEvent.code); uiohook numbers them.
const CODES = {
  Backquote: 'Backquote', Minus: 'Minus', Equal: 'Equal', BracketLeft: 'BracketLeft', BracketRight: 'BracketRight',
  Backslash: 'Backslash', Semicolon: 'Semicolon', Quote: 'Quote', Comma: 'Comma', Period: 'Period', Slash: 'Slash',
  Space: 'Space', Tab: 'Tab', Enter: 'Enter', CapsLock: 'CapsLock', Backspace: 'Backspace', Insert: 'Insert', Delete: 'Delete',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown',
  ControlLeft: 'Ctrl', ControlRight: 'CtrlRight', ShiftLeft: 'Shift', ShiftRight: 'ShiftRight',
  AltLeft: 'Alt', AltRight: 'AltRight', MetaLeft: 'Meta', MetaRight: 'MetaRight',
  NumpadMultiply: 'NumpadMultiply', NumpadAdd: 'NumpadAdd', NumpadSubtract: 'NumpadSubtract',
  NumpadDecimal: 'NumpadDecimal', NumpadDivide: 'NumpadDivide', NumpadEnter: 'NumpadEnter',
  ScrollLock: 'ScrollLock', PrintScreen: 'PrintScreen',
};
function keycode(code) {
  const name = /^Key([A-Z])$/.exec(code)?.[1] ?? /^Digit(\d)$/.exec(code)?.[1] ?? /^(Numpad\d|F\d{1,2})$/.exec(code)?.[1] ?? CODES[code];
  return name === undefined ? null : UiohookKey[name] ?? null;
}

// Electron's shortcut names, for the fallback.
const ACCEL = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'",
  Comma: ',', Period: '.', Slash: '/', Space: 'Space', Tab: 'Tab', Enter: 'Enter', Backspace: 'Backspace', Insert: 'Insert',
  Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',
};
function accelerator(k) {
  const key = /^Key([A-Z])$/.exec(k.code)?.[1] ?? /^Digit(\d)$/.exec(k.code)?.[1] ?? /^(F\d{1,2})$/.exec(k.code)?.[1]
    ?? (/^Numpad(\d)$/.exec(k.code) ? `num${k.code.slice(6)}` : ACCEL[k.code]);
  if (!key) return null;
  return [k.ctrl && 'Control', k.alt && 'Alt', k.shift && 'Shift', k.meta && 'Super', key].filter(Boolean).join('+');
}

const allowed = () => process.platform !== 'darwin' || systemPreferences.isTrustedAccessibilityClient(false);

let binds = null; // { ptt, mute, deafen }, each { code, ctrl?, alt?, shift?, meta? } or null
let send = () => {};
let listening = false;
let pttDown = false;

const matches = (k, e, exact) => {
  const mouse = /^Mouse(\d)$/.exec(k?.code ?? '')?.[1];
  if (mouse) return e.button === Number(mouse);
  if (!k || e.keycode === undefined || e.keycode !== keycode(k.code)) return false;
  if (!exact || /^(Control|Shift|Alt|Meta)(Left|Right)$/.test(k.code)) return true;
  return !!k.ctrl === e.ctrlKey && !!k.alt === e.altKey && !!k.shift === e.shiftKey && !!k.meta === e.metaKey;
};
function onDown(e) {
  if (!binds) return;
  if (matches(binds.ptt, e, true) && !pttDown) { pttDown = true; send('ptt', true); }
  if (matches(binds.mute, e, true)) send('mute', true);
  if (matches(binds.deafen, e, true)) send('deafen', true);
}
function onUp(e) {
  // Letting go counts whatever else is held.
  if (binds && pttDown && matches(binds.ptt, e, false)) { pttDown = false; send('ptt', false); }
}

function startHook() {
  if (listening) return true;
  try {
    uiohook.on('keydown', onDown);
    uiohook.on('keyup', onUp);
    uiohook.on('mousedown', onDown);
    uiohook.on('mouseup', onUp);
    uiohook.start();
    listening = true;
  } catch (err) {
    console.warn('Global hotkeys failed to start:', err.message);
    uiohook.removeAllListeners();
  }
  return listening;
}
function stopHook() {
  if (!listening) return;
  try { uiohook.stop(); } catch {}
  uiohook.removeAllListeners();
  listening = false;
}

/**
 * Listens for the given keys everywhere (or stops, given null). Returns whether they are heard
 * everywhere, so the page knows whether to listen itself, and whether a Mac needs permission first.
 */
function set(next, sender) {
  send = sender;
  binds = next;
  globalShortcut.unregisterAll();
  if (pttDown) { pttDown = false; send('ptt', false); }
  if (!binds) { stopHook(); return { global: false }; }
  const needsPermission = !!uiohook && !allowed();
  if (uiohook && !needsPermission && startHook()) return { global: true };
  stopHook();
  // Presses only: mute and deafen work, push to talk stays with the page.
  for (const name of ['mute', 'deafen']) {
    const acc = binds[name] && accelerator(binds[name]);
    if (acc) try { globalShortcut.register(acc, () => send(name, true)); } catch {}
  }
  return { global: false, needsPermission };
}

/** Asks macOS to let Burrow hear keys in other apps. */
function askPermission() {
  if (process.platform !== 'darwin') return;
  systemPreferences.isTrustedAccessibilityClient(true);
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
}

function stop() {
  binds = null;
  globalShortcut.unregisterAll();
  stopHook();
}

module.exports = { set, askPermission, stop };
