import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelRouteResolver } from '../lib/model-route.js';

const pair = (provider, model, source) => ({ provider, model, source });
function setup(extra = {}) {
  const services = new Map(), settings = { provider: '', model: '' }, turns = new Map();
  const resolver = createModelRouteResolver({ getService: key => services.get(key), getSettings: () => settings,
    getTurnRoute: id => turns.get(id), ...extra });
  return { resolver, services, settings, turns };
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('explicit chat and rewrite selections precede turn metadata and do not silently repair an unlisted exact model', async () => {
  const { resolver, services, settings, turns } = setup();
  services.set('agentDefaultModel', { currentSelection: () => ({ provider: 'global', model: 'real-global' }) });
  services.set('llm', { listModels() { assert.fail('an exact selection must not be replaced by a provider catalog'); } });
  turns.set('work', { provider: 'turn', model: 'turn-model', private: 'not-a-route' });
  Object.assign(settings, { provider: 'rewrite', model: 'unlisted-explicit-model' });
  assert.deepEqual(await resolver.resolve('work', { provider: 'chat', model: 'also-unlisted', thinking: false }), pair('chat', 'also-unlisted', 'chat'));
  assert.deepEqual(await resolver.resolve('work'), pair('rewrite', 'unlisted-explicit-model', 'rewrite'));
  Object.assign(settings, { provider: '', model: '' });
  assert.deepEqual(await resolver.resolve('work'), pair('turn', 'turn-model', 'turn'));
  assert.deepEqual(resolver.peek('work'), pair('turn', 'turn-model', 'turn'));
});

test('a restarted Host without turn state resolves the actual synchronous global selection without a catalog query', async () => {
  const { resolver, services } = setup();
  let selection = { provider: 'chosen-provider', model: 'chosen-model', reasoningEffort: 'high', apiKey: 'PRIVATE' };
  services.set('agentDefaultModel', { currentSelection: () => selection });
  services.set('llm', { listModels() { assert.fail('catalog order does not identify the global default'); } });
  assert.equal(resolver.canResolve('work'), true);
  assert.deepEqual(resolver.peek('work'), pair('chosen-provider', 'chosen-model', 'global'));
  assert.deepEqual(await resolver.resolve('work'), pair('chosen-provider', 'chosen-model', 'global'));
  selection = { provider: 'another-provider', model: 'new-current-default' };
  assert.deepEqual(await resolver.resolve('work'), pair('another-provider', 'new-current-default', 'global'));
});

test('live Agent choices and the narrow live model projection precede the global fallback without activating a Session', async () => {
  const { resolver, services } = setup();
  const session = { id: 'work', get events() { assert.fail('routing never reads messages'); }, append() { assert.fail('routing is read only'); } };
  services.set('agents', { get: id => id === 'work' ? { model: { current: () => ({ provider: 'agent', model: 'pending-choice' }) } } : undefined });
  services.set('agentDefaultModel', { currentSelection: () => ({ provider: 'global', model: 'default' }) });
  assert.deepEqual(await resolver.resolve('work'), pair('agent', 'pending-choice', 'session-live'));
  services.delete('agents');
  services.set('sessions', { get: () => session });
  services.set('sessionProjections', { snapshot(actual, keys) {
    assert.equal(actual, session); assert.deepEqual(keys, ['modelSelection']);
    return { values: { modelSelection: { lastUsed: { provider: 'old', model: 'last' }, next: { provider: 'projection', model: 'selected-next' } } } };
  } });
  assert.deepEqual(resolver.peek('work'), pair('projection', 'selected-next', 'session-live'));
});

test('cold routing uses only header stat and official lifecycle-checked model cache, never a log observation', async () => {
  const { resolver, services } = setup();
  const header = { id: 'work', createdAt: 1, formatVersion: 4, cwd: 'D:/not-read' };
  let stats = 0, snapshots = 0;
  services.set('sessionPersistence', { async stat(id, options) { stats++; assert.equal(id, 'work'); assert.ok(options.signal instanceof AbortSignal); return { header, revision: 'opaque' }; },
    open() { assert.fail('routing cannot open a Session log'); } });
  services.set('sessionQuery', { observeSession() { assert.fail('routing cannot observe conversation bodies'); }, readSession() { assert.fail('routing cannot read conversation bodies'); } });
  services.set('sessionProjectionCache', { cachedSnapshot(actual, keys) {
    snapshots++; assert.equal(actual, header); assert.deepEqual(keys, ['modelSelection']);
    return { values: { modelSelection: { lastUsed: { provider: 'old', model: 'used' }, next: { provider: 'stored', model: 'chosen' } },
      privateMemory: 'PRIVATE_NOT_PROJECTED' } };
  } });
  services.set('agentDefaultModel', { currentSelection: () => ({ provider: 'global', model: 'default' }) });
  assert.deepEqual(await resolver.resolve('work'), pair('stored', 'chosen', 'session-cache'));
  assert.equal(stats, 1); assert.equal(snapshots, 1);
  assert.equal(resolver.canResolve('work'), true);
});

test('unusable lifecycle cache, missing model rows and mismatched stat identity fall back to the actual global selection', async () => {
  const { resolver, services } = setup();
  services.set('agentDefaultModel', { currentSelection: () => ({ provider: 'global', model: 'configured' }) });
  let cacheReads = 0, snapshot;
  services.set('sessionPersistence', { stat: async () => ({ header: { id: 'work', createdAt: 2 } }) });
  services.set('sessionProjectionCache', { cachedSnapshot() { cacheReads++; return snapshot; } });
  for (snapshot of [undefined, { values: {} }, { values: { modelSelection: { next: { provider: '', model: 'bad' } } } }])
    assert.deepEqual(await resolver.resolve('work'), pair('global', 'configured', 'global'));
  services.set('sessionPersistence', { stat: async () => ({ header: { id: 'other-lifecycle', createdAt: 2 } }) });
  assert.deepEqual(await resolver.resolve('work'), pair('global', 'configured', 'global'));
  assert.equal(cacheReads, 3, 'a foreign header never reaches the official cache face');
});

test('a Session becoming live during stat wins over its older persisted checkpoint', async () => {
  const { resolver, services } = setup(), waiting = deferred();
  services.set('sessionPersistence', { stat: () => waiting.promise });
  services.set('sessionProjectionCache', { cachedSnapshot() { assert.fail('a newly live Session wins over the stale cache'); } });
  const resolving = resolver.resolve('work');
  services.set('agents', { get: () => ({ model: { current: () => ({ provider: 'live', model: 'latest' }) } }) });
  waiting.resolve({ header: { id: 'work' } });
  assert.deepEqual(await resolving, pair('live', 'latest', 'session-live'));
});

test('an explicit provider with an empty model uses its matching global choice, never another provider default', async () => {
  const { resolver, services } = setup(); let catalogReads = 0;
  services.set('agentDefaultModel', { currentSelection: () => ({ provider: 'same', model: 'actual-global-model' }) });
  services.set('llm', { async listModels(provider) { catalogReads++; assert.equal(provider, 'other'); return [{ id: 'other-preferred' }, { id: 'another' }]; } });
  assert.deepEqual(await resolver.resolve('work', { provider: 'same', model: '' }), pair('same', 'actual-global-model', 'chat'));
  assert.equal(catalogReads, 0);
  assert.deepEqual(await resolver.resolve('work', { provider: 'other', model: '' }), pair('other', 'other-preferred', 'chat'));
  assert.equal(catalogReads, 1);
});

test('provider metadata lookup is shared and cached, expires or invalidates, and a failed lookup remains retryable', async () => {
  let now = 0, calls = 0, fail = false; const waiting = deferred();
  const { resolver, services } = setup({ now: () => now, metadataTtlMs: 100 });
  services.set('llm', { async listModels() { calls++; if (calls === 1) await waiting.promise; if (fail) throw Error('PRIVATE_CATALOG_ERROR'); return [{ id: 'preferred-' + calls }]; } });
  const options = { provider: 'explicit', model: '' }, a = resolver.resolve('work', options), b = resolver.resolve('other', options);
  waiting.resolve();
  assert.deepEqual(await a, pair('explicit', 'preferred-1', 'chat')); assert.deepEqual(await b, await a); assert.equal(calls, 1);
  await resolver.resolve('work', options); assert.equal(calls, 1);
  now = 100; assert.deepEqual(await resolver.resolve('work', options), pair('explicit', 'preferred-2', 'chat'));
  resolver.invalidate(); fail = true; assert.equal(await resolver.resolve('work', options), undefined);
  fail = false; assert.deepEqual(await resolver.resolve('work', options), pair('explicit', 'preferred-4', 'chat'));
  assert.equal(calls, 4);
});

test('malformed explicit choices block fallback, and an unavailable provider catalog never borrows an unrelated global route', async () => {
  const { resolver, services, settings } = setup();
  services.set('agentDefaultModel', { currentSelection: () => ({ provider: 'global', model: 'configured' }) });
  services.set('llm', { listModels: async () => [{ id: '' }, { id: 'not-the-first-entry' }] });
  for (const explicit of [{ provider: 1, model: 'm' }, { provider: '', model: 'orphan-model' }, { provider: 'bad', model: null }, { provider: ' bad', model: '' }]) {
    assert.equal(resolver.peek('work', explicit), undefined); assert.equal(resolver.canResolve('work', explicit), false);
    assert.equal(await resolver.resolve('work', explicit), undefined);
  }
  assert.equal(await resolver.resolve('work', { provider: 'unavailable', model: '' }), undefined);
  Object.assign(settings, { provider: 'rewrite', model: 42 });
  assert.equal(await resolver.resolve('work'), undefined);
});

test('caller cancellation includes pending metadata reads and late results cannot become a completed route', async () => {
  const { resolver, services } = setup(), waiting = deferred(), abort = new AbortController();
  let lookupSignal, cacheReads = 0;
  services.set('sessionPersistence', { stat(id, { signal }) { lookupSignal = signal; return waiting.promise; } });
  services.set('sessionProjectionCache', { cachedSnapshot() { cacheReads++; return { values: { modelSelection: { next: { provider: 'late', model: 'late' } } } }; } });
  const resolving = resolver.resolve('work', undefined, { signal: abort.signal });
  abort.abort(Error('deadline'));
  await assert.rejects(resolving, /deadline/); assert.equal(lookupSignal.aborted, true);
  waiting.resolve({ header: { id: 'work' } }); await Promise.resolve();
  assert.equal(cacheReads, 0);
  assert.equal(resolver.canResolve('work'), true, 'a cancelled request does not disable a later explicit lookup');
});

test('one cancelled caller does not poison a shared catalog lookup for another active request', async () => {
  const { resolver, services } = setup(), waiting = deferred(), abort = new AbortController(); let calls = 0;
  services.set('llm', { async listModels() { calls++; await waiting.promise; return [{ id: 'shared' }]; } });
  const choice = { provider: 'explicit', model: '' };
  const cancelled = resolver.resolve('one', choice, { signal: abort.signal }), active = resolver.resolve('two', choice);
  abort.abort(Error('first-deadline')); await assert.rejects(cancelled, /first-deadline/);
  waiting.resolve(); assert.deepEqual(await active, pair('explicit', 'shared', 'chat')); assert.equal(calls, 1);
});

test('unload disposes outstanding lookups promptly and disables synchronous readiness without dispatching anything late', async () => {
  for (const kind of ['stat', 'catalog']) {
    const { resolver, services } = setup(), waiting = deferred(); let reads = 0;
    if (kind === 'stat') {
      services.set('sessionPersistence', { stat: () => waiting.promise });
      services.set('sessionProjectionCache', { cachedSnapshot() { reads++; return { values: { modelSelection: { next: { provider: 'late', model: 'late' } } } }; } });
    } else services.set('llm', { listModels: () => waiting.promise });
    const resolving = resolver.resolve('work', kind === 'catalog' ? { provider: 'explicit', model: '' } : undefined);
    await Promise.resolve(); resolver.dispose();
    assert.equal(await resolving, undefined);
    assert.equal(resolver.peek('work'), undefined); assert.equal(resolver.canResolve('work'), false);
    waiting.resolve(kind === 'stat' ? { header: { id: 'work' } } : [{ id: 'late' }]); await Promise.resolve();
    assert.equal(reads, 0); assert.equal(await resolver.resolve('work'), undefined);
  }
});

test('an already aborted request reads no Host metadata and closing during a read prevents fallback', async () => {
  let closing = false, reads = 0; const { resolver, services } = setup({ isClosing: () => closing });
  const waiting = deferred(), abort = new AbortController(); abort.abort(Error('already-aborted'));
  services.set('sessionPersistence', { stat() { reads++; return waiting.promise; } });
  services.set('sessionProjectionCache', { cachedSnapshot() { assert.fail('closing lookup cannot read the cache'); } });
  services.set('agentDefaultModel', { currentSelection() { assert.fail('closing lookup cannot choose a global route'); } });
  await assert.rejects(resolver.resolve('work', undefined, { signal: abort.signal }), /already-aborted/);
  assert.equal(reads, 0);
  const resolving = resolver.resolve('work'); closing = true; waiting.resolve({ header: { id: 'work' } });
  assert.equal(await resolving, undefined); assert.equal(reads, 1);
});

test('reading overrides preserve current priority, then use the captured report before cold metadata and global', async () => {
  const { resolver, services, settings, turns } = setup();
  let live = { provider: 'live', model: 'next' }, stats = 0;
  services.set('agents', { get: () => live ? { model: { current: () => live } } : undefined });
  services.set('agentDefaultModel', { currentSelection: () => ({ provider: 'global', model: 'default' }) });
  services.set('sessionPersistence', { async stat() { stats++; return { header: { id: 'work' } }; } });
  services.set('sessionProjectionCache', { cachedSnapshot: () => ({ values: { modelSelection: { next: { provider: 'stored', model: 'selected' } } } }) });
  services.set('llm', { listModels() { assert.fail('complete routes never need a catalog'); } });
  turns.set('work', { provider: 'turn', model: 'checkpoint' });
  Object.assign(settings, { provider: 'rewrite', model: 'selected' });
  const options = { reportRoute: { provider: 'report', model: 'original-model', private: 'not-a-route' }, overrideSource: 'reading' };
  assert.equal(stats, 0, 'constructing or holding report metadata does not look up a Session');
  assert.deepEqual(await resolver.resolve('work', { provider: 'reading', model: 'exact-unlisted' }, options), pair('reading', 'exact-unlisted', 'reading'));
  assert.deepEqual(await resolver.resolve('work', undefined, options), pair('rewrite', 'selected', 'rewrite'));
  Object.assign(settings, { provider: '', model: '' });
  assert.deepEqual(await resolver.resolve('work', undefined, options), pair('turn', 'checkpoint', 'turn'), 'existing turn-before-live priority is unchanged');
  turns.clear();
  assert.deepEqual(await resolver.resolve('work', undefined, options), pair('live', 'next', 'session-live'));
  live = undefined;
  assert.deepEqual(await resolver.resolve('work', undefined, options), pair('report', 'original-model', 'report-captured'));
  assert.equal(stats, 0, 'a current or captured route avoids cold metadata entirely');
  assert.deepEqual(await resolver.resolve('work', undefined, { overrideSource: 'reading' }), pair('stored', 'selected', 'session-cache'));
  assert.equal(stats, 1);
  services.delete('sessionProjectionCache');
  assert.deepEqual(await resolver.resolve('work', undefined, { overrideSource: 'reading' }), pair('global', 'default', 'global'));
});

test('a reading provider-only choice fills within that provider and never falls back after catalog failure', async () => {
  const { resolver, services } = setup(); let catalogs = 0;
  services.set('agentDefaultModel', { currentSelection: () => ({ provider: 'same', model: 'global-in-same-provider' }) });
  services.set('sessionPersistence', { stat() { assert.fail('an explicit reading provider blocks cold fallback'); } });
  services.set('sessionProjectionCache', { cachedSnapshot() { assert.fail('no cold fallback'); } });
  services.set('llm', { async listModels(provider) {
    catalogs++;
    if (provider === 'missing') return [];
    if (provider === 'unavailable') throw Error('catalog-unavailable');
    assert.equal(provider, 'other'); return [{ id: 'adapter-preferred' }];
  } });
  const options = { reportRoute: { provider: 'captured', model: 'must-not-replace-explicit' }, overrideSource: 'reading' };
  assert.deepEqual(await resolver.resolve('work', { provider: 'same', model: '' }, options), pair('same', 'global-in-same-provider', 'reading'));
  assert.equal(catalogs, 0);
  assert.deepEqual(await resolver.resolve('work', { provider: 'other', model: '' }, options), pair('other', 'adapter-preferred', 'reading'));
  assert.equal(await resolver.resolve('work', { provider: 'missing', model: '' }, options), undefined);
  assert.equal(await resolver.resolve('work', { provider: 'unavailable', model: '' }, options), undefined);
  assert.equal(catalogs, 3, 'a failed explicit choice never tries another provider');
});

test('captured report routes are complete bounded pairs, and malformed explicit reading choices still block fallback', async () => {
  const { resolver, services } = setup(); let stats = 0;
  services.set('agentDefaultModel', { currentSelection: () => ({ provider: 'global', model: 'default' }) });
  services.set('sessionPersistence', { async stat() { stats++; return { header: { id: 'work' } }; } });
  services.set('sessionProjectionCache', { cachedSnapshot: () => ({ values: {} }) });
  for (const reportRoute of [{ provider: 'only-provider' }, { provider: ' padded', model: 'bad' }, { provider: 'p', model: '' }]) {
    assert.deepEqual(await resolver.resolve('work', undefined, { reportRoute, overrideSource: 'reading' }), pair('global', 'default', 'global'));
  }
  assert.equal(stats, 3, 'an incomplete capture is not a new configured provider to repair');
  assert.deepEqual(await resolver.resolve('work', undefined, { reportRoute: { provider: 'capture', model: 'exact', apiKey: 'not-projected' } }),
    pair('capture', 'exact', 'report-captured'));
  for (const override of [{ provider: '', model: 'orphan' }, { provider: ' padded', model: 'bad' }]) {
    assert.equal(await resolver.resolve('work', override, { reportRoute: { provider: 'capture', model: 'exact' }, overrideSource: 'reading' }), undefined);
  }
  assert.equal(stats, 3, 'malformed explicit choices cannot escape through capture, cold or global routes');
  assert.deepEqual(resolver.peek('work'), pair('global', 'default', 'global'), 'peek has no report-policy change');
  assert.equal(resolver.canResolve('work'), true);
  assert.deepEqual(await resolver.resolve('work'), pair('global', 'default', 'global'), 'ordinary resolve keeps its existing cold/global policy');
  assert.equal(stats, 4);
});

test('cancelled reading lookup cannot choose a capture or global route after late provider metadata', async () => {
  const { resolver, services } = setup(), waiting = deferred(), abort = new AbortController(); let stats = 0, catalogs = 0;
  services.set('agentDefaultModel', { currentSelection: () => ({ provider: 'global', model: 'default' }) });
  services.set('llm', { async listModels() { catalogs++; await waiting.promise; return [{ id: 'late-explicit' }]; } });
  services.set('sessionPersistence', { stat() { stats++; assert.fail('explicit reading cannot enter cold fallback'); } });
  services.set('sessionProjectionCache', { cachedSnapshot() { assert.fail('no cold fallback'); } });
  const resolving = resolver.resolve('work', { provider: 'explicit', model: '' }, {
    signal: abort.signal, reportRoute: { provider: 'capture', model: 'old' }, overrideSource: 'reading',
  });
  await Promise.resolve(); abort.abort(Error('reading-cancelled'));
  await assert.rejects(resolving, /reading-cancelled/);
  waiting.resolve(); await Promise.resolve();
  assert.equal(catalogs, 1); assert.equal(stats, 0);
  const already = new AbortController(); already.abort(Error('already-cancelled'));
  await assert.rejects(resolver.resolve('work', undefined, { signal: already.signal,
    reportRoute: { provider: 'capture', model: 'old' }, overrideSource: 'reading' }), /already-cancelled/);
  assert.equal(stats, 0);
});
