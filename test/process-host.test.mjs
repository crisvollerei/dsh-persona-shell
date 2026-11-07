import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { apply } from '../index.js';
import { resolveConfig } from '../lib/config.js';

const tick = async () => { for (let i = 0; i < 12; i++) await new Promise(setImmediate); };
const textChunks = (text) => [{ type: 'text-delta', index: 0, text }, { type: 'finish', reason: { kind: 'stop' } }];
const queryChunks = () => [{ type: 'block-end', index: 0, block: {
  type: 'tool-call', id: 'usage', name: 'get_tool_usage', arguments: '{}',
} }, { type: 'finish', reason: { kind: 'tool-calls' } }];
function storage(saved = {}, gate = Promise.resolve()) {
  const tables = new Map([['profile', new Map([['settings', saved]])]]);
  return { tables, async open() {
    await gate;
    return { table(name) {
      if (!tables.has(name)) tables.set(name, new Map());
      const map = tables.get(name);
      return { get: (key) => map.get(key), entries: () => map.entries(),
        put: async (key, value) => map.set(key, structuredClone(value)), delete: async (key) => map.delete(key) };
    }, close: async () => {} };
  } };
}
function fixture(t, { config = {}, domain, script } = {}) {
  const bus = new EventEmitter(); const disposers = []; const routes = [];
  const calls = []; const observations = [];
  const llm = { stream(options) {
    calls.push(options);
    const chunks = script?.(options, calls.length) ?? (options.tools ? queryChunks() : options.messages.at(-1).role === 'tool'
      ? (() => {
        const facts = JSON.parse(options.messages.at(-1).content[0].text);
        observations.push(facts);
        const total = Object.values(facts.categories).reduce((sum, c) => sum + c.calls, 0);
        return textChunks(JSON.stringify({ rewrite: '接着看 [[0]]。', process_note: `哼，这段调用了${total}次工具。` }));
      })() : textChunks('接着看 [[0]]。'));
    return (async function* () { yield* chunks; })();
  } };
  const services = new Map([['llm', llm], ['webServer', { register(route) { routes.push(route); return () => {}; } }]]);
  if (domain) services.set('storageDomain', domain);
  const ctx = { get: (key) => services.get(key),
    on(name, listener) { bus.on(name, listener); return () => bus.off(name, listener); },
    inject(names, callback) { if (names.every((key) => services.has(key))) callback(ctx); return () => {}; },
    effect(fn) { const stop = fn(); if (typeof stop === 'function') disposers.push(stop); return stop; },
    logger: { warn() {} } };
  apply(ctx, { processToolUsage: true, provider: 'p', model: 'm', allowUnauthenticatedRoutes: true, ...config });
  let disposed = false;
  const dispose = async () => { if (!disposed) { disposed = true; await Promise.all(disposers.map((stop) => stop())); } };
  t.after(dispose);
  const session = { id: 'main', header: {}, append: () => assert.fail('must never write to the working session') };
  let seq = 0;
  let turn = 1;
  const emit = (type, data, override = {}) => {
    const event = { type, seq: ++seq, data, ...override }; bus.emit('session/event', session, event); return event;
  };
  const request = async (path, patch) => {
    const req = { url: '/persona-shell/' + path, method: patch === undefined ? 'GET' : 'POST',
      async *[Symbol.asyncIterator]() { yield JSON.stringify(patch); } };
    let result;
    await routes.find((r) => r.path === '/persona-shell').handler(req, {
      writeHead(code) { assert.equal(code, 200); }, end(body) { result = JSON.parse(body); },
    });
    return result;
  };
  return { calls, observations, session, dispose, emit, request,
    start: (next = 1) => { turn = next; return emit('turn/start', { turn }); },
    call: (id, name = 'read') => emit('tool/call', { turn, callId: id, name, arguments: { private: 'DO_NOT_SEND' } }),
    result: (id, isError = false) => emit('tool/result', { turn, message: { toolCallId: id, isError, content: 'DO_NOT_SEND' } }),
    report: (process = true, text = '接着看 `secret.js`。') => emit('assistant/message', { turn,
      message: { id: `message${seq + 1}`, source: { kind: 'model', provider: 'p', model: 'm' }, content: [
        { type: 'text', text }, ...(process ? [{ type: 'tool-call', id: 'next' + seq, name: 'read', arguments: '{}' }] : []),
      ] } }),
    state: () => request('state?session=main'),
  };
}

test('host supplies independent per-report counts and excludes all tool-informed history from final requests', async (t) => {
  const f = fixture(t); f.start();
  f.call('a', 'grep'); f.result('a'); const first = f.report(); await tick();
  f.call('a', 'grep'); f.result('a'); f.call('b', 'write_file'); const second = f.report(); await tick();
  f.result('b', true); const third = f.report(); await tick();
  assert.deepEqual(f.observations.map((x) => x.categories), [
    { search: { calls: 1, returned: 1, errors: 0, earlier_returns: 0 } },
    { edit: { calls: 1, returned: 0, errors: 0, earlier_returns: 0 } },
    { edit: { calls: 0, returned: 1, errors: 1, earlier_returns: 1 } },
  ]);
  const rows = (await f.state()).rows;
  assert.ok(f.calls.length > 1 && f.calls.every((call) => call.reasoningEffort === 'off'),
    'the initial process rewrite and every tool continuation prefer thinking off');
  assert.equal(rows.find((r) => r.seq === first.seq).processNote, '哼，这段调用了1次工具。');
  assert.equal(rows.find((r) => r.seq === second.seq).text, '接着看 `secret.js`。');
  assert.equal(rows.find((r) => r.seq === third.seq).status, 'ready');
  assert.doesNotMatch(JSON.stringify(f.calls), /secret\.js|DO_NOT_SEND/);
  const end = f.report(false); await tick();
  const options = f.calls.at(-1);
  assert.equal(options.tools, undefined);
  assert.doesNotMatch(options.system + JSON.stringify(options.messages), /get_tool_usage|process_note|这段调用|since_previous_process_report|session_pacing|work_nature|最近几段/);
  f.emit('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const final = (await f.state()).rows.find((r) => r.seq === end.seq);
  assert.equal(final.final, true);
  assert.equal(final.processNote, undefined);
  const reviewed = rows.find((r) => r.seq === first.seq).review;
  assert.equal(reviewed.editScore, 0, 'the separate aside contributes no wording distance');
});

test('unqueried and failed rewrites still advance the next counting window', async (t) => {
  let processCalls = 0; const got = [];
  const f = fixture(t, { script(options) {
    if (options.tools) {
      processCalls++;
      if (processCalls === 1) return textChunks(JSON.stringify({ rewrite: '接着看 [[0]]。', process_note: '' }));
      if (processCalls === 2) return [{ type: 'finish', reason: { kind: 'error' } }];
      return queryChunks();
    }
    got.push(JSON.parse(options.messages.at(-1).content[0].text));
    return textChunks(JSON.stringify({ rewrite: '接着看 [[0]]。', process_note: '' }));
  } });
  f.start(); f.call('one', 'grep'); f.report(); await tick();
  f.call('two', 'write'); const bad = f.report(); await tick();
  f.call('three', 'read'); f.report(); await tick();
  assert.deepEqual(got[0].categories, { read: { calls: 1, returned: 0, errors: 0, earlier_returns: 0 } });
  assert.equal((await f.state()).rows.find((r) => r.seq === bad.seq).status, 'skipped');
});

test('disabled, final-only, report-trigger and subagent paths never offer the function', async (t) => {
  assert.equal(resolveConfig({}).processToolUsage, false);
  assert.equal(resolveConfig({ processToolUsage: 'true' }).processToolUsage, false);
  for (const config of [{ processToolUsage: false }, { includeToolSteps: false }, { trigger: 'report' },
    { subagentSteps: true, subagentReports: true }]) {
    const f = fixture(t, { config });
    if (config.subagentSteps) f.session.header.delegationDepth = 1;
    f.start(); f.call('a', 'private_connector_name'); f.result('a'); f.report(); f.report(false);
    f.emit('turn/end', { turn: 1, reason: { kind: 'completed' } }); await tick();
    assert.ok(f.calls.length > 0);
    for (const options of f.calls) {
      assert.equal(options.tools, undefined);
      assert.doesNotMatch(options.system + JSON.stringify(options.messages), /private_connector_name|DO_NOT_SEND|本步语境|get_tool_usage|process_note|since_previous_process_report|session_pacing|work_nature/);
    }
  }
});

test('only a qualifying closing report can be submitted in report-only mode', async (t) => {
  const f = fixture(t, { config: { trigger: 'report', maxRewriteChars: 200 } });
  const end = turn => f.emit('turn/end', { turn, reason: { kind: 'completed' } });
  f.start(); f.report(false, '第一阶段，请稍等。');
  const long = f.report(false, '长'.repeat(201)); end(1);
  f.start(2); f.report(false, '第二阶段，请稍等。'); f.report(true); end(2);
  f.start(3); f.report(false, '第三阶段，请稍等。');
  f.emit('assistant/message', {turn:3, interrupted:true, message:{content:[{type:'text',text:'未写完'}]}}); end(3);
  f.start(4); f.report(false, '新要求之前的回答。');
  f.emit('user/message', {source:{kind:'user'},content:[{type:'text',text:'先处理另一个问题。'}]}); end(4);
  f.start(5); f.report(false, '未结束的旧轮。'); f.start(6); end(6);
  await tick(); assert.equal(f.calls.length, 0);
  const rows = (await f.state()).rows;
  assert.deepEqual(rows.filter(r => r.final).map(r => [r.seq,r.reason]), [[long.seq, 'too-long']]);
  f.start(7);
  const old = f.report(false, '旧草稿。'); const current = f.report(false, '最终结论。');
  f.emit(old.type, old.data, {seq:old.seq}); end(7); await tick();
  assert.equal(f.calls.length,1);
  assert.equal((await f.state()).rows.find(r => r.seq === current.seq)?.final,true);
  assert.match(f.calls[0].messages[0].content[0].text,/最终结论/);
});

test('opting into process observations shares the category, never the raw runtime tool identifier', async (t) => {
  const f = fixture(t);
  f.start(); f.call('sensitive-call', 'private_connector_name'); f.result('sensitive-call');
  f.report(true); await tick(); f.report(false); await tick();
  assert.equal(f.observations[0].categories.other.calls, 1);
  for (const call of f.calls) assert.doesNotMatch(JSON.stringify(call.messages), /private_connector_name|sensitive-call|DO_NOT_SEND|本步语境/);
  assert.equal(f.calls.at(-1).tools, undefined);
});

test('a truncated or failed working-model stream is never submitted for rewriting, even before turn/end', async (t) => {
  for (const trigger of ['step','report']) {
    const f = fixture(t, {config:{trigger}});
    for (const [i,kind] of ['max-tokens','error','aborted','unknown-finish'].entries()) {
      const turn=i+1; f.start(turn);
      const clipped=f.emit('assistant/message',{turn,message:{content:[{type:'text',text:'可以上线，但是如果'}]},
        stream:[{type:'chunk',time:100,chunk:{type:'finish',reason:{kind}}}]});
      await tick(); assert.equal(f.calls.length,0);
      f.emit('turn/end',{turn,reason:{kind:kind==='unknown-finish'?'completed':kind}});
      assert.equal((await f.state()).rows.some(r=>r.seq===clipped.seq&&r.final),false);
    }
    f.start(5);
    f.emit('assistant/message',{turn:5,message:{content:[{type:'text',text:'接着看 `secret.js`。'}]},
      stream:[{type:'chunk',time:120,chunk:{type:'finish',reason:{kind:'stop'}}}]});
    f.emit('turn/end',{turn:5,reason:{kind:'completed'}});await tick();assert.equal(f.calls.length,1);
  }
});

test('a closing event must confirm completion; a legacy length stop withdraws the step rewrite', async(t)=>{
  const f=fixture(t);
  for(const [index,kind] of ['blocked','aborted','error','max-tokens'].entries()){
    const turn=index+1;f.start(turn);
    const event=f.report(false);await tick();assert.equal((await f.state()).rows.at(-1).status,'ready');
    f.emit('turn/end',{turn,reason:{kind}});const row=(await f.state()).rows.find(r=>r.seq===event.seq);
    assert.notEqual(row.final,true);
    if(kind==='max-tokens'){assert.equal(row.status,'skipped');assert.equal(row.text,'');assert.equal(row.canRetry,false);}
  }
});

test('toggling global rewriting cannot promote the stale candidate of an unviewed session', async(t)=>{
  const f=fixture(t,{config:{trigger:'report'}});
  f.start();f.report(false,'关闭前的进展。');
  await f.request('settings',{enabled:false});f.report(false,'关闭期间的实际最终稿。');
  await f.request('settings',{enabled:true});
  f.emit('turn/end',{turn:1,reason:{kind:'completed'}});await tick();
  assert.equal(f.calls.length,0);assert.deepEqual((await f.state()).rows,[]);
  f.start(2);f.report(false);f.emit('turn/end',{turn:2,reason:{kind:'completed'}});await tick();
  assert.equal(f.calls.length,1);assert.equal((await f.state()).rows[0].final,true);
});

test('attachment-only steering invalidates the previous report without collecting memory or inspecting the attachment', async(t)=>{
  const f=fixture(t,{config:{trigger:'report'},domain:storage()});await tick();
  for(const [i,type] of ['image','file'].entries()){
    const turn=i+1;f.start(turn);f.report(false,'此前的结果。');
    f.emit('user/message',{source:{kind:'user'},content:[{type,get attachment(){assert.fail('attachment data must stay private');}}]});
    f.emit('turn/end',{turn,reason:{kind:'completed'}});await tick();
  }
  assert.equal(f.calls.length,0);assert.deepEqual((await f.state()).rows,[]);
  assert.equal((await f.request('diagnostics')).memory.messages,0);
  f.start(3);f.report(false);f.emit('user/message',{source:{kind:'runtime-context'},content:[{type:'image'}]});
  f.emit('turn/end',{turn:3,reason:{kind:'completed'}});await tick();assert.equal(f.calls.length,1);
});

test('a repeated source event cannot replace or reissue the in-flight row', async (t) => {
  const f = fixture(t); f.start(); f.call('a'); const report = f.report();
  f.emit(report.type, report.data, { seq: report.seq }); await tick();
  assert.equal(f.calls.length, 2);
  assert.equal((await f.state()).rows.filter((r) => r.seq === report.seq).length, 1);
});

test('turn note cap, body score and length validation remain independent', async (t) => {
  const f = fixture(t); f.start();
  for (let i = 0; i < 5; i++) { f.call('call' + i); f.result('call' + i); f.report(); await tick(); }
  const rows = (await f.state()).rows;
  assert.equal(rows.filter((r) => r.processNote).length, 3);
  assert.ok(rows.every((r) => r.text === '接着看 `secret.js`。' && r.review.editScore === 0));
  const long = fixture(t, { script: (o) => o.tools ? queryChunks()
    : textChunks(JSON.stringify({ rewrite: '字'.repeat(250), process_note: '忙起来啦。' })) });
  long.start(); long.call('one'); const event = long.report(); await tick();
  const failed = (await long.state()).rows.find((r) => r.seq === event.seq);
  assert.equal(failed.status, 'skipped'); assert.equal(failed.processNote, undefined);
});

test('turning the switch off aborts even a stalled provider and drops its pending note', async (t) => {
  let signal;
  const f = fixture(t, { script(options) {
    signal = options.signal;
    return { async *[Symbol.asyncIterator]() { await new Promise(() => {}); } };
  } });
  f.start(); f.call('a'); const event = f.report(); await tick();
  await f.request('settings', { processToolUsage: false }); await tick();
  assert.equal(signal.aborted, true);
  const row = (await f.state()).rows.find((r) => r.seq === event.seq);
  assert.equal(row.status, 'skipped'); assert.equal(row.processNote, undefined);
});

test('setting and separate notes persist and restore, without restoring live counters', async (t) => {
  const domain = storage(); const f = fixture(t, { domain }); await tick();
  await f.request('settings', { processToolUsage: true });
  f.start(); f.call('one'); f.result('one'); const event = f.report(); await tick();
  await f.dispose();
  assert.equal(domain.tables.get('profile').get('settings').processToolUsage, true);
  const next = fixture(t, { domain, config: { processToolUsage: false } }); await tick();
  const restored = (await next.state()).rows.find((r) => r.seq === event.seq);
  assert.equal(restored.processNote, '哼，这段调用了1次工具。');
  next.call('two'); next.report(); await tick();
  assert.equal(next.observations.at(-1)?.available, false, 'first mid-turn observation is incomplete, not old cumulative data');
});

test('restore races honor saved opt-out and a newer user toggle wins over a stored value', async (t) => {
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const off = storage({ processToolUsage: false }, gate);
  const f = fixture(t, { domain: off });
  f.start(); f.call('one'); f.report(); await tick();
  assert.equal(f.calls.length, 0, 'no rewrite or collection before authoritative switches restore');
  release(); await tick(); f.report(); await tick();
  assert.ok(f.calls.length > 0); assert.ok(f.calls.every((o) => o.tools === undefined));
  let release2; const gate2 = new Promise((resolve) => { release2 = resolve; });
  const on = storage({ processToolUsage: false }, gate2);
  const early = fixture(t, { domain: on });
  await early.request('settings', { processToolUsage: true }); release2(); await tick();
  assert.equal((await early.request('settings')).settings.processToolUsage, true);
  early.start(); early.call('one'); early.report(); await tick();
  assert.deepEqual(early.observations[0].categories, { read: { calls: 1, returned: 0, errors: 0, earlier_returns: 0 } });
});

test('host exposes pacing only through optional queries and keeps file identities local', async (t) => {
  const f = fixture(t); f.start(24);
  f.call('edit-a', 'edit');
  f.emit('tool/result', { turn: 24, message: { toolCallId: 'edit-a', isError: false },
    meta: { path: '/secret/project/private.js', diffs: [{ oldText: 'PRIVATE_CODE', newText: 'NEW_PRIVATE_CODE' }] } });
  f.report(); await tick();
  const first = f.observations.at(-1);
  assert.equal(first.work_nature.files_touched, 1);
  assert.equal(first.session_pacing.session_turn_count, 24);
  assert.equal(first.session_pacing.is_first_report, true);
  f.call('read-a'); f.report(); await tick();
  assert.equal(f.observations.at(-1).session_pacing.is_first_report, false);
  assert.equal(f.observations.at(-1).work_nature.files_touched, 0);
  f.report(false); await tick(); f.emit('turn/end', { turn: 24 }); f.start(25);
  f.call('read-b'); f.report(); await tick();
  const next = f.observations.at(-1);
  assert.equal(next.session_pacing.session_turn_count, 25);
  assert.equal(next.session_pacing.is_first_report, true);
  assert.equal(next.session_pacing.idle_minutes, 0);
  assert.doesNotMatch(JSON.stringify(f.calls), /private\.js|PRIVATE_CODE|NEW_PRIVATE_CODE/);
  await f.request('settings', { processToolUsage: false });
  f.report(); await tick();
  assert.equal(f.calls.at(-1).tools, undefined);
  assert.doesNotMatch(f.calls.at(-1).system + JSON.stringify(f.calls.at(-1).messages), /session_pacing|work_nature|第25轮/);
});
