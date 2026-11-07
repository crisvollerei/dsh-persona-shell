import test from 'node:test';
import assert from 'node:assert/strict';
import { createStructuredMemory, MEMORY_LIMITS } from '../lib/structured-memory.js';
const ctx = { personaId: 'whale', sessionId: 's' };
const add = (m, content, extra = {}) => m.mutate({ action: 'add', entry: {
  kind: 'preference', scope: 'persona', personaId: 'whale', content, ...extra } });
const propose = (m, e, operation = 'revise', extra = {}) => m.mutate({ action: 'propose',
  id: e.id, version: e.version, operation, content: '把必要的条件讲清楚', statement: '  以前要求精简，现在请把必要条件讲清楚。\n不是让你省略风险。  ', ...extra });
const confirm = (m, op) => m.mutate({ action: 'confirm', id: op.id, version: op.version });
const observe = (m, text, seq = 1, extra = {}) => m.observe({ ...ctx, text, seq, ...extra });

test('correction waits for confirmation, preserves both original evidence and exact new owner statement', () => {
  const m = createStructuredMemory(); const e = add(m, '简洁一点'); const op = propose(m, e);
  assert.equal(m.select(ctx)[0].content, '简洁一点');
  assert.equal(op.evidence[0].quote, '  以前要求精简，现在请把必要条件讲清楚。\n不是让你省略风险。  ');
  assert.equal(op.evidence[0].source, 'settings');
  const applied = confirm(m, op); const selected = m.select(ctx)[0];
  assert.equal(selected.content, '把必要的条件讲清楚'); assert.equal(selected.replaces, e.id);
  assert.equal(selected.key, e.key); assert.equal(selected.personaId, 'whale');
  assert.equal(selected.evidence[0].quote, op.evidence[0].quote);
  assert.equal(m.snapshot().entries[0].evidence[0].quote, '简洁一点');
  assert.equal(applied.resultId, selected.id); assert.equal(m.references([{ id: e.id, version: 1 }], ctx).length, 0);
});

test('retract invalidates exactly the target without a replacement, inverse preference, or revival', () => {
  const m = createStructuredMemory(); const old = add(m, '先前的称呼');
  const current = add(m, '后来的称呼', { key: old.key });
  const op = propose(m, current, 'retract', { content: '不得拿这个伪造替代项' });
  confirm(m, op);
  assert.deepEqual(m.select(ctx), []);
  assert.equal(m.snapshot().entries.length, 2);
  assert.equal(m.snapshot().entries.find((e) => e.id === current.id).status, 'retracted');
  assert.equal(m.snapshot().entries.find((e) => e.id === old.id).status, 'superseded');
  assert.equal(m.snapshot().operations[0].content, null);
});

test('caller-supplied scope and identity cannot turn a private correction into shared memory', () => {
  const m = createStructuredMemory(); const e = add(m, '鲸鲸的约定', { kind: 'agreement' });
  const op = propose(m, e, 'revise', { scope: 'shared', personaId: 'dragon', sessionId: 'other' });
  confirm(m, op);
  assert.equal(m.select(ctx)[0].scope, 'persona'); assert.deepEqual(m.select({ ...ctx, personaId: 'dragon' }), []);
});

test('session correction retains persona, lifetime and session, and cannot extend an expired record', () => {
  let now = 10; const m = createStructuredMemory({ now: () => now });
  const e = add(m, '今晚用严肃语气', { scope: 'session', sessionId: 's', expiresAt: 100 });
  const op = propose(m, e); confirm(m, op);
  assert.equal(m.select(ctx)[0].expiresAt, 100);
  assert.deepEqual(m.select({ ...ctx, personaId: 'dragon' }), []);
  assert.deepEqual(m.select({ ...ctx, sessionId: 'elsewhere' }), []);
  const another = propose(m, m.select(ctx)[0], 'retract'); now = 100;
  assert.throws(() => confirm(m, another), /conflict/);
});

test('repeated successful confirmation after restart is idempotent and does not add records', () => {
  const m = createStructuredMemory(); const e = add(m, '原偏好'); const op = propose(m, e); const result = confirm(m, op);
  const restarted = createStructuredMemory(); restarted.restore(m.snapshot());
  assert.deepEqual(confirm(restarted, op), result);
  assert.equal(restarted.snapshot().entries.length, 2);
  assert.equal(restarted.snapshot().operations[0].status, 'applied');
});

test('pending review survives restart; missing or blank statement is refused without changing the target', () => {
  const m = createStructuredMemory(); const e = add(m, '原偏好');
  assert.throws(() => propose(m, e, 'retract', { statement: ' \n ' }), /statement-required/);
  const op = propose(m, e); const restarted = createStructuredMemory(); restarted.restore(m.snapshot());
  assert.deepEqual(restarted.snapshot().operations[0], op); confirm(restarted, op);
  assert.equal(restarted.select(ctx)[0].content, op.content);
});

test('rejecting a proposal leaves old evidence and prompt selection unchanged', () => {
  const m = createStructuredMemory(); const e = add(m, '原偏好'); const op = propose(m, e);
  m.mutate({ action: 'dismiss', id: op.id, version: 1 });
  assert.deepEqual(m.select(ctx), [e]); assert.throws(() => confirm(m, op), /conflict/);
});

test('a competing edit or retraction cannot be overwritten by a stale review', () => {
  const m = createStructuredMemory(); const e = add(m, '原偏好'); const first = propose(m, e);
  const second = propose(m, e, 'retract', { statement: '这条不要了' }); confirm(m, second);
  assert.throws(() => confirm(m, first), /conflict/); assert.deepEqual(m.select(ctx), []);
});

test('candidate adoption previews affected records and refuses an unseen competing change', () => {
  const m = createStructuredMemory(); const e = add(m, '语气要轻松'); observe(m, '我想换一种正式的口吻');
  const batch = m.batch(); m.commit(batch, [{ kind: 'preference', scope: 'persona', content: '语气要正式',
    evidence: [{ eventId: 's:1', quote: '正式' }] }]);
  const candidate = m.snapshot().entries.find((x) => x.status === 'candidate');
  const op = m.mutate({ action: 'propose', operation: 'accept', id: candidate.id, version: candidate.version });
  assert.deepEqual(op.conflicts, [{ id: e.id, version: e.version }]);
  add(m, '语气要克制'); assert.throws(() => confirm(m, op), /conflict/);
  assert.equal(m.select(ctx)[0].content, '语气要克制');
});

test('model correction uses the whole real user source, keeping negation, and remains a suggestion', () => {
  const m = createStructuredMemory(); const e = add(m, '旧的约定');
  const raw = '不是要你更简短，而是必要条件必须讲明白，数值 25 也不能漏掉。'; observe(m, raw);
  const batch = m.batch(); assert.equal(batch.targets[0].id, e.id);
  m.commit(batch, [{ operation: 'revise', target: { id: e.id, version: 1 }, content: '保留解释和条件',
    evidence: [{ eventId: 's:1', quote: '必要条件必须讲明白' }] }]);
  const op = m.snapshot().operations[0]; assert.equal(op.evidence[0].quote, raw);
  assert.equal(m.select(ctx)[0].id, e.id); confirm(m, op); assert.equal(m.select(ctx)[0].content, '保留解释和条件');
});

test('model withdrawal cannot cite fabricated, partial-filtered, ambiguous or other-persona evidence', () => {
  for (const scenario of ['fake', 'filtered', 'ambiguous', 'other-persona']) {
    const m = createStructuredMemory(); const e = add(m, '旧的约定', scenario === 'other-persona' ? { personaId: 'dragon' } : {});
    observe(m, scenario === 'filtered' ? '不要记 `old_setting` 里的这个约定' : scenario === 'ambiguous' ? '别记了，别记了' : '这条不再适用');
    const batch = m.batch();
    assert.throws(() => m.commit(batch, [{ operation: 'retract', target: { id: e.id, version: 1 },
      evidence: [{ eventId: scenario === 'fake' ? 'made-up' : 's:1',
        quote: scenario === 'ambiguous' ? '别记了' : batch.sources[0].text }] }]), /evidence|target/, scenario);
    assert.equal(m.snapshot().operations.length, 0); assert.equal(m.snapshot().queue.length, 1);
  }
});

test('background target list never exposes another persona, other session, shared or episode records', () => {
  const m = createStructuredMemory(); const e = add(m, '本人格的约定');
  add(m, '另一个人格', { personaId: 'dragon' }); add(m, '共享', { scope: 'shared' });
  add(m, '其他会话', { scope: 'session', sessionId: 'other' }); add(m, '共同经历', { kind: 'episode' });
  observe(m, '不用记那件事了'); assert.deepEqual(m.batch().targets.map((e) => e.id), [e.id]);
});

test('a confirmed withdrawal discards queued old sources and invalidates late extraction', () => {
  const m = createStructuredMemory(); observe(m, '简洁一点'); const e = m.select(ctx)[0]; const oldBatch = m.batch();
  const op = propose(m, e, 'retract'); confirm(m, op);
  assert.equal(m.snapshot().queue.length, 0);
  assert.equal(m.commit(oldBatch, [{ kind: 'preference', scope: 'persona', content: '简洁一点',
    evidence: [{ eventId: 's:1', quote: '简洁一点' }] }]), false);
  assert.equal(observe(m, '简洁一点', 1), false); assert.equal(observe(m, '简洁一点', 2), true);
  assert.equal(m.select(ctx).length, 1, 'a new deliberate user request can establish a new preference');
});

test('malformed restored reviews cannot crash the settings view or activate a correction', () => {
  const m = createStructuredMemory(); const e = add(m, '旧记录'); const op = propose(m, e); const raw = m.snapshot();
  raw.operations.push({ ...op, id: 'bad-target', target: null }, { ...op, id: 'bad-refs', conflicts: 'oops' });
  const next = createStructuredMemory(); next.restore(raw); assert.equal(next.snapshot().operations.length, 1);
  assert.equal(next.select(ctx)[0].content, '旧记录');
});

test('clear and deletion remove review evidence, while a pin keeps the original source intact', () => {
  const m = createStructuredMemory(); const e = add(m, '旧记录'); const op = propose(m, e);
  const pinned = m.mutate({ action: 'pin', id: e.id, version: 1, pinned: true });
  assert.deepEqual(pinned.evidence, e.evidence); assert.throws(() => confirm(m, op), /conflict/);
  m.mutate({ action: 'delete', id: e.id, version: pinned.version }); assert.equal(m.snapshot().operations.length, 0);
  const next = add(m, '另一个记录'); propose(m, next); m.clear(); assert.equal(m.snapshot().operations.length, 0);
});

test('review capacity is bounded and failed allocation leaves the original record intact', () => {
  const m = createStructuredMemory(); const e = add(m, '旧记录');
  for (let i = 0; i < MEMORY_LIMITS.operations; i++) propose(m, e, 'revise', { statement: '说明' + i });
  assert.throws(() => propose(m, e, 'retract'), /operation-capacity/);
  assert.equal(m.snapshot().operations.length, MEMORY_LIMITS.operations); assert.equal(m.select(ctx)[0].id, e.id);
});

test('withdrawing old evidence also invalidates an unadopted candidate derived from that evidence', () => {
  const m = createStructuredMemory(); observe(m, '简洁一点'); const entry = m.select(ctx)[0]; const batch = m.batch();
  m.commit(batch, [{ kind: 'preference', scope: 'persona', content: '倾向简洁表达',
    evidence: [{ eventId: 's:1', quote: '简洁一点' }] }]);
  const op = propose(m, entry, 'retract'); confirm(m, op);
  assert.equal(m.snapshot().entries.find((e) => e.origin === 'model').status, 'rejected');
  assert.deepEqual(m.select(ctx), []);
});

test('preparing a new manual record never changes active preferences before adoption', () => {
  const m = createStructuredMemory(); const entry = add(m, '语气要轻松');
  const op = m.mutate({ action: 'propose-add', entry: { kind: 'preference', scope: 'persona', personaId: 'whale', content: '语气要严肃' } });
  assert.equal(op.kind, 'accept'); assert.deepEqual(op.conflicts, [{ id: entry.id, version: 1 }]);
  assert.equal(m.select(ctx)[0].content, entry.content); confirm(m, op);
  assert.equal(m.select(ctx)[0].content, '语气要严肃');
});

test('multiple locators in the same real message produce one complete source, not repeated evidence', () => {
  const m = createStructuredMemory(); const e = add(m, '原记录');
  observe(m, '这条不要记了，我明确撤销。'); const batch = m.batch();
  m.commit(batch, [{ operation: 'retract', target: { id: e.id, version: 1 }, evidence: [
    { eventId: 's:1', quote: '不要记了' }, { eventId: 's:1', quote: '明确撤销' } ] }]);
  assert.equal(m.snapshot().operations[0].evidence.length, 1);
  assert.equal(m.snapshot().operations[0].evidence[0].quote, '这条不要记了，我明确撤销。');
});

test('raw whitespace also counts toward the evidence limit without silently trimming the original', () => {
  const m = createStructuredMemory(); const e = add(m, '原记录');
  assert.throws(() => propose(m, e, 'retract', { statement: ' '.repeat(MEMORY_LIMITS.sourceText) + '撤销' }), /statement-required/);
  assert.equal(m.snapshot().operations.length, 0);
});
