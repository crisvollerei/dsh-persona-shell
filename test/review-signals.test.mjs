import test from 'node:test';
import assert from 'node:assert/strict';
import { assessRewrite, restoreReview } from '../lib/review.js';
import { mask, unmask } from '../lib/mask.js';

const assess = (original, candidate) => assessRewrite({ original, candidate, maskedOriginal: original, maskedCandidate: candidate });

test('local completed-work polarity cannot be cancelled by discourse or a different predicate', () => {
  for (const [original, candidate] of [
    ['尚未发布。', '已经发布，不过检查通过。'],
    ['尚未发布，检查已通过。', '已经发布，检查未通过。'],
    ['尚未正式导入。', '已经正式导入。'],
    ['检查尚未通过。', '检查通过。'],
    ['已经部署。', '还没有部署。'],
  ]) {
    const result = assess(original, candidate);
    assert.ok(result.reasons.includes('negation-change'), `${original} -> ${candidate}`);
    assert.deepEqual(result.criticalReasons, ['negation-change']);
    assert.deepEqual(restoreReview(result), result);
  }
});

test('colloquial negatives and equivalent status wording are not critical changes', () => {
  for (const [original, candidate] of [
    ['尚未发布。', '还没有发布。'],
    ['已经发布。', '发布了。'],
    ['检查已经通过。', '检查已经通过，不过先歇会儿。'],
    ['已经发布。', '已经发布，不好意思来晚了。'],
    ['报告已完成。', '报告已完成，不仅如此，说明也写好了。'],
  ]) {
    const result = assess(original, candidate);
    assert.ok(!result.reasons.includes('negation-change'), `${original} -> ${candidate}`);
    assert.equal(result.criticalReasons, undefined);
  }
  for (const [original, candidate] of [
    ['并不复杂。', '很简单。'],
    ['不可以删除备份。', '可以删除备份。'],
    ['检查通过。', '检查通不过。'],
    ['材料光滑。', '材料不光滑。'],
    ['会错过提醒。', '不错过提醒。'],
  ]) {
    const result = assess(original, candidate);
    assert.ok(result.reasons.includes('negation-change'));
    assert.equal(result.criticalReasons, undefined, 'a changed negation count alone is only a soft hint');
  }
});

test('conditional or ambiguous repeated predicates are not assigned a strong polarity verdict', () => {
  for (const [original, candidate] of [
    ['如果已经发布，就检查版本。', '如果尚未发布，就检查版本。'],
    ['可能已经发布。', '尚未发布。'],
    ['预计已经发布。', '尚未发布。'],
    ['需要确认已经发布。', '尚未发布。'],
    ['已经发布的话，先检查。', '尚未发布的话，先检查。'],
    ['甲尚未发布，乙已经发布。', '乙已经发布，甲尚未发布。'],
  ]) assert.equal(assess(original, candidate).criticalReasons, undefined, `${original} -> ${candidate}`);
});

test('only exposed prose quantities and local statuses contribute critical reasons', () => {
  const quantity = assess('修了 2 处，尚未发布。', '修了 3 处，已经发布。');
  assert.deepEqual(quantity.criticalReasons, ['negation-change', 'quantity-change']);
  assert.ok(quantity.criticalReasons.every(reason => quantity.reasons.includes(reason)));
  const original = '原话是 `尚未发布，数量2`。报告已完成。';
  const shielded = mask(original);
  const maskedCandidate = '原话是 [[0]]。报告已经完成啦。';
  const candidate = unmask(maskedCandidate, shielded.literals);
  const result = assessRewrite({ original, candidate, maskedOriginal: shielded.masked, maskedCandidate });
  assert.equal(result.criticalReasons, undefined);
  assert.deepEqual(result.reasons, []);
});

test('review restore keeps legacy rows and strictly bounds optional critical reasons', () => {
  const legacy = assess('检查好了。', '检查完成啦。');
  assert.equal('criticalReasons' in legacy, false);
  assert.deepEqual(restoreReview(legacy), legacy);
  const quantity = assess('有 2 项。', '有 3 项。');
  assert.deepEqual(restoreReview(quantity), quantity);
  for (const criticalReasons of [null, 'quantity-change', [1], ['unknown'], ['literal-order'], ['negation-change']]) {
    assert.equal(restoreReview({ ...quantity, criticalReasons }), undefined, JSON.stringify(criticalReasons));
  }
  assert.equal(restoreReview({ ...quantity, reasons: [], criticalReasons: ['quantity-change'] }), undefined, 'a claimed critical reason must also be a normal reason');
  assert.deepEqual(restoreReview({ ...legacy, criticalReasons: [] }), { ...legacy, criticalReasons: [] });
});
