import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { apply } from '../index.js';

const flush = async () => { for (let i = 0; i < 15; i++) await new Promise(setImmediate); };
const chunks = (text, finish = 'stop') => (async function* () {
  yield { type: 'text-delta', index: 0, text };
  if (finish) yield { type: 'finish', reason: { kind: finish } };
})();
function backing(gate = Promise.resolve()) {
  const tables = new Map();
  return { tables, async open() {
    await gate;
    return { table(name) {
      if (!tables.has(name)) tables.set(name, new Map());
      const table = tables.get(name);
      return { get: (id) => structuredClone(table.get(id)), entries: () => table.entries(),
        put: async (id, value) => { table.set(id, structuredClone(value)); }, delete: async (id) => table.delete(id) };
    }, close: async () => {} };
  } };
}
function fixture(t, { domain = backing(), script, config = {}, listModels } = {}) {
  const bus = new EventEmitter(); const disposers = []; const routes = []; const calls = [];
  const services = new Map([['storageDomain', domain],
    ['webServer', { register(value) { routes.push(value); return () => {}; } }],
    ['connection', { requestRejection: ({ headers }) => headers.authorization === 'owner' ? undefined : 403 }],
    ['llm', { listModels: listModels ?? (async () => [{ id: 'm' }]), stream(options) {
      calls.push(options); return script?.(options) ?? chunks('原始汇报的另一种说法。');
    } }]]);
  apply({ get: (id) => services.get(id),
    on(type, fn) { bus.on(type, fn); return () => bus.off(type, fn); },
    inject(names, fn) { if (names.every((id) => services.has(id))) fn({ get: (id) => services.get(id) }); },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
    logger: { warn() {} },
  }, { provider: 'p', model: 'm', ...config });
  let disposed = false;
  const dispose = async () => {
    if (disposed) return; disposed = true;
    for (const stop of [...disposers].reverse()) await stop();
  };
  t.after(dispose);
  async function request(path, body, authenticated = true) {
    let status; let value;
    await routes[0].handler({ url: '/persona-shell/' + path,
      method: body === undefined ? 'GET' : 'POST', headers: { authorization: authenticated ? 'owner' : '' },
      async *[Symbol.asyncIterator]() { yield JSON.stringify(body); } },
    { writeHead(code) { status = code; }, end(text) { value = JSON.parse(text); } });
    return { status, value };
  }
  const session = { id: 's', header: {}, append() { assert.fail('memory never writes to working sessions'); } };
  return { request, domain, calls, dispose,
    async ready() { await flush(); assert.equal((await request('diagnostics')).value.storage, 'open'); },
    user(text, seq = 1, other = session) {
      bus.emit('session/event', other, { type: 'user/message', seq,
        data: { content: [{ type: 'text', text }] } });
    },
    report(seq = 50) {
      bus.emit('session/event', session, { type: 'assistant/message', seq,
        data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: '原始汇报。' }] } } });
    },
    async persona() {
      const result = await request('presets'); return result.value.presets[0].id;
    },
  };
}
async function add(f, content, extra = {}) {
  const response = await f.request('memory', { action: 'add', entry: {
    kind: 'preference', scope: 'persona', personaId: await f.persona(), content, ...extra,
  } });
  assert.equal(response.status, 200); return response.value.result;
}

test('memory management requires authentication and refuses mutations before storage restoration', async (t) => {
  let release;
  const f = fixture(t, { domain: backing(new Promise((resolve) => { release = resolve; })) });
  assert.equal((await f.request('memory', undefined, false)).status, 403);
  assert.equal((await f.request('memory', { action: 'add', entry: {} })).status, 503);
  release(); await f.ready();
});

test('management persists immediately, restores on restart, and protects updates with entry versions', async (t) => {
  const f = fixture(t); await f.ready();
  const entry = await add(f, '称呼我为阿晴');
  assert.ok(f.domain.tables.get('profile').get('structuredMemory').entries.some((e) => e.id === entry.id));
  const updated = await f.request('memory', { action: 'update', id: entry.id, version: entry.version,
    content: '称呼我为小晴', pinned: true });
  assert.equal(updated.status, 200);
  assert.equal((await f.request('memory', { action: 'delete', id: entry.id, version: entry.version })).status, 409);
  await f.dispose();
  const next = fixture(t, { domain: f.domain }); await next.ready();
  assert.equal((await next.request('memory')).value.entries[0].content, '称呼我为小晴');
});

test('user evidence deduplicates across replays; assistant and subagent messages do not become user memory', async (t) => {
  const f = fixture(t); await f.ready();
  f.user('简洁一点', 1); f.user('简洁一点', 1);
  f.user('语气要轻松', 2, { id: 'child', header: { delegationDepth: 1, origin: 'subagent' } });
  f.report(); await flush();
  assert.equal((await f.request('memory')).value.entries.length, 1);
  assert.equal((await f.request('diagnostics')).value.memory.messages, 1);
  assert.equal(f.calls.length, 1, 'background model extraction remains off by default');
  assert.match(f.calls[0].system, /简洁一点/);
});

test('only relevant preferences reach rewrites; saved episodes and other persona preferences stay out', async (t) => {
  const f = fixture(t); await f.ready();
  await add(f, '称呼我为阿晴');
  await add(f, '不应插入正文的历史经历', { kind: 'episode' });
  const presets = (await f.request('presets')).value.presets;
  await add(f, '另一个人格的私有偏好', { personaId: presets[1].id });
  f.report(); await flush();
  const prompt = f.calls.at(-1).system;
  assert.match(prompt, /称呼我为阿晴/);
  assert.doesNotMatch(prompt, /不应插入正文的历史经历|另一个人格的私有偏好/);
  assert.match(prompt, /不得据此把历史经历/);
});

test('background extraction consumes exact quoted evidence and stores only candidates', async (t) => {
  const f = fixture(t, { config: { memoryExtraction: true }, script(options) {
    const source = JSON.parse(options.messages[0].content[0].text).sources[0];
    return chunks(JSON.stringify({ entries: [{ kind: 'preference', scope: 'persona',
      content: '喜欢先看结论', evidence: [{ eventId: source.id, quote: source.text }] }] }));
  } });
  await f.ready();
  for (let i = 1; i <= 8; i++) f.user('我希望先看到核心结果再展开', i);
  await flush();
  const state = (await f.request('memory')).value;
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].tools, undefined);
  assert.equal(state.entries[0].status, 'candidate');
  assert.equal(state.extraction.pending, 0);
  assert.deepEqual((await f.request('settings')).value.memory, []);
});

test('clear cancels a blocked stream and prevents late extraction results and persisted legacy text', async (t) => {
  let release; let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const began = new Promise((resolve) => { started = resolve; });
  const f = fixture(t, { config: { memoryExtraction: true }, script(options) {
    const source = JSON.parse(options.messages[0].content[0].text).sources[0];
    return (async function* () {
      started(options.signal); await gate;
      yield* chunks(JSON.stringify({ entries: [{ kind: 'preference', scope: 'persona',
        content: '不应复活', evidence: [{ eventId: source.id, quote: source.text }] }] }));
    })();
  } });
  await f.ready(); f.user('简洁一点');
  await f.request('memory', { action: 'consolidate' });
  const signal = await began;
  await f.request('settings', { clearMemory: true });
  assert.equal(signal.aborted, true);
  release(); await flush(); await f.dispose();
  const persisted = JSON.stringify([...f.domain.tables.get('profile')]);
  assert.doesNotMatch(persisted, /简洁一点|不应复活/);
});

test('a session opt-out cancels its pending memory extraction and discards its queued excerpts', async (t) => {
  let release; let signal;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture(t, { config: { memoryExtraction: true }, script(options) {
    signal = options.signal;
    return (async function* () { await gate; yield* chunks('{"entries":[]}'); })();
  } });
  await f.ready(); f.user('我希望先说结果');
  await f.request('memory', { action: 'consolidate' });
  await flush();
  await f.request('session-switch', { sessionId: 's', enabled: false });
  assert.equal(signal.aborted, true); release(); await flush();
  assert.equal((await f.request('memory')).value.extraction.pending, 0);
});

test('truncated background extraction retains the batch without creating memory', async (t) => {
  const f = fixture(t, { config: { memoryExtraction: true }, script: () => chunks('{"entries":[]}', 'max-tokens') });
  await f.ready(); f.user('我更习惯这种表达');
  await f.request('memory', { action: 'consolidate' }); await flush();
  const value = (await f.request('memory')).value;
  assert.equal(value.entries.length, 0); assert.equal(value.extraction.pending, 1);
  assert.equal(value.extraction.status, 'failed');
});

test('handoff routes require a receiver/session and reject private memory exports', async (t) => {
  const f = fixture(t); await f.ready();
  const presets = (await f.request('presets')).value.presets;
  const entry = await add(f, '角色私有内容');
  const body = { action: 'create', fromPersonaId: presets[0].id, toPersonaId: presets[1].id,
    sessionId: 's', summary: '用户希望接着讨论方案', memoryIds: [entry.id] };
  assert.equal((await f.request('memory/handoffs', body)).status, 400);
  const created = await f.request('memory/handoffs', { ...body, memoryIds: [] });
  assert.equal(created.status, 200);
  assert.equal((await f.request('memory/handoffs')).status, 400);
  const other = await f.request('memory/handoffs?session=other&persona=' + presets[1].id);
  assert.deepEqual(other.value.handoffs, []);
  const result = await f.request('memory/handoffs?session=s&persona=' + presets[1].id);
  assert.equal(result.value.handoffs.length, 1);
  assert.deepEqual(result.value.handoffs[0].memories, []);
});

test('unloading during memory route discovery drains locally and never dispatches a late model call', async (t) => {
  let release;
  const catalog = new Promise((resolve) => { release = resolve; });
  const f = fixture(t, { config: { memoryExtraction: true, model: '' }, listModels: () => catalog });
  await f.ready(); f.user('我更喜欢先看结论');
  await f.request('memory', { action: 'consolidate' });
  await f.dispose();
  release([{ id: 'late' }]); await flush();
  assert.equal(f.calls.length, 0);
  assert.equal(f.domain.tables.get('profile').get('structuredMemory').queue.length, 1);
});

test('clearing preferences aborts a rewrite using old memory and removes its tone samples', async (t) => {
  let release; let began;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { began = resolve; });
  let block = true;
  const f = fixture(t, { script(options) {
    if (!block) return chunks('原始汇报的另一种说法。');
    return (async function* () { began(options.signal); await gate; yield* chunks('旧称呼不应该留下。'); })();
  } });
  await f.ready(); await add(f, '称呼我为阿晴');
  f.report(); const signal = await started;
  await f.request('settings', { clearMemory: true });
  assert.equal(signal.aborted, true);
  release(); await flush(); block = false;
  f.report(51); await flush();
  assert.doesNotMatch(f.calls.at(-1).system, /阿晴|旧称呼不应该留下/);
  assert.equal(f.domain.tables.get('profile').get('structuredMemory').entries.length, 0);
});

test('a stored session opt-out cannot resume pending extraction after restart', async (t) => {
  const first = fixture(t, { config: { memoryExtraction: true } }); await first.ready();
  first.user('我更喜欢先看结论');
  await first.dispose();
  first.domain.tables.get('profile').set('sessionSwitches', { rev: 1, values: { s: false } });
  const next = fixture(t, { domain: first.domain, config: { memoryExtraction: true } }); await next.ready();
  assert.equal((await next.request('memory')).value.extraction.pending, 0);
  assert.equal(next.calls.length, 0);
});
