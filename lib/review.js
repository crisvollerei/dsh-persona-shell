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

// These are discourse/positive phrases, not a negative assertion. They should
// neither cancel a removed negation elsewhere nor turn a friendly aside into
// a new negation hint.
const negationText = (text) => text.replace(/(?<![\p{L}\p{N}_])不过(?!关|期|时|敏|滤|载)|不但|不仅|不光(?!滑)|不妨|不错(?!过)|不好意思|\bnot\s+only\b/giu, ' ');
const WORK_PREDICATES = /发布|推送|部署|提交|上传|导入|执行|修改|删除|启用|验证|完成|通过/gu;
const STATUS_MODIFIERS = '(?:(?:实际|真正|正式|成功|全部|完全|自动|手动|直接|被))*';
const NEGATIVE_STATUS = new RegExp(`(?:尚未|还未|仍未|并未|从未|未曾|未|还没(?:有)?|仍没(?:有)?|并没(?:有)?|没(?:有)?|(?:并非|不是)(?:已(?:经)?)?)${STATUS_MODIFIERS}$`, 'u');
const POSITIVE_STATUS = new RegExp(`(?:已(?:经)?|现已|确已|业已)${STATUS_MODIFIERS}$`, 'u');

function workStates(text) {
  const states = new Map();
  for (const match of text.matchAll(WORK_PREDICATES)) {
    const before = text.slice(Math.max(0, match.index - 24), match.index).split(/[，,。.!！？?；;:\n]/u).at(-1).trimEnd();
    const after = text.slice(match.index + match[0].length);
    const hypothetical = /如果|假如|除非|若|只要|一旦|要是|可能|也许|或许|似乎|预计|计划|准备|打算|是否|确认|据说|听说|担心|以为/u.test(before)
      || /^(?:的话|时|之前|以前|之后|以后)/u.test(after);
    const negative = NEGATIVE_STATUS.test(before);
    const positive = POSITIVE_STATUS.test(before) || /^(?:了|完成|成功|完毕)/u.test(after)
      || (match[0] === '通过' && /(?:检查|测试|验证|构建|编译|验收)(?:均|都|全部)?$/u.test(before));
    const list = states.get(match[0]) ?? [];
    list.push(hypothetical ? 0 : negative ? -1 : positive ? 1 : 0);
    states.set(match[0], list);
  }
  return states;
}

// Require an explicit status on both sides and an unambiguous single mention
// of the same work predicate. Repeated predicates can belong to different
// subjects or conditions; guessing their alignment would create false alarms
// when a valid rewrite reorders them. This is a narrow review hint, not proof.
function localWorkPolarityChanged(source, target) {
  const left = workStates(source);
  const right = workStates(target);
  for (const [predicate, states] of left) {
    const other = right.get(predicate);
    if (states.length === 1 && other?.length === 1 && states[0] * other[0] === -1) return true;
  }
  return false;
}

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
  const criticalReasons = [];
  // Keep word boundaries for English and strip markers, not their literal text.
  const source = maskedOriginal.replace(/\[\[\s*\d+\s*\]\]/g, ' ');
  const target = maskedCandidate.replace(/\[\[\s*\d+\s*\]\]/g, ' ');
  for (const [reason, pattern] of Object.entries(SIGNALS)) {
    const left = reason === 'negation-change' ? negationText(source) : source;
    const right = reason === 'negation-change' ? negationText(target) : target;
    if ([...left.matchAll(pattern)].length !== [...right.matchAll(pattern)].length) reasons.push(reason);
  }
  if (localWorkPolarityChanged(source, target)) {
    if (!reasons.includes('negation-change')) reasons.push('negation-change');
    criticalReasons.push('negation-change');
  }
  const quantities = (text) => (text.match(/\d+(?:[.,]\d+)*(?:\s*%)?/g) ?? []).join('|');
  if (quantities(source) !== quantities(target)) {
    reasons.push('quantity-change');
    criticalReasons.push('quantity-change');
  }
  const order = (text) => [...text.matchAll(/\[\[\s*(\d+)\s*\]\]/g)].map((match) => Number(match[1])).join(',');
  if (order(maskedOriginal) !== order(maskedCandidate)) reasons.push('literal-order');
  return {
    version: 1,
    scope: 'message',
    method: 'local-lexical-v1',
    editScore: round(Math.max(lexicalChange, lengthChange)),
    reasons,
    ...(criticalReasons.length ? { criticalReasons } : {}),
    sourceHash: reviewFingerprint(original),
    targetHash: reviewFingerprint(candidate),
  };
}

/** Ignore unknown versions or corrupt metadata; old rows stay unassessed. */
export function restoreReview(value) {
  if (value?.version !== 1 || value.scope !== 'message' || value.method !== 'local-lexical-v1'
    || !Number.isFinite(value.editScore) || value.editScore < 0 || value.editScore > 1
    || !Array.isArray(value.reasons) || value.reasons.some((reason) => !REVIEW_REASONS.has(reason))
    || (value.criticalReasons !== undefined && (!Array.isArray(value.criticalReasons)
      || value.criticalReasons.some((reason) => !['negation-change', 'quantity-change'].includes(reason) || !value.reasons.includes(reason))))
    || !/^v1:\d+:[\da-f]+:[\da-f]+$/.test(value.sourceHash)
    || !/^v1:\d+:[\da-f]+:[\da-f]+$/.test(value.targetHash)) return undefined;
  return {
    version: 1, scope: 'message', method: 'local-lexical-v1',
    editScore: value.editScore, reasons: [...new Set(value.reasons)],
    ...(value.criticalReasons !== undefined ? { criticalReasons: [...new Set(value.criticalReasons)] } : {}),
    sourceHash: value.sourceHash, targetHash: value.targetHash,
  };
}
