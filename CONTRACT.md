# 話し日記 Hanashi Nikki — build contract

A $0 speaking-diary PWA for Japanese (N3 learner). Every day the user speaks an entry; the app stores
it on-device, measures the audio locally, and sends the audio + local metrics to Google Gemini's free
tier for feedback.

## Hard constraints
- **No build step.** Vanilla ES modules (`<script type="module">`), plain CSS. Must run from any static
  host (GitHub Pages) under a sub-path, so **all paths are relative** (`./js/x.js`, never `/js/x.js`).
- **No dependencies, no CDNs.** Everything in-repo. Works offline except the Gemini call.
- Target: iOS Safari 16.4+ and Android Chrome, installed to home screen. Mobile-first, works on desktop.
- All user data on-device (IndexedDB). Only the Gemini request leaves the phone.
- Each agent writes ONLY the files it owns (listed below). Don't edit others' files; if a contract
  change is needed, say so in your final report.

## File ownership
| Owner | Files |
|---|---|
| Audio agent | `js/recorder.js`, `js/wav.js`, `js/audio-analysis.js`, `tests/audio.test.mjs` |
| AI agent | `js/ai.js`, `tests/ai.test.mjs` |
| App/UI agent | `index.html`, `styles.css`, `manifest.webmanifest`, `sw.js`, `icons/*`, `js/app.js`, `js/views/*`, `js/db.js`, `js/srs.js`, `js/prompts.js`, `js/reminders.js`, `js/charts.js`, `js/util.js`, `tests/app.test.mjs` |
| Lead (me) | `CONTRACT.md`, `README.md`, integration fixes |

## Module APIs

### js/wav.js (audio agent)
```js
export async function blobToMonoPCM(blob, targetRate = 16000) // -> { samples: Float32Array, sampleRate }
// decode with (Offline)AudioContext.decodeAudioData, downmix to mono, resample to targetRate
export function encodeWav(samples, sampleRate)                 // -> Blob('audio/wav'), 16-bit PCM mono
export function pcmToWavArrayBuffer(samples, sampleRate)       // -> ArrayBuffer (pure; node-testable)
```

### js/recorder.js (audio agent)
```js
export function isRecordingSupported() // -> boolean
export async function startRecording({ onLevel } = {})
// onLevel(level0to1) called ~20x/sec for a live meter.
// returns controller:
//   { stop(): Promise<{ blob, mimeType, durationSec }>, cancel(): void, elapsedSec(): number }
// Uses getUserMedia + MediaRecorder, choosing a supported mimeType (iOS gives audio/mp4).
// Must release the mic tracks on stop/cancel.
```

### js/audio-analysis.js (audio agent) — PURE, no DOM, runs in Node too
```js
export function analyzeAudio(samples /*Float32Array mono*/, sampleRate) // -> AudioMetrics
```
```ts
AudioMetrics = {
  version: 1,
  durationSec: number,
  speechSec: number,             // total voiced/speech time (VAD)
  speechRatio: number,           // speechSec / durationSec
  segments: {start:number,end:number}[],     // speech segments (sec)
  pauses: {start:number,end:number}[],       // silences >= 0.25s between speech
  longPauses: {start:number,end:number}[],   // silences >= 1.2s (hesitation)
  meanPauseSec: number,
  syllableRate: number,          // estimated syllable nuclei per second of total duration (~mora rate proxy)
  articulationRate: number,      // same estimate but over speech time only
  pitch: {
    frameSec: number,            // hop, e.g. 0.02
    hz: number[],                // per frame, 0 = unvoiced; rounded to 1 decimal; max ~30k frames
    medianHz: number,
    rangeSemitones: number,      // 5th..95th percentile span of voiced frames
    stdSemitones: number,        // monotony indicator
  },
  volume: {
    frameSec: number,
    db: number[],                // per-frame RMS dBFS, rounded to 1 decimal
    meanDb: number,              // over speech frames
    trendDbPerMin: number,       // slope over the entry (fading out = negative)
  },
  hesitationScore: number,       // 0-100, higher = more hesitant (long pauses, low speech ratio)
  confidenceScore: number,       // 0-100, composite of volume steadiness, pause pattern, pitch variety
}
```

### js/ai.js (AI agent) — Gemini REST via fetch, API key supplied by the user
```js
export const DEFAULT_MODEL // best free-tier Flash model id known to work; overridable in settings
export async function listModels(apiKey)  // -> [{ id, displayName }] that support generateContent; Flash-family first
export async function testKey(apiKey)     // -> { ok: true } | throws AIError
export async function analyzeEntry({ apiKey, model, wavBlob, metrics, prompt /*{ja,en}*/, level /*'N3'*/, recentMistakes /*string[]*/ , signal })
// -> Analysis. Inline base64 when the request is < ~18MB, else Gemini Files API (resumable upload).
// Uses generationConfig.responseFormat {text:{mimeType:'application/json', schema}} (falls back to responseMimeType + responseJsonSchema). Validates/normalises the result
// (clamps numbers, fills missing arrays with []), never returns partial garbage.
export class AIError extends Error { code /* 'auth'|'rate_limit'|'network'|'bad_response'|'too_large'|'model'|'aborted' */; retryAfterSec }
```
```ts
Analysis = {
  version: 1,
  model: string,
  transcript: { start:number, end:number, text:string }[],   // sentence-level, seconds, Japanese as spoken
  corrections: { sentenceIndex:number, original:string, corrected:string, explanation:string,
                 type:'grammar'|'particle'|'conjugation'|'vocab'|'word_choice'|'register'|'other' }[],
  naturalRewrite: string,        // whole entry as a native speaker would say it (same content)
  translation: string,           // English translation of what the user meant
  pronunciation: { time:number, word:string, reading:string, issue:string, tip:string,
                   category:'long_vowel'|'sokuon'|'n'|'r'|'tsu_su'|'vowel'|'devoicing'|'other' }[],
  pitchAccent: { time:number, word:string, reading:string, expected:string, heard:string, tip:string }[],
                 // expected/heard as H/L mora patterns e.g. "LHH" plus type name (heiban/atamadaka/nakadaka/odaka)
  fluency: { fillers: { time:number, text:string }[], fillerCount:number, comment:string },
  scores: { grammar:number, pronunciation:number, pitchAccent:number, fluency:number, vocabulary:number }, // 0-100
  summary: string,               // 2-4 sentences, English, honest + encouraging
  strengths: string[],
  focusNext: string,             // one concrete thing to work on tomorrow
  cards: { front:string, back:string, note:string, kind:'correction'|'vocab'|'pronunciation'|'pitch' }[],
}
```
Feedback language: English explanations, Japanese examples. Level N3: no furigana needed except for
kanji above N3 (put reading in parentheses).

### js/db.js (app agent) — IndexedDB `hanashi-nikki`
Stores: `entries` (key `id`), `audio` (key `id`, `{id, blob, mimeType}`), `cards` (key `id`), `settings` (key `key`).
```ts
Entry = { id:string /* `${date}-${createdAt}` */, date:'YYYY-MM-DD' /* local date */, createdAt:number,
          durationSec:number, prompt:{ja:string,en:string}|null, audioId:string,
          metrics:AudioMetrics|null, analysis:Analysis|null,
          status:'saved'|'analyzing'|'done'|'error', error:string|null }
Card  = { id, front, back, note, kind, sourceEntryId, createdAt, due:number /*ms*/, interval:number /*days*/,
          ease:number, reps:number, lapses:number }
Settings keys: apiKey, model, level, minSeconds (default 60), reminderTime ('20:00'), lastExportAt
```
Export/import: one JSON file with entries+cards+settings (minus apiKey), audio as base64.

## Product behaviour (app agent)
- **Today**: daily prompt (deterministic per date from `prompts.js`, ~90 N3 topics, ja + en, "shuffle"
  allowed), big record button, live level meter + timer, min-length bar (default 60s). Entry counts for
  the streak only if `durationSec >= minSeconds`. After stop: save immediately → run local analysis →
  call Gemini → show result. If offline/rate-limited, keep `status:'saved'` and offer "Analyze" later
  (queue retried on next open).
- **Entry detail**: audio player; transcript with tap-to-seek timestamps; corrections inline
  (original struck → corrected + explanation); natural rewrite + translation; pronunciation & pitch
  notes with tap-to-replay (seek to time-0.5s, play ~3s); fluency (fillers, pauses, rate); pitch
  contour + volume chart (canvas) with pauses shaded; scores.
- **Calendar**: streak count (current + best), month heatmap, missed days visible, tap a day → entries.
- **Review**: SRS cards (SM-2-lite) created from `analysis.cards`, de-duped by normalised `front`.
- **Trends**: charts over time of scores, syllableRate, hesitation/confidence, filler count, pitch range.
- **Settings**: Gemini API key (with link + 3-step how-to for aistudio.google.com/apikey and a clear note
  that free-tier data may be used by Google to improve products), model picker (from `listModels`),
  min seconds, reminder time, export/import, delete all.
- **Reminders** ($0, no server): (1) "Add daily reminder to my calendar" → downloads a recurring
  `.ics` (DAILY RRULE, VALARM) — the reliable path on iOS; (2) best-effort local Notification when
  the app is opened/visible after the reminder time with no entry today; (3) app badge
  (`navigator.setAppBadge`) when today's entry is missing.
- PWA: manifest, icons (generate PNGs 192/512 + maskable + apple-touch), service worker caching the
  app shell (cache-first, versioned), never caching Gemini requests.
- Look: calm, notebook-like, dark-mode aware. Japanese font stack: system (Hiragino / Noto Sans JP).
