import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createProgress, validateProgress, PROGRESS_LEASE_MS } from '../lib/progress.js';
import { resolveConfig } from '../lib/config.js';
import { apply } from '../index.js';

const flush = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); };

function clock() {
  let time = 1000;
  let next = 0;
  const timers = new Map();
  return { timers, now: () => time,
    setTimer(fn, delay) { const id = ++next; timers.set(id, { fn, at: time + delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    async advance(ms) {
      const end = time + ms;
      for (let count = 0; count < 10000; count += 1) {
        const item = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!item) { time = end; await flush(); return; }
        time = item[1].at; timers.delete(item[0]); item[1].fn(); await flush();
      }
      assert.fail('scheduler did not settle');
    },
  };
}

function fixture(t, { enabled = true, produce } = {}) {
  const time = clock();
  const settings = { enabled, minutes: 5 };
  const calls = [];
  const changes = [];
  const agents = new Map();
  const session = { id: 's1', header: {} };
  const agent = { session, status: 'running' };
  agents.set(session.id, agent);
  const progress = createProgress({ ...time,
    config: () => settings, allowed: (s) => s.enabled !== false,
    agentFor: (id) => agents.get(id), changed: (id) => changes.push(id),
    produce: async (...args) => { calls.push(args); return produce ? produce(...args) : '还没收到新的正文结果，先来报个到。'; },
  });
  t.after(() => progress.dispose());
  let seq = 0;
  const event = (type, data = {}, s = session) => progress.event(s, { type, seq: ++seq, data });
  const start = (turn = 1, s = session) => event('turn/start', { turn }, s);
  const viewer = (id = 'v', s = session.id, revision = 1) => progress.viewer(id, s, revision);
  async function elapse(ms, renew = true) {
    while (ms > 0) {
      const step = Math.min(ms, 30000);
      if (renew) viewer();
      await time.advance(step); ms -= step;
    }
  }
  return { time, settings, progress, calls, changes, session, agent, agents, event, start, viewer, elapse };
}

test('progress is opt-in and the interval accepts only whole minutes in range', () => {
  assert.equal(resolveConfig({}).progressNotices, false);
  assert.equal(resolveConfig({}).progressMinutes, 5);
  assert.equal(resolveConfig({ progressMinutes: 1, progressNotices: true }).progressMinutes, 1);
  for (const value of [0, 61, 1.5, '5', NaN, Infinity]) assert.equal(resolveConfig({ progressMinutes: value }).progressMinutes, 5);
});

test('disabled notices add no scheduler, timeout or API call', async (t) => {
  const f = fixture(t, { enabled: false });
  f.start(); f.viewer();
  assert.equal(f.time.timers.size, 0);
  await f.elapse(1200000);
  assert.equal(f.calls.length, 0);
  assert.equal(f.time.timers.size, 0);
});

test('the quiet deadline is five minutes, and elapsed time alone is not a new fact', async (t) => {
  const f = fixture(t);
  f.start(); f.viewer();
  await f.elapse(299999);
  assert.equal(f.calls.length, 0);
  await f.elapse(1);
  assert.equal(f.calls.length, 1);
  assert.ok(f.progress.notice('s1'));
  await f.elapse(1200000);
  assert.equal(f.calls.length, 1, 'same observations never spend another call');
});

test('tool events do not postpone silence and only counts, not payloads, enter the call', async (t) => {
  const f = fixture(t);
  f.start();
  await f.elapse(240000);
  f.event('tool/call', { turn: 1, callId: 'c1', name: 'SECRET_TOOL', arguments: 'secret command' });
  f.event('tool/result', { turn: 1, message: { toolCallId: 'c1', isError: true, content: 'SECRET_OUTPUT' }, error: { reason: 'secret error' } });
  f.event('tool/call', { turn: 1, callId: 'c2', name: 'read', arguments: 'private path' });
  await f.elapse(60000);
  assert.equal(f.calls.length, 1);
  const facts = f.calls[0][1];
  assert.match(facts, /2 次工具调用.*1 次返回.*1 次尚未返回/);
  assert.match(facts, /1 次返回被工具标记为执行错误/);
  for (const secret of ['SECRET_TOOL', 'secret command', 'SECRET_OUTPUT', 'secret error', 'private path']) assert.ok(!facts.includes(secret));
});

test('new facts permit another notice but total extra calls are capped at three per turn', async (t) => {
  const f = fixture(t);
  f.start();
  for (let n = 1; n <= 5; n += 1) {
    f.event('tool/call', { turn: 1, callId: `c${n}`, name: 'bash' });
    await f.elapse(300000);
  }
  assert.equal(f.calls.length, 3);
});

test('real text deltas reset the deadline, hide notices and discard a late API answer', async (t) => {
  let release;
  const f = fixture(t, { produce: () => new Promise((resolve) => { release = resolve; }) });
  f.start();
  f.progress.stream(f.agent, { type: 'start', turn: 1, attemptId: 'a1' });
  await f.elapse(300000);
  assert.equal(f.calls.length, 1);
  f.progress.stream(f.agent, { type: 'chunk', attemptId: 'a1', chunk: { type: 'text-delta', text: 'actual report' } });
  assert.equal(f.calls[0][2].aborted, true);
  release('已经过时的播报。'); await flush();
  assert.equal(f.progress.notice('s1'), undefined);
  await f.elapse(300000);
  assert.equal(f.calls.length, 1, 'text alone does not manufacture new progress facts');
});

test('reasoning chunks neither reset silence nor become new evidence for repeated calls', async (t) => {
  const f = fixture(t);
  f.start(); f.progress.stream(f.agent, { type: 'start', turn: 1, attemptId: 'a1' });
  for (let i = 0; i < 20; i += 1) {
    f.progress.stream(f.agent, { type: 'chunk', attemptId: 'a1', chunk: { type: 'reasoning-delta', text: 'PRIVATE_THOUGHT' } });
    await f.elapse(30000);
  }
  assert.equal(f.calls.length, 1);
  assert.ok(!f.calls[0][1].includes('PRIVATE_THOUGHT'));
});

test('visible text extends silence from its latest delta and changed facts withdraw the previous notice', async (t) => {
  const f = fixture(t);
  f.start(); f.progress.stream(f.agent, { type: 'start', turn: 1, attemptId: 'a' });
  await f.elapse(240000);
  f.progress.stream(f.agent, { type: 'chunk', attemptId: 'a', chunk: { type: 'text-delta', text: 'new visible text' } });
  await f.elapse(60000); assert.equal(f.calls.length, 0);
  await f.elapse(240000); assert.equal(f.calls.length, 1);
  assert.ok(f.progress.notice('s1'));
  f.event('tool/call', { turn: 1, callId: 'changed', name: 'read' });
  assert.equal(f.progress.notice('s1'), undefined, 'do not leave outdated present-tense claims visible');
});

test('tool/question and approval waits suppress notices and resume with a full quiet interval', async (t) => {
  for (const kind of ['question', 'approval']) {
    const f = fixture(t); f.start();
    if (kind === 'question') f.event('tool/call', { turn: 1, name: 'ask_user_question', callId: 'q' });
    else f.event('approval/asked', { id: 'approval' });
    await f.elapse(600000);
    assert.equal(f.calls.length, 0);
    if (kind === 'question') f.event('tool/result', { turn: 1, message: { toolCallId: 'q' } });
    else f.event('approval/decided', { id: 'approval', outcome: 'allowed-once' });
    await f.elapse(299999); assert.equal(f.calls.length, 0);
    await f.elapse(1); assert.equal(f.calls.length, 1);
  }
});

test('a vanished view expires without background spending and an old hide cannot cancel a newer view', async (t) => {
  const f = fixture(t); f.start(); f.viewer();
  await f.elapse(300000, false);
  assert.equal(f.calls.length, 0);
  f.viewer('v', 's1', 3); f.progress.viewer('v', undefined, 2);
  await f.elapse(0); await f.time.advance(0);
  assert.equal(f.calls.length, 1);
  await f.elapse(PROGRESS_LEASE_MS + 1, false);
  assert.equal(f.progress.notice('s1'), undefined);
});

test('switching views withdraws a late notice, while another window may retain its own lease', async (t) => {
  let release;
  const f = fixture(t, { produce: () => new Promise((resolve) => { release = resolve; }) });
  f.start(); await f.elapse(300000);
  f.progress.viewer('v', undefined, 2);
  assert.equal(f.calls[0][2].aborted, true);
  release('晚到的消息。'); await flush();
  assert.equal(f.progress.notice('s1'), undefined);
  f.viewer('second', 's1', 1);
  f.progress.viewer('v', undefined, 3);
  assert.equal(f.progress.notice('s1'), undefined);
});

test('a hung API is bounded even if it ignores cancellation, with no immediate retry', async (t) => {
  const f = fixture(t, { produce: () => new Promise(() => {}) });
  f.start(); await f.elapse(300000);
  await f.elapse(15000);
  assert.equal(f.calls[0][2].aborted, true);
  await f.elapse(600000);
  assert.equal(f.calls.length, 1);
  assert.equal(f.progress.notice('s1'), undefined);
});

test('completed turns, master/session switches, disposal and replacement agents reject stale answers', async (t) => {
  for (const cause of ['end', 'idle', 'off', 'session-off', 'dispose', 'replacement']) {
    let release;
    const f = fixture(t, { produce: () => new Promise((resolve) => { release = resolve; }) });
    f.start(); await f.elapse(300000);
    if (cause === 'end') f.event('turn/end', { turn: 1 });
    if (cause === 'idle') { f.agent.status = 'idle'; f.progress.status(f.agent, 'idle'); }
    if (cause === 'off') { f.settings.enabled = false; f.progress.configure(); }
    if (cause === 'session-off') { f.session.enabled = false; f.progress.configure('s1'); }
    if (cause === 'dispose') f.progress.dispose();
    if (cause === 'replacement') f.agents.set('s1', { status: 'running', session: { id: 's1' } });
    release('不可展示的迟到结果。'); await flush();
    assert.equal(f.progress.notice('s1'), undefined, cause);
  }
});

test('a different turn or newer facts cannot receive the previous snapshot', async (t) => {
  for (const change of ['turn', 'facts']) {
    let release;
    const f = fixture(t, { produce: () => new Promise((resolve) => { release = resolve; }) });
    f.start(); await f.elapse(300000);
    if (change === 'turn') { f.start(2); f.event('turn/end', { turn: 1 }); }
    else f.event('tool/call', { turn: 1, callId: 'new', name: 'read' });
    release('旧快照。'); await flush();
    assert.equal(f.progress.notice('s1'), undefined);
  }
});

test('an idle status without an agent is ignored', (t) => {
  const f = fixture(t);
  assert.doesNotThrow(() => f.progress.status(undefined, 'idle'));
  assert.doesNotThrow(() => f.progress.status(undefined, 'running'));
  assert.doesNotThrow(() => f.progress.status({}, 'idle'));
});

test('progress shares one API slot across sessions and ignores unknown runtime status', async (t) => {
  let release;
  const f = fixture(t, { produce: () => new Promise((resolve) => { release = resolve; }) });
  const other = { id: 's2' };
  f.agents.set('s2', { session: other, status: 'running' });
  f.start(); f.start(1, other); f.viewer('second', 's2');
  // Keep both windows' leases alive through the deadline.
  for (let i = 0; i < 10; i += 1) { f.viewer(); f.viewer('second', 's2'); await f.time.advance(30000); }
  assert.equal(f.calls.length, 1);
  release('还没有新的正文结果。'); await flush(); await f.time.advance(0);
  assert.equal(f.calls.length, 2);
  f.progress.dispose();
  const unknown = fixture(t); unknown.agents.clear(); unknown.start(); await unknown.elapse(600000);
  assert.equal(unknown.calls.length, 0);
});

test('format violations and obvious promises use a local conservative fallback', async (t) => {
  for (const text of ['已经完成了，测试全部通过。', '预计 2 分钟完成。', '完成 80%。', '```sh\nrm\n```', 'a\nb', 'x'.repeat(221)]) {
    assert.equal(validateProgress(text), undefined);
  }
  const f = fixture(t, { produce: () => '马上完成。' });
  f.start(); await f.elapse(300000);
  assert.match(f.progress.notice('s1').text, /暂时没有能确认的新进展/);
});

function hostFixture(t, rawConfig = {}, storage) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const bus = new EventEmitter();
  const disposers = [];
  const session = { id: 's1', header: {}, append() { assert.fail('plugin must not append to the session'); } };
  const agent = { session, status: 'running' };
  const calls = [];
  let handler;
  const services = new Map([
    ['agents', { get: (id) => id === 's1' ? agent : undefined }],
    ['llm', { stream(options) { calls.push(options); return (async function* () {
      yield { type: 'text-delta', text: '还没收到新的结果，先来报个到。' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    })(); } }],
    ['webServer', { register(route) { handler = route.handler; return () => {}; } }],
  ]);
  if (storage) services.set('storageDomain', storage);
  const ctx = {
    get: (key) => services.get(key), logger: { warn() {} },
    on(name, fn) { bus.on(name, fn); return () => bus.off(name, fn); },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return dispose; },
    inject(names, fn) { if (names.every((name) => services.has(name))) fn(ctx); return () => {}; },
  };
  apply(ctx, { allowUnauthenticatedRoutes: true, provider: 'p', model: 'm', ...rawConfig });
  t.after(async () => { for (const dispose of disposers.reverse()) await dispose(); });
  let seq = 0;
  const event = (type, data = {}) => bus.emit('session/event', session, { type, seq: ++seq, data });
  async function request(url, body) {
    const req = { url, method: body === undefined ? 'GET' : 'POST',
      async *[Symbol.asyncIterator]() { yield JSON.stringify(body); } };
    const response = { writeHead(code) { this.status = code; }, end(value) { this.body = value; } };
    await handler(req, response);
    return { status: response.status, value: JSON.parse(response.body) };
  }
  const view = () => request('/persona-shell/state?session=s1&viewing=1&viewer=v&viewRev=1');
  async function elapse(ms) {
    while (ms > 0) { await view(); const step = Math.min(ms, 30000); t.mock.timers.tick(step); await flush(); ms -= step; }
  }
  return { session, agent, calls, event, request, view, elapse, services, bus };
}

test('nested human questions pause notices and pass through the identical answer promise and error', async (t) => {
  const f = hostFixture(t, { progressNotices: true });
  f.event('turn/start', { turn: 1 });
  const observe = f.bus.listeners('user-questions/request')[0];
  let resolve;
  const pending = new Promise((yes) => { resolve = yes; });
  const returned = observe({ agent: f.agent, questions: ['PRIVATE_QUESTION'] }, () => pending);
  assert.equal(returned, pending);
  await f.elapse(600000); assert.equal(f.calls.length, 0);
  const answer = { answers: ['PRIVATE_ANSWER'] };
  resolve(answer); assert.equal(await returned, answer); await flush();
  await f.elapse(300000); assert.equal(f.calls.length, 1);
  assert.ok(!JSON.stringify(f.calls[0]).includes('PRIVATE_'));
  const error = new Error('answerer failed');
  assert.throws(() => observe({ agent: f.agent }, () => { throw error; }), (actual) => actual === error);
});

test('real Host publishes ephemeral facts-only notices through authenticated state, never rows or transcript', async (t) => {
  const f = hostFixture(t, { progressNotices: true });
  f.session.header.parentSession = 'an-ordinary-user-fork';
  f.event('turn/start', { turn: 1 });
  f.event('tool/call', { turn: 1, callId: 'c', name: 'SECRET_NAME', arguments: 'SECRET_ARGS' });
  await f.elapse(300000);
  const state = (await f.request('/persona-shell/state?session=s1')).value;
  assert.equal(f.calls.length, 1);
  assert.equal(state.rows.length, 0);
  assert.ok(state.progress.text);
  const call = f.calls[0];
  assert.equal(call.messages.length, 1);
  assert.equal(call.tools, undefined);
  assert.equal(call.maxTokens, 512);
  assert.ok(!JSON.stringify(call).includes('SECRET_'));
  assert.equal(call.provider, 'p'); assert.equal(call.model, 'm');
  f.event('turn/end', { turn: 1 });
  assert.equal((await f.request('/persona-shell/state?session=s1')).value.progress, undefined);
});

test('Host defaults off, validates settings and never enables a delegated session', async (t) => {
  const f = hostFixture(t);
  f.event('turn/start', { turn: 1 }); await f.elapse(300000);
  assert.equal(f.calls.length, 0);
  let result = await f.request('/persona-shell/settings', { progressNotices: true, progressMinutes: 2 });
  assert.equal(result.value.settings.progressNotices, true);
  assert.equal(result.value.settings.progressMinutes, 2);
  result = await f.request('/persona-shell/settings', { progressNotices: 'true', progressMinutes: 0.1 });
  assert.equal(result.value.settings.progressMinutes, 2);
  f.session.header.delegationDepth = 1;
  f.event('turn/start', { turn: 2 }); await f.elapse(300000);
  assert.equal(f.calls.length, 0);
});

test('Host does not spend during delayed settings restore and restores the saved opt-out', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tables = new Map([['profile', new Map([['settings', { progressNotices: false }]])]]);
  const storage = { async open() { await gate; return {
    table(name) { if (!tables.has(name)) tables.set(name, new Map()); const map = tables.get(name); return {
      get: (key) => map.get(key), keys: () => map.keys(), entries: () => map.entries(),
      put: async (key, value) => map.set(key, value), delete: async (key) => map.delete(key),
    }; }, close: async () => {},
  }; } };
  const f = hostFixture(t, { progressNotices: true }, storage);
  f.event('turn/start', { turn: 1 }); await f.elapse(600000);
  assert.equal(f.calls.length, 0);
  release(); await flush();
  assert.equal((await f.request('/persona-shell/settings')).value.settings.progressNotices, false);
  f.event('turn/start', { turn: 2 }); await f.elapse(600000);
  assert.equal(f.calls.length, 0);
});

test('failed storage keeps optional spending off, and viewer endpoints reject malformed input', async (t) => {
  const f = hostFixture(t, { progressNotices: true }, { open: async () => { throw new Error('storage unavailable'); } });
  await flush();
  f.event('turn/start', { turn: 1 }); await f.elapse(600000);
  assert.equal(f.calls.length, 0);
  for (const body of [null, {}, { viewer: 'v', revision: 1, visible: true },
    { viewer: 'v', revision: -1, visible: false }, { viewer: 'v', revision: 1.5, visible: false }]) {
    assert.equal((await f.request('/persona-shell/progress-view', body)).status, 400);
  }
  assert.equal((await f.request('/persona-shell/progress-view', { viewer: 'v', revision: 2, visible: false })).status, 200);
});

test('an edit during storage open wins over the saved progress switch without persisting a notice', async (t) => {
  let release;
  const gate = new Promise((yes) => { release = yes; });
  const tables = new Map([['profile', new Map([['settings', { progressNotices: true, progressMinutes: 12 }]])]]);
  const storage = { async open() { await gate; return {
    table(name) { if (!tables.has(name)) tables.set(name, new Map()); const map = tables.get(name); return {
      get: (key) => map.get(key), keys: () => map.keys(), entries: () => map.entries(),
      put: async (key, value) => map.set(key, value), delete: async (key) => map.delete(key),
    }; }, close: async () => {},
  }; } };
  const f = hostFixture(t, {}, storage);
  await f.request('/persona-shell/settings', { progressNotices: false, progressMinutes: 2 });
  release(); await flush();
  const settings = (await f.request('/persona-shell/settings')).value.settings;
  assert.equal(settings.progressNotices, false);
  assert.equal(settings.progressMinutes, 2);
  assert.equal(tables.get('profile').get('settings').progressNotices, false);
  assert.equal(tables.get('profile').get('settings').progressMinutes, 2);
  assert.deepEqual([...tables.get('sessions').values()], []);
});
