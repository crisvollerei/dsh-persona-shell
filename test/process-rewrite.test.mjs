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

test('one tool-free request carries the frozen observation with the masked report', async () => {
  const r = runner([answer()]);
  assert.deepEqual(await r.run(), { text: '鲸鲸接着看。', note: '哼，搜索了2次，还碰到1次报错。' });
  assert.equal(r.calls.length,1);assert.equal(r.calls[0].tools,undefined);
  assert.deepEqual(JSON.parse(r.calls[0].messages[0].content.at(-1).text),{processUsage:usage});
  assert.doesNotMatch(r.partials.join(''), /private reasoning|signature|process_note|get_tool_usage|报错/);
});

test('an unavailable observation drops the note', async () => {
  const r = runner([answer()],{usage:null});
  assert.deepEqual(await r.run(), { text: '鲸鲸接着看。', note: undefined });
  assert.equal(r.calls.length, 1);
});

test('process text accepts an unindexed single block and orders indexed blocks by position',async()=>{
  const text='{"rewrite":"正文。","process_note":""}', stop={type:'finish',reason:{kind:'stop'}};
  const delta=(index,text)=>({type:'text-delta',index,text});
  for(const pieces of [[delta(undefined,text.slice(0,6)),delta(undefined,text.slice(6))],
    [delta(3,text.slice(6)),delta(1,text.slice(0,6))]]){
    assert.deepEqual(await runner([[...pieces,stop]]).run(),{text:'正文。',note:undefined});
  }
  for(const pieces of [[delta(undefined,'{'),delta(1,'}')],[delta(1,'{'),delta(undefined,'}')]]){
    await assert.rejects(runner([[...pieces,stop]]).run(),/process-block-index/);
  }
});

test('authoritative completed blocks ignore late deltas and private reasoning', async () => {
  const r = runner([[
    { type: 'block-start', index: 5, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 5, text: 'retained only for provider replay' },
    { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify({ rewrite: '正文。', process_note: '' }) } },
    { type: 'text-delta', index: 0, text: 'ignored after closure' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]]);
  assert.deepEqual(await r.run(), { text: '正文。', note: undefined });
  assert.equal(r.calls.length,1);assert.doesNotMatch(r.partials.join(''),/replay/);
});

test('bad optional notes are dropped without damaging the body', async () => {
  for (const note of ['字'.repeat(41), '一行\n另一行', '你好。再见。', 'Busy. Again.', '测试通过啦。', '搜索了9次。', '搜索了1次。', '**真忙**']) {
    const r = runner([answer('正文。', note)]);
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
  await assert.rejects(twice.run(), /process-tool-denied/);
  const anotherRound = runner([[tool(), finish], [tool(), finish]]);
  await assert.rejects(anotherRound.run(), /process-tool-denied/);
  assert.equal(anotherRound.calls.length, 1);
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
  const r = runner([answer('正文。', '第25轮啦，鲸鲸还在呢。')], { usage: noTools });
  assert.deepEqual(await r.run(), { text: '正文。', note: '第25轮啦，鲸鲸还在呢。' });
});

test('disabled gates prevent querying/continuation and aborted hanging providers settle promptly', async () => {
  const off = runner([answer()], { allowed: () => false });
  await assert.rejects(off.run(), /process-disabled/);
  assert.equal(off.calls.length, 0);
  let enabled = true;
  async function* disabledBeforeExecution() {
    yield {type:'text-delta',index:0,text:'{'}; enabled = false;
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
