// entry.js — entry detail: player, contour chart, scores, transcript + corrections, notes.
// Everything from Gemini is untrusted: rendered only through html`` (auto-escaped) or textContent.
import { html, raw, formatDateJa, formatTime, formatDuration, round, diffChars, averageScore, isQualifying } from '../util.js';
import { contourChart } from '../charts.js';
import { icons } from './icons.js';
import { statusPill } from './common.js';

const SCORE_LABELS = [
  ['grammar', 'Grammar', '文法'],
  ['vocabulary', 'Vocabulary', '語彙'],
  ['fluency', 'Fluency', '流暢さ'],
  ['pronunciation', 'Pronunciation', '発音'],
  ['pitchAccent', 'Pitch accent', 'アクセント'],
];
const TYPE_LABEL = { grammar: 'grammar', particle: 'particle', conjugation: 'conjugation', vocab: 'vocab',
  word_choice: 'word choice', register: 'politeness', other: 'other' };
const PRON_LABEL = { long_vowel: 'long vowel', sokuon: 'small っ', n: 'ん', r: 'r-sound', tsu_su: 'つ/す',
  vowel: 'vowel', devoicing: 'devoicing', other: 'other' };

const ts = (sec) => formatDuration(sec);

function seekBtn(t, label = ts(t), cls = 'ts-btn') {
  return html`<button class="${cls}" data-seek="${Number(t) || 0}" aria-label="Play from ${ts(t)}">${raw(icons.play)}<span>${label}</span></button>`;
}
function snippetBtn(t) {
  return html`<button class="snip-btn" data-snip="${Number(t) || 0}" aria-label="Replay this moment at ${ts(t)}">${raw(icons.play)}<span>${ts(t)}</span></button>`;
}

function diffView(a, b) {
  const parts = diffChars(a, b);
  const before = parts.filter((p) => p.type !== 'ins').map((p) => p.type === 'del' ? html`<del>${p.text}</del>` : html`<span>${p.text}</span>`);
  const after = parts.filter((p) => p.type !== 'del').map((p) => p.type === 'ins' ? html`<ins>${p.text}</ins>` : html`<span>${p.text}</span>`);
  return html`<div class="diff"><div class="diff-row diff-before" lang="ja"><span class="diff-mark" aria-label="You said">✕</span><span>${before}</span></div>
    <div class="diff-row diff-after" lang="ja"><span class="diff-mark" aria-label="Better">○</span><span>${after}</span></div></div>`;
}

function moraPattern(s) {
  const m = String(s || '').match(/[HL]{1,12}/);
  const rest = String(s || '').replace(/[HL]{1,12}/, '').replace(/^[\s(（,:-]+|[\s)）]+$/g, '').trim();
  if (!m) return html`<span class="pattern-text">${s}</span>`;
  return html`<span class="mora" aria-label="${m[0]}">${[...m[0]].map((c) => html`<i class="${c === 'H' ? 'hi' : 'lo'}"></i>`)}</span>${rest ? html`<span class="pattern-text">${rest}</span>` : ''}`;
}

function scoreBars(scores) {
  const avg = averageScore(scores);
  return html`<div class="scores">
    <div class="score-overall"><span class="score-big">${avg ?? '—'}</span><span class="muted">overall</span></div>
    <ul class="score-bars">${SCORE_LABELS.map(([k, en, ja]) => {
      const v = Math.max(0, Math.min(100, Math.round(Number(scores?.[k]) || 0)));
      return html`<li><span class="score-name">${en} <span lang="ja" class="muted">${ja}</span></span>
        <span class="bar" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${v}" aria-label="${en}"><span style="width:${v}%"></span></span>
        <span class="score-val">${v}</span></li>`;
    })}</ul></div>`;
}

function describeRate(r) {
  if (!(r > 0)) return '';
  if (r < 3.5) return 'slow and careful';
  if (r < 5.5) return 'steady learner pace';
  if (r < 7.5) return 'fairly natural';
  return 'fast';
}

function fluencyStats(m, analysis) {
  if (!m) return '';
  const ratio = Math.round((m.speechRatio || 0) * 100);
  const trend = m.volume?.trendDbPerMin || 0;
  const rows = [
    ['Speaking time', `${ts(m.speechSec)} of ${ts(m.durationSec)}`, `${ratio}% of the recording was speech`],
    ['Overall pace', `${round(m.syllableRate, 1)} syll/s`, `${describeRate(m.syllableRate)} (rough estimate; relaxed native speech is often 6–8)`],
    ['Speed while talking', `${round(m.articulationRate, 1)} syll/s`, 'pace excluding pauses'],
    ['Pauses', `${m.pauses?.length || 0}`, `average ${round(m.meanPauseSec, 1)}s`],
    ['Long pauses (>1.2s)', `${m.longPauses?.length || 0}`, (m.longPauses?.length || 0) > 3 ? 'try bridging with そうですね… or ええと less often' : 'good flow'],
    ['Pitch range', `${round(m.pitch?.rangeSemitones, 1)} st`, (m.pitch?.rangeSemitones || 0) < 4 ? 'quite flat — let your voice rise and fall more' : 'lively, expressive range'],
    ['Volume', `${round(m.volume?.meanDb, 0)} dB`, trend < -1.5 ? 'fading towards the end — keep your energy up' : trend > 1.5 ? 'getting louder as you warm up' : 'steady'],
    ['Hesitation', `${Math.round(m.hesitationScore || 0)}/100`, 'lower is smoother'],
    ['Confidence', `${Math.round(m.confidenceScore || 0)}/100`, 'steady volume, pauses and pitch variety'],
  ];
  if (analysis?.fluency) rows.splice(5, 0, ['Fillers (ええと, あの…)', `${analysis.fluency.fillerCount ?? analysis.fluency.fillers?.length ?? 0}`, '']);
  return html`<dl class="stats">${rows.map(([k, v, d]) => html`<div class="stat"><dt>${k}</dt><dd><b>${v}</b>${d ? html`<span class="muted"> · ${d}</span>` : ''}</dd></div>`)}</dl>`;
}

export async function render(root, app, id) {
  let entry = app.getEntry(id) || (await app.db.getEntry(id));
  if (!entry) {
    root.innerHTML = String(html`<header class="page-head"><a class="back-btn" href="#/calendar" aria-label="Back">${raw(icons.back)}</a><h1>Entry not found</h1></header>
      <div class="card"><p>This entry doesn’t exist (it may have been deleted).</p></div>`);
    return;
  }
  const offs = [];
  let audioUrl = null, chart = null, stopAt = null;

  function body() {
    const a = entry.analysis, m = entry.metrics;
    const minSec = Number(app.settings.minSeconds) || 60;
    const hasKey = !!app.settings.apiKey;
    // Only a request that is actually running counts as busy. A stored 'analyzing' status with
    // nothing in flight means the app was closed/reloaded mid-request.
    const busy = app.inFlight.has(entry.id);
    let status = '';
    if (busy) {
      status = html`<div class="card status-card"><div class="spinner" aria-hidden="true"></div><div><p><b>Analyzing…</b> <span data-elapsed></span></p>
        <p class="small muted" data-progress>Gemini is listening to your entry. This usually takes 20–60 seconds.</p>
        <button class="btn btn-secondary" data-cancel>Cancel</button></div></div>`;
    } else if (!a && entry.status === 'analyzing') {
      status = html`<div class="card nudge" role="alert"><p><b>Analysis was interrupted</b> (the app was closed or reloaded while waiting for Gemini).</p><button class="btn btn-primary" data-reanalyze>Try again</button></div>`;
    } else if (!a && !hasKey) {
      status = html`<div class="card nudge"><p><b>Saved, no feedback yet.</b> Add a free Gemini API key to get corrections, a natural rewrite and pronunciation tips.</p>
        <a class="btn btn-primary" href="#/settings">Add API key</a></div>`;
    } else if (!a && entry.status === 'error') {
      status = html`<div class="card error-card" role="alert"><p>${entry.error || 'Analysis failed.'}</p><button class="btn btn-primary" data-reanalyze>Try again</button></div>`;
    } else if (!a) {
      status = html`<div class="card nudge"><p>Not analyzed yet${app.online ? '' : ' (you’re offline)'}.</p><button class="btn btn-primary" data-reanalyze ${app.online ? '' : 'disabled'}>Analyze now</button></div>`;
    }

    const transcript = a?.transcript?.length ? html`<section class="card">
      <h2 class="card-title">Transcript & corrections <span lang="ja" class="muted">書き起こし</span></h2>
      <ol class="transcript">${a.transcript.map((s, i) => {
        const cs = (a.corrections || []).filter((c) => Number(c.sentenceIndex) === i);
        return html`<li class="sentence">${seekBtn(s.start)}<div class="sentence-body"><p lang="ja" class="sentence-text">${s.text}</p>
          ${cs.map((c) => html`<div class="correction">${diffView(c.original, c.corrected)}
            <p class="explain"><span class="tag tag-${c.type}">${TYPE_LABEL[c.type] || c.type}</span> ${c.explanation}</p></div>`)}
        </div></li>`;
      })}</ol>
      ${(() => {
        const orphan = (a.corrections || []).filter((c) => !(Number(c.sentenceIndex) >= 0 && Number(c.sentenceIndex) < a.transcript.length));
        return orphan.length ? html`<div class="orphans">${orphan.map((c) => html`<div class="correction">${diffView(c.original, c.corrected)}<p class="explain"><span class="tag">${TYPE_LABEL[c.type] || c.type}</span> ${c.explanation}</p></div>`)}</div>` : '';
      })()}
    </section>` : '';

    const rewrite = a && (a.naturalRewrite || a.translation) ? html`<section class="card">
      <details open><summary class="card-title">Natural version <span lang="ja" class="muted">自然な言い方</span></summary>
        <p lang="ja" class="rewrite">${a.naturalRewrite}</p></details>
      <details><summary class="card-title">English translation</summary><p class="translation">${a.translation}</p></details>
    </section>` : '';

    const pron = a?.pronunciation?.length ? html`<section class="card"><h2 class="card-title">Pronunciation <span lang="ja" class="muted">発音</span></h2>
      <ul class="notes">${a.pronunciation.map((p) => html`<li class="note">${snippetBtn(p.time)}<div>
        <p><b lang="ja">${p.word}</b>${p.reading ? html` <span lang="ja" class="muted">（${p.reading}）</span>` : ''} <span class="tag">${PRON_LABEL[p.category] || p.category}</span></p>
        <p>${p.issue}</p>${p.tip ? html`<p class="tip">Tip: ${p.tip}</p>` : ''}</div></li>`)}</ul></section>` : '';

    const pitch = a?.pitchAccent?.length ? html`<section class="card"><h2 class="card-title">Pitch accent <span lang="ja" class="muted">アクセント</span></h2>
      <ul class="notes">${a.pitchAccent.map((p) => html`<li class="note">${snippetBtn(p.time)}<div>
        <p><b lang="ja">${p.word}</b>${p.reading ? html` <span lang="ja" class="muted">（${p.reading}）</span>` : ''}</p>
        <div class="patterns"><span class="pat"><span class="pat-label">expected</span>${moraPattern(p.expected)}</span>
          <span class="pat"><span class="pat-label">you said</span>${moraPattern(p.heard)}</span></div>
        ${p.tip ? html`<p class="tip">${p.tip}</p>` : ''}</div></li>`)}</ul></section>` : '';

    const fillers = a?.fluency?.fillers?.length ? html`<div class="fillers"><span class="muted">Fillers:</span> ${a.fluency.fillers.map((f) => html`<button class="chip" data-snip="${Number(f.time) || 0}"><span lang="ja">${f.text}</span> <small>${ts(f.time)}</small></button>`)}</div>` : '';

    return html`
    <header class="page-head">
      <a class="back-btn" href="#/calendar" data-back aria-label="Back">${raw(icons.back)}</a>
      <div class="grow">
        <p class="eyebrow">${formatTime(entry.createdAt)} · ${formatDuration(entry.durationSec)} ${isQualifying(entry, minSec) ? '· counts ✓' : `· under ${formatDuration(minSec)}`}</p>
        <h1 lang="ja">${formatDateJa(entry.date)}</h1>
      </div>
      ${statusPill(entry)}
    </header>
    ${entry.prompt ? html`<p class="entry-prompt"><span lang="ja">${entry.prompt.ja}</span><br><span class="muted">${entry.prompt.en}</span></p>` : ''}
    ${status}
    <section class="card player-card">
      <audio controls preload="metadata" data-audio aria-label="Your recording"></audio>
      ${m && (m.pitch?.hz?.length || m.volume?.db?.length) ? html`
        <div class="chart-wrap contour-wrap"><canvas data-contour role="img" aria-label="Pitch and volume over time. Tap to play from that point."></canvas></div>
        <div class="legend"><span><i class="lg-pitch"></i>Pitch (semitones vs your average)</span><span><i class="lg-vol"></i>Volume</span><span><i class="lg-pause"></i>Pauses</span></div>` : ''}
    </section>
    ${a ? html`<section class="card">${scoreBars(a.scores)}
      ${a.summary ? html`<p class="summary">${a.summary}</p>` : ''}
      ${a.strengths?.length ? html`<ul class="strengths">${a.strengths.map((s) => html`<li>${raw(icons.check)}<span>${s}</span></li>`)}</ul>` : ''}
      ${a.focusNext ? html`<div class="focus"><span class="label">Tomorrow, focus on</span><p>${a.focusNext}</p></div>` : ''}
    </section>` : ''}
    ${transcript}
    ${rewrite}
    ${pron}
    ${pitch}
    ${m || a?.fluency ? html`<section class="card"><h2 class="card-title">Fluency <span lang="ja" class="muted">流暢さ</span></h2>
      ${a?.fluency?.comment ? html`<p>${a.fluency.comment}</p>` : ''}${fillers}${fluencyStats(m, a)}</section>` : ''}
    <section class="actions">
      ${a ? html`<button class="btn btn-secondary" data-reanalyze ${busy || !hasKey ? 'disabled' : ''}>${raw(icons.spark)} Re-analyze</button>` : ''}
      <button class="btn btn-danger-ghost" data-delete>${raw(icons.trash)} Delete entry</button>
    </section>
    ${a?.model ? html`<p class="muted small center">Feedback by ${a.model}. AI feedback can be wrong — trust your teacher and your ears.</p>` : ''}`;
  }

  async function loadAudioSrc(el) {
    const rec = await app.db.getAudio(entry.audioId);
    if (!rec?.blob) { el.replaceWith(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'Audio is missing for this entry.' })); return; }
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = URL.createObjectURL(rec.blob);
    el.src = audioUrl;
  }

  function paint() {
    const playing = root.querySelector('[data-audio]');
    const keepTime = playing && !playing.paused ? null : playing?.currentTime;
    chart?.destroy(); chart = null;
    root.innerHTML = String(body());
    const audioEl = root.querySelector('[data-audio]');
    if (audioEl) {
      loadAudioSrc(audioEl).then(() => { if (keepTime) audioEl.currentTime = keepTime; });
      audioEl.addEventListener('timeupdate', () => {
        chart?.setPlayhead(audioEl.currentTime);
        if (stopAt != null && audioEl.currentTime >= stopAt) { audioEl.pause(); stopAt = null; }
      });
      audioEl.addEventListener('pause', () => { /* keep playhead */ });
    }
    const cv = root.querySelector('[data-contour]');
    if (cv && entry.metrics) {
      chart = contourChart(cv, { metrics: entry.metrics, duration: entry.metrics.durationSec || entry.durationSec, onSeek: (t) => seek(t, false) });
    }
  }

  function seek(t, snippet) {
    const el = root.querySelector('[data-audio]');
    if (!el) return;
    const go = () => {
      const start = snippet ? Math.max(0, t - 0.5) : Math.max(0, t);
      try { el.currentTime = start; } catch { /* not seekable yet */ }
      stopAt = snippet ? start + 3 : null;
      el.play().catch(() => {});
      chart?.setPlayhead(start);
    };
    if (el.readyState >= 1) go();
    else el.addEventListener('loadedmetadata', go, { once: true });
  }

  root.addEventListener('click', async (ev) => {
    const t = ev.target.closest('button, a');
    if (!t) return;
    if (t.matches('[data-back]')) {
      ev.preventDefault();
      if (app.routeCount > 1) history.back();
      else app.navigate('#/calendar');
      return;
    }
    if (t.dataset.seek != null) { seek(Number(t.dataset.seek), false); return; }
    if (t.dataset.snip != null) { seek(Number(t.dataset.snip), true); return; }
    if (t.matches('[data-cancel]')) { app.cancelAnalysis(entry.id); return; }
    if (t.matches('[data-reanalyze]')) {
      if (!app.settings.apiKey) { app.navigate('#/settings'); return; }
      if (entry.analysis) {
        const ok = await app.confirm({ title: 'Re-analyze this entry?', body: 'This uses one Gemini request and replaces the current feedback.', ok: 'Re-analyze' });
        if (!ok) return;
      }
      const p = app.analyzeEntryById(entry.id);
      entry = app.getEntry(entry.id) || entry;
      paint();
      try { await p; app.toast('Feedback updated.'); } catch (e) { app.toast(app.friendlyAIError(e), { kind: 'error' }); }
      return;
    }
    if (t.matches('[data-delete]')) {
      const ok = await app.confirm({ title: 'Delete this entry?', body: 'The recording and its feedback will be removed from this device. Flashcards made from it are kept.', ok: 'Delete', danger: true });
      if (!ok) return;
      await app.deleteEntry(entry.id);
      app.toast('Entry deleted.');
      app.navigate('#/calendar');
    }
  });

  offs.push(app.on('entry', (e) => { if (e?.id === entry.id) { entry = e; paint(); } }));
  // Live elapsed time + which model is being tried, while a request runs.
  const tickProgress = () => {
    const p = app.progress.get(entry.id);
    const el = root.querySelector('[data-elapsed]');
    if (el && p) el.textContent = `${Math.floor((Date.now() - p.startedAt) / 1000)}s`;
    const pe = root.querySelector('[data-progress]');
    if (pe && p && p.attempt > 1) pe.textContent = `The first model was busy or out of quota, so it's now trying ${p.model} (${p.attempt} of 4).`;
  };
  const progressTimer = setInterval(tickProgress, 1000);
  offs.push(() => clearInterval(progressTimer));
  offs.push(app.on('progress', (eid) => { if (eid === entry.id) { if (!app.inFlight.has(eid)) paint(); else tickProgress(); } }));
  offs.push(app.on('audio', (eid) => {
    if (eid !== entry.id) return;
    const el = root.querySelector('[data-audio]');
    if (el && el.paused) loadAudioSrc(el);
  }));
  paint();

  return () => {
    offs.forEach((f) => f());
    chart?.destroy();
    const el = root.querySelector('[data-audio]');
    if (el) { el.pause(); el.removeAttribute('src'); }
    if (audioUrl) URL.revokeObjectURL(audioUrl);
  };
}
