import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStateStream } from '../lib/state-stream.js';
import { createRemoteContract } from '../lib/remote-contract.js';
import { createClientTransport } from '../lib/client-transport.js';

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const snapshot = (rev = 0, rows = [], instanceId = 'host-a') => ({
  type: 'snapshot', instanceId, rev, rows, settings: { enabled: true }, switchesReady: true,
});

test('the browser embeds the exact shared contract and transport implementation', () => {
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  for (const fn of [createRemoteContract, createClientTransport]) assert.ok(client.includes(fn.toString()));
});

test('Remote input codecs reject oversized keys and malformed leases', () => {
  const descriptor = createRemoteContract().descriptors[0];
  const key = descriptor.parameters[0].codec.create();
  assert.equal(key.parse(''), '', 'empty key selects the control stream');
  assert.throws(() => key.parse('x'.repeat(201)));
  assert.throws(() => key.parse({}));
  const view = descriptor.uplink.codec.create();
  for (const value of [null, {}, { viewer: 'v', revision: -1, visible: true },
    { viewer: 'v', revision: 1, visible: 'yes' }, { viewer: 'v', revision: 1, visible: true, extra: 'unsafe' }]) {
    assert.throws(() => view.parse(value));
  }
});

test('Host sends a baseline, coalesces slow-consumer updates, and sends only changed rows', async () => {
  let state = snapshot(0, [{ seq: 1, text: 'old' }, { seq: 2, text: 'same' }]);
  const hub = createStateStream({ read: () => state });
  const abort = new AbortController();
  const stream = hub.observe('s1', abort.signal);
  const baseline = (await stream.next()).value;
  assert.equal(baseline.type, 'snapshot');
  for (let rev = 1; rev <= 1000; rev++) {
    state = snapshot(rev, [{ seq: 1, text: String(rev) }, { seq: 2, text: 'same' }]);
    hub.changed('s1');
  }
  const delta = (await stream.next()).value;
  assert.equal(delta.type, 'delta'); assert.equal(delta.rev, 1000); assert.equal(delta.baseRev, 0);
  assert.deepEqual(delta.upsert, [{ seq: 1, text: '1000' }]);
  assert.equal(baseline.rows[0].text, 'old', 'published snapshots are detached from live state');
  state = snapshot(1001, [{ seq: 2, text: 'same' }]); hub.changed('s1');
  assert.deepEqual((await stream.next()).value.removed, [1]);
  const pending = stream.next(); abort.abort();
  assert.equal((await pending).done, true);
  assert.deepEqual(hub.stats(), { active: 0, opened: 1, snapshots: 1, deltas: 2 });
});

test('Host attaches its listener before reading, and unload releases idle readers', async () => {
  let reads = 0;
  let hub;
  hub = createStateStream({ read() {
    if (++reads === 1) hub.changed('s1');
    return snapshot(reads);
  } });
  const stream = hub.observe('s1', new AbortController().signal);
  assert.equal((await stream.next()).value.rev, 1);
  assert.equal((await stream.next()).value.rev, 2);
  const pending = stream.next(); hub.close();
  assert.equal((await pending).done, true); assert.equal(hub.stats().active, 0);
});

/** Transport doubles only; an optional integration runs the real rc.3 Gateway and supervisors. */
function harness() {
  const handles = [];
  const states = [];
  const statuses = [];
  const timers = new Map();
  let request = 0;
  let unmounted = 0;
  class CarrierError extends Error {}
  function queue(signal) {
    const items = [];
    let waiter;
    let done = false;
    let failure;
    const handle = {
      sent: [],
      push(value) { items.push(value); waiter?.(); },
      fail(error) { failure = error; waiter?.(); },
      send(value) { handle.sent.push(value); },
      dispose() { done = true; waiter?.(); },
      async *[Symbol.asyncIterator]() {
        while (!done && !signal.aborted) {
          if (failure) throw failure;
          if (items.length) yield items.shift();
          else await new Promise((resolve) => { waiter = resolve; });
        }
      },
    };
    signal.addEventListener('abort', () => handle.dispose(), { once: true });
    return handle;
  }
  const remote = {
    async $mount() { return async () => { unmounted++; }; },
    personaShell: { observe(key, signal) { const handle = queue(signal); handle.key = key; handles.push(handle); return handle; } },
    $stream(options) {
      const abort = new AbortController();
      return { options, abort, [Symbol.asyncIterator]: () => options.open(abort.signal)[Symbol.asyncIterator](),
        async dispose() { abort.abort(); } };
    },
  };
  class SnapshotStream {
    constructor(logical, callbacks) { this.logical = logical; this.callbacks = callbacks; }
    start() {
      this.done = (async () => {
        try {
          for await (const frame of this.logical) {
            if (frame.type === 'snapshot') this.callbacks.replace(frame);
            else this.callbacks.update(frame);
          }
        } catch (error) { this.callbacks.failed(error); }
      })();
    }
    async dispose() { await this.logical.dispose(); await this.done; }
  }
  const transport = createClientTransport({ remote, SnapshotStream, CarrierError, viewer: 'viewer-1',
    contribution: createRemoteContract(), nextRequest: () => ++request,
    onState: (key, state) => states.push({ key, state }), onStatus: (key, status, error) => statuses.push({ key, status, error }),
    setTimer(fn, delay) { const token = {}; timers.set(token, { fn, delay }); return token; },
    clearTimer: (token) => timers.delete(token),
  });
  return { transport, remote, handles, states, statuses, timers, get unmounted() { return unmounted; } };
}

test('Client shares subscriptions, applies deltas, and releases the final subscriber', async () => {
  const app = harness();
  const first = app.transport.subscribe('s1'); const second = app.transport.subscribe('s1');
  await app.transport.start();
  assert.equal(app.handles.length, 1);
  app.handles[0].push(snapshot(7, [{ seq: 1, text: 'one' }, { seq: 2, text: 'two' }])); await flush();
  assert.equal(app.transport.status('s1'), 'ready'); assert.equal(app.timers.size, 0);
  app.handles[0].push({ ...snapshot(8), type: 'delta', baseRev: 7,
    upsert: [{ seq: 2, text: 'updated' }], removed: [1] }); await flush();
  assert.deepEqual(app.states.at(-1).state.rows, [{ seq: 2, text: 'updated' }]);
  assert.equal(app.statuses.filter((value) => value.status === 'ready').length, 1,
    'stream deltas do not generate one HTTP diagnostics report per frame');
  first(); assert.equal(app.transport.status('s1'), 'ready');
  second(); await app.transport.dispose();
  assert.equal(app.unmounted, 1); assert.equal(app.timers.size, 0);
});

test('Client keeps foreground leases alive without state changes and stops on hiding', async () => {
  const app = harness(); app.transport.subscribe('s1'); await app.transport.start();
  const handle = app.handles[0];
  app.transport.setView({ sessionId: 's1', visible: true, revision: 1 });
  assert.equal(handle.sent.at(-1).visible, true);
  const [token, timer] = [...app.timers].find(([, value]) => value.delay === 15000);
  app.timers.delete(token); timer.fn();
  assert.equal(handle.sent.filter((value) => value.visible).length, 2);
  app.transport.setView({ visible: false, revision: 2 });
  assert.equal(handle.sent.at(-1).visible, false);
  assert.ok(![...app.timers.values()].some((value) => value.delay === 15000));
  await app.transport.dispose();
});

test('Client falls back on a missing endpoint or opening timeout, not auth or invalid deltas', async () => {
  for (const code of ['gateway/method-unavailable', 'persona-shell/owner-required', 'bad-delta', 'timeout']) {
    const app = harness(); app.transport.subscribe('s1'); await app.transport.start();
    if (code === 'timeout') {
      [...app.timers.values()].find((value) => value.delay === 10000).fn();
    } else if (code === 'bad-delta') {
      app.handles[0].push(snapshot(9)); await flush();
      app.handles[0].push({ ...snapshot(10), type: 'delta', baseRev: 2, upsert: [], removed: [] });
    } else app.handles[0].fail(Object.assign(new Error(code), { code }));
    await flush();
    assert.equal(app.transport.status('s1'), ['timeout', 'gateway/method-unavailable'].includes(code) ? 'fallback' : 'blocked');
    await app.transport.dispose(); assert.equal(app.timers.size, 0);
  }
});

test('Client reconnect replaces the snapshot even at a lower revision', async () => {
  const app = harness(); app.transport.subscribe('s1'); await app.transport.start();
  app.handles[0].push(snapshot(90, [{ seq: 1, text: 'old' }])); await flush();
  app.handles[0].fail(Object.assign(new Error('host reloading'), { code: 'gateway/service-unavailable' })); await flush();
  app.transport.restart();
  assert.equal(app.handles.length, 2);
  app.handles[1].push(snapshot(1, [{ seq: 2, text: 'new' }], 'host-b')); await flush();
  assert.deepEqual(app.states.at(-1).state.rows, [{ seq: 2, text: 'new' }]);
  await app.transport.dispose();
});

test('Client disposal waits for an in-progress contribution mount and withdraws it once', async () => {
  const app = harness();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const mount = app.remote.$mount;
  app.remote.$mount = async () => { await gate; return mount(); };
  app.transport.subscribe('s1');
  const starting = app.transport.start();
  let disposed = false;
  const closing = app.transport.dispose().then(() => { disposed = true; });
  await flush(); assert.equal(disposed, false);
  release(); await starting; await closing;
  assert.equal(app.unmounted, 1); assert.equal(app.handles.length, 0);
  await app.transport.dispose(); assert.equal(app.unmounted, 1);
});

test('Client does not retry a terminal authorization failure as compatibility churn', async () => {
  const app = harness(); app.transport.subscribe('s1'); await app.transport.start();
  app.handles[0].fail(Object.assign(new Error('denied'), { code: 'persona-shell/owner-required' }));
  await flush(); app.transport.restart();
  assert.equal(app.handles.length, 1); assert.equal(app.transport.status('s1'), 'blocked');
  await app.transport.dispose();
});
