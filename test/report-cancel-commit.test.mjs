import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture as hostFixture, domain, jsonReply } from './helpers/persona-chat-host.mjs';
const fixture=(t,options)=>hostFixture(t,{modelInfo:async()=>({reasoning:{efforts:[{id:'off',name:'off'},{id:'low',name:'low'}]}}),...options});

const original = '交接记录已整理。', old = '交接记录已经整理好了。', fresh = '交接记录现已整理妥当。';
const read = (f, id) => f.request('report-visualization?session=' + id + '&seq=10&presentation=readable');
const post = (f, src, action, requestId, extra = {}) => f.request('report-visualization', {
  sessionId: src.sessionId, seq: src.seq, sourceHash: src.hash, action, requestId, regenerate: true, presentation: 'readable', ...extra,
});
const body = (f, source) => read(f, source.sessionId).then(r => r.value.result?.blocks?.[0]?.text);
async function publish(f, id) {
  const session = { id, header: {} };
  for (const [type, seq, data] of [['turn/start', 9, { turn: 1 }],
    ['assistant/message', 10, { turn: 1, message: { content: [{ type: 'text', text: original }] } }],
    ['turn/end', 11, { turn: 1, reason: { kind: 'completed' } }]]) f.bus.emit('session/event', session, { type, seq, data });
  return (await read(f, id)).value.source;
}
async function stage(t, fails = false) {
  const entered = Promise.withResolvers(), writing = Promise.withResolvers();
  let draft = old;
  const storage = domain(Promise.resolve(), { beforePut: async (key, value) => {
    if (key !== JSON.stringify(['report-views', 'saving']) || !value.reports.some(r => r.readable?.result.blocks[0].text === fresh)) return;
    entered.resolve(); await writing.promise; if (fails) throw Error('disk');
  } });
  const f = fixture(t, { storage, script: () => jsonReply({ schemaVersion: 3, blocks: [{ ref: 'b1', text: draft }] }) });
  t.after(() => writing.resolve());
  await f.ready(); await f.request('settings', { enabled: false, memory: false });
  const a = await publish(f, 'saving'), b = await publish(f, 'queued');
  for (const src of [a, b]) assert.equal((await post(f, src, 'generate', src.sessionId + '-old')).value.result.blocks[0].text, old);
  draft = fresh;
  const generating = post(f, a, 'generate', 'new-saving');
  await entered.promise;
  return { f, a, b, storage, generating, release: writing.resolve };
}

for (const fail of [false, true]) test('stopping after cache write started preserves its actual ' + (fail ? 'failure' : 'success') + ' after restart', async t => {
  const { f, a, storage, generating, release } = await stage(t, fail);
  let receipt;
  try {
    assert.equal(await body(f, a), old);
    receipt = await post(f, a, 'cancel', 'new-saving');
    assert.deepEqual(await post(f, a, 'cancel', 'new-saving'), receipt);
  } finally { release(); }
  const done = await generating;
  assert.equal(receipt.value.outcome, 'saving');
  assert.equal(done.status, fail ? 503 : 200);
  if (fail) assert.equal(done.value.error, 'report-save-failed'); else assert.equal(done.value.result.blocks[0].text, fresh);
  assert.equal((await post(f, a, 'cancel', 'new-saving')).value.outcome, 'settled');
  assert.deepEqual(await post(f, a, 'generate', 'new-saving'), done);
  assert.equal(f.calls.length, 3);
  assert.equal(await body(f, a), fail ? old : fresh);
  await f.dispose();
  const restored = fixture(t, { storage }); await restored.ready();
  assert.equal(await body(restored, a), fail ? old : fresh);
  assert.equal(restored.calls.length, 0);
});

test('a parsed result waiting in the shared writer can still be cancelled, without affecting a different session at commit', async t => {
  const { f, a, b, storage, generating, release } = await stage(t);
  let pending, stopped;
  try {
    pending = post(f, b, 'generate', 'new-queued'); await f.ready();
    assert.equal(f.calls.length, 4);
    assert.equal((await post(f, a, 'cancel', 'new-queued')).status, 409); // same source hash, different session
    assert.equal((await post(f, b, 'cancel', 'new-queued', { sourceHash: '0'.repeat(64) })).status, 409);
    stopped = await post(f, b, 'cancel', 'new-queued');
    let early; pending.then(r => { early = r; }); await f.ready();
    assert.equal(early?.value.error, 'report-cancelled', 'a cancelled waiter finishes before the separate write is released');
  } finally { release(); }
  const [saved, cancelled] = await Promise.all([generating, pending]);
  assert.equal(stopped.value.outcome, 'cancelled'); assert.equal(saved.status, 200);
  assert.equal(cancelled.value.error, 'report-cancelled'); assert.equal(cancelled.status, 409);
  assert.deepEqual(await post(f, b, 'generate', 'new-queued'), cancelled);
  assert.equal(await body(f, b), old); assert.equal(await body(f, a), fresh);
  await f.dispose(); const restored = fixture(t, { storage }); await restored.ready();
  assert.equal(await body(restored, b), old); assert.equal(await body(restored, a), fresh);
});

test('a stop arriving before its generate is bound to the exact source, even after other early stops', async t => {
  const f = fixture(t, { script: () => jsonReply({ schemaVersion: 3, blocks: [{ ref: 'b1', text: old }] }) });
  await f.ready(); await f.request('settings', { enabled: false, memory: false });
  const a = await publish(f, 'early'), stale = { sourceHash: '0'.repeat(64) };
  assert.equal((await post(f, a, 'cancel', 'stale-only', stale)).value.outcome, 'cancelled');
  assert.equal((await post(f, a, 'generate', 'stale-only')).status, 200);
  assert.equal((await post(f, a, 'cancel', 'both')).value.outcome, 'cancelled');
  await post(f, a, 'cancel', 'both', stale);
  assert.equal((await post(f, a, 'generate', 'both')).value.error, 'report-cancelled');
  assert.equal(f.calls.length, 1);
});

test('Host shutdown drains a write already committed to storage and does not misreport its result as a cancellation', async t => {
  const { f, a, storage, generating, release } = await stage(t);
  const closing = f.dispose(); await f.ready(); release();
  const [saved] = await Promise.all([generating, closing]); assert.equal(saved.status, 200);
  const reopened = fixture(t, { storage }); await reopened.ready(); assert.equal(await body(reopened, a), fresh);
});
