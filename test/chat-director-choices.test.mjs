import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDirectorPrompt, parseDirector } from '../lib/chat-director.js';
import { chatSchedulerEventKey } from '../lib/chat-scheduler.js';

const member = (id, name = id) => ({ id, name });
const key = (turnId, roomId = 'choices-room') => chatSchedulerEventKey({ roomId, generation: 0,
  sourceScope: roomId + ':sources:0', turnId, attemptId: 'attempt-' + turnId });
const user = (messages = ['先说我的第一句话。', '这是后来补充的第二句话。']) => ({ id: key('user'), author: { role: 'user', name: '我' }, messages });
const peer = (n, authorId = 'dragon', messages = ['鲸鲸，你怎么看这件事？']) => ({ id: key('peer-' + n), author: { role: 'assistant', id: authorId, name: authorId }, messages });
const ready = (id, events, patch = {}) => ({ id, level: 0, normalRemaining: 3, peerRemaining: 1,
  normalReady: true, peerReady: true, pendingEventIds: events.map(event => event.id), normalPendingEventIds: events.map(event => event.id), ...patch });
function setup() {
  const events = [user(), peer(1)];
  return { message: events[0].messages.join('\n'), members: [member('fish', '鲸鲸'), member('dragon', 'GPT')],
    events, states: [ready('fish', events)], sourceIds: ['work'] };
}
const view = options => JSON.parse(buildDirectorPrompt(options).user);
const wire = (choiceId, extra = {}) => JSON.stringify({ choiceId, ...extra });
const context = options => ({ work: 'not-needed', sourceIds: [], request: 'answer', evidence: options.message.slice(0, 100) });
const pick = (options, predicate) => {
  const choice = view(options).choices.find(predicate); assert.ok(choice); return choice;
};

test('the short protocol chooses a separately preserved user part and returns canonical actor, author and original evidence', () => {
  const options = setup(), body = view(options);
  const parts = body.choices.filter(choice => choice.id === 'fish' && choice.to === 'user');
  assert.deepEqual(parts.map(choice => choice.index), [0, 1]);
  assert.deepEqual(Object.keys(parts[0]).sort(), ['choiceId', 'eventId', 'id', 'index', 'kind', 'to']);
  assert.doesNotMatch(JSON.stringify(body.choices), /第一句话|第二句话|怎么看|sources:0|attempt-/,
    'options point to one copy of public text rather than duplicating it per persona');
  const result = parseDirector(wire(parts[1].choiceId, { context: context(options), goal: '接住后来的补充。' }), options);
  assert.equal(result.basis, 'model');
  assert.deepEqual(result.next, { id: 'fish', kind: 'normal', to: 'user',
    evidence: { eventId: options.events[0].id, index: 1, text: options.events[0].messages[1] }, goal: '接住后来的补充。' });
});

test('a minimal choice has a fixed safe goal and withholds work when auxiliary context is missing or malformed', () => {
  const options = setup(), selected = pick(options, choice => choice.to === 'user');
  for (const extra of [{}, { context: null }, { context: { work: 'required', sourceIds: ['unattached'], evidence: 'forged' } }, { goal: '' }, { goal: null }]) {
    const result = parseDirector(wire(selected.choiceId, extra), options);
    assert.equal(result.basis, 'model'); assert.equal(result.next.id, 'fish');
    assert.equal(result.next.goal, '回应选中的这条公开原话。');
    assert.equal(result.context.work, 'unclear'); assert.deepEqual(result.context.sourceIds, []);
  }
  const empty = { ...options, states: [] };
  assert.deepEqual(view(empty).choices, []);
  assert.equal(parseDirector('{"choiceId":null}', empty).basis, 'model');
  assert.equal(parseDirector('{"choiceId":null,"goal":{"ignored":"no action"}}', empty).next, null);
});

test('unknown routing fields cannot override a chosen actor, source author, kind or literal evidence', () => {
  const options = setup(), selected = pick(options, choice => choice.to === 'user');
  for (const extra of [{ id: 'dragon' }, { to: 'dragon' }, { kind: 'peer' }, { evidence: { text: 'forged' } }, { next: null }]) {
    const result = parseDirector(wire(selected.choiceId, extra), options);
    assert.equal(result.basis, 'invalid'); assert.equal(result.reason, 'shape'); assert.equal(result.next, null);
  }
  assert.equal(parseDirector(wire('not-an-option'), options).reason, 'choice');
  assert.equal(parseDirector(wire(1), options).reason, 'choice');
  for (const goal of [17, {}, 'x'.repeat(181)])
    assert.equal(parseDirector(wire(selected.choiceId, { goal }), options).reason, 'goal');
});

test('only fresh explicitly authorized external events generate options; missing unread authority never grants an invitation', () => {
  const options = setup(), canonical = options.events[1].id;
  for (const state of [{ ...options.states[0], pendingEventIds: [] }, { ...options.states[0], pendingEventIds: [key('foreign')] },
    { ...options.states[0], pendingEventIds: undefined }, { ...options.states[0], normalReady: false, peerReady: false }])
    assert.deepEqual(view({ ...options, states: [state] }).choices, []);
  const onlyPeer = { ...options, states: [ready('fish', [], { pendingEventIds: [canonical] })] };
  assert.ok(view(onlyPeer).choices.every(choice => choice.eventId === 'e2' && choice.to === 'dragon'));
  for (const normalRemaining of ['3', -1, 4])
    assert.ok(view({ ...options, states: [{ ...options.states[0], normalRemaining, peerReady: false }] }).choices.length === 0);
  const exhausted = { ...options, states: [{ ...options.states[0], level: 3, normalRemaining: 0 }] };
  assert.ok(view(exhausted).choices.length > 0); assert.ok(view(exhausted).choices.every(choice => choice.kind === 'peer'));
});

test('an untouched user entry remains available without treating unrelated peer rounds as new normal invitations', () => {
  const options = setup(); options.events = [user(['先听用户。']), ...Array.from({ length: 5 }, (_, n) => peer(n)),
    peer('absent', 'absent', ['不能给缺席者安排回应。'])];
  options.states = [ready('fish', options.events)];
  const body = view(options), ids = new Set(body.choices.filter(choice=>choice.kind==='normal').map(choice => choice.eventId));
  assert.deepEqual([...ids], ['e1']);
  assert.ok(body.choices.every(choice => choice.to === 'user' || choice.to === 'dragon'));
  assert.ok(body.choices.filter(choice => choice.to !== 'user').every(choice => choice.index === 0));
});

test('a peer option points to the actual bubble containing the direct name rather than another bubble in that event', () => {
  const options = setup(); options.events[1].messages = ['我先说自己的看法。', '鲸鲸，入口应该放在哪里？', '最后补一句，先别执行。'];
  const selected = pick(options, choice => choice.kind === 'peer');
  assert.equal(selected.index, 1); assert.equal(selected.to, 'dragon');
  const result = parseDirector(wire(selected.choiceId), options);
  assert.equal(result.next.evidence.text, '鲸鲸，入口应该放在哪里？');
  assert.equal(result.next.evidence.eventId, options.events[1].id);
  const noName = structuredClone(options); noName.events[1].messages[1] = '先聊一下入口放在哪里。';
  assert.ok(view(noName).choices.every(choice => choice.kind !== 'peer'));
  assert.equal(parseDirector(wire(selected.choiceId), noName).reason, 'choice');
});

test('three newer plain peer rounds cannot hide an unread real peer call after normal quota is exhausted', () => {
  const options = setup();
  const named = peer('earlier-named', 'dragon', ['鲸鲸，这个入口你会放在哪里？']);
  options.events = [user(['先听大家聊。']), named,
    ...Array.from({ length: 3 }, (_, n) => peer('newer-plain-' + n, 'dragon', ['只是新的公开补充-' + n + '。']))];
  options.states = [ready('fish', options.events, { level: 3, normalRemaining: 0, normalReady: false })];
  const body = view(options), selected = body.choices.find(choice => choice.kind === 'peer');
  assert.ok(selected, 'an unread named opportunity remains available even when the three latest external rounds are plain statements');
  assert.equal(selected.eventId, 'e2'); assert.equal(selected.to, 'dragon');
  assert.ok(body.choices.every(choice => choice.kind === 'peer'));
  const result = parseDirector(wire(selected.choiceId), options);
  assert.equal(result.next.evidence.eventId, named.id);
  assert.equal(result.next.evidence.text, named.messages[0]);
  assert.equal(result.next.kind, 'peer');
});

test('choice references are bound to the room and the exact current public snapshot instead of a reusable c1 slot', () => {
  const options = setup(), first = pick(options, choice => choice.to === 'user');
  assert.equal(view(options).choices[0].choiceId, view(structuredClone(options)).choices[0].choiceId);
  const consumed = { ...options, states: [{ ...options.states[0], pendingEventIds: [options.events[1].id] }] };
  assert.equal(parseDirector(wire(first.choiceId), consumed).reason, 'choice');
  const foreign = structuredClone(options); foreign.events = foreign.events.map((event, index) => ({ ...event, id: key('event-' + index, 'other-room') }));
  foreign.states[0].pendingEventIds = foreign.events.map(event => event.id);
  assert.equal(parseDirector(wire(first.choiceId), foreign).reason, 'choice');
  const edited = structuredClone(options); edited.members[0].name = '新的名字';
  assert.equal(parseDirector(wire(first.choiceId), edited).reason, 'choice');
});

test('identical display names do not merge stable actors or their response opportunities', () => {
  const options = setup(); options.members = [member('first-fish', '鲸鲸'), member('second-fish', '鲸鲸'), member('dragon', 'GPT')];
  options.states = [ready('first-fish', options.events), ready('second-fish', options.events)];
  const choices = view(options).choices.filter(choice => choice.to === 'user' && choice.index === 0);
  assert.equal(new Set(choices.map(choice => choice.choiceId)).size, 2);
  assert.deepEqual(choices.map(choice => parseDirector(wire(choice.choiceId), options).next.id), ['first-fish', 'second-fish']);
});

test('long evidence is a bounded exact literal fragment without broken surrogate pairs and retains full source text in events', () => {
  const options = setup(), line = '甲'.repeat(1599) + '🐳' + '乙'.repeat(2399);
  assert.equal(line.length, 4000); options.events[0].messages = [line]; options.message = line;
  const selected = pick(options, choice => choice.to === 'user'), result = parseDirector(wire(selected.choiceId), options);
  const evidence = result.next.evidence.text;
  assert.ok(evidence.length <= 1600); assert.ok(line.includes(evidence)); assert.equal(evidence.isWellFormed(), true);
  assert.equal(view(options).events[0].messages[0], line);
  const longPeer = '前'.repeat(1899) + '。鲸鲸，你怎么看？' + '后'.repeat(200);
  options.events[1].messages = [longPeer];
  const peerChoice = pick(options, choice => choice.kind === 'peer');
  const peerResult = parseDirector(wire(peerChoice.choiceId), options);
  assert.ok(longPeer.includes(peerResult.next.evidence.text)); assert.match(peerResult.next.evidence.text, /鲸鲸/);
  assert.ok(peerResult.next.evidence.text.length <= 1600);
  options.events[1].messages = ['前'.repeat(1599) + '鲸鲸' + '后'.repeat(200)];
  assert.ok(!view(options).choices.some(choice => choice.kind === 'peer'),'a bare embedded name at a clipping boundary is not an address');
  const boundaryPeer = '前'.repeat(1598) + '。鲸鲸，你来看。' + '后'.repeat(200);
  options.events[1].messages = [boundaryPeer];
  const boundary = parseDirector(wire(pick(options, choice => choice.kind === 'peer').choiceId), options).next.evidence.text;
  assert.ok(boundaryPeer.includes(boundary));assert.match(boundary,/鲸鲸/,'a locating fragment retains the whole direct name crossing its original budget edge');
});

test('the worst supported roster and split input remain bounded and do not repeat whole source text per option', () => {
  const options = setup(); options.events = [user(Array.from({ length: 8 }, (_, n) => '用户分段原话-' + n)), peer(1), peer(2), peer(3)];
  options.members = Array.from({ length: 8 }, (_, n) => member('member-' + n, '鲸鲸'));
  options.events.slice(1).forEach(event => { event.author.id = 'member-7'; });
  options.states = options.members.map(person => ready(person.id, options.events));
  const body = view(options); assert.ok(body.choices.length > 0 && body.choices.length <= 112);
  assert.equal(new Set(body.choices.map(choice => choice.choiceId)).size, body.choices.length);
  assert.ok(body.choices.every(choice => choice.choiceId.length <= 16));
  assert.doesNotMatch(JSON.stringify(body.choices), /用户分段原话|你怎么看/);
});

test('safe parse diagnostics are stable categories and never echo malformed or duplicate model text', () => {
  const options = setup(), selected = pick(options, choice => choice.to === 'user');
  for (const [value, reason] of [[{}, 'wire-type'], ['x'.repeat(20001), 'wire-size'], ['SECRET_MODEL_TEXT', 'json'],
    ['{"choiceId":null,"choiceId":"SECRET_DUPLICATE"}', 'duplicate-key'], ['[]', 'shape']]) {
    const result = parseDirector(value, options); assert.equal(result.reason, reason);
    assert.doesNotMatch(result.reason, /SECRET|MODEL|DUPLICATE/); assert.equal(result.next, null);
  }
  const fenced = '```json\n' + wire(selected.choiceId) + '\n```';
  assert.equal(parseDirector(fenced, options).next.id, 'fish');
  assert.equal(parseDirector('解释：' + wire(selected.choiceId), options).reason, 'json');
});

test('legacy native actions keep author, exact evidence, freshness and opportunity validation with specific failure reasons', () => {
  const options = setup(), action = { id: 'fish', kind: 'normal', to: 'user', goal: '自然回应。',
    evidence: { eventId: options.events[0].id, index: 0, text: options.events[0].messages[0] } };
  const legacy = next => JSON.stringify({ context: context(options), next });
  assert.equal(parseDirector(legacy(action), options).next.id, 'fish');
  for (const [next, reason] of [[{ ...action, id: 'missing' }, 'actor'], [{ ...action, to: 'dragon' }, 'author'],
    [{ ...action, evidence: { ...action.evidence, eventId: key('foreign') } }, 'event'],
    [{ ...action, evidence: { ...action.evidence, text: 'FORGED_TEXT' } }, 'evidence']])
    assert.equal(parseDirector(legacy(next), options).reason, reason);
  assert.equal(parseDirector(legacy(action), { ...options, states: [{ ...options.states[0], pendingEventIds: [] }] }).reason, 'stale-event');
  assert.equal(parseDirector(legacy(action), { ...options, states: [{ ...options.states[0], level: 3 }] }).reason, 'normal-ineligible');
  const peerAction = { ...action, kind: 'peer', to: 'dragon', evidence: { eventId: options.events[1].id, index: 0, text: options.events[1].messages[0] } };
  assert.equal(parseDirector(legacy(peerAction), { ...options, states: [{ ...options.states[0], peerRemaining: 0 }] }).reason, 'peer-ineligible');
});

test('legacy native wire cannot downgrade omitted unread authority into an invitation', () => {
  const options=setup(),next={id:'fish',kind:'normal',to:'user',goal:'自然回应。',
    evidence:{eventId:options.events[0].id,index:0,text:options.events[0].messages[0]}};
  const legacy=JSON.stringify({context:context(options),next});
  assert.equal(parseDirector(legacy,options).next.id,'fish');
  for(const pendingEventIds of [undefined,null,'all',{}]){
    const result=parseDirector(legacy,{...options,states:[{...options.states[0],pendingEventIds}]});
    assert.equal(result.next,null);assert.equal(result.basis,'invalid');assert.equal(result.reason,'stale-event');
  }
});
