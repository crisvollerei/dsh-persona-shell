import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, domain, flush, jsonReply } from './helpers/persona-chat-host.mjs';
import { DEFAULTS, resolveConfig } from '../lib/config.js';

const inputOf = options => JSON.parse(options.messages[0].content[0].text);
const response = source => ({ schemaVersion: 3, blocks: source.blocks.map(({ ref, text }) => ({ ref, text })) });
const script = options => { const input = inputOf(options); return jsonReply(input.task === 'report-readable'
  ? response(input.source) : { schemaVersion: 2, annotations: [], reading: [] }); };
async function setup(t, options = {}) {
  const f = fixture(t, { script,modelInfo:thinkingInfo, ...options }); await f.ready();
  assert.equal((await f.request('settings', { enabled: false, memory: false })).status, 200);
  return f;
}
function report(f, id = 'work', seq = 10, text = '本地修改已完成。\n\n客户端尚未验证；只有用户确认后才会发布。\n\n配置为 `config.yml`，修改 2 处。') {
  const session = { id, header: {}, append() { assert.fail('reading cannot write work messages'); } };
  for (const [type, n, data] of [['turn/start', seq - 1, { turn: 1 }],
    ['assistant/message', seq, { turn: 1, message: { content: [{ type: 'text', text }] } }],
    ['turn/end', seq + 1, { turn: 1, reason: { kind: 'completed' } }]]) f.bus.emit('session/event', session, { type, seq: n, data });
}
const read = (f, id = 'work', seq = 10, presentation = 'readable') => f.request(`report-visualization?session=${id}&seq=${seq}&presentation=${presentation}`);
const generate = (f, source, requestId = 'readable-1', extra = {}) => f.request('report-visualization', {
  action: 'generate', sessionId: source.sessionId, seq: source.seq, sourceHash: source.hash, presentation: 'readable', requestId, ...extra });

test('readable view is lazy, authenticated, original-only and accounted as visualization rather than chat', async t => {
  const f = await setup(t); report(f);
  assert.equal((await f.request('report-visualization?session=work&seq=10&presentation=readable', undefined, false)).status, 403);
  const opened = await read(f); assert.equal(opened.status, 200); assert.equal(opened.value.cached, false); assert.equal(f.calls.length, 0);
  const generated = await generate(f, opened.value.source); assert.equal(generated.status, 200);
  assert.equal(generated.value.result.schemaVersion, 3); assert.equal(generated.value.source.text, opened.value.source.text);
  assert.deepEqual(generated.value.result.blocks.map(block => block.ref), opened.value.source.blocks.map(block => block.id));
  assert.equal(f.calls.length, 1); const input = inputOf(f.calls[0]);
  assert.equal(input.task, 'report-readable'); assert.doesNotMatch(JSON.stringify(input), /memory|persona|chatHistory/);
  assert.equal(f.calls[0].reasoningEffort,'deep','readable generation explicitly dispatches an advertised thinking effort');
  assert.equal((await generate(f, opened.value.source, 'readable-again')).status, 200); assert.equal(f.calls.length, 1);
  const usage = (await f.request('model-usage')).value;
  assert.match(JSON.stringify(usage), /report-visualization/);
});

test('source annotations and readable prose keep separate caches across switching, regeneration and restart', async t => {
  const storage = domain(), f = await setup(t, { storage }); report(f);
  const opened = (await read(f)).value;
  const readable = (await generate(f, opened.source)).value.result;
  const emphasis = await generate(f, opened.source, 'annotate', { presentation: 'emphasis' }); assert.equal(emphasis.status, 200);
  assert.equal(emphasis.value.result.schemaVersion, 2);
  assert.deepEqual((await read(f)).value.result, readable); assert.equal((await read(f, 'work', 10, 'emphasis')).value.cached, true);
  await f.dispose();
  const restarted = await setup(t, { storage });
  assert.deepEqual((await read(restarted)).value.result, readable);
  assert.equal((await read(restarted, 'work', 10, 'emphasis')).value.result.schemaVersion, 2);
  assert.equal(restarted.calls.length, 0);
});

test('failed regeneration and incomplete finishes preserve the last readable draft and the complete original', async t => {
  let mode = 'ok';
  const f = await setup(t, { script: options => mode === 'bad' ? jsonReply({ schemaVersion: 3, blocks: [] })
    : jsonReply(response(inputOf(options).source), mode === 'truncated' ? 'max-tokens' : 'stop') });
  report(f); const opened = (await read(f)).value; const previous = await generate(f, opened.source);
  for (const [i, next] of ['bad', 'truncated'].entries()) {
    mode = next; const failed = await generate(f, opened.source, 'failed-' + i, { regenerate: true }); assert.equal(failed.status, 422);
    const current = (await read(f)).value; assert.deepEqual(current.result, previous.value.result); assert.equal(current.source.text, opened.source.text);
  }
});

test('local fallback warnings retain a risky paragraph and survive cache restoration', async t => {
  const storage = domain();
  const f = await setup(t, { storage, script: options => { const value = response(inputOf(options).source);
    value.blocks[1].text = '客户端已经验证，可以发布。'; return jsonReply(value); } });
  report(f); const opened = (await read(f)).value; const generated = await generate(f, opened.source);
  assert.equal(generated.status, 200); assert.equal(generated.value.result.blocks[1].text, opened.source.blocks[1].text);
  assert.ok(generated.value.warnings.some(note => note.code === 'readable-block-original'));
  await f.dispose(); const restarted = await setup(t, { storage });
  assert.deepEqual((await read(restarted)).value.warnings, generated.value.warnings);
});

test('recoverable fenced JSON, aliases, reordered blocks and omitted passages normalize and persist locally', async t => {
  const storage = domain();
  const g = await setup(t, { storage, script: options => (async function* () {
    const input = inputOf(options), blocks = input.source.blocks.slice(1).reverse().map(({ ref, text }) => ({ blockId: ref, content: text }));
    yield { type: 'text-delta', text: '```json\n' + JSON.stringify({ blocks }) + '\n```' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })() });
  report(g); const source = (await read(g)).value.source;
  const generated = await generate(g, source, 'normalized'); assert.equal(generated.status, 200);
  assert.equal(g.calls.length, 1);
  assert.deepEqual(generated.value.result.blocks.map(block => block.ref), source.blocks.map(block => block.id));
  assert.equal(generated.value.result.blocks[0].text, source.blocks[0].text);
  assert.ok(generated.value.warnings.some(note => note.code === 'readable-format-normalized'));
  await g.dispose(); const restarted = await setup(t, { storage });
  assert.deepEqual((await read(restarted)).value.result, generated.value.result);
  assert.deepEqual((await read(restarted)).value.warnings, generated.value.warnings);
  assert.equal(restarted.calls.length, 0);
});

test('a failed readable cache write preserves both previous presentations and permits an explicit retry', async t => {
  let failWrite = false;
  const storage = domain(Promise.resolve(), { fail: key => failWrite && key === JSON.stringify(['report-views', 'work']) });
  const f = await setup(t, { storage }); report(f);
  const source = (await read(f)).value.source;
  const previous = (await generate(f, source)).value.result;
  const emphasis = (await generate(f, source, 'disk-emphasis', { presentation: 'emphasis' })).value.result;
  failWrite = true;
  const failed = await generate(f, source, 'disk-failed', { regenerate: true });
  assert.equal(failed.status, 503); assert.equal(failed.value.error, 'report-save-failed');
  assert.deepEqual((await read(f)).value.result, previous);
  assert.deepEqual((await read(f, 'work', 10, 'emphasis')).value.result, emphasis);
  assert.equal((await read(f)).value.source.text, source.text);
  failWrite = false; assert.equal((await generate(f, source, 'disk-retry', { regenerate: true })).status, 200);
});

test('request identities and original hashes cannot cross report or view boundaries', async t => {
  const f = await setup(t); report(f); report(f, 'other', 20);
  const one = (await read(f)).value.source, two = (await read(f, 'other', 20)).value.source;
  assert.equal((await generate(f, one, 'shared')).status, 200);
  assert.equal((await generate(f, two, 'shared')).status, 409);
  assert.equal((await generate(f, one, 'shared', { presentation: 'emphasis' })).status, 409);
  assert.equal((await generate(f, one, 'stale', { sourceHash: '0'.repeat(64) })).status, 409);
  assert.equal(f.calls.length, 1);
});

test('closing a readable request cancels only its exact job and never starts a late follow-up call', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = await setup(t, { script: options => (async function* () { await gate; yield* jsonReply(response(inputOf(options).source)); })() });
  report(f); const source = (await read(f)).value.source;
  const pending = generate(f, source, 'cancel-me'); await flush();
  assert.equal((await f.request('report-visualization', { action: 'cancel', sessionId: 'work', seq: 10,
    presentation: 'readable', requestId: 'cancel-me' })).status, 200);
  assert.equal((await pending).status, 409); release(); await flush();
  assert.equal((await read(f)).value.cached, false); assert.equal(f.calls.length, 1);
  assert.equal((await generate(f, source, 'cancel-me')).status, 409);
});

const thinkingInfo = async () => ({ reasoning: {
  efforts: [{ id: 'off' }, { id: 'low' }, { id: 'deep' }], defaultEffort: 'deep',
} });

test('readable thinking with no declared default uses a real enabled effort and preserves old prose when unavailable',async t=>{
 let capable=true;const f=await setup(t,{modelInfo:async()=>capable?{reasoning:{efforts:[{id:'off'},{id:'low'}]}}:{}});report(f);
 const source=(await read(f)).value.source,first=await generate(f,source);assert.equal(first.status,200);assert.equal(f.calls.at(-1).reasoningEffort,'low');
 capable=false;const before=f.calls.length,failed=await generate(f,source,'missing-thinking',{regenerate:true});assert.equal(failed.status,503);assert.equal(failed.value.error,'report-thinking-unavailable');assert.equal(f.calls.length,before);
 assert.deepEqual((await read(f)).value.result,first.value.result);
 await f.request('settings',{readableThinking:false});assert.equal((await generate(f,source,'explicit-off',{regenerate:true})).status,200);
});

test('readable thinking defaults on independently of legacy visualization and report controls', () => {
  assert.equal(DEFAULTS.readableThinking, true);
  assert.equal(DEFAULTS.visualizationThinking, false);
  assert.equal(resolveConfig({ readableThinking: false }).readableThinking, false);
  assert.equal(resolveConfig({ visualizationThinking: false }).readableThinking, true);
  for (const readableThinking of [null, 0, 'false', {}, []]) {
    const settings = resolveConfig({ readableThinking });
    assert.equal(settings.readableThinking, true);
    assert.equal(settings.reasoningEffort, DEFAULTS.reasoningEffort);
    assert.equal(settings.chatThinking, DEFAULTS.chatThinking);
  }
});

test('readable generation selects its actual model default, stays lazy and records the actual route', async t => {
  const lookedUp = [];
  const f = await setup(t, { modelInfo: async (provider, model) => { lookedUp.push([provider, model]); return thinkingInfo(); } });
  const settings = (await f.request('settings')).value.settings;
  assert.equal(settings.readableThinking, true);
  assert.equal(settings.visualizationThinking, false);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(lookedUp, []);
  await f.request('settings', { visualizationProvider: 'reading-provider', visualizationModel: 'reading-model' });
  report(f); const source = (await read(f)).value.source;
  assert.equal(f.calls.length, 0);
  assert.equal((await generate(f, source)).status, 200);
  assert.deepEqual(lookedUp, [['reading-provider', 'reading-model']]);
  assert.deepEqual([f.calls[0].provider, f.calls[0].model, f.calls[0].reasoningEffort], ['reading-provider', 'reading-model', 'deep']);
  assert.equal(f.calls[0].maxTokens, 24576);
  const usage = (await f.request('model-usage')).value;
  assert.deepEqual(usage.models.map(row => [row.provider, row.model, row.calls]), [['reading-provider', 'reading-model', 1]]);
  assert.equal(usage.purposes.find(row => row.purpose === 'report-visualization')?.calls, 1);
  assert.equal(usage.purposes.some(row => row.purpose === 'chat'), false);
});

test('an early explicit readable off survives restore and restart without overwriting unrelated saved settings', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const storage = domain(gate);
  storage.tables.set('profile', new Map([['settings', {
    readableThinking: true, visualizationThinking: true, visualizationProvider: 'saved-provider', visualizationModel: 'saved-model',
    reasoningEffort: 'retained-report-choice', chatThinking: false,
  }]]));
  const f = fixture(t, { storage, script, modelInfo: thinkingInfo });
  assert.equal((await f.request('settings', { readableThinking: false })).status, 200);
  release(); await f.ready();
  let saved = (await f.request('settings')).value.settings;
  assert.equal(saved.readableThinking, false);
  assert.equal(saved.visualizationThinking, true);
  assert.equal(saved.reasoningEffort, 'retained-report-choice');
  assert.equal(saved.chatThinking, false);
  assert.deepEqual([saved.visualizationProvider, saved.visualizationModel], ['saved-provider', 'saved-model']);
  await f.dispose();
  assert.equal(storage.tables.get('profile').get('settings').readableThinking, false);
  const restarted = await setup(t, { storage, modelInfo: thinkingInfo });
  saved = (await restarted.request('settings')).value.settings;
  assert.equal(saved.readableThinking, false);
  assert.equal(saved.visualizationThinking, true);
  report(restarted); const source = (await read(restarted)).value.source;
  assert.equal((await generate(restarted, source)).status, 200);
  assert.deepEqual([restarted.calls[0].provider, restarted.calls[0].model, restarted.calls[0].reasoningEffort], ['saved-provider', 'saved-model', 'off']);
  assert.equal(restarted.calls[0].maxTokens, 16384);
  for (const readableThinking of [null, 'true', 1]) await restarted.request('settings', { readableThinking });
  assert.equal((await restarted.request('settings')).value.settings.readableThinking, false);
});

test('old visualization off does not disable readable thinking; automatic rewrite and manual adjustment are independent', async t => {
  const storage = domain();
  storage.tables.set('profile', new Map([['settings', { visualizationThinking: false }]]));
  const mixedScript = options => {
    let input; try { input = inputOf(options); } catch { /* A formal rewrite has its own plain source. */ }
    if (input) return script(options);
    const original = options.messages[0].content[0].text.split('待改写：\n').at(-1);
    return (async function* () { yield { type: 'text-delta', text: original }; yield { type: 'finish', reason: { kind: 'stop' } }; })();
  };
  const f = await setup(t, { storage, script: mixedScript, modelInfo: thinkingInfo });
  const settings = (await f.request('settings')).value.settings;
  assert.equal(settings.readableThinking, true);
  assert.equal(settings.visualizationThinking, false);
  report(f); const source = (await read(f)).value.source;
  assert.equal((await generate(f, source)).status, 200);
  assert.equal((await generate(f, source, 'emphasis-off', { presentation: 'emphasis' })).status, 200);
  assert.deepEqual(f.calls.map(call => call.reasoningEffort), ['deep', 'off']);
  await f.request('settings', { enabled: true });
  report(f, 'formal', 30, '本地检查已完成，客户端尚未验证。'); await flush();
  const row = (await f.request('state?session=formal')).value.rows.find(value => value.seq === 30);
  assert.equal(row.status, 'ready');
  assert.equal(f.calls.at(-1).reasoningEffort, 'off');
  const restated = await f.request('feedback', { sessionId: 'formal', seq: row.seq, version: row.version,
    personaId: row.speaker.id, scope: 'once', content: '用完整的句子讲清楚。' });
  assert.equal(restated.status, 200);
  assert.equal(f.calls.at(-1).reasoningEffort, 'deep');
  assert.equal((await f.request('settings')).value.settings.chatThinking, settings.chatThinking);
});

test('opposite readable and emphasis switches stay independent for the same original', async t => {
  const f = await setup(t, { modelInfo: thinkingInfo });
  await f.request('settings', { readableThinking: false, visualizationThinking: true });
  report(f); const source = (await read(f)).value.source;
  assert.equal((await generate(f, source, 'readable-off')).status, 200);
  assert.equal((await generate(f, source, 'emphasis-on', { presentation: 'emphasis' })).status, 200);
  assert.deepEqual(f.calls.map(call => call.reasoningEffort), ['off', 'deep']);
  assert.deepEqual(f.calls.map(call => inputOf(call).task), ['report-readable', 'report-emphasis']);
});
