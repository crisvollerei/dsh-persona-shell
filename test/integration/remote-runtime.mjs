// Optional integration: real rc.3 Cordis, registry, Gateway, Connection and stream supervisors.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { makeSlots } from '../helpers/slots.mjs';
import { apply } from '../../index.js';
import { createRemoteContract } from '../../lib/remote-contract.js';
import { createClientTransport } from '../../lib/client-transport.js';

const { values } = parseArgs({ options: { deps: { type: 'string' } } });
assert.ok(values.deps, 'Pass --deps <test dependencies package.json>');
const require = createRequire(values.deps);
const load = (name) => import(pathToFileURL(require.resolve(name)));
for (const name of ['dsh-api-gateway', 'dsh-client-connection', 'dsh-typert-registry']) {
  assert.equal(require(`@deepseek-ai/${name}/package.json`).version, '0.2.1-rc.3');
}
const { Context } = await load('@deepseek-ai/cordis');
const { default: Registry } = await load('@deepseek-ai/dsh-typert-registry');
const { default: Gateway } = await load('@deepseek-ai/dsh-api-gateway');
const { Peer } = await load('@deepseek-ai/dsh-client-connection');
const clientConnection = await load('@deepseek-ai/dsh-client-connection/client');
const clientGateway = await load('@deepseek-ai/dsh-api-gateway/client');
const host = new Context();
const client = new Context();
const routes = [];
const statuses = [];
const received = [];
let hostPlugin;
let transport;
let calls = 0;
const pause = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, label) {
  for (let i = 0; i < 400; i++) { if (predicate()) return; await pause(); }
  throw new Error(`Timed out: ${label}; ${JSON.stringify(statuses)}`);
}
async function request(url, body) {
  let value;
  const handler = routes.at(-1).handler;
  await handler({ url, method: body ? 'POST' : 'GET', headers: {},
    async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)); } },
  { writeHead(code) { assert.equal(code, 200); }, end(text) { value = JSON.parse(text); } });
  return value;
}
try {
  await host.plugin(Registry);
  // The integration uses an owner Peer; policy assembly is not under test.
  host.provide('remoteAccess', { decide: () => ({ kind: 'allow' }) });
  await host.plugin(Gateway, {});
  host.provide('webServer', { register(route) {
    routes.push(route); return () => routes.splice(routes.indexOf(route), 1);
  } });
  host.provide('llm', { stream() { calls++; throw new Error('No model calls in transport tests'); } });
  host.typertGateway.registerRemoteEvents((signal) => (async function* () {
    if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  })(), { home: 'test-home' });
  const peer = new Peer(host, { principal: { kind: 'owner' } });
  const config = { allowUnauthenticatedRoutes: true, progressNotices: false };
  hostPlugin = await host.plugin({ name: 'persona-shell-under-test', apply: (ctx) => apply(ctx, config) });
  await until(() => host.get('personaShell'), 'Host service active');
  const guest = new Peer(host, { principal: { kind: 'test-guest' } });
  await assert.rejects(async () => {
    const source = await host.typertGateway.stream({ namespace: 'personaShell', method: 'observe',
      args: { key: '' }, peer: guest, signal: new AbortController().signal });
    for await (const _frame of source) assert.fail('a guest must not receive any state');
  }, (error) => error.code === 'persona-shell/owner-required');
  await guest.dispose();
  await client.plugin(Registry);
  await client.plugin({ apply(ctx) {
    clientConnection.installConnection(ctx, { interactions: 'answer', transport: {
      ownsHost: true,
      rpc: {
        call: async () => ({ ok: true, value: undefined }),
        async *open(channel, endpoint, payload, signal, uplink) {
          assert.equal(channel, '/api');
          yield* await host.typertGateway.wireStream.open(endpoint, payload, uplink, peer, signal);
        },
      },
    } });
  } });
  await client.plugin({ inject: clientGateway.inject, apply: clientGateway.apply });
  await until(() => client.connection.generation.getSnapshot(), 'official Connection generation');
  let sequence = 0;
  transport = createClientTransport({ remote: client.remote, SnapshotStream: clientGateway.RemoteSnapshotStream,
    CarrierError: clientGateway.RemoteStreamCarrierError, contribution: createRemoteContract(),
    viewer: 'runtime-viewer', nextRequest: () => ++sequence,
    onState: (key, state) => received.push({ key, state }),
    onStatus: (key, status, error) => statuses.push({ key, status, code: error?.code, message: error?.message }),
  });
  transport.subscribe(''); transport.subscribe('s1');
  await transport.start();
  await until(() => transport.status('') === 'ready' && transport.status('s1') === 'ready', 'opening snapshots');
  const oldInstance = received.find((item) => item.key === 's1').state.instanceId;
  await request('/persona-shell/session-switch', { sessionId: 's1', enabled: false });
  await until(() => received.some((item) => item.key === 's1' && item.state.sessionEnabled === false), 'session delta');
  await until(() => received.some((item) => item.key === '' && item.state.sessionSwitches.values.s1 === false), 'control delta');
  await request('/persona-shell/settings', { enabled: false });
  await until(() => received.some((item) => item.key === '' && item.state.settings.enabled === false), 'global off');
  await request('/persona-shell/settings', { enabled: true });
  await until(() => received.filter((item) => item.key === '').at(-1).state.settings.enabled === true, 'global re-enable');
  transport.setView({ sessionId: 's1', revision: 1, visible: true });
  client.connection.reconnect();
  await until(() => host.typertGateway.hasLiveClient(), 'Connection reconnect');
  await pause(50);
  assert.equal(transport.status('s1'), 'ready');
  await hostPlugin.dispose(); hostPlugin = undefined;
  hostPlugin = await host.plugin({ name: 'persona-shell-reloaded', apply: (ctx) => apply(ctx, config) });
  await until(() => host.get('personaShell'), 'replacement Host');
  transport.restart();
  await until(() => received.some((item) => item.key === 's1' && item.state.instanceId !== oldInstance), 'replacement baseline');
  const replacement = received.filter((item) => item.key === 's1').at(-1).state;
  assert.equal(replacement.rows.length, 0);
  assert.equal(replacement.sessionEnabled, true);
  const ping = await request('/persona-shell/ping');
  assert.ok(ping.stateSync.snapshots >= 2);
  await transport.dispose(); transport = undefined;
  await pause(20);
  assert.equal((await request('/persona-shell/ping')).stateSync.active, 0);
  // Exercise the real browser entry from an injected Cordis fiber, not root:
  // root reads bypass the namespace-inject checks that Desktop enforces.
  const fixture = makeSlots();
  client.provide('slots', fixture.slots);
  let definition;
  const browserRequests = [];
  vm.runInNewContext(readFileSync(new URL('../../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load(value) { definition = value; } } }, console,
    setTimeout, clearTimeout, setInterval, clearInterval, URLSearchParams, AbortController,
    async fetch(url, options) {
      browserRequests.push(url);
      const body = options?.body ? JSON.parse(options.body) : undefined;
      const value = await request(url, body);
      return { ok: true, json: async () => value };
    },
  });
  const module = definition.factory((id) => {
    if (id === 'react') return { createElement: (type, props) => ({ type, props }), useEffect() {} };
    if (id === '@deepseek-ai/dsh-api-gateway') return clientGateway;
    throw new Error(`Unexpected browser import: ${id}`);
  });
  const browserPlugin = await client.plugin({ inject: ['slots'], apply: module.apply });
  const stopWatch = module.__testing.watchState('s1', 7);
  await until(() => module.__testing.getHostState('s1')?.instanceId, 'production browser entry state');
  await until(() => received.length > 0, 'settled observers');
  await pause(30);
  const beforeRequests = browserRequests.filter((url) => url.includes('/state?')).length;
  await request('/persona-shell/session-switch', { sessionId: 's1', enabled: false });
  await until(() => module.__testing.getHostState('s1')?.sessionEnabled === false, 'production browser delta');
  await pause(30);
  assert.equal(browserRequests.filter((url) => url.includes('/state?')).length, beforeRequests,
    'ready Remote subscription no longer reissues long-polls');
  assert.equal((await request('/persona-shell/ping')).stateSync.client, 'ready');
  stopWatch(); await browserPlugin.dispose();
  await until(() => fixture.subscriberCount() === 0, 'browser listeners released');
  assert.equal((await request('/persona-shell/ping')).stateSync.active, 0);
  assert.equal(calls, 0);
  console.log(JSON.stringify({ result: 'passed', runtime: 'official 0.2.1-rc.3',
    checks: ['strict Host registration and service binding', 'owner-only even under permissive access policy', 'official Connection generation and reconnect',
      'snapshot and control/session deltas', 'global disable/re-enable', 'independent Host reload',
      'production browser entry in an injected Cordis fiber', 'no long-polls after push readiness',
      'stream disposal leaves zero active subscribers', 'zero model calls'],
    limitations: 'In-process carrier; Desktop and network authentication are verified separately.' }, null, 2));
} finally {
  await transport?.dispose(); await client.fiber.dispose(); await hostPlugin?.dispose(); await host.fiber.dispose();
}
