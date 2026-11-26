// review.js — SRS flashcards (SM-2-lite in srs.js) + browse/delete.
import { html, raw, formatDateShort, localDateStr } from '../util.js';
import { review, dueCards, previewIntervals, GRADES } from '../srs.js';
import { icons } from './icons.js';
import { emptyState } from './common.js';

const KIND_LABEL = { correction: 'correction', vocab: 'vocab', pronunciation: 'pronunciation', pitch: 'pitch accent' };
const GRADE_LABEL = { again: 'Again', hard: 'Hard', good: 'Good', easy: 'Easy' };

export async function render(root, app) {
  let mode = 'home';
  let queue = [], current = null, flipped = false, done = 0, filter = '';
  const offs = [];

  function home() {
    const due = dueCards(app.cards);
    const total = app.cards.length;
    const next = app.cards.filter((c) => c.due > Date.now()).sort((a, b) => a.due - b.due)[0];
    return html`
      <header class="page-head"><div><p class="eyebrow">Review</p><h1 lang="ja">復習</h1></div></header>
      <section class="card review-home">
        <p class="due-num">${due.length}</p>
        <p class="due-label">${due.length === 1 ? 'card due' : 'cards due'}</p>
        ${due.length ? html`<button class="btn btn-primary btn-wide" data-start>Start review</button>`
          : html`<p class="muted">${total ? `All caught up! Next card ${next ? formatDateShort(localDateStr(new Date(next.due))) : 'later'}.` : 'Cards are created automatically from your corrections and feedback.'}</p>`}
      </section>
      <section>
        <div class="section-row"><h2 class="section-title">All cards (${total})</h2>${total ? html`<button class="btn btn-ghost btn-small" data-browse>Browse</button>` : ''}</div>
        ${total ? '' : emptyState('No cards yet', 'Record an entry with a Gemini key set to get your first cards.')}
      </section>`;
  }

  function session() {
    if (!current) {
      return html`<header class="page-head"><div><p class="eyebrow">Review</p><h1 lang="ja">おつかれさま！</h1></div></header>
        <section class="card review-home"><p class="due-num">${done}</p><p class="due-label">reviewed</p>
        <button class="btn btn-primary btn-wide" data-home>Done</button></section>`;
    }
    const iv = previewIntervals(current);
    return html`
      <header class="page-head"><button class="back-btn" data-home aria-label="End review">${raw(icons.back)}</button>
        <div class="grow"><p class="eyebrow">${queue.length + 1} left</p><h1 lang="ja">復習</h1></div></header>
      <section class="flashcard ${flipped ? 'flipped' : ''}" data-flip tabindex="0" role="button" aria-label="${flipped ? 'Card answer' : 'Tap to show answer'}">
        <span class="tag tag-${current.kind}">${KIND_LABEL[current.kind] || current.kind}</span>
        <p class="fc-front" lang="ja">${current.front}</p>
        ${flipped ? html`<hr><p class="fc-back" lang="ja">${current.back}</p>${current.note ? html`<p class="fc-note">${current.note}</p>` : ''}
          ${current.sourceEntryId ? html`<a class="small" href="#/entry/${encodeURIComponent(current.sourceEntryId)}">From your entry →</a>` : ''}`
          : html`<p class="muted fc-hint">Say it out loud, then tap to check</p>`}
      </section>
      ${flipped ? html`<div class="grades">${GRADES.map((g) => html`<button class="grade grade-${g}" data-grade="${g}"><b>${GRADE_LABEL[g]}</b><small>${iv[g]}</small></button>`)}</div>`
        : html`<button class="btn btn-primary btn-wide" data-show>Show answer</button>`}`;
  }

  function browse() {
    const q = filter.trim().toLowerCase();
    const list = [...app.cards].sort((a, b) => b.createdAt - a.createdAt)
      .filter((c) => !q || `${c.front} ${c.back} ${c.note}`.toLowerCase().includes(q));
    return html`
      <header class="page-head"><button class="back-btn" data-home aria-label="Back">${raw(icons.back)}</button>
        <div class="grow"><p class="eyebrow">${app.cards.length} cards</p><h1>Browse cards</h1></div></header>
      <input class="input" type="search" placeholder="Search cards" aria-label="Search cards" data-filter value="${filter}">
      <ul class="card-list">${list.map((c) => html`<li class="card-row">
        <div class="grow"><p lang="ja" class="cr-front">${c.front}</p><p lang="ja" class="muted cr-back">${c.back}</p>
          <p class="small muted"><span class="tag tag-${c.kind}">${KIND_LABEL[c.kind] || c.kind}</span> due ${formatDateShort(localDateStr(new Date(c.due)))} · ${c.reps} reviews</p></div>
        <button class="icon-btn danger" data-del="${c.id}" aria-label="Delete card">${raw(icons.trash)}</button></li>`)}</ul>
      ${list.length ? '' : emptyState('No matching cards', '')}`;
  }

  function paint() {
    root.innerHTML = String(mode === 'session' ? session() : mode === 'browse' ? browse() : home());
    if (mode === 'browse') {
      const inp = root.querySelector('[data-filter]');
      inp.addEventListener('input', () => { filter = inp.value; const pos = inp.selectionStart; paint(); const n = root.querySelector('[data-filter]'); n.focus(); n.setSelectionRange(pos, pos); });
    }
  }

  async function grade(g) {
    const updated = review(current, g);
    await app.db.putCard(updated);
    const i = app.cards.findIndex((c) => c.id === updated.id);
    if (i >= 0) app.cards[i] = updated;
    done++;
    if (g === 'again') queue.push(updated); // see it again this session
    current = queue.shift() || null;
    flipped = false;
    app.emit('cards');
    paint();
  }

  root.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button, [data-flip]');
    if (!b) return;
    if (b.matches('[data-start]')) { queue = dueCards(app.cards); current = queue.shift() || null; done = 0; flipped = false; mode = 'session'; paint(); }
    else if (b.matches('[data-home]')) { mode = 'home'; paint(); }
    else if (b.matches('[data-browse]')) { mode = 'browse'; paint(); }
    else if (b.matches('[data-show]') || (b.matches('[data-flip]') && !flipped)) { flipped = true; paint(); }
    else if (b.dataset.grade) { await grade(b.dataset.grade); }
    else if (b.dataset.del) {
      const c = app.cards.find((x) => x.id === b.dataset.del);
      const ok = await app.confirm({ title: 'Delete this card?', body: c?.front || '', ok: 'Delete', danger: true });
      if (!ok) return;
      await app.db.deleteCard(b.dataset.del);
      app.cards = app.cards.filter((x) => x.id !== b.dataset.del);
      app.emit('cards');
      paint();
    }
  });
  root.addEventListener('keydown', (ev) => {
    if (mode !== 'session' || !current) return;
    if ((ev.key === ' ' || ev.key === 'Enter') && !flipped) { ev.preventDefault(); flipped = true; paint(); }
    else if (flipped && ['1', '2', '3', '4'].includes(ev.key)) grade(GRADES[Number(ev.key) - 1]);
  });
  offs.push(app.on('cards', () => { if (mode === 'home') paint(); }));
  paint();
  return () => offs.forEach((f) => f());
}
