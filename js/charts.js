// charts.js — tiny canvas charts. DPR-aware, dark-mode aware (reads CSS custom properties),
// redraws on resize / colour-scheme change, degrades gracefully with 0–2 points.

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function theme() {
  return {
    surface: cssVar('--card', '#fffdf8'),
    text: cssVar('--ink', '#2b2a28'),
    muted: cssVar('--muted', '#6f6a60'),
    grid: cssVar('--grid', 'rgba(0,0,0,0.08)'),
    accent: cssVar('--accent', '#3b5b8c'),
    pause: cssVar('--pause-shade', 'rgba(210,85,58,0.12)'),
    vol: cssVar('--vol-fill', 'rgba(120,110,95,0.18)'),
    series: [1, 2, 3, 4, 5, 6].map((i) => cssVar(`--series-${i}`, ['#257de0', '#f47230', '#00b894', '#f2a600', '#ee7fac', '#008a17'][i - 1])),
  };
}

/** Size canvas backing store to its CSS box × devicePixelRatio. */
export function setupCanvas(canvas, cssHeight) {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const w = Math.max(10, Math.round(canvas.clientWidth || canvas.parentElement?.clientWidth || 300));
  const h = cssHeight || Math.round(canvas.clientHeight) || 180;
  canvas.style.height = `${h}px`;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

/** Re-run draw() on resize and on light/dark switch. Returns cleanup. */
function autoRedraw(canvas, draw) {
  let raf = 0;
  const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); };
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
  ro?.observe(canvas);
  const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
  mq?.addEventListener?.('change', schedule);
  draw();
  return () => { ro?.disconnect(); mq?.removeEventListener?.('change', schedule); cancelAnimationFrame(raf); };
}

function niceTicks(min, max, count = 4) {
  if (!(max > min)) { max = min + 1; }
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) || step0;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return { lo, hi, ticks };
}

function ensureTooltip(canvas) {
  const wrap = canvas.parentElement;
  let tip = wrap.querySelector(':scope > .chart-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.setAttribute('role', 'status');
    wrap.appendChild(tip);
  }
  return tip;
}

/**
 * lineChart(canvas, { series:[{name, values:(number|null)[]}], labels:string[], height,
 *   yMin, yMax, format:(v)=>string })
 * Points are evenly spaced by index (one per entry). Tap/hover shows a crosshair + values.
 */
export function lineChart(canvas, opts) {
  const { series = [], labels = [], height = 180, format = (v) => String(Math.round(v)) } = opts;
  const n = labels.length;
  let hover = -1;
  const pad = { l: 34, r: 12, t: 10, b: 24 };

  const draw = () => {
    const t = theme();
    const { ctx, w, h } = setupCanvas(canvas, height);
    const all = series.flatMap((s) => s.values).filter((v) => Number.isFinite(v));
    let yMin = opts.yMin ?? (all.length ? Math.min(...all) : 0);
    let yMax = opts.yMax ?? (all.length ? Math.max(...all) : 1);
    if (opts.yMin == null && opts.yMax == null && yMax - yMin < 1e-9) { yMin -= 1; yMax += 1; }
    const { lo, hi, ticks } = opts.yMin != null && opts.yMax != null
      ? { lo: yMin, hi: yMax, ticks: niceTicks(yMin, yMax, 4).ticks.filter((v) => v >= yMin && v <= yMax) }
      : niceTicks(yMin, yMax, 4);
    const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
    const X = (i) => pad.l + (n <= 1 ? pw / 2 : (i / (n - 1)) * pw);
    const Y = (v) => pad.t + ph - ((v - lo) / (hi - lo || 1)) * ph;

    // grid + y labels
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    ctx.lineWidth = 1;
    for (const v of ticks) {
      const y = Math.round(Y(v)) + 0.5;
      ctx.strokeStyle = t.grid;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
      ctx.fillStyle = t.muted;
      ctx.fillText(format(v), pad.l - 6, y);
    }
    // x labels: first, last, and a middle one if space
    ctx.textBaseline = 'top';
    const xl = n <= 1 ? [0] : n === 2 ? [0, 1] : [0, Math.floor((n - 1) / 2), n - 1];
    for (const i of xl) {
      if (labels[i] == null) continue;
      ctx.textAlign = n <= 1 ? 'center' : i === 0 ? 'left' : i === n - 1 ? 'right' : 'center';
      ctx.fillStyle = t.muted;
      ctx.fillText(labels[i], X(i), h - pad.b + 7);
    }
    // series
    series.forEach((s, si) => {
      const color = s.color || t.series[si % t.series.length];
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.beginPath();
      let started = false;
      s.values.forEach((v, i) => {
        if (!Number.isFinite(v)) { started = false; return; }
        if (!started) { ctx.moveTo(X(i), Y(v)); started = true; } else ctx.lineTo(X(i), Y(v));
      });
      ctx.stroke();
      // markers when sparse, or at last point
      const sparse = n <= 12;
      s.values.forEach((v, i) => {
        if (!Number.isFinite(v)) return;
        if (!(sparse || i === n - 1 || i === hover)) return;
        ctx.beginPath(); ctx.arc(X(i), Y(v), i === hover ? 5 : 3.5, 0, Math.PI * 2);
        ctx.fillStyle = color; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = t.surface; ctx.stroke();
      });
    });
    if (hover >= 0) {
      ctx.strokeStyle = t.muted; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(Math.round(X(hover)) + 0.5, pad.t); ctx.lineTo(Math.round(X(hover)) + 0.5, pad.t + ph); ctx.stroke();
      ctx.setLineDash([]);
    }
    canvas._geom = { X, n, w, pad, pw };
  };

  const tip = ensureTooltip(canvas);
  const onMove = (ev) => {
    const g = canvas._geom; if (!g || !n) return;
    const r = canvas.getBoundingClientRect();
    const x = ev.clientX - r.left;
    const i = n <= 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round(((x - g.pad.l) / g.pw) * (n - 1))));
    hover = i; draw();
    const t = theme();
    tip.innerHTML = `<b>${esc(labels[i] ?? '')}</b>` + series.map((s, si) =>
      `<span><i style="background:${s.color || t.series[si % t.series.length]}"></i>${esc(s.name)}: ${Number.isFinite(s.values[i]) ? esc(format(s.values[i])) : '—'}</span>`).join('');
    tip.style.display = 'block';
    const tx = g.X(i);
    tip.style.left = `${Math.min(Math.max(tx - tip.offsetWidth / 2, 0), g.w - tip.offsetWidth)}px`;
  };
  const onLeave = () => { hover = -1; tip.style.display = 'none'; draw(); };
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerdown', onMove);
  canvas.addEventListener('pointerleave', onLeave);
  const stop = autoRedraw(canvas, draw);
  return { destroy() { stop(); canvas.removeEventListener('pointermove', onMove); canvas.removeEventListener('pointerdown', onMove); canvas.removeEventListener('pointerleave', onLeave); } };
}

/** barChart(canvas, { labels, values, height, format }) */
export function barChart(canvas, { labels = [], values = [], height = 160, format = (v) => String(v) } = {}) {
  let hover = -1;
  const pad = { l: 34, r: 12, t: 10, b: 24 };
  const draw = () => {
    const t = theme();
    const { ctx, w, h } = setupCanvas(canvas, height);
    const max = Math.max(1, ...values.filter(Number.isFinite));
    const { hi, ticks } = niceTicks(0, max, 3);
    const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
    const Y = (v) => pad.t + ph - (v / hi) * ph;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const v of ticks) {
      const y = Math.round(Y(v)) + 0.5;
      ctx.strokeStyle = t.grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
      ctx.fillStyle = t.muted; ctx.fillText(format(v), pad.l - 6, y);
    }
    const n = values.length || 1;
    const slot = pw / n;
    const bw = Math.max(4, Math.min(28, slot - 2));
    values.forEach((v, i) => {
      const x = pad.l + slot * i + (slot - bw) / 2;
      const y = Y(v || 0), bh = pad.t + ph - y;
      ctx.fillStyle = i === hover ? t.text : t.accent;
      roundTop(ctx, x, y, bw, bh, Math.min(4, bw / 2));
    });
    ctx.textBaseline = 'top'; ctx.fillStyle = t.muted;
    const step = Math.ceil(n / 5);
    labels.forEach((l, i) => {
      if (i % step && i !== n - 1) return;
      ctx.textAlign = 'center';
      ctx.fillText(l, pad.l + slot * i + slot / 2, h - pad.b + 7);
    });
    canvas._geom = { pad, slot, w };
  };
  const tip = ensureTooltip(canvas);
  const onMove = (ev) => {
    const g = canvas._geom; if (!g || !values.length) return;
    const r = canvas.getBoundingClientRect();
    const i = Math.max(0, Math.min(values.length - 1, Math.floor((ev.clientX - r.left - g.pad.l) / g.slot)));
    hover = i; draw();
    tip.innerHTML = `<b>${esc(labels[i])}</b><span>${esc(format(values[i]))}</span>`;
    tip.style.display = 'block';
    const cx = g.pad.l + g.slot * i + g.slot / 2;
    tip.style.left = `${Math.min(Math.max(cx - tip.offsetWidth / 2, 0), g.w - tip.offsetWidth)}px`;
  };
  const onLeave = () => { hover = -1; tip.style.display = 'none'; draw(); };
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerdown', onMove);
  canvas.addEventListener('pointerleave', onLeave);
  const stop = autoRedraw(canvas, draw);
  return { destroy() { stop(); } };
}

function roundTop(ctx, x, y, w, h, r) {
  if (h <= 0) return;
  r = Math.min(r, h);
  ctx.beginPath();
  ctx.moveTo(x, y + h); ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h); ctx.closePath(); ctx.fill();
}

/**
 * contourChart(canvas, { metrics, duration, onSeek(t), height })
 * Pitch in semitones relative to the speaker's median (line, gaps when unvoiced) over a
 * volume envelope (filled area). Pauses shaded. Tap to seek. Returns { setPlayhead(t), destroy }.
 */
export function contourChart(canvas, { metrics, duration, onSeek, height = 200 }) {
  let playhead = -1;
  const pad = { l: 30, r: 8, t: 10, b: 22 };
  const pitch = metrics?.pitch || { hz: [], frameSec: 0.02, medianHz: 0 };
  const vol = metrics?.volume || { db: [], frameSec: 0.02 };
  const dur = duration || metrics?.durationSec || Math.max(pitch.hz.length * pitch.frameSec, vol.db.length * vol.frameSec) || 1;
  const med = pitch.medianHz || median(pitch.hz.filter((x) => x > 0)) || 150;
  const st = pitch.hz.map((hz) => (hz > 0 ? 12 * Math.log2(hz / med) : null));
  const stVals = st.filter((v) => v != null);
  const stAbs = Math.max(6, Math.min(18, Math.ceil(percentileAbs(stVals, 0.98) + 1)));

  const draw = () => {
    const t = theme();
    const { ctx, w, h } = setupCanvas(canvas, height);
    const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
    const X = (sec) => pad.l + (sec / dur) * pw;
    const Y = (s) => pad.t + ph / 2 - (s / stAbs) * (ph / 2);
    // pauses
    ctx.fillStyle = t.pause;
    for (const p of metrics?.pauses || []) ctx.fillRect(X(p.start), pad.t, Math.max(1, X(p.end) - X(p.start)), ph);
    ctx.fillStyle = t.pause;
    for (const p of metrics?.longPauses || []) ctx.fillRect(X(p.start), pad.t, Math.max(1, X(p.end) - X(p.start)), ph);
    // volume envelope (bottom-anchored area, -60..0 dB)
    if (vol.db.length) {
      ctx.beginPath();
      ctx.moveTo(X(0), pad.t + ph);
      const step = Math.max(1, Math.floor(vol.db.length / (pw * 2)));
      for (let i = 0; i < vol.db.length; i += step) {
        const v = Math.max(0, Math.min(1, (vol.db[i] + 60) / 60));
        ctx.lineTo(X(i * vol.frameSec), pad.t + ph - v * ph * 0.55);
      }
      ctx.lineTo(X(Math.min(dur, vol.db.length * vol.frameSec)), pad.t + ph);
      ctx.closePath();
      ctx.fillStyle = t.vol; ctx.fill();
    }
    // grid lines at 0 and ±6 st
    ctx.font = '10px system-ui, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const s of [-stAbs + (stAbs % 6), 0, stAbs - (stAbs % 6)].filter((v, i, a) => a.indexOf(v) === i)) {
      const y = Math.round(Y(s)) + 0.5;
      ctx.strokeStyle = t.grid; ctx.lineWidth = 1;
      ctx.setLineDash(s === 0 ? [] : [2, 3]);
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = t.muted; ctx.fillText(`${s > 0 ? '+' : ''}${s}`, pad.l - 4, y);
    }
    // pitch line
    ctx.strokeStyle = t.series[0]; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    let prev = null;
    const stride = Math.max(1, Math.floor(st.length / (pw * 2)));
    for (let i = 0; i < st.length; i += stride) {
      const v = st[i];
      if (v == null) { prev = null; continue; }
      const x = X(i * pitch.frameSec), y = Y(Math.max(-stAbs, Math.min(stAbs, v)));
      if (prev == null) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      prev = v;
    }
    ctx.stroke();
    // x axis time labels
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = t.muted;
    const tStep = dur > 240 ? 60 : dur > 90 ? 30 : dur > 30 ? 10 : 5;
    for (let s = 0; s <= dur + 0.01; s += tStep) {
      ctx.fillText(`${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`, Math.min(X(s), w - pad.r - 10), h - pad.b + 6);
    }
    // playhead
    if (playhead >= 0) {
      const x = Math.round(X(playhead)) + 0.5;
      ctx.strokeStyle = t.text; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ph); ctx.stroke();
    }
    canvas._geom = { pad, pw };
  };
  const onDown = (ev) => {
    const g = canvas._geom; if (!g) return;
    const r = canvas.getBoundingClientRect();
    const sec = Math.max(0, Math.min(dur, ((ev.clientX - r.left - g.pad.l) / g.pw) * dur));
    onSeek?.(sec);
  };
  canvas.addEventListener('pointerdown', onDown);
  const stop = autoRedraw(canvas, draw);
  return {
    setPlayhead(sec) { playhead = sec; draw(); },
    destroy() { stop(); canvas.removeEventListener('pointerdown', onDown); },
  };
}

function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}
function percentileAbs(a, p) {
  if (!a.length) return 0;
  const s = a.map(Math.abs).sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
