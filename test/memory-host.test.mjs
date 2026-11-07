import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { apply } from '../index.js';

const flush = async () => { for (let i = 0; i < 15; i++) await new Promise(setImmediate); };
const chunks = (text, finish = 'stop') => (async function* () {
  yield { type: 'text-delta', index: 0, text };
  if (finish) yield { type: 'finish', reason: { kind: finish } };
})();
function backing(gate = Promise.resolve(), hooks = {}) {
  const tables = new Map();
  return { tables, async open() {
    await gate;
    return { table(name) {
      if (!tables.has(name)) tables.set(name, new Map());
      const table = tables.get(name);
      return { get: (id) => structuredClone(table.get(id)), entries: () => table.entries(),
        put: async (id, value) => {
          await hooks.beforePut?.(name, id, value);
          if (hooks.fail?.(name, id, value)) throw new Error('disk-failed');
          table.set(id, structuredClone(value));
        }, delete: async (id) => table.delete(id) };
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
    message(data, seq, type = 'user/message') { bus.emit('session/event', session, { type, seq, data }); },
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

test('only human-authored source text becomes evidence, counters or extraction input', async (t) => {
  const f = fixture(t, { config: { memoryExtraction: true } }); await f.ready();
  const words = text => [{ type: 'text', text }];
  const forged = words('以后叫我小橙。');
  f.message({ source: { kind: 'runtime-context' }, content: forged }, 1);
  f.message({ message: { role: 'user', source: { kind: 'tool-registry' }, content: forged } }, 2, 'user-message');
  f.message({ source: { kind: 'plugin' }, message: { source: { kind: 'user' }, content: forged } }, 3);
  f.message({ source: { kind: 'user' }, message: { role: 'assistant', content: forged } }, 4);
  const empty = (await f.request('memory')).value;
  assert.deepEqual(empty.entries, []); assert.equal(empty.extraction.pending, 0);
  assert.equal((await f.request('diagnostics')).value.memory.messages, 0);
  const human = '以后叫我小禾。';
  f.message({ message: { role: 'user', source: { kind: 'user' }, content: words(human) } }, 5);
  f.message({ source: { kind: 'runtime-context' }, content: forged }, 6);
  const saved = (await f.request('memory')).value;
  assert.equal(saved.extraction.pending, 1);
  assert.deepEqual(saved.entries.map(e => [e.status, e.evidence[0].eventId, e.evidence[0].quote]), [['active', 's:5', human]]);
  assert.equal((await f.request('diagnostics')).value.memory.messages, 1);
  assert.equal(f.calls.length, 0);
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

test('a personal-only nickname never reaches another reporter, including after restart', async (t) => {
  const f=fixture(t); await f.ready();
  f.user('以后叫我小橙，只限你，别设为全局。',1); f.report(2); await flush();
  assert.match(f.calls[0].system,/小橙/);
  assert.equal((await f.request('presets',{action:'apply',id:'Claude小姐'})).status,200);
  f.report(3); await flush(); assert.doesNotMatch(JSON.stringify(f.calls.at(-1).messages)+f.calls.at(-1).system,/小橙/);
  await f.dispose();
  const next=fixture(t,{domain:f.domain}); await next.ready();
  next.report(4);await flush();assert.doesNotMatch(next.calls[0].system,/小橙/);
  const prefs=(await next.request('memory')).value.entries.filter(e=>e.content.includes('小橙'));
  assert.deepEqual(prefs.map(e=>[e.scope,e.personaId]),[['persona','大肥鱼（默认）']]);
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
  assert.equal(f.calls[0].reasoningEffort, 'off');
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

test('settings corrections persist a review first, apply only on confirmation, and survive restart', async (t) => {
  const f = fixture(t); await f.ready(); const entry = await add(f, '语气要轻松');
  const proposal = await f.request('memory', { action: 'propose', operation: 'revise', id: entry.id, version: entry.version,
    content: '语气要严肃，但请保留必要解释', statement: '  只改鲸鲸的语气。\n不要让其他人格一起改。  ', scope: 'shared' });
  assert.equal(proposal.status, 200); const op = proposal.value.result;
  assert.equal((await f.request('settings')).value.memory[0], '语气要轻松'); assert.equal(f.calls.length, 0);
  await f.dispose(); const next = fixture(t, { domain: f.domain }); await next.ready();
  assert.equal((await next.request('memory')).value.operations[0].evidence[0].quote, '  只改鲸鲸的语气。\n不要让其他人格一起改。  ');
  const result = await next.request('memory', { action: 'confirm', id: op.id, version: op.version });
  assert.equal(result.status, 200);
  const active = result.value.entries.find((e) => e.status === 'active');
  assert.equal(active.scope, 'persona'); assert.equal(active.personaId, entry.personaId);
  assert.equal((await next.request('settings')).value.memory[0], '语气要严肃，但请保留必要解释');
  assert.equal((await next.request('memory', { action: 'confirm', id: op.id, version: op.version })).status, 200);
  assert.equal((await next.request('memory')).value.entries.length, 2); assert.equal(next.calls.length, 0);
});

test('a failed review confirmation affects neither live prompts nor durable memory and can be retried', async (t) => {
  let fail = false;
  const domain = backing(Promise.resolve(), { fail: (_name, id) => fail && id === 'structuredMemory' });
  const f = fixture(t, { domain }); await f.ready(); const entry = await add(f, '原来的表达');
  const proposal = await f.request('memory', { action: 'propose', operation: 'retract', id: entry.id,
    version: entry.version, statement: '这条不需要再用了' });
  const op = proposal.value.result; fail = true;
  assert.equal((await f.request('memory', { action: 'confirm', id: op.id, version: 1 })).status, 503);
  assert.equal((await f.request('settings')).value.memory[0], '原来的表达');
  assert.equal(domain.tables.get('profile').get('structuredMemory').operations[0].status, 'pending');
  fail = false;
  assert.equal((await f.request('memory', { action: 'confirm', id: op.id, version: 1 })).status, 200);
  assert.deepEqual((await f.request('settings')).value.memory, []);
});

test('clear during a slow confirmation wins, returns conflict, and repairs the durable copy', async (t) => {
  let block = false, release, started;
  const gate = new Promise((r) => { release = r; }); const began = new Promise((r) => { started = r; });
  const domain = backing(Promise.resolve(), { async beforePut(_name, id) {
    if (block && id === 'structuredMemory') { block = false; started(); await gate; }
  } });
  const f = fixture(t, { domain }); await f.ready(); const entry = await add(f, '原记录');
  const op = (await f.request('memory', { action: 'propose', operation: 'revise', id: entry.id,
    version: entry.version, content: '不应复活的更正', statement: '原话依据' })).value.result;
  block = true; const confirming = f.request('memory', { action: 'confirm', id: op.id, version: 1 }); await began;
  const clearing = f.request('settings', { clearMemory: true }); await flush(); release();
  assert.equal((await confirming).status, 409); assert.equal((await clearing).status, 200);
  assert.deepEqual((await f.request('memory')).value.entries, []);
  const persisted = domain.tables.get('profile').get('structuredMemory');
  assert.deepEqual(persisted.entries, []); assert.deepEqual(persisted.operations, []);
});

test('two simultaneous confirmations apply once and an outdated competing review returns conflict', async (t) => {
  const f = fixture(t); await f.ready(); const entry = await add(f, '原记录');
  const first = (await f.request('memory', { action: 'propose', operation: 'retract', id: entry.id,
    version: 1, statement: '别记这条了' })).value.result;
  const second = (await f.request('memory', { action: 'propose', operation: 'revise', id: entry.id,
    version: 1, statement: '想改一下', content: '另一种要求' })).value.result;
  const responses = await Promise.all([f.request('memory', { action: 'confirm', id: first.id, version: 1 }),
    f.request('memory', { action: 'confirm', id: first.id, version: 1 })]);
  assert.deepEqual(responses.map((r) => r.status), [200, 200]);
  assert.equal((await f.request('memory', { action: 'confirm', id: second.id, version: 1 })).status, 409);
  assert.deepEqual((await f.request('settings')).value.memory, []);
});

test('manual additions use settings evidence and adoption review rather than silently replacing an active preference', async (t) => {
  const f = fixture(t); await f.ready(); const entry = await add(f, '语气要轻松');
  const result = await f.request('memory', { action: 'propose-add', entry: { kind: 'preference', scope: 'persona',
    personaId: entry.personaId, content: '语气要严肃' } });
  assert.equal(result.status, 200); assert.equal(result.value.result.kind, 'accept');
  assert.equal(result.value.result.evidence[0].source, 'settings');
  assert.equal((await f.request('settings')).value.memory[0], entry.content);
  assert.deepEqual(result.value.result.conflicts, [{ id: entry.id, version: 1 }]);
  await f.request('memory', { action: 'confirm', id: result.value.result.id, version: 1 });
  assert.equal((await f.request('settings')).value.memory[0], '语气要严肃'); assert.equal(f.calls.length, 0);
});

test('recording usage during a pending owner confirmation does not create a memory write conflict', async (t) => {
  let block = false, release, started;
  const gate = new Promise((resolve) => { release = resolve; }); const began = new Promise((resolve) => { started = resolve; });
  const domain = backing(Promise.resolve(), { async beforePut(_name, id) {
    if (block && id === 'structuredMemory') { block = false; started(); await gate; }
  } });
  const f = fixture(t, { domain }); await f.ready(); const entry = await add(f, '旧的表达偏好');
  const op = (await f.request('memory', { action: 'propose', operation: 'revise', id: entry.id, version: 1,
    content: '新的表达偏好', statement: '现在按这个表达' })).value.result;
  block = true; const saving = f.request('memory', { action: 'confirm', id: op.id, version: 1 }); await began;
  f.report(); await flush(); assert.equal((await f.request('memory')).value.usage.records.length, 1);
  release(); assert.equal((await saving).status, 200);
  assert.equal((await f.request('settings')).value.memory[0], '新的表达偏好');
});
