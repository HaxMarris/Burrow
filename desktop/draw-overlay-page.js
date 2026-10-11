// Paints strokes, given as points from 0 to 1 across the screen, and fades them out.
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
let strokes = []; // { color, pts, fadeAt }: fadeAt is when it's fully gone (null while still being drawn)
let frame = 0;

window.overlay.onStrokes((list) => {
  const now = Date.now();
  strokes = (list ?? []).map((s) => ({ color: s.color, pts: s.pts, fadeAt: s.fadeIn == null ? null : now + s.fadeIn }));
  paint();
});

function paint() {
  cancelAnimationFrame(frame);
  const dpr = devicePixelRatio || 1;
  const w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) Object.assign(canvas, { width: w, height: h });
  ctx.clearRect(0, 0, w, h);
  const now = Date.now();
  strokes = strokes.filter((s) => s.fadeAt == null || s.fadeAt > now);
  ctx.lineCap = ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(4, w / 300);
  for (const s of strokes) {
    if (!s.pts.length) continue;
    ctx.globalAlpha = s.fadeAt == null ? 1 : Math.min(1, (s.fadeAt - now) / 1000);
    ctx.strokeStyle = s.color;
    ctx.beginPath();
    s.pts.forEach(([x, y], i) => ctx[i ? 'lineTo' : 'moveTo'](x * w, y * h));
    if (s.pts.length === 1) ctx.lineTo(s.pts[0][0] * w + 0.1, s.pts[0][1] * h);
    ctx.stroke();
  }
  if (strokes.some((s) => s.fadeAt != null)) frame = requestAnimationFrame(paint);
}
