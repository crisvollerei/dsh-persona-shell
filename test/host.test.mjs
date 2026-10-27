// End-to-end checks for the Host half against a fake Cordis context and a fake
// llm service. Exercises event classification, masking, validation, the route,
// and the failure paths that must leave the plain report in place.
// Run with: node --test persona-shell/test/host.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { apply } from '../index.js';

/** A fake Cordis context exposing only what this plugin uses. */
/**
 * A fake Cordis context exposing only what this plugin uses.
 *
 * `inject` mirrors the real contract: run the callback when every named service
 * is already present, otherwise keep it for later. Tests that never provide the
 * service simply never see the callback, which is the point.
 */
function makeCtx({ llm, webServer, storageDomain } = {}) {
  const bus = new EventEmitter();
  const services = new Map();
  if (llm !== undefined) services.set('llm', llm);
  if (webServer !== undefined) services.set('webServer', webServer);
  if (storageDomain !== undefined) services.set('storageDomain', storageDomain);
  const disposers = [];
  return {
    bus,
    disposers,
    get: (key) => services.get(key),
    on: (name, listener) => {
      bus.on(name, listener);
      return () => bus.off(name, listener);
    },
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

/** A fake llm service that answers with a scripted response per call. */
function makeLlm(answer) {
  const calls = [];
  return {
    calls,
    stream(options) {
      calls.push(options);
      const text = typeof answer === 'function' ? answer(options, calls.length) : answer;
      return (async function* generate() {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
}

/** A fake webserver capturing registered routes. */
function makeWebServer() {
  const routes = [];
  return {
    routes,
    register: (route) => {
      routes.push(route);
      return () => {
        const index = routes.indexOf(route);
        if (index >= 0) routes.splice(index, 1);
      };
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

/**
 * Deliver one committed assistant message and wait for the rewrite to settle.
 * @param {object} [options]
 * @param {number} [options.delegationDepth] - >0 marks a subagent's session.
 */
async function deliver(ctx, rows, { seq, text, interrupted = false, toolCall = false, route, delegationDepth }) {
  const content = [];
  if (text !== '') content.push({ type: 'text', text });
  if (toolCall) content.push({ type: 'tool-call', id: `c${seq}`, name: 'read', arguments: '{}' });
  const session = { id: 's1' };
  if (delegationDepth !== undefined) session.header = { id: 's1', delegationDepth };
  ctx.bus.emit('session/event', session, {
    type: 'assistant/message',
    seq,
    time: Date.now(),
    data: {
      turn: 1,
      step: seq,
      message: {
        role: 'assistant',
        content,
        source: { kind: 'model', provider: (route ?? DEFAULT_ROUTE).provider, model: (route ?? DEFAULT_ROUTE).model },
      },
      stream: [],
      ...(interrupted ? { interrupted: true } : {}),
    },
  });
  await flush();
}

/**
 * Deliver one user-authored message, in the shape the live feed actually uses.
 *
 * `user/message` puts `content`, `role` and `id` directly under `data`, while
 * `assistant/message` nests them under `data.message`. Reading the wrong path
 * yields `undefined` with no error — which is exactly how the first version of
 * the memory feature learned nothing while looking correct.
 */
async function deliverUser(ctx, { seq, text }) {
  ctx.bus.emit('session/event', { id: 's1' }, {
    type: 'user/message',
    seq,
    time: Date.now(),
    data: {
      role: 'user',
      content: [{ type: 'text', text }],
      id: `m${seq}`,
    },
    surfaceOp: { kind: 'append' },
  });
  await flush();
}

const DEFAULT_ROUTE = { provider: 'p', model: 'm' };

/**
 * A fake llm that streams in slow slices, so the row can be observed mid-flight.
 * @param {string[]} pieces - text deltas, yielded with a pause between them.
 */
function makeStreamingLlm(pieces) {
  return {
    calls: [],
    stream(options) {
      this.calls.push(options);
      return (async function* generate() {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        for (const piece of pieces) {
          await new Promise((resolve) => setTimeout(resolve, 120));
          yield { type: 'text-delta', index: 0, text: piece };
        }
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
}

/** Ask the plugin's own state route for one session. */
async function readState(webServer, session = 's1') {
  const route = webServer.routes.find((candidate) => candidate.path === '/persona-shell');
  assert.ok(route, 'route was registered');
  const response = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
    end(body) { this.body = body ?? ''; },
  };
  await route.handler({ url: `/persona-shell/state?session=${session}`, method: 'GET' }, response);
  return { status: response.statusCode, value: JSON.parse(response.body) };
}

test('a plain assistant message becomes a ready rewrite', async () => {
  const webServer = makeWebServer();
  // The model answers in the masked vocabulary: it keeps the marker it was given.
  const llm = makeLlm('我看了看，改好了 [[0]]。');
  const ctx = makeCtx({ llm, webServer });
  apply(ctx, { enabled: true });

  // No request header at all: the route comes from the message itself.
  await deliver(ctx, null, { seq: 10, text: '我看了一下，改好了 `npm run build`。', route: { provider: 'magpie', model: 'w/x' } });

  const { status, value } = await readState(webServer);
  assert.equal(status, 200);
  const row = value.rows.find((candidate) => candidate.seq === 10);
  assert.equal(row.status, 'ready');
  assert.ok(row.text.includes('`npm run build`'), 'the literal is restored verbatim');
  assert.ok(!row.text.includes('[[0]]'), 'no marker leaks into the rendering');
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].provider, 'magpie');
  assert.equal(llm.calls[0].model, 'w/x');
  // The rewriting model must never receive the real command bytes.
  assert.ok(!llm.calls[0].messages[0].content[0].text.includes('npm run build'));
});

test('a tool-carrying step is rewritten by default', async () => {
  // Narration a step emits before calling tools ("现在改常量…") is most of what
  // the reader sees during a long turn. It used to be skipped by a hardcoded
  // rule, which left the middle of every turn plain.
  const webServer = makeWebServer();
  const llm = makeLlm('鲸鲸先看看 [[0]]。');
  const ctx = makeCtx({ llm, webServer });
  apply(ctx, { enabled: true });
  ctx.bus.emit('session/event', { id: 's1' }, {
    type: 'request/header', seq: 1, time: 0,
    data: { header: { config: { provider: 'p', model: 'm' } }, reason: 'initial' },
  });

  await deliver(ctx, null, { seq: 11, text: '我先看看 `a.js`。', toolCall: true });

  const { value } = await readState(webServer);
  const row = value.rows.find((candidate) => candidate.seq === 11);
  assert.equal(row.status, 'ready');
  assert.equal(llm.calls.length, 1);
});

test('includeToolSteps: false keeps mid-turn narration plain', async () => {
  const webServer = makeWebServer();
  const llm = makeLlm('不会用到');
  const ctx = makeCtx({ llm, webServer });
  apply(ctx, { enabled: true, includeToolSteps: false });
  ctx.bus.emit('session/event', { id: 's1' }, {
    type: 'request/header', seq: 1, time: 0,
    data: { header: { config: { provider: 'p', model: 'm' } }, reason: 'initial' },
  });

  await deliver(ctx, null, { seq: 12, text: '我先看看文件。', toolCall: true });

  const { value } = await readState(webServer);
  assert.equal(value.rows.length, 0);
  assert.equal(llm.calls.length, 0);
});

test('an interrupted step is never rewritten', async () => {
  const webServer = makeWebServer();
  const llm = makeLlm('不会用到');
  const ctx = makeCtx({ llm, webServer });
  apply(ctx, { enabled: true });
  ctx.bus.emit('session/event', { id: 's1' }, {
    type: 'request/header', seq: 1, time: 0,
    data: { header: { config: { provider: 'p', model: 'm' } }, reason: 'initial' },
  });

  await deliver(ctx, null, { seq: 12, text: '被中断的汇报。', interrupted: true });

  const { value } = await readState(webServer);
  assert.equal(value.rows.length, 0);
  assert.equal(llm.calls.length, 0);
});

test('a rewrite that drops a literal is refused and the plain report stands', async () => {
  const webServer = makeWebServer();
  // Drops the [[0]] marker entirely.
  const llm = makeLlm('我改好了。');
  const ctx = makeCtx({ llm, webServer });
  apply(ctx, { enabled: true });
  ctx.bus.emit('session/event', { id: 's1' }, {
    type: 'request/header', seq: 1, time: 0,
    data: { header: { config: { provider: 'p', model: 'm' } }, reason: 'initial' },
  });

  await deliver(ctx, null, { seq: 13, text: '已经改好了 `a.js`。' });

  const { value } = await readState(webServer);
  const row = value.rows.find((candidate) => candidate.seq === 13);
  assert.equal(row.status, 'skipped');
  assert.equal(row.reason, 'dropped-marker');
  assert.equal(row.text, '');
});

test('no route means no call and an explicit skip', async () => {
  const webServer = makeWebServer();
  const llm = makeLlm('不会用到');
  const ctx = makeCtx({ llm, webServer });
  apply(ctx, { enabled: true });

  // A message with no model source and no header: the route is unknown.
  ctx.bus.emit('session/event', { id: 's1' }, {
    type: 'assistant/message',
    seq: 14,
    time: Date.now(),
    data: {
      turn: 1,
      step: 14,
      message: { role: 'assistant', content: [{ type: 'text', text: '一段汇报。' }] },
      stream: [],
    },
  });
  await flush();

  const { value } = await readState(webServer);
  const row = value.rows.find((candidate) => candidate.seq === 14);
  assert.equal(row.status, 'skipped');
  assert.equal(row.reason, 'no-route');
  assert.equal(llm.calls.length, 0);
});

test('report mode only rewrites the last report of a completed turn', async () => {
  const webServer = makeWebServer();
  const llm = makeLlm('套壳版 [[0]]。');  const ctx = makeCtx({ llm, webServer });
  apply(ctx, { enabled: true, trigger: 'report' });
  ctx.bus.emit('session/event', { id: 's1' }, {
    type: 'request/header', seq: 1, time: 0,
    data: { header: { config: { provider: 'p', model: 'm' } }, reason: 'initial' },
  });
  ctx.bus.emit('session/event', { id: 's1' }, { type: 'turn/start', seq: 2, time: 0, data: { turn: 1 } });

  await deliver(ctx, null, { seq: 20, text: '第一步汇报 `x`。' });
  await deliver(ctx, null, { seq: 21, text: '最终汇报 `y`。' });
  assert.equal(llm.calls.length, 0, 'nothing is spent before the turn ends');

  ctx.bus.emit('session/event', { id: 's1' }, {
    type: 'turn/end', seq: 22, time: 0, data: { turn: 1, reason: { kind: 'completed' } },
  });
  await flush();
  await flush();

  const { value } = await readState(webServer);
  const ready = value.rows.filter((row) => row.status === 'ready');
  assert.equal(ready.length, 1);
  assert.equal(ready[0].seq, 21, 'the last report wins');
});

test('settings posted to the route change the route and the pack', async () => {
  const webServer = makeWebServer();
  const llm = makeLlm('套壳。');
  const ctx = makeCtx({ llm, webServer });
  apply(ctx, { enabled: true });
  ctx.bus.emit('session/event', { id: 's1' }, {
    type: 'request/header', seq: 1, time: 0,
    data: { header: { config: { provider: 'p', model: 'm' } }, reason: 'initial' },
  });

  const route = webServer.routes[0];
  const response = {
    statusCode: 0, body: '',
    writeHead(code) { this.statusCode = code; },
    end(body) { this.body = body ?? ''; },
  };
  const payload = JSON.stringify({ provider: 'other', model: 'zzz', pack: { identity: '一个冷淡的声音' } });
  const request = {
    url: '/persona-shell/settings',
    method: 'POST',
    async *[Symbol.asyncIterator]() { yield payload; },
  };
  await route.handler(request, response);
  assert.equal(response.statusCode, 200);

  await deliver(ctx, null, { seq: 30, text: '一段汇报。' });
  assert.equal(llm.calls.at(-1).provider, 'other');
  assert.equal(llm.calls.at(-1).model, 'zzz');
  assert.ok(llm.calls.at(-1).system.includes('一个冷淡的声音'));
});

test('disabling the row stops all rewriting', async () => {
  const webServer = makeWebServer();
  const llm = makeLlm('不会用到');
  const ctx = makeCtx({ llm, webServer });
  apply(ctx, { enabled: false });
  await deliver(ctx, null, { seq: 40, text: '一段汇报。' });
  assert.equal(llm.calls.length, 0);
  assert.equal(webServer.routes.length, 0);
});

test('a slow rewrite streams partial text before it settles', async () => {
  const webServer = makeWebServer();
  const llm = makeStreamingLlm(['鲸鲸看了', '一下配置，', '改好了 [[0]]。']);
  const ctx = makeCtx({ llm, webServer });
  apply(ctx, { enabled: true });
  ctx.bus.emit('session/event', { id: 's1' }, {
    type: 'request/header', seq: 1, time: 0,
    data: { header: { config: { provider: 'p', model: 'm' } }, reason: 'initial' },
  });

  await deliver(ctx, null, { seq: 50, text: '看了一下配置，改好了 `a.js`。' });

  // Mid-flight: the row is still pending but already carries text.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const during = await readState(webServer);
  const pendingRow = during.value.rows.find((row) => row.seq === 50);
  assert.ok(pendingRow, 'the row exists while the rewrite is running');
  assert.equal(pendingRow.status, 'pending');
  assert.ok(pendingRow.partial.length > 0, 'partial text is published before the rewrite finishes');
  assert.ok(Array.isArray(pendingRow.partialLiterals), 'the literal table travels with the partial');

  // Settled: the partial is dropped and the final text is validated and restored.
  await new Promise((resolve) => setTimeout(resolve, 700));
  const after = await readState(webServer);
  const doneRow = after.value.rows.find((row) => row.seq === 50);
  assert.equal(doneRow.status, 'ready');
  assert.equal(doneRow.partial, '', 'a settled row carries no partial');
  assert.ok(doneRow.text.includes('`a.js`'), 'the final text has its literals restored');
});

test('only the step that closes a turn is marked final', async () => {
  // The page puts the persona badge and the 「原文」 toggle on this row only, so
  // mid-turn narration is not papered with controls.
  const webServer = makeWebServer();
  const llm = makeLlm('鲸鲸看了 [[0]]。');
  const ctx = makeCtx({ llm, webServer });
  apply(ctx, { enabled: true });

  ctx.bus.emit('session/event', { id: 's1' }, { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } });
  await deliver(ctx, null, { seq: 60, text: '我看一下 `a.js`。', toolCall: true });
  await deliver(ctx, null, { seq: 61, text: '再看 `b.js`。', toolCall: true });
  await deliver(ctx, null, { seq: 62, text: '都看完了 `c.js`。' });

  const before = await readState(webServer);
  assert.ok(
    before.value.rows.every((row) => row.final !== true),
    'nothing is final until the turn ends',
  );

  ctx.bus.emit('session/event', { id: 's1' }, {
    type: 'turn/end', seq: 63, time: 0, data: { turn: 1, reason: { kind: 'completed' } },
  });

  const after = await readState(webServer);
  const finals = after.value.rows.filter((row) => row.final === true);
  assert.equal(finals.length, 1, 'exactly one row closes the turn');
  assert.equal(finals[0].seq, 62, 'the last report of the turn is the one');
});

test('user messages are observed through the data.content path', async () => {
  // Regression: `user/message` carries content at `data.content`, not at
  // `data.message.content`. The wrong path returns undefined without any error,
  // so the memory silently stayed empty while appearing to be wired up.
  const webServer = makeWebServer();
  const ctx = makeCtx({ llm: makeLlm('好。'), webServer });
  apply(ctx, { enabled: true });

  await deliverUser(ctx, { seq: 5, text: '帮我看一下这个配置文件对不对劲，我怀疑端口写错了。' });

  const route = webServer.routes.find((candidate) => candidate.path === '/persona-shell');
  const response = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
    end(body) { this.body = body ?? ''; },
  };
  await route.handler({ url: '/persona-shell/settings', method: 'GET' }, response);
  const payload = JSON.parse(response.body);

  assert.equal(payload.memoryStats.messages, 1, 'the message was counted');
  assert.ok(payload.memoryStats.hanShare > 0.5, 'its script was measured');
});

test('a subagent session is left alone by default, steps AND reports', async () => {
  // Both switches start off. A spawned helper's conversation is its own; the
  // user asked for the persona to stay in the main thread unless opted in.
  const webServer = makeWebServer();
  const llm = makeLlm('不该被调用。');
  const ctx = makeCtx({ llm, webServer });
  apply(ctx, { enabled: true });

  await deliver(ctx, null, { seq: 70, text: '我先看一下。', toolCall: true, delegationDepth: 1 });
  await deliver(ctx, null, { seq: 71, text: '看完了，结论是好的。', delegationDepth: 1 });

  assert.equal(llm.calls.length, 0, 'no rewrite is requested for a subagent');
  const { value } = await readState(webServer);
  const reasons = value.rows.map((row) => row.reason);
  assert.ok(reasons.includes('subagent-step-off'), 'the step is skipped as a subagent step');
  assert.ok(reasons.includes('subagent-report-off'), 'the report is skipped as a subagent report');
});

test('the two subagent switches are independent', async () => {
  // Enabling the report must not drag the step along with it: the user may want
  // the helper's conclusion voiced while its progress chatter stays plain.
  const webServer = makeWebServer();
  const llm = makeLlm('鲸鲸看完了 [[0]]。');
  const ctx = makeCtx({ llm, webServer });
  apply(ctx, { enabled: true, subagentReports: true });

  await deliver(ctx, null, { seq: 72, text: '我先看一下 `a.js`。', toolCall: true, delegationDepth: 1 });
  await deliver(ctx, null, { seq: 73, text: '看完了 `a.js`。', delegationDepth: 1 });

  assert.equal(llm.calls.length, 1, 'only the concluding report is rewritten');
  const { value } = await readState(webServer);
  const step = value.rows.find((row) => row.seq === 72);
  const report = value.rows.find((row) => row.seq === 73);
  assert.equal(step.status, 'skipped');
  assert.equal(report.status, 'ready');
});

test('history samples are masked, so literals never reach the model twice', async () => {
  // The leak this guards: the sample list stored `row.text`, which has its
  // literals restored, and it is replayed as `history` on the next call. A secret
  // or path from one report was therefore sent verbatim on the following step,
  // breaking the only guarantee this plugin makes about technical content.
  const webServer = makeWebServer();
  const llm = makeLlm('鲸鲸看了 [[0]]。');
  const ctx = makeCtx({ llm, webServer });
  apply(ctx, { enabled: true, keepSamples: 2 });

  await deliver(ctx, null, { seq: 80, text: '看了 `private-key-secret`。' });
  await deliver(ctx, null, { seq: 81, text: '又看了 `other.js`。' });

  assert.equal(llm.calls.length, 2, 'both rewrites ran');
  const secondPrompt = llm.calls[1].messages[0].content[0].text;
  assert.ok(
    !secondPrompt.includes('private-key-secret'),
    'the first literal must not appear verbatim in the second call',
  );
  assert.ok(secondPrompt.includes('{{0}}') || secondPrompt.includes('[['), 'a placeholder carries the voice instead');
});
