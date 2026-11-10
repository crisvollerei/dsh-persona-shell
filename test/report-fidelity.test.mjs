import test from 'node:test';
import assert from 'node:assert/strict';
import { checkReportFidelity } from '../lib/report-fidelity.js';
import { makeReportSource } from '../lib/report-visualization.js';
import { buildReportReadablePrompt, parseReportReadable } from '../lib/report-readable.js';

test('report quantities preserve occurrences while prose can reorder the same observations', () => {
  assert.equal(checkReportFidelity({ original: '12/12 通过，修改2处。', candidate: '修改2处，12/12 检查通过。' }).ok, true);
  assert.deepEqual(checkReportFidelity({ original: '12/12 通过。', candidate: '12项都通过了，12/12。' }).reasons, ['quantity-change']);
});
test('ordinary workers do not acquire a subagent nickname while explicit relay mappings remain valid', () => {
  const original = '工作助手已调整配置。';
  assert.equal(checkReportFidelity({ original, candidate: '小鲸鲸已经调整配置了。' }).ok, false);
  assert.equal(checkReportFidelity({ original, candidate: '工作助手已经调整配置了。' }).ok, true);
  assert.equal(checkReportFidelity({ original, candidate: '姐姐已经调整配置了。', relay: true, workerLabel: '姐姐' }).ok, true);
  assert.equal(checkReportFidelity({ original, candidate: '小鲸鲸已经调整配置了。', relay: true, workerLabel: '姐姐' }).ok, false);
});
test('a uniquely anchored permission or requirement cannot turn into a promised execution', () => {
  for (const original of ['只有确认后才可关闭演练。', '只有确认后才需关闭演练。']) {
    assert.equal(checkReportFidelity({ original, candidate: '只有确认后才会关闭演练。' }).ok, false);
    assert.equal(checkReportFidelity({ original, candidate: '只有确认后，会关闭演练。' }).ok, false);
    assert.equal(checkReportFidelity({ original, candidate: '只有确认后会去关掉演练。' }).ok, false);
  }
  assert.equal(checkReportFidelity({ original: '只有确认后才可关闭演练。', candidate: '只有确认后才可以关闭演练。' }).ok, true);
  assert.equal(checkReportFidelity({ original: '只有确认后才可关闭写入端。', candidate: '只有确认后才会去关掉写入端。' }).ok, false);
  assert.equal(checkReportFidelity({ original: '确认之后才会关闭演练。', candidate: '确认之后才会关闭演练。' }).ok, true);
});
test('readable output falls back at the original permission and worker boundary', () => {
  const source = makeReportSource({ sessionId: 's', seq: 1, text: '只有确认后才可关闭演练。\n\n工作助手已调整配置。' });
  const request = JSON.parse(buildReportReadablePrompt(source).user);
  const candidate = { schemaVersion: 3, blocks: request.source.blocks.map(({ ref, text }, i) => ({ ref,
    text: i === 0 ? text.replace('才可', '才会') : text.replace('工作助手', '小鲸鲸') })) };
  const result = parseReportReadable(JSON.stringify(candidate), source);
  assert.equal(result.ok, true); assert.deepEqual(result.value.blocks.map(block => block.text), source.blocks.map(block => block.text));
});
