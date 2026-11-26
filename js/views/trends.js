// trends.js — progress charts over time.
import { html, formatDateShort, weekKey, addDays, localDateStr, round } from '../util.js';
import { lineChart, barChart } from '../charts.js';
import { emptyState } from './common.js';

const SCORE_SERIES = [
  ['grammar', 'Grammar'], ['vocabulary', 'Vocabulary'], ['fluency', 'Fluency'],
  ['pronunciation', 'Pronunciation'], ['pitchAccent', 'Pitch accent'],
];

export async function render(root, app) {
  const charts = [];
  const entries = [...app.entries].sort((a, b) => a.createdAt - b.createdAt);
  const withA = entries.filter((e) => e.analysis?.scores);
  const withM = entries.filter((e) => e.metrics);
  const lbl = (e) => formatDateShort(e.date);

  // weekly speaking minutes: last 12 weeks including this one
  const thisWeek = weekKey(localDateStr());
  const weeks = Array.from({ length: 12 }, (_, i) => addDays(thisWeek, -7 * (11 - i)));
  const perWeek = new Map(weeks.map((w) => [w, 0]));
  for (const e of entries) {
    const k = weekKey(e.date);
    if (perWeek.has(k)) perWeek.set(k, perWeek.get(k) + (Number(e.durationSec) || 0) / 60);
  }

  const chartCard = (id, title, sub, legend = []) => html`<section class="card">
    <h2 class="card-title">${title}</h2>${sub ? html`<p class="muted small">${sub}</p>` : ''}
    ${legend.length ? html`<div class="legend">${legend.map(([name, i]) => html`<span><i style="background:var(--series-${i})"></i>${name}</span>`)}</div>` : ''}
    <div class="chart-wrap"><canvas data-chart="${id}" role="img" aria-label="${title}"></canvas></div></section>`;

  const few = (n) => n < 2 ? html`<p class="muted small few">Only ${n} data point${n === 1 ? '' : 's'} so far — trends appear after a few entries.</p>` : '';

  if (!entries.length) {
    root.innerHTML = String(html`<header class="page-head"><div><p class="eyebrow">Trends</p><h1 lang="ja">成長</h1></div></header>
      ${emptyState('No entries yet', 'Your progress charts will grow here as you record.')}`);
    return;
  }

  root.innerHTML = String(html`
    <header class="page-head"><div><p class="eyebrow">Trends</p><h1 lang="ja">成長</h1></div></header>
    ${chartCard('minutes', 'Speaking minutes per week', 'Last 12 weeks')}
    ${withA.length ? html`${chartCard('scores', 'Scores', 'From Gemini feedback, 0–100', SCORE_SERIES.map(([, n], i) => [n, i + 1]))}${few(withA.length)}` : ''}
    ${withM.length ? html`
      ${chartCard('rate', 'Pace', 'Estimated syllables per second (higher = faster)')}
      ${chartCard('hesconf', 'Hesitation & confidence', '0–100 from local audio analysis', [['Hesitation (lower is better)', 1], ['Confidence', 2]])}
      ${chartCard('range', 'Pitch range', 'Semitones — under ~4 sounds flat')}` : ''}
    ${withA.length ? chartCard('fillers', 'Fillers per entry', 'ええと, あの, なんか…') : ''}
    ${!withA.length ? html`<div class="card nudge"><p>Score and filler trends need Gemini feedback. <a href="#/settings">Add your API key</a>.</p></div>` : ''}`);

  const cv = (id) => root.querySelector(`[data-chart="${id}"]`);
  charts.push(barChart(cv('minutes'), {
    labels: weeks.map((w) => formatDateShort(w)), values: weeks.map((w) => round(perWeek.get(w), 1)),
    format: (v) => `${round(v, 1)}m`,
  }));
  if (withA.length) {
    charts.push(lineChart(cv('scores'), {
      labels: withA.map(lbl), yMin: 0, yMax: 100,
      series: SCORE_SERIES.map(([k, n]) => ({ name: n, values: withA.map((e) => Number(e.analysis.scores[k])) })),
    }));
    charts.push(lineChart(cv('fillers'), {
      labels: withA.map(lbl), yMin: 0,
      series: [{ name: 'Fillers', values: withA.map((e) => Number(e.analysis.fluency?.fillerCount ?? e.analysis.fluency?.fillers?.length ?? 0)) }],
    }));
  }
  if (withM.length) {
    charts.push(lineChart(cv('rate'), { labels: withM.map(lbl), format: (v) => round(v, 1).toString(),
      series: [{ name: 'Syllables/s', values: withM.map((e) => e.metrics.syllableRate) }] }));
    charts.push(lineChart(cv('hesconf'), { labels: withM.map(lbl), yMin: 0, yMax: 100,
      series: [{ name: 'Hesitation', values: withM.map((e) => e.metrics.hesitationScore) },
        { name: 'Confidence', values: withM.map((e) => e.metrics.confidenceScore) }] }));
    charts.push(lineChart(cv('range'), { labels: withM.map(lbl), yMin: 0, format: (v) => round(v, 1).toString(),
      series: [{ name: 'Range (st)', values: withM.map((e) => e.metrics.pitch?.rangeSemitones) }] }));
  }
  return () => charts.forEach((c) => c.destroy());
}
