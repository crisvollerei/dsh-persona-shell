/**
 * Literal shielding.
 *
 * The report is split into prose and "literals": fenced code, inline code,
 * URLs, filesystem paths, error identifiers and versions. Literals never
 * reach the model; they are replaced by `[[n]]` markers and restored locally
 * afterwards. A dropped or rewritten marker voids the whole rewrite, so the
 * worst failure mode is a bad tone, never a corrupted path or command.
 */

const MARKER = /\[\[\s*(\d+)\s*\]\]/g;

/** Longest-match patterns, tried in order at every position. */
const PATTERNS = [
  /```[\s\S]*?(?:```|$)/,
  /~~~[\s\S]*?(?:~~~|$)/,
  /`[^`\n]+`/,
  /https?:\/\/[^\s<>()"'`\]]+/,
  /[A-Za-z]:\\[^\s"',;:)\]|]+/,
  /\/(?:[\w.@+-]+\/)+[\w.@+-]*/,
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/,
  /\bv?\d+\.\d+\.\d+(?:-[\w.]+)?\b/,
];

const STICKY = PATTERNS.map((re) => new RegExp(re.source, `${re.flags.replace(/[gy]/g, '')}y`));

/**
 * Replace every literal with a stable marker.
 * @param {string} input
 * @returns {{ masked: string, literals: string[] }}
 */
export function mask(input) {
  const literals = [];
  let out = '';
  let i = 0;

  while (i < input.length) {
    let best = '';
    for (const re of STICKY) {
      re.lastIndex = i;
      const m = re.exec(input);
      if (m !== null && m[0].length > best.length) best = m[0];
    }
    if (best.length === 0) {
      out += input[i];
      i += 1;
      continue;
    }
    out += `[[${literals.length}]]`;
    literals.push(best);
    i += best.length;
  }

  return { masked: out, literals };
}

/**
 * List the markers that appear, in order, including duplicates.
 * @param {string} text
 * @returns {number[]}
 */
export function markers(text) {
  const found = [];
  for (const m of text.matchAll(MARKER)) found.push(Number(m[1]));
  return found;
}

/**
 * Put the original literals back.
 * @param {string} text
 * @param {readonly string[]} literals
 * @returns {string}
 */
export function unmask(text, literals) {
  return text.replace(MARKER, (_whole, digits) => {
    const index = Number(digits);
    return literals[index] ?? `[[${digits}]]`;
  });
}

/**
 * True when the model reproduced exactly the markers it was given.
 * @param {string} text
 * @param {number} expected
 * @returns {boolean}
 */
export function markersIntact(text, expected) {
  const found = markers(text);
  if (found.length !== expected) return false;
  const seen = new Set();
  for (const index of found) {
    if (index >= expected || seen.has(index)) return false;
    seen.add(index);
  }
  return true;
}
