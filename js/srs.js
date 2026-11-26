// srs.js — SM-2-lite spaced repetition. PURE (no DOM / no DB), node-testable.
import { startOfLocalDay } from './util.js';

export const GRADES = ['again', 'hard', 'good', 'easy'];
const MIN_EASE = 1.3;
const MAX_INTERVAL = 365;
const RELEARN_MS = 10 * 60 * 1000; // "again" → see it again in 10 minutes

/** Normalise a card front for de-duplication. */
export function normaliseFront(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s　]+/g, '')
    .replace(/[。、．，,.!?！？「」『』（）()【】・…~〜"'“”]/g, '');
}

export function newCard({ front, back = '', note = '', kind = 'vocab', sourceEntryId = null }, now = Date.now()) {
  return {
    id: `c-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    front: String(front ?? ''), back: String(back ?? ''), note: String(note ?? ''),
    kind: ['correction', 'vocab', 'pronunciation', 'pitch'].includes(kind) ? kind : 'vocab',
    sourceEntryId, createdAt: now, due: now, interval: 0, ease: 2.5, reps: 0, lapses: 0,
  };
}

/**
 * Build new cards from analysis.cards, skipping any whose normalised front already
 * exists (in `existing` or earlier in the same batch).
 */
export function cardsFromAnalysis(analysisCards, sourceEntryId, existing = [], now = Date.now()) {
  const seen = new Set(existing.map((c) => normaliseFront(c.front)));
  const out = [];
  for (const c of analysisCards || []) {
    const key = normaliseFront(c?.front);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(newCard({ ...c, sourceEntryId }, now + out.length));
  }
  return out;
}

/** Returns the card after grading (new object). grade ∈ GRADES. */
export function review(card, grade, now = Date.now()) {
  if (!GRADES.includes(grade)) throw new Error(`bad grade ${grade}`);
  const c = { ...card };
  let ease = Number(c.ease) || 2.5;
  let interval = Number(c.interval) || 0;
  let reps = Number(c.reps) || 0;

  if (grade === 'again') {
    c.lapses = (Number(c.lapses) || 0) + 1;
    c.reps = 0;
    c.interval = 0;
    c.ease = Math.max(MIN_EASE, round2(ease - 0.2));
    c.due = now + RELEARN_MS;
    c.lastReviewed = now;
    return c;
  }
  if (grade === 'hard') {
    interval = reps === 0 ? 1 : Math.max(interval + 1, Math.round(interval * 1.2));
    ease = Math.max(MIN_EASE, ease - 0.15);
  } else if (grade === 'good') {
    interval = reps === 0 ? 1 : reps === 1 ? 3 : Math.max(interval + 1, Math.round(interval * ease));
  } else { // easy
    interval = reps === 0 ? 3 : reps === 1 ? 5 : Math.max(interval + 2, Math.round(interval * ease * 1.3));
    ease = ease + 0.15;
  }
  c.interval = Math.min(MAX_INTERVAL, interval);
  c.ease = round2(ease);
  c.reps = reps + 1;
  // Due at the start of the local day `interval` days from now, so it's ready in the morning.
  const d = new Date(startOfLocalDay(now));
  c.due = new Date(d.getFullYear(), d.getMonth(), d.getDate() + c.interval).getTime();
  c.lastReviewed = now;
  return c;
}

/** Human label for what each grade would schedule ('10m', '1d', '3d', '2mo'). */
export function previewIntervals(card, now = Date.now()) {
  const out = {};
  for (const g of GRADES) {
    const r = review(card, g, now);
    out[g] = g === 'again' ? '10m' : formatInterval(r.interval);
  }
  return out;
}

export function formatInterval(days) {
  if (days < 1) return '<1d';
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${round2(days / 365)}y`;
}

export function isDue(card, now = Date.now()) { return (Number(card.due) || 0) <= now; }

export function dueCards(cards, now = Date.now()) {
  return (cards || []).filter((c) => isDue(c, now)).sort((a, b) => a.due - b.due);
}

function round2(x) { return Math.round(x * 100) / 100; }
