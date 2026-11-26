// today.js — prompt, record button, pipeline progress, today's entries.
import { html, raw, formatDateJa, formatDuration, localDateStr } from '../util.js';
import { getPromptForDate, promptIndexForDate, randomPromptIndex, PROMPTS } from '../prompts.js';
import { icons } from './icons.js';
import { entryItem } from './common.js';

const RING_R = 70;
const RING_C = 2 * Math.PI * RING_R;

const REC_ERRORS = {
  permission: 'Microphone access is blocked. On iPhone: Settings → Apps → Safari (or this app) → Microphone, or tap “aA” → Website Settings → Microphone → Allow. Then try again.',
  unsupported: 'Recording isn’t supported in this browser. Use Safari on iPhone (iOS 16.4+) or Chrome on Android, over HTTPS.',
  no_device: 'No microphone is available — it may be in use by another app (a call, voice memo…). Close it and try again.',
};

const STEPS = [
  ['save', 'Saved to your phone', '保存'],
  ['decode', 'Preparing the audio', '変換'],
  ['measure', 'Measuring pace, pauses & pitch', '分析'],
  ['ai', 'Getting feedback from Gemini', '添削'],
];

function currentPrompt(app, today) {
  const tp = app.settings.todayPrompt;
  if (tp && tp.date === today && PROMPTS[tp.index]) return { prompt: PROMPTS[tp.index], index: tp.index };
  return { prompt: getPromptForDate(today), index: promptIndexForDate(today) };
}

export async function render(root, app) {
  const today = localDateStr();
  let { prompt, index } = currentPrompt(app, today);
  const minSec = Number(app.settings.minSeconds) || 60;
  const offs = [];
  let ctrl = null, timerId = 0, wakeLock = null, busy = false, lastLevel = 0;

  root.innerHTML = String(html`
    <header class="page-head">
      <div>
        <p class="eyebrow">${formatDateJa(today)}</p>
        <h1 lang="ja">今日の日記</h1>
      </div>
      <a href="#/calendar" class="streak-chip" data-streak aria-label="Streak"></a>
    </header>

    <section class="card prompt-card" aria-labelledby="prompt-label">
      <div class="prompt-head">
        <span id="prompt-label" class="label">今日のお題 · Today’s prompt</span>
        <button class="icon-btn" data-shuffle aria-label="Shuffle prompt" title="Another prompt">${raw(icons.shuffle)}</button>
      </div>
      <p class="prompt-ja" lang="ja" data-pja></p>
      <p class="prompt-en" data-pen></p>
    </section>

    <section class="recorder" aria-label="Recorder">
      <div class="rec-wrap">
        <div class="rec-halo" data-halo></div>
        <svg class="rec-ring" viewBox="0 0 160 160" aria-hidden="true">
          <circle cx="80" cy="80" r="${RING_R}" class="ring-track"/>
          <circle cx="80" cy="80" r="${RING_R}" class="ring-fill" data-ring
            stroke-dasharray="${RING_C}" stroke-dashoffset="${RING_C}" transform="rotate(-90 80 80)"/>
        </svg>
        <button class="rec-btn" data-rec aria-label="Start recording">${raw(icons.mic)}</button>
      </div>
      <div class="rec-timer" data-timer aria-live="off">0:00</div>
      <div class="minbar" role="progressbar" aria-label="Minimum length" aria-valuemin="0" aria-valuemax="${minSec}" aria-valuenow="0" data-minbar>
        <div class="minbar-fill" data-minfill></div>
      </div>
      <p class="rec-hint" data-hint>Tap to start. Speak for ${formatDuration(minSec)} or more to keep your streak.</p>
      <button class="btn btn-ghost btn-small" data-cancel hidden>Discard recording</button>
      <div class="rec-error" data-recerr role="alert" hidden></div>
    </section>

    <section class="card pipeline" data-pipeline hidden aria-live="polite">
      <h2 class="card-title">Processing</h2>
      <ol class="steps">
        ${STEPS.map(([id, label, ja]) => html`<li data-step="${id}" class="step"><span class="step-dot" aria-hidden="true"></span>
          <span class="step-label">${label} <span class="step-ja" lang="ja">${ja}</span></span><span class="step-info" data-info></span></li>`)}
      </ol>
    </section>

    <section class="card nudge" data-nudge hidden>
      <p><b>Your entry is saved and counts for today.</b> To get corrections and pronunciation feedback, add a free Gemini API key.</p>
      <a class="btn btn-primary" href="#/settings">Add API key in Settings</a>
    </section>

    <section class="today-list" aria-labelledby="today-h">
      <h2 id="today-h" class="section-title">今日の記録 · Today’s entries</h2>
      <ul class="entry-list" data-list></ul>
    </section>`);

  const $ = (s) => root.querySelector(s);
  const recBtn = $('[data-rec]'), timerEl = $('[data-timer]'), fill = $('[data-minfill]'), ring = $('[data-ring]');
  const halo = $('[data-halo]'), hint = $('[data-hint]'), cancelBtn = $('[data-cancel]'), errEl = $('[data-recerr]');
  const minbar = $('[data-minbar]');

  function paintPrompt() {
    $('[data-pja]').textContent = prompt.ja;
    $('[data-pen]').textContent = prompt.en;
  }
  function paintStreak() {
    const s = app.streaks();
    const el = $('[data-streak]');
    el.innerHTML = `${icons.flame}<span>${s.current}</span><small lang="ja">日</small>`;
    el.classList.toggle('done', s.todayDone);
    el.setAttribute('aria-label', `Current streak ${s.current} days${s.todayDone ? ', today done' : ''}`);
  }
  function paintList() {
    const list = app.entries.filter((e) => e.date === today).sort((a, b) => b.createdAt - a.createdAt);
    $('[data-list]').innerHTML = list.length
      ? list.map((e) => String(entryItem(e, minSec))).join('')
      : `<li class="muted empty-line">No entries yet today. お題について話してみましょう。</li>`;
  }
  paintPrompt(); paintStreak(); paintList();

  $('[data-shuffle]').addEventListener('click', async () => {
    if (ctrl) return;
    index = randomPromptIndex(index);
    prompt = PROMPTS[index];
    paintPrompt();
    await app.setSetting('todayPrompt', { date: today, index });
  });

  function setProgress(sec) {
    const p = Math.min(1, sec / minSec);
    fill.style.width = `${p * 100}%`;
    ring.setAttribute('stroke-dashoffset', String(RING_C * (1 - p)));
    minbar.setAttribute('aria-valuenow', String(Math.floor(Math.min(sec, minSec))));
    const reached = sec >= minSec;
    minbar.classList.toggle('reached', reached);
    ring.classList.toggle('reached', reached);
    timerEl.textContent = formatDuration(sec);
    if (ctrl) {
      hint.textContent = reached ? '✓ Long enough for your streak — keep going or tap stop.'
        : `${formatDuration(minSec - sec)} more to count for your streak`;
    }
  }

  function showRecError(msg) {
    errEl.textContent = msg;
    errEl.hidden = false;
    errEl.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }

  function setRecordingUI(on) {
    app.isRecording = on;
    document.body.classList.toggle('recording', on);
    recBtn.classList.toggle('is-recording', on);
    recBtn.innerHTML = on ? icons.stop : icons.mic;
    recBtn.setAttribute('aria-label', on ? 'Stop recording' : 'Start recording');
    cancelBtn.hidden = !on;
    if (!on) { halo.style.transform = 'scale(1)'; halo.style.opacity = '0'; }
  }

  function onLevel(level) {
    lastLevel = lastLevel * 0.6 + Math.max(0, Math.min(1, level)) * 0.4;
    halo.style.transform = `scale(${1 + lastLevel * 0.45})`;
    halo.style.opacity = String(0.25 + lastLevel * 0.6);
  }

  async function acquireWakeLock() {
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }
  }
  function releaseWakeLock() { try { wakeLock?.release(); } catch { /* */ } wakeLock = null; }

  function start() {
    errEl.hidden = true;
    const audio = app.audio;
    if (!audio) {
      recBtn.disabled = true;
      hint.textContent = 'Loading recorder…';
      app.loadAudio().then(() => { recBtn.disabled = false; hint.textContent = 'Ready — tap to start.'; })
        .catch(() => { recBtn.disabled = false; showRecError('The recorder failed to load. Check your connection and reload the app.'); });
      return;
    }
    if (!audio.isRecordingSupported()) { showRecError(REC_ERRORS.unsupported); return; }
    busy = true;
    recBtn.disabled = true;
    let p;
    try {
      p = audio.startRecording({ onLevel }); // called synchronously inside the tap (iOS gesture)
    } catch (e) { p = Promise.reject(e); }
    p.then((c) => {
      ctrl = c;
      busy = false;
      recBtn.disabled = false;
      setRecordingUI(true);
      acquireWakeLock();
      setProgress(0);
      timerId = setInterval(() => setProgress(ctrl ? ctrl.elapsedSec() : 0), 200);
    }).catch((e) => {
      busy = false;
      recBtn.disabled = false;
      console.warn('startRecording failed', e);
      showRecError(REC_ERRORS[e?.code] || e?.message || 'Could not start recording.');
    });
  }

  async function stop() {
    if (!ctrl || busy) return;
    busy = true;
    recBtn.disabled = true;
    clearInterval(timerId);
    const c = ctrl;
    let result;
    try {
      result = await c.stop();
    } catch (e) {
      ctrl = null; busy = false; recBtn.disabled = false;
      setRecordingUI(false); releaseWakeLock();
      if (e?.code !== 'cancelled') showRecError(`Recording failed: ${e?.message || e}`);
      return;
    }
    ctrl = null;
    setRecordingUI(false);
    releaseWakeLock();
    if (!result?.blob || result.blob.size === 0 || (result.durationSec || 0) < 1.5) {
      busy = false; recBtn.disabled = false;
      setProgress(0);
      hint.textContent = 'That was too short to save. Tap to try again.';
      return;
    }
    await runPipeline(result);
  }

  async function runPipeline(result) {
    const pipe = $('[data-pipeline]');
    pipe.hidden = false;
    pipe.querySelectorAll('.step').forEach((li) => { li.className = 'step'; li.querySelector('[data-info]').textContent = ''; });
    recBtn.disabled = true;
    hint.textContent = result.durationSec >= minSec ? 'Nice! Saving…' : `Saved — but shorter than ${formatDuration(minSec)}, so it won’t count for the streak.`;
    let outcome = {};
    let entryId = null;
    const onStep = (step, state, info) => {
      const li = pipe.querySelector(`[data-step="${step}"]`);
      if (!li) return;
      li.className = `step step-${state}`;
      li.querySelector('[data-info]').textContent = info || (state === 'skip' ? 'skipped' : '');
      if (step === 'ai' && state === 'skip') outcome.needsKey = !app.settings.apiKey;
    };
    try {
      entryId = await app.saveRecording(result, prompt, onStep);
    } catch (e) {
      console.error(e);
      showRecError(e?.code === 'quota' ? e.message : `Could not save the entry: ${e?.message || e}`);
      busy = false; recBtn.disabled = false;
      return;
    }
    busy = false;
    recBtn.disabled = false;
    setProgress(0);
    paintList(); paintStreak();
    if (outcome.needsKey) {
      $('[data-nudge]').hidden = false;
      app.toast('Saved! Add a Gemini key in Settings to get feedback.', { action: 'Open entry', onAction: () => app.navigate(`#/entry/${entryId}`) });
      return;
    }
    setTimeout(() => { if (location.hash.startsWith('#/today') || !location.hash) app.navigate(`#/entry/${encodeURIComponent(entryId)}`); }, 700);
  }

  recBtn.addEventListener('click', () => { if (ctrl) stop(); else if (!busy) start(); });
  cancelBtn.addEventListener('click', async () => {
    if (!ctrl) return;
    const ok = await app.confirm({ title: 'Discard this recording?', body: 'It will not be saved.', ok: 'Discard', danger: true });
    if (!ok || !ctrl) return;
    clearInterval(timerId);
    try { ctrl.cancel(); } catch { /* */ }
    ctrl = null;
    setRecordingUI(false); releaseWakeLock(); setProgress(0);
    hint.textContent = 'Discarded. Tap to start again.';
  });

  offs.push(app.on('entries', () => { paintList(); paintStreak(); }));
  offs.push(app.on('entry', () => paintList()));
  offs.push(app.on('visible', () => {
    if (!ctrl && localDateStr() !== today) app.navigate('#/today');
    else if (ctrl && wakeLock == null) acquireWakeLock();
  }));

  return () => {
    offs.forEach((f) => f());
    clearInterval(timerId);
    if (ctrl) { try { ctrl.cancel(); } catch { /* */ } ctrl = null; }
    app.isRecording = false;
    document.body.classList.remove('recording');
    releaseWakeLock();
  };
}
