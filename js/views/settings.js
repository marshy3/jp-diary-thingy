// settings.js — API key, model, level, min length, reminders, data management.
import { html, raw, formatBytes, localDateStr } from '../util.js';
import { downloadICS, requestNotificationPermission, notificationsSupported } from '../reminders.js';
import { icons } from './icons.js';

const LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1'];
const MIN_OPTIONS = [30, 45, 60, 90, 120, 180, 300];

export async function render(root, app) {
  let s = app.settings;
  let models = null; // [{id, displayName}]
  let defaultModel = '';
  try { defaultModel = (await app.loadAI()).DEFAULT_MODEL || ''; } catch { /* offline first load */ }

  const notifState = () => !notificationsSupported() ? 'unsupported' : Notification.permission;
  const isStandalone = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  function modelOptions() {
    const list = models && models.length ? models : [];
    const ids = new Set(list.map((m) => m.id));
    const cur = s.model || defaultModel;
    const extra = [defaultModel, cur].filter((m) => m && !ids.has(m)).filter((m, i, a) => a.indexOf(m) === i)
      .map((id) => ({ id, displayName: id === defaultModel ? `${id} (default)` : id }));
    return [...extra, ...list].map((m) => html`<option value="${m.id}" ${m.id === cur ? 'selected' : ''}>${m.displayName}${m.displayName !== m.id && !m.displayName.includes(m.id) ? ` — ${m.id}` : ''}</option>`);
  }

  function paint() {
    s = app.settings;
    const n = notifState();
    root.innerHTML = String(html`
      <header class="page-head"><div><p class="eyebrow">Settings</p><h1 lang="ja">設定</h1></div></header>

      <section class="card">
        <h2 class="card-title">${raw(icons.key)} Gemini API key</h2>
        <p class="muted small">Free. Your key stays on this phone and is only sent to Google.</p>
        <ol class="howto">
          <li>Open <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> and sign in with a Google account.</li>
          <li>Tap <b>Create API key</b>.</li>
          <li>Copy it and paste it below, then tap <b>Test</b>.</li>
        </ol>
        <div class="key-row">
          <label class="sr-only" for="apikey">API key</label>
          <input id="apikey" class="input mono" type="password" autocomplete="off" autocapitalize="off" spellcheck="false"
            placeholder="AIza…" value="${s.apiKey || ''}" data-key>
          <button class="icon-btn" data-toggle aria-label="Show key" aria-pressed="false">${raw(icons.eye)}</button>
        </div>
        <div class="btn-row">
          <button class="btn btn-primary" data-savekey>Save & test</button>
          ${s.apiKey ? html`<button class="btn btn-ghost" data-clearkey>Remove key</button>` : ''}
        </div>
        <p class="key-status small" data-keystatus role="status"></p>
        <p class="privacy small">⚠︎ Privacy: on Google’s <b>free tier</b>, your prompts and audio may be used by Google to improve its products, and may be reviewed by humans. Don’t say anything you wouldn’t want Google to hear.</p>
      </section>

      <section class="card">
        <h2 class="card-title">Feedback</h2>
        <label class="field"><span>Model</span>
          <select class="input" data-model>${modelOptions()}</select></label>
        <p class="muted small" data-modelhint>${s.apiKey ? (models ? `${models.length} models available for your key.` : 'Loading models…') : 'Add a key to load the model list.'}</p>
        <label class="field"><span>Your level</span>
          <select class="input" data-level>${LEVELS.map((l) => html`<option ${l === (s.level || 'N3') ? 'selected' : ''}>${l}</option>`)}</select></label>
        <label class="field"><span>Minimum length for streak</span>
          <select class="input" data-min>${MIN_OPTIONS.map((m) => html`<option value="${m}" ${Number(s.minSeconds) === m ? 'selected' : ''}>${m < 60 ? `${m} seconds` : `${m / 60} minute${m > 60 ? 's' : ''}`}</option>`)}</select></label>
      </section>

      <section class="card">
        <h2 class="card-title">${raw(icons.bell)} Daily reminder</h2>
        <label class="field"><span>Reminder time</span><input class="input" type="time" value="${s.reminderTime || '20:00'}" data-time></label>
        <button class="btn btn-secondary btn-wide" data-ics>Add daily reminder to my calendar</button>
        <p class="muted small">Downloads a repeating calendar event (.ics) with an alert — the most reliable reminder on iPhone. Open the file and tap “Add All”.</p>
        <button class="btn btn-ghost btn-wide" data-notif ${n === 'granted' || n === 'unsupported' || n === 'denied' ? 'disabled' : ''}>
          ${n === 'granted' ? 'Notifications enabled ✓' : n === 'denied' ? 'Notifications blocked in system settings' : n === 'unsupported' ? 'Notifications not available here' : 'Enable notifications'}</button>
        ${n === 'unsupported' && isIOS && !isStandalone ? html`<p class="muted small">On iPhone, notifications work only after “Add to Home Screen” (Share → Add to Home Screen).</p>` : ''}
        <p class="muted small">When you open the app after the reminder time without an entry, you’ll get a nudge, and the app icon shows a badge.</p>
      </section>

      <section class="card">
        <h2 class="card-title">Your data</h2>
        <p class="small" data-storage>Checking storage…</p>
        <button class="btn btn-ghost btn-wide" data-persist>Keep my data safe (persistent storage)</button>
        <div class="btn-row">
          <button class="btn btn-secondary" data-export>Export backup</button>
          <label class="btn btn-secondary file-btn">Import backup<input type="file" accept="application/json,.json" data-import hidden></label>
        </div>
        <p class="muted small">${s.lastExportAt ? `Last export: ${localDateStr(new Date(s.lastExportAt))}.` : 'No backup yet.'} Backups include audio but never your API key.</p>
        <button class="btn btn-danger-ghost btn-wide" data-wipe>${raw(icons.trash)} Delete all data</button>
      </section>
      <p class="muted small center">話し日記 Hanashi Nikki · everything stays on your device.</p>`);
    refreshStorage();
  }

  async function refreshStorage() {
    const el = root.querySelector('[data-storage]');
    const est = await app.db.storageEstimate();
    const persisted = await app.db.isPersisted();
    const pb = root.querySelector('[data-persist]');
    if (pb) { pb.disabled = persisted; pb.textContent = persisted ? 'Storage is persistent ✓' : 'Keep my data safe (persistent storage)'; }
    if (!el) return;
    el.textContent = est
      ? `${app.entries.length} entries · ${app.cards.length} cards · using ${formatBytes(est.usage)}${est.quota ? ` of ~${formatBytes(est.quota)}` : ''}${persisted ? ' · persistent' : ' · may be cleared by the browser if space runs low'}`
      : `${app.entries.length} entries · ${app.cards.length} cards`;
  }

  async function loadModels() {
    if (!s.apiKey) return;
    try {
      const ai = await app.loadAI();
      models = await ai.listModels(s.apiKey);
    } catch (e) {
      models = null;
      const h = root.querySelector('[data-modelhint]');
      if (h) h.textContent = `Couldn’t load models (${app.friendlyAIError(e)}). Using the default.`;
      return;
    }
    const sel = root.querySelector('[data-model]');
    if (sel) sel.innerHTML = String(html`${modelOptions()}`);
    const h = root.querySelector('[data-modelhint]');
    if (h) h.textContent = `${models.length} models available for your key.`;
  }

  function setKeyStatus(text, kind) {
    const el = root.querySelector('[data-keystatus]');
    el.textContent = text;
    el.className = `key-status small ${kind || ''}`;
  }

  root.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.matches('[data-toggle]')) {
      const inp = root.querySelector('[data-key]');
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      b.innerHTML = show ? icons.eyeOff : icons.eye;
      b.setAttribute('aria-label', show ? 'Hide key' : 'Show key');
      b.setAttribute('aria-pressed', String(show));
    } else if (b.matches('[data-savekey]')) {
      const key = root.querySelector('[data-key]').value.trim();
      if (!key) { setKeyStatus('Paste your key first.', 'bad'); return; }
      b.disabled = true;
      setKeyStatus('Testing…');
      try {
        const ai = await app.loadAI();
        await ai.testKey(key);
        await app.setSetting('apiKey', key);
        setKeyStatus('✓ Key works and is saved. Unanalyzed entries will be processed now.', 'good');
        const status = root.querySelector('[data-keystatus]').outerHTML;
        paint();
        root.querySelector('[data-keystatus]').outerHTML = status;
        loadModels();
      } catch (e) {
        if (e?.code === 'network') {
          await app.setSetting('apiKey', key);
          setKeyStatus(`Saved, but the test call failed: ${String(e?.message || '').slice(0, 200)}`, 'warn');
        } else {
          setKeyStatus(app.friendlyAIError(e), 'bad');
        }
      } finally { b.disabled = false; }
    } else if (b.matches('[data-clearkey]')) {
      const ok = await app.confirm({ title: 'Remove API key?', body: 'New entries will be saved but not analyzed.', ok: 'Remove', danger: true });
      if (!ok) return;
      await app.setSetting('apiKey', '');
      models = null; paint();
    } else if (b.matches('[data-ics]')) {
      downloadICS({ time: s.reminderTime || '20:00', startDate: localDateStr(), url: location.href.split('#')[0] });
      app.toast('Calendar file downloaded — open it to add the daily reminder.');
    } else if (b.matches('[data-notif]')) {
      const r = await requestNotificationPermission();
      app.toast(r === 'granted' ? 'Notifications enabled.' : r === 'denied' ? 'Notifications were blocked.' : 'Notifications aren’t available here.');
      paint();
    } else if (b.matches('[data-persist]')) {
      const ok = await app.db.requestPersist();
      app.toast(ok ? 'Storage is now persistent — the browser won’t clear it automatically.' : 'The browser didn’t grant persistent storage. Installing to the home screen and using the app regularly helps; export backups too.', { kind: ok ? 'info' : 'warn' });
      refreshStorage();
    } else if (b.matches('[data-export]')) {
      b.disabled = true; b.textContent = 'Exporting…';
      try {
        const blob = await app.db.exportAll();
        const name = `hanashi-nikki-${localDateStr()}.json`;
        const file = typeof File === 'function' ? new File([blob], name, { type: 'application/json' }) : null;
        if (file && navigator.canShare?.({ files: [file] }) && /iP(hone|ad)/.test(navigator.userAgent)) {
          await navigator.share({ files: [file], title: 'Hanashi Nikki backup' }).catch(() => {});
        } else {
          const url = URL.createObjectURL(blob);
          const a = Object.assign(document.createElement('a'), { href: url, download: name });
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
        }
        await app.setSetting('lastExportAt', Date.now());
        app.toast(`Backup ready (${formatBytes(blob.size)}).`);
      } catch (e) {
        app.toast(`Export failed: ${e.message}`, { kind: 'error' });
      } finally { paint(); }
    } else if (b.matches('[data-wipe]')) {
      const ok = await app.confirm({ title: 'Delete ALL data?', body: 'Every entry, recording, flashcard and setting (including your API key) will be erased from this device. This cannot be undone. Export a backup first if unsure.', ok: 'Delete everything', danger: true });
      if (!ok) return;
      await app.db.deleteAll();
      await app.reloadAll();
      app.toast('All data deleted.');
      app.navigate('#/today');
    }
  });

  root.addEventListener('change', async (ev) => {
    const t = ev.target;
    if (t.matches('[data-model]')) { await app.setSetting('model', t.value); app.toast(`Model: ${t.value}`); }
    else if (t.matches('[data-level]')) await app.setSetting('level', t.value);
    else if (t.matches('[data-min]')) { await app.setSetting('minSeconds', Number(t.value)); }
    else if (t.matches('[data-time]')) { await app.setSetting('reminderTime', t.value || '20:00'); app.toast('Reminder time saved. Re-add the calendar reminder if you used one.'); }
    else if (t.matches('[data-import]') && t.files?.[0]) {
      const f = t.files[0];
      try {
        const data = JSON.parse(await f.text());
        const r = await app.db.importAll(data);
        await app.reloadAll();
        app.toast(`Imported ${r.entries} entries, ${r.cards} cards.`);
        paint();
      } catch (e) {
        app.toast(e instanceof SyntaxError ? 'That file isn’t valid JSON.' : `Import failed: ${e.message}`, { kind: 'error' });
      }
      t.value = '';
    }
  });

  paint();
  loadModels();
}
