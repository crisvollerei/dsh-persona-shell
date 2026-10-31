import test from 'node:test';
import assert from 'node:assert/strict';
import { processRewritePartial, parseProcessRewrite, validateProcessNote, runProcessRewrite } from '../lib/process-rewrite.js';

const usage = Object.freeze({ available: true, scope: 'since_previous_process_report', categories: {
  search: { calls: 2, returned: 2, errors: 1, earlier_returns: 0 },
} });
const tool = (overrides = {}) => ({ type: 'block-end', index: 1, block: {
  type: 'tool-call', id: 'query1', name: 'get_tool_usage', arguments: '{}', ...overrides,
} });
const answer = (rewrite = '鲸鲸接着看。', process_note = '哼，搜索了2次，还碰到1次报错。') => [
  { type: 'text-delta', index: 0, text: JSON.stringify({ rewrite, process_note }) },
  { type: 'finish', reason: { kind: 'stop' } },
];
function runner(rounds, overrides = {}) {
  const calls = []; const partials = [];
  const llm = { stream(options) {
    calls.push(options);
    const chunks = rounds[calls.length - 1];
    assert.ok(chunks, 'no unexpected third model request');
    return (async function* () { yield* chunks; })();
  } };
  return { calls, partials, run: () => runProcessRewrite({ llm, options: {
    provider: 'p', model: 'm', signal: new AbortController().signal,
    system: 'test', messages: [{ role: 'user', content: [{ type: 'text', text: '原文 [[0]]' }] }],
  }, usage, allowed: () => true, onPartial: (value) => partials.push(value), maxChars: 4096, ...overrides }) };
}

test('partial JSON decoding shows only body prose, including fragmented escapes', () => {
  const body = '鲸鲸说："稍等"\n看 [[0]]，\t好啦😀。';
  const wire = JSON.stringify({ rewrite: body, process_note: 'never stream this' });
  for (let i = 0; i <= wire.length; i++) assert.ok(body.startsWith(processRewritePartial(wire.slice(0, i))));
  assert.equal(processRewritePartial(wire), body);
  assert.equal(processRewritePartial('{"process_note":"leak","rewrite":"body"}'), '');
  assert.equal(processRewritePartial('{"rewrite":"bad\\u0'), 'bad');
  assert.equal(parseProcessRewrite('{"rewrite":"body","extra":"no"}'), undefined);
});

test('real SDK tool blocks query once and preserve reasoning/replay plus correlated role-tool messages', async () => {
  const replayState = { vendor: { opaque: 'signature' } };
  const r = runner([[
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'private reasoning', signature: 'sig' } },
    { type: 'tool-call-delta', index: 1, id: 'query1', name: 'get_tool_usage', argumentsDelta: '{' },
    { type: 'tool-call-delta', index: 1, id: 'query1', argumentsDelta: '}' },
    tool(), { type: 'finish', reason: { kind: 'tool-calls' }, replayState },
  ], answer()]);
  assert.deepEqual(await r.run(), { text: '鲸鲸接着看。', note: '哼，搜索了2次，还碰到1次报错。' });
  assert.equal(r.calls.length, 2);
  assert.deepEqual(r.calls[0].tools.map((t) => t.name), ['get_tool_usage']);
  assert.equal(Object.hasOwn(r.calls[1], 'tools'), false);
  const [, assistant, result] = r.calls[1].messages;
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.content[0].type, 'reasoning');
  assert.equal(assistant.content[1].id, 'query1');
  assert.equal(assistant.source.replayState, replayState);
  assert.equal(result.role, 'tool');
  assert.equal(result.source.callId, result.toolCallId);
  assert.equal(result.toolCallId, 'query1');
  assert.deepEqual(JSON.parse(result.content[0].text), usage);
  assert.doesNotMatch(r.partials.join(''), /private reasoning|signature|process_note|get_tool_usage|报错/);
});

test('querying is optional and an unqueried note is always discarded', async () => {
  const r = runner([answer()]);
  assert.deepEqual(await r.run(), { text: '鲸鲸接着看。', note: undefined });
  assert.equal(r.calls.length, 1);
});

test('delta-only providers and authoritative completed blocks follow the same query contract', async () => {
  const r = runner([[
    { type: 'block-start', index: 5, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 5, text: 'retained only for provider replay' },
    { type: 'tool-call-delta', index: 2, id: 'query1', name: 'get_tool_usage', argumentsDelta: '{' },
    { type: 'tool-call-delta', index: 2, id: 'query1', argumentsDelta: '}' },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ], [
    { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify({ rewrite: '正文。', process_note: '' }) } },
    { type: 'text-delta', index: 0, text: 'ignored after closure' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]]);
  assert.deepEqual(await r.run(), { text: '正文。', note: undefined });
  assert.deepEqual(r.calls[1].messages[1].content.map((b) => b.type), ['reasoning', 'tool-call'], 'preserve SDK first-seen block order');
  assert.equal(r.calls[1].messages[1].content[1].arguments, '{}');
});

test('bad optional notes are dropped without damaging the body', async () => {
  for (const note of ['字'.repeat(41), '一行\n另一行', '你好。再见。', 'Busy. Again.', '测试通过啦。', '搜索了9次。', '搜索了1次。', '**真忙**']) {
    const r = runner([[tool(), { type: 'finish', reason: { kind: 'tool-calls' } }], answer('正文。', note)]);
    assert.deepEqual(await r.run(), { text: '正文。', note: undefined }, note);
  }
  assert.equal(validateProcessNote('碰到1次报错。', { ...usage, categories: { search: { ...usage.categories.search, errors: 0 } } }), undefined);
  assert.equal(validateProcessNote('忙起来啦。', { ...usage, available: false }), undefined);
  assert.equal(validateProcessNote('忙起来啦。', { ...usage, categories: {} }), undefined);
  assert.equal(validateProcessNote('鲸'.repeat(39) + '！', usage)?.length, 40);
});

test('unknown functions, arguments, repeated calls and extra rounds never dispatch', async () => {
  const finish = { type: 'finish', reason: { kind: 'tool-calls' } };
  for (const block of [tool({ name: 'bash' }), tool({ arguments: '{"session":"elsewhere"}' }),
    tool({ arguments: '[]' }), tool({ arguments: '{' }), tool({ arguments: ' '.repeat(257) })]) {
    const r = runner([[block, finish]]);
    await assert.rejects(r.run(), /process-tool/);
    assert.equal(r.calls.length, 1);
  }
  const twice = runner([[tool(), { ...tool({ id: 'query2' }), index: 2 }, finish]]);
  await assert.rejects(twice.run(), /process-tool-limit/);
  const anotherRound = runner([[tool(), finish], [tool(), finish]]);
  await assert.rejects(anotherRound.run(), /process-tool-limit/);
  assert.equal(anotherRound.calls.length, 2);
});

test('malformed/truncated streams fall back rather than accepting partial JSON', async () => {
  for (const chunks of [[{ type: 'text-delta', index: 0, text: '{"rewrite":"hi"}' }],
    [{ type: 'text-delta', index: 0, text: '{"rewrite":"hi"' }, { type: 'finish', reason: { kind: 'stop' } }],
    [{ type: 'finish', reason: { kind: 'tool-calls' } }],
    [{ type: 'finish', reason: { kind: 'max-tokens' } }]]) {
    await assert.rejects(runner([chunks]).run(), /process-/);
  }
  await assert.rejects(runner([answer('x'.repeat(4100))]).run(), /process-too-long/);
});

test('work nature and independently known pacing support short asides without inventing outcomes', async () => {
  const enriched = { ...usage, work_nature: { is_read_only: true, files_touched: 0, ran_destructive_cmd: false },
    session_pacing: { session_turn_count: 25, local_hour: 2, idle_minutes: 0.5, is_first_report: true } };
  for (const note of ['这段只读，先慢慢看。', '第25轮啦，鲸鲸还在呢。', '间隔0.5分钟，又见面啦。', '都2点了，鲸鲸轻声说。']) {
    assert.equal(validateProcessNote(note, enriched), note);
  }
  for (const note of ['第2轮啦。', '都25点了。', '修改了2个文件。', '运行了危险命令。', '间隔2分钟，接着看。',
    '调用了25次工具。', '收到返回了25次。']) {
    assert.equal(validateProcessNote(note, enriched), undefined, note);
  }
  const noTools = { available: false, scope: usage.scope, categories: {},
    work_nature: { is_read_only: null, files_touched: null, ran_destructive_cmd: null },
    session_pacing: enriched.session_pacing };
  assert.equal(validateProcessNote('第25轮啦，鲸鲸还在呢。', noTools), '第25轮啦，鲸鲸还在呢。');
  assert.equal(validateProcessNote('这段只读，先慢慢看。', noTools), undefined);
  assert.equal(validateProcessNote('间隔0.5分钟，又见面啦。', { ...noTools,
    session_pacing: { ...enriched.session_pacing, is_first_report: false } }), undefined);
  const r = runner([[tool(), { type: 'finish', reason: { kind: 'tool-calls' } }], answer('正文。', '第25轮啦，鲸鲸还在呢。')], { usage: noTools });
  assert.deepEqual(await r.run(), { text: '正文。', note: '第25轮啦，鲸鲸还在呢。' });
});

test('disabled gates prevent querying/continuation and aborted hanging providers settle promptly', async () => {
  const off = runner([answer()], { allowed: () => false });
  await assert.rejects(off.run(), /process-disabled/);
  assert.equal(off.calls.length, 0);
  let enabled = true;
  async function* disabledBeforeExecution() {
    yield tool(); enabled = false;
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  }
  const changed = runner([disabledBeforeExecution()], { allowed: () => enabled });
  await assert.rejects(changed.run(), /process-disabled/);
  assert.equal(changed.calls.length, 1);
  const controller = new AbortController();
  const hanging = runner([], { llm: { stream: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }) },
    options: { signal: controller.signal, messages: [] } });
  const pending = hanging.run();
  controller.abort();
  await assert.rejects(pending, /process-aborted/);
});
