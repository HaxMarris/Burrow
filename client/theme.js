// Apply the saved theme before first paint to avoid a flash.
// (A separate file so the page's security policy can forbid inline scripts.)
try { const t = localStorage.getItem('theme'); if (t) document.documentElement.dataset.theme = t; } catch {}
