// Offline contract probe against a supplied published SDK; no real provider or working-agent tools.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runProcessRewrite } from '../../lib/process-rewrite.js';

const { values } = parseArgs({ options: { deps: { type: 'string' } } });
assert.ok(values.deps, 'Pass --deps <SDK dependency directory/package.json>');
const require = createRequire(path.resolve(values.deps));
const sdk = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')));
const version = require('@deepseek-ai/dsh-llm/package.json').version;
assert.match(version, /^0\.2\.1-rc\./);
const usage = { available: true, scope: 'since_previous_process_report', categories: {
  read: { calls: 1, returned: 1, errors: 0, earlier_returns: 0 },
}, work_nature: { is_read_only: true, files_touched: 0, ran_destructive_cmd: false },
session_pacing: { session_turn_count: 25, local_hour: 2, idle_minutes: 45, is_first_report: true } };
for (const completedBlocks of [false, true]) {
  const replayState = { response: { provider: 'fixture', marker: 'opaque' }, blocks: [{ n: 'reasoning' }, { n: 'tool' }] };
  const chunks = [
    { type: 'block-start', index: 4, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 4, text: 'Provider replay only.' },
    ...(completedBlocks ? [{ type: 'block-end', index: 4, block: { type: 'reasoning', text: 'Provider replay only.', signature: 'signed' } }] : []),
    { type: 'tool-call-delta', index: 1, id: 'usage', name: 'get_tool_usage', argumentsDelta: '{' },
    { type: 'tool-call-delta', index: 1, id: 'usage', argumentsDelta: '}' },
    ...(completedBlocks ? [{ type: 'block-end', index: 1, block: { type: 'tool-call', id: 'usage', name: 'get_tool_usage', arguments: '{}' } }] : []),
    { type: 'finish', reason: { kind: 'tool-calls' }, replayState },
  ];
  const assembler = new sdk.BlockAssembler();
  for (const chunk of chunks) assembler.push(chunk);
  let requests = 0;
  const result = await runProcessRewrite({
    options: { provider: 'fixture', model: 'fixture', signal: new AbortController().signal, messages: [] },
    usage, allowed: () => true, maxChars: 2048, onPartial() {},
    llm: { stream(options) {
      requests++;
      return (async function* () {
        if (requests === 1) { yield* chunks; return; }
        assert.equal(options.tools, undefined);
        const [assistant, tool] = options.messages;
        const expectedAssistant = sdk.createAssistantMessage({ source: { provider: 'fixture', model: 'fixture',
          replayState: assembler.replayState }, content: assembler.blocks() });
        assert.deepEqual({ ...assistant, id: '' }, { ...expectedAssistant, id: '' });
        const expectedTool = sdk.createToolResultMessage({ callId: 'usage', content: [{ type: 'text', text: JSON.stringify(usage) }], isError: false });
        assert.deepEqual({ ...tool, id: '' }, { ...expectedTool, id: '' });
        yield { type: 'text-delta', index: 0, text: '{"rewrite":"继续看下一部分。","process_note":"刚读了1次，接着来。"}' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    } },
  });
  assert.equal(requests, 2);
  assert.equal(result.text, '继续看下一部分。');
  assert.equal(result.note, '刚读了1次，接着来。');
}
console.log(JSON.stringify({ result: 'passed', sdk: version,
  checks: ['delta-only and completed blocks', 'first-seen block order', 'opaque replay state', 'native assistant/tool message shape', 'single bounded continuation'],
  limitations: 'No live provider or Desktop render; SDK assembly and message contracts only.' }, null, 2));
