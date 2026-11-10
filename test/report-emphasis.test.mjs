import test from 'node:test';
import assert from 'node:assert/strict';
import { makeReportSource } from '../lib/report-visualization.js';
import { REPORT_EMPHASIS_LIMITS, buildReportEmphasisPrompt, validateReportEmphasis } from '../lib/report-emphasis.js';

const source = text => makeReportSource({ sessionId: 'work', seq: 42, text });
const context = '\n\n补充说明：这部分原文用于提供完整的上下文，页面始终按原有顺序展示，不会因为着色而修改内容。'.repeat(4);
const sample = () => source('本轮调整已经完成，尚未执行线上验证。\n\n789/789 项测试通过，后续仍需手动检查。' + context);
const annotation = (quote, blockId = 'b1', extra = {}) => ({ blockId, quote, kind: 'conclusion', importance: 1, ...extra });
const result = annotations => ({ schemaVersion: 2, annotations });
const parse = (s, annotations) => validateReportEmphasis(result(annotations), s);

test('emphasis prompt requests exact original words and never asks for a rewritten report or offset', () => {
  const s = sample(), prompt = buildReportEmphasisPrompt({ ...s, privateMemory: 'PRIVATE_SECRET', persona: 'PERSONA_SECRET' });
  const input = JSON.parse(prompt.user);
  assert.equal(input.task, 'report-emphasis'); assert.deepEqual(input.source.blocks, s.blocks);
  assert.equal(input.source.hash, s.hash); assert.deepEqual(input.source.caveatRefs, s.caveatRefs);
  assert.equal(prompt.messages[0].content[0].text, prompt.user);
  assert.doesNotMatch(prompt.user, /PRIVATE_SECRET|PERSONA_SECRET/);
  assert.match(prompt.system, /不能改写、重排、总结/u); assert.match(prompt.system, /最多18项/u);
  assert.match(prompt.system, /schemaVersion.*annotations/u); assert.match(prompt.system, /25%/u);
  assert.match(prompt.system, /不要生成新标题/u); assert.match(prompt.system, /未验证范围/u);
});

test('source identity, complete text, block segmentation and caveats are rechecked before annotation', () => {
  const s = sample();
  for (const forged of [{ ...s, hash: 'f'.repeat(64) }, { ...s, text: '另一份报告。' },
    { ...s, blocks: [{ id: 'b1', kind: 'text', text: '替换内容' }] }, { ...s, caveatRefs: [] }]) {
    assert.equal(parse(forged, []).issue.code, 'source-invalid');
    assert.throws(() => buildReportEmphasisPrompt(forged), /invalid-report-source/u);
  }
});

test('validated emphasis preserves immutable Markdown and derives exact global UTF-16 ranges', () => {
  const original = '# 本轮汇报\r\n\r\n🐟 本轮调整已经完成，尚未执行线上验证。\r\n\r\n789/789 项测试通过，后续仍需手动检查。' + context;
  const s = source(original), before = JSON.stringify(s);
  const parsed = parse(s, [annotation('本轮调整已经完成', 'b2'), annotation('尚未执行线上验证', 'b2', { kind: 'risk' }),
    annotation('789/789 项测试通过', 'b3', { kind: 'evidence', importance: 2 })]);
  assert.equal(parsed.ok, true); assert.equal(parsed.value.schemaVersion, 2); assert.equal(parsed.value.annotations.length, 3);
  for (const value of parsed.value.annotations) {
    assert.equal(original.slice(value.start, value.end), value.quote);
    assert.equal(value.id, 'a' + value.start + '-' + value.end);
    assert.equal(value.start, original.indexOf(value.quote));
  }
  assert.equal(JSON.stringify(s), before); assert.deepEqual(Object.keys(parsed.value), ['schemaVersion', 'annotations']);
  assert.ok(parsed.unreferenced.includes('b1')); assert.equal(parsed.unreferenced.includes('b2'), false);
});

test('one complete JSON fence and an omitted protocol version are reversible format differences', () => {
  const s = sample(), value = { annotations: [annotation('本轮调整已经完成')] };
  const parsed = validateReportEmphasis('```json\n' + JSON.stringify(value) + '\n```', s);
  assert.equal(parsed.ok, true); assert.equal(parsed.value.annotations.length, 1);
  assert.deepEqual(parsed.warnings, [{ code: 'json-fence-normalized', path: '$' }, { code: 'schema-version-defaulted', path: '$.schemaVersion' }]);
  const wire = JSON.stringify(result([]));
  for (const malformed of [wire + '\n解释', '说明：' + wire, wire + wire, '```javascript\n' + wire + '\n```'])
    assert.equal(validateReportEmphasis(malformed, s).ok, false);
});

test('duplicate keys and undeclared execution or visual fields are rejected with bounded metadata', () => {
  const s = sample();
  for (const candidate of [
    '{"schemaVersion":2,"annotations":[],"annotations":[]}',
    '{"schemaVersion":2,"annotations":[{"blockId":"b1","quote":"本轮调整已经完成","q\\u0075ote":"other","kind":"conclusion","importance":1}]}',
    { ...result([]), action: 'execute' }, { ...result([]), html: '<script>attack()</script>' },
    result([{ ...annotation('本轮调整已经完成'), color: 'red' }]),
    result([{ ...annotation('本轮调整已经完成'), href: 'https://evil.invalid' }]),
  ]) {
    const parsed = validateReportEmphasis(candidate, s); assert.equal(parsed.ok, false);
    assert.deepEqual(Object.keys(parsed.issue).sort(), ['code', 'path']);
    assert.doesNotMatch(JSON.stringify(parsed), /attack|evil|other|本轮调整/u);
  }
  assert.equal(validateReportEmphasis('{"schemaVersion":2,"annotations":[],"annotations":[]}', s).issue.code, 'json-duplicate-key');
});

test('unknown, altered, cross-block or globally ambiguous quotes are omitted without losing valid emphasis', () => {
  const s = source('本轮调整已经完成，尚未执行线上验证。\n\n这个重复短句出现在第一处。\n\n这个重复短句出现在第二处。' + context);
  const parsed = parse(s, [annotation('本轮调整已经完成'), annotation('尚未执行线上验证'),
    annotation('伪造的工作结果'), annotation('本轮调整已经完成', 'b2'), annotation('这个重复短句', 'b2'),
    annotation('SECRET_NOT_A_SOURCE', 'SECRET_BLOCK')]);
  assert.equal(parsed.ok, true); assert.equal(parsed.value.annotations.length, 2);
  assert.equal(parsed.warnings.length, 4);
  assert.ok(parsed.warnings.every(warning => warning.code === 'ungrounded-item-omitted'));
  assert.doesNotMatch(JSON.stringify(parsed), /SECRET|伪造/);
  assert.equal(parsed.unreferenced.includes('b2'), true);
});

test('code blocks, inline code, HTML tags, URLs and paths keep the native technical presentation', () => {
  const body = '本轮调整已经完成。使用 `pnpm test` 检查，文件为 src/main.js，参考 https://example.com/report 。\n\n'
    + '```js\nconst exact = "特殊代码原文";\n```\n\n<span>这是普通说明</span>。' + context;
  const s = source(body), codeBlock = s.blocks.find(block => block.kind === 'code'), htmlBlock = s.blocks.find(block => block.text.includes('<span>'));
  const parsed = parse(s, [annotation('本轮调整已经完成'), annotation('pnpm test'), annotation('src/main.js'),
    annotation('https://example.com/report'), annotation('特殊代码原文', codeBlock.id), annotation('<span>', htmlBlock.id)]);
  assert.equal(parsed.ok, true); assert.deepEqual(parsed.value.annotations.map(a => a.quote), ['本轮调整已经完成']);
  assert.equal(parsed.warnings.length, 5);
  assert.equal(s.text, body);
});

test('bare commands and technical paths retain their own presentation without swallowing numeric evidence', () => {
  const s = source('本轮调整已经完成，789/789 项测试通过。执行 pnpm test 后检查 /tmp，相关文件在 2026-reports/main.js，版本 0.2.2-rc.1。' + context);
  const parsed = parse(s, [annotation('本轮调整已经完成'), annotation('789/789 项测试通过', 'b1', { kind: 'evidence' }),
    annotation('pnpm test'), annotation('/tmp'), annotation('2026-reports/main.js'), annotation('0.2.2-rc.1')]);
  assert.equal(parsed.ok, true); assert.deepEqual(parsed.value.annotations.map(a => a.quote), ['本轮调整已经完成', '789/789 项测试通过']);
  assert.equal(parsed.warnings.length, 4);
});

test('plain bold contents remain eligible while the native renderer owns complete links and their labels', () => {
  const s = source('本轮采用 **完整发布流程**，请先[查看发布说明](https://example.com/release)再决定。' + context);
  const parsed = parse(s, [annotation('完整发布流程'), annotation('查看发布说明'), annotation('**完整发布流程**'), annotation('](https://example.com/release)')]);
  assert.equal(parsed.ok, true); assert.deepEqual(parsed.value.annotations.map(a => a.quote), ['完整发布流程']);
  assert.equal(parsed.warnings.length, 3);
});

test('entity conversion, formulas, reference labels and Markdown escapes never create misplaced emphasis', () => {
  const s = source('本轮调整已经完成。\n\n实体 &amp; 与 &#38;、&#x26; 保留。链接 [重要结论](https://example.com)，参考 [参考详情][r] 和 ![图示原文][r]，快捷 [引用原文]。\n\n'
    + '公式 $x + y = z$ 与 $$a^2 + b^2$$ 不作语义着色。转义 \\*明确提醒\\* 仍保留。\n\n**普通加粗内容**。\n\n[r]: https://example.com/ref' + context);
  const quotes = ['本轮调整已经完成', '普通加粗内容', '&amp;', '&#38;', '&#x26;', '重要结论', '参考详情', '图示原文', '引用原文', 'x + y', 'a^2 + b^2', '\\*明确提醒\\*'];
  const values = quotes.map(quote => annotation(quote, s.blocks.find(block => block.text.includes(quote)).id));
  const parsed = parse(s, values);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value.annotations.map(value => value.quote), ['本轮调整已经完成', '普通加粗内容']);
  assert.equal(parsed.warnings.length, quotes.length - 2);
  for (const value of parsed.value.annotations) assert.equal(s.text.slice(value.start, value.end), value.quote);
});

test('overlapping or duplicated highlights select the more important source range without altering either text', () => {
  const s = source('已经完成本轮修改，但尚未执行线上验证，需要人工确认。' + context);
  const parsed = parse(s, [annotation('已经完成本轮修改，但尚未执行线上验证', 'b1', { importance: 2 }),
    annotation('尚未执行线上验证', 'b1', { kind: 'risk', importance: 1 }), annotation('尚未执行线上验证', 'b1', { kind: 'evidence', importance: 3 })]);
  assert.equal(parsed.ok, true); assert.deepEqual(parsed.value.annotations.map(a => [a.quote, a.kind]), [['尚未执行线上验证', 'risk']]);
  assert.equal(parsed.warnings.length, 2);
});

test('highlight coverage remains sparse and tiny reports can stay entirely unmarked', () => {
  const tiny = source('测试通过。');
  const empty = parse(tiny, [annotation('测试通过。')]); assert.equal(empty.ok, true); assert.deepEqual(empty.value.annotations, []);
  assert.equal(empty.unreferenced.includes('b1'), true);
  const s = source('甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳');
  const parsed = parse(s, [annotation('甲乙丙丁'), annotation('戊己庚辛')]);
  assert.equal(parsed.ok, true); assert.equal(parsed.value.annotations.reduce((n, a) => n + a.quote.length, 0), 4);
  assert.ok(parsed.value.annotations.reduce((n, a) => n + a.quote.length, 0) <= s.text.length * REPORT_EMPHASIS_LIMITS.coverage);
});

test('maximum count and absolute character budget remain bounded even if a model overselects', () => {
  const phrases = Array.from({ length: 24 }, (_, i) => '重点' + String(i).padStart(2, '0'));
  const s = source(phrases.join('、') + context.repeat(3));
  const parsed = parse(s, phrases.map(quote => annotation(quote)));
  assert.equal(parsed.ok, true); assert.equal(parsed.value.annotations.length, REPORT_EMPHASIS_LIMITS.annotations);
  const longQuotes = Array.from({ length: 18 }, (_, i) => '长段' + String(i).padStart(2, '0') + String.fromCharCode(0x4e00 + i).repeat(146));
  const long = source(longQuotes.join('，') + context.repeat(16));
  const longResult = parse(long, longQuotes.map(quote => annotation(quote)));
  assert.equal(longResult.ok, true); assert.equal(longResult.value.annotations.reduce((n, a) => n + a.quote.length, 0), 1200);
  assert.ok(longResult.value.annotations.length < 18);
  assert.equal(parse(s, Array.from({ length: REPORT_EMPHASIS_LIMITS.candidates + 1 }, () => annotation(phrases[0]))).ok, false);
});

test('normalized cache annotations are revalidated and their offsets never become authority', () => {
  const s = sample(), parsed = parse(s, [annotation('本轮调整已经完成')]); assert.equal(parsed.ok, true);
  const restored = validateReportEmphasis(parsed.value, s); assert.equal(restored.ok, true); assert.deepEqual(restored.value, parsed.value);
  for (const patch of [{ start: parsed.value.annotations[0].start + 1 }, { end: 0 }, { id: 'a-forged' }, { start: -1 }, { quote: '尚未执行线上验证' }]) {
    const value = structuredClone(parsed.value); Object.assign(value.annotations[0], patch);
    assert.equal(validateReportEmphasis(value, s).ok, false);
  }
  assert.equal(validateReportEmphasis(JSON.stringify(parsed.value), s).ok, false, 'a model wire cannot provide backend-derived positions');
});

test('schema bounds and diagnostic metadata do not expose source or rejected model strings', () => {
  const s = sample();
  for (const value of [null, [], {}, { schemaVersion: 1, annotations: [] }, { schemaVersion: 2, annotations: 'not-array' },
    result([annotation('本轮调整已经完成', 'b1', { importance: 0 })]), result([{ ...annotation('本轮调整已经完成'), kind: 'execute' }])])
    assert.equal(validateReportEmphasis(value, s).ok, false);
  assert.equal(validateReportEmphasis(' '.repeat(REPORT_EMPHASIS_LIMITS.wireChars + 1), s).issue.code, 'wire-too-long');
  const bad = validateReportEmphasis('{"VERY_PRIVATE_MODEL_CONTENT":', s);
  assert.deepEqual(bad.issue, { code: 'json-invalid', path: '$' }); assert.doesNotMatch(JSON.stringify(bad), /VERY_PRIVATE_MODEL_CONTENT/);
});

test('optional reading classifications preserve old annotation caches and normalize source order', () => {
  const s = source('本轮工作已经完成。\n\n布局容器沿用固定定位。\n\n真实服务尚未验证。');
  const input = { schemaVersion: 2, annotations: [], reading: [
    { blockId: 'b2', role: 'detail', importance: 3, relatedRefs: [] },
    { blockId: 'b1', role: 'result', importance: 1, relatedRefs: ['b3', 'b3'] },
    { blockId: 'b3', role: 'risk', importance: 1, relatedRefs: [] },
  ] };
  const parsed = validateReportEmphasis(JSON.stringify(input), s);
  assert.equal(parsed.ok, true); assert.deepEqual(parsed.value.reading.map(entry => entry.blockId), ['b1', 'b2', 'b3']);
  assert.deepEqual(parsed.value.reading[0].relatedRefs, ['b3']);
  assert.deepEqual(validateReportEmphasis(parsed.value, s).value, parsed.value);
  assert.equal(Object.hasOwn(validateReportEmphasis(result([]), s).value, 'reading'), false);
  assert.equal(JSON.stringify(s.text), JSON.stringify('本轮工作已经完成。\n\n布局容器沿用固定定位。\n\n真实服务尚未验证。'));
});

test('invalid reading metadata is omitted locally without losing source or valid annotations', () => {
  const s = sample();
  const base = { blockId: 'b1', role: 'detail', importance: 3, relatedRefs: [] };
  for (const reading of [null, {}, 'RAW_SECRET', Array.from({ length: 257 }, () => base), [
    { ...base, blockId: 'missing' }, { ...base, role: 'execute' }, { ...base, importance: 9 },
    { ...base, relatedRefs: ['missing'] }, { ...base, relatedRefs: null }, { ...base, foldable: true },
    { ...base, keep: false }, { ...base, matchText: 'RAW_SECRET' }, { ...base, html: '<script>RAW_SECRET</script>' },
  ]]) {
    const parsed = validateReportEmphasis({ ...result([annotation('本轮调整已经完成')]), reading }, s);
    assert.equal(parsed.ok, true); assert.equal(parsed.value.annotations.length, 1); assert.deepEqual(parsed.value.reading, []);
    assert.ok(parsed.warnings.some(warning => warning.code === 'ungrounded-item-omitted'));
    assert.doesNotMatch(JSON.stringify(parsed), /RAW_SECRET|script|missing|execute/);
  }
});

test('conflicting duplicate block classifications fail closed instead of letting a later detail win', () => {
  const s = source('本轮工作已经完成。\n\n布局容器沿用固定定位。');
  const detail = { blockId: 'b1', role: 'detail', importance: 3, relatedRefs: [] };
  for (const first of [{ ...detail, role: 'risk', importance: 1 }, { ...detail, relatedRefs: ['missing'] }, { ...detail, foldable: true }]) {
    const parsed = validateReportEmphasis({ ...result([]), reading: [first, detail,
      { ...detail, blockId: 'b2' }] }, s);
    assert.equal(parsed.ok, true); assert.deepEqual(parsed.value.reading.map(entry => entry.blockId), ['b2']);
    assert.ok(parsed.warnings.length >= 1);
  }
});
