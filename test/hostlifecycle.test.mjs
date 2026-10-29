// Host lifecycle: the two windows a plugin cannot observe from the outside — a
// storage facility that arrives late, and an unload that races its own open.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { apply } from '../index.js';

/** A Cordis-like context where a service can arrive after `apply`. */
function makeCtx() {
  const bus = new EventEmitter();
  const services = new Map();
  const pending = [];
  const disposers = [];
  return {
    bus,
    disposers,
    services,
    pending,
    get: (key) => services.get(key),
    on: (name, listener) => { bus.on(name, listener); return () => bus.off(name, listener); },
    inject: (names, callback) => {
      const fire = () => callback({ get: (key) => services.get(key) });
      if (names.every((name) => services.has(name))) fire();
      else pending.push({ names, fire });
      return () => {};
    },
    /** Deliver a service and run whatever was waiting for it. */
    provide(name, value) {
      services.set(name, value);
      for (const entry of [...pending]) {
        if (entry.names.every((held) => services.has(held))) {
          pending.splice(pending.indexOf(entry), 1);
          entry.fire();
        }
      }
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
  return { routes, register: (route) => { routes.push(route); return () => {}; } };
}

function makeLlm() {
  return { calls: [], stream() { return (async function* empty() {})(); } };
}

const flush = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

/** Deliver one user message through the committed-event feed. */
function deliverUser(ctx, text) {
  ctx.bus.emit('session/event', { id: 's1' }, {
    type: 'user/message',
    seq: 5,
    time: Date.now(),
    data: { role: 'user', content: [{ type: 'text', text }], id: 'm5' },
  });
}

async function readSettings(webServer) {
  const route = webServer.routes.find((candidate) => candidate.path === '/persona-shell');
  const response = {
    statusCode: 0, body: '',
    writeHead(code) { this.statusCode = code; },
    end(body) { this.body = body ?? ''; },
  };
  await route.handler({ url: '/persona-shell/settings', method: 'GET' }, response);
  return JSON.parse(response.body);
}

/**
 * A storage facility whose open resolves only when released.
 *
 * This is what a late-arriving facility looks like from the plugin's side: the
 * service exists, but the domain is not usable yet.
 */
function makeGatedStorage(snapshot) {
  const tables = new Map();
  tables.set('profile', new Map(Object.entries(snapshot ?? {})));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let closed = false;
  return {
    release: () => release(),
    get closed() { return closed; },
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

test('a late storage facility still gates memory collection on the saved switch', async () => {
  // Regression: the gate was opened once at apply time when no facility existed.
  // The facility then arrived, its restore started, and messages sent during that
  // second window were recorded — and persisted — despite `memory:false`.
  const webServer = makeWebServer();
  const ctx = makeCtx();
  ctx.provide('llm', makeLlm());
  ctx.provide('webServer', webServer);
  apply(ctx, { enabled: true, allowUnauthenticatedRoutes: true });
  await flush();

  // The facility arrives now, with memory switched off in its saved settings.
  const storage = makeGatedStorage({ settings: { memory: false } });
  ctx.provide('storageDomain', storage);
  await flush();

  // Opening is still in progress: nothing may be collected.
  deliverUser(ctx, '这条消息在设置恢复完成前发出，不应该被记录。');
  await flush();
  const during = await readSettings(webServer);
  assert.equal(during.memoryStats.messages, 0, 'collection waits for the restore');

  // Let it finish; the saved switch applies. Still nothing collected.
  storage.release();
  await flush(80);
  const after = await readSettings(webServer);
  assert.equal(after.memoryStats.messages, 0, 'the saved switch is honoured after restore');
});

test('memory collection works once a restore confirms it is on', async () => {
  // The negative case above must not be reachable by simply never collecting.
  const webServer = makeWebServer();
  const ctx = makeCtx();
  ctx.provide('llm', makeLlm());
  ctx.provide('webServer', webServer);
  apply(ctx, { enabled: true, allowUnauthenticatedRoutes: true });

  const storage = makeGatedStorage({ settings: { memory: true } });
  ctx.provide('storageDomain', storage);
  storage.release();
  await flush(80);

  deliverUser(ctx, '设置确认开启之后发出的消息，应该被记录。');
  await flush();
  const state = await readSettings(webServer);
  assert.ok(state.memoryStats.messages >= 1, 'collection resumed');
});

test('unload waits for an open that has not landed yet', async () => {
  // Regression: only a resolved handle was awaited, so an unload during the open
  // returned immediately. The facility kept the domain staged and the next load
  // failed with `already-open`, staying memory-only for the rest of the process.
  const webServer = makeWebServer();
  const ctx = makeCtx();
  ctx.provide('llm', makeLlm());
  ctx.provide('webServer', webServer);
  apply(ctx, { enabled: true, allowUnauthenticatedRoutes: true });

  const storage = makeGatedStorage({});
  ctx.provide('storageDomain', storage);
  await flush();

  const dispose = ctx.disposers.at(-1);
  const unloaded = dispose();
  assert.ok(unloaded !== undefined && typeof unloaded.then === 'function', 'unload returns a thenable');

  // Release the open while the unload is pending; the late handle must be closed
  // as part of that same chain.
  storage.release();
  await unloaded;
  assert.equal(storage.closed, true, 'the late handle was closed before unload resolved');
});

for (const outcome of ['open', 'failed']) test(`storage ${outcome} wakes sessions first read during opening`, async () => {
  const web = makeWebServer();
  const ctx = makeCtx();
  const storage = makeGatedStorage({});
  const originalOpen = storage.open;
  if (outcome === 'failed') storage.open = async () => { await originalOpen(); throw new Error('offline'); };
  ctx.provide('webServer', web); ctx.provide('storageDomain', storage);
  apply(ctx, { allowUnauthenticatedRoutes: true });
  const handler = web.routes[0].handler;
  const response = () => ({ body: '', writeHead() {}, end(body) { this.body = body; } });
  const initial = response();
  await handler({ url: '/persona-shell/state?session=first', method: 'GET' }, initial);
  assert.equal(JSON.parse(initial.body).switchesReady, false);
  const held = response();
  const pending = handler({ url: '/persona-shell/state?session=first&rev=0&wait=15000', method: 'GET' }, held);
  try {
    storage.release(); await flush(30);
    assert.notEqual(held.body, '', 'readiness publishes without the long-poll timeout');
    assert.equal(JSON.parse(held.body).switchesReady, true);
  } finally { await ctx.disposers.at(-1)(); await pending; }
});
