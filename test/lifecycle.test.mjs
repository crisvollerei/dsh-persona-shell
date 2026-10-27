// Lifecycle contracts that both reviews found broken, asserted against real
// behaviour rather than the shape of the source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { apply } from '../index.js';

/** A minimal Cordis context with an injectable storage and timer control. */
function makeCtx({ llm, storage, webServer }) {
  const bus = new EventEmitter();
  const services = new Map();
  if (llm !== undefined) services.set('llm', llm);
  if (webServer !== undefined) services.set('webServer', webServer);
  if (storage !== undefined) services.set('storageDomain', storage);
  const disposers = [];
  return {
    bus,
    disposers,
    get: (key) => services.get(key),
    on: (name, listener) => { bus.on(name, listener); return () => bus.off(name, listener); },
    inject: (names, callback) => {
      if (names.every((name) => services.has(name))) callback({ get: (key) => services.get(key) });
      return () => {};
    },
    effect: (callback) => {
      const dispose = callback();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  };
}

function makeWebServer() {
  const routes = [];
  return {
    routes,
    register: (route) => { routes.push(route); return () => {}; },
  };
}

function makeLlm(answer) {
  return {
    calls: [],
    stream(options) {
      this.calls.push(options);
      const text = typeof answer === 'function' ? answer(options, this.calls.length) : answer;
      return (async function* generate() {
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 30));
const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

/** Deliver one committed user message, in the shape the live feed uses. */
function deliverUser(ctx, text) {
  ctx.bus.emit('session/event', { id: 's1' }, {
    type: 'user/message',
    seq: 5,
    time: Date.now(),
    data: { role: 'user', content: [{ type: 'text', text }], id: 'm5' },
  });
}

/** A storage domain whose open resolves only when released. */
function makeSlowStorage(snapshot) {
  const tables = new Map();
  tables.set('profile', new Map(Object.entries(snapshot ?? {})));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  return {
    release: () => release(),
    async open() {
      await gate;
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
        close: async () => { closed = true; },
      };
    },
  };
}

let closed = false;

test('memory collection waits for the saved switch to be restored', async () => {
  // The switches arrive asynchronously; their defaults are permissive. Collecting
  // before they land meant a user who had switched memory off still had messages
  // recorded — and persisted — during the startup window.
  closed = false;
  const webServer = makeWebServer();
  const ctx = makeCtx({ llm: makeLlm('壳版。'), webServer, storage: makeSlowStorage({ settings: { memory: false } }) });
  apply(ctx, { enabled: true, allowUnauthenticatedRoutes: true });

  // Storage is still opening: a message now must not be collected.
  deliverUser(ctx, '重启之后的第一条消息，不应该被记录。');
  await flush();

  const route = webServer.routes.find((candidate) => candidate.path === '/persona-shell');
  const read = async () => {
    const response = {
      statusCode: 0, body: '',
      writeHead(code) { this.statusCode = code; },
      end(body) { this.body = body ?? ''; },
    };
    await route.handler({ url: '/persona-shell/settings', method: 'GET' }, response);
    return JSON.parse(response.body);
  };

  const during = await read();
  assert.equal(during.memoryStats.messages, 0, 'nothing was collected before the switch arrived');

  // Let storage open and the saved switch apply.
  await settle(120);
});

test('unload returns a promise that resolves only after the store closed', async () => {
  // Fire-and-forget close let a reloaded plugin find the domain still open, get
  // `already-open`, and stay memory-only for the rest of the process.
  closed = false;
  const webServer = makeWebServer();
  // Open immediately for this case.
  const immediate = {
    async open() {
      return {
        table() {
          const backing = new Map();
          return {
            get: (key) => backing.get(key),
            entries: () => backing.entries(),
            keys: () => backing.keys(),
            put: async (key, value) => { backing.set(key, value); },
            delete: async (key) => backing.delete(key),
          };
        },
        close: async () => { closed = true; },
      };
    },
  };
  const ctx = makeCtx({ llm: makeLlm('壳版。'), webServer, storage: immediate });
  apply(ctx, { enabled: true, allowUnauthenticatedRoutes: true });
  await settle(60);

  const dispose = ctx.disposers.at(-1);
  assert.equal(typeof dispose, 'function', 'a disposer is registered');
  const result = dispose();
  assert.ok(result !== undefined && typeof result.then === 'function', 'the disposer returns a thenable');
  await result;
  assert.equal(closed, true, 'the domain is closed by the time the disposer resolves');
});
