// calendar.js — streaks + month heatmap + day list.
import { html, raw, localDateStr, parseLocalDate, formatMonthTitle, formatDateJa, secondsByDate, pad2, formatDuration } from '../util.js';
import { icons } from './icons.js';
import { entryItem, emptyState } from './common.js';

const DOW = ['日', '月', '火', '水', '木', '金', '土'];

export async function render(root, app) {
  const today = localDateStr();
  const t = parseLocalDate(today);
  let year = t.getFullYear(), month = t.getMonth();
  let selected = today;
  const offs = [];

  function paint() {
    const minSec = Number(app.settings.minSeconds) || 60;
    const s = app.streaks();
    const secs = secondsByDate(app.entries);
    const first = app.entries.length ? app.entries.reduce((m, e) => (e.date < m ? e.date : m), app.entries[0].date) : null;
    const startDow = new Date(year, month, 1).getDay();
    const days = new Date(year, month + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < startDow; i++) cells.push(html`<div class="cal-cell pad" aria-hidden="true"></div>`);
    for (let d = 1; d <= days; d++) {
      const ds = `${year}-${pad2(month + 1)}-${pad2(d)}`;
      const sec = secs.get(ds) || 0;
      const q = s.qualifyingDates.has(ds);
      const lvl = q ? (sec >= minSec * 3 ? 3 : sec >= minSec * 2 ? 2 : 1) : sec > 0 ? 'p' : 0;
      const missed = !q && ds < today && first && ds >= first;
      const cls = ['cal-cell', `lv-${lvl}`, ds === today && 'today', missed && 'missed', ds === selected && 'sel', ds > today && 'future'].filter(Boolean).join(' ');
      const label = `${month + 1}月${d}日: ${q ? `done, ${formatDuration(sec)}` : sec ? `${formatDuration(sec)}, too short` : missed ? 'missed' : 'no entry'}`;
      cells.push(html`<button class="${cls}" data-day="${ds}" aria-label="${label}" ${ds === selected ? raw('aria-pressed="true"') : ''}><span>${d}</span></button>`);
    }
    const dayEntries = app.entries.filter((e) => e.date === selected).sort((a, b) => a.createdAt - b.createdAt);
    const isCurMonth = year === t.getFullYear() && month === t.getMonth();

    root.innerHTML = String(html`
      <header class="page-head"><div><p class="eyebrow">Calendar</p><h1 lang="ja">記録</h1></div></header>
      <section class="streak-row">
        <div class="card stat-tile ${s.todayDone ? 'done' : ''}"><span class="stat-icon">${raw(icons.flame)}</span>
          <span class="stat-num">${s.current}</span><span class="stat-label">current streak<br><span class="muted">${s.todayDone ? 'today done ✓' : s.current ? 'speak today to extend it' : 'start today!'}</span></span></div>
        <div class="card stat-tile"><span class="stat-num">${s.best}</span><span class="stat-label">best streak<br><span class="muted">${s.qualifyingDates.size} days total</span></span></div>
      </section>
      <section class="card cal">
        <div class="cal-head">
          <button class="icon-btn" data-prev aria-label="Previous month">${raw(icons.chevL)}</button>
          <h2 lang="ja">${formatMonthTitle(year, month)}</h2>
          <button class="icon-btn" data-next aria-label="Next month" ${isCurMonth ? 'disabled' : ''}>${raw(icons.chevR)}</button>
        </div>
        <div class="cal-grid cal-dow" aria-hidden="true">${DOW.map((d, i) => html`<div class="${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${d}</div>`)}</div>
        <div class="cal-grid" role="group" aria-label="Days">${cells}</div>
        <div class="cal-legend" aria-hidden="true">
          <span><i class="lv-p"></i>too short</span><span><i class="lv-1"></i>done</span><span><i class="lv-3"></i>3× min</span><span><i class="missed-key"></i>missed</span>
        </div>
      </section>
      <section>
        <h2 class="section-title" lang="ja">${formatDateJa(selected)}</h2>
        ${dayEntries.length ? html`<ul class="entry-list">${dayEntries.map((e) => entryItem(e, minSec))}</ul>`
          : emptyState(selected === today ? 'Nothing yet today' : 'No entry this day', selected === today ? 'Head to Today and speak for a minute.' : '')}
      </section>`);
  }

  root.addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.matches('[data-prev]')) { month--; if (month < 0) { month = 11; year--; } paint(); }
    else if (b.matches('[data-next]')) { month++; if (month > 11) { month = 0; year++; } paint(); }
    else if (b.dataset.day) { selected = b.dataset.day; paint(); }
  });
  offs.push(app.on('entries', paint), app.on('entry', paint));
  paint();
  return () => offs.forEach((f) => f());
}
