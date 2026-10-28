/** Local wording-change hints, not semantic validation or a model confidence. */

/**
 * A non-cryptographic fingerprint for accidentally stale row/source pairs.
 * Mirrored in client.js because the page loader cannot import this host module.
 * This is a cache integrity check, never an authentication mechanism.
 */
export function reviewFingerprint(text) {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x85ebca6b);
  }
  return `v1:${text.length}:${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}`;
}

const SIGNALS = {
  'negation-change': /未必|并非|没有|无需|无须|不能|不|未|勿|禁止|\b(?:not|never|no|cannot|without)\b|n['\u2019]t\b/giu,
  'condition-change': /如果|若|只有|除非|前提|仅当|只要|否则|\b(?:if|unless|only\s+when|provided\s+that|otherwise)\b/giu,
  'uncertainty-change': /可能|也许|或许|大概|建议|似乎|\b(?:may|might|perhaps|probably|suggest|recommend|could)\b/giu,
};
const REVIEW_REASONS = new Set([...Object.keys(SIGNALS), 'quantity-change', 'literal-order']);
const round = (value) => Number(value.toFixed(3));
const clean = (text) => text.replace(/\[\[\s*\d+\s*\]\]/g, '').replace(/\s+/gu, '').toLowerCase();

function grams(text) {
  const chars = Array.from(text);
  const counts = new Map();
  if (chars.length === 1) counts.set(chars[0], 1);
  for (let i = 0; i + 1 < chars.length; i += 1) {
    const gram = chars[i] + chars[i + 1];
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

/** Assess only a validated final rewrite. Literals do not dilute the prose score. */
export function assessRewrite({ original, candidate, maskedOriginal, maskedCandidate }) {
  const a = clean(maskedOriginal);
  const b = clean(maskedCandidate);
  const left = grams(a);
  const right = grams(b);
  let shared = 0;
  let total = 0;
  for (const [gram, count] of left) {
    shared += Math.min(count, right.get(gram) ?? 0);
    total += count;
  }
  for (const count of right.values()) total += count;
  const lexicalChange = total === 0 ? 0 : 1 - 2 * shared / total;
  const lengthChange = Math.abs(a.length - b.length) / Math.max(1, a.length, b.length);
  const reasons = [];
  // Keep word boundaries for English and strip markers, not their literal text.
  const source = maskedOriginal.replace(/\[\[\s*\d+\s*\]\]/g, ' ');
  const target = maskedCandidate.replace(/\[\[\s*\d+\s*\]\]/g, ' ');
  for (const [reason, pattern] of Object.entries(SIGNALS)) {
    if ([...source.matchAll(pattern)].length !== [...target.matchAll(pattern)].length) reasons.push(reason);
  }
  const quantities = (text) => (text.match(/\d+(?:[.,]\d+)*(?:\s*%)?/g) ?? []).join('|');
  if (quantities(source) !== quantities(target)) reasons.push('quantity-change');
  const order = (text) => [...text.matchAll(/\[\[\s*(\d+)\s*\]\]/g)].map((match) => Number(match[1])).join(',');
  if (order(maskedOriginal) !== order(maskedCandidate)) reasons.push('literal-order');
  return {
    version: 1,
    scope: 'message',
    method: 'local-lexical-v1',
    editScore: round(Math.max(lexicalChange, lengthChange)),
    reasons,
    sourceHash: reviewFingerprint(original),
    targetHash: reviewFingerprint(candidate),
  };
}

/** Ignore unknown versions or corrupt metadata; old rows stay unassessed. */
export function restoreReview(value) {
  if (value?.version !== 1 || value.scope !== 'message' || value.method !== 'local-lexical-v1'
    || !Number.isFinite(value.editScore) || value.editScore < 0 || value.editScore > 1
    || !Array.isArray(value.reasons) || value.reasons.some((reason) => !REVIEW_REASONS.has(reason))
    || !/^v1:\d+:[\da-f]+:[\da-f]+$/.test(value.sourceHash)
    || !/^v1:\d+:[\da-f]+:[\da-f]+$/.test(value.targetHash)) return undefined;
  return {
    version: 1, scope: 'message', method: 'local-lexical-v1',
    editScore: value.editScore, reasons: [...new Set(value.reasons)],
    sourceHash: value.sourceHash, targetHash: value.targetHash,
  };
}
