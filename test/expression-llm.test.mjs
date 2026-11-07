import test from 'node:test';
import assert from 'node:assert/strict';
import { createExpressionLlm } from '../lib/expression-llm.js';

const unsupported = () => Object.assign(new Error('unsupported effort'), { code: 'UNSUPPORTED_REASONING_EFFORT' });
const options = () => ({ provider: 'p', model: 'm', signal: new AbortController().signal,
  system: 'expression only', messages: [{ role: 'user', content: [{ type: 'text', text: 'source report' }] }] });
const answer = async function* () { yield { type: 'text-delta', text: 'rewritten' }; yield { type: 'finish', reason: { kind: 'stop' } }; };
const collect = async (llm, opts = options()) => { const out = []; for await (const chunk of llm.stream(opts)) out.push(chunk); return out; };
const model = (ids = ['off', 'low', 'high'], defaultEffort = 'high') => ({ reasoning: { efforts: ids.map((id) => ({ id, name: id })), defaultEffort } });
function preparedHost(info, script = answer) {
  const calls = [], prepares = [];
  const llm = { async prepareCall(config, signal, configure) {
    prepares.push({ config, signal });
    const selected = configure(Object.freeze({ ...config }), info);
    const effective = { ...selected };
    if (effective.reasoningEffort === undefined && info.reasoning?.defaultEffort !== undefined) effective.reasoningEffort = info.reasoning.defaultEffort;
    return { config: effective, stream(next) { calls.push(next); return script(next); } };
  }, stream() { assert.fail('prepared dispatch must retain its adapter binding'); } };
  return { llm, calls, prepares };
}

test('default expression calls explicitly choose off over a thinking provider default', async () => {
  const f = preparedHost(model(['low', 'off', 'high']));
  const original = Object.freeze({ ...options(), reasoningEffort: 'high', maxTokens: 512, tools: [{ name: 'read_stats' }] });
  const policy = createExpressionLlm(f.llm);
  await collect(policy, original);
  assert.equal(f.calls[0].reasoningEffort, 'off');
  assert.equal(f.calls[0].maxTokens, 512); assert.equal(f.calls[0].tools, original.tools);
  assert.equal(f.calls[0].messages, original.messages); assert.equal(original.reasoningEffort, 'high');
});
test('thinking-only routes use the lowest advertised effort, not an invented universal level', async () => {
  const f = preparedHost(model(['tiny', 'deep'], 'deep'));
  await collect(createExpressionLlm(f.llm));
  assert.equal(f.calls[0].reasoningEffort, 'tiny');
});
test('models with no selectable reasoning controls do not receive a bogus off parameter', async () => {
  const f = preparedHost({}); await collect(createExpressionLlm(f.llm));
  assert.equal(Object.hasOwn(f.calls[0], 'reasoningEffort'), false);
});
test('a supported custom effort wins; an unsupported custom effort returns to automatic selection', async () => {
  const f = preparedHost(model(['off', 'custom-fast', 'high']));
  await collect(createExpressionLlm(f.llm, { reasoningEffort: ' custom-fast ' }));
  assert.equal(f.calls[0].reasoningEffort, 'custom-fast');
  const decisions = [];
  await collect(createExpressionLlm(f.llm, { reasoningEffort: 'missing', onDecision: (d) => decisions.push(d) }));
  assert.equal(f.calls[1].reasoningEffort, 'off'); assert.equal(decisions[0].reason, 'unsupported-custom');
});
test('older hosts can select exact-model efforts without a prepared-call API', async () => {
  const calls = [], queried = [];
  const llm = { async resolveModelInfo(...args) { queried.push(args); return model(); },
    stream(next) { calls.push(next); return answer(); } };
  const opts = options(); await collect(createExpressionLlm(llm), opts);
  assert.equal(calls[0].reasoningEffort, 'off'); assert.deepEqual(queried[0], ['p', 'm', opts.signal]);
});
for (const format of ['throw', 'finish']) {
  test(`a typed ${format} parameter rejection retries only once without the rejected control`, async () => {
    const calls = [];
    const llm = { stream(next) { calls.push(next); if (calls.length === 1) {
      if (format === 'throw') throw unsupported();
      return (async function* () { yield { type: 'finish', reason: { kind: 'error', failure: unsupported() } }; })();
    } return answer(); } };
    const result = await collect(createExpressionLlm(llm));
    assert.equal(calls.length, 2); assert.equal(calls[0].reasoningEffort, 'off');
    assert.equal(Object.hasOwn(calls[1], 'reasoningEffort'), false); assert.equal(result[0].text, 'rewritten');
  });
}
test('failed compatibility fallback cannot loop', async () => {
  let calls = 0;
  const llm = { stream() { calls++; throw unsupported(); } };
  await assert.rejects(collect(createExpressionLlm(llm)), { code: 'UNSUPPORTED_REASONING_EFFORT' });
  assert.equal(calls, 2);
});
for (const code of ['AUTH_FAILED', 'RATE_LIMITED', 'NETWORK_ERROR', 'BAD_REQUEST']) {
  test(`${code} cannot trigger an extra expression request`, async () => {
    let calls = 0;
    const llm = { stream() { calls++; throw Object.assign(new Error('thinking parameter mentioned by an unrelated error'), { code }); } };
    await assert.rejects(collect(createExpressionLlm(llm)), { code }); assert.equal(calls, 1);
  });
}
for (const type of ['text-delta', 'reasoning-delta', 'tool-call-delta']) {
  test(`an effort rejection after ${type} cannot replay already started output`, async () => {
    let calls = 0;
    const llm = { stream() { calls++; return (async function* () {
      yield { type, text: 'already emitted' };
      yield { type: 'finish', reason: { kind: 'error', failure: unsupported() } };
    })(); } };
    const result = await collect(createExpressionLlm(llm));
    assert.equal(calls, 1); assert.equal(result.at(-1).reason.kind, 'error');
  });
}
test('a compatibility choice persists across a tool continuation and has one logical retry budget', async () => {
  const calls = [];
  const llm = { stream(next) { calls.push(next); if (calls.length === 1) throw unsupported(); return answer(); } };
  const policy = createExpressionLlm(llm, { reasoningEffort: '' });
  await collect(policy); await collect(policy, { ...options(), messages: [{ role: 'tool', content: [] }] });
  assert.deepEqual(calls.map((o) => o.reasoningEffort), ['off', undefined, undefined]);
});
test('a new continuation cannot retry after earlier logical output was exposed', async () => {
  let calls = 0;
  const llm = { stream() { calls++; if (calls === 1) return answer(); throw unsupported(); } };
  const policy = createExpressionLlm(llm);
  await collect(policy);
  await assert.rejects(collect(policy), { code: 'UNSUPPORTED_REASONING_EFFORT' }); assert.equal(calls, 2);
});
test('abort drains locally during ignored asynchronous metadata and never dispatches its late result', async () => {
  let release, calls = 0;
  const pending = new Promise((resolve) => { release = resolve; });
  const llm = { prepareCall: () => pending };
  const abort = new AbortController();
  const task = collect(createExpressionLlm(llm), { ...options(), signal: abort.signal });
  abort.abort(new Error('disposed'));
  await assert.rejects(task, /disposed/);
  release({ config: {}, stream() { calls++; return answer(); } });
  await new Promise(setImmediate); assert.equal(calls, 0);
});
test('capability discovery failure does not silently dispatch with an unknown thinking default', async () => {
  let calls = 0;
  const llm = { resolveModelInfo: async () => { throw Object.assign(new Error('offline metadata'), { code: 'NETWORK_ERROR' }); },
    stream() { calls++; return answer(); } };
  await assert.rejects(collect(createExpressionLlm(llm)), { code: 'NETWORK_ERROR' }); assert.equal(calls, 0);
});

test('dispatch observation happens after capability preparation and never on metadata failure or abort', async () => {
  let release, dispatches = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const llm = { resolveModelInfo: () => gate, stream: answer };
  const abort = new AbortController();
  const task = collect(createExpressionLlm(llm, { onDispatch: () => dispatches++ }), { ...options(), signal: abort.signal });
  await Promise.resolve(); assert.equal(dispatches, 0); abort.abort(new Error('cancelled'));
  await assert.rejects(task, /cancelled/); release({}); await new Promise(setImmediate); assert.equal(dispatches, 0);
  const failed = createExpressionLlm({ resolveModelInfo: async () => { throw Error('metadata'); } }, { onDispatch: () => dispatches++ });
  await assert.rejects(collect(failed), /metadata/); assert.equal(dispatches, 0);
});

test('dispatch observations cover actual compatibility attempts and continuations without creating new logical policies', async () => {
  let calls = 0, observations = 0;
  const policy = createExpressionLlm({ stream() { calls++; if (calls === 1) throw unsupported(); return answer(); } },
    { onDispatch: () => observations++ });
  await collect(policy); await collect(policy, { ...options(), messages: [{ role: 'tool', content: [] }] });
  assert.equal(observations, 3); assert.equal(observations, calls);
});

test('chat thinking uses a supported non-off level and disabling it does not inherit rewrite effort',async()=>{
  const enabled=preparedHost(model());await collect(createExpressionLlm(enabled.llm,{thinking:true}));assert.equal(enabled.calls[0].reasoningEffort,'low');
  const disabled=preparedHost(model());await collect(createExpressionLlm(disabled.llm,{thinking:false,reasoningEffort:'high'}));assert.equal(disabled.calls[0].reasoningEffort,'off');
});
