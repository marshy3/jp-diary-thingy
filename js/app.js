// app.js — shell, router, state, analysis pipeline, pending queue, SW registration.
import * as db from './db.js';
import { localDateStr, computeStreaks, collectRecentMistakes, nextPaint, escapeHtml, sleep } from './util.js';
import { cardsFromAnalysis } from './srs.js';
import { checkReminder } from './reminders.js';
import { icons } from './views/icons.js';
import * as todayView from './views/today.js';
import * as entryView from './views/entry.js';
import * as calendarView from './views/calendar.js';
import * as reviewView from './views/review.js';
import * as trendsView from './views/trends.js';
import * as settingsView from './views/settings.js';

// ---------- lazily loaded modules owned by other agents ----------
let audioP = null, aiP = null;
export function loadAudio() {
  if (!audioP) {
    audioP = Promise.all([import('./recorder.js'), import('./wav.js'), import('./audio-analysis.js')])
      .then(([r, w, a]) => (app.audio = { ...r, ...w, ...a }));
    audioP.catch((e) => { console.error('audio modules failed to load', e); audioP = null; });
  }
  return audioP;
}
export function loadAI() {
  if (!aiP) {
    aiP = import('./ai.js');
    aiP.catch((e) => { console.error('ai module failed to load', e); aiP = null; });
  }
  return aiP;
}

// ---------- state + events ----------
const bus = new EventTarget();
export const app = {
  settings: { ...db.DEFAULT_SETTINGS },
  entries: [],
  cards: [],
  isRecording: false,
  audio: null, // resolved audio modules (recorder+wav+analysis) once loaded
  online: typeof navigator !== 'undefined' ? navigator.onLine !== false : true,
  db,
  loadAudio,
  loadAI,
  on(type, fn) { const h = (e) => fn(e.detail); bus.addEventListener(type, h); return () => bus.removeEventListener(type, h); },
  emit(type, detail) { bus.dispatchEvent(new CustomEvent(type, { detail })); },
  navigate(hash) { if (location.hash === hash) route(); else location.hash = hash; },
  toast,
  confirm: confirmDialog,
  today: () => localDateStr(),
  streaks() { return computeStreaks(app.entries, app.settings.minSeconds, localDateStr()); },
  async setSetting(key, value) {
    await db.setSetting(key, value);
    app.settings[key] = value;
    app.emit('settings', { key, value });
  },
  async reloadAll() {
    const [settings, entries, cards] = await Promise.all([db.getSettings(), db.getAllEntries(), db.getAllCards()]);
    app.settings = settings; app.entries = entries; app.cards = cards;
    app.emit('entries'); app.emit('cards');
  },
  getEntry(id) { return app.entries.find((e) => e.id === id) || null; },
  async patchEntry(id, patch) {
    const next = await db.updateEntry(id, patch);
    if (next) {
      const i = app.entries.findIndex((e) => e.id === id);
      if (i >= 0) app.entries[i] = next; else app.entries.push(next);
      app.emit('entry', next);
    }
    return next;
  },
  async deleteEntry(id) {
    await db.deleteEntry(id);
    app.entries = app.entries.filter((e) => e.id !== id);
    app.emit('entries');
    refreshReminder();
  },
  saveRecording,
  analyzeEntryById,
  runQueue,
  friendlyAIError,
  inFlight: new Set(),
  /** id -> { startedAt, model, attempt, previousError } while a Gemini request is running */
  progress: new Map(),
  /** id -> AbortController for the running analysis (Cancel button) */
  aborts: new Map(),
  cancelAnalysis(id) { app.aborts.get(id)?.abort(); },
};

// ---------- pipeline ----------

/**
 * Save a finished recording immediately (status 'saved'), then measure + analyze.
 * onStep(step, state, info) where step ∈ save|decode|measure|ai and state ∈ active|done|skip|error.
 */
async function saveRecording({ blob, mimeType, durationSec }, prompt, onStep = () => {}) {
  const createdAt = Date.now();
  const date = localDateStr(new Date(createdAt));
  const id = `${date}-${createdAt}`;
  const entry = {
    id, date, createdAt, durationSec: Math.round((Number(durationSec) || 0) * 10) / 10,
    prompt: prompt ? { ja: prompt.ja, en: prompt.en } : null, audioId: id,
    metrics: null, analysis: null, status: 'saved', error: null,
  };
  onStep('save', 'active');
  await db.saveEntryWithAudio(entry, { id, blob, mimeType: mimeType || blob.type });
  app.entries.push(entry);
  app.emit('entries');
  onStep('save', 'done');
  refreshReminder();
  if (app.entries.length <= 3) db.requestPersist(); // ask early so iOS doesn't evict the diary
  try {
    await analyzeEntryById(id, { onStep });
  } catch (e) {
    console.warn('analysis failed', e);
    if (e?.code === 'rate_limit') scheduleQueue(e.retryAfterSec);
  }
  return id;
}

/**
 * Measure (if needed) then send to Gemini (if key). Throws on AI failure (entry is updated first).
 * Returns { needsKey?:true, analysis? }.
 */
async function analyzeEntryById(id, { onStep = () => {}, force = false, signal: outerSignal } = {}) {
  if (app.inFlight.has(id)) throw Object.assign(new Error('Already analyzing this entry.'), { code: 'busy' });
  app.inFlight.add(id);
  const ctl = new AbortController();
  outerSignal?.addEventListener?.('abort', () => ctl.abort(), { once: true });
  app.aborts.set(id, ctl);
  const signal = ctl.signal;
  try {
    let entry = app.getEntry(id) || await db.getEntry(id);
    if (!entry) throw new Error('Entry not found');
    const audioRec = await db.getAudio(entry.audioId);
    if (!audioRec?.blob) throw Object.assign(new Error('The audio for this entry is missing.'), { code: 'no_audio' });
    const audio = await loadAudio();

    const storedIsWav = /wav/i.test(audioRec.mimeType || audioRec.blob.type || '');
    let pcm = null;
    let wavBlob = storedIsWav ? audioRec.blob : null;

    // 1) decode (skipped when we already have metrics + a WAV to send)
    if (!entry.metrics || force || !wavBlob) {
      onStep('decode', 'active');
      await nextPaint();
      try {
        pcm = await audio.blobToMonoPCM(audioRec.blob, 16000);
      } catch (e) {
        const msg = 'Could not decode the recording on this device.';
        onStep('decode', 'error', msg);
        await app.patchEntry(id, { status: 'error', error: msg });
        throw Object.assign(new Error(msg), { code: 'decode', cause: e });
      }
      // Replace the original (webm/mp4) with a 16 kHz WAV: plays everywhere incl. iOS, and is what Gemini gets.
      if (!storedIsWav) {
        try {
          wavBlob = audio.encodeWav(pcm.samples, pcm.sampleRate);
          await db.putAudio({ id: entry.audioId, blob: wavBlob, mimeType: 'audio/wav' });
          app.emit('audio', id);
        } catch (e) {
          console.warn('could not store WAV, keeping original', e);
          wavBlob = wavBlob || audio.encodeWav(pcm.samples, pcm.sampleRate);
        }
      }
      onStep('decode', 'done');
    } else {
      onStep('decode', 'done');
    }

    // 2) local metrics
    if (pcm && (!entry.metrics || force)) {
      onStep('measure', 'active');
      await nextPaint();
      let metrics;
      try {
        metrics = audio.analyzeAudio(pcm.samples, pcm.sampleRate);
        onStep('measure', 'done');
      } catch (e) {
        console.warn('analyzeAudio failed', e);
        metrics = typeof audio.emptyMetrics === 'function' ? audio.emptyMetrics(pcm.samples.length / pcm.sampleRate) : null;
        onStep('measure', 'error', 'Local voice measurements failed (continuing).');
      }
      const patch = { metrics };
      // Decoded duration is the truth (stop()'s wall-clock time includes start-up latency).
      if (metrics && Number.isFinite(metrics.durationSec) && metrics.durationSec > 0) {
        patch.durationSec = Math.round(metrics.durationSec * 10) / 10;
      }
      entry = await app.patchEntry(id, patch);
      app.emit('entries');
      await nextPaint();
    } else {
      onStep('measure', 'done');
    }
    pcm = null;

    // 3) Gemini
    const { apiKey, model, level } = app.settings;
    if (!apiKey) {
      onStep('ai', 'skip', 'No Gemini key yet');
      if (entry.status !== 'saved') entry = await app.patchEntry(id, { status: 'saved', error: null });
      return { needsKey: true };
    }
    if (!app.online && typeof navigator !== 'undefined' && navigator.onLine === false) {
      onStep('ai', 'skip', 'Offline — will analyze when you are back online');
      await app.patchEntry(id, { status: 'saved', error: null });
      return { offline: true };
    }
    onStep('ai', 'active');
    entry = await app.patchEntry(id, { status: 'analyzing', error: null });
    try {
      const ai = await loadAI();
      const others = app.entries.filter((e) => e.id !== id);
      const analysis = await ai.analyzeEntry({
        apiKey,
        model: model || ai.DEFAULT_MODEL,
        wavBlob,
        metrics: entry.metrics,
        prompt: entry.prompt || { ja: '', en: '' },
        level: level || 'N3',
        recentMistakes: collectRecentMistakes(others, 15),
        signal,
        onProgress: (info) => {
          const prev = app.progress.get(id);
          app.progress.set(id, { startedAt: prev?.startedAt || Date.now(), ...info });
          app.emit('progress', id);
          onStep('ai', 'active', info.attempt > 1 ? `First model busy, trying ${info.model}…` : '');
        },
      });
      await app.patchEntry(id, { analysis, status: 'done', error: null });
      const newCards = cardsFromAnalysis(analysis?.cards, id, app.cards);
      if (newCards.length) {
        await db.putCards(newCards);
        app.cards.push(...newCards);
        app.emit('cards');
      }
      onStep('ai', 'done', newCards.length ? `${newCards.length} new flashcard${newCards.length > 1 ? 's' : ''}` : '');
      return { analysis, newCards: newCards.length };
    } catch (e) {
      const msg = friendlyAIError(e);
      await app.patchEntry(id, { status: 'error', error: msg });
      onStep('ai', 'error', msg);
      throw e;
    }
  } finally {
    app.inFlight.delete(id);
    app.aborts.delete(id);
    app.progress.delete(id);
    app.emit('progress', id);
  }
}

export function friendlyAIError(e) {
  const code = e?.code;
  switch (code) {
    case 'auth': return 'Gemini rejected the API key. Check it in Settings (it may have been deleted or mistyped).';
    case 'rate_limit': return `Gemini’s free-tier limit was reached. Your entry is saved and will be analyzed automatically${e.retryAfterSec ? ` in about ${Math.ceil(e.retryAfterSec)}s` : ' later'}.`;
    case 'network': {
      const detail = String(e?.message || '').slice(0, 200);
      if (e?.status >= 500) return `Gemini’s servers are busy right now (tried several models). Your entry is saved; tap Re-analyze in a few minutes. Details: ${detail}`;
      return `Couldn’t reach Gemini. Your entry is saved and will be analyzed when the connection works. Details: ${detail}`;
    }
    case 'bad_response': return `Gemini couldn’t process the request. Tap Re-analyze to try again. Details: ${String(e?.message || '').slice(0, 200)}`;
    case 'too_large': return 'This recording is too large to send to Gemini. Try a shorter entry next time.';
    case 'model': return 'The selected Gemini model isn’t available for this key. Pick another model in Settings.';
    case 'aborted': return 'Analysis was cancelled.';
    case 'decode': case 'no_audio': return e.message;
    default: return `Analysis failed: ${e?.message || 'unknown error'}`;
  }
}

// ---------- pending queue ----------
let queueRunning = false, queueTimer = 0;
const sessionFailures = new Map(); // id -> count this session

/** Retry the queue after a rate limit (respects AIError.retryAfterSec; 2s..1h, default 60s). */
function scheduleQueue(retryAfterSec) {
  const wait = Math.max(2, Math.min(3600, Number(retryAfterSec) || 60));
  clearTimeout(queueTimer);
  queueTimer = setTimeout(runQueue, wait * 1000);
}

async function runQueue() {
  if (queueRunning) return;
  if (!app.settings.apiKey) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  queueRunning = true;
  clearTimeout(queueTimer);
  try {
    const pending = app.entries
      .filter((e) => !e.analysis && ['saved', 'error', 'analyzing'].includes(e.status) && !app.inFlight.has(e.id))
      .filter((e) => (sessionFailures.get(e.id) || 0) < 1)
      .sort((a, b) => a.createdAt - b.createdAt);
    const doneIds = [];
    for (const e of pending) {
      if (!app.settings.apiKey) break;
      try {
        await analyzeEntryById(e.id);
        doneIds.push(e.id);
      } catch (err) {
        const code = err?.code;
        if (code === 'rate_limit') { scheduleQueue(err.retryAfterSec); break; }
        if (code === 'auth' || code === 'model' || code === 'network' || code === 'aborted') break;
        if (code === 'busy') continue;
        sessionFailures.set(e.id, (sessionFailures.get(e.id) || 0) + 1);
      }
      await sleep(1500); // be gentle with the free tier
    }
    if (doneIds.length === 1 && !location.hash.includes(doneIds[0])) {
      toast('Feedback is ready for a saved entry.', { action: 'View', onAction: () => app.navigate(`#/entry/${encodeURIComponent(doneIds[0])}`) });
    } else if (doneIds.length > 1) {
      toast(`Feedback is ready for ${doneIds.length} saved entries.`, { action: 'Calendar', onAction: () => app.navigate('#/calendar') });
    }
  } finally {
    queueRunning = false;
  }
}

// ---------- reminders ----------
function refreshReminder() {
  const { todayDone } = app.streaks();
  checkReminder({ reminderTime: app.settings.reminderTime, todayDone }).catch(() => {});
}

// ---------- toasts & dialogs ----------
function toast(message, { action, onAction, kind = 'info', timeout } = {}) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.innerHTML = `<span>${escapeHtml(message)}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-action';
    b.textContent = action;
    b.addEventListener('click', () => { onAction?.(); el.remove(); });
    el.appendChild(b);
  }
  const close = document.createElement('button');
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';
  close.addEventListener('click', () => el.remove());
  el.appendChild(close);
  host.appendChild(el);
  while (host.children.length > 2) host.firstElementChild.remove();
  const ms = timeout ?? (kind === 'error' ? 9000 : action ? 8000 : 3500);
  if (ms > 0) setTimeout(() => el.remove(), ms);
  return el;
}

function confirmDialog({ title, body = '', ok = 'OK', cancel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const dlg = document.getElementById('modal');
    dlg.innerHTML = `<form method="dialog" class="modal-body">
      <h2>${escapeHtml(title)}</h2>${body ? `<p>${escapeHtml(body)}</p>` : ''}
      <div class="modal-actions">
        <button value="cancel" class="btn btn-ghost">${escapeHtml(cancel)}</button>
        <button value="ok" class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${escapeHtml(ok)}</button>
      </div></form>`;
    const onClose = () => { dlg.removeEventListener('close', onClose); resolve(dlg.returnValue === 'ok'); };
    dlg.addEventListener('close', onClose);
    dlg.returnValue = '';
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else resolve(window.confirm(`${title}\n\n${body}`));
  });
}

// ---------- shell + router ----------
const TABS = [
  { id: 'today', label: '今日', en: 'Today', icon: icons.today },
  { id: 'calendar', label: '記録', en: 'Calendar', icon: icons.calendar },
  { id: 'review', label: '復習', en: 'Review', icon: icons.review },
  { id: 'trends', label: '成長', en: 'Trends', icon: icons.trends },
  { id: 'settings', label: '設定', en: 'Settings', icon: icons.settings },
];
const VIEWS = { today: todayView, calendar: calendarView, review: reviewView, trends: trendsView, settings: settingsView, entry: entryView };

function renderShell() {
  const root = document.getElementById('app');
  root.innerHTML = `
    <main id="view" tabindex="-1"></main>
    <nav class="tabbar" aria-label="Main">
      ${TABS.map((t) => `<a href="#/${t.id}" class="tab" data-tab="${t.id}" aria-label="${t.en}">
        ${t.icon}<span class="tab-ja" aria-hidden="true">${t.label}</span><span class="tab-en">${t.en}</span>
        ${t.id === 'review' ? '<span class="tab-badge" hidden></span>' : ''}</a>`).join('')}
    </nav>`;
  root.querySelector('.tabbar').addEventListener('click', (ev) => {
    if (app.isRecording && ev.target.closest('a')) {
      ev.preventDefault();
      toast('Stop the recording first.', { kind: 'warn' });
    }
  });
  updateReviewBadge();
}

function updateReviewBadge() {
  const b = document.querySelector('.tab-badge');
  if (!b) return;
  const now = Date.now();
  const n = app.cards.filter((c) => c.due <= now).length;
  b.hidden = n === 0;
  b.textContent = n > 99 ? '99+' : String(n);
}

let cleanup = null;
let routeSeq = 0;
async function route() {
  const hash = location.hash || '#/today';
  const [, name = 'today', param] = hash.match(/^#\/([a-z]+)(?:\/(.+))?/) || [];
  const view = VIEWS[name] ? name : 'today';
  if (app.isRecording && view !== 'today') {
    toast('Stop the recording first.', { kind: 'warn' });
    history.replaceState(null, '', '#/today');
    return;
  }
  const seq = ++routeSeq;
  app.routeCount = (app.routeCount || 0) + 1;
  if (typeof cleanup === 'function') { try { cleanup(); } catch (e) { console.warn(e); } }
  cleanup = null;
  // Fresh element per route so listeners that views attach to their root never leak across views.
  const prev = document.getElementById('view');
  const main = prev.cloneNode(false);
  prev.replaceWith(main);
  main.className = `view view-${view}`;
  document.querySelectorAll('.tab').forEach((t) => {
    const active = t.dataset.tab === view;
    t.classList.toggle('active', active);
    if (active) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  });
  try {
    const c = await VIEWS[view].render(main, app, param ? decodeURIComponent(param) : undefined);
    if (seq !== routeSeq) { if (typeof c === 'function') c(); return; }
    cleanup = c;
  } catch (e) {
    console.error(e);
    main.innerHTML = `<div class="card error-card"><h2>Something went wrong</h2><p>${escapeHtml(e?.message || e)}</p></div>`;
  }
  window.scrollTo(0, 0);
}

// ---------- service worker ----------
let updateRequested = false;
function registerSW() {
  if (!('serviceWorker' in navigator) || window.HN_NO_SW) return;
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    const offer = (w) => {
      toast('A new version is ready.', {
        action: 'Reload', timeout: 0,
        onAction: () => { updateRequested = true; w.postMessage({ type: 'SKIP_WAITING' }); },
      });
    };
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
      });
    });
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // Only reload when the user tapped "Reload" (not on first install's clients.claim()).
      if (!updateRequested || reloaded || app.isRecording) return;
      reloaded = true; location.reload();
    });
  }).catch((e) => console.warn('SW registration failed', e));
}

// ---------- boot ----------
async function boot() {
  renderShell();
  try {
    await app.reloadAll();
  } catch (e) {
    console.error(e);
    document.getElementById('view').innerHTML = `<div class="card error-card"><h2>Storage unavailable</h2>
      <p>${escapeHtml(e.message)}</p><p class="muted">Private browsing can block storage. Open the app normally or from the home screen.</p></div>`;
    return;
  }
  app.on('cards', updateReviewBadge);
  app.on('entries', () => app.emit('streak'));
  window.addEventListener('hashchange', route);
  await route();
  loadAudio().catch(() => {}); // warm the cache so the record button is instant
  registerSW();
  refreshReminder();
  setTimeout(runQueue, 1200);

  window.addEventListener('online', () => { app.online = true; app.emit('online', true); runQueue(); });
  window.addEventListener('offline', () => { app.online = false; app.emit('online', false); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    refreshReminder();
    updateReviewBadge();
    runQueue();
    app.emit('visible');
  });
  app.on('settings', ({ key }) => { if (key === 'apiKey') runQueue(); if (key === 'reminderTime') refreshReminder(); });
}

window.addEventListener('unhandledrejection', (ev) => {
  const m = ev.reason?.message || String(ev.reason || '');
  if (ev.reason?.code === 'quota') toast(m, { kind: 'error' });
  console.error('unhandled', ev.reason);
});

window.hanashi = app; // handy for debugging
boot();
