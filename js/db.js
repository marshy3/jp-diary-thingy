// db.js — IndexedDB wrapper for 'hanashi-nikki'.
// Stores: entries (id), audio (id: {id, blob, mimeType}), cards (id), settings (key: {key, value}).

const DB_NAME = 'hanashi-nikki';
const DB_VERSION = 1;

export const DEFAULT_SETTINGS = {
  apiKey: '',
  model: '',
  level: 'N3',
  minSeconds: 60,
  reminderTime: '20:00',
  lastExportAt: null,
};

export class StorageError extends Error {
  constructor(message, code = 'storage', cause) { super(message); this.code = code; this.cause = cause; }
}

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new StorageError('This browser has no IndexedDB, so entries cannot be saved.', 'unsupported'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('entries')) {
        const s = db.createObjectStore('entries', { keyPath: 'id' });
        s.createIndex('date', 'date');
      }
      if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('cards')) {
        const s = db.createObjectStore('cards', { keyPath: 'id' });
        s.createIndex('due', 'due');
      }
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(wrapErr(req.error));
    req.onblocked = () => reject(new StorageError('Database is blocked by another open tab. Close other tabs and retry.', 'blocked'));
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function wrapErr(err) {
  if (err instanceof StorageError) return err;
  const name = err?.name || '';
  if (name === 'QuotaExceededError' || /quota/i.test(err?.message || '')) {
    return new StorageError('Your device storage is full. Export and delete old entries, or free up space.', 'quota', err);
  }
  return new StorageError(`Storage error: ${err?.message || name || 'unknown'}`, 'storage', err);
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(wrapErr(req.error));
  });
}

async function tx(stores, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    let t;
    try { t = db.transaction(stores, mode); } catch (e) { reject(wrapErr(e)); return; }
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(wrapErr(t.error));
    t.onabort = () => reject(wrapErr(t.error || new Error('aborted')));
    Promise.resolve(fn(t)).then((r) => { result = r; }, (e) => { try { t.abort(); } catch { /* */ } reject(wrapErr(e)); });
  });
}

const store = (t, name) => t.objectStore(name);

// ---------- entries ----------
export const getAllEntries = () => tx(['entries'], 'readonly', (t) => reqP(store(t, 'entries').getAll()))
  .then((list) => list.sort((a, b) => a.createdAt - b.createdAt));
export const getEntry = (id) => tx(['entries'], 'readonly', (t) => reqP(store(t, 'entries').get(id)));
export const putEntry = (e) => tx(['entries'], 'readwrite', (t) => reqP(store(t, 'entries').put(e)));
export async function getEntriesByDate(date) {
  return tx(['entries'], 'readonly', (t) => reqP(store(t, 'entries').index('date').getAll(date)))
    .then((l) => l.sort((a, b) => a.createdAt - b.createdAt));
}

/** Save a new entry and its audio atomically. */
export const saveEntryWithAudio = (entry, audio) => tx(['entries', 'audio'], 'readwrite', (t) => {
  store(t, 'audio').put(audio);
  return reqP(store(t, 'entries').put(entry));
});

/** Merge a patch into a stored entry (read-modify-write in one transaction). */
export const updateEntry = (id, patch) => tx(['entries'], 'readwrite', async (t) => {
  const s = store(t, 'entries');
  const cur = await reqP(s.get(id));
  if (!cur) return null;
  const next = { ...cur, ...patch };
  s.put(next);
  return next;
});

export const deleteEntry = (id) => tx(['entries', 'audio'], 'readwrite', async (t) => {
  const e = await reqP(store(t, 'entries').get(id));
  store(t, 'entries').delete(id);
  if (e?.audioId) store(t, 'audio').delete(e.audioId);
});

// ---------- audio ----------
export const getAudio = (id) => tx(['audio'], 'readonly', (t) => reqP(store(t, 'audio').get(id)));
export const putAudio = (a) => tx(['audio'], 'readwrite', (t) => reqP(store(t, 'audio').put(a)));

// ---------- cards ----------
export const getAllCards = () => tx(['cards'], 'readonly', (t) => reqP(store(t, 'cards').getAll()));
export const putCard = (c) => tx(['cards'], 'readwrite', (t) => reqP(store(t, 'cards').put(c)));
export const putCards = (cs) => tx(['cards'], 'readwrite', (t) => { cs.forEach((c) => store(t, 'cards').put(c)); });
export const deleteCard = (id) => tx(['cards'], 'readwrite', (t) => reqP(store(t, 'cards').delete(id)));

// ---------- settings ----------
export async function getSettings() {
  const rows = await tx(['settings'], 'readonly', (t) => reqP(store(t, 'settings').getAll()));
  const s = { ...DEFAULT_SETTINGS };
  for (const r of rows) s[r.key] = r.value;
  return s;
}
export async function getSetting(key) {
  const r = await tx(['settings'], 'readonly', (t) => reqP(store(t, 'settings').get(key)));
  return r ? r.value : DEFAULT_SETTINGS[key];
}
export const setSetting = (key, value) => tx(['settings'], 'readwrite', (t) => reqP(store(t, 'settings').put({ key, value })));

// ---------- export / import ----------
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
function base64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: type || 'application/octet-stream' });
}

/** Build the export as a Blob (streamed in parts so we never hold one giant string). */
export async function exportAll() {
  const [entries, cards, settings] = await Promise.all([getAllEntries(), getAllCards(), getSettings()]);
  const { apiKey, ...safeSettings } = settings; // never export the key
  const parts = [`{"app":"hanashi-nikki","version":1,"exportedAt":${Date.now()},`,
    `"settings":${JSON.stringify(safeSettings)},`,
    `"entries":${JSON.stringify(entries)},`,
    `"cards":${JSON.stringify(cards)},"audio":[`];
  let first = true;
  for (const e of entries) {
    const a = await getAudio(e.audioId);
    if (!a?.blob) continue;
    const b64 = await blobToBase64(a.blob);
    parts.push(`${first ? '' : ','}{"id":${JSON.stringify(a.id)},"mimeType":${JSON.stringify(a.mimeType || a.blob.type)},"data":"`, b64, '"}');
    first = false;
  }
  parts.push(']}');
  return new Blob(parts, { type: 'application/json' });
}

/** Import (merge) from a parsed export object. Returns counts. */
export async function importAll(data) {
  if (!data || data.app !== 'hanashi-nikki' || !Array.isArray(data.entries)) {
    throw new StorageError('That file is not a Hanashi Nikki export.', 'format');
  }
  let entries = 0, cards = 0, audio = 0;
  for (const a of data.audio || []) {
    if (!a?.id || typeof a.data !== 'string') continue;
    await putAudio({ id: a.id, blob: base64ToBlob(a.data, a.mimeType), mimeType: a.mimeType });
    audio++;
  }
  for (const e of data.entries) {
    if (!e?.id || !e.date) continue;
    await putEntry(e); entries++;
  }
  if (Array.isArray(data.cards)) {
    const valid = data.cards.filter((c) => c?.id && c.front);
    if (valid.length) await putCards(valid);
    cards = valid.length;
  }
  if (data.settings && typeof data.settings === 'object') {
    for (const [k, v] of Object.entries(data.settings)) {
      if (k === 'apiKey' || !(k in DEFAULT_SETTINGS || k === 'todayPrompt')) continue;
      await setSetting(k, v);
    }
  }
  return { entries, cards, audio };
}

export async function deleteAll() {
  await tx(['entries', 'audio', 'cards', 'settings'], 'readwrite', (t) => {
    for (const n of ['entries', 'audio', 'cards', 'settings']) store(t, n).clear();
  });
}

// ---------- storage ----------
export async function storageEstimate() {
  try {
    if (navigator.storage?.estimate) return await navigator.storage.estimate();
  } catch { /* ignore */ }
  return null;
}
export async function isPersisted() {
  try { return navigator.storage?.persisted ? await navigator.storage.persisted() : false; } catch { return false; }
}
export async function requestPersist() {
  try { return navigator.storage?.persist ? await navigator.storage.persist() : false; } catch { return false; }
}
