import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelUsage } from '../lib/model-usage.js';
import { createExpressionLlm } from '../lib/expression-llm.js';

const route = { provider: 'local', model: 'm', purpose: 'rewrite' };
const usage = { inputTokens: 5, outputTokens: 8, cacheReadTokens: 7, cacheWriteTokens: 2, reasoningTokens: 3 };
const stop = { type: 'finish', reason: { kind: 'stop' } };
async function drain(stream) { for await (const _ of stream) { /* consume every chunk */ } }

test('receipts count one dispatched stream and the last valid usage snapshot, with disjoint cache and no double-counted reasoning', () => {
  const ledger = createModelUsage();
  const call = ledger.begin(route);
  call.usage({ inputTokens: 1, outputTokens: 0 }); call.usage({ ...usage, text: 'private' });
  call.usage({ inputTokens: -5, outputTokens: NaN }); call.finish(true); call.finish(false);
  const second = ledger.begin({ ...route, purpose: 'chat' });
  second.usage({ ...usage, totalTokens: 28 }); second.finish(false);
  const unknown = ledger.begin({ ...route, provider: 'remote', purpose: 'chat' }); unknown.finish(true);
  assert.deepEqual(ledger.report().totals, { calls: 3, failedCalls: 1, usageCalls: 2, inputTokens: 10,
    outputTokens: 16, cacheReadTokens: 14, cacheWriteTokens: 4, reasoningTokens: 6, totalTokens: 50 });
  assert.equal(ledger.report().models.length, 2); assert.equal(ledger.report().purposes.length, 2);
  assert.equal(ledger.report().breakdown.length, 3);
  assert.doesNotMatch(JSON.stringify(ledger.snapshot()), /private/);
});

test('local date filtering, day of dispatch across midnight, bounded retention and merging restores once', () => {
  let date = new Date(2026, 9, 8, 23, 59);
  const now = () => date, old = createModelUsage({ now });
  const past = old.begin(route); date = new Date(2026, 9, 9, 0, 1);
  past.usage(usage); past.finish(true);
  assert.equal(old.report(1).totals.calls, 0);
  assert.equal(old.report(7).daily.at(-2).totalTokens, 22);
  const ledger = createModelUsage({ now }), fresh = ledger.begin(route), saved = old.snapshot();
  ledger.restore(saved); ledger.restore(saved); fresh.finish(false);
  assert.equal(ledger.report(7).totals.calls, 2);
  assert.equal(ledger.report(1).totals.failedCalls, 1);
  date = new Date(2026, 10, 7);
  assert.deepEqual(ledger.snapshot().rows.map(r => r.date), ['2026-10-09']);
});

test('bounded dimensions coalesce excess model series while retaining purpose totals, including after reload', () => {
  const ledger = createModelUsage();
  for (let i = 0; i < 300; i++) {
    const c = ledger.begin({ purpose: i % 2 === 0 ? 'chat' : 'preset', provider: 'local', model: String(i) });
    c.usage(usage); c.finish(true);
  }
  const saved = ledger.snapshot(), next = createModelUsage(); next.restore(saved);
  const r = next.report();
  assert.ok(saved.rows.length <= 34); assert.equal(r.totals.calls, 300); assert.equal(r.totals.totalTokens, 6600);
  assert.deepEqual(r.purposes.map(p => p.calls), [150, 150]);
  assert.equal(r.models.find(row => row.model === '(other)').calls, 268);
});

test('physical dispatch uses the resolved route and counts retry, cancellation and continuation, but not a rejected preflight', async () => {
  const ledger = createModelUsage(), onAttempt = r => ledger.begin({ ...r, purpose: 'rewrite' });
  const opts = { provider: 'alias', model: 'hint', signal: new AbortController().signal };
  let calls = 0;
  const llm = createExpressionLlm({ async prepareCall(conf, _, choose) {
    return { config: choose({ ...conf, provider: 'mounted', model: 'exact' }, { reasoning: { efforts: [{ id: 'off' }] } }),
      stream: async function* () {
        if (++calls === 1) throw Object.assign(new Error('effort'), { code: 'UNSUPPORTED_REASONING_EFFORT' });
        yield { type: 'usage', usage }; yield { type: 'finish', reason: { kind: calls === 2 ? 'tool-calls' : 'stop' } };
      } };
  } }, { onAttempt });
  await drain(llm.stream(opts)); await drain(llm.stream(opts));
  await assert.rejects(drain(createExpressionLlm({ async prepareCall() { throw Error('offline'); } }, { onAttempt }).stream(opts)));
  const controller = new AbortController();
  let release;
  const gate = new Promise(r => { release = r; });
  const stalled = createExpressionLlm({ stream: async function* () {
    yield { type: 'usage', usage }; await gate; yield stop;
  } }, { onAttempt }).stream({ ...opts, signal: controller.signal });
  await stalled.next();
  const pending = stalled.next(); controller.abort();
  assert.equal(ledger.report().totals.failedCalls, 2, 'abort is accounted even when adapter ignores signal');
  release(); await assert.rejects(pending);
  const r = ledger.report();
  assert.equal(r.totals.calls, 4); assert.equal(r.totals.usageCalls, 3); assert.equal(r.totals.failedCalls, 2);
  assert.equal(r.models.find(m => m.provider === 'mounted' && m.model === 'exact').calls, 3);
  assert.equal(r.models.find(m => m.provider === 'alias' && m.model === 'hint').calls, 1);
});
