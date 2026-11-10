import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { REPORT_VISUAL_LIMITS, REPORT_VISUAL_ISSUE_CODES, REPORT_VISUAL_WARNING_CODES, makeReportSource, buildReportVisualizationPrompt, validateReportVisualization } from '../lib/report-visualization.js';

const source = text => makeReportSource({ sessionId: 'work-a', seq: 42, text });
const result = (s, extra = {}) => ({ schemaVersion: 1, template: 'overview', title: '本轮工作概览',
  conclusion: { text: '已完成本轮修改。', refs: [s.blocks[0].id] }, sections: [], ...extra });
const parse = (s, extra) => validateReportVisualization(JSON.stringify(result(s, extra)), s);
const group = (kind, items, title = '详细说明') => ({ kind, title, items });
const item = (text, refs = ['b1'], extra = {}) => ({ text, refs, ...extra });

test('report source preserves paragraphs, whitespace, CRLF, long fences and every source character', () => {
  const original = '\r\n# 本轮修改\r\n\r\n修复 `src/main.js`。\r\n\r\n````js\r\nconst fence = "```";\r\n```\r\nconsole.log(fence);\r\n````\r\n\r\n尚未验证真实模型。\r\n';
  const s = source(original);
  assert.equal(s.text, original); assert.equal(s.blocks.map(block => block.text).join(''), original);
  assert.equal(s.blocks.filter(block => block.kind === 'code').length, 1);
  assert.match(s.blocks.find(block => block.kind === 'code').text, /console\.log/u);
  assert.deepEqual(s.blocks.map(block => block.id), s.blocks.map((_, index) => 'b' + (index + 1)));
  assert.equal(s.hash, createHash('sha256').update(original).digest('hex'));
  assert.equal(s.hash, makeReportSource({ sessionId: 'another-work', seq: 99, text: original }).hash);
  assert.deepEqual(s.caveatRefs, [s.blocks.at(-1).id]);
  assert.equal(s.blocks.some(block => !block.text.trim()), false);
});

test('source handles tilde fences, unmatched code and simple single paragraphs without truncation', () => {
  for (const original of ['正文没有换行。', '第一段。\n\n第二段。\n\n', '~~~sh\npnpm test\n~~~~\n结束。', '```js\nconst unfinished = true;']) {
    const s = source(original); assert.equal(s.blocks.map(block => block.text).join(''), original);
  }
  const unfinished = source('```js\nconst unfinished = true;');
  assert.deepEqual(unfinished.caveatRefs, []); assert.equal(unfinished.blocks[0].kind, 'code');
});

test('independent source limits reject oversized reports and too many paragraphs without taking prefixes', () => {
  assert.throws(() => source('x'.repeat(REPORT_VISUAL_LIMITS.sourceChars + 1)), /report-too-long/u);
  assert.throws(() => source(Array.from({ length: REPORT_VISUAL_LIMITS.sourceBlocks + 1 }, () => '段落').join('\n\n')), /report-too-long/u);
  assert.equal(source('x'.repeat(REPORT_VISUAL_LIMITS.sourceChars)).text.length, REPORT_VISUAL_LIMITS.sourceChars);
  for (const args of [undefined, {}, { sessionId: '', seq: 1, text: '报告' }, { sessionId: 'x\nsecret', seq: 1, text: '报告' },
    { sessionId: 'work', seq: 1.5, text: '报告' }, { sessionId: 'work', seq: -1, text: '报告' }, { sessionId: 'work', seq: 1, text: '  ' }])
    assert.throws(() => makeReportSource(args), /invalid-report-source/u);
});

test('prompt has only the complete selected report with evidence identifiers and no hidden conversation data', () => {
  const s = source('修改已经完成。\n\n注意：未进行线上验证。');
  const prompt = buildReportVisualizationPrompt({ ...s, privateMemory: 'PRIVATE', persona: 'PERSONA', chat: 'CHAT' });
  const data = JSON.parse(prompt.user);
  assert.equal(data.task, 'report-visualization'); assert.equal(data.source.hash, s.hash);
  assert.deepEqual(data.source.blocks, s.blocks); assert.deepEqual(data.source.caveatRefs, s.caveatRefs);
  assert.equal(prompt.messages[0].content[0].text, prompt.user);
  assert.doesNotMatch(prompt.user, /PRIVATE|PERSONA|CHAT|work-a/u);
  assert.match(prompt.system, /不获取其他会话/u); assert.match(prompt.system, /不代表已经上线/u);
  assert.match(prompt.system, /条件、否定、未知、失败与未验证/u);
});

test('source hash, source blocks and caveat classification are checked again before validation or prompting', () => {
  const s = source('原始报告。\n\n未验证线上行为。');
  for (const forged of [{ ...s, hash: 'f'.repeat(64) }, { ...s, text: '另一个报告。' },
    { ...s, blocks: [{ id: 'b1', text: '伪造内容', kind: 'text' }] }, { ...s, caveatRefs: [] }]) {
    assert.equal(validateReportVisualization(result(s), forged).reason, 'invalid-report-source');
    assert.throws(() => buildReportVisualizationPrompt(forged), /invalid-report-source/u);
  }
});

test('valid evidence-grounded extraction returns only declared fields and lists the untouched original blocks', () => {
  const s = source('已完成本轮修改。\n\n测试通过。\n\n仍需人工核对线上行为。');
  const parsed = parse(s, { sections: [group('validation', [item('测试通过。', ['b2'], { title: '回归检查', state: 'passed' })])] });
  assert.equal(parsed.ok, true); assert.deepEqual(parsed.unreferenced, ['b3']);
  assert.deepEqual(parsed.value.sections[0].items[0], { title: '回归检查', text: '测试通过。', refs: ['b2'], state: 'passed' });
  assert.deepEqual(s.caveatRefs, ['b3']);
  assert.equal('unreferenced' in parsed.value, false);
});

test('original caveats remain available when the model puts a limitation under validation or omits it entirely', () => {
  const s = source('完成了修改。\n\n未验证真实模型，不保证线上行为。');
  const omitted = parse(s); assert.equal(omitted.ok, true); assert.deepEqual(omitted.unreferenced, ['b2']);
  assert.deepEqual(s.caveatRefs, ['b2']);
  const inValidation = parse(s, { sections: [group('validation', [item('未验证真实模型。', ['b2'], { state: 'not-run' })])] });
  assert.equal(inValidation.ok, true); assert.deepEqual(inValidation.unreferenced, []);
  assert.deepEqual(s.caveatRefs, ['b2']);
});

test('missing, cross-source and unsupported citations are refused while duplicate references normalize safely', () => {
  const s = source('完成了修改。');
  for (const refs of [[], ['missing'], [1], ['other-room:b1'], 'b1'])
    assert.equal(parse(s, { conclusion: { text: '完成了修改。', refs } }).ok, false);
  assert.equal(parse(s, { sections: [group('changes', [item('完成了修改。', ['b2'])])] }).ok, false);
  const duplicate = parse(s, { conclusion: item('完成了修改。', ['b1', 'b1']) });
  assert.equal(duplicate.ok, true); assert.deepEqual(duplicate.value.conclusion.refs, ['b1']);
  assert.deepEqual(duplicate.warnings, [{ code: 'duplicate-refs-normalized', path: '$.conclusion.refs' }]);
});

test('strict JSON refuses ambiguous envelopes, duplicate keys and additional execution fields', () => {
  const s = source('完成了修改。'), wire = JSON.stringify(result(s));
  for (const candidate of [null, [], '{}', '前缀\n```json\n' + wire + '\n```', wire + '\n解释', wire + wire,
    wire.replace('"template":"overview"', '"template":"steps","template":"overview"'),
    wire.replace('"text":"已完成本轮修改。"', '"text":"失败","t\\u0065xt":"已完成本轮修改。"'),
    { ...result(s), html: '<div/>' }, { ...result(s), action: 'execute' },
    result(s, { conclusion: { text: '完成了修改。', refs: ['b1'], href: 'https://example.com' } })])
    assert.equal(validateReportVisualization(candidate, s).ok, false, String(candidate));
});

test('template types and bounded component trees stay inside the supported reading catalog', () => {
  const s = source('先完成修改，再验证。\n\n方案甲重视简洁，方案乙重视扩展。');
  for (const template of ['comparison', 'steps']) {
    const fallback = parse(s, { template }); assert.equal(fallback.ok, true);
    assert.equal(fallback.value.template, 'overview'); assert.equal(fallback.warnings.at(-1).code, 'template-fallback');
  }
  assert.equal(parse(s, { template: 'comparison', sections: [group('comparison', [item('方案甲重视简洁。', ['b2'], { title: '方案甲' })])] }).ok, true);
  assert.equal(parse(s, { template: 'steps', sections: [group('steps', [item('先完成修改，再验证。')])] }).ok, true);
  for (const extra of [{ template: 'dashboard' }, { sections: Array.from({ length: 9 }, () => group('details', [item('完成修改。')])) },
    { sections: [group('details', Array.from({ length: 9 }, () => item('完成修改。')))] },
    { sections: [group('execute', [item('执行修改。')])] }, { title: 'x'.repeat(81) }])
    assert.equal(parse(s, extra).ok, false);
  const empty = parse(s, { sections: [group('details', [])] });
  assert.equal(empty.ok, true); assert.deepEqual(empty.value.sections, []); assert.equal(empty.warnings.at(-1).code, 'empty-section-omitted');
});

test('new numbers, changed paths, new commands and altered versions cannot borrow another cited block authority', () => {
  const s = source('修改 `src/main.js`，测试通过 789 项。\n\n执行 pnpm test，版本为 0.5.0，链接 https://example.com/report 。');
  assert.equal(parse(s, { conclusion: { text: '测试通过 789 项，修改 `src/main.js`。', refs: ['b1'] } }).ok, true);
  for (const conclusion of [item('测试通过 790 项。'), item('完成度 100%。'), item('修改 `src/secret.js`。'), item('修改 src/secret.js。'),
    item('执行 git reset --hard。'), item('版本为 0.6.0。', ['b2']), item('执行 pnpm test。', ['b1']),
    item('链接 https://evil.example/report 。', ['b2'])])
  {
    const parsed = parse(s, { conclusion }); assert.equal(parsed.ok, true, conclusion.text);
    assert.equal(parsed.value.conclusion.text, '整理后的结论暂未通过核对，请查看所引原文。');
    assert.equal(parsed.warnings[0].code, 'ungrounded-conclusion-replaced');
    assert.ok(parsed.unreferenced.includes(conclusion.refs[0]));
  }
  const badGroupTitle = parse(s, { sections: [group('changes', [item('修改已完成。')], '处理 999 个问题')] });
  assert.equal(badGroupTitle.ok, true); assert.equal(badGroupTitle.value.sections[0].title, '主要改动');
  const badTitle = parse(s, { title: '完成了 999 项修改' }); assert.equal(badTitle.ok, true); assert.equal(badTitle.value.title, '报告概览');
});

test('code can be cited without copying or executing it and unchanged inline commands can refer to a code block', () => {
  const s = source('报告已经完成。\n\n```sh\npnpm test\n```\n');
  const parsed = parse(s, { sections: [group('details', [item('命令为 `pnpm test`。', ['b2'])])] });
  assert.equal(parsed.ok, true);
  assert.equal(s.blocks[1].kind, 'code');
  assert.equal(parse(s, { sections: [group('details', [item('<script>pnpm test</script>', ['b2'])])] }).ok, false);
});

test('verification badges need matching source wording and cannot turn a plan or negative result into success', () => {
  const cases = [
    ['测试通过。', 'passed', true], ['Unit tests passed.', 'passed', true], ['尚未测试。', 'passed', false],
    ['测试未通过。', 'passed', false], ['预计测试通过。', 'passed', false], ['如果验证通过再上线。', 'passed', false],
    ['测试失败。', 'failed', true], ['检查未通过。', 'failed', true], ['没有错误。', 'failed', false],
    ['未验证真实模型。', 'not-run', true], ['测试通过。', 'not-run', false], ['状态不确定。', 'unknown', true],
  ];
  for (const [original, state, expected] of cases) {
    const s = source(original); const parsed = parse(s, { conclusion: item(original), sections: [group('validation', [item(original, ['b1'], { state })])] });
    assert.equal(parsed.ok, true, original + ' => ' + state);
    assert.equal(parsed.value.sections[0].items[0].state, expected ? state : undefined, original + ' => ' + state);
    if (!expected) assert.equal(parsed.warnings[0].code, 'unsupported-state-removed');
  }
  const s = source('测试通过。');
  const misplaced = parse(s, { sections: [group('changes', [item('测试通过。', ['b1'], { state: 'passed' })])] });
  assert.equal(misplaced.ok, true); assert.equal(misplaced.value.sections[0].items[0].state, undefined);
});

test('control text, executable surfaces and excessive output are rejected instead of rendered partially', () => {
  const s = source('报告已经完成。');
  for (const unsafe of ['<iframe src="https://evil.example"></iframe>', '<svg onload="alert()">', 'javascript:alert(1)',
    '<thinking>secret</thinking>', 'text\u0001more'])
    assert.equal(parse(s, { conclusion: item(unsafe) }).ok, false);
  const tooLong = parse(s, { sections: Array.from({ length: 8 }, () => group('details', Array.from({ length: 8 }, () => item('字'.repeat(100))))) });
  assert.equal(tooLong.reason, 'visualization-too-long');
  assert.equal(validateReportVisualization(' '.repeat(40001), s).ok, false);
});

test('the prompt contains an internally consistent complete JSON example including schemaVersion', () => {
  const prompt = buildReportVisualizationPrompt(source('本轮工作已经完成。'));
  assert.match(prompt.system, /顶层字段严格为 schemaVersion、template、title、conclusion、sections/u);
  const example = /完整格式示例[^：]+：(\{[^\n]+\})。没有栏目/u.exec(prompt.system);
  assert.ok(example); const parsed = JSON.parse(example[1]);
  assert.equal(parsed.schemaVersion, 1); assert.equal(parsed.template, 'overview'); assert.deepEqual(Object.keys(parsed), ['schemaVersion', 'template', 'title', 'conclusion', 'sections']);
});

test('one complete JSON fence and omitted protocol version normalize without accepting ambiguous surrounding content', () => {
  const s = source('工作完成。'), value = result(s); delete value.schemaVersion;
  const wire = '```json\n' + JSON.stringify(value) + '\n```';
  const parsed = validateReportVisualization(wire, s);
  assert.equal(parsed.ok, true); assert.equal(parsed.value.schemaVersion, 1);
  assert.deepEqual(parsed.warnings, [{ code: 'json-fence-normalized', path: '$' }, { code: 'schema-version-defaulted', path: '$.schemaVersion' }]);
  for (const invalid of [wire + '\n这里是解释', '先说明一下\n' + wire, wire + '\n' + wire,
    JSON.stringify({ ...value, schemaVersion: 2 }), '```javascript\n' + JSON.stringify(value) + '\n```'])
    assert.equal(validateReportVisualization(invalid, s).ok, false);
});

test('ordinary thousands and percent typography do not become new facts, but different values still leave the summary', () => {
  for (const [original, candidate] of [['新增 2405 行代码。', '新增 2,405 行代码。'], ['新增 2,405 行代码。', '新增 2405 行代码。'],
    ['覆盖率为 25%。', '覆盖率为 25％。'], ['覆盖率为 25%。', '覆盖率为 25 %。']]) {
    const s = source(original), parsed = parse(s, { conclusion: item(candidate) });
    assert.equal(parsed.ok, true); assert.equal(parsed.value.conclusion.text, candidate); assert.equal(parsed.warnings, undefined);
  }
  const s = source('新增 2405 行代码。');
  for (const candidate of ['新增 2,406 行代码。', '新增 2.405 行代码。']) {
    const parsed = parse(s, { conclusion: item(candidate) }); assert.equal(parsed.ok, true);
    assert.equal(parsed.warnings[0].code, 'ungrounded-conclusion-replaced'); assert.doesNotMatch(parsed.value.conclusion.text, /2[,.]40[56]/u);
  }
});

test('package terminology is prose while actual commands, paths and versions remain evidence checked', () => {
  const s = source('源码和 npm 包内容一致。');
  const prose = parse(s, { conclusion: item('源码与 npm package 内容一致。') });
  assert.equal(prose.ok, true); assert.equal(prose.value.conclusion.text, '源码与 npm package 内容一致。'); assert.equal(prose.warnings, undefined);
  for (const candidate of ['执行 npm package。', 'git reset --hard', '运行 node attack.js。', '修改 src/secret.js。', '安装版本 0.6.0。']) {
    const parsed = parse(s, { conclusion: item(candidate) }); assert.equal(parsed.ok, true);
    assert.equal(parsed.warnings[0].code, 'ungrounded-conclusion-replaced'); assert.equal(parsed.unreferenced.includes('b1'), true);
  }
});

test('a local evidence mismatch removes only that item and preserves the remaining report and original fallback', () => {
  const s = source('已完成修改。\n\n789 项测试通过。\n\n尚未上线，需要人工验证。');
  const parsed = parse(s, { sections: [group('validation', [item('790 项测试通过。', ['b2'], { state: 'passed' })]),
    group('risks', [item('尚未上线，需要人工验证。', ['b3'])])] });
  assert.equal(parsed.ok, true); assert.deepEqual(parsed.value.sections.map(section => section.kind), ['risks']);
  assert.deepEqual(parsed.unreferenced, ['b2']); assert.doesNotMatch(JSON.stringify(parsed.value), /790/u);
  assert.deepEqual(parsed.warnings, [{ code: 'ungrounded-item-omitted', path: '$.sections[0].items[0].text' },
    { code: 'empty-section-omitted', path: '$.sections[0]' }]);
});

test('diagnostic details contain only fixed codes and structural locations without leaking candidate content', () => {
  const s = source('工作已经完成。');
  const invalid = parse(s, { conclusion: item('敏感候选正文', ['private-source-id']) });
  assert.equal(invalid.ok, false); assert.deepEqual(invalid.issue, { code: 'unknown-evidence', path: '$.conclusion.refs' });
  assert.doesNotMatch(JSON.stringify(invalid), /敏感|private-source-id/u);
  const duplicate = validateReportVisualization('{"template":"overview","template":"steps"}', s);
  assert.deepEqual(duplicate.issue, { code: 'json-duplicate-key', path: '$' });
  const normalized = parse(s, { sections: [group('validation', [item('工作已经完成。', ['b1'], { state: 'passed' })])] });
  for (const result of [invalid, duplicate, normalized]) {
    if (result.issue) assert.ok(REPORT_VISUAL_ISSUE_CODES.includes(result.issue.code));
    for (const warning of result.warnings ?? []) { assert.ok(REPORT_VISUAL_WARNING_CODES.includes(warning.code)); assert.match(warning.path, /^\$/u); }
  }
});
