// Optional real-Cordis lifecycle/waterfall check; provider and Agent are test doubles.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { mock } from 'node:test';
import { apply } from '../../index.js';

const { values } = parseArgs({ options: { cordis: { type: 'string' } } });
assert.ok(values.cordis, 'Pass --cordis <@deepseek-ai/cordis/lib/index.js>');
const { Context } = await import(pathToFileURL(path.resolve(values.cordis)));
const root = new Context();
const flush = async () => { for (let i = 0; i < 40; i += 1) await Promise.resolve(); };
mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
const calls = [];
const session = { id: 'main', header: {}, append() { assert.fail('no session writes'); } };
const agent = { session, status: 'running' };
let route;
const services = new Map([
  ['agents', { get: (id) => id === session.id ? agent : undefined }],
  ['webServer', { register(value) { route = value.handler; return () => { route = undefined; }; } }],
  ['llm', { stream(options) { calls.push(options); return (async function* () {
    yield { type: 'text-delta', text: '还没有新的结果，先来报个到。' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })(); } }],
]);
let resolveAnswer;
const answer = { answers: ['original human answer'] };
root.on('user-questions/request', () => new Promise((resolve) => { resolveAnswer = resolve; }));
let fiber;
try {
  fiber = await root.plugin({ name: 'progress-host-probe', apply(ctx) {
    const facade = {
      get: (key) => services.get(key), logger: { warn() {} },
      on: ctx.on.bind(ctx), effect: ctx.effect.bind(ctx),
      inject(names, callback) { if (names.every((key) => services.has(key))) callback(facade); return () => {}; },
    };
    apply(facade, { progressNotices: true, provider: 'test', model: 'test', allowUnauthenticatedRoutes: true });
  } });
  let seq = 0;
  const emit = (type, data) => root.emit('session/event', session, { type, seq: ++seq, data });
  async function state() {
    let body;
    await route({ url: '/persona-shell/state?session=main&viewing=1&viewer=runtime&viewRev=1', method: 'GET' },
      { writeHead(code) { assert.equal(code, 200); }, end(value) { body = JSON.parse(value); } });
    return body;
  }
  async function elapse(ms) {
    while (ms > 0) { await state(); const step = Math.min(ms, 30000); mock.timers.tick(step); await flush(); ms -= step; }
  }
  emit('turn/start', { turn: 1 });
  const pending = root.waterfall('user-questions/request', { agent, questions: ['private question'] }, () => Promise.resolve(null));
  await flush();
  assert.equal(typeof resolveAnswer, 'function', 'real waterfall reached the existing answerer');
  await elapse(600000);
  assert.equal(calls.length, 0, 'prepend observer suppresses notices throughout the actual waterfall wait');
  resolveAnswer(answer);
  assert.equal(await pending, answer, 'the original answer passes through unchanged');
  await flush(); await elapse(300000);
  assert.equal(calls.length, 1);
  assert.ok((await state()).progress);
  assert.ok(!JSON.stringify(calls[0]).includes('private question'));
  root.emit('agent/assistant-stream', { agent, frame: { type: 'start', turn: 1, attemptId: 'attempt' } });
  root.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', attemptId: 'attempt', chunk: { type: 'text-delta', text: 'real main report' } } });
  assert.equal((await state()).progress, undefined);
  await fiber.dispose(); fiber = undefined;
  assert.equal(route, undefined, 'real Cordis disposal removes the route and owned effects');
  mock.timers.tick(600000); await flush();
  assert.equal(calls.length, 1, 'unload never restarts progress calls');
  console.log(JSON.stringify({ result: 'passed', assertions: ['production Host + real Cordis emit/waterfall/effect',
    'existing human answerer unchanged', 'no notices during human wait', 'facts-only extra call',
    'main text withdraws notice', 'unload releases timers/listeners/route'],
    limitations: 'Agent and LLM are test doubles; not a live Desktop, scope-driver or real-provider test.' }, null, 2));
} finally {
  await fiber?.dispose();
  await root.fiber.dispose();
  mock.timers.reset();
}
