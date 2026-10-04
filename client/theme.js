// Apply the saved theme before first paint to avoid a flash.
// (A separate file so the page's security policy can forbid inline scripts.)
//
// Light/dark is `data-theme` on <html>. On top of that, someone can pick their own theme color
// on a color wheel: a hue and how strong it is. Everything else (backgrounds, lines, the accent)
// is worked out from that, separately for light and dark, so text always stays readable.

(() => {
  const hsl = (h, s, l, a) => (a == null ? `hsl(${h} ${s}% ${l}%)` : `hsl(${h} ${s}% ${l}% / ${a})`);

  function palette({ h, s }, dark) {
    const tint = s * 0.22; // how colored the backgrounds get
    const acc = Math.min(100, s * 0.9 + 8);
    return dark
      ? {
          bg: hsl(h, tint, 11), sidebar: hsl(h, tint, 8), topbar: hsl(h, tint, 6), surface: hsl(h, tint, 14), 'surface-2': hsl(h, tint, 18),
          line: hsl(h, tint, 21), hover: hsl(h, 30, 75, 0.06), 'code-bg': hsl(h, tint, 9),
          text: hsl(h, tint * 0.5, 86), 'text-strong': hsl(h, tint * 0.5, 95), 'sidebar-ink': hsl(h, tint * 0.5, 89), muted: hsl(h, tint * 0.5, 60),
          accent: hsl(h, acc * 0.7, 64), 'accent-hover': hsl(h, acc * 0.7, 72), 'accent-ink': hsl(h, 30, 8),
          'accent-soft': hsl(h, acc * 0.7, 64, 0.14), moss: hsl(h, acc * 0.6, 64),
        }
      : {
          bg: hsl(h, tint, 94), sidebar: hsl(h, tint * 1.2, 89), topbar: hsl(h, tint * 1.3, 86), surface: hsl(h, tint, 98), 'surface-2': hsl(h, tint, 92),
          line: hsl(h, tint, 85), hover: hsl(h, 30, 30, 0.07), 'code-bg': hsl(h, tint, 90),
          text: hsl(h, tint * 0.6, 17), 'text-strong': hsl(h, tint * 0.6, 10), 'sidebar-ink': hsl(h, tint * 0.6, 15), muted: hsl(h, tint * 0.4, 42),
          accent: hsl(h, acc * 0.6, 30), 'accent-hover': hsl(h, acc * 0.6, 24), 'accent-ink': '#ffffff',
          'accent-soft': hsl(h, acc * 0.6, 30, 0.12), moss: hsl(h, acc * 0.45, 51),
        };
  }

  const vars = (p) => Object.entries(p).map(([k, v]) => `--${k}: ${v};`).join(' ');

  /** Use a theme color ({ h: 0-360, s: 0-100 }), or null for Burrow's own forest colors. */
  function applyThemeColor(color) {
    let tag = document.getElementById('theme-color');
    if (!color) return tag?.remove();
    if (!tag) {
      tag = document.createElement('style');
      tag.id = 'theme-color';
      document.head.append(tag);
    }
    const light = vars(palette(color, false)), dark = vars(palette(color, true));
    tag.textContent = `:root:not([data-theme="dark"]) { ${light} }
:root[data-theme="dark"] { ${dark} }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${dark} } }`;
  }
  window.applyThemeColor = applyThemeColor;

  try {
    const t = localStorage.getItem('theme');
    if (t) document.documentElement.dataset.theme = t;
    const c = JSON.parse(localStorage.getItem('themeColor'));
    if (c && Number.isFinite(c.h) && Number.isFinite(c.s)) applyThemeColor(c);
  } catch {}
})();
