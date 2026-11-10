import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { apply } from '../index.js';

const flush = async () => { for (let i = 0; i < 24; i++) await new Promise(setImmediate); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const text = '本轮修改已经完成。\n\n修复了输入保留和阅读位置，已经执行本地回归检查。\n\n真实模型与生产环境尚未验证，发布前仍需人工核对。';
const emphasis = source => ({ schemaVersion: 2, annotations: [{ blockId: source.blocks[0].id,
  quote: '本轮修改已经完成。', kind: 'conclusion', importance: 1 }] });
const summary = source => ({ schemaVersion: 1, template: 'overview', title: '工作报告',
  conclusion: { text: source.blocks[0].text, refs: [source.blocks[0].id] }, sections: [] });
const stream = (value, finish = 'stop') => (async function* () {
  yield { type: 'text-delta', text: typeof value === 'string' ? value : JSON.stringify(value) };
  yield { type: 'usage', usage: { inputTokens: 9, outputTokens: 4 } };
  yield { type: 'finish', reason: { kind: finish } };
})();
const inputOf = options => JSON.parse(options.messages[0].content[0].text);

function fixture(t, { tables = new Map(), script, config = {}, listModels, failWrite = () => false } = {}) {
  const bus = new EventEmitter(), routes = [], disposers = [], calls = [];
  const services = new Map([
    ['storageDomain', { async open() { return { table(name) {
      if (!tables.has(name)) tables.set(name, new Map()); const own = tables.get(name);
      return { get: id => structuredClone(own.get(id)), entries: () => own.entries(),
        async put(id, value) { if (failWrite(name, id)) throw Error('disk-write'); own.set(id, structuredClone(value)); }, async delete(id) { own.delete(id); } };
    }, async close() {} }; } }],
    ['webServer', { register(route) { routes.push(route); return () => {}; } }],
    ['connection', { requestRejection: ({ headers }) => headers.authorization === 'owner' ? undefined : 403 }],
    ['llm', { listModels: listModels ?? (async () => [{ id: 'm' }]),
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }, { id: 'low' }] } }),
      stream(options) { calls.push(options); if (script) return script(options, calls.length);
        const input = inputOf(options); return stream(input.task === 'report-emphasis' ? emphasis(input.source) : summary(input.source)); } }],
  ]);
  const ctx = { get: name => services.get(name), logger: { warn() {} },
    on(name, handler) { bus.on(name, handler); return () => bus.off(name, handler); },
    inject(names, callback) { if (names.every(name => services.has(name))) callback(ctx); },
    effect(callback) { const stop = callback(); if (typeof stop === 'function') disposers.push(stop); } };
  apply(ctx, { provider: 'p', model: 'm', memory: false, ...config });
  let disposed, initialized = false;
  const dispose = () => disposed ??= (async () => { for (const stop of [...disposers].reverse()) await stop(); })();
  t.after(dispose);
  const request = async (path, body, auth = true) => {
    let status, value;
    await routes[0].handler({ url: '/persona-shell/' + path, method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: auth ? 'owner' : '' }, async *[Symbol.asyncIterator]() { if (body !== undefined) yield JSON.stringify(body); } },
    { writeHead(code) { status = code; }, end(raw) { value = JSON.parse(raw); } });
    return { status, value };
  };
  const event = (type, seq, data, sessionId = 's') => bus.emit('session/event', { id: sessionId, header: {},
    append() { assert.fail('emphasis must never append a working message'); } }, { type, seq, data });
  const report = (raw = text, sessionId = 's', seq = 10) => {
    event('turn/start', seq - 1, { turn: 1 }, sessionId);
    event('assistant/message', seq, { turn: 1, message: { content: [{ type: 'text', text: raw }] } }, sessionId);
    event('turn/end', seq + 1, { turn: 1, reason: { kind: 'completed' } }, sessionId);
  };
  const read = (sessionId = 's', seq = 10, presentation = 'emphasis') => request('report-visualization?session=' + encodeURIComponent(sessionId)
    + '&seq=' + seq + (presentation ? '&presentation=' + presentation : ''));
  const generate = (source, requestId = 'emphasis-one', extra = {}) => request('report-visualization', {
    action: 'generate', sessionId: source.sessionId, seq: source.seq, sourceHash: source.hash, requestId, presentation: 'emphasis', ...extra });
  const ready = async () => { await flush(); if (!initialized) { initialized = true;
    assert.equal((await request('settings', { enabled: false })).status, 200); } await flush(); };
  return { calls, tables, request, read, generate, report, event, ready, dispose };
}

test('emphasis uses authenticated source reads and never calls a model merely to open a report', async t => {
  const f = fixture(t); await f.ready(); f.report();
  assert.equal((await f.request('report-visualization?session=s&seq=10&presentation=emphasis', undefined, false)).status, 403);
  const first = await f.read(); assert.equal(first.status, 200); assert.equal(first.value.available, true);
  assert.equal(first.value.source.text, text); assert.equal(first.value.cached, false); assert.equal(first.value.result, undefined);
  assert.deepEqual((await f.read()).value.source, first.value.source); assert.equal(f.calls.length, 0);
  const invalid = await f.request('report-visualization?session=s&seq=10&presentation=execute');
  assert.equal(invalid.status, 400); assert.equal(f.calls.length, 0);
});

test('emphasis generation sends only original report blocks and returns source-grounded offsets without rewriting words', async t => {
  const f = fixture(t); await f.ready(); f.report(); const source = (await f.read()).value.source;
  const generated = await f.generate(source); assert.equal(generated.status, 200);
  const result = generated.value.result; assert.equal(result.schemaVersion, 2); assert.equal(result.annotations.length, 1);
  const annotation = result.annotations[0]; assert.equal(source.text.slice(annotation.start, annotation.end), annotation.quote);
  assert.equal(annotation.quote, '本轮修改已经完成。'); assert.equal(annotation.start, source.text.indexOf(annotation.quote));
  assert.equal(generated.value.source.text, text); assert.equal(generated.value.source.hash, source.hash);
  assert.equal('conclusion' in result, false); assert.equal('sections' in result, false);
  const input = inputOf(f.calls[0]); assert.equal(input.task, 'report-emphasis');
  assert.equal(input.source.blocks.map(block => block.text).join(''), text);
  assert.deepEqual(Object.keys(input).sort(), ['source', 'task']);
  assert.doesNotMatch(JSON.stringify(input), /history|persona|privateMemory|preferences/);
  assert.equal(f.calls[0].reasoningEffort, 'off');
  assert.equal((await f.request('memory')).value.entries.length, 0);
  const usage = (await f.request('model-usage')).value;
  assert.equal(usage.purposes.find(row => row.purpose === 'report-visualization')?.calls, 1);
});

test('unmatched quotes are omitted locally while the exact complete original stays available', async t => {
  const f = fixture(t, { script: options => { const input = inputOf(options), result = emphasis(input.source);
    result.annotations.push({ blockId: input.source.blocks[1].id, quote: '全部环境已经验证且已经发布。', kind: 'evidence', importance: 1 });
    return stream(result); } });
  await f.ready(); f.report(); const source = (await f.read()).value.source;
  const generated = await f.generate(source); assert.equal(generated.status, 200);
  assert.equal(generated.value.result.annotations.length, 1);
  assert.doesNotMatch(JSON.stringify(generated.value.result), /全部环境已经验证/);
  assert.equal(generated.value.source.text, text); assert.ok(generated.value.warnings?.length);
  assert.equal(f.calls.length, 1, 'local validation cannot start a second repair model');
});

test('code content never receives a semantic annotation and UTF-16 offsets still refer to original prose', async t => {
  const raw = '🐋 本轮修改已经完成。\n\n```sh\nnode --test\n```\n\n生产环境尚未验证，稍后仍需要人工核对。';
  const f = fixture(t, { script: options => { const source = inputOf(options).source;
    return stream({ schemaVersion: 2, annotations: [
      { blockId: source.blocks[0].id, quote: '本轮修改已经完成。', kind: 'conclusion', importance: 1 },
      { blockId: source.blocks.find(block => block.kind === 'code').id, quote: 'node --test', kind: 'evidence', importance: 2 },
    ] }); } });
  await f.ready(); f.report(raw); const source = (await f.read()).value.source;
  const generated = await f.generate(source); assert.equal(generated.status, 200);
  assert.equal(generated.value.result.annotations.length, 1);
  const [annotation] = generated.value.result.annotations;
  assert.equal(annotation.start, 3); assert.equal(raw.slice(annotation.start, annotation.end), annotation.quote);
  assert.equal(generated.value.source.text, raw); assert.equal(f.calls.length, 1);
});

test('emphasis results, warnings and immutable source survive restart without another model call', async t => {
  const tables = new Map(), first = fixture(t, { tables, script: options => {
    const source = inputOf(options).source, result = emphasis(source);
    result.annotations.push({ blockId: source.blocks[1].id, quote: '不存在的改写句子。', kind: 'next', importance: 2 }); return stream(result);
  } });
  await first.ready(); first.report(); const source = (await first.read()).value.source;
  const generated = await first.generate(source); assert.equal(generated.status, 200);
  assert.equal((await first.generate(source, 'cached-second')).status, 200); assert.equal(first.calls.length, 1);
  assert.deepEqual((await first.read()).value.result, generated.value.result); await first.dispose();
  const next = fixture(t, { tables }); await next.ready(); const restored = await next.read();
  assert.equal(restored.value.cached, true); assert.deepEqual(restored.value.result, generated.value.result);
  assert.deepEqual(restored.value.warnings, generated.value.warnings); assert.equal(restored.value.source.text, text);
  assert.equal(restored.value.source.hash, source.hash); assert.equal(next.calls.length, 0);
});

test('legacy card caches are not mistaken for annotated original reports', async t => {
  const tables = new Map(), first = fixture(t, { tables }); await first.ready(); first.report();
  const source = (await first.read()).value.source;
  const card = await first.generate(source, 'legacy-card', { presentation: 'summary' });
  assert.equal(card.status, 200); assert.equal(card.value.result.schemaVersion, 1); await first.dispose();
  const next = fixture(t, { tables }); await next.ready(); const opened = await next.read();
  assert.equal(opened.value.available, true); assert.equal(opened.value.cached, false); assert.equal(opened.value.result, undefined);
  assert.equal(opened.value.source.text, text); assert.equal(next.calls.length, 0);
  const marked = await next.generate(opened.value.source); assert.equal(marked.status, 200);
  assert.equal(marked.value.result.schemaVersion, 2); assert.equal(next.calls.length, 1);
  const legacyRead = await next.read('s', 10, 'summary'); assert.equal(legacyRead.value.cached, false);
  assert.equal(legacyRead.value.result, undefined, 'old clients cannot consume annotation data as a card result');
});

test('one request identity cannot be reused for a different report presentation', async t => {
  const f = fixture(t); await f.ready(); f.report(); const source = (await f.read()).value.source;
  assert.equal((await f.generate(source, 'fixed-id')).status, 200);
  const conflict = await f.generate(source, 'fixed-id', { presentation: 'summary' });
  assert.equal(conflict.status, 409); assert.equal(f.calls.length, 1);
});

test('invalid annotation structure and failed saves preserve the previous usable annotation cache', async t => {
  let broken = false, writing = false;
  const f = fixture(t, { script: options => { const source = inputOf(options).source;
    return stream(broken ? { schemaVersion: 2, annotations: [], execute: 'UNTRUSTED_ACTION' } : emphasis(source)); },
    failWrite: (_, id) => writing && id === JSON.stringify(['report-views', 's']) });
  await f.ready(); f.report(); const source = (await f.read()).value.source;
  const first = await f.generate(source); assert.equal(first.status, 200);
  broken = true; const invalid = await f.generate(source, 'broken-result', { regenerate: true });
  assert.equal(invalid.status, 422); assert.ok(invalid.value.issue); assert.doesNotMatch(JSON.stringify(invalid.value), /UNTRUSTED_ACTION/);
  assert.deepEqual((await f.read()).value.result, first.value.result);
  broken = false; writing = true; const failure = await f.generate(source, 'failed-save', { regenerate: true });
  assert.equal(failure.status, 503); assert.deepEqual((await f.read()).value.result, first.value.result);
  assert.equal(f.calls.length, 3);
});

test('exact cancellation and tombstones stop annotations without cancelling another report', async t => {
  const gate = deferred(); const f = fixture(t, { script: options => (async function* () { await gate.promise; yield* stream(emphasis(inputOf(options).source)); })() });
  await f.ready(); f.report(); f.report(text, 'other'); const source = (await f.read()).value.source;
  const other = (await f.read('other')).value.source;
  const pending = f.generate(source, 'same-name'), surviving = f.generate(other, 'other-request'); await flush();
  assert.equal((await f.request('report-visualization', { action: 'cancel', presentation: 'emphasis', sessionId: 's', seq: 10, requestId: 'same-name' })).status, 200);
  const cancelled = await pending; assert.equal(cancelled.status, 409); gate.resolve();
  assert.equal((await surviving).status, 200); assert.equal((await f.read()).value.cached, false);
  await f.request('report-visualization', { action: 'cancel', presentation: 'emphasis', sessionId: 's', seq: 10, requestId: 'late' });
  assert.equal((await f.generate(source, 'late')).status, 409); assert.equal(f.calls.length, 2);
});

test('emphasis model lookup is included in deadline and cannot dispatch after timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gate = deferred(), f = fixture(t, { config: { visualizationProvider: 'chosen', visualizationModel: '', timeoutMs: 1000 }, listModels: () => gate.promise });
  await f.ready(); f.report(); const source = (await f.read()).value.source, pending = f.generate(source);
  await flush(); t.mock.timers.tick(1001); const timedOut = await pending;
  assert.equal(timedOut.status, 503); assert.equal(timedOut.value.error, 'report-timeout');
  gate.resolve([{ id: 'late' }]); await flush(); assert.equal(f.calls.length, 0);
});

test('unload drains a pending annotation lookup without a late model call', async t => {
  const gate = deferred(), f = fixture(t, { config: { visualizationProvider: 'chosen', visualizationModel: '' }, listModels: () => gate.promise });
  await f.ready(); f.report(); const source = (await f.read()).value.source, pending = f.generate(source);
  await flush(); await f.dispose(); const disposed = await pending; assert.ok(disposed.status >= 400);
  gate.resolve([{ id: 'late' }]); await flush(); assert.equal(f.calls.length, 0);
});
