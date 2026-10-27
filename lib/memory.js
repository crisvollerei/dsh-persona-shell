/**
 * Long-term memory, split into two layers that must not be mixed.
 *
 * **Shared** — who the reader is. Language, address form, how terse they are.
 * These describe the *person*, so they hold across every persona: switching from
 * one character to another does not change which language someone writes in.
 *
 * **Per-preset** — style corrections. "太啰嗦了" is a judgement about the voice
 * currently speaking, and applying it to a different character would be wrong:
 * one persona may be meant to be verbose and another clipped. These live beside
 * the preset id.
 *
 * The distinction is not cosmetic. A single shared bag produced two real bugs:
 * corrections from one persona steering another, and — worse — persona prompt
 * text being stored as if the user had asked for it.
 */

/** Language detection by character-class share; no dictionary needed. */
const HAN = /[\u4e00-\u9fff]/g;
const LATIN_LETTER = /[A-Za-z]/g;

/** How many messages before an observed ratio is trusted. */
const MIN_SAMPLES = 20;

/** Upper bound on remembered corrections per preset. */
const MAX_STATED = 6;

/** Empty profile: shared counters plus an empty per-preset correction map. */
export function emptyProfile() {
  return {
    version: 2,
    messages: 0,
    hanChars: 0,
    latinChars: 0,
    totalChars: 0,
    sentences: 0,
    chars: 0,
    address: { 你: 0, 您: 0 },
    /** presetId → string[] of corrections the user made about that voice. */
    stated: {},
    updatedAt: 0,
  };
}

/**
 * Fold one user message into the shared counters.
 *
 * Pure and total: a malformed profile is reset rather than thrown on, because a
 * corrupt memory must never break a rewrite.
 * @param {unknown} current
 * @param {string} text
 * @returns {ReturnType<typeof emptyProfile>}
 */
export function observeMessage(current, text) {
  const profile = isProfile(current) ? current : emptyProfile();
  if (typeof text !== 'string' || text.trim() === '') return profile;

  const next = {
    ...profile,
    address: { ...profile.address },
    stated: { ...profile.stated },
  };

  // Measure the *prose*, not the payload. A developer writing in Chinese still
  // types paths, identifiers and commands, and those are almost all Latin
  // characters; counting them mislabelled a native Chinese writer as English.
  const prose = stripTechnicalSpans(text);
  next.messages += 1;
  next.totalChars += prose.length;
  next.hanChars += (prose.match(HAN) ?? []).length;
  next.latinChars += (prose.match(LATIN_LETTER) ?? []).length;

  const fragments = prose.split(/[。！？!?\n]+/).map((piece) => piece.trim()).filter((piece) => piece !== '');
  for (const fragment of fragments) {
    next.sentences += 1;
    next.chars += fragment.length;
  }

  for (const form of ['你', '您']) {
    const hits = (prose.match(new RegExp(form, 'g')) ?? []).length;
    next.address[form] = (next.address[form] ?? 0) + hits;
  }

  next.updatedAt = Date.now();
  return next;
}

/**
 * Record one style correction against a specific preset.
 *
 * The detection here is deliberately narrow, because the previous version's
 * keyword heuristic was actively harmful: it matched `称呼`, `语气`, `正经` and
 * `严肃`, all of which appear constantly inside persona prompts. Pasting a
 * 1800-character persona stored a dozen lines of that persona as if the user had
 * requested them, and they were then fed back into *other* personas' prompts.
 *
 * A message is only treated as a correction when it is **short** and **about the
 * output**, not a pasted document. Two guards:
 *
 * 1. Length. A correction is a sentence; a persona prompt is paragraphs. Anything
 *    over `MAX_FEEDBACK_CHARS` is treated as content, not commentary.
 * 2. It must be phrased as an instruction about the writing (`太…了`, `别…`,
 *    `不要…`, `改成…`) rather than merely containing a topical word.
 *
 * @param {unknown} current
 * @param {string} text
 * @param {string} presetId - the voice this correction applies to
 * @returns {ReturnType<typeof emptyProfile>}
 */
export function observeFeedback(current, text, presetId) {
  const profile = isProfile(current) ? current : emptyProfile();
  if (typeof text !== 'string') return profile;
  if (presetId === undefined || presetId === '') return profile;

  // A long message is never a style correction; it is the task, or a pasted
  // document. This single guard removes the entire class of contamination.
  if (text.length > MAX_FEEDBACK_CHARS) return profile;

  const sentences = text
    .split(/[。！？!?\n]+/)
    .map((piece) => piece.trim())
    .filter((piece) => piece !== '')
    .filter((piece) => isCorrection(piece));

  if (sentences.length === 0) return profile;

  const next = { ...profile, stated: { ...profile.stated } };
  const list = Array.isArray(next.stated[presetId]) ? [...next.stated[presetId]] : [];
  for (const sentence of sentences) {
    if (list.includes(sentence)) continue;
    list.push(sentence);
  }
  while (list.length > MAX_STATED) list.shift();
  next.stated[presetId] = list;
  next.updatedAt = Date.now();
  return next;
}

/**
 * Whether one sentence reads as a correction of the output's style.
 *
 * Requires an instruction shape, not just a topical word. `语气要严肃` is a
 * correction; `八、语气示例` is a heading in a pasted persona and is not.
 * @param {string} sentence
 */
function isCorrection(sentence) {
  if (sentence.length > 60) return false;
  return CORRECTION_SHAPES.some((shape) => shape.test(sentence));
}

/**
 * Instruction shapes: a comparative complaint, a prohibition, or an explicit
 * change request. Anchored on how a correction is phrased rather than on nouns
 * that also appear in persona documents.
 */
const CORRECTION_SHAPES = [
  /太(啰嗦|冗长|长|短|萌|冷|硬|正式|随意)/,
  /(别|不要|不用)(这么|那么|太|再)?(啰嗦|长|短|卖萌|萌|冷|硬|正式|随意|用|说)/,
  /(改成|换个|换一种|调整成|变得|更)(简洁|简短|正式|随意|自然|口语|严肃|轻松)/,
  /(语气|口吻|称呼)(要|应该|改|换|别|不要)/,
  /(简短|简洁|精简)一点/,
];

/** A correction is a sentence, not a document. */
const MAX_FEEDBACK_CHARS = 200;

/**
 * Remove the parts of a message that are not the writer's prose.
 *
 * Code, paths, commands, URLs and long identifiers say nothing about which
 * language someone thinks in; they are quoted material. What remains is the
 * sentence they actually composed.
 *
 * The lone-identifier rule is applied **only when the message already contains
 * Han characters**. In an all-Latin message the long words *are* the prose, and
 * stripping them would leave nothing to measure.
 * @param {string} text
 * @returns {string}
 */
export function stripTechnicalSpans(text) {
  let out = text
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[A-Za-z]:\\[^\s]*/g, ' ')
    .replace(/(?:^|\s)\/(?:[\w.-]+\/)+[\w.-]*/g, ' ');

  if (/[\u4e00-\u9fff]/.test(out)) {
    out = out.replace(/\b[A-Za-z][A-Za-z0-9_.-]{3,}\b/g, ' ');
  }
  return out;
}

/**
 * Whether a value looks like a profile this module produced.
 *
 * Version 1 stored corrections in a flat array; that shape is rejected so a
 * stale profile is rebuilt instead of half-read.
 * @param {unknown} value
 */
function isProfile(value) {
  if (value === null || typeof value !== 'object') return false;
  const candidate = /** @type {Record<string, unknown>} */ (value);
  return candidate.version === 2
    && typeof candidate.messages === 'number'
    && candidate.stated !== null
    && typeof candidate.stated === 'object'
    && !Array.isArray(candidate.stated);
}

/**
 * Turn raw counters into the few, high-confidence facts worth putting in a
 * prompt, for one preset.
 *
 * Thresholds are intentionally conservative: a prompt line that is wrong is
 * worse than a prompt line that is missing, because the model will follow it and
 * the user cannot trace the resulting tone back to a miscalculated ratio.
 * @param {unknown} raw
 * @param {string | undefined} presetId - whose corrections to include
 * @returns {{ language: string | undefined, address: string | undefined, terse: boolean | undefined, stated: string[] }}
 */
export function summarizeProfile(raw, presetId) {
  const profile = isProfile(raw) ? raw : emptyProfile();
  const result = { language: undefined, address: undefined, terse: undefined, stated: [] };

  if (profile.messages >= MIN_SAMPLES && profile.totalChars > 0) {
    const hanShare = profile.hanChars / profile.totalChars;
    const latinShare = profile.latinChars / profile.totalChars;
    if (hanShare >= 0.3) result.language = '中文';
    else if (latinShare >= 0.5) result.language = '英文';

    const meanSentence = profile.sentences > 0 ? profile.chars / profile.sentences : 0;
    if (meanSentence > 0) result.terse = meanSentence <= 28;
  }

  const you = profile.address?.['你'] ?? 0;
  const nin = profile.address?.['您'] ?? 0;
  if (you + nin >= MIN_SAMPLES) {
    if (nin > you * 2) result.address = '您';
    else if (you > nin * 2) result.address = '你';
  }

  // Corrections belong to one voice only.
  const own = presetId !== undefined ? profile.stated?.[presetId] : undefined;
  result.stated = Array.isArray(own) ? own.slice(-MAX_STATED) : [];
  return result;
}

/**
 * Render the summary as prompt lines.
 *
 * Shared facts first, then the corrections that apply to this preset. Returns an
 * empty array when nothing is known, so a fresh install adds no tokens and no
 * invented claims.
 * @param {unknown} raw
 * @param {string | undefined} presetId
 * @returns {string[]}
 */
export function memoryLines(raw, presetId) {
  const summary = summarizeProfile(raw, presetId);
  const lines = [];
  if (summary.language !== undefined) lines.push(`用户主要用${summary.language}提问，参考它的语感。`);
  if (summary.address !== undefined) lines.push(`用户习惯被称呼为「${summary.address}」。`);
  if (summary.terse === true) lines.push('用户平时说话简短，汇报也可以更紧凑一些。');
  if (summary.terse === false) lines.push('用户习惯长句，可以稍微展开，但不要注水。');
  for (const stated of summary.stated) lines.push(`用户曾对这个语气提出：${stated}`);
  return lines;
}
