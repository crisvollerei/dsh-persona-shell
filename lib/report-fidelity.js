import { localWorkPolarityChanged } from './review.js';

// Only balanced quotations exempt their contents. Unclosed quotes leave the prose reviewable.
export function strictSelfReference(masked, personaName = '', pack = {}) {
  const pairs = { '“':'”', '「':'」', '『':'』', '‘':'’', '"':'"', "'":"'" }, stack = [];
  let outside = '', start = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if ((c === "'" || c === '’') && /[a-z0-9]/iu.test(masked[i-1] ?? '')
      && (/[a-z0-9]/iu.test(masked[i+1] ?? '') || (!stack.length && /s/iu.test(masked[i-1])))) continue;
    if (stack.length && c === stack.at(-1)) {
      stack.pop();
      if (!stack.length) start = i + 1;
    } else if (pairs[c]) {
      if (!stack.length) { outside += masked.slice(start, i) + ' '; start = i; }
      stack.push(pairs[c]);
    }
  }
  outside = (outside + masked.slice(start)).replace(/\[\[\d+\]\]/gu, ' ');
  const name = personaName.replace(/（(?:实验性|默认)）$/u, '').trim();
  const aliases = [...(pack.narration?.selfAliases ?? [])];
  for (const m of (pack.identity??'').matchAll(/(?<!不|勿|别|禁止)自称\s*(?:『([^『』\n]{1,8})』|「([^「」\n]{1,8})」)/gu)) aliases.push(m[1]??m[2]);
  return /(?<!自|忘)我(?!国|方)|咱|(?<!别)人家/u.test(outside) || Boolean(name && outside.includes('本' + name))
    || aliases.some(alias=>alias && !['我','咱','人家'].includes(alias) && outside.includes(alias));
}

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
      if ((raw === '一' && (/[同每各逐任某另这那上下前后]/u.test(previous)
        || unit === '步' && previous === '进' || unit === '次' && prose[offset + full.length] === '性')) || /\d/u.test(previous)) return full;
      const value = smallChineseInteger(raw);
      return value === null ? full : value + full.slice(raw.length);
    });
}
function equivalentQuantities(original, candidate) {
  const left = formalQuantityParts(original), right = formalQuantityParts(candidate);
  if (JSON.stringify(left.ordinals) !== JSON.stringify(right.ordinals)) return false;
  // Normalize both sides in the same Arabic-anchored units: a source may mix
  // 2个 and 两个 while the candidate uses 两个 twice for those same references.
  const anchoredUnits = new Set([...arabicCountUnits(left.prose), ...arabicCountUnits(right.prose)]);
  // Counts of three or more also anchor their unit on their own. Leave common
  // indefinite phrases such as 一份报告 alone when neither side quantifies them.
  for (const prose of [left.prose, right.prose]) {
    for (const match of prose.matchAll(new RegExp(`(${chineseNumeral})[ \\t]*(${countUnits})`, 'gu'))) {
      if (Number(smallChineseInteger(match[1])) >= 3) anchoredUnits.add(match[2]);
    }
  }
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
    if (match[2] && /^[话议]/u.test(match[3])) continue;
    const key = /^[\p{L}]{2}/u.exec(match[3].trim())?.[0];
    if (!key) continue;
    const modal = match[1] ?? match[2];
    const kind = /^(?:可|能)/u.test(modal) ? 'permitted' : modal === '会' ? 'expected' : 'required';
    const values = found.get(key) ?? []; values.push(kind); found.set(key, values);
  }
  return found;
}

function widenedScope(original, candidate) {
  const verbs = '覆盖|支持|适用于?|包含';
  const restriction = new RegExp(`(?<!不)(?:仅(?:限)?|只)(?:能|会)?(${verbs})([^，,。！？；;\n]{2,32})`, 'gu');
  const expansion = new RegExp(`(?:同时|也|均|都)(?:能|会)?(${verbs})([^，,。！？；;\n]{2,64})`, 'gu');
  const expanded = [...candidate.matchAll(expansion)];
  if (!expanded.length) return false;
  const retained = [...candidate.matchAll(restriction)];
  return [...original.matchAll(restriction)].some(([, verb, raw]) => {
    const scope = raw.trim();
    return !retained.some(([, nextVerb, nextScope]) => nextVerb === verb && nextScope.trim() === scope)
      && expanded.some(([, nextVerb, nextScope]) => nextVerb === verb && nextScope.trim().startsWith(scope)
        && /^(?:和|与|以及|及|、)/u.test(nextScope.trim().slice(scope.length).trimStart()));
  });
}

// Compare repeated parallel measurements only when both passages explicitly
// name the same subjects, action and unit. Other paraphrases remain reviewable.
function attributedCounts(text) {
  const counts = new Map();
  const pattern = /^\s*(?:[-*+]\s+)?(?:其中\s*|而\s*)?`?([\p{L}][\p{L}\d._-]{0,31}?(?:[ \t]+[\d][\w.-]{0,12})?)`?\s*(?:这边|那边|平台|环境|侧|上|(?<!前|后)端)?\s*(?:已经|已|一共|总共|共)?\s*(完成|通过|失败|修复|跳过|处理|更新|新增|删除)\s*了?\s*(\d+|[零〇一二两三四五六七八九十]+)\s*(个文件|项|次|个|处|条|组|份|行)/u;
  for (const clause of text.split(/[、，,。；;\n]/u)) {
    const match = pattern.exec(clause);
    if (!match) continue;
    const [, rawSubject, action, rawNumber, unit] = match;
    const subject=rawSubject.replace(/[ \t]+/gu,' ');
    const number=/^\d+$/u.test(rawNumber)?rawNumber:smallChineseInteger(rawNumber);
    if(number===null)continue;
    const key = `${action}:${unit}`;
    if (!counts.has(key)) counts.set(key, new Map());
    const group = counts.get(key);
    group.set(subject, group.has(subject) ? null : number);
  }
  return counts;
}

function countAssignmentsChanged(original, candidate) {
  const target = attributedCounts(candidate);
  for (const [key, subjects] of attributedCounts(original)) {
    const other = target.get(key);
    if (!other || subjects.size < 2 || subjects.size !== other.size) continue;
    if ([...subjects].every(([id, value]) => value !== null && other.get(id) != null)
      && [...subjects].some(([id, value]) => value !== other.get(id))) return true;
  }
  return false;
}

export function checkReportFidelity({ original, candidate, maskedOriginal = original, maskedCandidate = candidate, relay = false, workerLabel,
  allowEquivalentQuantities = false, voice = false, subagentLabel, sourceIsSubagent = false, mainWorkerLabel } = {}) {
  const reasons = [];
  const quantityMatch = allowEquivalentQuantities ? equivalentQuantities(original, candidate)
    : JSON.stringify(quantities(original)) === JSON.stringify(quantities(candidate));
  if (!quantityMatch) reasons.push('quantity-change');
  if (countAssignmentsChanged(original, candidate)) reasons.push('quantity-attribution');
  original = maskedOriginal.replace(/\[\[\d+\]\]/gu, ' ');
  candidate = maskedCandidate.replace(/\[\[\d+\]\]/gu, ' ');
  if (widenedScope(original, candidate)) reasons.push('scope-change');
  if (localWorkPolarityChanged(original, candidate)) reasons.push('status-change');
  const hasSubagentLabel = typeof subagentLabel === 'string' && subagentLabel.length > 0;
  // Mixed main/helper prose cannot be aligned by a nickname occurrence alone.
  // Reject the unambiguous no-helper case; otherwise leave that relationship
  // to source-aware reading rather than treating this check as authorization.
  const unexpectedSubagent = hasSubagentLabel && candidate.includes(subagentLabel) && !sourceIsSubagent
    && !original.includes(subagentLabel) && !original.includes('子代理');
  if (unexpectedSubagent) reasons.push('worker-change');
  for (const name of ['工作助手', '原助手']) {
    if (!original.includes(name) || candidate.includes(name)) continue;
    const relayMapping = relay && typeof workerLabel === 'string' && workerLabel && candidate.includes(workerLabel);
    const voiceMapping = voice && !relay && !unexpectedSubagent;
    if (!relayMapping && !voiceMapping && !reasons.includes('worker-change')) reasons.push('worker-change');
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
    && (targetKinds.length === 1 && targetKinds[0] === 'expected'
      || /(?:确认|批准|审批|授权)(?:可以|可|能)?(?:在)?(?:事后|随后|稍后)(?:再|补)/u.test(candidate)
        && !/(?:确认|批准|审批|授权)(?:可以|可|能)?(?:在)?(?:事后|随后|稍后)(?:再|补)/u.test(original))) reasons.push('permission-change');
  for (const [predicate, values] of left) {
    const other = right.get(predicate);
    if (values.length === 1 && other?.length === 1 && values[0] !== 'expected' && other[0] === 'expected') {
      if (!reasons.includes('permission-change')) reasons.push('permission-change'); break;
    }
  }
  return { ok: reasons.length === 0, reasons };
}
