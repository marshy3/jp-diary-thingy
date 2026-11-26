// recorder.js — microphone capture with a live level meter.
//
//   if (isRecordingSupported()) {
//     button.onclick = async () => {               // MUST be called from a user gesture (iOS)
//       const rec = await startRecording({ onLevel: (l) => meter.value = l });
//       ...
//       const { blob, mimeType, durationSec } = await rec.stop();   // or rec.cancel()
//     };
//   }
//
// Errors thrown by startRecording carry err.code: 'permission' | 'unsupported' | 'no_device'.
//
// iOS notes:
//  * The AudioContext used for the level meter is created and resume()d synchronously inside
//    startRecording, BEFORE the first await, so it still counts as part of the user gesture.
//    Call startRecording directly from a click/touchend handler.
//  * Safari's MediaRecorder produces audio/mp4 (AAC); Chrome/Firefox produce webm/ogg Opus.
//  * Mic tracks are always stopped on stop()/cancel() so the red recording indicator goes away.

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', ''];
const LEVEL_INTERVAL_MS = 50;   // ~20 Hz meter updates
const LEVEL_FLOOR_DB = -60;     // meter maps [-60 dBFS, 0 dBFS] -> [0, 1]

/** True if this browser can record audio with getUserMedia + MediaRecorder. */
export function isRecordingSupported() {
  return typeof navigator !== 'undefined' &&
    !!(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function') &&
    typeof window !== 'undefined' && typeof window.MediaRecorder === 'function';
}

/** First supported mimeType from the preference list ('' = let the browser choose). */
export function pickMimeType() {
  const MR = typeof window !== 'undefined' ? window.MediaRecorder : undefined;
  if (!MR) return '';
  for (const t of MIME_CANDIDATES) {
    if (t === '') return '';
    try { if (typeof MR.isTypeSupported === 'function' && MR.isTypeSupported(t)) return t; } catch { /* ignore */ }
  }
  return '';
}

/**
 * Start recording.
 * @param {{ onLevel?: (level: number) => void }} [opts] onLevel receives 0..1 (perceptual: dB-scaled)
 * @returns {Promise<{ stop(): Promise<{blob: Blob, mimeType: string, durationSec: number}>,
 *                     cancel(): void, elapsedSec(): number }>}
 */
export async function startRecording({ onLevel } = {}) {
  if (!isRecordingSupported()) {
    throw codedError('Audio recording is not supported in this browser.', 'unsupported');
  }

  // --- created synchronously in the user gesture (iOS requirement) ---------------------------
  let ctx = null;
  if (typeof onLevel === 'function') {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      try {
        ctx = new AC();
        if (ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(() => {});
      } catch { ctx = null; } // meter is optional; recording still works
    }
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,     // helps with room echo/speaker bleed
        noiseSuppression: true,     // cleaner VAD and pitch
        autoGainControl: false,     // keep volume metrics meaningful (no automatic levelling)
      },
      video: false,
    });
  } catch (err) {
    closeCtx(ctx);
    throw mapGetUserMediaError(err);
  }

  // --- MediaRecorder -------------------------------------------------------------------------
  const chosen = pickMimeType();
  let recorder;
  try {
    recorder = chosen ? new MediaRecorder(stream, { mimeType: chosen }) : new MediaRecorder(stream);
  } catch (err) {
    try { recorder = new MediaRecorder(stream); } catch (err2) {
      stopTracks(stream); closeCtx(ctx);
      throw codedError(`MediaRecorder could not start (${(err2 && err2.message) || err2}).`, 'unsupported', err2);
    }
  }

  const chunks = [];
  let startedAt = 0;          // performance.now() when recording actually started
  let stoppedAt = 0;
  let cleaned = false;
  let cancelled = false;
  let levelTimer = null;

  const stopped = new Promise((resolve) => {
    recorder.addEventListener('stop', () => resolve(), { once: true });
  });
  recorder.addEventListener('dataavailable', (e) => { if (e.data && e.data.size) chunks.push(e.data); });
  recorder.addEventListener('error', () => { try { if (recorder.state !== 'inactive') recorder.stop(); } catch { /* ignore */ } });
  recorder.addEventListener('start', () => { startedAt = now(); }, { once: true });

  // If the mic disappears (unplugged, iOS phone call, other app grabs it) stop cleanly; stop()
  // will still return everything captured so far.
  for (const track of stream.getAudioTracks()) {
    track.addEventListener('ended', () => {
      try { if (recorder.state !== 'inactive') recorder.stop(); } catch { /* ignore */ }
    });
  }

  // --- live level meter (AnalyserNode RMS) ---------------------------------------------------
  if (ctx) {
    try {
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0;
      source.connect(analyser); // not connected to destination: no monitoring/feedback
      const buf = new Float32Array(analyser.fftSize);
      const hasFloat = typeof analyser.getFloatTimeDomainData === 'function';
      const bytes = hasFloat ? null : new Uint8Array(analyser.fftSize);
      let smoothed = 0;
      levelTimer = setInterval(() => {
        if (cleaned) return;
        if (ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(() => {});
        let sum = 0;
        if (hasFloat) {
          analyser.getFloatTimeDomainData(buf);
          for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        } else {
          analyser.getByteTimeDomainData(bytes);
          for (let i = 0; i < bytes.length; i++) { const v = (bytes[i] - 128) / 128; sum += v * v; }
        }
        const rms = Math.sqrt(sum / buf.length);
        const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
        const level = Math.max(0, Math.min(1, (db - LEVEL_FLOOR_DB) / -LEVEL_FLOOR_DB));
        // fast attack, slower release so the meter looks natural
        smoothed = level > smoothed ? level : smoothed * 0.7 + level * 0.3;
        try { onLevel(smoothed); } catch { /* never let UI errors kill recording */ }
      }, LEVEL_INTERVAL_MS);
    } catch {
      // meter unavailable; recording continues
    }
  }

  try {
    recorder.start(1000); // timeslice: periodic chunks (also avoids losing everything on a crash)
  } catch (err) {
    cleanup();
    throw codedError(`Recording could not start (${(err && err.message) || err}).`, 'unsupported', err);
  }
  if (!startedAt) startedAt = now();

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    if (levelTimer) clearInterval(levelTimer);
    levelTimer = null;
    stopTracks(stream);
    closeCtx(ctx);
    ctx = null;
    if (typeof onLevel === 'function') { try { onLevel(0); } catch { /* ignore */ } }
  }

  function elapsedSec() {
    if (!startedAt) return 0;
    return ((stoppedAt || now()) - startedAt) / 1000;
  }

  let stopPromise = null;
  function stop() {
    if (cancelled) return Promise.reject(codedError('Recording was cancelled.', 'cancelled'));
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      if (!stoppedAt) stoppedAt = now();
      if (recorder.state !== 'inactive') {
        try { recorder.stop(); } catch { /* already stopping */ }
      }
      await stopped;
      cleanup();
      const mimeType = recorder.mimeType || chosen || (chunks[0] && chunks[0].type) || 'audio/webm';
      const blob = new Blob(chunks, { type: mimeType });
      return { blob, mimeType, durationSec: Math.max(0, elapsedSec()) };
    })();
    return stopPromise;
  }

  function cancel() {
    if (cancelled) return;
    cancelled = true;
    if (!stoppedAt) stoppedAt = now();
    try { if (recorder.state !== 'inactive') recorder.stop(); } catch { /* ignore */ }
    chunks.length = 0;
    cleanup();
  }

  return { stop, cancel, elapsedSec };
}

// ---------------------------------------------------------------------------------------------

function mapGetUserMediaError(err) {
  const name = (err && err.name) || '';
  const msg = (err && err.message) || String(err);
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return codedError('Microphone permission was denied. Allow microphone access in your browser/site settings and try again.', 'permission', err);
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return codedError('No microphone was found.', 'no_device', err);
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return codedError('The microphone is unavailable (it may be in use by another app).', 'no_device', err);
    case 'TypeError':
    case 'NotSupportedError':
      return codedError(`Audio recording is not supported here (${msg}). The page must be served over HTTPS.`, 'unsupported', err);
    default:
      return codedError(`Could not access the microphone (${msg}).`, 'no_device', err);
  }
}

function stopTracks(stream) {
  if (!stream) return;
  for (const t of stream.getTracks()) { try { t.stop(); } catch { /* ignore */ } }
}

function closeCtx(ctx) {
  if (ctx && ctx.state !== 'closed' && typeof ctx.close === 'function') {
    try { ctx.close().catch(() => {}); } catch { /* ignore */ }
  }
}

function now() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

function codedError(message, code, cause) {
  const e = new Error(message);
  e.code = code;
  if (cause) e.cause = cause;
  return e;
}
