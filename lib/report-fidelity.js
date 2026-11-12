// Narrow, observable source checks. They do not establish semantic equivalence.
const quantities = text => (text.match(/\d+(?:[.,]\d+)*(?:[ \t]*[%％])?/gu) ?? [])
  .map(value => value.replace(/[ \t]/gu, '').replace('％', '%')).sort();

// The formal-report opt-in only recognizes small, explicit integer counts.
// Do not guess large numerals, decimals, percentages or bare Chinese words.
const chineseNumeral = '[零〇一二两三四五六七八九十百千万亿]+';
const chineseDigits = '零一二三四五六七八九';
function smallChineseInteger(raw) {
  const value = raw.replaceAll('〇', '零').replaceAll('两', '二');
  if (value.length === 1 && chineseDigits.includes(value)) return String(chineseDigits.indexOf(value));
  const match = /^([一二三四五六七八九]?)十([一二三四五六七八九]?)$/u.exec(value);
  return match ? String((match[1] ? chineseDigits.indexOf(match[1]) : 1) * 10
    + (match[2] ? chineseDigits.indexOf(match[2]) : 0)) : null;
}
const countUnits = '处|项|个|次|条|组|份|人|轮|步';
function formalQuantityParts(text) {
  const ordinals = new Set();
  const prose = text.replace(new RegExp(`第[ \\t]*(\\d+|${chineseNumeral})[ \\t]*(阶段|步|项|条|轮|次)`, 'gu'),
    (full, raw, unit) => {
      const value = /^\d+$/u.test(raw) ? raw.replace(/^0+(?=\d)/u, '') : smallChineseInteger(raw);
      if (value === null) return full;
      ordinals.add(`${unit}:${value}`);
      return ' '.repeat(full.length);
    });
  return { prose, ordinals: [...ordinals].sort() };
}
function arabicCountUnits(text) {
  return new Set([...text.matchAll(new RegExp(`(?<![\\d.,])(\\d+)[ \\t]*(${countUnits})`, 'gu'))].map(match => match[2]));
}
function normalizeChineseCounts(prose, anchoredUnits) {
  return prose.replace(new RegExp(`(${chineseNumeral})[ \\t]*(${countUnits})`, 'gu'),
    (full, raw, unit, offset) => {
      if (!anchoredUnits.has(unit)) return full;
      const previous = prose[offset - 1] ?? '';
      // Referential phrases are not new counts: 同一项、下一步、每一项.
      if ((raw === '一' && /[同每各逐任某另这那上下前后]/u.test(previous)) || /\d/u.test(previous)) return full;
      const value = smallChineseInteger(raw);
      return value === null ? full : value + full.slice(raw.length);
    });
}
function equivalentQuantities(original, candidate) {
  const left = formalQuantityParts(original), right = formalQuantityParts(candidate);
  if (JSON.stringify(left.ordinals) !== JSON.stringify(right.ordinals)) return false;
  const leftCounts = quantities(left.prose), rightCounts = quantities(right.prose);
  // Purely Chinese/discourse wording must not manufacture a numeric mismatch
  // when all exposed Arabic counts already match (e.g. 再交代一次 / 一份报告).
  if (JSON.stringify(leftCounts) === JSON.stringify(rightCounts)) return true;
  // Normalize both sides in the same Arabic-anchored units: a source may mix
  // 2个 and 两个 while the candidate uses 两个 twice for those same references.
  const anchoredUnits = new Set([...arabicCountUnits(left.prose), ...arabicCountUnits(right.prose)]);
  const normalizedLeft = normalizeChineseCounts(left.prose, anchoredUnits);
  const normalizedRight = normalizeChineseCounts(right.prose, anchoredUnits);
  // Counts remain a multiset. A value-set would miss 2 passed / 1 failed /
  // 1 notice changing to 2 passed / 2 failed / 1 notice. Only explicit ordinal
  // repetition is ignored, so restating 第1步 need not add a new quantity.
  // Include every explicit Chinese count in an anchored unit, not just values
  // that happen to match: 2项 -> 两项加三项 must still fail.
  return JSON.stringify(quantities(normalizedLeft)) === JSON.stringify(quantities(normalizedRight));
}
function permissions(text) {
  const found = new Map();
  for (const match of text.matchAll(/(?:才(可以|可|能够|能|应当|应该|应|需要|需|会)|(?:[,，][ \t]*|(?:之后|以后|后)(?:[,，][ \t]*)?)(?:就|也)?(会))([^。！？\n；;，,]+)/gu)) {
    const key = /^[\p{L}]{2}/u.exec(match[3].trim())?.[0];
    if (!key) continue;
    const modal = match[1] ?? match[2];
    const kind = /^(?:可|能)/u.test(modal) ? 'permitted' : modal === '会' ? 'expected' : 'required';
    const values = found.get(key) ?? []; values.push(kind); found.set(key, values);
  }
  return found;
}
export function checkReportFidelity({ original, candidate, relay = false, workerLabel,
  allowEquivalentQuantities = false, voice = false, subagentLabel, sourceIsSubagent = false, mainWorkerLabel } = {}) {
  const reasons = [];
  const quantityMatch = allowEquivalentQuantities ? equivalentQuantities(original, candidate)
    : JSON.stringify(quantities(original)) === JSON.stringify(quantities(candidate));
  if (!quantityMatch) reasons.push('quantity-change');
  const hasSubagentLabel = typeof subagentLabel === 'string' && subagentLabel.length > 0;
  // Mixed main/helper prose cannot be aligned by a nickname occurrence alone.
  // Reject the unambiguous no-helper case; otherwise leave that relationship
  // to source-aware reading rather than treating this check as authorization.
  const unexpectedSubagent = hasSubagentLabel && candidate.includes(subagentLabel) && !sourceIsSubagent
    && !original.includes(subagentLabel) && !original.includes('子代理');
  for (const name of ['工作助手', '原助手']) {
    if (!original.includes(name) || candidate.includes(name)) continue;
    const relayMapping = relay && typeof workerLabel === 'string' && workerLabel && candidate.includes(workerLabel);
    const voiceMapping = voice && !relay && !unexpectedSubagent;
    if (!relayMapping && !voiceMapping) reasons.push('worker-change');
  }
  // A real helper report can use elision. Only reject the explicit, newly
  // introduced main-worker label replacing its configured relay worker; do
  // not require names everywhere or misclassify an existing source quotation.
  if (sourceIsSubagent && relay && typeof workerLabel === 'string' && workerLabel
    && typeof mainWorkerLabel === 'string' && mainWorkerLabel && mainWorkerLabel !== workerLabel
    && !original.includes(mainWorkerLabel) && candidate.includes(mainWorkerLabel) && !candidate.includes(workerLabel)
    && !reasons.includes('worker-change')) reasons.push('worker-change');
  const left = permissions(original), right = permissions(candidate);
  const sourceKinds = [...left.values()].flat(), targetKinds = [...right.values()].flat();
  // With exactly one such clause and no existing forecast, the comparison does
  // not depend on the model retaining a particular verb (e.g. 关闭 -> 去关掉).
  if (sourceKinds.length === 1 && sourceKinds[0] !== 'expected'
    && targetKinds.length === 1 && targetKinds[0] === 'expected') reasons.push('permission-change');
  for (const [predicate, values] of left) {
    const other = right.get(predicate);
    if (values.length === 1 && other?.length === 1 && values[0] !== 'expected' && other[0] === 'expected') {
      if (!reasons.includes('permission-change')) reasons.push('permission-change'); break;
    }
  }
  return { ok: reasons.length === 0, reasons };
}
