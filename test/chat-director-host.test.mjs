import {readChatInput} from './helpers/chat-input.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, directorReply, reply, preference, newRoom, roomSend, roomState, settledRoom, flush,
  whale, dragon, claude } from './helpers/persona-chat-host.mjs';
import { parseDirector } from '../lib/chat-director.js';
import { chatSchedulerEventKey } from '../lib/chat-scheduler.js';

const body = options => readChatInput(options);
const context = value => ({ work: 'not-needed', sourceIds: [], request: 'open', evidence: value.message });
const lastUser = value => value.events.findLast(event => event.author.role === 'user');
const spoken = value => value.events.filter(event => event.author.role === 'assistant');
const choice = (value, id, { kind = 'normal', event = lastUser(value), to = 'user', index = 0 } = {}) => ({ id, kind, to,
  evidence: { eventId: event.id, index, text: event.messages[index] }, goal: '接住这一条公开原话。' });
function gate(t) { let open; const promise = new Promise(resolve => { open = resolve; }); t.after(open); return { promise, open }; }
async function until(read, predicate, reason) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { await flush(); const value = await read(); if (predicate(value)) return value; }
  assert.fail(reason);
}
async function target(f, room, ids) {
  const state = await roomState(f, room);
  assert.equal((await f.request('chat-rooms', { ...room, action: 'update', targetPersonaIds: ids,
    configRevision: state.room.configRevision, epoch: state.epoch })).status, 200);
}

test('native director evidence accepts full canonical event references and still enforces author, readiness and real peer-call eligibility', () => {
  const roomId = 'room:00000000-0000-4000-8000-000000000000', scope = JSON.stringify([roomId + ':sources:0', 0]);
  const eventId = (turnId, attemptId) => chatSchedulerEventKey({ roomId, generation: 0, sourceScope: scope, turnId, attemptId });
  const events = [{ id: eventId('test-user-message-id', 'user'), author: { role: 'user', name: '我' }, messages: ['你们随意说说。'] },
    { id: eventId('directed:00000000-0000-4000-8000-000000000000', 'directed:00000000-0000-4000-8000-000000000000'),
      author: { role: 'assistant', id: dragon, name: dragon }, messages: ['鲸鲸，你怎么看这句话？'] }];
  assert.ok(events.every(event => event.id.length > 200), 'production references are larger than a persona id');
  const members = [{ id: whale, name: whale, builtin: true }, { id: dragon, name: dragon, builtin: true }];
  const states = [{ id: whale, level: 0, normalRemaining: 3, peerRemaining: 1, normalReady: true, peerReady: true, pendingEventIds: events.map(event=>event.id),normalPendingEventIds:[events[0].id] }];
  const value = { message: '你们随意说说。', events, states, members }, normal = choice(value, whale);
  const parse = (next, extra = {}) => parseDirector(JSON.stringify({ context: context(value), next }), { ...value, ...extra });
  assert.equal(parse(normal).next.id, whale);
  const peer = choice(value, whale, { kind: 'peer', event: events[1], to: dragon });
  assert.equal(parse(peer).next.kind, 'peer');
  assert.equal(parse({ ...peer, to: whale }).next, null);
  assert.equal(parse({ ...normal, evidence: { ...normal.evidence, eventId: 'foreign-event' } }).next, null);
  assert.equal(parse({ ...normal, evidence: { ...normal.evidence, index: 6 } }).next, null);
  assert.equal(parse(normal, { states: [{ ...states[0], level: 3 }] }).next, null);
  assert.equal(parse(peer, { states: [{ ...states[0], peerReady: false }] }).next, null);
  const notCalled = [{ ...events[1], messages: ['我只是谈谈自己的想法。'] }];
  assert.equal(parseDirector(JSON.stringify({ context: context(value), next: { ...peer,
    evidence: { eventId: notCalled[0].id, index: 0, text: notCalled[0].messages[0] } } }), { ...value, events: notCalled }).next, null);
});

test('a cold Host can open and send through its actual global model while the native director creates one next reply at a time', async t => {
  const f = fixture(t, { config: { provider: '', model: '' },
    extraServices: [['agentDefaultModel', { currentSelection: () => ({ provider: 'actual-global', model: 'chosen-model' }) }]],
    modelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }, { id: 'low' }], defaultEffort:'low' } }),
    directorScript: options => { const value = body(options); return directorReply(context(value), spoken(value).length ? null : choice(value, whale)); } });
  await f.ready(); const room = await newRoom(f, [whale], '无工作调用也能开始', 'cold-director');
  assert.equal((await roomState(f, room)).modelReady, true); assert.equal(f.requests.length, 0);
  assert.equal((await roomSend(f, room, whale, '先轻松聊一句。', 'cold-message')).status, 200);
  const done = await settledRoom(f, room);
  assert.equal(f.calls.length, 1); assert.ok(f.directors.length >= 1);
  assert.ok(f.requests.every(options => options.provider === 'actual-global' && options.model === 'chosen-model'));
  assert.ok(f.directors.every(options => options.reasoningEffort === 'off'));
  assert.equal(f.calls[0].reasoningEffort,'low','a fresh chat uses its advertised model default');
  assert.equal(f.plans.length + f.continuations.length, 0, 'the old pre/post planning threads are no longer called');
  assert.equal(done.room.turns[0].phase, 'anchor'); assert.equal(done.room.turns[0].recipientId, 'user');
  assert.equal(done.room.turns.filter(turn => turn.phase !== 'anchor').length, 1);
  const before = f.requests.length; await flush(); assert.equal(f.requests.length, before, 'no background polling creates another judgement');
});

test('the director may change speaker order dynamically and later speakers receive actual public predecessors', async t => {
  const order = [claude, dragon, whale], f = fixture(t, {
    directorScript: options => { const value = body(options), id = order[spoken(value).length];
      return directorReply(context(value), id ? choice(value, id) : null); },
    script: options => reply([body(options).speaker.name + ' 的公开回应。']),
  });
  await f.ready(); const room = await newRoom(f, [whale, dragon, claude], '按这次话题接话', 'dynamic-director');
  await target(f, room, [whale, dragon]);
  await roomSend(f, room, whale, '大家随意聊聊，不必按座次。', 'dynamic-message');
  const done = await settledRoom(f, room);
  assert.deepEqual(f.calls.map(options => body(options).speaker.id), order);
  assert.deepEqual(body(f.calls[0]).exchange, []);
  assert.deepEqual(body(f.calls[1]).exchange.map(event => event.speaker.id), [claude]);
  assert.deepEqual(body(f.calls[2]).exchange.map(event => event.speaker.id), [claude, dragon]);
  assert.deepEqual(f.calls.map(options => body(options).opportunity), [
    { kind: 'normal', normalRemainingAfterThis: 0, peerRemainingAfterThis: 1 },
    { kind: 'normal', normalRemainingAfterThis: 1, peerRemainingAfterThis: 1 },
    { kind: 'normal', normalRemainingAfterThis: 2, peerRemainingAfterThis: 1 },
  ]);
  assert.ok(f.calls.every(options => body(options).recipients.map(person => person.id).join() === [whale, dragon].join()));
  assert.deepEqual(done.room.turns.filter(turn => turn.status === 'ready' && turn.phase !== 'anchor').map(turn => turn.recipientId), order);
  assert.ok(f.directors.every(options => body(options).task === 'chat-room-director'));
});

test('an unmentioned broadcast keeps recipients empty and starts all members at level zero without forcing everyone to speak', async t => {
  const f = fixture(t, { directorScript: options => { const value = body(options);
    return directorReply(context(value), spoken(value).length ? null : choice(value, claude)); } });
  await f.ready(); const room = await newRoom(f, [whale, dragon, claude], '没有点名也可聊', 'broadcast-director');
  await target(f, room, []);
  const sent = await roomSend(f, room, whale, '大家下午好。', 'broadcast-message'); assert.equal(sent.status, 200, JSON.stringify(sent.value));
  const done = await settledRoom(f, room);
  const first = body(f.directors[0]);
  assert.deepEqual(first.recipients, []); assert.ok(first.states.every(state => state.level === 0 && state.normalRemaining === 3));
  assert.equal(f.calls.length, 1); assert.equal(body(f.calls[0]).speaker.id, claude);
  assert.deepEqual(body(f.calls[0]).recipients, []); assert.deepEqual(done.room.turns[0].recipients, []);
});

test('level three refuses another normal reply even when a newly pending peer message provides genuine evidence',async t=>{
  const f=fixture(t,{directorScript:options=>{
    const value=body(options),said=spoken(value),id=said.length%2===0?whale:dragon;
    return directorReply(context(value),choice(value,id,said.length>=1?{kind:said.length===1?'peer':'normal',event:said.at(-1),to:said.at(-1).author.id}:{}));
  },script:(options,count)=>reply([body(options).speaker.id===whale?'GPT，第'+count+'次完整回应。':'鲸鲸，第'+count+'次完整回应。'])});
  await f.ready();const room=await newRoom(f,[whale,dragon,claude],'正常机会有边界','normal-limit');await target(f,room,[]);
  await roomSend(f,room,whale,'可以承接新的同伴发言。','normal-limit-message');const done=await settledRoom(f,room);
  assert.equal(f.calls.length,6);assert.deepEqual(f.calls.filter(options=>body(options).speaker.id===whale).map(options=>body(options).opportunity.normalRemainingAfterThis),[2,1,0]);
  assert.equal(done.room.turns.filter(turn=>turn.phase!=='anchor'&&turn.status==='ready').length,6);
  const latest=body(f.directors.at(-1)),last=latest.states.find(state=>state.id===whale);
  assert.equal(last.level,3);assert.equal(last.normalRemaining,0);assert.equal(last.normalReady,false);
  assert.ok(last.pendingEventIds.length>0,'quota refusal is tested with a new external event, not merely stale evidence');
});

test('a real new peer mention grants one independent opportunity after normal quota is exhausted without enabling a second peer reply',async t=>{
  const f=fixture(t,{directorScript:options=>{
    const value=body(options),said=spoken(value),count=said.length;
    if(count<6){const id=count%2===0?whale:dragon;return directorReply(context(value),choice(value,id,count>=1?{kind:count===1?'peer':'normal',event:said.at(-1),to:said.at(-1).author.id}:{}));}
    const fromDragon=said.findLast(event=>event.author.id===dragon);
    return directorReply(context(value),choice(value,whale,{kind:'peer',event:fromDragon,to:dragon}));
  },script:options=>reply([body(options).speaker.id===dragon?'鲸鲸，你刚才那个比喻还挺有趣，你会怎么接？':'GPT，这句话我接住了。'])});
  await f.ready();const room=await newRoom(f,[whale,dragon,claude],'独立接同伴的话','peer-opportunity');await target(f,room,[]);
  await roomSend(f,room,whale,'你们聊聊这个想法。','peer-message');const done=await settledRoom(f,room);
  assert.deepEqual(f.calls.map(options=>body(options).speaker.id),[whale,dragon,whale,dragon,whale,dragon,whale]);
  const peer=body(f.calls.at(-1));assert.equal(peer.responsePlan.kind,'peer');assert.equal(peer.responsePlan.to,dragon);
  assert.deepEqual(peer.opportunity,{kind:'peer',normalRemainingAfterThis:0,peerRemainingAfterThis:0});
  assert.ok(peer.exchange.some(event=>event.speaker.id===dragon&&event.messages.some(text=>text.includes('鲸鲸'))));
  const state=body(f.directors.at(-1)).states.find(state=>state.id===whale);assert.equal(state.level,3);assert.equal(state.normalRemaining,0);assert.equal(state.peerRemaining,0);assert.equal(state.peerReady,false);
  assert.equal(done.room.turns.filter(turn=>turn.phase==='followup'&&turn.status==='ready').length,2);
});

test('new user input refreshes the cycle while preserving the current persona complete multi-bubble response', async t => {
  const speaking = gate(t); let activeSignal;
  const f = fixture(t, { directorScript: options => { const value = body(options);
    return directorReply(context(value), spoken(value).length ? null : choice(value, whale)); },
    script: (options, count) => (async function* () {
      if (count === 1) { activeSignal = options.signal; await speaking.promise; }
      yield* reply(['完整回应的第一段。', '同一次调用的第二段。']);
    })(),
  });
  await f.ready(); const room = await newRoom(f, [whale], '新输入接续', 'new-input-cycle');
  await roomSend(f, room, whale, '先接住这句话。', 'old-cycle');
  await until(() => Promise.resolve(f.calls.length), count => count === 1, 'the first reply begins');
  assert.equal((await roomState(f,room)).canYield,false,'a directed pending actor is still a complete response in progress');
  assert.equal((await roomSend(f, room, whale, '我又补充了一句话。', 'new-cycle')).status, 200);
  assert.equal(activeSignal.aborted, false); assert.equal(f.calls.length, 1);
  speaking.open(); const done = await settledRoom(f, room);
  assert.equal(f.calls.length, 2);
  for (const messageId of ['old-cycle', 'new-cycle']) {
    const replyTurn = done.room.turns.find(turn => turn.messageId === messageId && turn.phase !== 'anchor');
    assert.equal(replyTurn.status, 'ready'); assert.equal(replyTurn.assistant.length, 2);
  }
  const refreshed = f.directors.map(body).find(value => value.message === '我又补充了一句话。');
  assert.equal(refreshed.states.find(state => state.id === whale).level, 0);
});

test('a failed independent peer reply can retry its exact public invitation without becoming a fresh normal reply',async t=>{
  let whaleCalls=0;
  const f=fixture(t,{directorScript:options=>{
    const value=body(options),done=spoken(value);
    if(!done.length)return directorReply(context(value),choice(value,dragon));
    if(!done.some(event=>event.author.id===whale)&&value.states.find(state=>state.id===whale)?.peerReady)
      return directorReply(context(value),choice(value,whale,{kind:'peer',event:done.find(event=>event.author.id===dragon),to:dragon}));
    return directorReply(context(value),null);
  },script:options=>{
    if(body(options).speaker.id===dragon)return reply(['鲸鲸，你愿意接着说吗？']);
    whaleCalls++;if(whaleCalls===1)throw Error('network');return reply(['这次接上了。']);
  }});
  await f.ready();const room=await newRoom(f,[whale,dragon],'同伴失败精确重试','peer-retry');
  await roomSend(f,room,dragon,'你们聊一句。','peer-retry-user');
  const stopped=await settledRoom(f,room),failed=stopped.room.turns.find(turn=>turn.recipientId===whale&&turn.status==='failed');
  assert.ok(failed);assert.equal(failed.responsePlan.kind,'peer');assert.equal(whaleCalls,1);
  const result=await f.request('chat',{...room,action:'retry',personaId:whale,id:failed.id,attemptId:'peer-retry-exact',revision:stopped.room.revision,epoch:stopped.epoch});
  assert.equal(result.status,200,JSON.stringify(result.value));
  const done=await settledRoom(f,room),retried=done.room.turns.find(turn=>turn.id===failed.id);
  assert.equal(retried.status,'ready');assert.equal(retried.responsePlan.kind,'peer');assert.equal(retried.responsePlan.to,dragon);
  assert.equal(whaleCalls,2);assert.equal(done.room.turns.filter(turn=>turn.recipientId===whale).length,1);
});

test('the director sees only same-room public evidence and speakers retain isolated private preferences', async t => {
  const f = fixture(t, { directorScript: options => { const value = body(options);
    const person = value.recipients[0] ?? value.members[0];
    return directorReply(context(value), spoken(value).length ? null : choice(value, person.id)); } });
  await f.ready(); await preference(f, 'ONLY_WHALE_PRIVATE', whale); await preference(f, 'ONLY_DRAGON_PRIVATE', dragon);
  const a = await newRoom(f, [whale], '甲房间', 'private-a'), b = await newRoom(f, [dragon], '乙房间', 'private-b');
  await roomSend(f, a, whale, 'ROOM_A_PUBLIC_ONLY', 'a-public'); const doneA = await settledRoom(f, a);
  await roomSend(f, b, dragon, 'ROOM_B_PUBLIC_ONLY', 'b-public'); await settledRoom(f, b);
  const aDirectors = f.directors.filter(options => body(options).message === 'ROOM_A_PUBLIC_ONLY');
  const bDirectors = f.directors.filter(options => body(options).message === 'ROOM_B_PUBLIC_ONLY');
  assert.ok(aDirectors.length && bDirectors.length);
  assert.doesNotMatch(JSON.stringify(aDirectors), /ROOM_B_PUBLIC_ONLY|ONLY_WHALE_PRIVATE|ONLY_DRAGON_PRIVATE/);
  assert.doesNotMatch(JSON.stringify(bDirectors), /ROOM_A_PUBLIC_ONLY|ONLY_WHALE_PRIVATE|ONLY_DRAGON_PRIVATE/);
  assert.match(f.calls[0].system, /ONLY_WHALE_PRIVATE/); assert.doesNotMatch(f.calls[0].system, /ONLY_DRAGON_PRIVATE/);
  assert.match(f.calls[1].system, /ONLY_DRAGON_PRIVATE/); assert.doesNotMatch(f.calls[1].system, /ONLY_WHALE_PRIVATE/);
  const priorCalls = f.requests.length;
  const foreignQuote = { roomId: a.roomId, generation: doneA.room.generation, kind: 'user', messageId: 'a-public' };
  const stateB = await roomState(f, b);
  assert.equal((await f.request('chat', { ...b, action: 'send', personaId: dragon, requestId: 'forged-quote', content: '读这个。',
    quote: foreignQuote, revision: stateB.room.revision, epoch: stateB.epoch })).status, 400);
  assert.equal(f.requests.length, priorCalls, 'a foreign pointer is refused before any judge or speaker dispatch');
});

test('forged director event evidence cannot manufacture a persona call or change the preserved user anchor', async t => {
  const f = fixture(t, { directorScript: options => { const value = body(options), next = choice(value, whale);
    next.evidence.eventId = 'foreign-room-or-retired-attempt';
    return directorReply(context(value), next); } });
  await f.ready(); const room = await newRoom(f, [whale], '错误依据不发言', 'forged-evidence');
  await roomSend(f, room, whale, '仍然保留我的原话。', 'forged-message'); const done = await settledRoom(f, room);
  assert.equal(f.calls.length, 0); assert.equal(done.room.turns.length, 1);
  assert.equal(done.room.turns[0].phase, 'anchor'); assert.equal(done.room.turns[0].user, '仍然保留我的原话。');
});

test('a failed directed reply keeps its user anchor for explicit retry and a later quote still identifies the successful second bubble', async t => {
  const f = fixture(t, { directorScript: options => { const value = body(options);
    return directorReply(context(value), spoken(value).length ? null : choice(value, whale)); },
    script: (_, count) => reply(['第一段有明确作者。', '第二段保留原话索引。'], count === 1 ? 'max-tokens' : 'stop'),
  });
  await f.ready(); const room = await newRoom(f, [whale], '失败后引用仍可靠', 'director-retry');
  await roomSend(f, room, whale, '这条原话不要因为失败消失。', 'retry-anchor');
  const failedState = await settledRoom(f, room), failed = failedState.room.turns.find(turn => turn.phase !== 'anchor');
  assert.equal(f.calls.length, 1); assert.equal(failed.status, 'failed');
  assert.equal(failedState.room.turns[0].phase, 'anchor'); assert.equal(failedState.room.turns[0].user, '这条原话不要因为失败消失。');
  assert.equal((await f.request('chat', { ...room, action: 'retry', personaId: whale, id: failed.id, attemptId: 'explicit-directed-retry',
    revision: failedState.room.revision, epoch: failedState.epoch })).status, 200);
  const retried = await settledRoom(f, room), ready = retried.room.turns.find(turn => turn.phase !== 'anchor');
  assert.equal(f.calls.length, 2); assert.equal(ready.status, 'ready'); assert.equal(ready.id, failed.id);
  assert.equal(ready.attemptId, 'explicit-directed-retry'); assert.equal(retried.room.turns.length, 2);
  const quote = { roomId: room.roomId, generation: retried.room.generation, kind: 'assistant', turnId: ready.id, attemptId: ready.attemptId, index: 1 };
  assert.equal((await f.request('chat', { ...room, action: 'send', personaId: whale, requestId: 'quote-second-bubble', content: '接着说这句。', quote,
    revision: retried.room.revision, epoch: retried.epoch })).status, 200);
  await settledRoom(f, room); assert.equal(f.calls.length, 3);
  assert.equal(body(f.calls.at(-1)).quotedMessage.text, '第二段保留原话索引。');
  assert.equal(body(f.calls.at(-1)).quotedMessage.author.id, whale);
});
