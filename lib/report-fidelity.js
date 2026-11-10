// Narrow, observable source checks. They do not establish semantic equivalence.
const quantities = text => (text.match(/\d+(?:[.,]\d+)*(?:[ \t]*[%％])?/gu) ?? [])
  .map(value => value.replace(/[ \t]/gu, '').replace('％', '%')).sort();
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
export function checkReportFidelity({ original, candidate, relay = false, workerLabel } = {}) {
  const reasons = [];
  if (JSON.stringify(quantities(original)) !== JSON.stringify(quantities(candidate))) reasons.push('quantity-change');
  for (const name of ['工作助手', '原助手']) {
    if (original.includes(name) && !candidate.includes(name)
      && !(relay && typeof workerLabel === 'string' && workerLabel && candidate.includes(workerLabel))) reasons.push('worker-change');
  }
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
