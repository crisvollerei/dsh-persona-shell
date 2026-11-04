import test from 'node:test';
import assert from 'node:assert/strict';
import { createStructuredMemory } from '../lib/structured-memory.js';
import { buildMemoryPrompt, createMemoryConsolidator, MEMORY_INTERVAL_MS } from '../lib/memory-consolidation.js';

const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(setImmediate); };
function setup(run, count = 1) {
  const memory = createStructuredMemory(); const timers = new Map(); let nextTimer = 0; let enabled = true;
  for (let i = 1; i <= count; i++) memory.observe({ sessionId: 's', personaId: 'p', seq: i, text: '我更喜欢这种表达' });
  const worker = createMemoryConsolidator({ memory, enabled: () => enabled, run,
    setTimer(fn, ms) { assert.equal(ms, MEMORY_INTERVAL_MS); timers.set(++nextTimer, fn); return nextTimer; },
    clearTimer(id) { timers.delete(id); } });
  return { memory, worker, timers, disable: () => { enabled = false; worker.cancel(); },
    fire() { const [id, fn] = timers.entries().next().value; timers.delete(id); fn(); } };
}

test('sparse buffers wait for the interval; successful batches acknowledge exactly their sources', async () => {
  let calls = 0;
  const f = setup(async () => { calls++; return []; });
  f.worker.notify(); f.worker.notify();
  assert.equal(calls, 0); assert.equal(f.timers.size, 1);
  f.fire(); await flush();
  assert.equal(calls, 1); assert.equal(f.memory.snapshot().queue.length, 0);
  assert.equal(f.timers.size, 0);
  await f.worker.dispose();
});

test('eight observations start one background job without blocking the caller', async () => {
  let finish; let calls = 0;
  const f = setup(() => { calls++; return new Promise((resolve) => { finish = resolve; }); }, 8);
  f.worker.notify(); f.worker.notify();
  assert.equal(calls, 1); assert.equal(f.worker.state().status, 'running');
  finish([]); await flush();
  assert.equal(f.memory.snapshot().queue.length, 0);
  await f.worker.dispose();
});

test('failed extraction retains the batch and schedules a bounded later retry', async () => {
  const f = setup(async () => { throw new Error('provider failure'); });
  await f.worker.start();
  assert.equal(f.worker.state().status, 'failed');
  assert.equal(f.memory.snapshot().queue.length, 1);
  assert.equal(f.timers.size, 1);
  await f.worker.dispose();
  assert.equal(f.timers.size, 0);
});

test('turning off extraction cancels in-flight work and rejects late successful results', async () => {
  let finish; let signal;
  const f = setup((_batch, value) => { signal = value; return new Promise((resolve) => { finish = resolve; }); });
  const task = f.worker.start();
  f.disable(); assert.equal(signal.aborted, true);
  finish([{ kind: 'preference', scope: 'persona', content: '不应写入',
    evidence: [{ eventId: 's:1', quote: '我更喜欢这种表达' }] }]);
  await task;
  assert.equal(f.memory.snapshot().entries.length, 0);
  assert.equal(f.timers.size, 0);
  await f.worker.dispose();
});

test('clearing while extraction is pending cannot resurrect old text', async () => {
  let finish;
  const f = setup(() => new Promise((resolve) => { finish = resolve; }));
  const task = f.worker.start(); f.memory.clear();
  finish([{ kind: 'preference', scope: 'persona', content: '不应写入',
    evidence: [{ eventId: 's:1', quote: '我更喜欢这种表达' }] }]);
  await task;
  assert.equal(f.memory.snapshot().entries.length, 0);
  assert.equal(f.memory.snapshot().queue.length, 0);
  await f.worker.dispose();
});

test('the extraction prompt separates quoted user evidence from role and task claims', () => {
  const f = setup(async () => []);
  const prompt = buildMemoryPrompt(f.memory.batch());
  assert.match(prompt.system, /输入是引用数据/);
  assert.match(prompt.system, /不得推断人格、心理、亲密程度或任务成功/);
  assert.equal(JSON.parse(prompt.user).sources[0].id, 's:1');
});
