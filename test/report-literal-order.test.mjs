import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { mask, unmask } from '../lib/mask.js';
import { assessRewrite, restoreReview } from '../lib/review.js';
import { validateRewrite } from '../lib/prompt.js';
import { parseReportReadable, validateReportReadable } from '../lib/report-readable.js';
import { makeReportSource } from '../lib/report-visualization.js';

const stepText = '先在副本上执行 `layout-check --copy`，核准后再运行 `layout-export`。';
const swapped = '先在副本上执行 [[1]]，核准后再运行 [[0]]。';
const source = text => makeReportSource({ sessionId: 'order', seq: 2, text });
const form = passages => ({ schemaVersion: 3, blocks: passages.map((text, i) => ({ ref: 'b' + (i + 1), text })) });

function clientHint() {
  let module;
  vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load(definition) { module = definition; } } }, setTimeout, clearTimeout, AbortController, URLSearchParams,
  });
  return module.factory(id => {
    if (id === 'react' || id === 'react-dom') return {};
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return { Modal() {}, MarkdownText() {} };
    throw Error(id);
  }).__testing.reviewNeeded;
}

test('formal report flags swapped commands even with zero prose edits; moving intact clauses is still allowed', () => {
  const { masked, literals } = mask(stepText), needsReview = clientHint();
  for (const candidate of [swapped, '核准后再运行 [[1]]。此前先在副本上执行 [[0]]。']) {
    const checked = validateRewrite({ candidate, original: masked, literalCount: literals.length, maxRatio: 1.8 });
    assert.equal(checked.ok, true, 'formal narration may change the order in which it explains intact steps');
    const text = unmask(checked.text, literals);
    const review = restoreReview(assessRewrite({ original: stepText, candidate: text, maskedOriginal: masked, maskedCandidate: checked.text }));
    const row = { status: 'ready', text, review };
    assert.ok(review.reasons.includes('literal-order'));
    if (candidate === swapped) assert.equal(review.editScore, 0);
    assert.equal(needsReview(row, stepText, { reviewThreshold: 1 }), true);
    assert.equal(needsReview(row, stepText, { reviewHints: false }), false);
    assert.equal(needsReview(row, stepText + '来源已变。', {}), false);
  }
});

test('smooth reading restores a reordered operation locally, including an old unmasked draft', () => {
  const raw = source(stepText + '\n\n附录已经整理。');
  const decoded = unmask(swapped, mask(stepText).literals), other = '附录已经整理好了。';
  for (const checked of [parseReportReadable(JSON.stringify(form([swapped, other])), raw),
    validateReportReadable(form([decoded, other]), raw)]) {
    assert.equal(checked.ok, true); assert.equal(checked.value.blocks[0].text, raw.blocks[0].text);
    assert.equal(checked.value.blocks[1].text, other);
    assert.deepEqual(checked.warnings, [{ code: 'readable-block-original', path: '$.blocks[0].text' }]);
  }
  const valid = '先在副本上执行 [[0]]。得到核准后，再运行 [[1]]。';
  assert.equal(parseReportReadable(JSON.stringify(form([valid, other])), raw).value.blocks[0].text, unmask(valid, mask(stepText).literals));
  assert.equal(parseReportReadable(JSON.stringify(form([swapped])), source(stepText), { replacingDraft: true }).issue?.code, 'readable-all-fallback');
});

test('a coordinated list can be rephrased with a review hint, but an explicitly ordered list cannot be reversed', () => {
  for (const [prefix, ordered] of [['使用 ', false], ['依次使用 ', true]]) {
    const original = prefix + '`a.yml` 与 `b.yml`；检查尚未通过。';
    const candidate = prefix + '[[1]] 与 [[0]]；检查尚未通过。';
    const checked = parseReportReadable(JSON.stringify(form([candidate])), source(original));
    assert.equal(checked.value.blocks[0].text, ordered ? original : unmask(candidate, mask(original).literals));
    assert.deepEqual(checked.warnings, [{ code: ordered ? 'readable-block-original' : 'readable-wording-review', path: '$.blocks[0].text' }]);
  }
});
