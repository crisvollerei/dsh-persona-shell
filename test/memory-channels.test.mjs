import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { apply } from '../index.js';
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(setImmediate); };
const clocks = new WeakSet();
function domain() {
  const tables = new Map(); let failUsage = false;
  return { tables, fail: (value) => { failUsage = value; }, async open() { return { table(name) {
    if (!tables.has(name)) tables.set(name, new Map()); const own = tables.get(name);
    return { get: (id) => structuredClone(own.get(id)), entries: () => own.entries(), delete: async (id) => own.delete(id),
      async put(id, value) { if (failUsage && id === 'memoryUsage') throw Error('disk'); own.set(id, structuredClone(value)); } };
  }, close: async () => {} }; } };
}
const output = (text) => (async function* () { yield { type: 'text-delta', index: 0, text }; yield { type: 'finish', reason: { kind: 'stop' } }; })();
function fixture(t, { storage = domain(), config = {}, prepare } = {}) {
  if (!clocks.has(t)) { t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000000 }); clocks.add(t); }
  const bus = new EventEmitter(), disposers = [], calls = [], routes = [];
  const session = { id: 's', header: {}, append() { assert.fail('memory observation never enters the working conversation'); } };
  const agent = { session, status: 'running' };
  const llm = { resolveModelInfo: prepare ?? (async () => ({ reasoning: { efforts: [{ id: 'off' }, { id: 'low' }] } })), stream(options) {
    calls.push(options);
    if (options.tools) return (async function* () {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'usage', name: 'get_tool_usage', arguments: '{}' } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    })();
    if (options.messages.at(-1).role === 'tool') return output(JSON.stringify({ rewrite: '原始汇报的另一种说法。', process_note: '' }));
    return output(options.system.includes('独立的状态播报员') ? '还没有新的正文汇报，我在这里等消息。' : '原始汇报的另一种说法。');
  } };
  const services = new Map([['llm', llm], ['agents', { get: (id) => id === 's' ? agent : undefined }],
    ['storageDomain', storage], ['webServer', { register(value) { routes.push(value); return () => {}; } }]]);
  const ctx = { get: (key) => services.get(key), logger: { warn() {} },
    on(type, fn) { bus.on(type, fn); return () => bus.off(type, fn); },
    inject(keys, fn) { if (keys.every((key) => services.has(key))) fn(ctx); },
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); } };
  apply(ctx, { allowUnauthenticatedRoutes: true, provider: 'p', model: 'm', progressNotices: true,
    progressMinutes: 1, processToolUsage: true, ...config });
  let disposed = false;
  const dispose = async () => { if (!disposed) { disposed = true; for (const stop of [...disposers].reverse()) await stop(); } };
  t.after(dispose);
  const request = async (path, body) => {
    let status, value;
    await routes[0].handler({ url: '/persona-shell/' + path, method: body === undefined ? 'GET' : 'POST',
      async *[Symbol.asyncIterator]() { yield JSON.stringify(body); } },
    { writeHead(code) { status = code; }, end(raw) { value = JSON.parse(raw); } });
    return { status, value };
  };
  let seq = 0;
  const event = (type, data) => bus.emit('session/event', session, { type, seq: ++seq, data });
  const report = (process = false) => event('assistant/message', { turn: 1, message: { role: 'assistant', content: [
    { type: 'text', text: '原始汇报。' }, ...(process ? [{ type: 'tool-call', id: 'next' + seq, name: 'read', arguments: '{}' }] : []) ] } });
  return { request, calls, storage, llm, dispose, event, report, ready: flush,
    async quiet() { for (let i = 0; i < 2; i++) {
      await request('state?session=s&viewing=1&viewer=memory&viewRev=1'); t.mock.timers.tick(30000); await flush();
    } },
    usage: async () => (await request('memory')).value.usage.records,
  };
}
async function add(f, content, extra = {}) {
  const result = await f.request('memory', { action: 'add', entry: { kind: 'preference', scope: 'persona',
    personaId: '大肥鱼（默认）', content, ...extra } });
  assert.equal(result.status, 200); return result.value.result;
}

test('report, process continuation, one-off retry and quiet notice share scoped expression preferences', async (t) => {
  const f = fixture(t); await f.ready();
  const pref = await add(f, '不要提醒我休息'); await add(f, '叫我阿晴', { scope: 'shared' });
  await add(f, 'DRAGON_PRIVATE', { personaId: '大肥龙' }); await add(f, 'EPISODE_PRIVATE', { kind: 'episode' });
  await add(f, 'OTHER_SESSION', { scope: 'session', sessionId: 'other' });
  await f.request('memory', { action: 'propose-add', entry: { kind: 'preference', scope: 'persona',
    personaId: pref.personaId, content: 'UNCONFIRMED' } });
  f.event('turn/start', { turn: 1 }); f.report(); await flush();
  const row = (await f.request('state?session=s')).value.rows[0];
  assert.equal((await f.request('feedback', { sessionId: 's', seq: row.seq, version: row.version,
    personaId: row.speaker.id, scope: 'once', content: '措辞更克制' })).status, 200);
  f.event('tool/call', { turn: 1, callId: 'r', name: 'read', arguments: { secret: 'TOOL_BODY' } }); f.report(true); await flush();
  await f.quiet();
  const records = await f.usage(); assert.deepEqual(records.map((r) => r.channel), ['report', 'retry', 'process', 'progress']);
  assert.equal(f.calls.length, 5, 'four logical requests, including one process continuation');
  for (const call of f.calls) {
    assert.match(call.system, /不要提醒我休息/); assert.match(call.system, /叫我阿晴/);
    assert.doesNotMatch(call.system, /DRAGON_PRIVATE|EPISODE_PRIVATE|OTHER_SESSION|UNCONFIRMED|TOOL_BODY/);
  }
  assert.deepEqual(records.map((r) => [r.channel, r.selected.length, r.sentAt !== null, r.outcome]),
    ['report', 'retry', 'process', 'progress'].map((channel) => [channel, 2, true, 'generated']));
  assert.ok(records[0].omitted.some((ref) => ref.reason === 'candidate'));
  assert.equal(Object.hasOwn((await f.request('state?session=s')).value, 'usage'), false, 'usage is a settings-only view');
  await f.dispose();
  const stored = f.storage.tables.get('profile').get('memoryUsage');
  assert.doesNotMatch(JSON.stringify(stored), /不要提醒|叫我阿晴|原始汇报|TOOL_BODY/);
  const next = fixture(t, { storage: f.storage }); await next.ready();
  assert.equal((await next.usage()).length, 4);
});

test('memory disabled stops new usage recording and removes preferences from every expression prompt', async (t) => {
  const f = fixture(t); await f.ready(); await add(f, 'PRIVATE_EXPRESSION');
  f.event('turn/start', { turn: 1 }); f.report(); await flush();
  assert.equal((await f.usage()).length, 1);
  await f.request('settings', { memory: false }); f.report(true); await flush(); await f.quiet();
  assert.equal((await f.usage()).length, 1); assert.ok(f.calls.length >= 3);
  for (const call of f.calls.slice(1)) assert.doesNotMatch(call.system, /PRIVATE_EXPRESSION/);
});

test('model capability failure is recorded as selected but not provided, with no dispatch', async (t) => {
  const f = fixture(t, { prepare: async () => { throw Error('PRIVATE_ERROR_BODY'); } }); await f.ready();
  await add(f, '不会发出的偏好'); f.event('turn/start', { turn: 1 }); f.report(); await flush();
  const [record] = await f.usage(); assert.equal(record.selected.length, 1); assert.equal(record.sentAt, null);
  assert.equal(record.outcome, 'failed'); assert.equal(f.calls.length, 0);
  assert.doesNotMatch(JSON.stringify(record), /PRIVATE_ERROR_BODY/);
});

test('changing a preference aborts a pending quiet request and prevents late dispatch with old memory', async (t) => {
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture(t, { prepare: () => gate }); await f.ready(); const pref = await add(f, '旧的关心方式');
  f.event('turn/start', { turn: 1 }); await f.quiet();
  assert.equal((await f.usage())[0].outcome, 'pending');
  const op = (await f.request('memory', { action: 'propose', operation: 'retract', id: pref.id, version: 1, statement: '不需要了' })).value.result;
  await f.request('memory', { action: 'confirm', id: op.id, version: 1 }); await flush();
  release({ reasoning: { efforts: [{ id: 'off' }] } }); await flush();
  assert.equal(f.calls.length, 0); assert.equal((await f.usage())[0].outcome, 'cancelled');
  assert.equal((await f.usage())[0].sentAt, null);
});

test('clear during an outstanding request removes usage durably and late completion cannot recreate it', async (t) => {
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture(t, { prepare: () => gate }); await f.ready(); await add(f, '旧偏好');
  f.event('turn/start', { turn: 1 }); f.report(); await flush(); assert.equal((await f.usage()).length, 1);
  assert.equal((await f.request('settings', { clearMemory: true })).status, 200);
  release({}); await flush(); await f.dispose();
  assert.deepEqual(f.storage.tables.get('profile').get('memoryUsage').records, []);
});

test('usage persistence failures are visible in settings without changing report generation', async (t) => {
  const f = fixture(t); await f.ready(); await add(f, '不要省略必要条件'); f.storage.fail(true);
  f.event('turn/start', { turn: 1 }); f.report(); await flush(); t.mock.timers.tick(1500); await flush();
  assert.equal((await f.request('memory')).value.usage.persistence, 'failed');
  assert.equal((await f.request('state?session=s')).value.rows[0].status, 'ready');
  f.storage.fail(false); await f.dispose();
  assert.equal(f.storage.tables.get('profile').get('memoryUsage').records[0].outcome, 'generated');
});

test('quiet notices use the session-selected persona rather than the global default persona', async (t) => {
  const f = fixture(t); await f.ready(); await add(f, 'WHALE_ONLY');
  await add(f, 'DRAGON_ONLY', { personaId: '大肥龙' }); await add(f, 'SHARED_STYLE', { scope: 'shared' });
  const choice = (await f.request('conversation?session=s')).value;
  assert.equal((await f.request('conversation', { action: 'select', sessionId: 's', revision: choice.revision,
    personaId: '大肥龙', trigger: 'inherit' })).status, 200);
  f.event('turn/start', { turn: 1 }); await f.quiet();
  assert.equal(f.calls.length, 1); assert.match(f.calls[0].system, /DRAGON_ONLY/); assert.match(f.calls[0].system, /SHARED_STYLE/);
  assert.doesNotMatch(f.calls[0].system, /WHALE_ONLY/); assert.equal((await f.usage())[0].personaId, '大肥龙');
});
