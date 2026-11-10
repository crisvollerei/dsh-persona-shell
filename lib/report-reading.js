/** Local reading structure over the original report. Keep this function dependency-free for the browser copy. */
export function createReportReadingPlan(source, result) {
  const empty = { sourceHash: typeof source?.hash === 'string' ? source.hash : null, entries: [], navigation: [] };
  if (!source || typeof source.text !== 'string' || source.text.length > 24000 || !/^[a-f0-9]{64}$/.test(source.hash ?? '')
    || !Array.isArray(source.blocks) || source.blocks.length > 256 || !Array.isArray(source.caveatRefs)) return empty;
  const ids = new Set(), blocks = [];
  let offset = 0;
  for (const block of source.blocks) {
    if (!block || typeof block.id !== 'string' || !block.id || ids.has(block.id) || typeof block.text !== 'string'
      || !['text', 'code'].includes(block.kind)) return empty;
    ids.add(block.id); blocks.push({ ...block, start: offset, end: offset + block.text.length }); offset += block.text.length;
  }
  if (blocks.map(block => block.text).join('') !== source.text) return empty;
  const roles = new Set(['result', 'risk', 'decision', 'evidence', 'next', 'detail']);
  const plain = value => value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  const validReading = value => plain(value) && Object.keys(value).every(key => ['blockId', 'role', 'importance', 'relatedRefs'].includes(key))
    && ids.has(value.blockId) && roles.has(value.role) && [1, 2, 3].includes(value.importance) && Array.isArray(value.relatedRefs)
    && value.relatedRefs.length <= 16 && value.relatedRefs.every(ref => typeof ref === 'string' && ids.has(ref));
  const reading = new Map(), repeated = new Set();
  if (result?.schemaVersion === 2 && Array.isArray(result.reading) && result.reading.length <= 256) {
    for (const value of result.reading) {
      if (plain(value) && ids.has(value.blockId)) {
        if (reading.has(value.blockId) || repeated.has(value.blockId)) { reading.delete(value.blockId); repeated.add(value.blockId); continue; }
        if (validReading(value)) reading.set(value.blockId, value);
        else repeated.add(value.blockId);
      }
    }
  }
  const byId = new Map(blocks.map(block => [block.id, block])), marked = new Map();
  const annotationRoles = { conclusion: 'result', risk: 'risk', evidence: 'evidence', next: 'next' };
  const roleOrder = { risk: 0, decision: 1, result: 2, next: 3, evidence: 4 };
  for (const value of result?.schemaVersion === 2 && Array.isArray(result.annotations) ? result.annotations.slice(0, 72) : []) {
    const block = byId.get(value?.blockId), role = annotationRoles[value?.kind], quote = value?.quote;
    if (!block || block.kind === 'code' || !role || typeof quote !== 'string' || quote.length < 4 || ![1, 2, 3].includes(value.importance)) continue;
    const at = source.text.indexOf(quote);
    if (at < block.start || at + quote.length > block.end || source.text.indexOf(quote, at + 1) !== -1
      || (value.start !== undefined && value.start !== at) || (value.end !== undefined && value.end !== at + quote.length)) continue;
    const previous = marked.get(block.id);
    if (!previous || roleOrder[role] < roleOrder[previous.role]) marked.set(block.id, { role, importance: value.importance });
  }
  const caveats = new Set(source.caveatRefs.filter(id => ids.has(id)));
  // These are keep guards, not assertions that a failure occurred or a decision is still pending.
  // Match actual conditions and polarity phrases, not individual Chinese
  // characters in neutral words such as 不同、未来、需求、无缝 or 刚才.
  const condition = /风险|限制|注意|尚未|必须|需要|仅(?:在|限|有|供|当|对|用于|支持|适用|涉及|提供|处理|完成|修改|包含|保留|允许|执行|验证|测试|覆盖|表示|代表|说明|进行|使用|本|这|仅)|只有|除非|否则|前提|条件|依赖|仍(?:需|未|不)|可能|失败|警告|建议|后续|下一步|手动|人工|审批|批准|确保|以免|避免|直到|才(?:能|可|会|算|允许|执行|生效)|取决于|是否|要不要|选哪|哪个方案|以上|以下|至少|至多|大于|小于|[<>]=|[≥≤]|(?:^|[，。；：\s])若|如果|假如|假设|在[^。\n]{0,60}(?:环境|范围|平台|版本)|(?:当|等到|一旦)[^。\n]{0,80}(?:时|后|才|再)|(?:完成|成功|确认|通过|满足|就绪|重启|恢复|加载|连接|保存|读取|安装|生成|结束|打开|更新|迁移|启动|登录)[^。\n]{0,12}(?:后|前|时)(?:才|再|可|能|需|会|不|请|应|执行|重试|继续)|待(?:确认|验证|测试|处理|完善|实现|检查|审批|批准|发布|接入|用户|修复|解决|完成|补充|部署)|需(?:确认|提供|保证|满足|先|等|由|用|在|获|重|手动|另行|核对|通过|准备|安装)|\b(?:if|unless|only|except|without|not|never|must|should|required?|requires?|assuming|depends?|dependent|cannot|pending|unverified|untested|unknown|may|might|risk|limitation|caveat|prerequisite|warning|failed|failure|remaining|missing)\b/iu;
  const polarity = /不(?!同|一样|过(?!期|关)|但|仅|光(?!滑)|妨|错(?!过)|约而同|知不觉|由自主|好意思)|未(?!来|央)|无(?!缝|论|数|聊|与伦比)|没(?!关系|事|想到)|需(?!求)|仅|仍/u;
  const englishCondition = /\b(?:no|none|provided|until|when|whenever|once|before|after)\b|\b(?:subject\s+to|as\s+long\s+as|depending\s+on|in\s+case|on\s+condition|in\s+the\s+event|at\s+least|at\s+most|no\s+(?:more|less)\s+than|or\s+(?:higher|lower|above|below|newer|older))\b|\b(?:can|won|shouldn|isn|wasn)['’]t\b/iu;
  const riskSignal = /风险|限制|尚未|未验证|未测试|未覆盖|未上线|待验证|不支持|无法|不保证|前提|仅在|只有|除非|否则|必须|取决于|失败|警告|至少|至多|以上|以下|[<>]=|[≥≤]|如果|假如|假设|在[^。\n]{0,100}(?:环境|范围|平台|版本)[^。\n]{0,40}才|\b(?:risk|limitations?|caveats?|prerequisites?|warnings?|failed|failure|unverified|untested|unsupported|unavailable|cannot|unless|only|assuming|depends?|requires?)\b|\bnot\s+(?:yet\s+)?(?:supported|tested|verified|covered|guaranteed)\b/iu;
  const completedDecision = /无需|不需|不用|不必|已(?:经)?确认|确认(?:完成|通过)|\balready\s+(?:confirmed|approved|decided)|\bno\s+(?:confirmation|approval|decision)\s+(?:is\s+)?(?:needed|required)|\bdoes\s+not\s+require\b/iu;
  const decision = /(?:请|需要|需|等待|待)[^。\n]{0,24}(?:你|用户)[^。\n]{0,24}(?:确认|决定|选择|批准)|(?:请|需要|需|待)(?:确认|决定|选择|批准)|\b(?:please\s+confirm|your\s+(?:decision|approval)|awaiting\s+(?:your\s+)?(?:confirmation|approval)|choose\s+(?:between|one)|decide\s+whether|approval\s+required)\b/iu;
  const riskHeading = /风险|限制|前提|条件|注意|边界|兼容|提醒|未完成|未验证|待验证|待确认|待办|运行环境|系统要求|适用范围|支持范围|使用条件|\b(?:risk|limitations?|caveats?|warnings?|prerequisites?|known\s+issues|remaining|pending|todo|open\s+questions|system\s+requirements|supported\s+platforms|environment)\b/iu;
  const continuation = /^(?:但|不过|然而|否则|其中|同时|另外|此外|上述|前述|该项|这项|此项|相应|适用|部署|上线|使用|满足|前提|only\b|however\b|otherwise\b|provided\b|subject\b)/iu;
  const headingStack = [];
  const protectedRefs = new Set();
  for (const value of reading.values()) for (const ref of value.relatedRefs) protectedRefs.add(ref);
  // Only a whole, simple paragraph can map to one native <p>. Complex Markdown stays visible.
  const paragraphText = block => {
    if (block.kind !== 'text') return null;
    const original = block.text.replace(/\r\n?/g, '\n');
    if (/^(?: {4}|\t)\S/mu.test(original)) return null;
    let text = original.trim();
    if (!text || /\n\s*\n/u.test(text) || /^ {0,3}(?:#{1,6}[ \t]|>|[-+*][ \t]|\d+[.)][ \t]|`{3,}|~{3,}|(?:[-*_][ \t]*){3,}$)/mu.test(text)
      || /^(?: {4}|\t)/mu.test(text) || /[|<>\[\]\\$\uE000\uE001]/u.test(text)
      || /&(?:#[xX][\da-f]+|#\d+|[a-z][a-z\d]+);/iu.test(text) || /\n {0,3}(?:=+|-+)[ \t]*$/u.test(text)) return null;
    const code = [];
    text = text.replace(/`([^`\n]+)`/gu, (_, value) => {
      const literal = value.startsWith(' ') && value.endsWith(' ') && value.trim() ? value.slice(1, -1) : value;
      code.push(literal); return '\uE000' + (code.length - 1) + '\uE001';
    });
    text = text.replace(/\*\*([^*\n]+)\*\*/gu, '$1').replace(/__([^_\n]+)__/gu, '$1')
      .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/gu, '$1').replace(/(?<!_)_([^_\n]+)_(?!_)/gu, '$1');
    if (/[*_`~]/u.test(text)) return null;
    return text.replace(/\uE000(\d+)\uE001/gu, (_, index) => code[Number(index)]).replace(/\s+/gu, ' ').trim();
  };
  const entries = blocks.map(block => {
    const raw = block.text.trim(), lines = raw.split(/\r?\n/u);
    let heading = false;
    if (block.kind === 'text') for (let index = 0; index < lines.length; index++) {
      const atx = /^ {0,3}(#{1,6})[ \t]+(.*)$/u.exec(lines[index]);
      const setext = index + 1 < lines.length && /^ {0,3}(=+|-+)[ \t]*$/u.exec(lines[index + 1]);
      if (!atx && !setext) continue;
      heading = true;
      const level = atx ? atx[1].length : setext[1][0] === '=' ? 1 : 2;
      const text = atx ? atx[2] : lines[index];
      while (headingStack.length && headingStack.at(-1).level >= level) headingStack.pop();
      headingStack.push({ level, guarded: riskHeading.test(text) });
      if (setext) index++;
    }
    const chosen = reading.get(block.id), annotation = marked.get(block.id);
    const localDecision = block.kind === 'text' && !completedDecision.test(raw) && decision.test(raw);
    const localCondition = block.kind === 'text' && (caveats.has(block.id) || condition.test(raw) || polarity.test(raw) || englishCondition.test(raw) || completedDecision.test(raw));
    const localRisk = block.kind === 'text' && riskSignal.test(raw);
    const guardedSection = headingStack.some(value => value.guarded);
    let role = block.kind === 'code' ? 'unknown' : localDecision ? 'decision' : localRisk || guardedSection ? 'risk'
      : annotation?.role ?? chosen?.role ?? 'unknown';
    if (role === 'decision' && completedDecision.test(raw)) role = 'unknown';
    const importance = Math.min(chosen?.importance ?? 3, annotation?.importance ?? 3,
      localCondition || localDecision || guardedSection ? 1 : 3);
    const matchText = paragraphText(block);
    const reason = localDecision ? 'decision' : localRisk || guardedSection ? 'risk' : localCondition ? 'condition'
      : protectedRefs.has(block.id) ? 'related-context' : annotation ? 'marked' : heading || matchText === null ? 'structure'
        : !chosen ? 'unknown' : chosen.role !== 'detail' || chosen.importance !== 3 ? 'important' : 'detail';
    const foldable = reason === 'detail' && role === 'detail' && importance === 3;
    return { blockId: block.id, start: block.start, end: block.end, role, importance, keep: !foldable, foldable, matchText, reason };
  });
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry.foldable || !continuation.test(blocks[index].text.trim())) continue;
    if ([entries[index - 1], entries[index + 1]].some(other => other && ['result', 'risk', 'decision', 'evidence', 'next'].includes(other.role))) {
      Object.assign(entry, { keep: true, foldable: false, reason: 'adjacent-context' });
    }
  }
  const matches = new Map();
  for (const entry of entries) if (entry.matchText) matches.set(entry.matchText, (matches.get(entry.matchText) ?? 0) + 1);
  for (const entry of entries) if (entry.foldable && matches.get(entry.matchText) > 1)
    Object.assign(entry, { keep: true, foldable: false, reason: 'ambiguous-paragraph' });
  const opening = entries.find(entry => entry.matchText !== null);
  if (opening?.foldable) Object.assign(opening, { keep: true, foldable: false, reason: 'opening-context' });
  const navigation = entries.filter(entry => ['result', 'risk', 'decision', 'evidence', 'next'].includes(entry.role)).map(entry => ({
    kind: entry.role, blockId: entry.blockId,
    label: (entry.matchText ?? byId.get(entry.blockId).text.trim().replace(/^ {0,3}#{1,6}[ \t]+/u, '')).slice(0, 96),
  }));
  return { sourceHash: source.hash, entries, navigation };
}
