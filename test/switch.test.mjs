// Per-session switches and the long-poll state route. These are Host-side
// contracts: the browser half only mirrors the map and gates its renderer.
// Run with: node --test persona-shell/test/switch.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';

import { apply } from '../index.js';

/** A fake Cordis context with the services this plugin uses. */
function makeCtx({ llm, webServer, storage } = {}) {
  const bus = new EventEmitter();
  const services = new Map();
  if (llm !== undefined) services.set('llm', llm);
  if (webServer !== undefined) services.set('webServer', webServer);
  if (storage !== undefined) services.set('storageDomain', storage);
  return {
    bus,
    get: (key) => services.get(key),
    on: (name, listener) => { bus.on(name, listener); return () => bus.off(name, listener); },
    inject: (names, callback) => {
      if (names.every((name) => services.has(name))) callback({ get: (key) => services.get(key) });
      return () => {};
    },
    effect: (callback) => { const dispose = callback(); return typeof dispose === 'function' ? dispose : () => {}; },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  };
}

/** A storageDomain stand-in with shared tables across applies. */
function makeStorage(tables = new Map()) {
  return {
    tables,
    async open() {
      return {
        table(name) {
          if (!tables.has(name)) tables.set(name, new Map());
          const backing = tables.get(name);
          return {
            get: (key) => backing.get(key),
            entries: () => backing.entries(),
            keys: () => backing.keys(),
            put: async (key, value) => { backing.set(key, value); },
            delete: async (key) => backing.delete(key),
          };
        },
        close: async () => {},
      };
    },
  };
}

function makeLlm(answer) {
  const calls = [];
  return {
    calls,
    stream(options) {
      calls.push(options);
      return (async function* generate() {
        yield { type: 'text-delta', index: 0, text: typeof answer === 'function' ? answer(options) : answer };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
}

/** A streaming LLM that pauses between chunks, so a switch can land mid-stream. */
function makeStreamingLlm() {
  const calls = [];
  return {
    calls,
    stream(options) {
      calls.push(options);
      return (async function* generate() {
        yield { type: 'text-delta', index: 0, text: '壳版' };
        await new Promise((resolve) => setTimeout(resolve, 40));
        yield { type: 'text-delta', index: 0, text: ' [[0]]。' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
}

/** A storage whose open does not resolve until the test releases it. */
function makeGatedStorage(tables, seed) {
  if (seed !== undefined) tables.set('profile', new Map([['sessionSwitches', seed]]));
  const base = makeStorage(tables);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  return {
    release: () => release(),
    async open() {
      await gate;
      return base.open();
    },
  };
}

function makeWebServer() {
  const routes = [];
  return { routes, register: (route) => { routes.push(route); return () => {}; } };
}

const routeOf = (webServer) => {
  const route = webServer.routes.find((candidate) => candidate.path === '/persona-shell');
  assert.ok(route, 'the plugin route was registered');
  return route;
};

/** Call one plugin route with an optional JSON body. */
async function call(webServer, { url, method = 'GET', body }) {
  const response = {
    statusCode: 0,
    body: '',
    writeHead(code) { this.statusCode = code; },
    end(chunk) { this.body = chunk === undefined ? '' : String(chunk); },
  };
  const request = {
    url,
    method,
    headers: {},
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); },
  };
  await routeOf(webServer).handler(request, response);
  return { status: response.statusCode, value: response.body === '' ? undefined : JSON.parse(response.body) };
}

/** Deliver one assistant message through the committed-event feed. */
function deliverAssistant(ctx, seq, text) {
  ctx.bus.emit('session/event', { id: 's1' }, {
    type: 'assistant/message',
    seq,
    time: Date.now(),
    data: {
      turn: 1,
      step: seq,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      stream: [],
    },
  });
}

/** Deliver one user-authored message. */
function deliverUser(ctx, seq, text) {
  ctx.bus.emit('session/event', { id: 's1' }, {
    type: 'user/message',
    seq,
    time: Date.now(),
    data: { role: 'user', content: [{ type: 'text', text }], id: `m${seq}` },
  });
}

const flush = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

test('a session switch turns off rewriting and memory collection for that session', async () => {
  const storage = makeStorage();
  const web = makeWebServer();
  const llm = makeLlm('鲸鲸看过了 [[0]]。');
  const ctx = makeCtx({ llm, webServer: web, storage });
  apply(ctx, { enabled: true, allowUnauthenticatedRoutes: true });
  await flush();

  const disabled = await call(web, {
    url: '/persona-shell/session-switch',
    method: 'POST',
    body: { sessionId: 's1', enabled: false },
  });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.value.sessionEnabled, false);
  assert.deepEqual(disabled.value.sessionSwitches.values, { s1: false });

  deliverAssistant(ctx, 1, '原始汇报 `a.js`。');
  deliverUser(ctx, 2, '帮我看一下这个配置文件对不对。');
  await flush();

  const state = await call(web, { url: '/persona-shell/state?session=s1' });
  assert.equal(state.value.sessionEnabled, false, 'the state reports the effective value');
  assert.equal(state.value.rows.length, 0, 'no rewrite row is created while off');
  assert.equal(llm.calls.length, 0, 'no model call is made while off');

  const settings = await call(web, { url: '/persona-shell/settings' });
  assert.equal(settings.value.memoryStats.messages, 0, 'memory observation is off for the session');

  // Turning it back on resumes both behaviours.
  const enabled = await call(web, {
    url: '/persona-shell/session-switch',
    method: 'POST',
    body: { sessionId: 's1', enabled: true },
  });
  assert.equal(enabled.status, 200);
  assert.deepEqual(enabled.value.sessionSwitches.values, {});

  deliverAssistant(ctx, 3, '原始汇报 `b.js`。');
  await flush();
  const resumed = await call(web, { url: '/persona-shell/state?session=s1' });
  assert.equal(resumed.value.sessionEnabled, true);
  assert.equal(resumed.value.rows.length, 1);
  assert.equal(resumed.value.rows[0].status, 'ready');
  assert.equal(llm.calls.length, 1);
});

test('the session switch survives a restart', async () => {
  const storage = makeStorage();
  const web1 = makeWebServer();
  apply(makeCtx({ llm: makeLlm('鲸鲸看过了 [[0]]。'), webServer: web1, storage }), { enabled: true, allowUnauthenticatedRoutes: true });
  await flush();
  await call(web1, {
    url: '/persona-shell/session-switch',
    method: 'POST',
    body: { sessionId: 's1', enabled: false },
  });

  const web2 = makeWebServer();
  apply(makeCtx({ llm: makeLlm('鲸鲸看过了 [[0]]。'), webServer: web2, storage }), { enabled: true, allowUnauthenticatedRoutes: true });
  await flush(60);

  const settings = await call(web2, { url: '/persona-shell/settings' });
  assert.deepEqual(settings.value.sessionSwitches.values, { s1: false }, 'the override came back');
  const state = await call(web2, { url: '/persona-shell/state?session=s1' });
  assert.equal(state.value.sessionEnabled, false);
});

test('a toggle made before storage opens is merged with the saved map', async () => {
  // The page can be usable while the storage facility is still opening. A click
  // in that window must not be erased by the older saved map arriving later.
  const tables = new Map();
  const storage = makeGatedStorage(tables, { rev: 4, values: { s1: false } });
  const web = makeWebServer();
  apply(makeCtx({ llm: makeLlm('鲸鲸看过了 [[0]]。'), webServer: web, storage }), { enabled: true, allowUnauthenticatedRoutes: true });
  await flush(20);

  // Before the open lands: undo the saved off for s1, and turn s2 off.
  await call(web, {
    url: '/persona-shell/session-switch',
    method: 'POST',
    body: { sessionId: 's1', enabled: true },
  });
  await call(web, {
    url: '/persona-shell/session-switch',
    method: 'POST',
    body: { sessionId: 's2', enabled: false },
  });

  storage.release();
  await flush(80);

  const settings = await call(web, { url: '/persona-shell/settings' });
  assert.deepEqual(settings.value.sessionSwitches.values, { s2: false }, 'the early toggle wins over the saved copy');
  const s1 = await call(web, { url: '/persona-shell/state?session=s1' });
  const s2 = await call(web, { url: '/persona-shell/state?session=s2' });
  assert.equal(s1.value.sessionEnabled, true);
  assert.equal(s2.value.sessionEnabled, false);
});

test('turning the global switch off mid-stream discards the rewrite', async () => {
  const storage = makeStorage();
  const web = makeWebServer();
  const llm = makeStreamingLlm();
  const ctx = makeCtx({ llm, webServer: web, storage });
  apply(ctx, { enabled: true, allowUnauthenticatedRoutes: true });
  await flush(40);

  deliverAssistant(ctx, 1, '原始汇报 `a.js`。');
  await flush(10);
  const off = await call(web, {
    url: '/persona-shell/settings',
    method: 'POST',
    body: { enabled: false },
  });
  assert.equal(off.status, 200);
  await flush(140);

  const state = await call(web, { url: '/persona-shell/state?session=s1' });
  const row = state.value.rows.find((candidate) => candidate.seq === 1);
  assert.ok(row, 'the row exists');
  assert.equal(row.status, 'skipped', 'the stream did not publish a ready persona row');
  assert.equal(row.text, '');
  assert.equal(llm.calls.length, 1, 'the already-running call is not reissued');
});

test('the session switch rejects a too-long session id', async () => {
  const web = makeWebServer();
  apply(makeCtx({ llm: makeLlm('鲸鲸看过了 [[0]]。'), webServer: web }), { enabled: true, allowUnauthenticatedRoutes: true });
  const response = await call(web, {
    url: '/persona-shell/session-switch',
    method: 'POST',
    body: { sessionId: 'x'.repeat(201), enabled: false },
  });
  assert.equal(response.status, 400);
});

test('the state route holds the request until something changes', async () => {
  const web = makeWebServer();
  const ctx = makeCtx({ llm: makeLlm('鲸鲸看过了 [[0]]。'), webServer: web });
  apply(ctx, { enabled: true, allowUnauthenticatedRoutes: true });
  await flush();

  const response = {
    statusCode: 0,
    body: '',
    writeHead(code) { this.statusCode = code; },
    end(chunk) { this.body = chunk === undefined ? '' : String(chunk); },
  };
  const pending = routeOf(web).handler(
    { url: '/persona-shell/state?session=s1&rev=0&wait=1000', method: 'GET', headers: {} },
    response,
  );
  await flush(20);
  assert.equal(response.body, '', 'the request is held while nothing changes');

  deliverAssistant(ctx, 1, '原始汇报。');
  await pending;

  const value = JSON.parse(response.body);
  assert.ok(value.rev > 0, 'the revision moved');
  assert.equal(value.rows.length, 1, 'the new row is delivered with the wake');
});

test('the state route answers a no-change hold at its deadline', async () => {
  const web = makeWebServer();
  const ctx = makeCtx({ llm: makeLlm('鲸鲸看过了 [[0]]。'), webServer: web });
  apply(ctx, { enabled: true, allowUnauthenticatedRoutes: true });
  await flush();

  const first = await call(web, { url: '/persona-shell/state?session=s1' });
  const started = Date.now();
  const held = await call(web, {
    url: `/persona-shell/state?session=s1&rev=${first.value.rev}&wait=40`,
  });
  assert.ok(Date.now() - started >= 20, 'the hold is not a no-op');
  assert.equal(held.value.rev, first.value.rev, 'nothing moved');
});

test('a held state request survives a real HTTP connection', async () => {
  // The fake request in the other tests has no EventEmitter methods, so it can
  // never exercise the close handling. This one uses Node's real server: the
  // response must stay open for the requested window instead of resolving as
  // soon as the GET is received.
  const web = makeWebServer();
  const ctx = makeCtx({ llm: makeLlm('鲸鲸看过了 [[0]]。'), webServer: web });
  apply(ctx, { enabled: true, allowUnauthenticatedRoutes: true });
  await flush();
  const server = http.createServer((request, response) => {
    Promise.resolve(routeOf(web).handler(request, response)).catch((error) => {
      response.destroy(error instanceof Error ? error : undefined);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${port}/persona-shell/state?session=s1&rev=0&wait=100`);
    const value = await response.json();
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 60, `the hold survived a real connection (${elapsed}ms)`);
    assert.equal(value.rev, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
