// Durable behaviour: a rewrite survives a host restart, and a storage failure
// degrades to memory-only instead of breaking rewriting.
// Run with: node --test persona-shell/test/persist.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { apply } from '../index.js';
import { reviewFingerprint } from '../lib/review.js';

/** A fake cordis context with an in-memory storageDomain shared across runs. */
/**
 * A fake Cordis context.
 *
 * `inject` runs the callback only when every named service is present, exactly
 * like the real contract; the storage path is opened through it.
 */
function makeCtx({ llm, storage, webServer } = {}) {
  const bus = new EventEmitter();
  const disposers = [];
  const services = new Map();
  if (llm !== undefined) services.set('llm', llm);
  if (webServer !== undefined) services.set('webServer', webServer);
  if (storage !== undefined) services.set('storageDomain', storage);
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
      return typeof dispose === 'function' ? dispose : () => {};
    },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  };
}

/**
 * A storageDomain stand-in.
 *
 * Each table gets its own Map: sharing one between `sessions` and `presets`
 * would make a preset overwrite a session row with the same key and hide the
 * mistake behind a passing test.
 */
function makeStorage(blobs, seed = {}) {
  const tables = new Map();
  const seeded = new Map();
  if (Array.isArray(seed.presets)) {
    seeded.set('presets', new Map(seed.presets.map((preset) => [preset.id, preset])));
  }
  if (typeof seed.activePreset === 'string') {
    seeded.set('profile', new Map([['activePreset', seed.activePreset]]));
  }
  return {
    async open() {
      return {
        table(name) {
          if (!tables.has(name)) {
            tables.set(name, name === 'sessions' ? blobs : (seeded.get(name) ?? new Map()));
          }
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

/** A storageDomain whose open always rejects. */
function makeBrokenStorage() {
  return { open: async () => { throw new Error('storage offline'); } };
}

/** The storage facility's own unit-name rule, copied from its source. */
const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/;

/** A storageDomain that enforces the real name rule, like the shipped backend. */
function makeStrictStorage(seen) {
  return {
    async open(spec) {
      seen.push(spec.name);
      if (!UNIT_NAME_RE.test(spec.name)) {
        throw new Error(`invalid unit name '${spec.name}'`);
      }
      return {
        table() {
          return {
            get: () => undefined,
            entries: () => new Map().entries(),
            keys: () => new Map().keys(),
            put: async () => {},
            delete: async () => false,
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
      const text = typeof answer === 'function' ? answer(options, calls.length) : answer;
      return (async function* generate() {
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
}

function makeWebServer() {
  const routes = [];
  return {
    routes,
    register: (route) => { routes.push(route); return () => {}; },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 30));

async function deliver(ctx, { sessionId = 's1', seq, text, provider = 'p', model = 'm' }) {
  ctx.bus.emit('session/event', { id: sessionId }, {
    type: 'assistant/message',
    seq,
    time: Date.now(),
    data: {
      turn: 1,
      step: seq,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text }],
        source: { kind: 'model', provider, model },
      },
      stream: [],
    },
  });
  await flush();
}

async function readState(webServer, session = 's1') {
  const route = webServer.routes.find((candidate) => candidate.path === '/persona-shell');
  assert.ok(route, 'route registered');
  const response = {
    statusCode: 0, body: '',
    writeHead(code) { this.statusCode = code; },
    end(body) { this.body = body ?? ''; },
  };
  await route.handler({ url: `/persona-shell/state?session=${session}`, method: 'GET' }, response);
  return JSON.parse(response.body);
}

test('a rewrite survives a restart', async () => {
  const blobs = new Map();
  const storage = makeStorage(blobs);

  // First run: rewrite one step and let persistence settle.
  const web1 = makeWebServer();
  const ctx1 = makeCtx({ llm: makeLlm('壳版 [[0]]。'), storage, webServer: web1 });
  apply(ctx1, {enabled: true,  allowUnauthenticatedRoutes: true });
  await new Promise((resolve) => setTimeout(resolve, 40));
  await deliver(ctx1, { seq: 5, text: '原文 `a.js`。' });
  const first = await readState(web1);
  assert.equal(first.rows.find((row) => row.seq === 5).status, 'ready');
  await new Promise((resolve) => setTimeout(resolve, 600));

  // Second run: same storage, no rewriting needed; the page still sees the row.
  const web2 = makeWebServer();
  const ctx2 = makeCtx({ llm: makeLlm('不会用到'), storage, webServer: web2 });
  apply(ctx2, {enabled: true,  allowUnauthenticatedRoutes: true });
  await new Promise((resolve) => setTimeout(resolve, 60));

  const second = await readState(web2);
  const restored = second.rows.find((row) => row.seq === 5);
  assert.ok(restored, 'the row came back from storage');
  assert.equal(restored.status, 'ready');
  assert.ok(restored.text.includes('`a.js`'), 'the restored text is the rewrite, literals intact');
});

test('the domain name satisfies the storage facility rule', async () => {
  // Regression: `persona-shell` and `personaShell` are both rejected by the
  // shipped backend with "invalid unit name", which left the plugin silently
  // memory-only. This asserts the declared name against the real rule.
  const seen = [];
  const web = makeWebServer();
  const ctx = makeCtx({ llm: makeLlm('壳版 [[0]]。'), storage: makeStrictStorage(seen), webServer: web });
  apply(ctx, {enabled: true,  allowUnauthenticatedRoutes: true });
  await deliver(ctx, { seq: 11, text: '原文 `d.js`。' });
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(seen.length, 1, 'the domain was opened');
  assert.match(seen[0], UNIT_NAME_RE, `domain name "${seen[0]}" must match the facility rule`);
});

test('a broken storage service degrades to memory-only', async () => {
  const web = makeWebServer();
  const llm = makeLlm('壳版 [[0]]。');
  const ctx = makeCtx({ llm, storage: makeBrokenStorage(), webServer: web });
  apply(ctx, {enabled: true,  allowUnauthenticatedRoutes: true });
  await new Promise((resolve) => setTimeout(resolve, 40));

  await deliver(ctx, { seq: 7, text: '原文 `b.js`。' });
  const state = await readState(web);
  const row = state.rows.find((candidate) => candidate.seq === 7);
  assert.equal(row.status, 'ready', 'rewriting still works without storage');
  assert.equal(llm.calls.length, 1);
});

test('no storage service at all still rewrites', async () => {
  const web = makeWebServer();
  const ctx = makeCtx({ llm: makeLlm('壳版 [[0]]。'), webServer: web });
  apply(ctx, {enabled: true,  allowUnauthenticatedRoutes: true });
  await deliver(ctx, { seq: 9, text: '原文 `c.js`。' });
  const state = await readState(web);
  assert.equal(state.rows.find((row) => row.seq === 9).status, 'ready');
});

test('the active preset survives a restart', async () => {
  // Regression: the selection lived only in memory. Switching persona worked
  // until the process restarted and then silently reverted to the default, which
  // is indistinguishable from the switch never having taken effect.
  const blobs = new Map();
  const storage = makeStorage(blobs);

  const web1 = makeWebServer();
  const ctx1 = makeCtx({ llm: makeLlm('壳版 [[0]]。'), storage, webServer: web1 });
  apply(ctx1, {enabled: true,  allowUnauthenticatedRoutes: true });
  await new Promise((resolve) => setTimeout(resolve, 40));

  const route1 = web1.routes.find((candidate) => candidate.path === '/persona-shell');
  const saveResponse = {
    statusCode: 0, body: '',
    writeHead(code) { this.statusCode = code; },
    end(body) { this.body = body ?? ''; },
  };
  const payload = JSON.stringify({
    action: 'save',
    name: '测试预设',
    pack: { identity: '测试用身份，自称「吾」。' },
  });
  await route1.handler({
    url: '/persona-shell/presets',
    method: 'POST',
    async *[Symbol.asyncIterator]() { yield payload; },
  }, saveResponse);
  assert.equal(saveResponse.statusCode, 200);
  await new Promise((resolve) => setTimeout(resolve, 40));

  // Second run: same storage, fresh process.
  const web2 = makeWebServer();
  const ctx2 = makeCtx({ llm: makeLlm('壳版 [[0]]。'), storage, webServer: web2 });
  apply(ctx2, {enabled: true,  allowUnauthenticatedRoutes: true });
  await new Promise((resolve) => setTimeout(resolve, 60));

  const route2 = web2.routes.find((candidate) => candidate.path === '/persona-shell');
  const settingsResponse = {
    statusCode: 0, body: '',
    writeHead(code) { this.statusCode = code; },
    end(body) { this.body = body ?? ''; },
  };
  await route2.handler({ url: '/persona-shell/settings', method: 'GET' }, settingsResponse);
  const restored = JSON.parse(settingsResponse.body);

  assert.equal(restored.settings.presetName, '测试预设', 'the selection came back');
  assert.ok(restored.settings.pack.identity.includes('吾'), 'and so did its pack');
});

test('the non-default shipped personas survive a restart and stay selectable', async () => {
  // All shipped presets must be present in a fresh profile, and choosing either
  // non-default one must persist by id across a restart. A restore that kept
  // only `presets[0]` would silently drop them and reset the user to 大肥鱼.
  const blobs = new Map();
  const storage = makeStorage(blobs);

  const web1 = makeWebServer();
  apply(makeCtx({ llm: makeLlm('壳版 [[0]]。'), storage, webServer: web1 }), { enabled: true, allowUnauthenticatedRoutes: true });
  await new Promise((resolve) => setTimeout(resolve, 40));

  const before = await getJson(web1, '/persona-shell/presets');
  assert.deepEqual(
    before.value.presets.map((preset) => preset.name).slice(0, 4),
    ['大肥鱼（默认）', '大肥龙', 'Claude小姐', '鲸鲸（实验性）'],
    'all shipped presets are listed first, in order',
  );
  const dragon = before.value.presets.find((preset) => preset.name === '大肥龙');
  const claude = before.value.presets.find((preset) => preset.name === 'Claude小姐');
  assert.equal(dragon.builtin, true, 'the dragon preset is builtin');
  assert.equal(claude.builtin, true, 'the Claude preset is builtin');

  const appliedDragon = await postJson(web1, '/persona-shell/presets', { action: 'apply', id: dragon.id });
  assert.equal(appliedDragon.status, 200);
  assert.equal(appliedDragon.value.active, '大肥龙');

  // Fresh process, same storage.
  const web2 = makeWebServer();
  apply(makeCtx({ llm: makeLlm('壳版 [[0]]。'), storage, webServer: web2 }), { enabled: true, allowUnauthenticatedRoutes: true });
  await new Promise((resolve) => setTimeout(resolve, 60));
  const restoredDragon = await getJson(web2, '/persona-shell/settings');
  assert.equal(restoredDragon.value.settings.presetName, '大肥龙', 'the dragon selection came back');
  assert.match(restoredDragon.value.settings.pack.identity, /白龙/, 'and so did its pack');
  assert.equal(restoredDragon.value.settings.pack.address.subagent, '小肥龙', 'helpers keep the dragon name');

  // Switch to the third shipped persona in the second process, then restart again.
  const appliedClaude = await postJson(web2, '/persona-shell/presets', { action: 'apply', id: claude.id });
  assert.equal(appliedClaude.status, 200);
  assert.equal(appliedClaude.value.active, 'Claude小姐');

  const web3 = makeWebServer();
  apply(makeCtx({ llm: makeLlm('壳版 [[0]]。'), storage, webServer: web3 }), { enabled: true, allowUnauthenticatedRoutes: true });
  await new Promise((resolve) => setTimeout(resolve, 60));
  const restoredClaude = await getJson(web3, '/persona-shell/settings');
  assert.equal(restoredClaude.value.settings.presetName, 'Claude小姐', 'the Claude selection came back');
  assert.match(restoredClaude.value.settings.pack.identity, /Claude小姐/);
});

test('a legacy custom preset with a shipped name is superseded, not duplicated', async () => {
  // Before 大肥龙 was shipped, it existed only as a custom preset. A restore must
  // list the shipped card once and must not lose the user's selection if that
  // selection still pointed at the old custom record.
  const blobs = new Map();
  const legacy = {
    id: 'preset-legacy',
    name: '大肥龙',
    pack: { identity: '旧的自定义大肥龙。' },
    builtin: false,
    at: 1,
  };
  const storage = makeStorage(blobs, { presets: [legacy], activePreset: 'preset-legacy' });

  const web = makeWebServer();
  apply(makeCtx({ llm: makeLlm('壳版 [[0]]。'), storage, webServer: web }), { enabled: true, allowUnauthenticatedRoutes: true });
  await new Promise((resolve) => setTimeout(resolve, 60));

  const list = await getJson(web, '/persona-shell/presets');
  const dragons = list.value.presets.filter((preset) => preset.name === '大肥龙');
  assert.equal(dragons.length, 1, 'the name appears once');
  assert.equal(dragons[0].builtin, true, 'the shipped card supersedes the custom one');

  const restored = await getJson(web, '/persona-shell/settings');
  assert.equal(restored.value.settings.presetName, '大肥龙', 'the old selection follows the absorbed preset');
  assert.match(restored.value.settings.pack.identity, /白龙/, 'and the shipped card is what is active');
});

/** POST a JSON body to one of the plugin's routes and return the parsed reply. */
async function postJson(webServer, path, body) {
  const route = webServer.routes.find((candidate) => candidate.path === '/persona-shell');
  assert.ok(route, 'route registered');
  const response = {
    statusCode: 0, body: '',
    writeHead(code) { this.statusCode = code; },
    end(payload) { this.body = payload ?? ''; },
  };
  const text = JSON.stringify(body);
  await route.handler({
    url: path,
    method: 'POST',
    async *[Symbol.asyncIterator]() { yield text; },
  }, response);
  return { status: response.statusCode, value: JSON.parse(response.body) };
}

/** GET one of the plugin's routes and return the parsed reply. */
async function getJson(webServer, path) {
  const route = webServer.routes.find((candidate) => candidate.path === '/persona-shell');
  assert.ok(route, 'route registered');
  const response = {
    statusCode: 0, body: '',
    writeHead(code) { this.statusCode = code; },
    end(payload) { this.body = payload ?? ''; },
  };
  await route.handler({ url: path, method: 'GET' }, response);
  return { status: response.statusCode, value: JSON.parse(response.body) };
}

test('a new message after a restart does not erase the stored history', async () => {
  // Regression: the persist write replaces the whole session blob, but it wrote
  // whatever was in memory. After a restart that is only the rows this process
  // created, so the first new message wiped every stored row for that session.
  const blobs = new Map();
  const storage = makeStorage(blobs);

  const web1 = makeWebServer();
  const ctx1 = makeCtx({ llm: makeLlm('壳版 [[0]]。'), storage, webServer: web1 });
  apply(ctx1, {enabled: true,  allowUnauthenticatedRoutes: true });
  await new Promise((resolve) => setTimeout(resolve, 40));
  await deliver(ctx1, { seq: 5, text: '原文 `a.js`。' });
  await deliver(ctx1, { seq: 9, text: '原文 `b.js`。' });
  await new Promise((resolve) => setTimeout(resolve, 600));

  const stored = blobs.get('s1');
  assert.equal(stored.length, 2, 'both rows were stored');

  // Second run: one new message, without opening the old session first.
  const web2 = makeWebServer();
  const ctx2 = makeCtx({ llm: makeLlm('壳版 [[0]]。'), storage, webServer: web2 });
  apply(ctx2, {enabled: true,  allowUnauthenticatedRoutes: true });
  await new Promise((resolve) => setTimeout(resolve, 40));
  await deliver(ctx2, { seq: 13, text: '原文 `c.js`。' });
  await new Promise((resolve) => setTimeout(resolve, 600));

  const after = blobs.get('s1');
  assert.equal(after.length, 3, 'the older rows survived the write');
  assert.deepEqual(after.map((row) => row.seq), [5, 9, 13], 'and kept their order');
});

test('editing the card is written back into the active preset', async () => {
  // Regression: a pack edit changed only the in-memory settings. The presets
  // table kept the old card, so the next restart restored it and the edit looked
  // like it had never been saved.
  const blobs = new Map();
  const storage = makeStorage(blobs);

  const web1 = makeWebServer();
  apply(makeCtx({ llm: makeLlm('壳版 [[0]]。'), storage, webServer: web1 }), { enabled: true, allowUnauthenticatedRoutes: true });
  await new Promise((resolve) => setTimeout(resolve, 40));

  await postJson(web1, '/persona-shell/presets', {
    action: 'save',
    name: '可编辑预设',
    pack: { identity: '初始身份。', report: ['原始规则。'] },
  });
  await new Promise((resolve) => setTimeout(resolve, 40));

  // The user edits the report rules, exactly as the settings page does.
  await postJson(web1, '/persona-shell/settings', {
    pack: { identity: '初始身份。', report: ['改过的规则。'] },
  });
  await new Promise((resolve) => setTimeout(resolve, 60));

  // Fresh process, same storage.
  const web2 = makeWebServer();
  apply(makeCtx({ llm: makeLlm('壳版 [[0]]。'), storage, webServer: web2 }), { enabled: true, allowUnauthenticatedRoutes: true });
  await new Promise((resolve) => setTimeout(resolve, 60));

  const restored = await getJson(web2, '/persona-shell/settings');
  assert.deepEqual(
    restored.value.settings.pack.report,
    ['改过的规则。'],
    'the edit survived the restart',
  );
});

test('editing the builtin preset forks a new one instead of overwriting it', async () => {
  // The builtin has to stay pristine: it is the way back to the shipped
  // character. An edit therefore lands in a new preset.
  const blobs = new Map();
  const web = makeWebServer();
  apply(makeCtx({ llm: makeLlm('壳版 [[0]]。'), storage: makeStorage(blobs), webServer: web }), { enabled: true, allowUnauthenticatedRoutes: true });
  await new Promise((resolve) => setTimeout(resolve, 40));

  const before = await getJson(web, '/persona-shell/presets');
  const builtin = before.value.presets.find((preset) => preset.builtin === true);
  assert.ok(builtin, 'a builtin preset exists');

  await postJson(web, '/persona-shell/settings', {
    pack: { identity: '改过的内置身份。', report: ['改过的规则。'] },
  });
  await new Promise((resolve) => setTimeout(resolve, 40));

  const after = await getJson(web, '/persona-shell/presets');
  const stillBuiltin = after.value.presets.find((preset) => preset.builtin === true);
  assert.ok(
    !stillBuiltin.pack.identity.includes('改过的内置身份'),
    'the builtin card was not overwritten',
  );
  assert.notEqual(after.value.active, builtin.name, 'the edit moved to a new preset');
  assert.ok(
    after.value.presets.some((preset) => preset.name === after.value.active),
    'the new preset is in the list',
  );
});

test('review measurements and controls survive an awaited unload and restart', async (t) => {
  const blobs = new Map();
  const storage = makeStorage(blobs);
  const web1 = makeWebServer();
  const llm1 = makeLlm('不可以删除 [[0]]。');
  const ctx1 = makeCtx({ llm: llm1, storage, webServer: web1 });
  apply(ctx1, { enabled: true, allowUnauthenticatedRoutes: true });
  await flush();
  const original = '可以删除 `backup.zip`。';
  await deliver(ctx1, { seq: 100, text: original });
  await postJson(web1, '/persona-shell/settings', { reviewHints: false, reviewThreshold: 0.8,
    progressNotices: true, progressMinutes: 7 });
  const first = (await readState(web1)).rows[0];
  assert.equal(first.review.sourceHash, reviewFingerprint(original));
  assert.equal(first.review.targetHash, reviewFingerprint(first.text));
  for (const stop of ctx1.disposers) await stop();
  assert.deepEqual(blobs.get('s1')[0].review, first.review, 'unload drained the new optional field');

  const web2 = makeWebServer();
  const llm2 = makeLlm('不得调用。');
  const ctx2 = makeCtx({ llm: llm2, storage, webServer: web2 });
  apply(ctx2, { enabled: true, allowUnauthenticatedRoutes: true });
  t.after(async () => { for (const stop of ctx2.disposers) await stop(); });
  await flush();
  const restored = await readState(web2);
  assert.deepEqual(restored.rows[0].review, first.review);
  assert.equal(restored.settings.reviewHints, false);
  assert.equal(restored.settings.reviewThreshold, 0.8);
  assert.equal(restored.settings.progressNotices, true);
  assert.equal(restored.settings.progressMinutes, 7);
  await postJson(web2, '/persona-shell/settings', { reviewHints: true, reviewThreshold: 0.1 });
  assert.deepEqual((await readState(web2)).rows[0].review, first.review);
  assert.equal(llm2.calls.length, 0, 'restoring and changing thresholds never reruns a model');
});

test('legacy rows and unknown review versions stay usable and unassessed', async (t) => {
  const blobs = new Map([['s1', [
    { seq: 1, status: 'ready', text: '旧人格版。', final: true, time: 1 },
    { seq: 2, status: 'ready', text: '新版但评估不可识别。', review: { version: 99, editScore: 1 }, time: 2 },
  ]]]);
  const webServer = makeWebServer();
  const llm = makeLlm('不得调用。');
  const ctx = makeCtx({ llm, storage: makeStorage(blobs), webServer });
  apply(ctx, { enabled: true, allowUnauthenticatedRoutes: true });
  t.after(async () => { for (const stop of ctx.disposers) await stop(); });
  await flush();
  const state = await readState(webServer);
  assert.deepEqual(state.rows.map((row) => row.text), ['旧人格版。', '新版但评估不可识别。']);
  assert.ok(state.rows.every((row) => row.status === 'ready' && row.review === undefined));
  assert.equal(llm.calls.length, 0);
});
