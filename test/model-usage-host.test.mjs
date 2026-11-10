import {readChatInput} from './helpers/chat-input.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, domain, newRoom, roomSend, settledRoom, whale, dragon } from './helpers/persona-chat-host.mjs';

function withReceipt(text, tokens) {
  return (async function* () {
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'usage', usage: { inputTokens: tokens, outputTokens: 2 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })();
}

test('authenticated host analytics separate chat, participation and rewrite routes; reopening restores exact counts with no text or new calls', async t => {
  const storage = domain(), f = fixture(t, { storage, config: { chatProvider: 'chat-provider', chatModel: 'chat-model' },
    script: opts => opts.provider === 'chat-provider' ? withReceipt('{"messages":["嗨。"]}', 11) : withReceipt('这是正式汇报。', 6),
    directorScript: options => { const input=readChatInput(options), event=input.events.findLast(event=>event.author.role==='user');
      const next=input.events.some(event=>event.author.role==='assistant')?null:{id:whale,kind:'normal',to:'user',
        evidence:{eventId:event.id,index:0,text:event.messages[0]},goal:'自然回应用户。'};
      return withReceipt(JSON.stringify({context:{work:'required',sourceIds:input.sources.map(s=>s.id),request:'answer',evidence:input.message},next}),4);} });
  await f.ready();
  assert.equal((await f.request('model-usage', undefined, false)).status, 403);
  assert.equal((await f.request('model-usage', {})).status, 405);
  assert.equal((await f.request('model-usage?days=999')).status, 400);
  assert.equal((await f.request('model-usage')).value.totals.calls, 0);
  const room = await newRoom(f, [whale, dragon]); await roomSend(f, room, whale, 'TEST_PRIVATE_CONVERSATION'); await settledRoom(f, room);
  f.bus.emit('session/event', { id: 'formal', header: {} }, { seq: 5, type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '这是原始汇报。' }] } } });
  await f.ready();
  const r = (await f.request('model-usage?days=1')).value;
  assert.deepEqual(r.purposes.map(p => [p.purpose, p.totalTokens]).sort(), [['chat', 13], ['chat-participation', 12], ['rewrite', 8]]);
  assert.equal(f.directors.length,2); assert.equal(f.plans.length+f.continuations.length,0);
  assert.deepEqual(r.models.map(m => [m.provider, m.model, m.calls]).sort(), [['chat-provider', 'chat-model', 3], ['p', 'm', 1]]);
  assert.equal(r.persistence, 'local'); assert.equal(r.daily.length, 1);
  await f.dispose();
  const stored = storage.tables.get('profile').get('modelUsage');
  assert.doesNotMatch(JSON.stringify(stored), /TEST_PRIVATE_CONVERSATION|原始汇报|正式汇报|讨论室|嗨|formal/);
  const next = fixture(t, { storage }); await next.ready();
  assert.deepEqual((await next.request('model-usage?days=1')).value, r);
  assert.equal(next.calls.length + next.directors.length, 0);
});

test('a failed analytics write does not fail chat and is retried on unload without losing receipts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let fail = true;
  const storage = domain(Promise.resolve(), { fail: id => id === 'modelUsage' && fail });
  const f = fixture(t, { storage, script: () => withReceipt('{"messages":["收到。"]}', 17) });
  await f.ready(); await f.send('仅用于测试'); await f.ready();
  assert.equal(f.calls.length,1);assert.equal(f.directors.length,1,'a solo reply consumes its user event without another empty director call');
  assert.equal((await f.request('model-usage')).value.totals.totalTokens, 19);
  t.mock.timers.tick(1500); await f.ready();
  assert.equal((await f.request('model-usage')).value.persistence, 'failed');
  fail = false; await f.dispose();
  const reopened = fixture(t, { storage }); await reopened.ready();
  const r = (await reopened.request('model-usage')).value;
  assert.equal(r.persistence, 'local'); assert.equal(r.totals.calls, 2); assert.equal(r.totals.totalTokens, 19);
  assert.equal(r.purposes.find(row=>row.purpose==='chat').calls,1);
  assert.equal(r.purposes.find(row=>row.purpose==='chat-participation').calls,1);
});

test('a delayed disk write cannot overwrite a newer snapshot when the plugin unloads', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release, writing = 0; const gate = new Promise(r => { release = r; }), persisted = [];
  const storage = domain(Promise.resolve(), { async beforePut(id, value) {
    if (id !== 'modelUsage') return;
    assert.equal(writing++, 0, 'analytics writes must be serialized');
    try { if (!persisted.length) await gate; persisted.push(value.rows.reduce((n,r) => n + r.calls, 0)); }
    finally { writing--; }
  } });
  const f = fixture(t, { storage, script: () => withReceipt('{"messages":["嗨。"]}', 4) });
  await f.ready(); await f.send('第一条'); await f.ready();
  t.mock.timers.tick(1500); await f.ready(); assert.equal(writing, 1);
  await f.send('第二条', whale, 'second-call'); await f.ready();
  assert.equal(f.calls.length,2);assert.equal(f.directors.length,2);assert.equal(f.requests.length,4);
  const disposed = f.dispose(); release(); await disposed;
  assert.deepEqual(persisted, [2, 4]);
  const saved=storage.tables.get('profile').get('modelUsage');
  assert.equal(saved.rows.reduce((sum,row)=>sum+row.calls,0),4,'the newer snapshot must remain authoritative after the blocked older write drains');
});
