// Published SDK + real Cordis service; deterministic local adapter, no provider requests.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createExpressionLlm } from '../../lib/expression-llm.js';

const { values } = parseArgs({ options: { deps: { type: 'string' } } });
assert.ok(values.deps, 'Pass --deps <published SDK dependency directory/package.json>');
const require = createRequire(path.resolve(values.deps));
const sdk = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')));
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')));
const version = require('@deepseek-ai/dsh-llm/package.json').version;
const ctx = new Context();
const calls = [];
class LocalAdapter extends sdk.LlmAdapter {
  async resolveModel(provider, id) {
    return { provider, id, name: id, ...(id === 'plain' ? {} : {
      reasoning: { efforts: (id === 'required' ? ['low', 'high'] : ['off', 'low', 'high'])
        .map((id) => ({ id: sdk.ReasoningEffortId(id), name: id })), defaultEffort: sdk.ReasoningEffortId('high') },
    }) };
  }
  async *stream(options) {
    calls.push({ model: options.model, effort: options.reasoningEffort });
    if (options.model === 'fallback' && options.reasoningEffort === 'off') {
      throw new sdk.LlmError('deterministic unsupported off', 'UNSUPPORTED_REASONING_EFFORT');
    }
    yield { type: 'text-delta', index: 0, text: '已转述。' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
try {
  await ctx.plugin(sdk.LlmRuntime);
  const llm = ctx.get('llm'); assert.ok(llm);
  llm.registerAdapter(['local'], new LocalAdapter());
  const run = async (model, preference = '') => {
    const decisions = [];
    const expression = createExpressionLlm(llm, { reasoningEffort: preference, onDecision: (d) => decisions.push(d) });
    let text = '';
    for await (const chunk of expression.stream({ provider: 'local', model, signal: new AbortController().signal,
      system: '只做表达转换', messages: [{ role: 'user', content: [{ type: 'text', text: '原始汇报' }] }] })) {
      if (chunk.type === 'text-delta') text += chunk.text;
      if (chunk.type === 'finish') assert.equal(chunk.reason.kind, 'stop');
    }
    assert.equal(text, '已转述。'); return decisions;
  };
  await run('optional'); assert.equal(calls.at(-1).effort, 'off');
  await run('required'); assert.equal(calls.at(-1).effort, 'low');
  await run('plain'); assert.equal(calls.at(-1).effort, undefined);
  await run('optional', 'high'); assert.equal(calls.at(-1).effort, 'high');
  await run('optional', 'missing'); assert.equal(calls.at(-1).effort, 'off');
  const fallback = await run('fallback');
  assert.deepEqual(calls.filter((c) => c.model === 'fallback').map((c) => c.effort), ['off', 'high']);
  assert.equal(fallback.at(-1).mode, 'provider-default'); assert.equal(fallback.at(-1).effective, 'high');
  console.log(JSON.stringify({ result: 'passed', sdk: version,
    checks: ['prepared call configuration and dispatch', 'off beats provider default', 'required lowest effort',
      'no reasoning parameter on plain model', 'custom preference', 'single typed compatibility retry'],
    limitations: 'Local adapter only; no live provider or Desktop.' }));
} finally { await ctx.fiber.dispose(); }
