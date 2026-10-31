import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { apply } from '../index.js';
import { emptyProfile } from '../lib/memory.js';

function makeStorage({ settings = {}, profile = emptyProfile(), presets = [], activePreset,
  sessionSwitches } = {}) {
  const profileTable = new Map([
    ['settings', structuredClone(settings)],
    ['default', structuredClone(profile)],
  ]);
  if (activePreset !== undefined) profileTable.set('activePreset', activePreset);
  if (sessionSwitches !== undefined) profileTable.set('sessionSwitches', structuredClone(sessionSwitches));
  const tables = new Map([
    ['profile', profileTable],
    ['sessions', new Map()],
    ['presets', new Map(presets.map(preset => [preset.id, structuredClone(preset)]))],
  ]);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  return {
    tables,
    release,
    async open() {
      await gate;
      return {
        table(name) {
          const backing = tables.get(name);
          return {
            get: key => structuredClone(backing.get(key)),
            entries: () => [...backing].map(([key, value]) => [key, structuredClone(value)]),
            put: async (key, value) => { backing.set(key, structuredClone(value)); },
            delete: async key => backing.delete(key),
          };
        },
        close: async () => {},
      };
    },
  };
}

function runtime(t, storage) {
  const bus = new EventEmitter();
  const routes = [];
  const disposers = [];
  const services = new Map([
    ['storageDomain', storage],
    ['webServer', { register: route => { routes.push(route); return () => {}; } }],
    ['connection', {
      requestRejection: ({ headers }) => headers?.authorization === 'Bearer test-owner' ? undefined : 403,
    }],
  ]);
  const ctx = {
    bus,
    get: name => services.get(name),
    on(name, listener) {
      bus.on(name, listener);
      return () => bus.off(name, listener);
    },
    inject(names, callback) {
      if (names.every(name => services.has(name))) callback({ get: name => services.get(name) });
      return () => {};
    },
    effect(callback) {
      const stop = callback();
      if (typeof stop === 'function') disposers.push(stop);
      return stop;
    },
    logger: { warn() {}, info() {}, error() {} },
  };
  apply(ctx, {});
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    storage.release();
    for (const stop of disposers) await stop();
  };
  t.after(dispose);
  async function request(path, body, authenticated = true) {
    const route = routes.find(item => item.path === '/persona-shell');
    assert.ok(route, 'the plugin route is registered before storage resolves');
    const response = {
      statusCode: 0,
      text: '',
      writeHead(status) { this.statusCode = status; },
      end(text) { this.text = text === undefined ? '' : String(text); },
    };
    await route.handler({
      url: `/persona-shell/${path}`,
      method: body === undefined ? 'GET' : 'POST',
      headers: authenticated ? { authorization: 'Bearer test-owner' } : {},
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body));
      },
    }, response);
    return { status: response.statusCode, value: response.text ? JSON.parse(response.text) : undefined };
  }
  return {
    bus,
    request,
    dispose,
    async ready() {
      storage.release();
      const deadline = Date.now() + 1000;
      while ((await request('diagnostics')).value.storage !== 'open') {
        assert.ok(Date.now() < deadline, 'storage restore finishes');
        await new Promise(resolve => setImmediate(resolve));
      }
    },
  };
}

function assertFields(actual, expected) {
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(actual[key], value, `${key} keeps the most recent saved choice`);
  }
}

test('all settings saved during storage opening survive restore and another restart', async t => {
  const storage = makeStorage({ settings: {
    enabled: true, includeToolSteps: true, processToolUsage: false, memory: true,
    reviewHints: true, reviewThreshold: 0.55, progressNotices: false, progressMinutes: 5,
    subagentSteps: false, subagentReports: false, provider: 'old-provider', model: 'old-model',
    reasoningEffort: 'low',
  } });
  const first = runtime(t, storage);
  const expected = {
    enabled: false, includeToolSteps: false, processToolUsage: true, memory: false,
    reviewHints: false, reviewThreshold: 0.82, progressNotices: true, progressMinutes: 7,
    subagentSteps: true, subagentReports: true, provider: 'new-provider', model: 'new-model',
    reasoningEffort: 'high',
  };
  const saved = await first.request('settings', expected);
  assert.equal(saved.status, 200);
  assertFields(saved.value.settings, expected);
  const latest = await first.request('settings', { provider: ' latest-provider ', model: ' latest-model ' });
  assert.equal(latest.status, 200);
  expected.provider = 'latest-provider';
  expected.model = 'latest-model';

  await first.ready();
  assertFields((await first.request('settings')).value.settings, expected);
  assertFields(storage.tables.get('profile').get('settings'), expected);
  await first.dispose();

  const second = runtime(t, storage);
  await second.ready();
  assertFields((await second.request('settings')).value.settings, expected);
});

test('clearing memory before storage opens cannot restore the old profile', async t => {
  const oldProfile = {
    ...emptyProfile(), messages: 25, hanChars: 100, totalChars: 100, sentences: 25, chars: 100,
    stated: { '大肥鱼（默认）': ['语气要简洁一点'] }, updatedAt: 1,
  };
  const storage = makeStorage({ profile: oldProfile });
  const first = runtime(t, storage);
  const cleared = await first.request('settings', { clearMemory: true });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.value.memoryStats.messages, 0);
  await first.ready();
  const restored = (await first.request('settings')).value;
  assert.equal(restored.memoryStats.messages, 0, 'old counters do not return when restore completes');
  assert.equal(restored.memoryStats.stated, 0, 'old style feedback stays cleared');
  assert.deepEqual(restored.memory, []);
  await first.dispose();
  assert.equal(storage.tables.get('profile').get('default').messages, 0);
  assert.deepEqual(storage.tables.get('profile').get('default').stated, {});

  const second = runtime(t, storage);
  await second.ready();
  assert.equal((await second.request('settings')).value.memoryStats.messages, 0);
});

test('a startup patch keeps untouched saved settings and can reset route fields to empty', async t => {
  const storage = makeStorage({ settings: {
    memory: true, includeToolSteps: false, subagentReports: true,
    provider: 'saved-provider', model: 'saved-model', reasoningEffort: 'high',
  } });
  const app = runtime(t, storage);
  assert.equal((await app.request('settings', { memory: false, model: '', reasoningEffort: '' })).status, 200);
  await app.ready();
  const expected = {
    memory: false, includeToolSteps: false, subagentReports: true,
    provider: 'saved-provider', model: '', reasoningEffort: '',
  };
  assertFields((await app.request('settings')).value.settings, expected);
  assertFields(storage.tables.get('profile').get('settings'), expected);
});

test('invalid startup fields cannot replace pending choices or clear saved memory', async t => {
  const oldSettings = {
    enabled: true, includeToolSteps: true, processToolUsage: false, memory: true,
    reviewHints: true, reviewThreshold: 0.55, progressNotices: false, progressMinutes: 5,
    subagentSteps: false, subagentReports: false, provider: 'saved-provider', model: 'saved-model',
    reasoningEffort: 'low',
  };
  const storage = makeStorage({ settings: oldSettings,
    profile: { ...emptyProfile(), messages: 3 } });
  const app = runtime(t, storage);
  const valid = { enabled: false, memory: false, provider: 'new-provider',
    reviewThreshold: 0.77, progressMinutes: 8, subagentReports: true };
  assert.equal((await app.request('settings', valid)).status, 200);
  assert.equal((await app.request('settings', {
    enabled: 'true', includeToolSteps: 0, processToolUsage: 'false', memory: 0,
    reviewHints: null, reviewThreshold: 2, progressNotices: 'yes', progressMinutes: 2.5,
    subagentSteps: [], subagentReports: 'false', provider: 17, model: { id: 'wrong' },
    reasoningEffort: null, clearMemory: 'true',
  })).status, 200);
  await app.ready();
  const restored = (await app.request('settings')).value;
  const expected = { ...oldSettings, ...valid };
  assertFields(restored.settings, expected);
  assertFields(storage.tables.get('profile').get('settings'), expected);
  assert.equal(restored.memoryStats.messages, 3, 'only boolean true clears memory');
});

test('memory switch changes before and after restore keep the latest collection choice', async t => {
  const storage = makeStorage({ settings: { memory: false } });
  const first = runtime(t, storage);
  const user = seq => first.bus.emit('session/event', { id: 's1' }, {
    type: 'user/message', seq, time: Date.now(),
    data: { id: `u${seq}`, role: 'user', content: [{ type: 'text', text: '请用简洁的语气汇报。' }] },
  });
  await first.request('settings', { memory: false });
  await first.request('settings', { memory: true });
  user(1);
  assert.equal((await first.request('settings')).value.memoryStats.messages, 0,
    'collection waits for saved settings even after an early toggle');
  await first.ready();
  assert.equal((await first.request('settings')).value.settings.memory, true,
    'the last pending toggle wins over the saved false');
  user(2);
  assert.equal((await first.request('settings')).value.memoryStats.messages, 1);
  await first.request('settings', { memory: false });
  user(3);
  assert.equal((await first.request('settings')).value.memoryStats.messages, 1,
    'a later disable stops collection without replaying the old pending true');
  await first.dispose();

  const second = runtime(t, storage);
  await second.ready();
  const restarted = (await second.request('settings')).value;
  assert.equal(restarted.settings.memory, false);
  assert.equal(restarted.memoryStats.messages, 1);
});

test('clearing memory removes user-text samples from authenticated diagnostics', async t => {
  const app = runtime(t, makeStorage());
  await app.ready();
  assert.equal((await app.request('diagnostics', undefined, false)).status, 403);
  const marker = 'private-memory-sample';
  app.bus.emit('session/event', { id: 's1' }, {
    type: 'user/message', seq: 1, time: Date.now(),
    data: { id: 'u1', role: 'user', content: [{ type: 'text', text: `${marker} 请说得简洁一些。` }] },
  });
  const before = await app.request('diagnostics');
  assert.equal(before.status, 200);
  assert.equal(before.value.memory.messages, 1, 'a user observation exists before clearing');
  assert.equal((await app.request('settings', { clearMemory: true })).status, 200);
  const after = (await app.request('diagnostics')).value;
  assert.equal(after.memory.messages, 0);
  assert.equal(after.memorySamples?.length ?? 0, 0, 'diagnostic sample entries are cleared too');
  assert.ok(!JSON.stringify(after).includes(marker), 'clearing does not leave a text copy in diagnostics');
});

test('startup settings changes still merge with pending per-session switches', async t => {
  const storage = makeStorage({
    settings: { progressNotices: false, progressMinutes: 5, reviewHints: true,
      reviewThreshold: 0.55, processToolUsage: false },
    sessionSwitches: { rev: 4, values: { s1: false } },
  });
  const first = runtime(t, storage);
  const expected = { progressNotices: true, progressMinutes: 9, reviewHints: false,
    reviewThreshold: 0.73, processToolUsage: true };
  assert.equal((await first.request('settings', expected)).status, 200);
  assert.equal((await first.request('session-switch', { sessionId: 's1', enabled: true })).status, 200);
  assert.equal((await first.request('session-switch', { sessionId: 's2', enabled: false })).status, 200);
  await first.ready();
  const settings = (await first.request('settings')).value;
  assertFields(settings.settings, expected);
  assert.deepEqual(settings.sessionSwitches.values, { s2: false });
  assertFields(storage.tables.get('profile').get('settings'), expected);
  assert.deepEqual(storage.tables.get('profile').get('sessionSwitches').values, { s2: false });
  await first.dispose();

  const second = runtime(t, storage);
  await second.ready();
  const restarted = (await second.request('settings')).value;
  assertFields(restarted.settings, expected);
  assert.deepEqual(restarted.sessionSwitches.values, { s2: false });
});

for (const operation of ['edit', 'save']) {
  test(`a startup preset ${operation} is preserved or explicitly refused until restore completes`, async t => {
    const old = { id: 'stored-custom', name: 'Stored custom', builtin: false,
      pack: { identity: 'Stored identity.' } };
    const storage = makeStorage({ presets: [old], activePreset: old.id });
    const first = runtime(t, storage);
    const identity = `New ${operation} identity.`;
    const path = operation === 'edit' ? 'settings' : 'presets';
    const body = operation === 'edit'
      ? { pack: { identity } }
      : { action: 'save', name: 'New custom', pack: { identity } };
    const early = await first.request(path, body);
    const accepted = early.status >= 200 && early.status < 300;
    if (!accepted) {
      assert.ok(early.status >= 400, 'a deferred operation has an explicit failure status');
      assert.ok(typeof early.value?.error === 'string' && early.value.error !== '', 'the caller receives a reason');
    }
    await first.ready();
    let state = (await first.request('settings')).value;
    assert.ok(state.presets.some(preset => preset.id === old.id), 'restoring keeps existing custom cards');
    if (!accepted) {
      assert.equal(state.settings.pack.identity, old.pack.identity, 'refused edits did not alter the saved selection');
      assert.equal((await first.request(path, body)).status, 200, 'the operation succeeds once storage is ready');
      state = (await first.request('settings')).value;
    }
    assert.equal(state.settings.pack.identity, identity, 'a successful edit is not overwritten by savedActive');
    const selected = state.presets.find(preset => preset.name === state.settings.presetName);
    assert.ok(selected);
    assert.equal(selected.pack.identity, identity);
    await first.dispose();
    assert.equal(storage.tables.get('presets').get(selected.id)?.pack.identity, identity);
    assert.equal(storage.tables.get('profile').get('activePreset'), selected.id);

    const second = runtime(t, storage);
    await second.ready();
    const restarted = (await second.request('settings')).value;
    assert.equal(restarted.settings.pack.identity, identity);
    assert.equal(restarted.settings.presetName, selected.name);
  });
}
