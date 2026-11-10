import test from 'node:test';
import assert from 'node:assert/strict';
import { makeReportSource } from '../lib/report-visualization.js';
import { buildReportReadablePrompt, parseReportReadable, validateReportReadable } from '../lib/report-readable.js';

const source = text => makeReportSource({ sessionId: 'work', seq: 8, text });
const wire = (raw, edit = blocks => blocks) => JSON.stringify({ schemaVersion: 3,
  blocks: edit(JSON.parse(buildReportReadablePrompt(raw).user).source.blocks.map(({ ref, text }) => ({ ref, text }))) });
const raw = source('初始化完成；失败任务未重试，只有用户确认后恢复。\n\n本地修改 2 处，`config.yml` 保持不变，尚未推送。\n\n```sh\nnode --test\n```\n');

test('readable prompt receives only the complete pinned source, masked literals and sentence-level instructions', () => {
  const prompt = buildReportReadablePrompt(raw), input = JSON.parse(prompt.user);
  assert.equal(input.task, 'report-readable'); assert.equal(input.source.hash, raw.hash);
  assert.equal(input.source.blocks.length, raw.blocks.length);
  assert.doesNotMatch(prompt.user, /config\.yml|node --test|memory|persona|chatHistory/);
  assert.match(prompt.system, /主体不明确/); assert.match(prompt.system, /不是摘要/);
  assert.match(prompt.system, /否定.*条件.*风险/);
});

test('readable full sentences retain source order, known subjects, conditions and exact technical content', () => {
  const result = parseReportReadable(wire(raw, blocks => blocks.map((block, index) => ({ ...block, text: index === 0
    ? '初始化已经完成了。失败的任务还没有重试，只有用户确认后才会恢复。' : index === 1
      ? '这次在本地修改了 2 处，[[0]] 保持不变，代码还没有推送。' : block.text }))), raw);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.blocks.map(block => block.ref), raw.blocks.map(block => block.id));
  assert.match(result.value.blocks[0].text, /还没有重试/);
  assert.match(result.value.blocks[1].text, /`config.yml`/);
  assert.equal(result.value.blocks[2].text, raw.blocks[2].text);
  assert.deepEqual(validateReportReadable(result.value, raw).value, result.value, 'stored text is idempotently rechecked');
  assert.equal(raw.blocks.map(block => block.text).join(''), raw.text);
});

test('new quantities and explicit negative-to-positive states restore originals while wording differences remain reviewable', () => {
  for (const replacement of ['本地修改 8 处，[[0]] 保持不变，尚未推送。', '本地修改 2 处，[[0]] 保持不变，已经推送。']) {
    const parsed = parseReportReadable(wire(raw, blocks => blocks.map((block, i) => i === 1 ? { ...block, text: replacement } : block)), raw);
    assert.equal(parsed.ok, true); assert.equal(parsed.value.blocks[1].text, raw.blocks[1].text);
    assert.ok(parsed.warnings.some(item => item.path === '$.blocks[1].text'));
  }
  const parsed = parseReportReadable(wire(raw, blocks => blocks.map((block, i) => i === 0
    ? { ...block, text: '初始化完成；失败任务未重试，会恢复。' } : block)), raw);
  assert.equal(parsed.value.blocks[0].text, '初始化完成；失败任务未重试，会恢复。');
  assert.ok(parsed.warnings.some(note => note.code === 'readable-wording-review'));
});

test('missing technical literals retain originals while complete literal sets can change prose order', () => {
  const original = source('使用 `a.yml` 与 `b.yml`；检查尚未通过。\n\n另有一个结果。');
  for (const text of ['使用 [[0]]；检查尚未通过。', '使用 [[2]]；检查尚未通过。']) {
    const parsed = parseReportReadable(wire(original, blocks => [{ ...blocks[0], text }, blocks[1]]), original);
    assert.equal(parsed.ok, true); assert.equal(parsed.value.blocks[0].text, original.blocks[0].text);
  }
  const reordered = parseReportReadable(wire(original, blocks => [{ ...blocks[0], text: '使用 [[1]] 与 [[0]]；检查尚未通过。' }, blocks[1]]), original);
  assert.equal(reordered.value.blocks[0].text, '使用 `b.yml` 与 `a.yml`；检查尚未通过。');
});

test('normalization restores source order and fills missing or ambiguous blocks without accepting executable surfaces', () => {
  for (const edit of [blocks => blocks.slice(1), blocks => blocks.reverse(), blocks => blocks.map(block => ({ ...block, ref: 'b1' }))]) {
    const parsed = parseReportReadable(wire(raw, edit), raw);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.value.blocks.map(block => block.ref), raw.blocks.map(block => block.id));
    assert.deepEqual(parsed.value.blocks.map(block => block.text.trim()), raw.blocks.map(block => block.text.trim()));
  }
  const bad = parseReportReadable(wire(raw, blocks => [{ ...blocks[0], text: '<script>alert(1)</script>' }, ...blocks.slice(1)]), raw);
  assert.equal(bad.ok, true); assert.equal(bad.value.blocks[0].text, raw.blocks[0].text);
  for (const link of ['[详情](javascript:alert())', '[详情](data:text/html,hi)', '[详情](other.md)']) {
    const parsed = parseReportReadable(wire(raw, blocks => [{ ...blocks[0], text: blocks[0].text + link }, ...blocks.slice(1)]), raw);
    assert.equal(parsed.value.blocks[0].text, raw.blocks[0].text);
  }
  assert.equal(parseReportReadable('{"schemaVersion":3,"schemaVersion":3,"blocks":[]}', raw).issue.code, 'json-duplicate-key');
  assert.equal(parseReportReadable(wire(raw).replace('"schemaVersion":3', '"schemaVersion":3,"execute":"run"'), raw).ok, false);
});

test('lists can normalize harmless formatting while code and tables stay verbatim', () => {
  const input = source('# 验证结果\n\n- 修改已完成。\n- 客户端尚未验证。\n\n| 检查 | 结果 |\n| --- | --- |\n| 测试 | 通过 |');
  const result = parseReportReadable(wire(input, blocks => blocks.map((block, i) => ({ ...block, text: i === 1
    ? '+ 修改已完成。\n+ 客户端尚未验证。' : i === 2 ? '| 检查 | 已上线 |' : block.text }))), input);
  assert.equal(result.ok, true);
  assert.equal(result.value.blocks[0].text.trim(), input.blocks[0].text.trim());
  assert.match(result.value.blocks[1].text, /^\+ 修改已完成/);
  assert.equal(result.value.blocks[2].text, input.blocks[2].text);
  assert.ok(result.warnings.some(note => note.code === 'readable-wording-review'));
});

test('complete JSON fences, omitted versions and source-aware aliases normalize without another call', () => {
  const expected = JSON.parse(wire(raw));
  for (const candidate of [
    '```json\n' + JSON.stringify(expected) + '\n```',
    JSON.stringify({ blocks: expected.blocks }),
    JSON.stringify({ schemaVersion: '3', blocks: expected.blocks }),
    JSON.stringify(expected.blocks),
    JSON.stringify({ blocks: expected.blocks.map(({ ref, text }) => ({ blockId: ref, content: text, kind: 'text', verbatim: false })) }),
  ]) {
    const parsed = parseReportReadable(candidate, raw);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.value.blocks.map(block => block.text.trim()), raw.blocks.map(block => block.text.trim()));
    assert.ok(parsed.warnings.some(note => note.code === 'readable-format-normalized'));
    assert.deepEqual(validateReportReadable(parsed.value, raw).value, parsed.value);
  }
});

test('unknown references cannot replace source paragraphs and explicit hashes cannot cross reports', () => {
  const original = JSON.parse(wire(raw));
  original.blocks[1] = { ref: 'foreign-b1', text: '其他报告的文字' };
  const parsed = parseReportReadable(JSON.stringify(original), raw);
  assert.equal(parsed.ok, true); assert.equal(parsed.value.blocks[1].text, raw.blocks[1].text);
  assert.equal(parseReportReadable(JSON.stringify({ schemaVersion: 3, blocks: [{ ref: 'foreign-b1', text: '其他报告的文字' }] }), raw).ok, false);
  assert.equal(parseReportReadable(JSON.stringify({ ...original, sourceHash: '0'.repeat(64) }), raw).ok, false);
});

test('benign condition wording and repeated equivalent numeric wording no longer discard the paragraph', () => {
  const original = source('验证失败时立即停止。\n\n离线检查12/12通过。');
  const parsed = parseReportReadable(wire(original, blocks => blocks.map((block, i) => ({ ...block,
    text: i === 0 ? '如果验证失败，应立即停止。' : '12项都通过了，离线检查结果是12/12。' }))), original);
  assert.equal(parsed.ok, true); assert.match(parsed.value.blocks[0].text, /^如果/);
  assert.match(parsed.value.blocks[1].text, /^12项/);
  assert.ok(parsed.warnings.some(note => note.code === 'readable-wording-review'));
});

test('malformed, oversized or substituted sources cannot become a partial readable report', () => {
  assert.equal(parseReportReadable('{', raw).ok, false);
  assert.equal(parseReportReadable('x'.repeat(80001), raw).issue.code, 'wire-too-long');
  assert.equal(parseReportReadable(wire(raw), { ...raw, hash: '0'.repeat(64) }).ok, false);
  assert.throws(() => buildReportReadablePrompt({ ...raw, blocks: [] }), /invalid-report-source/);
});
