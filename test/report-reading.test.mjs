import test from 'node:test';
import assert from 'node:assert/strict';
import { makeReportSource } from '../lib/report-visualization.js';
import { createReportReadingPlan } from '../lib/report-reading.js';

const source = text => makeReportSource({ sessionId: 'work', seq: 42, text });
const passage = (blockId, role = 'detail', importance = 3, relatedRefs = []) => ({ blockId, role, importance, relatedRefs });
const result = reading => ({ schemaVersion: 2, annotations: [], reading });
const classifyAll = s => result(s.blocks.map(block => passage(block.id)));

test('reading plan preserves complete source order, UTF-16 offsets and immutable inputs', () => {
  const s = source('🐟 本轮工作完成。\r\n\r\n布局容器沿用固定定位。\r\n\r\n正文按原有顺序输出。');
  const input = result([passage('b3'), passage('b1', 'result', 1), passage('b2')]);
  const before = JSON.stringify({ s, input }), plan = createReportReadingPlan(s, input);
  assert.equal(plan.sourceHash, s.hash); assert.deepEqual(plan.entries.map(entry => entry.blockId), ['b1', 'b2', 'b3']);
  for (const [index, entry] of plan.entries.entries()) assert.equal(s.text.slice(entry.start, entry.end), s.blocks[index].text);
  assert.equal(JSON.stringify({ s, input }), before); assert.equal(plan.entries[1].foldable, true);
  assert.deepEqual(plan.navigation.map(entry => entry.kind), ['result']);
});

test('only explicit low-priority detail can fold and unknown or important content stays visible', () => {
  const s = source('本轮工作完成。\n\n布局容器沿用固定定位。\n\n正文按原有顺序输出。\n\n补充记录描述视觉元素。');
  const plan = createReportReadingPlan(s, result([passage('b1', 'result', 1), passage('b2'), passage('b3', 'detail', 2)]));
  assert.deepEqual(plan.entries.map(entry => entry.keep), [true, false, true, true]);
  assert.equal(plan.entries[3].role, 'unknown'); assert.equal(plan.entries[3].reason, 'unknown');
});

test('older annotations-only caches keep all paragraphs and still provide grounded navigation', () => {
  const s = source('本轮工作完成。\n\n布局容器沿用固定定位。');
  const quote = '本轮工作完成。';
  const plan = createReportReadingPlan(s, { schemaVersion: 2, annotations: [{ blockId: 'b1', quote, kind: 'conclusion', importance: 1, start: 0, end: quote.length }] });
  assert.ok(plan.entries.every(entry => entry.keep)); assert.deepEqual(plan.navigation.map(entry => entry.blockId), ['b1']);
  assert.equal(createReportReadingPlan(s, { schemaVersion: 1, reading: [passage('b2')] }).entries[1].keep, true);
});

test('all condition, uncertainty and scope guards override a mistaken detail classification', () => {
  for (const text of ['在 Windows / Node20 环境下才通过。', '必须安装运行依赖。', '仅支持桌面环境。', '只有启用后才能使用。',
    '除非补齐依赖，否则无法使用。', '前提是人工核对。', '需检查当前版本。', '取决于提供方能力。', 'Node >= 20 才通过。',
    '版本 <= 21 适用。', '版本 ≥ 20。', '版本 ≤ 21。', '20 以上版本适用。', '21 以下版本适用。',
    'Only desktop environments are covered.', 'Unless the prerequisites are met, wait.', 'If storage opens, continue.',
    'Requires a manual review.', 'Assuming the service is ready, proceed.', 'Depends on the provider.', 'Without a key, it fails.',
    'Validation is pending.', 'The live service remains unverified.', 'This has not been tested.',
    '当前环境不支持。', '无法使用这个接口。', '不保证生产可用。', '当前功能未上线。', 'This is not supported.', 'Cannot load the live service.',
    'This feature is available provided that the client is restarted.', 'This is subject to a review.', 'It works as long as the source is available.',
    'It behaves differently depending on the provider.',
    'Keep the page open until the save completes.', 'When the storage opens, retry.', 'Run this once the job completes.',
    'After the page reloads, check again.', 'Before release, review the original.', 'Node 20 or higher is needed.', 'Use at least two workers.']) {
    const s = source(text), plan = createReportReadingPlan(s, classifyAll(s));
    assert.equal(plan.entries[0].keep, true, text); assert.equal(plan.entries[0].foldable, false, text);
  }
});

test('source caveats remain visible even when model metadata calls them minor detail', () => {
  const s = source('外部设备表现待确认。');
  assert.ok(s.caveatRefs.includes('b1'));
  assert.equal(createReportReadingPlan(s, classifyAll(s)).entries[0].keep, true);
});

test('keep guards do not invent risk navigation for a normal benefit or a next action', () => {
  const s = source('本地恢复不触发模型调用。\n\n下一步由用户手动核对。');
  const plan = createReportReadingPlan(s, result([passage('b1', 'result', 1), passage('b2', 'next', 2)]));
  assert.ok(plan.entries.every(entry => entry.keep));
  assert.deepEqual(plan.navigation.map(entry => entry.kind), ['result', 'next']);
  assert.ok(plan.entries.every(entry => entry.reason === 'condition'));
});

test('completed or explicitly unnecessary confirmation is not a pending decision', () => {
  for (const text of ['这项已经确认。', '无需你确认，界面沿用现有选择。', '不必确认。', 'Already confirmed.', 'No approval is required.']) {
    const s = source(text), plan = createReportReadingPlan(s, result([passage('b1', 'decision', 1)]));
    assert.equal(plan.entries[0].keep, true); assert.equal(plan.navigation.some(entry => entry.kind === 'decision'), false, text);
    const detail = createReportReadingPlan(s, classifyAll(s));
    assert.equal(detail.entries[0].keep, true, text); assert.equal(detail.navigation.some(entry => entry.kind === 'decision'), false, text);
  }
  const s = source('请你确认采用哪个方案。');
  const plan = createReportReadingPlan(s, classifyAll(s));
  assert.equal(plan.entries[0].keep, true); assert.equal(plan.navigation[0].kind, 'decision');
});

test('risk headings protect following detail through nested sections until a peer section begins', () => {
  const s = source('## 限制与前提\n\n部署环境范围见本段。\n\n### 平台信息\n\n这里列出环境说明。\n\n## 实现细节\n\n布局容器沿用固定定位。');
  const plan = createReportReadingPlan(s, classifyAll(s));
  for (const id of ['b1', 'b2', 'b3', 'b4']) assert.equal(plan.entries.find(entry => entry.blockId === id).keep, true);
  assert.equal(plan.entries.at(-1).foldable, true);
  assert.equal(plan.entries.find(entry => entry.blockId === 'b4').role, 'risk');
});

test('declared related context stays visible and malformed or conflicting reading entries cannot fold', () => {
  const s = source('本轮工作完成。\n\n布局容器沿用固定定位。\n\n正文按原有顺序输出。');
  const plan = createReportReadingPlan(s, result([passage('b1', 'result', 1, ['b3']), passage('b2'), passage('b3')]));
  assert.equal(plan.entries[2].keep, true); assert.equal(plan.entries[2].reason, 'related-context');
  for (const reading of [
    [passage('b2', 'detail', 3, ['missing'])],
    [passage('b2', 'result', 1), passage('b2')],
    [{ ...passage('b2'), foldable: true }],
    [passage('b2', 'unknown', 3)],
    Array.from({ length: 257 }, () => passage('b2')),
  ]) assert.equal(createReportReadingPlan(s, result(reading)).entries[1].keep, true);
});

test('a previously marked paragraph remains visible even when reading metadata calls it detail', () => {
  const s = source('本轮工作完成。\n\n布局容器沿用固定定位。'), quote = '布局容器沿用固定定位';
  const input = classifyAll(s); input.annotations.push({ blockId: 'b2', quote, kind: 'evidence', importance: 2 });
  const plan = createReportReadingPlan(s, input);
  assert.equal(plan.entries[1].keep, true); assert.equal(plan.entries[1].role, 'evidence');
});

test('simple paragraph matching includes native bold and inline code without changing technical literals', () => {
  const s = source('布局使用 **固定容器**，文件为 `src/main_file.js`。\n\n普通正文包含换行\n继续说明布局方式。');
  const plan = createReportReadingPlan(s, classifyAll(s));
  assert.equal(plan.entries[0].matchText, '布局使用 固定容器，文件为 src/main_file.js。');
  assert.equal(plan.entries[1].matchText, '普通正文包含换行 继续说明布局方式。');
  assert.equal(plan.entries[0].reason, 'opening-context'); assert.equal(plan.entries[0].keep, true);
  assert.equal(plan.entries[1].foldable, true);
});

test('complex, transformed or ambiguous Markdown structures stay visible', () => {
  for (const text of ['# 标题', '- 列表说明\n- 第二项', '> 引用说明', '| 项目 | 结果 |\n| --- | --- |\n| 容器 | 固定 |',
    '```js\nconst frame = true;\n```', '    const frame = true;', '[详情](https://example.com)', '结论 &amp; 条件。',
    '<span>正文</span>', '数学 $a+b$。', '使用 \\* 转义。', '不完整的 **加粗标记。']) {
    const s = source(text), plan = createReportReadingPlan(s, classifyAll(s));
    assert.ok(plan.entries.every(entry => entry.keep), text); assert.ok(plan.entries.every(entry => entry.matchText === null), text);
  }
  const s = source('**布局容器**沿用固定定位。\n\n布局容器沿用固定定位。');
  const plan = createReportReadingPlan(s, classifyAll(s));
  assert.ok(plan.entries.every(entry => entry.keep)); assert.ok(plan.entries.every(entry => entry.reason === 'ambiguous-paragraph'));
});

test('an adjacent continuation of important content stays visible without keeping unrelated details forever', () => {
  const s = source('本轮工作完成。\n\n其中布局部分沿用固定定位。\n\n普通说明描述元素排列。');
  const plan = createReportReadingPlan(s, result([passage('b1', 'result', 1), passage('b2'), passage('b3')]));
  assert.equal(plan.entries[1].keep, true); assert.equal(plan.entries[1].reason, 'adjacent-context');
  assert.equal(plan.entries[2].foldable, true);
});

test('invalid source shape fails closed without producing a partial folding plan', () => {
  const s = source('布局容器沿用固定定位。');
  for (const value of [null, { ...s, hash: 'invalid' }, { ...s, text: '另一份原文' },
    { ...s, blocks: [...s.blocks, ...s.blocks] }, { ...s, caveatRefs: null },
    { ...s, blocks: [{ ...s.blocks[0], text: 1 }] }]) {
    const plan = createReportReadingPlan(value, classifyAll(s));
    assert.deepEqual(plan.entries, []); assert.deepEqual(plan.navigation, []);
  }
});

test('the browser helper executes independently from its function source with identical results', () => {
  const browserCopy = Function('return (' + createReportReadingPlan.toString() + ')')();
  const s = source('本轮工作完成。\n\n布局容器沿用固定定位。\n\n真实环境尚未验证。');
  const input = result([passage('b1', 'result', 1), passage('b2'), passage('b3')]);
  assert.deepEqual(browserCopy(s, input), createReportReadingPlan(s, input));
});

test('environment and applicability headings keep even otherwise plain platform details visible', () => {
  for (const heading of ['运行环境', '系统要求', '适用范围', '支持范围', '使用条件', 'System requirements', 'Supported platforms', 'Environment']) {
    const s = source('# ' + heading + '\n\nWindows 客户端。\n\n界面适配桌面窗口。\n\n# 实现细节\n\n布局容器沿用固定定位。');
    const plan = createReportReadingPlan(s, classifyAll(s));
    for (const id of ['b2', 'b3']) {
      const entry = plan.entries.find(value => value.blockId === id);
      assert.equal(entry.keep, true, heading); assert.equal(entry.foldable, false, heading);
      assert.equal(entry.role, 'risk', heading); assert.equal(entry.reason, 'risk', heading);
    }
    assert.equal(plan.entries.at(-1).foldable, true, heading);
  }
});

test('all-detail reports retain the first readable paragraph as an opening context', () => {
  const s = source('# 布局说明\n\n布局容器沿用固定定位。\n\n正文按原有顺序输出。\n\n界面元素沿用现有样式。');
  const plan = createReportReadingPlan(s, classifyAll(s));
  assert.equal(plan.entries[0].matchText, null);
  assert.equal(plan.entries[1].keep, true); assert.equal(plan.entries[1].foldable, false);
  assert.equal(plan.entries[1].reason, 'opening-context');
  assert.ok(plan.entries.slice(2).every(entry => entry.foldable));
  assert.deepEqual(plan.entries.map(entry => entry.blockId), s.blocks.map(block => block.id));
});

test('retrospective whether checks retain evidence navigation instead of creating a pending decision', () => {
  const s = source('已经检查是否存在问题，结果正常。');
  const plan = createReportReadingPlan(s, result([passage('b1', 'evidence', 1)]));
  assert.equal(plan.entries[0].keep, true); assert.equal(plan.entries[0].role, 'evidence');
  assert.deepEqual(plan.navigation.map(entry => entry.kind), ['evidence']);
});

test('bare questions remain visible without locally manufacturing a user confirmation', () => {
  for (const question of ['是否现在发布？', '要不要继续？', '选哪一种方案？', '哪个方案适合？']) {
    const s = source('本轮工作完成。\n\n' + question);
    const plan = createReportReadingPlan(s, result([passage('b1', 'result', 1), passage('b2')]));
    assert.equal(plan.entries[1].keep, true, question); assert.equal(plan.entries[1].foldable, false, question);
    assert.equal(plan.entries[1].reason, 'condition', question);
    assert.equal(plan.navigation.some(entry => entry.kind === 'decision'), false, question);
    const classified = createReportReadingPlan(s, result([passage('b1', 'result', 1), passage('b2', 'decision', 1)]));
    assert.equal(classified.navigation.some(entry => entry.kind === 'decision'), true, question);
  }
});
