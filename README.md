# 話し日記 Hanashi Nikki

A $0 daily speaking diary for Japanese. Speak for a minute or more every day. The app keeps each
entry, measures your pitch, pauses, speed and volume on your phone, and has Google Gemini (free
tier) listen to the recording. It returns a corrected transcript, a natural native rewrite,
pronunciation and pitch-accent notes you can tap to replay, filler counts, scores, and review flashcards.

- Runs as an installable web app on iPhone, Android and desktop. No build step, no dependencies.
- All entries are stored on your device (IndexedDB). Only the Gemini request leaves the phone.
- Daily prompt, minimum length (default 60 s), streak + calendar, reminders, SRS review, trends.

## 1. Put it online for free (GitHub Pages, ~5 min)
1. Create a new public repo on GitHub (e.g. `hanashi-nikki`) and upload every file in this folder.
   You can drag-and-drop on github.com → "Add file → Upload files".
2. Repo → **Settings → Pages** → Source: *Deploy from a branch* → Branch `main`, folder `/ (root)` → Save.
3. After about a minute, the app is at `https://<your-username>.github.io/hanashi-nikki/`.
   The microphone only works over HTTPS, which Pages provides.

## 2. Install it on your phone
- **iPhone (Safari):** open the URL → Share → **Add to Home Screen**. Open it from the home-screen icon.
  This is required for notifications and makes iOS much less likely to clear your data.
- **Android (Chrome):** open the URL → ⋮ → **Install app**.

## 3. Get a free Gemini API key
1. Go to https://aistudio.google.com/apikey and sign in with a Google account.
2. Click **Create API key** (no billing needed).
3. In the app: **設定 Settings → paste key → Test**. Then pick a model (default `gemini-3.8-flash`).

Free tier notes: there are daily/minute rate limits (the app queues and retries automatically), and
Google may use free-tier inputs to improve its products. Your key is stored only on your device and
is never included in exports.

## 4. Daily reminder
Settings → **Add daily reminder to calendar** downloads a repeating calendar event. This is the
reliable free option on iPhone. Real push notifications would need a server. Once the app is
installed, a notification and app badge also appear when you open it after your reminder time
without an entry.

## Backups
Settings → **Export** saves everything (including audio) as one JSON file. Import restores it.
Do this occasionally: the data lives in your browser.

## Limits to know
- Entries up to ~9 minutes are sent directly. Longer ones use Gemini's file upload, which may be
  blocked by the browser. If that happens you'll get a "try a shorter entry" message.
- AI feedback, especially pitch accent, can be wrong. Treat it as a second opinion.
- The pitch/pause/speed numbers are acoustic estimates from your phone, not lab measurements.

## Development
```
python3 -m http.server 8000         # then open http://localhost:8000
node tests/audio.test.mjs           # local audio analysis (12 tests)
node tests/ai.test.mjs              # Gemini client, mocked fetch (32 tests)
node --test tests/app.test.mjs      # SRS, streaks, prompts, .ics (19 tests)
python3 tests/smoke.py              # headless-Chrome run of every screen → tests/screenshots/
```
When you change files, bump `VERSION` in `sw.js` so phones pick up the update. Any new file has
to be added to the `SHELL` list there. Module APIs and data shapes are in `CONTRACT.md`.

Layout: `js/recorder.js` `js/wav.js` `js/audio-analysis.js` (on-device audio), `js/ai.js` (Gemini),
`js/app.js` + `js/views/*` (UI), `js/db.js` (storage), `js/srs.js` (flashcards), `js/prompts.js` (90 topics).
