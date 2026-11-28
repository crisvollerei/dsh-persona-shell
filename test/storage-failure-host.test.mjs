import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../lib/store.js';
import { createStructuredMemory } from '../lib/structured-memory.js';
import { createHostReportRows } from '../lib/host-report-rows.js';
import { domain, fixture } from './helpers/persona-chat-host.mjs';

test('an early or late startup read error closes the handle once and preserves stored data on unload', async t => {
  for (const field of ['modelUsage', 'sessionSwitches']) await t.test(field, async sub => {
    const storage = domain(Promise.resolve(), { onGet(key) { if (key === field) throw Error('read error'); } });
    const memories = createStructuredMemory();
    memories.mutate({ action: 'add', entry: { kind: 'preference', scope: 'shared', content: 'Prefer short reports.' } });
    const saved = new Map([['default', { messages: 17 }], ['structuredMemory', memories.snapshot()]]);
    const original = structuredClone(saved);
    storage.tables.set('profile', saved);
    const open = storage.open.bind(storage);
    let closed = 0;
    storage.open = async () => ({ ...await open(), async close() { closed++; } });
    const host = fixture(sub, { storage });
    await host.ready();
    assert.equal((await host.request('ping')).value.storage, 'failed');
    assert.equal(closed, 1);
    await host.dispose();
    assert.equal(closed, 1);
    assert.deepEqual(saved, original);
  });
});

test('a failed row read defers replacement until recovery and skips only malformed records', async () => {
  const sessionId = 'work:with:colons';
  const row = seq => ({ seq, sessionId, status: 'ready', text: `text-${seq}`, final: false });
  let saved = [row(1), null, { seq: 'invalid' }, row(2)];
  let failed = true;
  const store = { get() { if (failed) throw Error('read error'); return saved; }, async put(id, values) { saved = values; } };
  const rows = new Map([[`${sessionId}:3`, row(3)]]);
  const host = createHostReportRows({ getStore: () => store, rows, rowsBySession: new Map(), sessionRows: () => rows.values(),
    setReportRow: (key, value) => rows.set(key, value), cfg: { maxRowsPerSession: 20 }, warn() {}, touch() {}, notifySession() {} });
  const original = structuredClone(saved);
  await host.flushPersist(sessionId);
  assert.deepEqual(saved, original);
  assert.equal(host.hydrated.has(sessionId), false);
  failed = false;
  host.hydrate(sessionId);
  assert.equal(host.persistTimers.has(sessionId), true, 'a successful read retries the deferred write');
  clearTimeout(host.persistTimers.get(sessionId));
  await host.flushPersist(sessionId);
  assert.deepEqual(saved.map(r => r.seq), [1, 2, 3]);
});

test('row, profile and session-switch writes serialize per key and close drains earlier dispatches', async t => {
  for (const key of ['work', 'default', 'sessionSwitches']) await t.test(key, async () => {
    const started = Promise.withResolvers();
    const gate = Promise.withResolvers();
    const writes = [];
    const storage = domain(Promise.resolve(), { async beforePut(id, value) {
      if (id !== key) return;
      writes.push(value);
      if (writes.length === 1) { started.resolve(); await gate.promise; }
    } });
    const db = await openStore({ get: () => storage });
    const put = value => key === 'work' ? db.put(key, value) : key === 'default' ? db.putProfile(value) : db.putSessionSwitches(value);
    const first = put({ revision: 1 });
    await started.promise;
    const second = put({ revision: 2 });
    let closed = false;
    const closing = db.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve));
    try {
      assert.deepEqual(writes, [{ revision: 1 }]);
      assert.equal(closed, false);
    } finally { gate.resolve(); }
    await Promise.all([first, second, closing]);
    assert.deepEqual(storage.tables.get(key === 'work' ? 'sessions' : 'profile').get(key), { revision: 2 });
  });
});
