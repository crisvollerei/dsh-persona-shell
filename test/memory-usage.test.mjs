import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryUsage, MEMORY_USAGE_LIMIT } from '../lib/memory-usage.js';
import { createStructuredMemory } from '../lib/structured-memory.js';
import { buildRewritePrompt } from '../lib/prompt.js';
import { buildProgressPrompt } from '../lib/progress.js';
import { DEFAULT_PACK } from '../lib/pack.js';
const context = { personaId: 'whale', sessionId: 's' };
const add = (memory, content, extra = {}) => memory.mutate({ action: 'add', entry: {
  kind: 'preference', scope: 'persona', personaId: 'whale', content, ...extra } });
const attempt = (usage, channel = 'report') => usage.begin({ ...context, channel,
  selection: { entries: [{ id: 'one', version: 1, content: 'never copy this text' }], omitted: [] } });

test('usage records distinguish selection from SDK dispatch and never copy prompts, text or evidence', () => {
  let now = 100; const usage = createMemoryUsage({ now: () => now }); const handle = attempt(usage);
  assert.equal(usage.snapshot().records[0].sentAt, null); now = 200; handle.sent(); now = 300; handle.sent();
  handle.finish('generated'); const record = usage.snapshot().records[0];
  assert.equal(record.sentAt, 200); assert.equal(record.endedAt, 300); assert.equal(record.outcome, 'generated');
  assert.deepEqual(record.selected, [{ id: 'one', version: 1 }]);
  assert.doesNotMatch(JSON.stringify(usage.snapshot()), /never copy|content|evidence|system|messages/);
  handle.finish('failed'); assert.equal(usage.snapshot().records[0].outcome, 'generated');
});

test('failed preparation, cancelled generation and restarted attempts stay distinct', () => {
  const usage = createMemoryUsage(); const neverSent = attempt(usage); neverSent.finish('failed');
  const sent = attempt(usage, 'progress'); sent.sent(); sent.finish('cancelled'); attempt(usage, 'process');
  const next = createMemoryUsage(); next.restore(usage.snapshot());
  assert.deepEqual(next.snapshot().records.map((r) => [r.sentAt !== null, r.outcome]), [
    [false, 'failed'], [true, 'cancelled'], [false, 'interrupted'] ]);
});

test('clear retires old handles so a late dispatch or completion cannot resurrect usage', () => {
  const usage = createMemoryUsage(); const handle = attempt(usage); usage.clear(); handle.sent(); handle.finish('generated');
  assert.deepEqual(usage.snapshot().records, []);
  const next = createMemoryUsage(); next.restore({ ...usage.snapshot(), records: [{ secrets: 'bad' }] });
  assert.deepEqual(next.snapshot().records, []);
});

test('usage is bounded and handles evicted from the recent window cannot reappear', () => {
  const usage = createMemoryUsage(); const old = attempt(usage);
  for (let i = 0; i < MEMORY_USAGE_LIMIT; i++) attempt(usage);
  old.sent(); old.finish('generated'); assert.equal(usage.snapshot().records.length, MEMORY_USAGE_LIMIT);
  assert.ok(usage.snapshot().records.every((r) => r.sentAt === null));
});

test('restoration strips arbitrary extra fields and rejects malformed reference/state data', () => {
  const usage = createMemoryUsage(); attempt(usage).sent(); const raw = usage.snapshot();
  raw.records[0].prompt = 'PRIVATE'; raw.records[0].selected[0].content = 'PRIVATE';
  raw.records.push({ ...raw.records[0], id: 'bad-channel', channel: 'memory-consolidation' },
    { ...raw.records[0], id: 'bad-ref', selected: [{ id: 'one', version: -1 }] });
  const next = createMemoryUsage(); next.restore(raw);
  assert.equal(next.snapshot().records.length, 1); assert.doesNotMatch(JSON.stringify(next.snapshot()), /PRIVATE/);
});

test('selection explains omitted current-scope records without exposing other personas or sessions', () => {
  const memory = createStructuredMemory({ now: () => 100 });
  const shared = add(memory, '所有角色用中文', { scope: 'shared' });
  const own = add(memory, '请用中文', { key: shared.key });
  const privateOther = add(memory, 'DRAGON_PRIVATE', { personaId: 'dragon' });
  const sessionOther = add(memory, 'OTHER_SESSION', { scope: 'session', sessionId: 'other' });
  const episode = add(memory, '共同经历', { kind: 'episode' });
  const temporary = add(memory, '临时语气', { scope: 'session', sessionId: 's', expiresAt: 101 });
  const raw = memory.snapshot(); raw.entries.find((e) => e.id === temporary.id).expiresAt = 100;
  memory.restore(raw);
  const plan = memory.selection(context);
  assert.deepEqual(plan.entries.map((e) => e.id), [own.id]);
  assert.equal(plan.omitted.find((e) => e.id === shared.id).reason, 'overridden');
  assert.equal(plan.omitted.find((e) => e.id === episode.id).reason, 'not-expression');
  assert.equal(plan.omitted.find((e) => e.id === temporary.id).reason, 'expired');
  assert.equal(plan.omitted.some((e) => [privateOther.id, sessionOther.id].includes(e.id)), false);
});

test('selection distinguishes count/budget limits from unconfirmed and withdrawn entries', () => {
  const memory = createStructuredMemory(); const withdrawn = add(memory, '旧偏好');
  const op = memory.mutate({ action: 'propose', operation: 'retract', id: withdrawn.id, version: 1, statement: '撤销' });
  memory.mutate({ action: 'confirm', id: op.id, version: 1 });
  const candidate = memory.mutate({ action: 'propose-add', entry: { kind: 'preference', scope: 'persona', personaId: 'whale', content: '候选' } });
  for (let i = 0; i < 7; i++) add(memory, '偏好' + i);
  const plan = memory.selection(context);
  assert.equal(plan.entries.length, 5); assert.equal(plan.omitted.find((e) => e.id === withdrawn.id).reason, 'retracted');
  assert.equal(plan.omitted.find((e) => e.id === candidate.targetId).reason, 'candidate');
  assert.equal(plan.omitted.filter((e) => e.reason === 'limit').length, 2);
  const long = createStructuredMemory(); for (let i = 0; i < 3; i++) add(long, String(i) + '好'.repeat(239));
  assert.equal(long.selection(context).omitted[0].reason, 'budget');
});

test('every expression prompt applies the same active preferences with factual and channel limits intact', () => {
  const prefs = ['不要提醒我休息', '叫我阿晴'];
  const report = buildRewritePrompt({ pack: DEFAULT_PACK, masked: '原汇报', literalCount: 0, history: [], memory: prefs }).system;
  const process = buildRewritePrompt({ pack: DEFAULT_PACK, masked: '原汇报', literalCount: 0, history: [], memory: prefs, processTools: true }).system;
  const progress = buildProgressPrompt(DEFAULT_PACK, '只有运行观测', prefs).system;
  for (const system of [report, process, progress]) {
    assert.ok(system.includes(JSON.stringify(prefs))); assert.match(system, /优先于人格卡/);
    assert.match(system, /只调整称呼和表达/); assert.match(system, /不得据此把历史经历/);
  }
  assert.match(process, /最多 40 个字符/); assert.match(progress, /不超过 180 字/);
  assert.match(report, /不得删除原文中的风险提示/); assert.match(progress, /不得推断任务内容/);
});
