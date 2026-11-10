import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { apply } from '../index.js';

const flush = async () => { for (let i = 0; i < 24; i++) await new Promise(setImmediate); };
const raw = [
  '本轮修改已经完成。',
  '背景资料按来源逐项排列，方便之后追溯界面的设计过程。',
  '缓存层按输入顺序读取数据，展示层按照既定顺序绘制界面。',
  '补充记录介绍了组件名称、布局来源和页面之间的联系。',
  '只有启用 `0.5.0` 对应配置后才可使用；否则仍需保留原有流程。',
  '生产环境尚未验证，发布前仍需人工核对。',
  '需要你确认是否采用这个方案。',
  '```sh\nnode --test test/report-reading.test.mjs\n```',
  '另有一段普通说明，完整展示组件之间的联系。',
].join('\n\n');
const inputOf = options => JSON.parse(options.messages[0].content[0].text);
const stream = value => (async function* () {
  yield { type: 'text-delta', text: JSON.stringify(value) };
  yield { type: 'usage', usage: { inputTokens: 13, outputTokens: 8 } };
  yield { type: 'finish', reason: { kind: 'stop' } };
})();
const annotation = source => ({ blockId: source.blocks[0].id, quote: '本轮修改已经完成。', kind: 'conclusion', importance: 1 });
const reading = (blockId, role = 'detail', importance = 3, relatedRefs = []) => ({ blockId, role, importance, relatedRefs });
const output = source => ({ schemaVersion: 2, annotations: [annotation(source)], reading: [
  reading(source.blocks[0].id, 'result', 1),
  ...source.blocks.slice(1, -1).map(block => reading(block.id)),
] });

function fixture(t, { tables = new Map(), script = options => stream(output(inputOf(options).source)) } = {}) {
  const bus = new EventEmitter(), routes = [], disposers = [], calls = [], appended = [];
  const services = new Map([
    ['storageDomain', { async open() { return { table(name) {
      if (!tables.has(name)) tables.set(name, new Map()); const own = tables.get(name);
      return { get: id => structuredClone(own.get(id)), entries: () => own.entries(),
        async put(id, value) { own.set(id, structuredClone(value)); }, async delete(id) { own.delete(id); } };
    }, async close() {} }; } }],
    ['webServer', { register(route) { routes.push(route); return () => {}; } }],
    ['connection', { requestRejection: ({ headers }) => headers.authorization === 'owner' ? undefined : 403 }],
    ['llm', { async listModels() { return [{ id: 'reading-model' }]; },
      async resolveModelInfo() { return { reasoning: { efforts: [{ id: 'off' }, { id: 'low' }] } }; },
      stream(options) { calls.push(options); return script(options, calls.length); } }],
  ]);
  const ctx = { get: name => services.get(name), logger: { warn() {} },
    on(name, handler) { bus.on(name, handler); return () => bus.off(name, handler); },
    inject(names, callback) { if (names.every(name => services.has(name))) callback(ctx); },
    effect(callback) { const stop = callback(); if (typeof stop === 'function') disposers.push(stop); } };
  apply(ctx, { provider: 'local', model: 'reading-model', memory: false });
  let disposed;
  const dispose = () => disposed ??= (async () => { for (const stop of [...disposers].reverse()) await stop(); })();
  t.after(dispose);
  const request = async (path, body, auth = true) => {
    let status, value;
    await routes[0].handler({ url: '/persona-shell/' + path, method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: auth ? 'owner' : '' }, async *[Symbol.asyncIterator]() { if (body !== undefined) yield JSON.stringify(body); } },
    { writeHead(code) { status = code; }, end(wire) { value = JSON.parse(wire); } });
    return { status, value };
  };
  const event = (type, seq, data, sessionId) => bus.emit('session/event', { id: sessionId, header: {},
    append(message) { appended.push(message); } }, { type, seq, data });
  const report = (text = raw, sessionId = 's', seq = 10) => {
    event('turn/start', seq - 1, { turn: 1 }, sessionId);
    event('assistant/message', seq, { turn: 1, message: { content: [{ type: 'text', text }] } }, sessionId);
    event('turn/end', seq + 1, { turn: 1, reason: { kind: 'completed' } }, sessionId);
  };
  const read = (sessionId = 's', seq = 10) => request('report-visualization?session=' + encodeURIComponent(sessionId) + '&seq=' + seq + '&presentation=emphasis');
  const generate = (source, requestId = 'reading-one', extra = {}) => request('report-visualization', {
    action: 'generate', sessionId: source.sessionId, seq: source.seq, sourceHash: source.hash,
    presentation: 'emphasis', requestId, ...extra });
  const ready = async () => { await flush(); assert.equal((await request('settings', { enabled: false })).status, 200); await flush(); };
  return { ready, report, read, generate, request, calls, tables, appended, dispose };
}

const entry = (value, id) => value.readingPlan.entries.find(item => item.blockId === id);
const assertOriginal = (value, source) => {
  assert.equal(value.source.text, source.text); assert.equal(value.source.hash, source.hash);
  assert.equal(value.source.blocks.map(block => block.text).join(''), source.text);
  assert.equal(value.readingPlan.sourceHash, source.hash);
  assert.deepEqual(value.readingPlan.entries.map(item => item.blockId), source.blocks.map(block => block.id));
  for (const item of value.readingPlan.entries) assert.equal(source.text.slice(item.start, item.end), source.blocks.find(block => block.id === item.blockId).text);
};

test('opening a report derives a source-ordered safe reading plan without dispatch or work-history writes', async t => {
  const f = fixture(t); await f.ready(); f.report();
  assert.equal((await f.request('report-visualization?session=s&seq=10&presentation=emphasis', undefined, false)).status, 403);
  const opened = await f.read(); assert.equal(opened.status, 200);
  assertOriginal(opened.value, opened.value.source);
  assert.ok(opened.value.readingPlan.entries.every(item => item.keep && !item.foldable));
  assert.equal(opened.value.cached, false); assert.equal(opened.value.result, undefined);
  assert.equal(f.calls.length, 0); assert.deepEqual(f.appended, []);
  assert.deepEqual((await f.read()).value.readingPlan, opened.value.readingPlan);
  assert.equal(f.calls.length, 0, 'reading and local plan derivation never repair via another model');
});

test('manual reading analysis stays grounded in original blocks and keeps conditions, code and unknown passages visible', async t => {
  const f = fixture(t); await f.ready(); f.report(); const source = (await f.read()).value.source;
  const generated = await f.generate(source); assert.equal(generated.status, 200); assertOriginal(generated.value, source);
  assert.equal(generated.value.result.schemaVersion, 2); assert.ok(generated.value.result.reading.length);
  for (const block of source.blocks.filter(block => /只有|尚未|需要你确认|node --test|普通说明/u.test(block.text))) {
    assert.equal(entry(generated.value, block.id).keep, true, block.text);
    assert.equal(entry(generated.value, block.id).foldable, false, block.text);
  }
  assert.ok(generated.value.readingPlan.navigation.some(item => item.kind === 'risk'), 'source conditions remain reachable even when a model calls them detail');
  assert.ok(generated.value.readingPlan.navigation.some(item => item.kind === 'decision'), 'an explicit user confirmation is part of the original-text guide');
  assert.equal(f.calls.length, 1); assert.deepEqual(f.appended, []);
  const input = inputOf(f.calls[0]); assert.equal(input.task, 'report-emphasis');
  assert.deepEqual(Object.keys(input).sort(), ['source', 'task']);
  assert.equal(input.source.blocks.map(block => block.text).join(''), raw);
  assert.doesNotMatch(JSON.stringify(input), /history|persona|privateMemory|preferences/);
  assert.match(f.calls[0].system, /reading/);
  assert.equal(f.calls[0].reasoningEffort, 'off');
  assert.equal((await f.request('memory')).value.entries.length, 0);
  assert.equal((await f.request('model-usage')).value.purposes.find(row => row.purpose === 'report-visualization')?.calls, 1);
});

test('only explicitly classified simple details can fold while related evidence stays attached to its result', async t => {
  const text = '本轮修改完成。\n\n补充实现说明。\n\n布局容器沿用固定定位，正文按原顺序输出。\n\n这段描述界面元素的排列方式，便于查看细节。\n\n真实环境尚未验证。';
  const f = fixture(t, { script: options => { const source = inputOf(options).source;
    return stream({ schemaVersion: 2, annotations: [], reading: [
      reading('b1', 'result', 1, ['b4']), reading('b2'), reading('b3'), reading('b4'), reading('b5', 'risk', 1),
    ] });
  } });
  await f.ready(); f.report(text); const source = (await f.read()).value.source, generated = await f.generate(source);
  assert.equal(generated.status, 200); assertOriginal(generated.value, source);
  assert.equal(entry(generated.value, 'b3').keep, false); assert.equal(entry(generated.value, 'b3').foldable, true);
  assert.equal(entry(generated.value, 'b3').matchText, '布局容器沿用固定定位，正文按原顺序输出。');
  assert.equal(entry(generated.value, 'b4').keep, true, 'a result dependency remains available even when classified as detail');
  assert.equal(entry(generated.value, 'b5').foldable, false);
  assert.deepEqual(generated.value.readingPlan.navigation.filter(item => ['result', 'risk'].includes(item.kind)).map(item => item.blockId), ['b1', 'b5']);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.appended, []);
});

test('English prerequisite clauses remain visible even when a model classifies them as optional details', async t => {
  const text = ['The work is complete.',
    'This feature is available provided that the client is restarted.',
    'The cached result is valid subject to source integrity.',
    'The setting applies as long as the selected profile remains active.',
    'The feature stays inactive until the client is restarted.',
    'The workflow can resume when the owner approves.',
  ].join('\n\n');
  const f = fixture(t, { script: options => { const source = inputOf(options).source;
    return stream({ schemaVersion: 2, annotations: [], reading: source.blocks.map((block, index) => reading(block.id, index ? 'detail' : 'result', index ? 3 : 1)) });
  } });
  await f.ready(); f.report(text); const source = (await f.read()).value.source, generated = await f.generate(source);
  assert.equal(generated.status, 200); assertOriginal(generated.value, source);
  for (const block of source.blocks.slice(1)) {
    assert.equal(entry(generated.value, block.id).keep, true, block.text);
    assert.equal(entry(generated.value, block.id).foldable, false, block.text);
  }
  assert.equal(f.calls.length, 1); assert.deepEqual(f.appended, []);
});

test('classified reading metadata survives restart while the view plan is freshly derived without a model call', async t => {
  const tables = new Map(), first = fixture(t, { tables }); await first.ready(); first.report();
  const source = (await first.read()).value.source, generated = await first.generate(source);
  assert.equal(generated.status, 200); assert.equal((await first.generate(source, 'cached-second')).status, 200);
  assert.equal(first.calls.length, 1); await first.dispose();
  const record = [...tables.values()].flatMap(table => [...table.values()]).find(value => Array.isArray(value?.reports));
  assert.ok(record?.reports[0]?.result.reading?.length); assert.doesNotMatch(JSON.stringify(record), /readingPlan|foldable|matchText/);
  const next = fixture(t, { tables }); await next.ready(); const restored = await next.read();
  assert.equal(restored.status, 200); assert.equal(restored.value.cached, true); assertOriginal(restored.value, source);
  assert.deepEqual(restored.value.result.reading, generated.value.result.reading);
  assert.deepEqual(restored.value.readingPlan, generated.value.readingPlan);
  assert.equal(next.calls.length, 0); assert.deepEqual(next.appended, []);
});

test('annotation-only caches remain readable and keep every unclassified passage without automatic upgrading', async t => {
  const tables = new Map(), first = fixture(t, { tables, script: options => {
    const source = inputOf(options).source; return stream({ schemaVersion: 2, annotations: [annotation(source)] });
  } });
  await first.ready(); first.report(); const source = (await first.read()).value.source;
  assert.equal((await first.generate(source)).status, 200); await first.dispose();
  const next = fixture(t, { tables }); await next.ready(); const restored = await next.read();
  assert.equal(restored.value.cached, true); assertOriginal(restored.value, source);
  assert.equal(restored.value.result.annotations.length, 1);
  assert.ok(restored.value.readingPlan.entries.every(item => item.keep && !item.foldable));
  assert.equal(next.calls.length, 0);
  assert.equal((await next.generate(source, 'old-cache-open')).status, 200); assert.equal(next.calls.length, 0);
});

test('malformed or conflicting classifications and unknown dependencies cannot fold content or lose the report', async t => {
  const f = fixture(t, { script: options => {
    const source = inputOf(options).source;
    return stream({ schemaVersion: 2, annotations: [annotation(source)], reading: [
      reading(source.blocks[0].id, 'result', 1),
      reading('missing-private-block'),
      reading(source.blocks[1].id, 'detail', 3, ['missing-private-dependency']),
      reading(source.blocks[2].id), reading(source.blocks[2].id, 'risk', 1),
      { ...reading(source.blocks[3].id), html: 'UNTRUSTED_READING_WIDGET' },
      reading(source.blocks[7].id, 'execute-private-action', 3),
    ] });
  } });
  await f.ready(); f.report(); const source = (await f.read()).value.source, generated = await f.generate(source);
  assert.equal(generated.status, 200); assertOriginal(generated.value, source);
  assert.equal(generated.value.result.annotations.length, 1);
  assert.ok(generated.value.warnings?.length);
  assert.doesNotMatch(JSON.stringify(generated.value.result), /missing-private|execute-private|UNTRUSTED_READING_WIDGET/);
  for (const block of source.blocks.slice(1, 4)) assert.equal(entry(generated.value, block.id).foldable, false);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.appended, []);
});

test('a corrupted cached reading role cannot turn an unknown passage into folded content on restart', async t => {
  const tables = new Map(), first = fixture(t, { tables }); await first.ready(); first.report();
  const source = (await first.read()).value.source; assert.equal((await first.generate(source)).status, 200); await first.dispose();
  const saved = [...tables.values()].flatMap(table => [...table.values()]).find(value => Array.isArray(value?.reports));
  saved.reports[0].result.reading = [reading(source.blocks.at(-1).id, 'UNTRUSTED_ROLE', 3)];
  saved.reports[0].readingPlan = { entries: [{ blockId: source.blocks.at(-1).id, foldable: true, keep: false }] };
  const next = fixture(t, { tables }); await next.ready(); const restored = await next.read();
  assert.equal(restored.status, 200); assertOriginal(restored.value, source);
  assert.equal(entry(restored.value, source.blocks.at(-1).id).keep, true);
  assert.equal(entry(restored.value, source.blocks.at(-1).id).foldable, false);
  assert.doesNotMatch(JSON.stringify(restored.value.result), /UNTRUSTED_ROLE/);
  assert.equal(next.calls.length, 0);
});

test('reading classifications stay attached to their own report and cannot affect another source or session', async t => {
  const f = fixture(t); await f.ready(); f.report(); f.report('另一份原始报告，正文保持自己的顺序。\n\n尚未完成真实设备验收。', 'other');
  const source = (await f.read()).value.source; assert.equal((await f.generate(source)).status, 200);
  const untouched = await f.read('other'); assert.equal(untouched.status, 200);
  assert.notEqual(untouched.value.source.hash, source.hash); assert.equal(untouched.value.result, undefined);
  assert.ok(untouched.value.readingPlan.entries.every(item => item.keep && !item.foldable));
  assert.equal(f.calls.length, 1); assert.deepEqual(f.appended, []);
});
