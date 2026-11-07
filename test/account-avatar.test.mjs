import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

function factory() {
  let definition;
  vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load(value) { definition = value; } } },
    URL, setTimeout, clearTimeout, console,
  });
  return definition.factory((id) => {
    if (id === 'react') return { createElement() {}, memo: (fn) => fn };
    throw Error('optional module');
  }).__testing.createAccountAvatarSource;
}
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); };
const ready = (avatarUrl) => ({ ok: true, value: { status: 'ready', value: { avatarUrl, name: 'NOT_RETAINED', contact: 'NOT_RETAINED' } } });
const client = () => ({ version: 'test', locale: 'zh-CN', timezoneOffsetSeconds: 28800 });

test('account reader is lazy, display-only and accepts only safe HTTPS pictures', async () => {
  const source = factory()(); let calls = 0, raw = 'https://avatar.test/a.webp';
  source.bind({ account: { getState: async () => ({ ok: true, value: { status: 'credential-stored' } }),
    async getProfile(metadata) { calls++; assert.equal(metadata.version, 'test'); return ready(raw); } } }, client);
  assert.equal(calls, 0); const stop = source.subscribe(() => {}); await flush();
  assert.equal(source.read(), raw); assert.equal(typeof source.read(), 'string');
  for (const bad of ['http://avatar.test/a', 'javascript:alert(1)', 'data:image/svg+xml,evil', 'https://user:password@avatar.test/a', 'file:///a']) {
    raw = bad; await source.refresh(); assert.equal(source.read(), null);
  }
  stop(); assert.equal(source.read(), null); const before = calls; await source.refresh(); assert.equal(calls, before);
});

test('sign-out and disposal retire pending profile reads; an old account cannot restore its picture', async () => {
  const source = factory()(); let release, push, finish;
  const frames = []; const waiters = [];
  const opened = { async *[Symbol.asyncIterator]() { while (true) {
    if (!frames.length) await new Promise(r => waiters.push(r));
    const value = frames.shift(); if (!value) return; yield { value, accept() {} };
  } }, dispose() { finish(); } };
  push = (status) => { frames.push({ status }); waiters.shift()?.(); };
  finish = () => { frames.push(null); waiters.shift()?.(); };
  const unbind = source.bind({ $stream: () => opened, account: { watch() {},
    getProfile: () => new Promise(r => { release = r; }) } }, client);
  const stop = source.subscribe(() => {}); push('credential-stored'); await flush();
  push('signed-out'); await flush(); release(ready('https://avatar.test/old.webp')); await flush(); assert.equal(source.read(), null);
  push('credential-stored'); await flush(); unbind(); release(ready('https://avatar.test/late.webp')); await flush();
  assert.equal(source.read(), null); stop();
});

test('failed and absent account APIs leave no avatar and never require sign-in', async () => {
  const source = factory()(); const stop = source.subscribe(() => {});
  await source.refresh(); assert.equal(source.read(), null);
  source.bind({ account: { getState: async () => ({ ok: false }) } }, client); await flush(); assert.equal(source.read(), null);
  source.bind({ account: { getState: async () => { throw Error('offline'); } } }, client); await flush(); assert.equal(source.read(), null); stop();
});

test('a timed-out profile request cannot publish a late picture', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = factory()(); let release;
  source.bind({ account: { getState: async () => ({ ok: true, value: { status: 'credential-stored' } }),
    getProfile: () => new Promise(r => { release = r; }) } }, client);
  const stop = source.subscribe(() => {}); await flush();
  t.mock.timers.tick(5000); await flush(); assert.equal(source.read(), null);
  release(ready('https://avatar.test/too-late.webp')); await flush(); assert.equal(source.read(), null); stop();
});
