import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { apply } from '../index.js';

const drain = async () => {
  for (let index = 0; index < 12; index++) await new Promise(setImmediate);
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function answer(text, finish = 'stop') {
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    if (finish === 'tool-calls') {
      yield { type: 'block-start', index: 1, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 1, id: 'unexpected', name: 'unexpected_tool', argumentsDelta: '{}' };
      yield { type: 'block-end', index: 1, block: {
        type: 'tool-call', id: 'unexpected', name: 'unexpected_tool', arguments: '{}',
      } };
    }
    if (finish !== null) yield { type: 'finish', reason: { kind: finish } };
  })();
}

async function gateOrAbort(gate, signal) {
  signal.throwIfAborted();
  let onAbort;
  const cancelled = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try { return await Promise.race([gate, cancelled]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

function fixture(t, { config = {}, stream, listModels, cleanup = () => {} } = {}) {
  const bus = new EventEmitter();
  const disposers = [];
  const routes = [];
  const calls = [];
  const llm = {
    listModels: listModels ?? (async () => [{ id: 'model' }]),
    stream(options) {
      calls.push(options);
      return stream?.(options, calls.length) ?? answer('A complete rewritten report.');
    },
  };
  const services = new Map([
    ['llm', llm],
    ['webServer', { register(route) { routes.push(route); return () => {}; } }],
  ]);
  const ctx = {
    get: (key) => services.get(key),
    on(name, listener) { bus.on(name, listener); return () => bus.off(name, listener); },
    inject(names, callback) { if (names.every((key) => services.has(key))) callback(ctx); },
    effect(callback) {
      const stop = callback();
      if (typeof stop === 'function') disposers.push(stop);
      return stop;
    },
    logger: { warn() {} },
  };
  apply(ctx, { provider: 'provider', model: 'model', allowUnauthenticatedRoutes: true, ...config });
  let disposal;
  const dispose = () => {
    disposal ??= (async () => {
      for (const stop of [...disposers].reverse()) await stop();
    })();
    return disposal;
  };
  t.after(async () => { cleanup(); await dispose(); });
  const session = { id: 'main', header: {} };
  let seq = 0;
  async function request(path, body) {
    let result;
    let status;
    await routes[0].handler({
      url: '/persona-shell/' + path,
      method: body === undefined ? 'GET' : 'POST',
      async *[Symbol.asyncIterator]() { if (body !== undefined) yield JSON.stringify(body); },
    }, {
      writeHead(value) { status = value; },
      end(value) { result = JSON.parse(value); },
    });
    assert.equal(status, 200);
    return result;
  }
  return {
    calls, dispose, request,
    report(text = 'The source report is complete, with important conditions.') {
      const event = { type: 'assistant/message', seq: ++seq, data: { turn: 1, message: {
        id: `message-${seq}`, role: 'assistant', content: [{ type: 'text', text }],
      } } };
      bus.emit('session/event', session, event);
      return event.seq;
    },
    state: () => request('state?session=main'),
  };
}

for (const finish of ['max-tokens', 'tool-calls', null]) {
  test(`ordinary rewrites reject ${finish ?? 'missing finish'} instead of saving partial text`, async (t) => {
    const f = fixture(t, { stream: () => answer('Only the first part.', finish) });
    const seq = f.report();
    await drain();
    const row = (await f.state()).rows.find((value) => value.seq === seq);
    assert.equal(row.status, 'skipped');
    assert.equal(row.text, '');
    assert.equal(row.partial, '');
  });
}

test('an explicit stop preserves a complete ordinary rewrite', async (t) => {
  const f = fixture(t);
  const seq = f.report();
  await drain();
  const row = (await f.state()).rows.find((value) => value.seq === seq);
  assert.equal(row.status, 'ready');
  assert.equal(row.text, 'A complete rewritten report.');
});

test('a pending default-model lookup cannot start a model call after disposal', async (t) => {
  const catalog = deferred();
  const f = fixture(t, { config: { model: '' }, listModels: () => catalog.promise,
    cleanup: () => catalog.resolve([{ id: 'model' }]) });
  f.report();
  await drain();
  assert.equal(f.calls.length, 0);
  await f.dispose();
  catalog.resolve([{ id: 'model' }]);
  await drain();
  assert.equal(f.calls.length, 0, 'the disposed instance must not dispatch a fresh provider request');
});

test('default-model lookup is included in the rewrite deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const catalog = deferred();
  const f = fixture(t, { config: { model: '', timeoutMs: 1000 }, listModels: () => catalog.promise,
    cleanup: () => catalog.resolve([{ id: 'model' }]) });
  const seq = f.report();
  await drain();
  t.mock.timers.tick(1000);
  await drain();
  const row = (await f.state()).rows.find((value) => value.seq === seq);
  assert.equal(row.status, 'skipped', 'waiting for the catalog must not outlive the configured deadline');
  assert.equal(row.text, '');
  catalog.resolve([{ id: 'model' }]);
  await drain();
  assert.equal(f.calls.length, 0, 'late catalog metadata cannot restart a timed-out rewrite');
});

test('disposal cancels a persona-extraction request already streaming', async (t) => {
  const gate = deferred();
  const began = deferred();
  const f = fixture(t, { cleanup: () => gate.resolve(), stream(options) {
    return (async function* () {
      began.resolve(options);
      await gateOrAbort(gate.promise, options.signal);
      yield* answer('{}');
    })();
  } });
  const pending = f.request('presets', { action: 'generate', prompt: 'A reserved persona who reports engineering work precisely.' });
  const options = await began.promise;
  await f.dispose();
  const aborted = options.signal.aborted;
  gate.resolve();
  const result = await pending;
  assert.equal(aborted, true, 'extraction must be owned and cancelled by the plugin lifecycle');
  assert.equal(result.ok, false);
});

test('disposal settles extraction during model lookup without waiting for its late metadata', async (t) => {
  const catalog = deferred();
  const f = fixture(t, { config: { model: '' }, listModels: () => catalog.promise,
    cleanup: () => catalog.resolve([{ id: 'model' }]) });
  let result;
  const pending = f.request('presets', { action: 'generate', prompt: 'A reserved persona who reports engineering work precisely.' })
    .then((value) => { result = value; });
  await drain();
  assert.equal(f.calls.length, 0);
  await f.dispose();
  await drain();
  assert.equal(result?.ok, false, 'the cancelled extraction must settle before the catalog returns');
  catalog.resolve([{ id: 'model' }]);
  await pending;
  await drain();
  assert.equal(f.calls.length, 0, 'late catalog metadata cannot dispatch extraction after disposal');
});

test('extraction model lookup shares its deadline and ignores late metadata', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const catalog = deferred();
  const f = fixture(t, { config: { model: '', timeoutMs: 1000 }, listModels: () => catalog.promise,
    cleanup: () => catalog.resolve([{ id: 'model' }]) });
  let result;
  const pending = f.request('presets', { action: 'generate', prompt: 'A reserved persona who reports engineering work precisely.' })
    .then((value) => { result = value; });
  await drain();
  t.mock.timers.tick(1999);
  await drain();
  assert.equal(result, undefined, 'the extraction deadline retains its two-second minimum');
  t.mock.timers.tick(1);
  await drain();
  assert.equal(result?.ok, false, 'catalog lookup must not outlive the extraction deadline');
  assert.equal(result.reason, 'extract-timeout');
  catalog.resolve([{ id: 'model' }]);
  await pending;
  await drain();
  assert.equal(f.calls.length, 0, 'late catalog metadata cannot restart a timed-out extraction');
});

async function personas(f) {
  const alpha = await f.request('presets', { action: 'save', name: 'Alpha', pack: { identity: 'ALPHA_IDENTITY' } });
  const alphaId = alpha.presets.find((preset) => preset.name === 'Alpha').id;
  const beta = alpha.presets.find((preset) => preset.builtin === true);
  await f.request('presets', { action: 'apply', id: alphaId });
  return { alphaId, betaId: beta.id, betaIdentity: beta.pack.identity };
}

test('successful samples remain available while the active persona is unchanged', async (t) => {
  const f = fixture(t, { stream: () => answer('ALPHA_HISTORY_SENTINEL.') });
  await personas(f);
  f.report();
  await drain();
  f.report('The next source report has the same persona.');
  await drain();
  assert.match(JSON.stringify(f.calls[1].messages), /ALPHA_HISTORY_SENTINEL/);
});

for (const change of ['apply', 'edit', 'save', 'delete']) {
  test(`changing the active persona through ${change} isolates earlier tone samples`, async (t) => {
    const f = fixture(t, { stream: () => answer('ALPHA_HISTORY_SENTINEL.') });
    const { alphaId, betaId } = await personas(f);
    f.report();
    await drain();
    assert.equal((await f.state()).rows[0].status, 'ready');
    if (change === 'apply') await f.request('presets', { action: 'apply', id: betaId });
    if (change === 'edit') await f.request('settings', { pack: { identity: 'EDITED_IDENTITY' } });
    if (change === 'save') await f.request('presets', { action: 'save', name: 'Gamma', pack: { identity: 'GAMMA_IDENTITY' } });
    if (change === 'delete') await f.request('presets', { action: 'delete', id: alphaId });
    f.report('A new source report after changing the persona.');
    await drain();
    assert.equal(f.calls.length, 2);
    assert.doesNotMatch(JSON.stringify(f.calls[1].messages), /ALPHA_HISTORY_SENTINEL/);
  });
}

test('late output from the previous persona cannot settle or seed a new persona', async (t) => {
  const gate = deferred();
  const began = deferred();
  const f = fixture(t, { cleanup: () => gate.resolve(), stream(options, number) {
    if (number !== 1) return answer('A new persona report.');
    return (async function* () {
      began.resolve(options);
      await gateOrAbort(gate.promise, options.signal);
      yield* answer('LATE_ALPHA_SENTINEL.');
    })();
  } });
  const { betaId, betaIdentity } = await personas(f);
  const oldSeq = f.report();
  await began.promise;
  await f.request('presets', { action: 'apply', id: betaId });
  gate.resolve();
  await drain();
  const old = (await f.state()).rows.find((row) => row.seq === oldSeq);
  assert.equal(old.status, 'skipped');
  assert.equal(old.text, '');
  assert.equal(old.partial, '');
  f.report('The first report in the new persona.');
  await drain();
  assert.ok(f.calls[1].system.includes(betaIdentity));
  assert.doesNotMatch(JSON.stringify(f.calls[1].messages), /LATE_ALPHA_SENTINEL/);
});
