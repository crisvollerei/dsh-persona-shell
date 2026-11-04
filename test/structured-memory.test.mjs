import test from 'node:test';
import assert from 'node:assert/strict';
import { createStructuredMemory, MEMORY_LIMITS } from '../lib/structured-memory.js';

const context = { personaId: 'whale', sessionId: 'main' };
const add = (m, content, extra = {}) => m.mutate({ action: 'add', entry: {
  kind: 'preference', scope: 'persona', personaId: 'whale', content, ...extra,
} });
const observe = (m, text, seq = 1, extra = {}) => m.observe({ ...context, seq, text, ...extra });
const candidate = (m, content = '喜欢先说明结论') => {
  const batch = m.batch();
  return { batch, entries: [{ kind: 'preference', scope: 'persona', content,
    evidence: [{ eventId: batch.sources[0].id, quote: batch.sources[0].text }] }] };
};

test('shared preferences cross personas, private and session memories retain their boundaries', () => {
  const m = createStructuredMemory();
  add(m, '所有人都用中文', { scope: 'shared', personaId: null });
  add(m, '可以轻微吐槽');
  add(m, '这次简短', { scope: 'session', sessionId: 'main' });
  assert.deepEqual(m.select(context).map((e) => e.content), ['这次简短', '可以轻微吐槽', '所有人都用中文']);
  assert.deepEqual(m.select({ personaId: 'dragon', sessionId: 'main' }).map((e) => e.content), ['所有人都用中文']);
  assert.deepEqual(m.select({ personaId: 'whale', sessionId: 'elsewhere' }).map((e) => e.content), ['可以轻微吐槽', '所有人都用中文']);
});

test('a temporary correction overrides a permanent preference only in its own session and lifetime', () => {
  let clock = 100;
  const m = createStructuredMemory({ now: () => clock });
  observe(m, '汇报太长了，简洁一点');
  observe(m, '这次汇报写得更具体一点', 2);
  assert.match(m.select(context)[0].content, /这次/);
  assert.doesNotMatch(m.select({ ...context, sessionId: 'other' })[0].content, /这次/);
  clock += 86400001;
  assert.doesNotMatch(m.select(context)[0].content, /这次/);
});

test('the latest explicit correction replaces the old one without repeating evidence', () => {
  const m = createStructuredMemory();
  assert.equal(observe(m, '简洁一点'), true);
  assert.equal(observe(m, '简洁一点'), false);
  assert.equal(m.snapshot().sources.length, 1);
  observe(m, '汇报写得更具体一点', 2);
  assert.equal(m.snapshot().entries.filter((e) => e.status === 'active').length, 1);
  assert.equal(m.snapshot().entries[0].status, 'superseded');
});

test('replay is still deduplicated after a restart and after clearing all text', () => {
  const first = createStructuredMemory();
  observe(first, '简洁一点', 5);
  const second = createStructuredMemory();
  second.restore(first.snapshot());
  assert.equal(observe(second, '简洁一点', 5), false);
  second.clear();
  assert.equal(second.snapshot().entries.length, 0);
  assert.equal(second.snapshot().sources.length, 0);
  assert.equal(observe(second, '简洁一点', 5), false);
  assert.equal(observe(second, '语气要轻松', 6), true);
});

test('explicit local capture need not enroll excerpts for model processing', () => {
  const m = createStructuredMemory();
  observe(m, '简洁一点', 1, { queue: false });
  assert.equal(m.select(context).length, 1);
  assert.equal(m.batch().sources.length, 0);
});

test('models cannot activate a candidate or cite an invented source or quote', () => {
  const m = createStructuredMemory(); observe(m, '我更习惯先看结论');
  const value = candidate(m);
  assert.throws(() => m.commit(value.batch, [{ ...value.entries[0], evidence: [{ eventId: 'fake', quote: '结论' }] }]), /evidence/);
  assert.throws(() => m.commit(value.batch, [{ ...value.entries[0],
    evidence: [{ eventId: 'main:1', quote: '不存在的原话' }] }]), /evidence/);
  m.commit(value.batch, value.entries);
  assert.equal(m.select(context).length, 0);
  const entry = m.snapshot().entries[0];
  m.mutate({ action: 'accept', id: entry.id, version: entry.version });
  assert.equal(m.select(context)[0].content, value.entries[0].content);
});

test('an extraction batch cannot mix sources from two personas or sessions', () => {
  const m = createStructuredMemory();
  observe(m, '这段表达我很喜欢');
  observe(m, '不要记成鲸鲸的偏好', 2, { personaId: 'dragon' });
  observe(m, '别的会话内容', 1, { sessionId: 'other' });
  assert.deepEqual(m.batch().sources.map((s) => s.id), ['main:1']);
  const value = candidate(m);
  assert.throws(() => m.commit(value.batch, [{ ...value.entries[0],
    evidence: [{ eventId: 'main:2', quote: '不要记成鲸鲸的偏好' }] }]), /evidence/);
});

test('model candidates cannot silently broaden a private preference to shared scope', () => {
  const m = createStructuredMemory(); observe(m, '别总拿这件事开玩笑');
  const value = candidate(m);
  assert.throws(() => m.commit(value.batch, [{ ...value.entries[0], scope: 'shared' }]), /unproven-shared/);
});

test('new observations do not invalidate a pending batch, but edits, deletes and clear do', () => {
  const m = createStructuredMemory(); observe(m, '我更习惯先看结论');
  const value = candidate(m);
  observe(m, '还有别的新消息', 2);
  assert.equal(m.commit(value.batch, value.entries), true);
  assert.deepEqual(m.snapshot().queue, ['main:2']);
  const pending = candidate(m);
  add(m, '手动确认的偏好');
  assert.equal(m.commit(pending.batch, pending.entries), false);
  const next = candidate(m);
  m.clear();
  assert.equal(m.commit(next.batch, next.entries), false);
});

test('invalid multi-entry batches commit nothing and retain all pending sources', () => {
  const m = createStructuredMemory(); observe(m, '这段说法我喜欢');
  const value = candidate(m);
  assert.throws(() => m.commit(value.batch, [...value.entries, { kind: 'made-up' }]), /proposal/);
  assert.equal(m.snapshot().entries.length, 0);
  assert.equal(m.snapshot().queue.length, 1);
});

test('model-supplied identity and lifetime fields cannot escape local candidate policy', () => {
  const m = createStructuredMemory(); observe(m, '这次说得简短一些');
  const value = candidate(m);
  m.commit(value.batch, [{ ...value.entries[0], scope: 'session', personaId: 'other', sessionId: 'elsewhere',
    expiresAt: null, status: 'active', origin: 'manual', id: 'forged', pinned: true }]);
  const entry = m.snapshot().entries.find((e) => e.origin === 'model');
  assert.equal(entry.status, 'candidate'); assert.equal(entry.personaId, 'whale');
  assert.equal(entry.sessionId, 'main'); assert.notEqual(entry.id, 'forged');
  assert.equal(entry.pinned, false); assert.ok(entry.expiresAt > Date.now());
});

test('deleting a memory removes its pending source so retries cannot resurrect it', () => {
  const m = createStructuredMemory(); observe(m, '简洁一点');
  const value = candidate(m);
  const entry = m.select(context)[0];
  m.mutate({ action: 'delete', id: entry.id, version: entry.version });
  assert.equal(m.snapshot().queue.length, 0);
  assert.equal(m.snapshot().sources.length, 0);
  assert.equal(m.commit(value.batch, value.entries), false);
});

test('stale entry versions cannot overwrite a newer edit', () => {
  const m = createStructuredMemory(); const entry = add(m, '简洁一点');
  m.mutate({ action: 'update', id: entry.id, version: entry.version, content: '语气要自然', pinned: true });
  assert.throws(() => m.mutate({ action: 'delete', id: entry.id, version: entry.version }), /conflict/);
  assert.equal(m.select(context)[0].content, '语气要自然');
});

test('deleting a preference also removes repeated source excerpts that could recreate it', () => {
  const m = createStructuredMemory();
  for (let seq = 1; seq <= 9; seq++) observe(m, '简洁一点', seq);
  const entry = m.select(context)[0];
  m.mutate({ action: 'delete', id: entry.id, version: entry.version });
  assert.equal(m.snapshot().queue.length, 0);
  assert.equal(m.snapshot().sources.length, 0);
  assert.equal(observe(m, '简洁一点', 9), false);
  assert.equal(observe(m, '简洁一点', 10), true, 'a new deliberate request may establish a preference again');
});

test('quoted examples and conditional text do not silently become active preferences', () => {
  const m = createStructuredMemory();
  observe(m, '> 简洁一点');
  observe(m, '比如有人说回答太长了', 2);
  observe(m, '如果语气要轻松就换一个角色', 3);
  assert.equal(m.select(context).length, 0);
});

test('malformed restored tags do not break a rewrite and invalid expiry cannot evict existing memory', () => {
  const m = createStructuredMemory(); add(m, '简洁一点');
  const saved = m.snapshot(); saved.entries[0].tags = 'bad';
  const next = createStructuredMemory(); next.restore(saved);
  assert.equal(next.select(context)[0].content, '简洁一点');
  assert.throws(() => add(next, '新的记忆', { expiresAt: -1 }), /expiry/);
  assert.equal(next.snapshot().entries.length, 1);
});

test('corrupt optional source and handoff records do not block startup restoration', () => {
  const m = createStructuredMemory(); add(m, '简洁一点');
  const raw = m.snapshot();
  raw.sources = [null, {}, 'bad'];
  raw.handoffs = [null, {}, 'bad'];
  const next = createStructuredMemory();
  assert.doesNotThrow(() => next.restore(raw));
  assert.equal(next.select(context)[0].content, '简洁一点');
  assert.deepEqual(next.batch().sources, []);
});

test('episodes are available for future companion context but never injected into report rewrites', () => {
  const m = createStructuredMemory();
  add(m, '上次共同讨论了界面', { kind: 'episode' });
  assert.equal(m.select(context).length, 0);
  assert.equal(m.select({ ...context, purpose: 'companion' }).length, 1);
  assert.throws(() => add(m, '别的角色不能自动继承', { kind: 'episode', scope: 'shared' }), /scope/);
});

test('legacy corrections are preserved as inspectable candidates and migrated only once', () => {
  const m = createStructuredMemory();
  m.migrate({ stated: { whale: ['简洁一点'], dragon: ['语气要轻松'] } });
  m.migrate({ stated: { whale: ['不应再次导入'] } });
  assert.equal(m.snapshot().entries.length, 2);
  assert.equal(m.select(context).length, 0);
  assert.ok(m.snapshot().entries.every((e) => e.origin === 'legacy' && e.status === 'candidate'));
});

test('restoring after a pre-startup clear preserves replay cursors but no memory text', () => {
  const m = createStructuredMemory(); observe(m, '简洁一点', 7);
  const next = createStructuredMemory(); next.restore(m.snapshot(), { clear: true });
  assert.equal(JSON.stringify(next.snapshot()).includes('简洁'), false);
  assert.equal(observe(next, '简洁一点', 7), false);
});

test('selection enforces both entry count and character budgets', () => {
  const m = createStructuredMemory();
  for (let i = 0; i < 12; i++) add(m, String(i) + '偏好'.repeat(50));
  const entries = m.select(context);
  assert.ok(entries.length <= MEMORY_LIMITS.selected);
  assert.ok(entries.reduce((n, e) => n + e.content.length, 0) <= MEMORY_LIMITS.promptChars);
});

test('a handoff references shared records and preserves sender, recipient and session', () => {
  const m = createStructuredMemory();
  const shared = add(m, '所有人格用中文', { scope: 'shared' });
  const scoped = add(m, '这轮先介绍方案', { kind: 'context', scope: 'session', sessionId: 'main', personaId: null });
  const record = m.handoff({ action: 'create', fromPersonaId: 'whale', toPersonaId: 'dragon',
    sessionId: 'main', summary: '用户希望继续讨论记忆方案', memoryIds: [shared.id, scoped.id] });
  assert.equal(record.source, 'owner-authored');
  assert.equal(m.handoffContext(record.id, { personaId: 'dragon', sessionId: 'main' }).memories.length, 2);
  assert.throws(() => m.handoffContext(record.id, context), /not-found/);
  assert.throws(() => m.handoffContext(record.id, { personaId: 'dragon', sessionId: 'other' }), /not-found/);
});

test('private memories cannot be exported implicitly or leaked after a scope change', () => {
  const m = createStructuredMemory();
  const privateEntry = add(m, '只属于鲸鲸的约定');
  assert.throws(() => m.handoff({ action: 'create', fromPersonaId: 'whale', toPersonaId: 'dragon',
    sessionId: 'main', summary: '交接', memoryIds: [privateEntry.id] }), /private-handoff/);
  const shared = add(m, '共同偏好', { scope: 'shared' });
  const handoff = m.handoff({ action: 'create', fromPersonaId: 'whale', toPersonaId: 'dragon',
    sessionId: 'main', summary: '交接', memoryIds: [shared.id] });
  m.mutate({ action: 'update', id: shared.id, version: shared.version, content: shared.content,
    pinned: false, scope: 'persona', personaId: 'whale' });
  assert.equal(m.handoffContext(handoff.id, { personaId: 'dragon', sessionId: 'main' }).memories.length, 0);
});

test('handoff acceptance is idempotent and closing requires a current version', () => {
  const m = createStructuredMemory();
  const record = m.handoff({ action: 'create', fromPersonaId: 'whale', toPersonaId: 'dragon',
    sessionId: 'main', summary: '交接', memoryIds: [] });
  const action = { action: 'accept', id: record.id, personaId: 'dragon', sessionId: 'main', version: 1 };
  const accepted = m.handoff(action);
  assert.deepEqual(m.handoff(action), accepted);
  assert.throws(() => m.handoff({ ...action, action: 'close' }), /conflict/);
  const closed = m.handoff({ ...action, action: 'close', version: accepted.version });
  assert.equal(closed.status, 'closed');
  const next = createStructuredMemory(); next.restore(m.snapshot());
  assert.equal(next.snapshot().handoffs[0].status, 'closed');
});
