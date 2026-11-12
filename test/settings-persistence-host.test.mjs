import test from 'node:test';
import assert from 'node:assert/strict';
import { domain, fixture, flush } from './helpers/persona-chat-host.mjs';

function gate(t) {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  t.after(() => resolve());
  return { promise, resolve };
}
const durable = storage => storage.tables.get('profile').get('settings');

test('settings acknowledge only the completed snapshot, with concurrent writes kept in order', async t => {
  const first = gate(t), second = gate(t), entered = gate(t), enteredSecond = gate(t);
  const snapshots = [];
  const storage = domain(Promise.resolve(), { async beforePut(key, value) {
    if (key !== 'settings') return;
    snapshots.push(value.colloquialReports);
    if (snapshots.length === 1) { entered.resolve(); await first.promise; }
    else { enteredSecond.resolve(); await second.promise; }
  } });
  const app = fixture(t, { storage }); await app.ready();
  let firstDone = false, secondDone = false;
  const a = app.request('settings', { colloquialReports: false }).then(value => { firstDone = true; return value; });
  await entered.promise;
  const b = app.request('settings', { colloquialReports: true }).then(value => { secondDone = true; return value; });
  await flush();
  assert.equal(firstDone, false); assert.equal(secondDone, false);
  assert.deepEqual(snapshots, [false], 'second write waits for the first');
  assert.equal(durable(storage), undefined);
  first.resolve();
  const savedA = await a; await enteredSecond.promise;
  assert.equal(savedA.status, 200);
  assert.equal(savedA.value.settingsPersistence, 'saved');
  assert.equal(savedA.value.settings.colloquialReports, false, 'A must not acknowledge B before B is durable');
  assert.equal(durable(storage).colloquialReports, false);
  assert.equal(secondDone, false);
  second.resolve();
  assert.equal((await b).value.settings.colloquialReports, true);
  assert.deepEqual(snapshots, [false, true]);
  await app.dispose();
  const restarted = fixture(t, { storage }); await restarted.ready();
  assert.equal((await restarted.request('settings')).value.settings.colloquialReports, true);
  assert.equal(app.requests.length + restarted.requests.length, 0);
});

test('failed settings keep live effects explicit and an empty-patch retry saves the current settings', async t => {
  let fail = false;
  const storage = domain(Promise.resolve(), { fail: key => fail && key === 'settings' });
  const app = fixture(t, { storage }); await app.ready();
  await app.request('settings', { colloquialReports: true, enabled: true });
  fail = true;
  const failed = await app.request('settings', { colloquialReports: false, enabled: false });
  assert.equal(failed.status, 503); assert.equal(failed.value.error, 'settings-save-failed');
  assert.equal(failed.value.settings, undefined, 'a failure is not a normal successful settings acknowledgement');
  assert.equal(failed.value.appliedSettings.enabled, false);
  assert.equal((await app.request('settings')).value.settings.colloquialReports, false);
  assert.equal(durable(storage).enabled, true, 'failed persistence does not pretend to undo live effects');
  fail = false;
  const retry = await app.request('settings', {});
  assert.equal(retry.status, 200); assert.equal(retry.value.settingsPersistence, 'saved');
  assert.equal(durable(storage).enabled, false);
  await app.dispose();
  const restarted = fixture(t, { storage }); await restarted.ready();
  assert.equal((await restarted.request('settings')).value.settings.colloquialReports, false);
  assert.equal((await restarted.request('settings')).value.settings.enabled, false);
  assert.equal(app.requests.length + restarted.requests.length, 0);
});

test('a slow card edit cannot let a later scalar setting be saved first', { timeout: 5000 }, async t => {
  const editing = gate(t), entered = gate(t); let hold = false;
  const writes = [];
  const storage = domain(Promise.resolve(), { async beforePut(key, value) {
    if (hold && typeof key === 'string' && key.startsWith('preset-')) { entered.resolve(); await editing.promise; }
    if (key === 'settings') writes.push(value.colloquialReports);
  } });
  const app = fixture(t, { storage }); await app.ready();
  const pack = (await app.request('settings')).value.settings.pack;
  hold = true;
  const first = app.request('settings', { pack: { ...pack, identity: '修改后的身份' }, colloquialReports: false });
  await entered.promise;
  let laterDone = false;
  const later = app.request('settings', { colloquialReports: true }).then(value => { laterDone = true; return value; });
  await flush(); assert.equal(laterDone, false); assert.deepEqual(writes, []);
  editing.resolve();
  assert.equal((await first).value.settings.colloquialReports, false);
  assert.equal((await later).value.settings.colloquialReports, true);
  assert.deepEqual(writes, [false, true]);
  assert.equal(durable(storage).colloquialReports, true);
});

test('a failed settings write is not durable across restart and does not block later saves', async t => {
  let fail = false;
  const storage = domain(Promise.resolve(), { fail: key => fail && key === 'settings' });
  const app = fixture(t, { storage }); await app.ready();
  await app.request('settings', { colloquialReports: true }); fail = true;
  assert.equal((await app.request('settings', { colloquialReports: false })).status, 503);
  await app.dispose();
  fail = false;
  const restarted = fixture(t, { storage }); await restarted.ready();
  assert.equal((await restarted.request('settings')).value.settings.colloquialReports, true);
  assert.equal((await restarted.request('settings', { colloquialReports: false })).status, 200);
  assert.equal(durable(storage).colloquialReports, false);
});

test('unload drains accepted settings writes before close and refuses new mutations', async t => {
  const write = gate(t), entered = gate(t); let closed = false;
  const storage = domain(Promise.resolve(), { async beforePut(key) {
    if (key === 'settings') { entered.resolve(); await write.promise; assert.equal(closed, false); }
  } });
  const open = storage.open;
  storage.open = async (...args) => { const value = await open(...args); return { ...value, async close() { closed = true; } }; };
  const app = fixture(t, { storage }); await app.ready();
  const saving = app.request('settings', { colloquialReports: false }); await entered.promise;
  let stopped = false;
  const stopping = app.dispose().then(() => { stopped = true; }); await flush();
  assert.equal(stopped, false); assert.equal(closed, false);
  assert.equal((await app.request('settings', { colloquialReports: true })).status, 503);
  write.resolve();
  assert.equal((await saving).status, 200); await stopping;
  assert.equal(closed, true); assert.equal(durable(storage).colloquialReports, false);
});

test('startup patches explicitly remain pending until merged with restored settings', async t => {
  const opening = gate(t);
  const storage = domain(opening.promise);
  const app = fixture(t, { storage });
  const pending = await app.request('settings', { colloquialReports: false });
  assert.equal(pending.status, 200); assert.equal(pending.value.settingsPersistence, 'pending');
  assert.equal(pending.value.settings.colloquialReports, false);
  opening.resolve(); await app.ready();
  assert.equal(durable(storage).colloquialReports, false);
  assert.equal((await app.request('settings', {})).value.settingsPersistence, 'saved');
});

test('unavailable storage explicitly reports memory-only application', async t => {
  const storage = { async open() { throw Error('unavailable'); } };
  const app = fixture(t, { storage }); await app.ready();
  const saved = await app.request('settings', { colloquialReports: false });
  assert.equal(saved.status, 200); assert.equal(saved.value.settingsPersistence, 'memory-only');
  assert.equal(saved.value.settings.colloquialReports, false);
  assert.equal(app.requests.length, 0);
});
