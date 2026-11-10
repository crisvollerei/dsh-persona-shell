import {readChatInput} from './helpers/chat-input.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { domain, fixture, flush, newRoom, roomSend, roomState, settledRoom, reply, directorReply, whale } from './helpers/persona-chat-host.mjs';

const KEY = 'chatLocalStateKey';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const input = options => readChatInput(options);
function gate(t) { let open; const promise = new Promise(resolve => { open = resolve; }); t.after(open); return { promise, open }; }
function trackedStorage({ onKeyGet, beforeKeyPut, failKeyPut = () => false, saved, openGate = Promise.resolve() } = {}) {
  const stats = { reads: 0, writes: [], closes: 0 };
  const storage = domain(openGate, {
    onGet(id) { if (id === KEY) { stats.reads++; onKeyGet?.(); } },
    async beforePut(id, value) { if (id === KEY) { stats.writes.push(structuredClone(value)); await beforeKeyPut?.(value); } },
    fail: id => id === KEY && failKeyPut(),
  });
  if (saved !== undefined) storage.tables.set('profile', new Map([[KEY, saved]]));
  const originalOpen = storage.open.bind(storage);
  storage.open = async (...args) => {
    const handle = await originalOpen(...args), originalClose = handle.close.bind(handle);
    handle.close = async () => { stats.closes++; await originalClose(); };
    return handle;
  };
  return { storage, stats };
}

test('normal settings and workflow-state reads leave the chat UI namespace completely lazy', async t => {
  const { storage, stats } = trackedStorage(), f = fixture(t, { storage }); await f.ready();
  assert.equal((await f.request('settings')).status, 200);
  assert.equal((await f.request('state?session=work')).status, 200);
  assert.equal((await f.request('chat-work-draft')).status, 200);
  assert.equal((await f.request('chat-rooms', { action: 'create', requestId: 'no-chat-open', name: '尚未打开的聊天室',
    memberIds: [whale], targetPersonaId: whale, epoch: 0 })).status, 200);
  assert.equal(stats.reads, 0); assert.equal(stats.writes.length, 0);
  assert.equal(storage.tables.get('profile').has(KEY), false);
  assert.equal(f.calls.length + f.selections.length + f.judgements.length, 0);
});

test('opening chat before storage is ready does not queue a hidden namespace initialization after restore', async t => {
  const wait = gate(t), { storage, stats } = trackedStorage({ openGate: wait.promise }), f = fixture(t, { storage });
  const loading = await f.request('chat'); assert.equal(loading.status, 200); assert.equal(loading.value.ready, false);
  assert.equal(Object.hasOwn(loading.value, 'localStateKey'), false); assert.equal(stats.reads, 0);
  wait.open(); await f.ready(); assert.equal(stats.reads, 0); assert.equal(stats.writes.length, 0);
  const opened = await f.request('chat'); assert.equal(opened.value.ready, true); assert.match(opened.value.localStateKey, uuid);
});

test('only an authenticated valid GET chat may initialize the durable UI namespace', async t => {
  const { storage, stats } = trackedStorage(), f = fixture(t, { storage }); await f.ready();
  assert.equal((await f.request('chat', undefined, false)).status, 403);
  assert.equal((await f.request('chat?room=not-a-room')).status, 404);
  assert.equal((await f.request('chat?session=')).status, 400);
  assert.equal(stats.reads, 0); assert.equal(stats.writes.length, 0);
  const opened = await f.request('chat'); assert.equal(opened.status, 200); assert.match(opened.value.localStateKey, uuid);
  assert.deepEqual(storage.tables.get('profile').get(KEY), { version: 1, id: opened.value.localStateKey });
  assert.equal(stats.reads, 1); assert.equal(stats.writes.length, 1);
});

test('concurrent first chat requests share one pending durable namespace operation', async t => {
  const wait = gate(t), { storage, stats } = trackedStorage({ beforeKeyPut: () => wait.promise }), f = fixture(t, { storage }); await f.ready();
  const first = f.request('chat'), second = f.request('chat?persona=' + encodeURIComponent(whale));
  try {
    await flush(); assert.equal(stats.reads, 1); assert.equal(stats.writes.length, 1);
    assert.equal(storage.tables.get('profile').has(KEY), false);
  } finally { wait.open(); }
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 200); assert.equal(b.status, 200); assert.match(a.value.localStateKey, uuid);
  assert.equal(b.value.localStateKey, a.value.localStateKey);
  assert.equal((await f.request('chat')).value.localStateKey, a.value.localStateKey);
  assert.equal(stats.reads, 1); assert.equal(stats.writes.length, 1);
});

test('a durable namespace survives host restart and stays distinct for another storage profile', async t => {
  const { storage, stats } = trackedStorage(), first = fixture(t, { storage }); await first.ready();
  const original = (await first.request('chat')).value.localStateKey; assert.match(original, uuid); await first.dispose();
  const restarted = fixture(t, { storage }); await restarted.ready();
  assert.equal(stats.reads, 1, 'restart restores ordinary settings without reading the chat-only key');
  assert.equal((await restarted.request('chat')).value.localStateKey, original);
  assert.equal(stats.writes.length, 1, 'an existing valid key is not rewritten');
  const other = fixture(t, { storage: trackedStorage().storage }); await other.ready();
  const otherKey = (await other.request('chat')).value.localStateKey; assert.match(otherKey, uuid); assert.notEqual(otherKey, original);
});

test('persisted valid namespace is returned without rewriting it, while invalid records are replaced safely', async t => {
  const id = randomUUID(), valid = trackedStorage({ saved: { version: 1, id } }), existing = fixture(t, { storage: valid.storage }); await existing.ready();
  assert.equal((await existing.request('chat')).value.localStateKey, id); assert.equal(valid.stats.writes.length, 0);
  const invalid = trackedStorage({ saved: { version: 1, id: 'PROFILE_PRIVATE_PATH_OR_SECRET' } }), corrupted = fixture(t, { storage: invalid.storage }); await corrupted.ready();
  const response = await corrupted.request('chat'); assert.equal(response.status, 200); assert.match(response.value.localStateKey, uuid);
  assert.doesNotMatch(JSON.stringify(response.value), /PROFILE_PRIVATE_PATH_OR_SECRET/);
  assert.deepEqual(invalid.storage.tables.get('profile').get(KEY), { version: 1, id: response.value.localStateKey });
});

test('failed namespace persistence never exposes an unsaved key and a later explicit open may retry', async t => {
  let failing = true; const { storage, stats } = trackedStorage({ failKeyPut: () => failing }), f = fixture(t, { storage }); await f.ready();
  const failed = await f.request('chat'); assert.equal(failed.status, 200);
  assert.equal(Object.hasOwn(failed.value, 'localStateKey'), false); assert.equal(storage.tables.get('profile').has(KEY), false);
  assert.equal(stats.writes.length, 1);
  assert.equal((await f.request('settings')).status, 200); assert.equal(stats.writes.length, 1);
  failing = false; const retried = await f.request('chat'); assert.equal(retried.status, 200); assert.match(retried.value.localStateKey, uuid);
  assert.deepEqual(storage.tables.get('profile').get(KEY), { version: 1, id: retried.value.localStateKey });
  assert.equal((await f.request('chat')).value.localStateKey, retried.value.localStateKey);
  assert.equal(f.calls.length + f.selections.length + f.judgements.length, 0);
});

test('a namespace read failure stays private and recoverable rather than leaking storage error text', async t => {
  let failing = true; const { storage, stats } = trackedStorage({ onKeyGet() { if (failing) throw Error('PROFILE_READ_SECRET'); } }), f = fixture(t, { storage }); await f.ready();
  const failed = await f.request('chat'); assert.equal(failed.status, 200); assert.equal(Object.hasOwn(failed.value, 'localStateKey'), false);
  assert.doesNotMatch(JSON.stringify(failed.value), /PROFILE_READ_SECRET/); assert.equal(stats.writes.length, 0);
  failing = false; assert.match((await f.request('chat')).value.localStateKey, uuid); assert.equal(stats.writes.length, 1);
});

test('unload drains a pending namespace write before releasing its storage domain', async t => {
  const wait = gate(t), { storage, stats } = trackedStorage({ beforeKeyPut: () => wait.promise }), f = fixture(t, { storage }); await f.ready();
  const opened = f.request('chat'); await flush(); assert.equal(stats.writes.length, 1);
  let stopped = false; const disposal = f.dispose().then(() => { stopped = true; });
  try { await flush(); assert.equal(stopped, false); assert.equal(stats.closes, 0); }
  finally { wait.open(); }
  await Promise.all([opened, disposal]); assert.equal(stopped, true); assert.equal(stats.closes, 1);
  assert.match(storage.tables.get('profile').get(KEY).id, uuid);
});

test('room summaries expose independent live activity without copying other room messages or reading workflow bodies', async t => {
  const selecting = gate(t), speaking = gate(t), sourceReads = [];
  const f = fixture(t, {
    directorScript: options => (async function* () {
      const body = input(options); if (body.message === 'A_PRIVATE_PENDING_MESSAGE') await selecting.promise;
      const event=body.events.find(e=>e.author.role==='user'),answered=body.events.some(e=>e.author.role==='assistant');
      yield*directorReply({work:'not-needed',sourceIds:[],request:'open',evidence:body.message},answered?null:{id:whale,kind:'normal',to:'user',evidence:{eventId:event.id,index:0,text:event.messages[0]},goal:'回应用户。'});
    })(),
    script: options => (async function* () {
      if (input(options).message === 'B_PRIVATE_SPEAKING_MESSAGE') await speaking.promise;
      yield* reply(['PRIVATE_ASSISTANT_BODY']);
    })(),
    extraServices: [
      ['sessions', { get: id => ({ header: { id, title: '已授权工作', cwd: 'D:/fixture/project' } }) }],
      ['sessionQuery', { observeSession: async id => { sourceReads.push(id); return { events: [] }; } }],
    ],
  });
  await f.ready(); const a = await newRoom(f, [whale], '甲房间', 'a'), b = await newRoom(f, [whale], '乙房间', 'b'), c = await newRoom(f, [whale], '丙房间', 'c');
  await roomSend(f, a, whale, 'A_PRIVATE_PENDING_MESSAGE', 'a-send'); await flush();
  await roomSend(f, b, whale, 'B_PRIVATE_SPEAKING_MESSAGE', 'b-send'); await flush();
  const before = { calls: f.calls.length, directors: f.directors.length, reads: sourceReads.length };
  const state = await roomState(f, c), summaries = new Map(state.rooms.map(room => [room.id, room]));
  assert.equal(state.running, false); assert.equal(summaries.get(a.roomId).running, true); assert.equal(summaries.get(b.roomId).running, true); assert.equal(summaries.get(c.roomId).running, false);
  for (const room of state.rooms) {
    assert.equal(Number.isSafeInteger(room.generation), true); assert.equal(Object.hasOwn(room, 'turns'), false);
    assert.equal(Object.hasOwn(room, 'assistant'), false); assert.equal(Object.hasOwn(room, 'user'), false);
  }
  assert.doesNotMatch(JSON.stringify(state.rooms), /A_PRIVATE_PENDING_MESSAGE|B_PRIVATE_SPEAKING_MESSAGE|PRIVATE_ASSISTANT_BODY/);
  assert.deepEqual({ calls: f.calls.length, directors: f.directors.length, reads: sourceReads.length }, before);
  selecting.open(); speaking.open(); await settledRoom(f, a); await settledRoom(f, b);
  const idle = await roomState(f, c); assert.ok(idle.rooms.every(room => room.running === false));
  const beforeClear = await roomState(f, a), oldGeneration = summaries.get(a.roomId).generation;
  assert.equal((await f.request('chat', { action: 'clear', ...a, personaId: whale, revision: beforeClear.room.revision, epoch: beforeClear.epoch })).status, 200);
  assert.ok((await roomState(f, c)).rooms.find(room => room.id === a.roomId).generation > oldGeneration);
});

test('round status reports the resolved model only after route lookup and drops live timing after completion', async t => {
  const route = gate(t), generating = gate(t); let lookups = 0;
  const f = fixture(t, { config: { model: '' }, listModels: async () => { lookups++; await route.promise; return [{ id: 'actual-default' }]; },
    script: () => (async function* () { await generating.promise; yield* reply(['已回复']); })() });
  await f.ready(); const room = await newRoom(f, [whale]);
  await roomSend(f, room, whale, '这条先等等', 'route-pending'); await flush();
  const unresolved = await roomState(f, room); assert.equal(unresolved.running, true); assert.equal(lookups, 1);
  assert.equal(Object.hasOwn(unresolved, 'roundModel'), false); assert.equal(f.calls.length, 0);
  assert.ok(Number.isFinite(unresolved.roundElapsedMs) && unresolved.roundElapsedMs >= 0);
  route.open(); await flush(); const active = await roomState(f, room);
  assert.deepEqual(active.roundModel, { provider: 'p', model: 'actual-default' }); assert.equal(f.calls.length, 1);
  assert.ok(active.roundElapsedMs >= unresolved.roundElapsedMs);
  generating.open(); const done = await settledRoom(f, room); assert.equal(done.room.turns.at(-1).status, 'ready');
  assert.equal(Object.hasOwn(done, 'roundModel'), false); assert.equal(Object.hasOwn(done, 'roundElapsedMs'), false);
});
