// common.js — shared view fragments.
import { html, formatTime, formatDuration, averageScore, isQualifying, formatDateJa } from '../util.js';

export const STATUS_LABEL = {
  saved: 'Saved · not analyzed',
  analyzing: 'Analyzing…',
  done: 'Feedback ready',
  error: 'Needs retry',
};

export function statusPill(entry) {
  const st = entry.analysis ? 'done' : entry.status;
  return html`<span class="pill pill-${st}">${STATUS_LABEL[st] || st}</span>`;
}

export function entryItem(entry, minSeconds, { showDate = false } = {}) {
  const avg = averageScore(entry.analysis?.scores);
  const first = entry.analysis?.transcript?.[0]?.text || entry.prompt?.ja || '';
  const counts = isQualifying(entry, minSeconds);
  return html`<li><a class="entry-item" href="#/entry/${encodeURIComponent(entry.id)}">
    <div class="entry-item-main">
      <div class="entry-item-top">
        <span class="entry-time">${showDate ? formatDateJa(entry.date) + ' ' : ''}${formatTime(entry.createdAt)}</span>
        <span class="entry-dur ${counts ? 'ok' : 'short'}" title="${counts ? 'Counts toward streak' : 'Shorter than the minimum'}">${formatDuration(entry.durationSec)}</span>
        ${statusPill(entry)}
      </div>
      <div class="entry-item-text" lang="ja">${first}</div>
    </div>
    ${avg != null ? html`<div class="score-badge" aria-label="Average score ${avg}">${avg}</div>` : ''}
  </a></li>`;
}

export function emptyState(title, body) {
  return html`<div class="empty"><p class="empty-title">${title}</p><p class="muted">${body}</p></div>`;
}
