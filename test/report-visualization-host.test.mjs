import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { apply } from '../index.js';

const flush = async () => { for (let i = 0; i < 24; i++) await new Promise(setImmediate); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const stream = (value, finish = 'stop') => (async function* () {
  yield { type: 'text-delta', text: typeof value === 'string' ? value : JSON.stringify(value) };
  yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 7 } };
  yield { type: 'finish', reason: { kind: finish } };
})();
const sourceOf = options => JSON.parse(options.messages[0].content[0].text).source;
const validResult = source => ({ schemaVersion: 1, template: 'overview', title: '工作汇报',
  conclusion: { text: source.blocks[0].text, refs: [source.blocks[0].id] }, sections: [{ kind: 'details', title: '原始结果',
    items: [{ text: source.blocks[0].text, refs: [source.blocks[0].id] }] }] });

function fixture(t, { tables = new Map(), gate = Promise.resolve(), config = {}, script, listModels,
  readFailure = () => false, writeFailure = () => false, beforeWrite = async () => {}, rewriting = false } = {}) {
  const bus = new EventEmitter(), routes = [], disposers = [], calls = [], reads = [], writes = [];
  const services = new Map([
    ['storageDomain', { async open() { await gate; return { table(name) {
      if (!tables.has(name)) tables.set(name, new Map()); const own = tables.get(name);
      return { get(key) { reads.push({ table: name, key }); if (readFailure(name, key)) throw Error('disk-read'); return structuredClone(own.get(key)); },
        entries: () => own.entries(), async put(key, value) { await beforeWrite(name, key, value);
          if (writeFailure(name, key)) throw Error('disk-write'); writes.push({ table: name, key, value: structuredClone(value) }); own.set(key, structuredClone(value)); },
        async delete(key) { own.delete(key); } };
    }, async close() {} }; } }],
    ['webServer', { register(route) { routes.push(route); return () => {}; } }],
    ['connection', { requestRejection: ({ headers }) => headers.authorization === 'owner' ? undefined : 403 }],
    ['llm', { listModels: listModels ?? (async () => [{ id: 'm' }]), resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }, { id: 'low' }], defaultEffort: 'low' } }),
      stream(options) { calls.push(options); if (script) return script(options, calls.length);
        let input; try { input = JSON.parse(options.messages[0].content[0].text); } catch {}
        return input?.task === 'report-visualization' ? stream(validResult(input.source)) : stream('这份汇报保留原有事实和条件。'); } }],
  ]);
  const ctx = { get: name => services.get(name), logger: { warn() {} },
    on(name, handler) { bus.on(name, handler); return () => bus.off(name, handler); },
    inject(names, callback) { if (names.every(name => services.has(name))) callback(ctx); },
    effect(callback) { const stop = callback(); if (typeof stop === 'function') disposers.push(stop); } };
  apply(ctx, { provider: 'p', model: 'm', memory: false, ...config });
  let disposed;
  const dispose = () => disposed ??= (async () => { for (const stop of [...disposers].reverse()) await stop(); })();
  t.after(dispose);
  const request = async (path, body, auth = true) => {
    let status, value;
    await routes[0].handler({ url: '/persona-shell/' + path, method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: auth ? 'owner' : '' }, async *[Symbol.asyncIterator]() { if (body !== undefined) yield JSON.stringify(body); } },
    { writeHead(code) { status = code; }, end(text) { value = JSON.parse(text); } });
    return { status, value };
  };
  const event = (type, seq, data, sessionId = 's') => bus.emit('session/event', { id: sessionId, header: {}, append() { assert.fail('visualization must never append working messages'); } }, { type, seq, data });
  const report = (text = '修改已经完成；真实客户端尚未验证。', { sessionId = 's', seq = 10, turn = 1, complete = true, reason = 'completed', data = {} } = {}) => {
    event('turn/start', seq - 1, { turn }, sessionId);
    event('assistant/message', seq, { turn, message: { role: 'assistant', content: [{ type: 'text', text }] }, ...data }, sessionId);
    if (complete) event('turn/end', seq + 1, { turn, reason: { kind: reason } }, sessionId);
  };
  const read = async (sessionId = 's', seq = 10) => request('report-visualization?session=' + encodeURIComponent(sessionId) + '&seq=' + seq);
  const generate = async (source, requestId = 'visual-one', extra = {}) => request('report-visualization', {
    action: 'generate', sessionId: source.sessionId, seq: source.seq, sourceHash: source.hash, requestId, ...extra });
  let initialized = false;
  const ready = async () => { await flush(); if (!initialized) { initialized = true;
    if (!rewriting) assert.equal((await request('settings', { enabled: false })).status, 200); } await flush(); };
  return { calls, tables, reads, writes, event, report, request, read, generate, dispose, ready };
}

test('visualization endpoints require owner auth and do not initialize a model on read', async t => {
  const f = fixture(t); await f.ready(); f.report(); await f.ready();
  assert.equal((await f.request('report-visualization?session=s&seq=10', undefined, false)).status, 403);
  assert.equal((await f.request('report-visualization', { action: 'generate', sessionId: 's' }, false)).status, 403);
  const opened = await f.read(); assert.equal(opened.status, 200); assert.equal(opened.value.available, true);
  assert.equal(opened.value.source.text, '修改已经完成；真实客户端尚未验证。');
  await f.read(); assert.equal(f.calls.length, 0); assert.equal(opened.value.cached, false);
});

test('source capture is independent of disabled rewriting, per-session switch and the rewrite character limit', async t => {
  const f = fixture(t, { config: { maxRewriteChars: 200 } }); await f.ready();
  assert.equal((await f.request('session-switch', { sessionId: 's', enabled: false })).status, 200);
  const raw = '完整报告中的条件、风险与下一步。'.repeat(100);
  f.report(raw); await f.ready();
  const opened = await f.read(); assert.equal(opened.status, 200); assert.equal(opened.value.available, true);
  assert.equal(opened.value.source.text, raw); assert.equal(f.calls.length, 0);
});

test('a complete code-only report remains available and source blocks preserve the original code', async t => {
  const f = fixture(t); await f.ready(); const raw = '```js\nconst exact = "$HOME";\n```'; f.report(raw); await f.ready();
  const opened = await f.read(); assert.equal(opened.value.available, true); assert.equal(opened.value.source.text, raw);
  assert.ok(opened.value.source.blocks.some(block => block.kind === 'code' && block.text === raw)); assert.equal(f.calls.length, 0);
});

test('only the true completed tail is eligible; steering and later tool calls withdraw an earlier candidate', async t => {
  const f = fixture(t); await f.ready(); f.report('只是阶段性说明。', { complete: false });
  assert.equal((await f.read()).value.available, false);
  f.event('assistant/message', 12, { turn: 1, message: { content: [{ type: 'text', text: '这是最终完整汇报。' }] } });
  f.event('turn/end', 13, { turn: 1, reason: { kind: 'completed' } });
  assert.equal((await f.read()).value.available, false); assert.equal((await f.read('s', 12)).value.available, true);
  f.report('工具前的说明。', { sessionId: 'tools', complete: false });
  f.event('assistant/message', 12, { turn: 1, message: { content: [{ type: 'tool-call', id: 'tool', name: 'read', arguments: {} }] } }, 'tools');
  f.event('turn/end', 13, { turn: 1, reason: { kind: 'completed' } }, 'tools');
  assert.equal((await f.read('tools')).value.available, false);
  f.report('转向之前的说明。', { sessionId: 'steer', complete: false });
  f.event('user/message', 12, { turn: 1, content: [{ type: 'text', text: '换一个目标。' }] }, 'steer');
  f.event('turn/end', 13, { turn: 1, reason: { kind: 'completed' } }, 'steer');
  assert.equal((await f.read('steer')).value.available, false); assert.equal(f.calls.length, 0);
  f.report('属于上一轮的阶段说明。', { sessionId: 'wrong-turn', complete: false });
  f.event('turn/end', 13, { turn: 2, reason: { kind: 'completed' } }, 'wrong-turn');
  assert.equal((await f.read('wrong-turn')).value.available, false, 'another turn end cannot finalize an earlier candidate');
});

test('truncated, interrupted and oversized reports are never silently turned into complete visual reports', async t => {
  const f = fixture(t); await f.ready();
  f.report('被截断的结果。', { sessionId: 'truncated', reason: 'max-tokens' });
  f.report('曾中断的结果。', { sessionId: 'interrupted', data: { interrupted: true } });
  f.report('长度停止的结果。', { sessionId: 'chunk', data: { stream: [{ type: 'finish', reason: { kind: 'max-tokens' } }] } });
  f.report('长'.repeat(24001), { sessionId: 'long' });
  for (const id of ['truncated', 'interrupted', 'chunk', 'long']) assert.equal((await f.read(id)).value.available, false, id);
  assert.equal(f.calls.length, 0);
});

test('legacy restored rewrite-tail inference cannot promote an unfinished source into a final visualization', async t => {
  const tables = new Map(), first = fixture(t, { tables, rewriting: true }); await first.ready();
  first.report('尚在执行中的阶段性说明。', { complete: false }); await first.ready(); await first.dispose();
  assert.equal(tables.get('sessions').get('s')[0].final, false);
  const next = fixture(t, { tables }); await next.ready();
  await next.request('state?session=s');
  assert.equal((await next.read()).value.available, false); assert.equal(next.calls.length, 0);
});

test('generation uses only the pinned raw report, records its model usage and defaults thinking off', async t => {
  const f = fixture(t); await f.ready();
  f.report('原文需要保持条件；尚未发布。'); const opened = (await f.read()).value;
  const response = await f.generate(opened.source); assert.equal(response.status, 200); assert.ok(response.value.result);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].reasoningEffort, 'off');
  const input = JSON.parse(f.calls[0].messages[0].content[0].text);
  assert.equal(input.task, 'report-visualization'); assert.equal(input.source.blocks.map(block => block.text).join(''), opened.source.text);
  assert.doesNotMatch(JSON.stringify(input), /chatHistory|memory|persona|preferences/);
  assert.equal((await f.request('memory')).value.entries.length, 0);
  const usage = (await f.request('model-usage')).value;
  assert.equal(usage.purposes.find(row => row.purpose === 'report-visualization')?.calls, 1);
  assert.deepEqual(usage.models.map(row => [row.provider, row.model, row.calls]), [['p', 'm', 1]]);
});

test('independent visualization model and thinking overrides do not change the rewrite settings', async t => {
  const f = fixture(t, { config: { visualizationProvider: 'visual-p', visualizationModel: 'visual-m', visualizationThinking: true } });
  await f.ready(); f.report(); const opened = (await f.read()).value;
  assert.equal((await f.generate(opened.source)).status, 200);
  assert.deepEqual([f.calls[0].provider, f.calls[0].model, f.calls[0].reasoningEffort], ['visual-p', 'visual-m', 'low']);
  const settings = (await f.request('settings')).value.settings;
  assert.deepEqual([settings.provider, settings.model, settings.reasoningEffort], ['p', 'm', '']);
});

test('reopening and duplicate generate requests reuse the same source cache without a second model call', async t => {
  const f = fixture(t); await f.ready(); f.report(); const source = (await f.read()).value.source;
  const result = await f.generate(source); assert.equal(result.status, 200);
  const same = await f.generate(source); assert.equal(same.status, 200);
  const otherRequest = await f.generate(source, 'visual-two'); assert.equal(otherRequest.status, 200);
  const opened = (await f.read()).value; assert.equal(opened.cached, true); assert.deepEqual(opened.result, result.value.result);
  assert.equal(f.calls.length, 1);
});

test('a successful one-off persona restatement does not invalidate the original-source visualization cache', async t => {
  const f = fixture(t, { rewriting: true }); await f.ready(); f.report(); await f.ready();
  const opened = (await f.read()).value, visual = await f.generate(opened.source); assert.equal(visual.status, 200);
  const row = (await f.request('state?session=s')).value.rows.find(row => row.seq === 10);
  const restated = await f.request('feedback', { sessionId: 's', seq: 10, version: row.version, personaId: row.speaker.id,
    scope: 'once', content: '更正式一些，保留所有条件' });
  assert.equal(restated.status, 200);
  const after = (await f.read()).value; assert.equal(after.source.hash, opened.source.hash); assert.equal(after.cached, true);
  assert.deepEqual(after.result, visual.value.result);
  assert.equal((await f.generate(after.source, 'after-restatement')).status, 200);
  assert.equal(f.calls.filter(options => { try { return JSON.parse(options.messages[0].content[0].text).task === 'report-visualization'; } catch { return false; } }).length, 1);
});

test('simultaneous requests for one raw report share generation and cannot multiply charges', async t => {
  const gate = deferred(); const f = fixture(t, { script: options => (async function* () { await gate.promise; yield* stream(validResult(sourceOf(options))); })() });
  await f.ready(); f.report(); const source = (await f.read()).value.source;
  const first = f.generate(source), second = f.generate(source); await f.ready(); assert.equal(f.calls.length, 1);
  gate.resolve(); const results = await Promise.all([first, second]);
  assert.ok(results.every(r => r.status === 200 || r.status === 409)); assert.ok(results.some(r => r.status === 200));
  assert.equal(f.calls.length, 1);
});

test('source hashes and request identity prevent substituted sources or cross-report reuse', async t => {
  const f = fixture(t); await f.ready(); f.report(); f.report('另一房间的完整报告。', { sessionId: 'other' });
  const a = (await f.read()).value.source, b = (await f.read('other')).value.source;
  const forged = await f.generate(a, 'wrong-hash', { sourceHash: b.hash }); assert.ok(forged.status >= 400); assert.equal(f.calls.length, 0);
  assert.equal((await f.generate(a, 'shared-request')).status, 200);
  const reused = await f.generate(b, 'shared-request'); assert.ok(reused.status >= 400); assert.equal(f.calls.length, 1);
});

test('untrusted refs, invalid JSON and incomplete model finishes never become cached results', async t => {
  for (const failure of ['refs', 'json', 'finish']) await t.test(failure, async t => {
    const f = fixture(t, { script: options => { const result = validResult(sourceOf(options));
      if (failure === 'refs') result.conclusion.refs = ['another-report-block'];
      return stream(failure === 'json' ? '{broken' : result, failure === 'finish' ? 'max-tokens' : 'stop'); } });
    await f.ready(); f.report(); const source = (await f.read()).value.source;
    assert.ok((await f.generate(source)).status >= 400); const opened = (await f.read()).value;
    assert.equal(opened.cached, false); assert.equal(opened.result, undefined); assert.equal(opened.source.text, source.text);
  });
});

test('precise cancellation aborts only its request and a late request cannot revive a cancelled generation', async t => {
  const f = fixture(t, { script: options => (async function* () { await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true })); })() });
  await f.ready(); f.report(); f.report('另一份完整报告。', { sessionId: 'other' });
  const a = (await f.read()).value.source, b = (await f.read('other')).value.source;
  const first = f.generate(a, 'a-request'), second = f.generate(b, 'b-request'); await f.ready(); assert.equal(f.calls.length, 2);
  const cancel = source => f.request('report-visualization', { action: 'cancel', sessionId: source.sessionId, seq: source.seq, requestId: source === a ? 'a-request' : 'b-request' });
  assert.equal((await cancel(a)).status, 200); assert.equal(f.calls[0].signal.aborted, true); assert.equal(f.calls[1].signal.aborted, false);
  assert.ok((await first).status >= 400); await cancel(b); await second;
  const before = f.calls.length;
  assert.equal((await f.request('report-visualization', { action: 'cancel', sessionId: 's', seq: 10, requestId: 'late-request' })).status, 200);
  assert.ok((await f.generate(a, 'late-request')).status >= 400); assert.equal(f.calls.length, before);
});

test('unload during a default-model lookup drains the request without a later model dispatch', async t => {
  const listing = deferred(); const f = fixture(t, { config: { model: '' }, listModels: () => listing.promise });
  await f.ready(); f.report(); const source = (await f.read()).value.source;
  const pending = f.generate(source); await f.ready(); assert.equal(f.calls.length, 0);
  await f.dispose(); const response = await pending; assert.ok(response.status >= 400);
  listing.resolve([{ id: 'late-model' }]); await f.ready(); assert.equal(f.calls.length, 0);
});

test('the visualization deadline includes model lookup and prevents a late dispatch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const listing = deferred(); const f = fixture(t, { config: { model: '', timeoutMs: 1000 }, listModels: () => listing.promise });
  await f.ready(); f.report(); const source = (await f.read()).value.source;
  const pending = f.generate(source); await f.ready(); t.mock.timers.tick(1001); await f.ready();
  assert.ok((await pending).status >= 400); listing.resolve([{ id: 'late-model' }]); await f.ready(); assert.equal(f.calls.length, 0);
});

test('source and cached visualization survive reopening without rewriting or another paid request', async t => {
  const tables = new Map(), first = fixture(t, { tables }); await first.ready(); first.report();
  const source = (await first.read()).value.source, generated = await first.generate(source); assert.equal(generated.status, 200);
  await first.dispose(); const next = fixture(t, { tables }); await next.ready();
  const restored = await next.read(); assert.equal(restored.value.available, true); assert.equal(restored.value.source.hash, source.hash);
  assert.equal(restored.value.cached, true); assert.deepEqual(restored.value.result, generated.value.result); assert.equal(next.calls.length, 0);
});

test('a failed regeneration write retains the previous complete cached view for retry', async t => {
  let fail = false;
  const f = fixture(t, { writeFailure: (_, key) => fail && key === JSON.stringify(['report-views', 's']) });
  await f.ready(); f.report(); const source = (await f.read()).value.source;
  const first = await f.generate(source); assert.equal(first.status, 200); fail = true;
  const rejected = await f.generate(source, 'explicit-regeneration', { regenerate: true }); assert.equal(rejected.status, 503);
  const after = (await f.read()).value; assert.equal(after.cached, true); assert.deepEqual(after.result, first.value.result);
  fail = false; assert.equal((await f.generate(source, 'retry-regeneration', { regenerate: true })).status, 200);
});

test('temporary source-store read failures do not erase saved reports or make a paid request and can be retried', async t => {
  const tables = new Map(), first = fixture(t, { tables }); await first.ready(); first.report();
  const source = (await first.read()).value.source; await first.generate(source); await first.dispose();
  const before = structuredClone(tables.get('profile').get(JSON.stringify(['report-views', 's'])));
  let fail = true; const next = fixture(t, { tables, readFailure: (_, key) => fail && key === JSON.stringify(['report-views', 's']) });
  await next.ready(); const failed = await next.read(); assert.ok(failed.status >= 400 || failed.value.available === false);
  assert.deepEqual(tables.get('profile').get(JSON.stringify(['report-views', 's'])), before); assert.equal(next.calls.length, 0);
  fail = false; const restored = await next.read(); assert.equal(restored.status, 200); assert.equal(restored.value.source.hash, source.hash);
  assert.equal(restored.value.cached, true); assert.equal(next.calls.length, 0);
});

test('a new final report during a temporary hydrate failure cannot overwrite older stored report views', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const key = JSON.stringify(['report-views', 's']), tables = new Map(), first = fixture(t, { tables });
  await first.ready(); first.report(); const source = (await first.read()).value.source;
  const generated = await first.generate(source); assert.equal(generated.status, 200); await first.dispose();
  let fail = true;
  const next = fixture(t, { tables, readFailure: (_, id) => fail && id === key }); await next.ready();
  next.report('后来完成的另一份报告。', { seq: 20, turn: 2 });
  t.mock.timers.tick(401); await next.ready();
  assert.ok(tables.get('profile').get(key).reports.some(report => report.seq === 10 && report.result), 'an unread stored view cannot be replaced by the new in-memory tail');
  fail = false;
  const restored = await next.read(); assert.equal(restored.value.cached, true); assert.deepEqual(restored.value.result, generated.value.result);
  assert.equal((await next.read('s', 20)).value.source.text, '后来完成的另一份报告。');
  await next.dispose(); assert.deepEqual(tables.get('profile').get(key).reports.map(report => report.seq), [10, 20]);
  assert.equal(next.calls.length, 0);
});

test('unload retains unread persisted report views when a final source arrived during a read failure', async t => {
  const key = JSON.stringify(['report-views', 's']), tables = new Map(), first = fixture(t, { tables });
  await first.ready(); first.report(); const source = (await first.read()).value.source;
  assert.equal((await first.generate(source)).status, 200); await first.dispose();
  const before = structuredClone(tables.get('profile').get(key));
  const next = fixture(t, { tables, readFailure: (_, id) => id === key }); await next.ready();
  next.report('读取故障期间的新报告。', { seq: 20, turn: 2 });
  await next.dispose();
  assert.deepEqual(tables.get('profile').get(key), before);
  assert.equal(next.calls.length, 0);
});

test('validation failures expose only bounded reason metadata and never echo rejected model content', async t => {
  for (const failure of ['json', 'refs']) await t.test(failure, async t => {
    const privateModelText = 'REJECTED_MODEL_CONTENT_DO_NOT_ECHO';
    const f = fixture(t, { script: options => {
      if (failure === 'json') return stream('{"' + privateModelText + '":');
      const value = validResult(sourceOf(options)); value.conclusion.refs = [privateModelText]; return stream(value);
    } });
    await f.ready(); f.report(); const source = (await f.read()).value.source;
    const failed = await f.generate(source); assert.equal(failed.status, 422);
    assert.equal(failed.value.error, 'report-invalid-output');
    assert.deepEqual(Object.keys(failed.value.issue).sort(), ['code', 'path']);
    assert.match(failed.value.issue.code, /^[a-z][a-z0-9-]{0,63}$/);
    assert.equal(typeof failed.value.issue.path, 'string'); assert.ok(failed.value.issue.path.length <= 180);
    assert.doesNotMatch(JSON.stringify(failed.value), /REJECTED_MODEL_CONTENT_DO_NOT_ECHO|修改已经完成|真实客户端/);
    const same = await f.generate(source); assert.deepEqual(same, failed); assert.equal(f.calls.length, 1);
    const after = await f.read(); assert.equal(after.value.cached, false); assert.equal(after.value.source.hash, source.hash);
  });
});

test('unsupported validation badges degrade locally and retain the same warnings after cache restoration', async t => {
  const tables = new Map(), original = '尚未运行线上验证，不能确认部署结果。';
  const first = fixture(t, { tables, script: options => {
    const source = sourceOf(options), value = validResult(source);
    value.sections = [{ kind: 'validation', title: '验证情况', items: [{ text: original, refs: [source.blocks[0].id], state: 'passed' }] }];
    return stream(value);
  } });
  await first.ready(); first.report(original); const source = (await first.read()).value.source;
  const generated = await first.generate(source); assert.equal(generated.status, 200);
  assert.notEqual(generated.value.result.sections[0].items[0].state, 'passed');
  assert.equal(generated.value.result.sections[0].items[0].text, original);
  assert.ok(generated.value.warnings?.length > 0); assert.equal(first.calls.length, 1);
  assert.deepEqual((await first.generate(source, 'cached-new-request')).value.warnings, generated.value.warnings);
  assert.equal(first.calls.length, 1, 'local badge repair and cache reads never start another model call');
  await first.dispose();
  const next = fixture(t, { tables }); await next.ready(); const restored = await next.read();
  assert.equal(restored.value.cached, true); assert.deepEqual(restored.value.result, generated.value.result);
  assert.deepEqual(restored.value.warnings, generated.value.warnings);
  assert.equal(restored.value.source.text, original); assert.equal(restored.value.source.hash, source.hash);
  assert.equal(next.calls.length, 0);
});

test('one invented numeric item is omitted without losing valid items or calling a repair model', async t => {
  const raw = '测试通过789项。\n\n未验证真实客户端。';
  const f = fixture(t, { script: options => {
    const source = sourceOf(options), value = validResult(source);
    value.sections = [{ kind: 'validation', title: '验证结果', items: [
      { text: '测试通过789项。', refs: [source.blocks[0].id], state: 'passed' },
      { text: '测试通过790项。', refs: [source.blocks[0].id], state: 'passed' },
    ] }];
    return stream(value);
  } });
  await f.ready(); f.report(raw); const source = (await f.read()).value.source;
  const generated = await f.generate(source); assert.equal(generated.status, 200);
  assert.equal(generated.value.result.sections[0].items.length, 1);
  assert.equal(generated.value.result.sections[0].items[0].text, '测试通过789项。');
  assert.doesNotMatch(JSON.stringify(generated.value.result), /790/);
  assert.ok(generated.value.warnings?.some(warning => warning.code === 'ungrounded-item-omitted'));
  assert.deepEqual(generated.value.source.caveatRefs, ['b2']); assert.equal(generated.value.source.text, raw);
  assert.equal(generated.value.source.hash, source.hash); assert.equal(f.calls.length, 1);
  assert.deepEqual((await f.read()).value.warnings, generated.value.warnings);
});

test('a rejected regeneration reports its cause while retaining the prior readable cache', async t => {
  const privateModelText = 'REJECTED_REGENERATION_CONTENT';
  const f = fixture(t, { script: (options, call) => {
    const value = validResult(sourceOf(options));
    if (call > 1) value.conclusion.refs = [privateModelText];
    return stream(value);
  } });
  await f.ready(); f.report(); const source = (await f.read()).value.source;
  const first = await f.generate(source); assert.equal(first.status, 200);
  const failed = await f.generate(source, 'reject-regeneration', { regenerate: true }); assert.equal(failed.status, 422);
  assert.ok(failed.value.issue?.code); assert.doesNotMatch(JSON.stringify(failed.value), /REJECTED_REGENERATION_CONTENT/);
  const after = await f.read(); assert.equal(after.value.cached, true); assert.deepEqual(after.value.result, first.value.result);
  assert.deepEqual(after.value.warnings, first.value.warnings); assert.equal(after.value.source.hash, source.hash);
  assert.equal(f.calls.length, 2); await f.generate(source, 'open-preserved-cache'); assert.equal(f.calls.length, 2);
});
