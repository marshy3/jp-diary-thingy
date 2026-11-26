// wav.js — decode recorded audio to mono PCM and encode 16-bit mono WAV.
//
//   blobToMonoPCM(blob, 16000)        browser only (Web Audio decodeAudioData)
//   encodeWav(samples, sampleRate)    -> Blob('audio/wav')
//   pcmToWavArrayBuffer(samples, sr)  -> ArrayBuffer   (pure, works in Node)
//   resampleLinear(samples, from, to) -> Float32Array  (pure JS fallback resampler)

/**
 * Decode an encoded audio Blob (webm/opus, mp4/aac, ogg, wav...) to mono Float32 PCM at targetRate.
 * Decoding uses an OfflineAudioContext (no audio output device, no autoplay restrictions, and
 * doesn't count against iOS's small limit of live AudioContexts). Prefers decoding straight at
 * targetRate (browser-native high-quality resampling); otherwise resamples with an
 * OfflineAudioContext render, and finally with a JS linear-interpolation fallback.
 * @returns {Promise<{samples: Float32Array, sampleRate: number}>}
 */
export async function blobToMonoPCM(blob, targetRate = 16000) {
  if (!blob || !blob.size) throw codedError('Empty recording.', 'decode');
  const encoded = await blob.arrayBuffer();

  let buffer;
  try {
    buffer = await decode(encoded, targetRate);
  } catch (err) {
    throw codedError(`Could not decode audio (${(err && err.message) || err}).`, 'decode', err);
  }

  const mono = downmix(buffer);
  if (buffer.sampleRate === targetRate) return { samples: mono, sampleRate: targetRate };

  let samples;
  try {
    samples = await resampleOffline(mono, buffer.sampleRate, targetRate);
  } catch {
    samples = null;
  }
  if (!samples) samples = resampleLinear(mono, buffer.sampleRate, targetRate);
  return { samples, sampleRate: targetRate };
}

/** 16-bit PCM mono WAV Blob. */
export function encodeWav(samples, sampleRate) {
  return new Blob([pcmToWavArrayBuffer(samples, sampleRate)], { type: 'audio/wav' });
}

/**
 * Pure RIFF/WAVE encoder: 44-byte canonical header + little-endian 16-bit PCM, mono.
 * Samples are clamped to [-1, 1]; NaN becomes 0. Negative values scale by 32768, positive by 32767
 * so that -1 and 1 map exactly to the int16 extremes.
 * @param {Float32Array|number[]} samples
 * @param {number} sampleRate
 * @returns {ArrayBuffer}
 */
export function pcmToWavArrayBuffer(samples, sampleRate) {
  const n = samples ? samples.length : 0;
  const sr = Math.round(sampleRate) || 16000;
  const dataBytes = n * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  writeAscii(v, 0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  writeAscii(v, 8, 'WAVE');
  writeAscii(v, 12, 'fmt ');
  v.setUint32(16, 16, true);          // fmt chunk size
  v.setUint16(20, 1, true);           // PCM
  v.setUint16(22, 1, true);           // channels
  v.setUint32(24, sr, true);          // sample rate
  v.setUint32(28, sr * 2, true);      // byte rate
  v.setUint16(32, 2, true);           // block align
  v.setUint16(34, 16, true);          // bits per sample
  writeAscii(v, 36, 'data');
  v.setUint32(40, dataBytes, true);
  const out = new Int16Array(buf, 44, n); // offset 44 is 2-byte aligned; platform is little-endian
  if (isLittleEndian()) {
    for (let i = 0; i < n; i++) out[i] = toInt16(samples[i]);
  } else {
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, toInt16(samples[i]), true);
  }
  return buf;
}

/**
 * Pure JS resampler: linear interpolation, with a box pre-filter when downsampling by > 1.5x to
 * limit aliasing. Good enough for speech analysis; used only when OfflineAudioContext can't.
 */
export function resampleLinear(samples, fromRate, toRate) {
  if (fromRate === toRate) return Float32Array.from(samples);
  const n = samples.length;
  let src = samples;
  const ratio = fromRate / toRate;
  if (ratio > 1.5) {
    // moving average of width ≈ ratio (a crude low-pass at the new Nyquist)
    const w = Math.max(1, Math.round(ratio));
    const f = new Float32Array(n);
    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc += samples[i];
      if (i >= w) acc -= samples[i - w];
      f[i] = acc / Math.min(i + 1, w);
    }
    src = f;
    // compensate the (w-1)/2 sample delay of the causal average below
    const shift = (w - 1) / 2;
    return interp(src, n, ratio, shift, Math.floor(n / ratio));
  }
  return interp(src, n, ratio, 0, Math.floor(n / ratio));
}

// ---------------------------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------------------------

function interp(src, n, ratio, shift, outLen) {
  const out = new Float32Array(Math.max(0, outLen));
  for (let i = 0; i < out.length; i++) {
    const p = i * ratio + shift;
    const i0 = Math.floor(p);
    if (i0 >= n - 1) { out[i] = src[n - 1] || 0; continue; }
    const frac = p - i0;
    out[i] = src[i0] + (src[i0 + 1] - src[i0]) * frac;
  }
  return out;
}

function getOfflineCtor() {
  const g = typeof globalThis !== 'undefined' ? globalThis : window;
  return g.OfflineAudioContext || g.webkitOfflineAudioContext || null;
}
function getRealtimeCtor() {
  const g = typeof globalThis !== 'undefined' ? globalThis : window;
  return g.AudioContext || g.webkitAudioContext || null;
}

/** decodeAudioData supporting both the promise form and old Safari's callback-only form. */
function decodeWith(ctx, arrayBuffer) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ok = (b) => { if (!settled) { settled = true; resolve(b); } };
    const fail = (e) => { if (!settled) { settled = true; reject(e || new Error('decodeAudioData failed')); } };
    try {
      const p = ctx.decodeAudioData(arrayBuffer, ok, fail);
      if (p && typeof p.then === 'function') p.then(ok, fail);
    } catch (e) { fail(e); }
  });
}

/**
 * Try, in order: OfflineAudioContext at targetRate (decoded buffer arrives resampled),
 * OfflineAudioContext at 44.1 kHz (older Safari only accepts common rates), then a realtime
 * AudioContext (closed right after). Each attempt gets a fresh copy because decodeAudioData
 * detaches its input buffer.
 */
async function decode(encoded, targetRate) {
  const Offline = getOfflineCtor();
  const Realtime = getRealtimeCtor();
  const attempts = [];
  if (Offline) {
    attempts.push(() => new Offline(1, 1, targetRate));
    attempts.push(() => new Offline(1, 1, 44100));
  }
  if (Realtime) attempts.push(() => new Realtime());
  if (!attempts.length) throw new Error('Web Audio API not available');

  let lastErr;
  for (const make of attempts) {
    let ctx;
    try {
      ctx = make();
    } catch (e) { lastErr = e; continue; }
    try {
      const buf = await decodeWith(ctx, encoded.slice(0));
      if (buf && buf.length) return buf;
      lastErr = new Error('decoded buffer is empty');
    } catch (e) {
      lastErr = e;
    } finally {
      if (ctx && typeof ctx.close === 'function' && !(Offline && ctx instanceof Offline)) {
        try { ctx.close(); } catch { /* ignore */ }
      }
    }
  }
  throw lastErr || new Error('decode failed');
}

/** Average all channels into one Float32Array. */
function downmix(buffer) {
  const ch = buffer.numberOfChannels;
  if (ch === 1) return Float32Array.from(buffer.getChannelData(0));
  const len = buffer.length;
  const out = new Float32Array(len);
  for (let c = 0; c < ch; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < len; i++) out[i] += d[i];
  }
  const k = 1 / ch;
  for (let i = 0; i < len; i++) out[i] *= k;
  return out;
}

/** High-quality resample by rendering through an OfflineAudioContext. Resolves null if unsupported. */
async function resampleOffline(mono, fromRate, toRate) {
  const Offline = getOfflineCtor();
  if (!Offline) return null;
  const outLen = Math.max(1, Math.round((mono.length * toRate) / fromRate));
  let ctx;
  try { ctx = new Offline(1, outLen, toRate); } catch { return null; }
  const src = ctx.createBuffer(1, mono.length, fromRate);
  if (src.copyToChannel) src.copyToChannel(mono, 0); else src.getChannelData(0).set(mono);
  const node = ctx.createBufferSource();
  node.buffer = src;
  node.connect(ctx.destination);
  node.start(0);
  const rendered = await new Promise((resolve, reject) => {
    ctx.oncomplete = (e) => resolve(e.renderedBuffer);
    try {
      const p = ctx.startRendering();
      if (p && typeof p.then === 'function') p.then(resolve, reject);
    } catch (e) { reject(e); }
  });
  return Float32Array.from(rendered.getChannelData(0));
}

function toInt16(s) {
  s = Number(s);
  if (!(s === s)) return 0; // NaN
  if (s >= 1) return 32767;
  if (s <= -1) return -32768;
  return s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
}

function writeAscii(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

let _le;
function isLittleEndian() {
  if (_le === undefined) _le = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  return _le;
}

function codedError(message, code, cause) {
  const e = new Error(message);
  e.code = code;
  if (cause) e.cause = cause;
  return e;
}
