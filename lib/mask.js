/**
 * Literal shielding.
 *
 * The report is split into prose and "literals": fenced code, inline code,
 * URLs, filesystem paths, commands, error identifiers and versions. Literals
 * never reach the model; they are replaced by `[[n]]` markers and restored
 * locally afterwards. A dropped or rewritten marker voids the whole rewrite, so
 * the worst failure mode is a bad tone, never a corrupted path or command.
 *
 * Fences are matched by **counting the opening run**, not by a fixed three
 * characters: a ```` block containing a ``` line closed early at the inner one
 * and leaked the rest of the code as prose. Both fence characters have the same
 * rule.
 */

const MARKER = /\[\[\s*(\d+)\s*\]\]/g;

/** A fenced block, closed only by a run at least as long as the opening one. */
const FENCE = /(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\1[ \t]*(?=\n|$)|$)/;

// Bare commands have no explicit Markdown boundary. Keep the familiar launcher
// forms, but do not mistake ordinary uses of "go" or "make" for invocations,
// and stop before an English prose continuation. Ambiguous/custom commands can
// always be made unambiguous with inline code or a fenced block.
const BARE_COMMAND = /\b(npm|npx|pnpm|yarn|node|python|pip|git|cargo|go|dotnet|java|mvn|gradle|docker|kubectl|make|cmake|curl|wget|ssh|scp|rsync|systemctl|brew|apt|choco|deno|bun)\b(?:[ \t]+(?:-{1,2}[\w-]+|[\w./@:=+-]+))+/y;
const GO_SUBCOMMANDS = new Set(['bug', 'build', 'clean', 'doc', 'env', 'fix', 'fmt', 'generate', 'get', 'help', 'install', 'list', 'mod', 'run', 'telemetry', 'test', 'tool', 'version', 'vet', 'work']);
const MAKE_PROSE = new Set(['sure', 'sense', 'it', 'a', 'an', 'the', 'this', 'that', 'these', 'those', 'up', 'your', 'our', 'things', 'clear']);
const PROSE_CONTINUATIONS = new Set(['and', 'but', 'then', 'after', 'before', 'because', 'when', 'while', 'which', 'that', 'with', 'without', 'is', 'are', 'was', 'were', 'has', 'have', 'had', 'will', 'would', 'can', 'could', 'should', 'must', 'needs', 'need', 'successfully']);

function bareCommandAt(input, index) {
  BARE_COMMAND.lastIndex = index;
  const match = BARE_COMMAND.exec(input);
  if (!match) return '';
  const tokens = [...match[0].matchAll(/[^ \t]+/g)];
  const first = tokens[1][0].toLowerCase();
  if (match[1] === 'npm' && ['package', 'packages'].includes(first)
    && !/(?:执行|运行|命令|调用|启动|安装|\b(?:run|execute|command))\s*(?:为|是|[:：])?\s*$/iu.test(input.slice(Math.max(0,index-18),index))) return '';
  if (match[1] === 'go' && !first.startsWith('-') && !GO_SUBCOMMANDS.has(first)) return '';
  if (match[1] === 'make' && MAKE_PROSE.has(first)) return '';
  const stop = tokens.findIndex((token, i) => i > 0 && PROSE_CONTINUATIONS.has(token[0].toLowerCase()));
  if (stop === 1) return '';
  return stop < 0 ? match[0] : match[0].slice(0, tokens[stop].index).trimEnd();
}

/** Longest-match patterns, tried in order at every position. */
const PATTERNS = [
  FENCE,
  /`[^`\n]+`/,
  // URLs: parentheses allowed inside, but only when balanced, so a trailing
  // `）` or `)` from surrounding prose does not truncate the link.
  /https?:\/\/[^\s<>"'`\u3000-\u303f\uff00-\uffef]*(?:\([^\s()]*\)[^\s<>"'`]*)*/,
  /[A-Za-z]:\\[^\s"',;:)\]|]+/,
  // POSIX paths, including a single-segment absolute path like /tmp.
  /(?<![\w.-])\/(?:[\w.@+-]+\/?)+/,
  // Explicitly relative paths, which start with a dot and are otherwise prose.
  /(?<![\w.-])\.{1,2}\/(?:[\w.@+-]+\/?)+/,
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
    let best = bareCommandAt(input, i);
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
