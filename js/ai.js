// js/ai.js — Gemini REST client for Hanashi Nikki (AI agent).
// Vanilla ES module, no dependencies. Runs in the browser and in Node 22 (for tests).
//
// Sources checked on 2026-11-25 (ai.google.dev/gemini-api/docs/* now redirects to aistudio.google.com/docs/*):
// - Models & ids (gemini-3.8-flash "New", gemini-3.6-flash Stable, gemini-3.5-flash-lite Stable,
//   gemini-3.1-flash-lite Stable, gemini-3-flash-preview Preview; 2.5 models restricted to existing users):
//     https://aistudio.google.com/docs/models
//     https://aistudio.google.com/docs/models/gemini-3.8-flash   (audio input; thinking low/medium/high, NOT minimal)
//     https://aistudio.google.com/docs/models/gemini-3.5-flash-lite (audio input, stable)
// - Free tier ("Free of charge", Standard tier) for 3.8-flash, 3.6-flash, 3.5-flash-lite, 3.1-flash-lite,
//   3-flash-preview:  https://aistudio.google.com/docs/pricing
// - generateContent REST (POST v1beta/models/{model}:generateContent, x-goog-api-key header, contents,
//   systemInstruction, generationConfig; responseSchema/_responseJsonSchema marked deprecated in favour of
//   responseFormat; thinkingConfig.thinkingLevel for Gemini 3; temperature ignored on 3.6+; Part.thought;
//   inlineData{mimeType,data}, fileData{fileUri,mimeType}; finishReason values):
//     https://ai.google.dev/api/generate-content
// - Structured output REST shape generationConfig.responseFormat.text{mimeType,schema}, JSON-Schema subset
//   (type, enum, minimum, maximum, required, items, minItems, maxItems, description...):
//     https://ai.google.dev/gemini-api/docs/structured-output
// - thinkingLevel "low" lowercase in REST examples: https://ai.google.dev/gemini-api/docs/generate-content/gemini-3
//   Levels per model: https://aistudio.google.com/docs/thinking
// - Audio: WAV supported, 32 tokens/s, timestamps as MM:SS, "Maximum request size is 20 MB total" for inline:
//     https://ai.google.dev/gemini-api/docs/audio
//   (file-input-methods now says 100 MB inline; we stay conservative at ~18 MB):
//     https://ai.google.dev/gemini-api/docs/generate-content/file-input-methods
// - Files API resumable upload (POST /upload/v1beta/files, X-Goog-Upload-* headers, x-goog-upload-url response
//   header, "upload, finalize"; GET/DELETE v1beta/{name}; 2 GB/file, 48 h retention):
//     https://ai.google.dev/gemini-api/docs/files
//   Browser CORS for the upload is NOT documented. Google's JS SDK does it from browsers, and third-party reports
//   (https://discuss.ai.google.dev/t/ai-studio-deployed-app-build-can-t-add-image-assets/106348) show it depends on
//   x-goog-upload-url being exposed. If the header is unreadable we throw AIError('too_large').
// - models.list (GET v1beta/models, pageSize<=1000, pageToken; Model.name/displayName/supportedGenerationMethods):
//     https://ai.google.dev/api/models
// - Errors: 403 PERMISSION_DENIED, 429 RESOURCE_EXHAUSTED retryable, 5xx retry with backoff:
//     https://aistudio.google.com/docs/troubleshooting , https://aistudio.google.com/docs/api-errors
//   429 body carries details[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"31s"}] and/or
//   "Please retry in 31.01s." in message, sometimes neither:
//     https://discuss.ai.google.dev/t/429-error-with-quota-with-tier/109918
//     https://discuss.ai.google.dev/t/429-resource-exhausted-at-0-03-of-quota-reproducible-across-projects-tiers-and-endpoints/177317

export const API_BASE = 'https://generativelanguage.googleapis.com';

/** Newest free-tier Flash model with audio input (see sources above). Overridable in settings. */
export const DEFAULT_MODEL = 'gemini-3.8-flash';

/** Tried in order when the chosen model returns "model not found". All free tier + audio input. */
export const FALLBACK_MODELS = [
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3-flash-preview',
];

/** Estimated total JSON request size above which we use the Files API instead of inline base64. */
export const INLINE_LIMIT_BYTES = 18 * 1024 * 1024;

/** Tunables (tests shrink the delays). */
export const config = {
  retryBaseMs: 2000,
  filePollMs: 1500,
  filePollMaxMs: 60000,
  maxOutputTokens: 16384,
};

export class AIError extends Error {
  /**
   * @param {'auth'|'rate_limit'|'network'|'bad_response'|'too_large'|'model'|'aborted'} code
   * @param {string} message
   * @param {{retryAfterSec?:number|null, status?:number, cause?:any}} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'AIError';
    this.code = code;
    this.retryAfterSec = extra.retryAfterSec ?? null;
    if (extra.status != null) this.status = extra.status;
    if (extra.cause !== undefined) this.cause = extra.cause;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------------------------------------------

export const CORRECTION_TYPES = ['grammar', 'particle', 'conjugation', 'vocab', 'word_choice', 'register', 'other'];
export const PRON_CATEGORIES = ['long_vowel', 'sokuon', 'n', 'r', 'tsu_su', 'vowel', 'devoicing', 'other'];
export const CARD_KINDS = ['correction', 'vocab', 'pronunciation', 'pitch'];

const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const score = (description) => ({ type: 'integer', minimum: 0, maximum: 100, description });

/** JSON Schema (Gemini supported subset). Key order = generation order: transcribe first, judge after. */
export const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    transcript: {
      type: 'array',
      description: 'Sentence-level verbatim transcript, in order.',
      items: {
        type: 'object',
        properties: {
          start: num('Seconds from audio start.'),
          end: num('Seconds from audio start.'),
          text: str('Exactly what was said, in Japanese, including mistakes and fillers.'),
        },
        required: ['start', 'end', 'text'],
      },
    },
    corrections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          sentenceIndex: { type: 'integer', minimum: 0, description: 'Index into transcript.' },
          original: str('The erroneous fragment exactly as said.'),
          corrected: str('Corrected fragment.'),
          explanation: str('Short English explanation.'),
          type: { type: 'string', enum: CORRECTION_TYPES },
        },
        required: ['sentenceIndex', 'original', 'corrected', 'explanation', 'type'],
      },
    },
    naturalRewrite: str('Whole entry as a native speaker would say it, same content.'),
    translation: str('English translation of what the user meant.'),
    pronunciation: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          time: num('Seconds from audio start.'),
          word: str('Word as written.'),
          reading: str('Kana reading.'),
          issue: str('What was heard, in English.'),
          tip: str('How to fix it, in English.'),
          category: { type: 'string', enum: PRON_CATEGORIES },
        },
        required: ['time', 'word', 'reading', 'issue', 'tip', 'category'],
      },
    },
    pitchAccent: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          time: num('Seconds from audio start.'),
          word: str('Word as written.'),
          reading: str('Kana reading.'),
          expected: str('Tokyo standard H/L per mora + type, e.g. "LHH (heiban)".'),
          heard: str('What the learner produced, e.g. "HLL (atamadaka)".'),
          tip: str('English tip.'),
        },
        required: ['time', 'word', 'reading', 'expected', 'heard', 'tip'],
      },
    },
    fluency: {
      type: 'object',
      properties: {
        fillers: {
          type: 'array',
          items: {
            type: 'object',
            properties: { time: num('Seconds from audio start.'), text: str('Filler as said, e.g. えーと.') },
            required: ['time', 'text'],
          },
        },
        fillerCount: { type: 'integer', minimum: 0 },
        comment: str('English fluency comment grounded in the measured numbers.'),
      },
      required: ['fillers', 'fillerCount', 'comment'],
    },
    scores: {
      type: 'object',
      properties: {
        grammar: score('0-100, calibrated for the stated JLPT level.'),
        pronunciation: score('0-100'),
        pitchAccent: score('0-100'),
        fluency: score('0-100'),
        vocabulary: score('0-100'),
      },
      required: ['grammar', 'pronunciation', 'pitchAccent', 'fluency', 'vocabulary'],
    },
    strengths: { type: 'array', items: { type: 'string' }, maxItems: 5 },
    summary: str('2-4 English sentences, honest and encouraging.'),
    focusNext: str('One concrete thing to practise tomorrow.'),
    cards: {
      type: 'array',
      minItems: 0,
      maxItems: 8,
      items: {
        type: 'object',
        properties: {
          front: str('Japanese cue/prompt the learner should produce or recognise.'),
          back: str('Answer + brief why.'),
          note: str('Optional context, e.g. the original mistake.'),
          kind: { type: 'string', enum: CARD_KINDS },
        },
        required: ['front', 'back', 'note', 'kind'],
      },
    },
  },
  required: [
    'transcript', 'corrections', 'naturalRewrite', 'translation', 'pronunciation', 'pitchAccent',
    'fluency', 'scores', 'strengths', 'summary', 'focusNext', 'cards',
  ],
};

// ---------------------------------------------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------------------------------------------

export function buildSystemInstruction(level = 'N3') {
  return `You are an expert, honest and kind Japanese speaking coach. Your student is an adult JLPT ${level} learner who records a spoken diary entry every day. You receive the AUDIO RECORDING itself plus locally measured acoustic metrics. LISTEN to the audio yourself: judge pronunciation, pitch accent, fillers and fluency from what you actually hear, not from a transcript.

Output: a single JSON object matching the response schema. All explanations, tips, comments and the summary in English; Japanese only for Japanese examples. At ${level}, do not add furigana except for kanji above ${level}: then put the kana reading in parentheses after the word, e.g. 憂鬱(ゆううつ).

Rules:
1. Timestamps (start, end, time) are numbers in SECONDS from the start of the audio (e.g. 83.4, not "01:23"). They must lie within the recording duration given below. Use the measured pauses/segments to anchor sentence boundaries.
2. transcript: sentence-level, in order, VERBATIM. Write exactly what was said, including grammar mistakes, wrong words, self-corrections, false starts and fillers (えーと, えっと, あの, あのー, なんか, その, まあ, うーん...). Never correct or tidy the transcript. Use normal Japanese orthography (kanji + kana) for clearly spoken words.
3. corrections: only REAL errors (grammar, particles, conjugation, vocabulary, word choice, register mismatch). Do not "correct" natural variants or casual-but-correct speech; do not list fillers as corrections. sentenceIndex refers to the transcript array. original = the fragment exactly as in the transcript; corrected = minimal fix; explanation = one or two short English sentences on why.
4. naturalRewrite: the whole entry as a native speaker would naturally say it, keeping the learner's content, meaning and register (plain vs polite); do not add new ideas. translation: natural English of what the learner meant.
5. pronunciation: only issues you actually HEAR, each with its time. Typical learner issues: long vowels shortened/lengthened (long_vowel), small っ missing or added (sokuon), ん (n), r-sounds (r), つ/す confusion (tsu_su), vowel quality (vowel), vowel devoicing e.g. です/します (devoicing). If pronunciation is good, return an empty array. Never invent issues to fill the list.
6. pitchAccent: Tokyo standard accent. Only words where you clearly heard a non-standard pattern, with time. expected/heard as H/L per mora plus the type name (heiban, atamadaka, nakadaka, odaka), e.g. expected "LHH (heiban)", heard "HLL (atamadaka)". If unsure, leave it out.
7. fluency: list each filler with its time and the text heard; fillerCount = total fillers heard. The comment must cite the measured numbers (speaking rate, speech ratio, long pauses with their times) and say what they mean for a ${level} speaker.
8. scores: integers 0-100 calibrated for an ${level} learner speaking spontaneously. 50 = typical ${level} learner, 70 = clearly above level, 85+ = near-native for this aspect, below 40 = hard to understand. Do NOT inflate. Pitch-accent and pronunciation scores reflect what you heard; fluency should agree with the measured metrics.
9. strengths: 1-4 specific things done well. summary: 2-4 English sentences, honest and encouraging. focusNext: ONE concrete, doable thing to practise tomorrow.
10. cards: 3-8 review cards from THIS entry's mistakes and useful vocabulary (prefer real errors, then recurring mistakes, then pronunciation/pitch, then useful words from the rewrite). front = a Japanese cue the learner should produce or recognise (e.g. a sentence with a blank, or an English meaning plus "→ 日本語?"); back = the answer plus a brief why; note = optional context such as the original mistake; kind = correction | vocab | pronunciation | pitch.
11. Recurring mistakes: if the learner repeats one of their recent mistakes (listed below), point it out in the explanation/summary and make a card for it.
12. Honesty: if the audio is silent, unclear, too short, mostly noise, or not Japanese, say so plainly in summary, return empty arrays for transcript/corrections/pronunciation/pitchAccent/fillers (and at most a few generic cards or none), low or zero scores as appropriate, and do not invent content.`;
}

const f1 = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : '?');
const f2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : '?');
const range = (p) => `${f1(p.start)}-${f1(p.end)}s (${f1(p.end - p.start)}s)`;

/** Compact human-readable summary of AudioMetrics for the prompt (per-frame arrays are NOT sent). */
export function summariseMetrics(m) {
  if (!m || typeof m !== 'object') return 'Local metrics: not available.';
  const lines = [];
  lines.push(`Duration: ${f1(m.durationSec)} s; speech: ${f1(m.speechSec)} s; speech ratio: ${f2(m.speechRatio)}.`);
  lines.push(`Estimated syllable (mora-proxy) rate: ${f1(m.syllableRate)}/s overall; articulation rate: ${f1(m.articulationRate)}/s while speaking (typical relaxed native conversational speech is roughly 6-8 morae/s).`);
  const pauses = Array.isArray(m.pauses) ? m.pauses : [];
  const longP = Array.isArray(m.longPauses) ? m.longPauses : [];
  lines.push(`Pauses >=0.25 s: ${pauses.length} (mean ${f2(m.meanPauseSec)} s).`);
  if (pauses.length) {
    const shown = pauses.slice(0, 60).map(range).join(', ');
    lines.push(`Pause times: ${shown}${pauses.length > 60 ? `, ... (+${pauses.length - 60} more)` : ''}.`);
  }
  lines.push(`Long pauses >=1.2 s (hesitation): ${longP.length}${longP.length ? ' at ' + longP.slice(0, 60).map(range).join(', ') : ''}.`);
  const segs = Array.isArray(m.segments) ? m.segments : [];
  if (segs.length) {
    lines.push(`Speech segments: ${segs.length}${segs.length <= 30 ? ' — ' + segs.map((s) => `${f1(s.start)}-${f1(s.end)}`).join(', ') : ''}.`);
  }
  const p = m.pitch || {};
  lines.push(`Pitch: median ${f1(p.medianHz)} Hz, range ${f1(p.rangeSemitones)} semitones (5th-95th pct), std ${f2(p.stdSemitones)} semitones (low std = monotone).`);
  const v = m.volume || {};
  lines.push(`Volume: mean ${f1(v.meanDb)} dBFS over speech, trend ${f2(v.trendDbPerMin)} dB/min (negative = fading).`);
  lines.push(`Local hesitation score: ${f1(m.hesitationScore)}/100 (higher = more hesitant); local confidence score: ${f1(m.confidenceScore)}/100.`);
  lines.push('These are heuristic estimates from a phone microphone; trust your ears where they disagree, but use the times to anchor your timestamps.');
  return lines.join('\n');
}

export function buildUserPrompt({ metrics, prompt, level = 'N3', recentMistakes = [], durationSec } = {}) {
  const dur = Number.isFinite(durationSec) ? durationSec : metrics?.durationSec;
  const topic = prompt && (prompt.ja || prompt.en)
    ? `Today's diary prompt: ${prompt.ja || ''}${prompt.en ? ` (${prompt.en})` : ''}. The learner may drift from it; that is fine.`
    : 'No specific prompt today (free talk).';
  const mistakes = (Array.isArray(recentMistakes) ? recentMistakes : [])
    .filter((s) => typeof s === 'string' && s.trim())
    .slice(0, 20)
    .map((s) => `- ${s.trim().slice(0, 200)}`);
  return [
    `Learner level: JLPT ${level}.`,
    topic,
    `Recording duration: ${f1(dur)} seconds. All timestamps must be between 0 and ${f1(dur)}.`,
    '',
    'LOCAL METRICS (measured on-device):',
    summariseMetrics(metrics),
    '',
    mistakes.length
      ? `Recent mistakes from previous entries (watch for repeats):\n${mistakes.join('\n')}`
      : 'Recent mistakes from previous entries: none recorded.',
    '',
    'Listen to the attached recording and return the analysis JSON.',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------------------------------------------

/** thinkingConfig suited to the model: low for Gemini 3.x (3.8 Flash rejects "minimal"), small budget for 2.5. */
export function thinkingConfigFor(model = '') {
  const id = String(model).replace(/^models\//, '');
  if (/^gemini-(3|[4-9])/.test(id)) return { thinkingLevel: 'low' };
  if (/^gemini-2\.5/.test(id)) return { thinkingBudget: 1024 };
  return null;
}

/**
 * Pure. Builds the generateContent JSON body.
 * @param {object} o
 * @param {{mimeType:string, data?:string, fileUri?:string}} o.audio  base64 data OR Files API uri
 * @param {'responseFormat'|'legacy'} [o.schemaStyle] current docs use responseFormat; legacy = responseMimeType+responseJsonSchema
 * @param {boolean} [o.thinking] include thinkingConfig (default true)
 */
export function buildRequestBody({
  audio, metrics, prompt, level = 'N3', recentMistakes = [], durationSec, model = DEFAULT_MODEL,
  schemaStyle = 'responseFormat', thinking = true,
} = {}) {
  const parts = [];
  if (audio?.fileUri) parts.push({ fileData: { mimeType: audio.mimeType || 'audio/wav', fileUri: audio.fileUri } });
  else if (audio?.data) parts.push({ inlineData: { mimeType: audio.mimeType || 'audio/wav', data: audio.data } });
  parts.push({ text: buildUserPrompt({ metrics, prompt, level, recentMistakes, durationSec }) });
  return {
    systemInstruction: { parts: [{ text: buildSystemInstruction(level) }] },
    contents: [{ role: 'user', parts }],
    generationConfig: generationConfig({ model, schemaStyle, thinking }),
  };
}

function generationConfig({ model, schemaStyle, thinking }) {
  const gc = { maxOutputTokens: config.maxOutputTokens };
  if (schemaStyle === 'legacy') {
    gc.responseMimeType = 'application/json';
    gc.responseJsonSchema = ANALYSIS_SCHEMA;
  } else {
    gc.responseFormat = { text: { mimeType: 'application/json', schema: ANALYSIS_SCHEMA } };
  }
  const tc = thinking ? thinkingConfigFor(model) : null;
  if (tc) gc.thinkingConfig = tc;
  return gc;
}

function buildRepairBody({ brokenText, parseError, model, schemaStyle, thinking }) {
  return {
    systemInstruction: { parts: [{ text: 'You repair malformed JSON. Output only the corrected JSON object.' }] },
    contents: [{
      role: 'user',
      parts: [{
        text: `The text below was meant to be ONE JSON object matching the response schema (a Japanese speaking-practice analysis) but it could not be parsed (${parseError}). Return the corrected JSON object, preserving all content. If it was cut off, drop the incomplete last item and close all brackets.\n\n${String(brokenText).slice(0, 200000)}`,
      }],
    }],
    generationConfig: generationConfig({ model, schemaStyle, thinking }),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------------------------------------------

/** Number from number | "12.5" | "01:23" | "1:02:03.5" | "12.5s"; else NaN. */
export function toNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return NaN;
  const s = v.trim().replace(/s(ec(onds?)?)?$/i, '').trim();
  if (/^\d+(:\d+){1,2}(\.\d+)?$/.test(s)) {
    return s.split(':').reduce((acc, p) => acc * 60 + parseFloat(p), 0);
  }
  return s === '' ? NaN : Number(s);
}

const text = (v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const arr = (v) => (Array.isArray(v) ? v : []);
const enumOr = (v, allowed, dflt) => {
  const s = text(v).toLowerCase().replace(/[\s-]+/g, '_');
  return allowed.includes(s) ? s : dflt;
};

/**
 * Pure. Coerces model output into a valid Analysis. Never throws for objects; fills defaults.
 * @param {any} raw parsed JSON (or a JSON string)
 * @param {{model?:string, durationSec?:number}} opts
 */
export function normaliseAnalysis(raw, { model = '', durationSec } = {}) {
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = {}; }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
  const dur = Number.isFinite(toNumber(durationSec)) && toNumber(durationSec) > 0 ? toNumber(durationSec) : null;

  const time = (v) => {
    let n = toNumber(v);
    if (!Number.isFinite(n) || n < 0) n = 0;
    if (dur != null && n > dur) n = dur;
    return Math.round(n * 100) / 100;
  };
  const byTime = (a, b) => a.time - b.time;

  const transcript = arr(raw.transcript)
    .filter((t) => t && typeof t === 'object' && text(t.text))
    .map((t) => {
      let start = time(t.start);
      let end = time(t.end);
      if (end < start) [start, end] = [end, start];
      return { start, end, text: text(t.text) };
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const corrections = arr(raw.corrections)
    .filter((c) => c && typeof c === 'object' && text(c.original) && text(c.corrected) && text(c.original) !== text(c.corrected))
    .map((c) => {
      let idx = Math.round(toNumber(c.sentenceIndex));
      const original = text(c.original);
      if (!(idx >= 0 && idx < transcript.length) || (transcript[idx] && !transcript[idx].text.includes(original))) {
        const found = transcript.findIndex((t) => t.text.includes(original));
        if (found >= 0) idx = found;
      }
      if (!Number.isFinite(idx) || idx < 0) idx = 0;
      if (idx > transcript.length - 1) idx = Math.max(0, transcript.length - 1);
      return {
        sentenceIndex: idx,
        original,
        corrected: text(c.corrected),
        explanation: text(c.explanation),
        type: enumOr(c.type, CORRECTION_TYPES, 'other'),
      };
    })
    .sort((a, b) => a.sentenceIndex - b.sentenceIndex);

  const pronunciation = arr(raw.pronunciation)
    .filter((p) => p && typeof p === 'object' && text(p.word) && (text(p.issue) || text(p.tip)))
    .map((p) => ({
      time: time(p.time),
      word: text(p.word),
      reading: text(p.reading),
      issue: text(p.issue),
      tip: text(p.tip),
      category: enumOr(p.category, PRON_CATEGORIES, 'other'),
    }))
    .sort(byTime);

  const pitchAccent = arr(raw.pitchAccent)
    .filter((p) => p && typeof p === 'object' && text(p.word) && (text(p.expected) || text(p.heard) || text(p.tip)))
    .map((p) => ({
      time: time(p.time),
      word: text(p.word),
      reading: text(p.reading),
      expected: text(p.expected),
      heard: text(p.heard),
      tip: text(p.tip),
    }))
    .sort(byTime);

  const fl = raw.fluency && typeof raw.fluency === 'object' ? raw.fluency : {};
  const fillers = arr(fl.fillers)
    .map((f) => (typeof f === 'string' ? { text: f, time: 0 } : f))
    .filter((f) => f && typeof f === 'object' && text(f.text))
    .map((f) => ({ time: time(f.time), text: text(f.text) }))
    .sort(byTime);
  const fcRaw = Math.round(toNumber(fl.fillerCount));
  const fluency = {
    fillers,
    fillerCount: Math.max(fillers.length, Number.isFinite(fcRaw) && fcRaw >= 0 ? fcRaw : 0),
    comment: text(fl.comment),
  };

  const sc = raw.scores && typeof raw.scores === 'object' ? raw.scores : {};
  const clampScore = (v) => {
    const n = toNumber(v);
    return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 0;
  };
  const scores = {
    grammar: clampScore(sc.grammar),
    pronunciation: clampScore(sc.pronunciation),
    pitchAccent: clampScore(sc.pitchAccent),
    fluency: clampScore(sc.fluency),
    vocabulary: clampScore(sc.vocabulary),
  };

  const strengths = (typeof raw.strengths === 'string' ? [raw.strengths] : arr(raw.strengths))
    .map(text).filter(Boolean).slice(0, 6);

  const seen = new Set();
  const cards = arr(raw.cards)
    .filter((c) => c && typeof c === 'object' && text(c.front) && text(c.back))
    .map((c) => ({
      front: text(c.front),
      back: text(c.back),
      note: text(c.note),
      kind: enumOr(c.kind, CARD_KINDS, 'correction'),
    }))
    .filter((c) => {
      const k = c.front.replace(/\s+/g, '').toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 8);

  return {
    version: 1,
    model: text(model) || text(raw.model),
    transcript,
    corrections,
    naturalRewrite: text(raw.naturalRewrite),
    translation: text(raw.translation),
    pronunciation,
    pitchAccent,
    fluency,
    scores,
    summary: text(raw.summary),
    strengths,
    focusNext: text(raw.focusNext),
    cards,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------------------------------------------

function durationToSec(s) {
  if (typeof s === 'number') return s;
  if (typeof s === 'object' && s) return (toNumber(s.seconds) || 0) + (toNumber(s.nanos) || 0) / 1e9;
  const m = /^\s*([\d.]+)\s*s?\s*$/.exec(String(s ?? ''));
  return m ? parseFloat(m[1]) : NaN;
}

/**
 * Pure. Seconds to wait from a Gemini error body: RetryInfo.retryDelay ("31s"), else "retry in 31.0s" in message.
 * Accepts the whole body ({error:{...}}) or the inner error. Returns integer seconds (ceil) or null.
 */
export function parseRetryAfter(errJson) {
  const e = errJson?.error ?? errJson;
  if (!e || typeof e !== 'object') return null;
  for (const d of arr(e.details)) {
    if (d && /RetryInfo/.test(String(d['@type'] || '')) && d.retryDelay != null) {
      const n = durationToSec(d.retryDelay);
      if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
    }
  }
  const m = /retry in\s+([\d.]+)\s*(ms|s)/i.exec(String(e.message || ''));
  if (m) {
    const n = parseFloat(m[1]) / (m[2].toLowerCase() === 'ms' ? 1000 : 1);
    if (Number.isFinite(n)) return Math.ceil(n);
  }
  return null;
}

function errorReasons(e) {
  return arr(e?.details).map((d) => String(d?.reason || '')).filter(Boolean);
}

/** Pure-ish. Maps an HTTP failure to AIError. */
export function mapHttpError(status, body, headers) {
  const e = body?.error ?? body ?? {};
  const msg = String(e.message || (typeof body === 'string' ? body : '') || `HTTP ${status}`);
  const reasons = errorReasons(e);
  const statusName = String(e.status || e.code || '');
  const extra = { status, cause: body };
  if (status === 401 || status === 403 || reasons.includes('API_KEY_INVALID') || /API key (not valid|expired|invalid)/i.test(msg)) {
    return new AIError('auth', `Gemini rejected the API key: ${msg}`, extra);
  }
  if (status === 429 || statusName === 'RESOURCE_EXHAUSTED') {
    let retryAfterSec = parseRetryAfter(body);
    if (retryAfterSec == null && headers?.get) {
      const h = Number(headers.get('retry-after'));
      if (Number.isFinite(h) && h >= 0) retryAfterSec = Math.ceil(h);
    }
    return new AIError('rate_limit', `Gemini rate limit / quota reached: ${msg}`, { ...extra, retryAfterSec });
  }
  if (status === 413 || /payload size|request (entity )?too large|exceeds the maximum/i.test(msg)) {
    return new AIError('too_large', `Recording too large for Gemini: ${msg}`, extra);
  }
  if (status === 404 || /model.*(not found|is not supported|not available)|models\/[\w.-]+ is not found/i.test(msg)) {
    return new AIError('model', `Model unavailable: ${msg}`, extra);
  }
  if (status >= 500 || status === 408) {
    return new AIError('network', `Gemini server error (${status}), try again later: ${msg}`, extra);
  }
  return new AIError('bad_response', `Gemini request failed (${status}): ${msg}`, extra);
}

function isAbort(err, signal) {
  return signal?.aborted || err?.name === 'AbortError';
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AIError('aborted', 'Aborted'));
    const t = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new AIError('aborted', 'Aborted')); };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/** fetch wrapper: maps network/abort errors; returns Response (not checked). */
async function rawFetch(url, init, signal) {
  if (signal?.aborted) throw new AIError('aborted', 'Aborted');
  try {
    return await fetch(url, { ...init, signal });
  } catch (err) {
    if (isAbort(err, signal)) throw new AIError('aborted', 'Aborted', { cause: err });
    throw new AIError('network', `Network error contacting Gemini: ${err?.message || err}`, { cause: err });
  }
}

async function readBody(res) {
  const t = await res.text().catch(() => '');
  try { return t ? JSON.parse(t) : {}; } catch { return t; }
}

/** fetch + JSON + error mapping, with ONE automatic retry on 500/503 (and 504). */
async function requestJson(url, init, signal) {
  for (let attempt = 0; ; attempt++) {
    const res = await rawFetch(url, init, signal);
    if (res.ok) {
      const body = await readBody(res);
      if (typeof body === 'string') throw new AIError('bad_response', 'Gemini returned non-JSON', { status: res.status });
      return { body, res };
    }
    const body = await readBody(res);
    if (attempt === 0 && [500, 503, 504].includes(res.status)) {
      await sleep(config.retryBaseMs * (1 + Math.random() * 0.5), signal);
      continue;
    }
    throw mapHttpError(res.status, body, res.headers);
  }
}

const keyHeaders = (apiKey) => ({ 'x-goog-api-key': String(apiKey || '').trim() });
const modelPath = (model) => `${API_BASE}/v1beta/models/${encodeURIComponent(String(model).replace(/^models\//, ''))}`;

// ---------------------------------------------------------------------------------------------------------------
// Models / key
// ---------------------------------------------------------------------------------------------------------------

const EXCLUDE_RE = /(image|tts|embed|live|native-audio|audio-dialog|robotics|computer-use|aqa|imagen|veo|omni|translate|learnlm|gemma|nano-banana)/i;

function modelRank(id) {
  const fam = /flash-lite/.test(id) ? 1 : /flash/.test(id) ? 0 : /pro/.test(id) ? 2 : 3;
  const ver = parseFloat((/gemini-(\d+(?:\.\d+)?)/.exec(id) || [])[1] || '0');
  const unstable = /preview|exp|latest/.test(id) ? 1 : 0;
  return { fam, ver, unstable };
}

/** -> [{id, displayName}] generateContent-capable Gemini text models; Flash, then Flash-Lite, then Pro, then others. */
export async function listModels(apiKey, { signal } = {}) {
  if (!apiKey) throw new AIError('auth', 'No Gemini API key set');
  const out = [];
  let pageToken = '';
  for (let page = 0; page < 10; page++) {
    const url = `${API_BASE}/v1beta/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const { body } = await requestJson(url, { method: 'GET', headers: keyHeaders(apiKey) }, signal);
    out.push(...arr(body.models));
    pageToken = body.nextPageToken || '';
    if (!pageToken) break;
  }
  const seen = new Set();
  return out
    .filter((m) => m && typeof m.name === 'string')
    .map((m) => ({ ...m, id: m.name.replace(/^models\//, '') }))
    .filter((m) => /^gemini-/.test(m.id) && !EXCLUDE_RE.test(m.id))
    .filter((m) => arr(m.supportedGenerationMethods).includes('generateContent'))
    .filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
    .sort((a, b) => {
      const ra = modelRank(a.id), rb = modelRank(b.id);
      return ra.fam - rb.fam || rb.ver - ra.ver || ra.unstable - rb.unstable || a.id.localeCompare(b.id);
    })
    .map((m) => ({ id: m.id, displayName: m.displayName || m.id }));
}

/** Cheap validity check (models.list, 1 item). */
export async function testKey(apiKey, { signal } = {}) {
  if (!apiKey || !String(apiKey).trim()) throw new AIError('auth', 'No Gemini API key set');
  await requestJson(`${API_BASE}/v1beta/models?pageSize=1`, { method: 'GET', headers: keyHeaders(apiKey) }, signal);
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------------------
// Audio transport
// ---------------------------------------------------------------------------------------------------------------

/** ArrayBuffer/Uint8Array -> base64, chunked to avoid call-stack limits. */
export function bytesToBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Estimated JSON body size for an inline request. */
export function estimateInlineBytes(blobSize, extraTextBytes = 12000) {
  return Math.ceil(blobSize / 3) * 4 + extraTextBytes;
}

/** Files API resumable upload. -> {name, uri, mimeType} */
export async function uploadFile(apiKey, blob, mimeType, { signal, displayName = 'hanashi-nikki-entry' } = {}) {
  const start = await rawFetch(`${API_BASE}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      ...keyHeaders(apiKey),
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(blob.size),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
  }, signal);
  if (!start.ok) throw mapHttpError(start.status, await readBody(start), start.headers);
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) {
    throw new AIError('too_large', 'Recording is too long to send inline and the browser could not start a Gemini file upload (upload URL header not readable). Try a shorter entry.', { status: start.status });
  }
  // Content-Length is set by fetch itself (forbidden header in browsers).
  const up = await rawFetch(uploadUrl, {
    method: 'POST',
    headers: { 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
    body: blob,
  }, signal);
  if (!up.ok) throw mapHttpError(up.status, await readBody(up), up.headers);
  const info = await readBody(up);
  let file = info?.file;
  if (!file?.uri || !file?.name) throw new AIError('bad_response', 'File upload returned no file uri');

  // Wait until the file is ACTIVE (audio usually is immediately).
  const t0 = Date.now();
  while (file.state === 'PROCESSING' && Date.now() - t0 < config.filePollMaxMs) {
    await sleep(config.filePollMs, signal);
    const { body } = await requestJson(`${API_BASE}/v1beta/${file.name}`, { method: 'GET', headers: keyHeaders(apiKey) }, signal);
    file = { ...file, ...body };
  }
  if (file.state === 'FAILED') throw new AIError('bad_response', 'Gemini could not process the uploaded audio');
  return { name: file.name, uri: file.uri, mimeType: file.mimeType || mimeType };
}

/** Best-effort delete; never throws. */
export async function deleteFile(apiKey, name) {
  try {
    await fetch(`${API_BASE}/v1beta/${name}`, { method: 'DELETE', headers: keyHeaders(apiKey) });
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------------------------------------------

/** Joins non-thought text parts of the first candidate. Throws AIError('bad_response') if blocked/empty. */
export function extractText(resp) {
  const block = resp?.promptFeedback?.blockReason;
  const cand = arr(resp?.candidates)[0];
  const textOut = arr(cand?.content?.parts).filter((p) => !p?.thought && typeof p?.text === 'string').map((p) => p.text).join('');
  if (!textOut) {
    const why = block || cand?.finishReason || 'empty';
    throw new AIError('bad_response', `Gemini returned no analysis (${why})`);
  }
  return { text: textOut, finishReason: cand?.finishReason || '' };
}

/** Lenient JSON parse: strips ``` fences, falls back to the outermost {...}. Throws SyntaxError. */
export function parseJsonLoose(s) {
  let t = String(s).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(t); } catch (err) {
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw err;
  }
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------------------------------------------------------
// analyzeEntry
// ---------------------------------------------------------------------------------------------------------------

/**
 * POST generateContent with graceful degradation: if a 400 complains about responseFormat / thinking fields,
 * retry once with the legacy structured-output fields and/or without thinkingConfig.
 */
async function generate(apiKey, model, makeBody, signal, state) {
  for (let i = 0; i < 3; i++) {
    const body = makeBody(state);
    try {
      const { body: resp } = await requestJson(`${modelPath(model)}:generateContent`, {
        method: 'POST',
        headers: { ...keyHeaders(apiKey), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, signal);
      return resp;
    } catch (err) {
      if (!(err instanceof AIError) || err.status !== 400) throw err;
      const m = String(err.message);
      if (state.schemaStyle === 'responseFormat' && /response_?format|unknown name|invalid json payload/i.test(m)) {
        state.schemaStyle = 'legacy';
        continue;
      }
      if (state.thinking && /thinking/i.test(m)) {
        state.thinking = false;
        continue;
      }
      throw err;
    }
  }
  throw new AIError('bad_response', 'Gemini rejected the request format');
}

/**
 * @returns {Promise<Analysis>}
 */
export async function analyzeEntry({
  apiKey, model, wavBlob, metrics, prompt, level = 'N3', recentMistakes = [], signal,
} = {}) {
  if (!apiKey || !String(apiKey).trim()) throw new AIError('auth', 'No Gemini API key set');
  if (!wavBlob || typeof wavBlob.size !== 'number' || !wavBlob.size) throw new AIError('bad_response', 'No audio to analyse');
  if (signal?.aborted) throw new AIError('aborted', 'Aborted');

  const mimeType = wavBlob.type || 'audio/wav';
  const durationSec = Number.isFinite(metrics?.durationSec) ? metrics.durationSec : (mimeType.includes('wav') ? (wavBlob.size - 44) / 32000 : undefined);
  const base = { metrics, prompt, level, recentMistakes, durationSec };

  let uploaded = null;
  let audio;
  try {
    if (estimateInlineBytes(wavBlob.size) < INLINE_LIMIT_BYTES) {
      audio = { mimeType, data: bytesToBase64(await wavBlob.arrayBuffer()) };
    } else {
      uploaded = await uploadFile(apiKey, wavBlob, mimeType, { signal });
      audio = { mimeType: uploaded.mimeType, fileUri: uploaded.uri };
    }

    const models = [model || DEFAULT_MODEL, ...FALLBACK_MODELS].filter((m, i, a) => m && a.indexOf(m) === i);
    let lastErr;
    for (const m of models.slice(0, 4)) {
      const state = { schemaStyle: 'responseFormat', thinking: true };
      let resp;
      try {
        resp = await generate(apiKey, m, (s) => buildRequestBody({ ...base, audio, model: m, ...s }), signal, state);
      } catch (err) {
        if (err instanceof AIError && err.code === 'model') { lastErr = err; continue; }
        throw err;
      }
      const { text: out } = extractText(resp);
      let parsed;
      try {
        parsed = parseJsonLoose(out);
        if (!isObj(parsed)) throw new SyntaxError('not an object');
      } catch (parseErr) {
        // One repair round-trip (text only, no audio).
        const repairResp = await generate(apiKey, m, (s) => buildRepairBody({ brokenText: out, parseError: parseErr.message, model: m, ...s }), signal, state);
        try {
          parsed = parseJsonLoose(extractText(repairResp).text);
          if (!isObj(parsed)) throw new SyntaxError('not an object');
        } catch {
          throw new AIError('bad_response', 'Gemini returned malformed JSON twice');
        }
      }
      return normaliseAnalysis(parsed, { model: m, durationSec });
    }
    throw lastErr || new AIError('model', 'No usable Gemini model');
  } catch (err) {
    if (err instanceof AIError) throw err;
    if (isAbort(err, signal)) throw new AIError('aborted', 'Aborted', { cause: err });
    throw new AIError('bad_response', String(err?.message || err), { cause: err });
  } finally {
    if (uploaded) deleteFile(apiKey, uploaded.name);
  }
}
