/**
 * Long-term memory of how the user writes and what they have asked for.
 *
 * Two kinds of memory, deliberately kept apart because they are learned very
 * differently:
 *
 * 1. **Observed** — measured from the user's own messages: script (Chinese vs
 *    Latin), reading language, how terse they are, how they address the
 *    assistant. These are counts, not judgements: no model call is involved and
 *    a wrong inference shows up as a wrong number the user can inspect.
 *
 * 2. **Stated** — extracted from explicit corrections ("别这么啰嗦"). The user
 *    said it, so it is duplicated verbatim and weighted above any inference.
 *
 * Nothing here is guessed from assistant output or from tool traffic. The memory
 * describes the reader, and the only trustworthy evidence of a reader is what
 * they type.
 */

/** Language detection by character-class share; no dictionary needed. */
const HAN = /[\u4e00-\u9fff]/g;
const LATIN_LETTER = /[A-Za-z]/g;

/** Empty profile: every counter starts at zero. */
export function emptyProfile() {
  return {
    version: 1,
    messages: 0,
    hanChars: 0,
    latinChars: 0,
    totalChars: 0,
    /** Running mean sentence length, in characters. */
    sentences: 0,
    chars: 0,
    /** How the user addresses the assistant. */
    address: { 你: 0, 您: 0 },
    /** Explicit corrections, newest last, each with the sentence that asked. */
    stated: [],
    updatedAt: 0,
  };
}

/**
 * Fold one user message into the profile.
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
    stated: [...profile.stated],
  };

  // Measure the *prose*, not the payload.
  //
  // A developer writing in Chinese still types paths, identifiers, commands and
  // URLs, and those are almost all Latin characters. Counting them mislabelled a
  // native Chinese writer as an English one at a 0.15 han-share — the plugin
  // would then have rewrote their reports with English rhythm. Stripping the
  // technical spans first is what makes the ratio describe the writer.
  const prose = stripTechnicalSpans(text);
  next.messages += 1;
  next.totalChars += prose.length;
  next.hanChars += (prose.match(HAN) ?? []).length;
  next.latinChars += (prose.match(LATIN_LETTER) ?? []).length;

  // Sentence length is a rough proxy for how terse the reader is. Split on the
  // terminators of both scripts; empty fragments are not sentences.
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
 * Remove the parts of a message that are not the writer's prose.
 *
 * Code, paths, commands, URLs and long identifiers say nothing about which
 * language someone thinks in; they are quoted material. What remains is the
 * sentence they actually composed.
 *
 * The lone-identifier rule is applied **only when the message already contains
 * Han characters**. In an all-Latin message the long words *are* the prose, and
 * stripping them would leave nothing to measure — which made every English
 * writer look like a writer of no language at all.
 * @param {string} text
 * @returns {string}
 */
export function stripTechnicalSpans(text) {
  let out = text
    // Fenced blocks, including an unterminated one at the end.
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    // Inline code.
    .replace(/`[^`\n]*`/g, ' ')
    // URLs.
    .replace(/https?:\/\/\S+/g, ' ')
    // Windows and POSIX paths.
    .replace(/[A-Za-z]:\\[^\s]*/g, ' ')
    .replace(/(?:^|\s)\/(?:[\w.-]+\/)+[\w.-]*/g, ' ');

  if (/[\u4e00-\u9fff]/.test(out)) {
    // A lone Latin token of 4+ characters inside a Chinese sentence is almost
    // always an identifier, flag or file name rather than an English word.
    // Short words ("ok", "log") stay, so a mixed writer is still measurable.
    out = out.replace(/\b[A-Za-z][A-Za-z0-9_.-]{3,}\b/g, ' ');
  }
  return out;
}

/**
 * Record one explicit correction.
 *
 * Only sentences that look like a comment on the *style* are kept, and the
 * original wording travels with them: a paraphrase here would be the plugin
 * inventing a preference the user never stated.
 * @param {unknown} current
 * @param {string} text
 * @returns {ReturnType<typeof emptyProfile>}
 */
export function observeFeedback(current, text) {
  const profile = isProfile(current) ? current : emptyProfile();
  if (typeof text !== 'string') return profile;

  const sentences = text
    .split(/[。！？!?\n]+/)
    .map((piece) => piece.trim())
    .filter((piece) => piece !== '')
    .filter((piece) => FEEDBACK_HINTS.some((hint) => piece.includes(hint)));

  if (sentences.length === 0) return profile;

  const next = { ...profile, stated: [...profile.stated] };
  for (const sentence of sentences) {
    if (next.stated.includes(sentence)) continue;
    next.stated.push(sentence);
  }
  // Kept short on purpose: the prompt carries these verbatim, and a long list of
  // old corrections would drown the current report.
  while (next.stated.length > MAX_STATED) next.stated.shift();
  next.updatedAt = Date.now();
  return next;
}

/** Phrasings that mean "this is about how you write", not "this is the task". */
const FEEDBACK_HINTS = [
  '太啰嗦', '太冗长', '太长', '太短', '简明', '简洁', '精简', '啰嗦',
  '别卖萌', '别太萌', '正经', '严肃', '随意', '自然', '生硬', '口语',
  '不要用', '别用', '多说', '少说', '语气', '口吻', '称呼',
  '换一种', '别这么', '不要这么', '太冷淡', '热情',
];

/** Upper bound on remembered corrections. */
const MAX_STATED = 8;

/**
 * Whether a value looks like a profile this module produced.
 * @param {unknown} value
 */
function isProfile(value) {
  if (value === null || typeof value !== 'object') return false;
  const candidate = /** @type {Record<string, unknown>} */ (value);
  return typeof candidate.messages === 'number' && typeof candidate.version === 'number';
}

/**
 * Turn raw counters into the few, high-confidence facts worth putting in a
 * prompt.
 *
 * Thresholds are intentionally conservative. A prompt line that is wrong is
 * worse than a prompt line that is missing: the model will follow it, and the
 * user has no way to trace the resulting tone back to a miscalculated ratio.
 * @param {unknown} raw
 * @returns {{ language: string | undefined, address: string | undefined, terse: boolean | undefined, stated: string[] }}
 */
export function summarizeProfile(raw) {
  const profile = isProfile(raw) ? raw : emptyProfile();
  const result = { language: undefined, address: undefined, terse: undefined, stated: [] };

  // Twenty messages is the point where the ratios stop being noise.
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
  // Only when one form clearly dominates; a tie says nothing.
  if (you + nin >= MIN_SAMPLES) {
    if (nin > you * 2) result.address = '您';
    else if (you > nin * 2) result.address = '你';
  }

  // Stated corrections are not thresholded: the user said them.
  result.stated = Array.isArray(profile.stated) ? profile.stated.slice(-MAX_STATED) : [];
  return result;
}

/** How many messages before an observed ratio is trusted. */
const MIN_SAMPLES = 20;

/**
 * Render the summary as prompt lines.
 *
 * Returns an empty array when nothing is known, so a fresh install adds no
 * tokens and no invented claims.
 * @param {unknown} raw
 * @returns {string[]}
 */
export function memoryLines(raw) {
  const summary = summarizeProfile(raw);
  const lines = [];
  if (summary.language !== undefined) lines.push(`用户主要用${summary.language}提问，参考它的语感。`);
  if (summary.address !== undefined) lines.push(`用户习惯被称呼为「${summary.address}」。`);
  if (summary.terse === true) lines.push('用户平时说话简短，汇报也可以更紧凑一些。');
  if (summary.terse === false) lines.push('用户习惯长句，可以稍微展开，但不要注水。');
  for (const stated of summary.stated) lines.push(`用户曾要求：${stated}`);
  return lines;
}
