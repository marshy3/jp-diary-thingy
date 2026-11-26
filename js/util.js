// util.js — pure helpers (no DOM access at import time; node-testable).
// Local dates are ALWAYS built from getFullYear/getMonth/getDate — never toISOString().

export function pad2(n) { return String(n).padStart(2, '0'); }

/** 'YYYY-MM-DD' in the device's local time zone. */
export function localDateStr(d = new Date()) {
  const x = d instanceof Date ? d : new Date(d);
  return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`;
}

/** Parse 'YYYY-MM-DD' as local midnight. */
export function parseLocalDate(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function addDays(dateStr, n) {
  const d = parseLocalDate(dateStr);
  d.setDate(d.getDate() + n);
  return localDateStr(d);
}

/** Whole days from a to b (b - a), DST-safe. */
export function daysBetween(a, b) {
  const da = parseLocalDate(a), db = parseLocalDate(b);
  return Math.round((Date.UTC(db.getFullYear(), db.getMonth(), db.getDate()) -
    Date.UTC(da.getFullYear(), da.getMonth(), da.getDate())) / 86400000);
}

export function startOfLocalDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Monday-start local week key 'YYYY-MM-DD' of that week's Monday. */
export function weekKey(dateStr) {
  const d = parseLocalDate(dateStr);
  const dow = (d.getDay() + 6) % 7; // Mon=0
  return addDays(dateStr, -dow);
}

const JA_DOW = ['日', '月', '火', '水', '木', '金', '土'];
const EN_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDateJa(dateStr) {
  const d = parseLocalDate(dateStr);
  return `${d.getMonth() + 1}月${d.getDate()}日（${JA_DOW[d.getDay()]}）`;
}
export function formatDateShort(dateStr) {
  const d = parseLocalDate(dateStr);
  return `${EN_MON[d.getMonth()]} ${d.getDate()}`;
}
export function formatMonthTitle(year, month0) {
  return `${year}年${month0 + 1}月`;
}
export function formatTime(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
/** 75.4 -> '1:15' */
export function formatDuration(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
}
export function formatBytes(n) {
  if (!Number.isFinite(n)) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
export function round(n, dp = 1) {
  const f = 10 ** dp;
  return Math.round((Number(n) || 0) * f) / f;
}
export function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escape ANY model/user text before putting it in innerHTML. */
export function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}

/** Tagged template that escapes every interpolation unless wrapped with raw(). */
export function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < vals.length) out += toHtml(vals[i]);
  });
  return new RawHtml(out);
}
class RawHtml { constructor(s) { this.s = s; } toString() { return this.s; } }
export function raw(s) { return new RawHtml(String(s ?? '')); }
function toHtml(v) {
  if (v == null || v === false) return '';
  if (v instanceof RawHtml) return v.s;
  if (Array.isArray(v)) return v.map(toHtml).join('');
  return escapeHtml(v);
}

/** Character-level diff (LCS) for short strings → [{type:'same'|'del'|'ins', text}] */
export function diffChars(a, b) {
  a = Array.from(String(a ?? '')); b = Array.from(String(b ?? ''));
  if (a.length * b.length > 250000) {
    return [{ type: 'del', text: a.join('') }, { type: 'ins', text: b.join('') }];
  }
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  const push = (type, ch) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += ch; else out.push({ type, text: ch });
  };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { push('same', a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push('del', a[i]); i++; }
    else { push('ins', b[j]); j++; }
  }
  while (i < n) push('del', a[i++]);
  while (j < m) push('ins', b[j++]);
  return out;
}

// ---------- Streaks (pure) ----------

/** Entry counts toward the streak only if it is long enough. */
export function isQualifying(entry, minSeconds = 60) {
  return !!entry && Number(entry.durationSec) >= Number(minSeconds);
}

/**
 * computeStreaks(entries, minSeconds, today='YYYY-MM-DD')
 * -> { current, best, todayDone, qualifyingDates:Set<string> }
 * Today not yet done does NOT break the streak (counts back from yesterday).
 */
export function computeStreaks(entries, minSeconds = 60, today = localDateStr()) {
  const qualifyingDates = new Set();
  for (const e of entries || []) {
    if (isQualifying(e, minSeconds) && e.date) qualifyingDates.add(e.date);
  }
  const todayDone = qualifyingDates.has(today);
  let current = 0;
  let cursor = todayDone ? today : addDays(today, -1);
  while (qualifyingDates.has(cursor)) { current++; cursor = addDays(cursor, -1); }

  const sorted = [...qualifyingDates].sort();
  let best = 0, run = 0, prev = null;
  for (const d of sorted) {
    run = prev && daysBetween(prev, d) === 1 ? run + 1 : 1;
    if (run > best) best = run;
    prev = d;
  }
  return { current, best: Math.max(best, current), todayDone, qualifyingDates };
}

/** Sum of durationSec per local date. */
export function secondsByDate(entries) {
  const m = new Map();
  for (const e of entries || []) m.set(e.date, (m.get(e.date) || 0) + (Number(e.durationSec) || 0));
  return m;
}

/** Last ~N correction strings from most recent entries, for analyzeEntry({recentMistakes}). */
export function collectRecentMistakes(entries, limit = 15) {
  const out = [];
  const sorted = [...(entries || [])].sort((a, b) => b.createdAt - a.createdAt);
  for (const e of sorted) {
    const cs = e.analysis?.corrections || [];
    for (const c of cs) {
      if (!c?.corrected) continue;
      out.push(`${c.type || 'other'}: ${c.original ? c.original + ' → ' : ''}${c.corrected}`);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

export function averageScore(scores) {
  if (!scores) return null;
  const v = Object.values(scores).filter((x) => Number.isFinite(x));
  return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Let the browser paint before heavy sync work. */
export const nextPaint = () => new Promise((r) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(r, 0));
  else setTimeout(r, 0);
});

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
