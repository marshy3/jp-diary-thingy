// audio-analysis.js — local, offline prosody/fluency metrics for a spoken diary entry.
//
// PURE module: no DOM, no Web Audio, no dependencies. Runs in browsers (main thread or a worker)
// and in Node (see tests/audio.test.mjs).
//
//   import { analyzeAudio } from './audio-analysis.js';
//   const metrics = analyzeAudio(samples /* Float32Array mono, -1..1 */, 16000);
//
// Pipeline (all per 20 ms hop, ~40 ms analysis window):
//   1. Frame energy  -> RMS dBFS per frame (via half-hop block energies, O(N)).
//   2. Adaptive VAD  -> noise floor = 10th percentile of frame dB, threshold = floor + 11 dB
//                       (capped for low-dynamic-range input; a loud flat clip counts as all
//                       speech), hysteresis, merge gaps < 0.25 s,
//                       drop segments < 0.1 s.
//   3. Pauses        -> gaps between speech segments (leading/trailing silence excluded);
//                       long pauses >= 1.2 s.
//   4. Pitch (F0)    -> YIN on speech frames only, signal decimated to ~8 kHz, 70–500 Hz,
//                       octave-jump correction against a local median, 5-frame median filter.
//   5. Syllables     -> de Jong & Wempe style intensity-peak nuclei (>= 2 dB dips, voiced).
//   6. Stats/scores  -> semitone range/std, volume trend (dB/min), hesitation & confidence 0–100.
//
// The returned object matches `AudioMetrics` (version 1) in CONTRACT.md exactly.

// ---------------------------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------------------------
const HOP_SEC = 0.02;            // frame hop (contract: pitch.frameSec / volume.frameSec)
const MAX_FRAMES = 30000;        // contract: "max ~30k frames" -> hop grows for entries > 10 min
const DB_FLOOR = -100;           // dBFS value used for digital silence

const VAD_FLOOR_PCT = 10;        // noise floor = this percentile of (median-smoothed) frame dB
const VAD_MARGIN_DB = 11;        // speech threshold = floor + margin
const VAD_MIN_MARGIN_DB = 6;     // ...but never closer than this to the floor
const VAD_PEAK_HEADROOM_DB = 15; // ...and not higher than (95th pct - headroom) when range is small
const VAD_ABS_MIN_DB = -60;      // nothing quieter than this is ever speech
const VAD_LOUD_FLAT_DB = -35;    // a flat recording louder than this is assumed to be all speech
const VAD_HYST_DB = 3;          // hysteresis: stay "on" until level drops below thr - hyst
const MERGE_GAP_SEC = 0.25;      // gaps shorter than this are bridged (also the minimum pause)
const MIN_SEG_SEC = 0.1;         // speech segments shorter than this are discarded
const LONG_PAUSE_SEC = 1.2;      // hesitation pause

const PITCH_MIN_HZ = 70;
const PITCH_MAX_HZ = 500;
const PITCH_TARGET_RATE = 8000;  // YIN runs on a decimated copy for speed
const YIN_WIN_SEC = 0.03;        // integration window of the difference function
const YIN_THRESHOLD = 0.15;      // CMNDF absolute threshold
const MIN_VOICED_RUN = 3;        // voiced runs shorter than this (frames) are treated as spurious

const NUCLEUS_DIP_DB = 2;        // a syllable peak must stand >= 2 dB above the dip to its neighbour
const NUCLEUS_REL_MAX_DB = 25;   // ...and be within 25 dB of the loud (99th pct) speech level

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

/**
 * Analyse a mono recording.
 * @param {Float32Array|number[]} samples mono PCM in [-1, 1]
 * @param {number} sampleRate Hz (16000 recommended, any rate >= 8000 works)
 * @returns {object} AudioMetrics (see CONTRACT.md)
 */
export function analyzeAudio(samples, sampleRate) {
  const sr = Number(sampleRate);
  const n = samples && typeof samples.length === 'number' ? samples.length : 0;
  if (!(sr > 0) || !Number.isFinite(sr) || n < 2) return emptyMetrics(n > 0 && sr > 0 ? n / sr : 0);

  const x = samples instanceof Float32Array ? samples : Float32Array.from(samples, sanitize);
  const durationSec = n / sr;

  // --- 1. framing --------------------------------------------------------------------------
  let hopSec = HOP_SEC;
  if (durationSec / hopSec > MAX_FRAMES) hopSec = Math.ceil((durationSec / MAX_FRAMES) * 1000) / 1000;
  const hop = Math.max(2, Math.round(hopSec * sr));
  const frameSec = hop / sr;
  const nFrames = Math.max(1, Math.ceil(n / hop));
  const db = frameDb(x, hop, nFrames);

  // --- 2. VAD ------------------------------------------------------------------------------
  const vad = detectSpeech(db, frameSec);
  const { segFrames, speechMask, thrOn } = vad;
  const segments = segFrames.map(([a, b]) => ({ start: a * frameSec, end: Math.min(b * frameSec, durationSec) }));
  let speechSec = 0;
  for (const s of segments) speechSec += s.end - s.start;

  // --- 3. pauses ---------------------------------------------------------------------------
  const pauses = [];
  for (let i = 1; i < segments.length; i++) {
    const gap = { start: segments[i - 1].end, end: segments[i].start };
    if (gap.end - gap.start >= MERGE_GAP_SEC - 1e-9) pauses.push(gap);
  }
  const longPauses = pauses.filter((p) => p.end - p.start >= LONG_PAUSE_SEC - 1e-9);
  const meanPauseSec = pauses.length ? pauses.reduce((s, p) => s + p.end - p.start, 0) / pauses.length : 0;

  // --- 4. pitch ----------------------------------------------------------------------------
  const hz = trackPitch(x, sr, hop, nFrames, speechMask, db, thrOn - VAD_HYST_DB);

  // --- 5. syllable nuclei ------------------------------------------------------------------
  const nuclei = countNuclei(db, hz, segFrames, speechMask, thrOn);
  const syllableRate = durationSec > 0 ? nuclei / durationSec : 0;
  const articulationRate = speechSec > 0 ? nuclei / speechSec : 0;

  // --- 6. pitch statistics (semitones re: median, voiced frames) -----------------------------
  const voiced = [];
  for (let i = 0; i < nFrames; i++) if (hz[i] > 0) voiced.push(hz[i]);
  let medianHz = 0, rangeSemitones = 0, stdSemitones = 0;
  if (voiced.length >= 3) {
    const sortedHz = Float64Array.from(voiced).sort();
    medianHz = pctSorted(sortedHz, 50);
    const st = new Float64Array(voiced.length);
    for (let i = 0; i < voiced.length; i++) st[i] = 12 * Math.log2(voiced[i] / medianHz);
    const stSorted = Float64Array.from(st).sort();
    rangeSemitones = pctSorted(stSorted, 95) - pctSorted(stSorted, 5);
    stdSemitones = stdev(st);
  }

  // --- volume statistics -------------------------------------------------------------------
  const vol = volumeStats(db, speechMask, frameSec, speechSec);

  // --- scores ------------------------------------------------------------------------------
  const { hesitationScore, confidenceScore } = scores({
    segments, longPauses, speechSec, stdSemitones, vol,
  });

  return {
    version: 1,
    durationSec: r3(durationSec),
    speechSec: r3(speechSec),
    speechRatio: r3(durationSec > 0 ? speechSec / durationSec : 0),
    segments: segments.map(roundSpan),
    pauses: pauses.map(roundSpan),
    longPauses: longPauses.map(roundSpan),
    meanPauseSec: r3(meanPauseSec),
    syllableRate: r2(syllableRate),
    articulationRate: r2(articulationRate),
    pitch: {
      frameSec: r6(frameSec),
      hz: roundArray(hz),
      medianHz: r1(medianHz),
      rangeSemitones: r2(rangeSemitones),
      stdSemitones: r2(stdSemitones),
    },
    volume: {
      frameSec: r6(frameSec),
      db: roundArray(db),
      meanDb: r1(vol.meanDb),
      trendDbPerMin: r2(vol.trendDbPerMin),
    },
    hesitationScore,
    confidenceScore,
  };
}

/** A valid all-zero AudioMetrics object (used for empty / unusable input). */
export function emptyMetrics(durationSec = 0) {
  return {
    version: 1,
    durationSec: r3(Number.isFinite(durationSec) ? durationSec : 0),
    speechSec: 0,
    speechRatio: 0,
    segments: [],
    pauses: [],
    longPauses: [],
    meanPauseSec: 0,
    syllableRate: 0,
    articulationRate: 0,
    pitch: { frameSec: HOP_SEC, hz: [], medianHz: 0, rangeSemitones: 0, stdSemitones: 0 },
    volume: { frameSec: HOP_SEC, db: [], meanDb: 0, trendDbPerMin: 0 },
    hesitationScore: 0,
    confidenceScore: 0,
  };
}

// ---------------------------------------------------------------------------------------------
// 1. Frame energy
// ---------------------------------------------------------------------------------------------

/**
 * RMS dBFS per frame. Frame i is centred on the middle of hop-cell i ([i*hop, (i+1)*hop)) and
 * spans two hops (≈40 ms). Computed from exact half-hop block energies, so it is O(N) and free
 * of the cancellation error a long prefix sum would have.
 */
function frameDb(x, hop, nFrames) {
  const n = x.length;
  const nBlocks = nFrames * 2 + 2; // half-hop blocks; block k covers [k*hop/2, (k+1)*hop/2)
  const eSum = new Float64Array(nBlocks);
  const eCnt = new Uint32Array(nBlocks);
  const half = hop / 2;
  for (let k = 0; k < nBlocks; k++) {
    const a = Math.round(k * half), b = Math.min(n, Math.round((k + 1) * half));
    let s = 0;
    for (let j = a; j < b; j++) { const v = x[j]; s += v * v; }
    eSum[k] = s;
    eCnt[k] = b > a ? b - a : 0;
  }
  const db = new Float64Array(nFrames);
  for (let i = 0; i < nFrames; i++) {
    // cell i = blocks 2i, 2i+1; window adds one half-block either side.
    let s = 0, c = 0;
    for (let k = 2 * i - 1; k <= 2 * i + 2; k++) {
      if (k < 0 || k >= nBlocks) continue;
      s += eSum[k]; c += eCnt[k];
    }
    const ms = c > 0 ? s / c : 0;
    const v = ms > 0 ? 10 * Math.log10(ms) : DB_FLOOR;
    db[i] = v < DB_FLOOR ? DB_FLOOR : v > 0 ? 0 : v;
  }
  return db;
}

// ---------------------------------------------------------------------------------------------
// 2. Voice activity detection
// ---------------------------------------------------------------------------------------------

function detectSpeech(db, frameSec) {
  const nF = db.length;
  // 3-frame median smoothing: removes single-frame clicks without smearing onsets.
  const sdb = new Float64Array(nF);
  for (let i = 0; i < nF; i++) {
    const a = db[i > 0 ? i - 1 : i], b = db[i], c = db[i < nF - 1 ? i + 1 : i];
    sdb[i] = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
  }
  const sorted = Float64Array.from(sdb).sort();
  const floor = pctSorted(sorted, VAD_FLOOR_PCT);
  const p95 = pctSorted(sorted, 95);
  // threshold = floor + margin, but when the recording has little dynamic range (loud noise,
  // quiet voice) pull it down towards (p95 - headroom), never closer than VAD_MIN_MARGIN_DB to
  // the floor and never below an absolute minimum.
  let thrOn = Math.max(floor + VAD_MIN_MARGIN_DB, Math.min(floor + VAD_MARGIN_DB, p95 - VAD_PEAK_HEADROOM_DB));
  thrOn = Math.max(thrOn, VAD_ABS_MIN_DB);
  // Degenerate case: no silence anywhere (speaker started instantly, clip is all voice) and the
  // level is loud and flat. Then the "floor" is really the voice; accept everything loud.
  if (p95 - floor < VAD_MIN_MARGIN_DB && floor > VAD_LOUD_FLAT_DB) thrOn = floor - VAD_HYST_DB;
  const thrOff = thrOn - VAD_HYST_DB;

  // hysteresis state machine -> raw runs [startFrame, endFrameExclusive)
  let runs = [];
  let on = false, start = 0;
  for (let i = 0; i < nF; i++) {
    const v = sdb[i];
    if (!on && v >= thrOn) { on = true; start = i; }
    else if (on && v < thrOff) { on = false; runs.push([start, i]); }
  }
  if (on) runs.push([start, nF]);

  // merge short gaps, then drop short segments
  const mergeFrames = MERGE_GAP_SEC / frameSec - 1e-9;
  const merged = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && r[0] - last[1] < mergeFrames) last[1] = r[1];
    else merged.push([r[0], r[1]]);
  }
  const minFrames = MIN_SEG_SEC / frameSec - 1e-9;
  const segFrames = merged.filter(([a, b]) => b - a >= minFrames);

  const speechMask = new Uint8Array(nF);
  for (const [a, b] of segFrames) speechMask.fill(1, a, b);
  return { segFrames, speechMask, thrOn, floor };
}

// ---------------------------------------------------------------------------------------------
// 4. Pitch tracking (YIN)
// ---------------------------------------------------------------------------------------------

/**
 * Per-frame F0 in Hz (0 = unvoiced / not speech).
 * Only frames inside speech segments whose level is above the VAD off-threshold are analysed.
 */
function trackPitch(x, sr, hop, nFrames, speechMask, db, minDb) {
  const raw = new Float64Array(nFrames);
  let any = false;
  for (let i = 0; i < nFrames; i++) if (speechMask[i] && db[i] >= minDb) { any = true; break; }
  if (!any) return raw;

  const { y, rate } = decimateForPitch(x, sr, speechMask, hop);
  const W = Math.max(16, Math.round(YIN_WIN_SEC * rate));
  const tauMin = Math.max(2, Math.floor(rate / PITCH_MAX_HZ));
  const tauMax = Math.ceil(rate / PITCH_MIN_HZ);
  const need = W + tauMax + 2;
  if (y.length < need) return raw;
  const cmnd = new Float64Array(tauMax + 2);
  const ratio = rate / sr;

  for (let i = 0; i < nFrames; i++) {
    if (!speechMask[i] || db[i] < minDb) continue;
    const centre = (i + 0.5) * hop * ratio;
    let st = Math.round(centre - need / 2);
    if (st < 0) st = 0;
    if (st + need > y.length) st = y.length - need;
    const f0 = yin(y, st, W, tauMin, tauMax, cmnd, rate);
    raw[i] = f0;
  }
  return postProcessPitch(raw);
}

/**
 * YIN (de Cheveigné & Kawahara 2002) on y[st .. st+W+tauMax]:
 *   d(τ)   = Σ_{j<W} (y[j] - y[j+τ])²                  (difference function)
 *   d'(τ)  = d(τ) · τ / Σ_{k=1..τ} d(k),  d'(0) = 1     (cumulative mean normalised difference)
 *   τ*     = first local minimum of d' below the threshold, refined by parabolic interpolation.
 * Computation stops as soon as that minimum is passed, which typically saves >50 % of the work.
 * Returns 0 if no dip goes below the threshold (unvoiced) or F0 is out of range.
 */
function yin(y, st, W, tauMin, tauMax, cmnd, rate) {
  cmnd[0] = 1;
  let running = 0;
  let best = -1;
  for (let tau = 1; tau <= tauMax; tau++) {
    let s = 0;
    const b = st + tau;
    for (let j = 0; j < W; j++) { const d = y[st + j] - y[b + j]; s += d * d; }
    running += s;
    const v = running > 0 ? (s * tau) / running : 1;
    cmnd[tau] = v;
    if (best < 0) {
      if (tau > tauMin && cmnd[tau - 1] < YIN_THRESHOLD && v >= cmnd[tau - 1]) { best = tau - 1; break; }
    }
  }
  if (best < 0) {
    // dip still descending at tauMax?
    if (cmnd[tauMax] < YIN_THRESHOLD) best = tauMax; else return 0;
  }
  if (running <= 0) return 0;
  // parabolic interpolation around best
  let tauF = best;
  if (best > 1 && best < tauMax) {
    const a = cmnd[best - 1], b = cmnd[best], c = cmnd[best + 1];
    const den = a - 2 * b + c;
    if (den > 0) {
      const delta = (0.5 * (a - c)) / den;
      if (delta > -1 && delta < 1) tauF = best + delta;
    }
  }
  const f0 = rate / tauF;
  return f0 >= PITCH_MIN_HZ && f0 <= PITCH_MAX_HZ ? f0 : 0;
}

/**
 * Decimate by an integer factor D = floor(sr / 8000) (16 kHz -> 8 kHz, 48 kHz -> 8 kHz,
 * 44.1 kHz -> 8.82 kHz) with a Hamming-windowed-sinc low-pass. Output samples are only computed
 * around speech frames (others left at 0), so silence costs nothing.
 */
function decimateForPitch(x, sr, speechMask, hop) {
  const D = Math.max(1, Math.floor(sr / PITCH_TARGET_RATE));
  if (D === 1) return { y: x, rate: sr };
  const rate = sr / D;
  const half = 4 * D;                         // taps = 8D + 1
  const taps = new Float64Array(2 * half + 1);
  const fc = 0.45 / D;                        // cutoff (cycles/sample) ~ 0.9 * new Nyquist
  let sum = 0;
  for (let k = -half; k <= half; k++) {
    const sinc = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
    const w = 0.54 + 0.46 * Math.cos((Math.PI * k) / half);
    taps[k + half] = sinc * w;
    sum += sinc * w;
  }
  for (let k = 0; k < taps.length; k++) taps[k] /= sum;

  const n = x.length;
  const m = Math.floor(n / D);
  const y = new Float32Array(m);
  // Output region per speech frame, padded so YIN windows (≈ 45 ms) are fully covered.
  const padOut = Math.ceil(0.03 * rate) + Math.ceil(rate / PITCH_MIN_HZ);
  const nF = speechMask.length;
  let i = 0;
  while (i < nF) {
    if (!speechMask[i]) { i++; continue; }
    let j = i;
    while (j < nF && speechMask[j]) j++;
    const a = Math.max(0, Math.floor((i * hop) / D) - padOut);
    const b = Math.min(m, Math.ceil((j * hop) / D) + padOut);
    for (let o = a; o < b; o++) {
      const c = o * D;
      let s = 0;
      if (c - half >= 0 && c + half < n) {
        for (let k = -half; k <= half; k++) s += x[c + k] * taps[k + half];
      } else {
        for (let k = -half; k <= half; k++) { const idx = c + k; if (idx >= 0 && idx < n) s += x[idx] * taps[k + half]; }
      }
      y[o] = s;
    }
    i = j;
  }
  return { y, rate };
}

/**
 * Pitch post-processing:
 *  1. octave-jump correction: compare each voiced frame with the median of voiced frames within
 *     ±12 frames (±240 ms); values ~2x / ~0.5x that median are folded back. A local (not global)
 *     reference keeps genuine glides intact.
 *  2. 5-frame median filter over voiced neighbours (unvoiced frames stay 0).
 *  3. voiced runs shorter than MIN_VOICED_RUN frames are removed as spurious.
 */
function postProcessPitch(raw) {
  const n = raw.length;
  const fixed = Float64Array.from(raw);
  const win = [];
  const R = 12;
  for (let i = 0; i < n; i++) {
    const f = raw[i];
    if (!(f > 0)) continue;
    win.length = 0;
    for (let k = Math.max(0, i - R); k <= Math.min(n - 1, i + R); k++) if (raw[k] > 0) win.push(raw[k]);
    if (win.length < 5) continue;
    win.sort((a, b) => a - b);
    const ref = win[win.length >> 1];
    const r = f / ref;
    if (r > 1.75 && r < 2.3 && f / 2 >= PITCH_MIN_HZ) fixed[i] = f / 2;
    else if (r > 0.43 && r < 0.57 && f * 2 <= PITCH_MAX_HZ) fixed[i] = f * 2;
  }
  // 5-frame median over voiced neighbours
  const med = new Float64Array(n);
  const buf = [];
  for (let i = 0; i < n; i++) {
    if (!(fixed[i] > 0)) continue;
    buf.length = 0;
    for (let k = i - 2; k <= i + 2; k++) if (k >= 0 && k < n && fixed[k] > 0) buf.push(fixed[k]);
    buf.sort((a, b) => a - b);
    med[i] = buf.length % 2 ? buf[buf.length >> 1] : 0.5 * (buf[buf.length / 2 - 1] + buf[buf.length / 2]);
  }
  // remove very short voiced runs
  let i = 0;
  while (i < n) {
    if (!(med[i] > 0)) { i++; continue; }
    let j = i;
    while (j < n && med[j] > 0) j++;
    if (j - i < MIN_VOICED_RUN) med.fill(0, i, j);
    i = j;
  }
  return med;
}

// ---------------------------------------------------------------------------------------------
// 5. Syllable nuclei (de Jong & Wempe 2009, simplified)
// ---------------------------------------------------------------------------------------------

/**
 * Count intensity peaks inside speech segments that
 *   - are local maxima of the 3-frame-smoothed intensity contour,
 *   - are above the VAD threshold and within 25 dB of the loud speech level (99th pct),
 *   - are separated from the previous accepted peak by a dip of >= 2 dB (else the louder wins),
 *   - are voiced (pitch > 0 at the peak or an adjacent frame).
 */
function countNuclei(db, hz, segFrames, speechMask, thrOn) {
  const n = db.length;
  if (!segFrames.length) return 0;
  const sm = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = db[i > 0 ? i - 1 : i], c = db[i < n - 1 ? i + 1 : i];
    sm[i] = (a + db[i] + c) / 3;
  }
  const speechLevels = [];
  for (let i = 0; i < n; i++) if (speechMask[i]) speechLevels.push(sm[i]);
  const loud = pctSorted(Float64Array.from(speechLevels).sort(), 99);
  const minPeak = Math.max(thrOn, loud - NUCLEUS_REL_MAX_DB);

  let count = 0;
  for (const [a, b] of segFrames) {
    const peaks = [];
    for (let i = Math.max(a, 1); i < Math.min(b, n - 1); i++) {
      const v = sm[i];
      if (v >= sm[i - 1] && v > sm[i + 1] && v >= minPeak) peaks.push(i);
    }
    const accepted = [];
    for (const p of peaks) {
      const last = accepted[accepted.length - 1];
      if (last === undefined) { accepted.push(p); continue; }
      let dip = Infinity;
      for (let k = last; k <= p; k++) if (sm[k] < dip) dip = sm[k];
      if (Math.min(sm[last], sm[p]) - dip >= NUCLEUS_DIP_DB) accepted.push(p);
      else if (sm[p] > sm[last]) accepted[accepted.length - 1] = p;
    }
    for (const p of accepted) {
      if (hz[p] > 0 || (p > 0 && hz[p - 1] > 0) || (p < n - 1 && hz[p + 1] > 0)) count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------------------------
// Volume statistics
// ---------------------------------------------------------------------------------------------

function volumeStats(db, speechMask, frameSec, speechSec) {
  const n = db.length;
  let cnt = 0, sum = 0;
  let st = 0, sx = 0, stt = 0, stx = 0; // regression sums (t in minutes)
  for (let i = 0; i < n; i++) {
    if (!speechMask[i]) continue;
    const v = db[i];
    const t = (i * frameSec) / 60;
    cnt++; sum += v;
    st += t; sx += v; stt += t * t; stx += t * v;
  }
  const meanDb = cnt ? sum / cnt : 0;
  // Least-squares slope of speech-frame dB against time. Needs >= 3 s of speech to mean anything;
  // clamped to ±60 dB/min so a short entry can't produce absurd numbers.
  let trendDbPerMin = 0;
  if (cnt > 2 && speechSec >= 3) {
    const den = cnt * stt - st * st;
    if (den > 0) trendDbPerMin = clamp((cnt * stx - st * sx) / den, -60, 60);
  }
  // Steadiness: std of ~1 s block means of speech-frame dB (blocks with >= 20 % speech).
  const blk = Math.max(1, Math.round(1 / frameSec));
  const means = [];
  for (let a = 0; a < n; a += blk) {
    let s = 0, c = 0;
    for (let i = a; i < Math.min(n, a + blk); i++) if (speechMask[i]) { s += db[i]; c++; }
    if (c >= blk * 0.2) means.push(s / c);
  }
  const blockStdDb = means.length >= 2 ? stdev(means) : 0;
  return { meanDb, trendDbPerMin, blockStdDb };
}

// ---------------------------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------------------------

/**
 * Both scores are computed over the ACTIVE span (first speech onset -> last speech offset), so
 * silence before pressing "speak" or after finishing never counts as hesitation.
 * With no speech at all both scores are 0.
 *
 *   activeSec    = lastSeg.end - firstSeg.start
 *   activeRatio  = speechSec / activeSec
 *   lpm          = longPauses.length / (activeSec / 60)            (long pauses per minute)
 *   meanLong     = mean long-pause length in s (0 if none)
 *
 *   P = clamp(lpm / 6, 0, 1)                       6+ long pauses/min      -> 1
 *   S = clamp((0.85 - activeRatio) / 0.55, 0, 1)   ratio 0.85+ -> 0, 0.30- -> 1
 *   L = clamp((meanLong - 1.2) / 2.8, 0, 1)        long pauses of 4 s+     -> 1
 *
 *   hesitationScore = round(100 * (0.45 P + 0.35 S + 0.20 L))
 *     -> monotonic: more/longer long pauses or lower speech ratio never lowers it.
 *
 *   V  = 1 - clamp((blockStdDb - 2) / 8, 0, 1)     volume steadiness (1 s block means; 2 dB ok, 10 dB bad)
 *   F  = clamp(-trendDbPerMin / 10, 0, 1)          fading out (10 dB/min fade -> 1); getting louder is fine
 *   Pv = pitch variety: ramps 0 -> 1 as stdSemitones goes 0 -> 2.5, flat 1 up to 6,
 *        then decays to 0 at 12 (erratic). Moderate variety is rewarded, monotone is not.
 *   Ld = clamp((meanDb + 45) / 20, 0, 1)           loudness (-45 dBFS -> 0, -25 dBFS+ -> 1)
 *
 *   confidenceScore = round(100 * (0.25 V(1 - 0.5F) + 0.30 (1 - P) + 0.20 (1 - S) + 0.15 Pv + 0.10 Ld))
 *     -> monotonic: steadier volume, fewer long pauses, higher speech ratio, louder voice and
 *        pitch variety moving towards the 2.5–6 st band never lower it.
 */
function scores({ segments, longPauses, speechSec, stdSemitones, vol }) {
  if (!segments.length || speechSec <= 0) return { hesitationScore: 0, confidenceScore: 0 };
  const activeSec = Math.max(segments[segments.length - 1].end - segments[0].start, 1e-6);
  const activeRatio = clamp(speechSec / activeSec, 0, 1);
  const lpm = longPauses.length / Math.max(activeSec / 60, 1 / 6); // floor at 10 s to avoid spikes
  const meanLong = longPauses.length
    ? longPauses.reduce((s, p) => s + p.end - p.start, 0) / longPauses.length : 0;

  const P = clamp(lpm / 6, 0, 1);
  const S = clamp((0.85 - activeRatio) / 0.55, 0, 1);
  const L = clamp((meanLong - LONG_PAUSE_SEC) / 2.8, 0, 1);
  const hesitation = 100 * (0.45 * P + 0.35 * S + 0.2 * L);

  const V = 1 - clamp((vol.blockStdDb - 2) / 8, 0, 1);
  const F = clamp(-vol.trendDbPerMin / 10, 0, 1);
  const sd = stdSemitones;
  const Pv = sd <= 2.5 ? clamp(sd / 2.5, 0, 1) : sd <= 6 ? 1 : 1 - clamp((sd - 6) / 6, 0, 1);
  const Ld = clamp((vol.meanDb + 45) / 20, 0, 1);
  const confidence = 100 * (0.25 * V * (1 - 0.5 * F) + 0.3 * (1 - P) + 0.2 * (1 - S) + 0.15 * Pv + 0.1 * Ld);

  return {
    hesitationScore: Math.round(clamp(hesitation, 0, 100)),
    confidenceScore: Math.round(clamp(confidence, 0, 100)),
  };
}

// ---------------------------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------------------------

/** Linear-interpolated percentile of an ascending-sorted array (p in 0..100). */
function pctSorted(sorted, p) {
  const n = sorted.length;
  if (!n) return 0;
  const pos = (clamp(p, 0, 100) / 100) * (n - 1);
  const lo = Math.floor(pos), hi = Math.min(n - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function stdev(arr) {
  const n = arr.length;
  if (n < 2) return 0;
  let m = 0;
  for (let i = 0; i < n; i++) m += arr[i];
  m /= n;
  let v = 0;
  for (let i = 0; i < n; i++) { const d = arr[i] - m; v += d * d; }
  return Math.sqrt(v / n);
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : Number.isFinite(v) ? v : lo; }
function sanitize(v) { v = Number(v); return Number.isFinite(v) ? v : 0; }
function fin(v) { return Number.isFinite(v) ? v : 0; }
function r1(v) { return Math.round(fin(v) * 10) / 10; }
function r2(v) { return Math.round(fin(v) * 100) / 100; }
function r3(v) { return Math.round(fin(v) * 1000) / 1000; }
function r6(v) { return Math.round(fin(v) * 1e6) / 1e6; }
function roundSpan(s) { return { start: r3(s.start), end: r3(s.end) }; }
function roundArray(a) {
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = Math.round(fin(a[i]) * 10) / 10;
  return out;
}
