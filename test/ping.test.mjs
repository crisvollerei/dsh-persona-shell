// The public liveness probe is the one endpoint answered BEFORE authentication,
// so its shape is a security boundary, not a convenience. These tests pin that
// boundary: a fixed enum/range for every field, no forwarding of internal text,
// and a diagnostic-key list drawn from a whitelist rather than from whatever the
// client happened to report.
// Run with: node --test persona-shell/test/ping.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { apply } from '../index.js';

/**
 * A fake Cordis context with a switchable Connection service.
 *
 * `mode` is mutable so one test can let the page report normally and then make
 * the auth check throw — the exact sequence that used to leak the thrown
 * message through the public probe.
 */
function makeCtx() {
  const bus = new EventEmitter();
  const services = new Map();
  const disposers = [];
  /** How `requestRejection` behaves: 'allow' | 'deny' | 'throw'. */
  const connection = { mode: 'allow' };

  const ctx = {
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
      return dispose;
    },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  };

  connection.requestRejection = () => {
    if (connection.mode === 'throw') throw new Error('secret-internal-token');
    if (connection.mode === 'deny') return 401;
    return undefined;
  };

  services.set('llm', { calls: [], stream() { return (async function* empty() {})(); } });
  services.set('connection', connection);
  return { ctx, connection };
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

/** One route provider plus a fresh consumer response object. */
function routeOf(webServer) {
  const route = webServer.routes.find((candidate) => candidate.path === '/persona-shell');
  assert.ok(route, 'the plugin route was registered');
  return route;
}

/**
 * Issue one request through the plugin's route handler.
 * @param {ReturnType<typeof routeOf>} route
 * @param {{ url: string, method?: string, body?: unknown, headers?: object }} request
 */
async function call(route, { url, method = 'GET', body, headers = {} }) {
  const request = {
    url,
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  };
  const response = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, responseHeaders) { this.statusCode = code; this.headers = responseHeaders; },
    end(chunk) {
      // Guard against `undefined` being stringified as the literal "undefined".
      this.body = chunk === undefined ? '' : String(chunk);
    },
  };
  await route.handler(request, response);
  return response;
}

const ping = async (route) => JSON.parse((await call(route, { url: '/persona-shell/ping' })).body);

/** Mount the plugin with the fake webserver visible from `apply`. */
function mount() {
  const webServer = makeWebServer();
  const { ctx, connection } = makeCtx();
  const withServer = { ...ctx, get: (key) => (key === 'webServer' ? webServer : ctx.get(key)) };
  apply(withServer, { enabled: true });
  return { webServer, connection };
}

/** The exact key names the public probe is allowed to publish. */
const PUBLIC_KEYS = ['applied', 'authCounts', 'authStatus', 'clientBuild', 'heartbeat', 'shippedMarkdown'];

test('the public probe never forwards internal text', async () => {
  const { webServer, connection } = mount();

  // The page reports normally, including values that must never become public.
  const posted = await call(routeOf(webServer), {
    url: '/persona-shell/diagnostics',
    method: 'POST',
    body: {
      sentinel: 'secret-internal-token',
      shippedMarkdown: 'a-value-that-is-not-an-enum',
      clientBuild: 'not-an-integer',
      heartbeat: Number.MAX_SAFE_INTEGER,
      stateTransport: { status: 'secret-internal-token', message: 'secret-internal-token', sessionId: 'private-session' },
    },
  });
  assert.equal(posted.statusCode, 200, 'the authenticated report lands');

  // Now the auth check starts throwing; its message is internal.
  connection.mode = 'throw';
  const rejected = await call(routeOf(webServer), { url: '/persona-shell/state?session=s1' });
  assert.equal(rejected.statusCode, 403, 'a throwing check still refuses the request');

  const { statusCode, body } = await call(routeOf(webServer), { url: '/persona-shell/ping' });
  assert.equal(statusCode, 200, 'the probe answers before auth');
  assert.ok(!body.includes('secret-internal-token'), 'internal text never crosses the boundary');

  const value = JSON.parse(body);
  assert.ok(Number.isInteger(value.hostBuild), 'the host build id is always published, even in the failure case');
  assert.equal(value.auth, 'error', 'the failure is reported as a fixed enum');
  assert.equal(value.shippedMarkdown, 'unknown', 'unexpected enum values degrade to unknown');
  assert.equal(value.clientBuild, null, 'a non-integer build id is not published');
  assert.equal(value.heartbeatAge, null, 'a future heartbeat is not published as a negative age');
  assert.equal(value.storage, 'unavailable', 'no storage facility is reported honestly');
  assert.equal(value.rows, 0);
  assert.deepEqual(value.stateSync, { active: 0, opened: 0, snapshots: 0, deltas: 0, client: 'unknown' });
  assert.ok(!body.includes('private-session'), 'transport details are never forwarded');

  // Only whitelisted key names; the unknown `sentinel` key is not even named.
  for (const key of value.diagnosticKeys) {
    assert.notEqual(key, 'sentinel', 'an unrecognised report key is not named publicly');
    assert.notEqual(key, 'at', 'the internal report timestamp is not public');
    assert.ok(PUBLIC_KEYS.includes(key), `${key} is not a whitelisted diagnostic key`);
  }

  // The authenticated diagnostics route still refuses this request.
  const guarded = await call(routeOf(webServer), { url: '/persona-shell/diagnostics' });
  assert.equal(guarded.statusCode, 403, 'the detail endpoint keeps its own check');
});

test('the public probe reports the healthy case honestly', async () => {
  const { webServer, connection } = mount();

  // An authenticated report arrives first, as a live page would send it.
  await call(routeOf(webServer), {
    url: '/persona-shell/diagnostics',
    method: 'POST',
    body: { clientBuild: 20261027, shippedMarkdown: 'ok', heartbeat: Date.now(), stateTransport: { status: 'ready' } },
  });

  // A denied request records the rejection, then an allowed one the success.
  connection.mode = 'deny';
  await call(routeOf(webServer), { url: '/persona-shell/state?session=s1' });
  connection.mode = 'allow';

  const value = await ping(routeOf(webServer));
  assert.ok(Number.isInteger(value.hostBuild), 'the host build id is published');
  assert.equal(value.clientBuild, 20261027);
  assert.equal(value.shippedMarkdown, 'ok');
  assert.equal(value.stateSync.client, 'ready');
  assert.ok(Number.isInteger(value.heartbeatAge) && value.heartbeatAge >= 0, 'a real heartbeat has an age');
  assert.ok(['ok', 'rejected'].includes(value.auth), 'the latest auth outcome is an enum');
  assert.equal(value.storage, 'unavailable', 'still no storage facility');
  for (const key of value.diagnosticKeys) {
    assert.ok(PUBLIC_KEYS.includes(key), `${key} is not a whitelisted diagnostic key`);
  }
});
