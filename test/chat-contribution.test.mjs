import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChatContribution } from '../lib/chat-contribution.js';
import { buildDirectorPrompt, parseDirector } from '../lib/chat-director.js';
import { buildDirectorRequest, parseDirectorResponse } from '../lib/chat-director-wire.js';
import { chatSchedulerEventKey } from '../lib/chat-scheduler.js';

const key = (turnId, roomId = 'room', sourceScope = null) => chatSchedulerEventKey({ roomId, generation: 0, sourceScope, turnId, attemptId: turnId });
function setup() {
  const user = key('user'), peer = key('peer');
  return { message: '只根据材料聊一小点，先别执行。', members: [{ id: 'fish', name: '甲甲' }, { id: 'dragon', name: '乙乙' }],
    events: [{ id: user, author: { role: 'user', name: '我' }, messages: ['只根据材料聊一小点，先别执行。'] },
      { id: peer, author: { role: 'assistant', id: 'dragon', name: '乙乙' }, messages: ['甲甲，你怎么看入口方向？'] }],
    states: [{ id: 'fish', level: 0, normalRemaining: 3, peerRemaining: 1, normalReady: true, peerReady: true,
      pendingEventIds: [user, peer], normalPendingEventIds: [user] }],
    sources: [{ id: 'source-a', name: '材料甲' }], sourceIds: ['source-a'] };
}
const view = options => JSON.parse(buildDirectorRequest(options).user);
const line = (options, { move = 'opine', point = '就入口方向说一个自己的取舍。', work = 'N', scene = '-' } = {}) => `${view(options).choices[0].choiceId} ${work} ${scene} ${move} | ${point}`;
const task = (move = 'answer', point = '说明还欠的那一项。') => ({ move, point });

test('a contribution is exactly one bounded data task with no partial certification', () => {
  for (const move of ['answer', 'ask', 'opine', 'react', 'develop', 'branch', 'correct']) {
    const original = { move, point: '  接住这次本人邀请。  ' };
    const result = normalizeChatContribution(original);
    assert.deepEqual(result, { move, point: '接住这次本人邀请。' });
    assert.notEqual(result, original);
  }
  assert.deepEqual(normalizeChatContribution(Object.assign(Object.create(null), task())), task());
  assert.ok(normalizeChatContribution(task('react', '甲'.repeat(180))));
  let getterCalled = false;
  const accessor = { move: 'react', get point() { getterCalled = true; return '不应读这个访问器。'; } };
  for (const value of [null, [], 'react', {}, { move: 'react' }, { point: '应声。' }, task('summarize'), task('REACT'),
    task('react', ''), task('react', '   '), task('react', 1), task('react', '甲'.repeat(181)), task('react', '\n接话。'),
    { ...task(), author: 'forged' }, { ...task(), [Symbol('private')]: 'not-data' }, Object.create(task()), accessor,
    ...['\n', '\r', '\t', '\u0000', '\u007f', '\u0085', '\u2028', '\u2029'].map(value => task('react', '接住' + value + '这一句'))]) {
    assert.equal(normalizeChatContribution(value), null);
  }
  assert.equal(getterCalled, false);
});

test('new finite tasks preserve actor, canonical evidence, source choice and goal compatibility', () => {
  const options = setup();
  for (const move of ['answer', 'ask', 'opine', 'react', 'develop', 'branch', 'correct']) {
    const result = parseDirectorResponse(line(options, { move, work: 's1' }), options);
    assert.equal(result.basis, 'model');
    assert.equal(result.next.id, 'fish'); assert.equal(result.next.kind, 'normal'); assert.equal(result.next.to, 'user');
    assert.equal(result.next.evidence.eventId, options.events[0].id);
    assert.equal(result.next.evidence.text, options.events[0].messages[0]);
    assert.deepEqual(result.next.contribution, task(move, '就入口方向说一个自己的取舍。'));
    assert.equal(result.next.goal, result.next.contribution.point);
    assert.deepEqual(result.context.sourceIds, ['source-a']);
    assert.equal(result.context.evidence, options.message);
  }
  const result = parseDirectorResponse(line(options, { point: '比较 A | B，暂不替用户选定。' }), options);
  assert.equal(result.next.contribution.point, '比较 A | B，暂不替用户选定。', 'only the first pipe delimits the task');
  const wire = line(options);
  for (const wrapped of ['  '+wire+'\n', '\n'+wire+'\r\n  ', '```text\n'+wire+'\n```', '```text\n \n'+wire+'\n \n```']) {
    const parsed = parseDirectorResponse(wrapped, options);
    assert.equal(parsed.basis, 'model', wrapped);
    assert.equal(parsed.next.contribution.point, '就入口方向说一个自己的取舍。');
  }
});

test('new tasks reject missing, unknown, multiline and overlong directions without a legacy fallback', () => {
  const options = setup(), choice = view(options).choices[0].choiceId;
  for (const wire of [`${choice} N - react |`, `${choice} N - lecture | 教训用户。`, `${choice} N - react extra | 接话。`,
    `${choice} N - react | ${'甲'.repeat(181)}`, `${choice} N - react | 接话\nWAIT`, `${choice} N - react | 接\t话`,
    `${choice} N - react | 接话\u2028WAIT`, `WAIT N - react | 接话。`,
    `${choice} s7 - react | 接话。`, `${choice} s1+s1 - react | 接话。`, `${choice} N F react | 接话。`]) {
    const result = parseDirectorResponse(wire, options);
    assert.equal(result.basis, 'invalid', wire); assert.equal(result.next, null); assert.deepEqual(result.context.sourceIds, []);
  }
  assert.equal(parseDirectorResponse(line(options, { point: '甲'.repeat(180) }), options).basis, 'model');
});

test('task payloads never reopen a stale event, foreign scope, author or exhausted opportunity', () => {
  const options = setup(), wire = line(options);
  for (const changed of [
    { ...options, events: options.events.map(event => ({ ...event, id: key(event.author.role, 'foreign-room') })) },
    { ...options, events: options.events.map(event => ({ ...event, id: key(event.author.role, 'room', 'foreign-scope') })) },
    { ...options, states: options.states.map(state => ({ ...state, pendingEventIds: [] })) },
    { ...options, states: options.states.map(state => ({ ...state, normalReady: false, peerReady: false })) },
    { ...options, states: options.states.map(state => ({ ...state, level: 3, normalRemaining: 0, peerReady: false })) },
    { ...options, events: options.events.map(event => event.author.role === 'assistant' ? { ...event, author: { role: 'assistant', id: 'fish', name: '甲' } } : event) },
  ]) assert.equal(parseDirectorResponse(wire, changed).basis, 'invalid');
  const peer = view(options).choices.find(choice => choice.kind === 'peer');
  const peerResult = parseDirectorResponse(`${peer.choiceId} N - react | 回应乙刚才对本人的邀请。`, options);
  assert.equal(peerResult.next.kind, 'peer'); assert.equal(peerResult.next.to, 'dragon');
  const noCall = { ...options, events: options.events.map(event => event.author.role === 'assistant' ? { ...event, messages: ['天气不错。'] } : event) };
  assert.equal(parseDirectorResponse(`${peer.choiceId} N - react | 回应乙刚才对本人的邀请。`, noCall).basis, 'invalid');
});

test('scene-aware tasks require a current finite scene while old stop and scene recordings remain readable', () => {
  const options = { ...setup(), sceneCatalog: { options: [{ key: 'F', relation: 'fresh' }], topics: [], current: null, omittedTopics: 0 } };
  assert.equal(parseDirectorResponse(line(options, { scene: 'F' }), options).sceneKey, 'F');
  for (const scene of ['-', 'C99']) assert.equal(parseDirectorResponse(line(options, { scene }), options).reason, 'scene');
  assert.equal(parseDirectorResponse('WAIT N F', options).waitForUser, true);
  assert.equal(parseDirectorResponse('IDLE N F', options).waitForUser, false);
  assert.equal(parseDirectorResponse('WAIT', options).next, null);
  assert.equal(parseDirectorResponse(`${view(options).choices[0].choiceId} N F`, options).basis, 'model');
});

test('JSON contributions share normalization and cannot disagree with a second goal', () => {
  const options = setup(), choiceId = view(options).choices[0].choiceId;
  const result = parseDirector(JSON.stringify({ choiceId, contribution: task('ask', '  澄清尚未回答的一个范围。  ') }), options);
  assert.equal(result.next.goal, '澄清尚未回答的一个范围。');
  assert.deepEqual(result.next.contribution, task('ask', '澄清尚未回答的一个范围。'));
  for (const value of [{ choiceId, contribution: { ...task(), extra: true } }, { choiceId, contribution: task(), goal: '另一个任务。' },
    { choiceId: null, contribution: task() }]) assert.equal(parseDirector(JSON.stringify(value), options).basis, 'invalid');
  const duplicate = `{"choiceId":"${choiceId}","contribution":{"move":"ask","point":"问题甲。","point":"问题乙。"}}`;
  assert.equal(parseDirectorResponse(duplicate, options).reason, 'duplicate-key');
  const legacy = parseDirector(JSON.stringify({ choiceId, goal: '旧的有界目标。' }), options);
  assert.equal(legacy.next.goal, '旧的有界目标。'); assert.equal('contribution' in legacy.next, false);
});

test('progress retains only bounded current public assistant records and never private or omitted events', () => {
  const options = setup(), peer = options.events[1].id;
  options.contributions = [
    { eventId: peer, contribution: task('ask', '问清入口方向。') },
    { eventId: options.events[0].id, contribution: task('answer', 'USER_MUST_NOT_PROJECT') },
    { eventId: key('foreign', 'elsewhere'), contribution: task('answer', 'FOREIGN_MUST_NOT_PROJECT') },
    { eventId: peer, contribution: { ...task(), secret: 'PRIVATE_TASK_MUST_NOT_PROJECT' } },
    { eventId: peer, contribution: task('react', 'EXTRA_FIELD_MUST_NOT_PROJECT'), privateMemory: 'PRIVATE_FIELD_MUST_NOT_PROJECT' },
  ];
  const projected = view(options);
  assert.deepEqual(projected.contributions, [{ eventId: 'e2', contribution: task('ask', '问清入口方向。') }]);
  assert.doesNotMatch(JSON.stringify(projected), /MUST_NOT_PROJECT/);
  const without = view({ ...options, contributions: [] });
  assert.deepEqual(projected.choices.map(({ choiceId, ...value }) => value), without.choices.map(({ choiceId, ...value }) => value), 'task labels never create or consume routing authority');
  assert.notEqual(projected.choices[0].choiceId, without.choices[0].choiceId);
  assert.equal(parseDirectorResponse(`${without.choices[0].choiceId} N - react | 接这一句。`, options).basis, 'invalid', 'a stale progress snapshot is not silently rebound');
  const conflicting = view({ ...options, contributions: [{ eventId: peer, contribution: task('ask', '问题甲。') }, { eventId: peer, contribution: task('ask', '问题乙。') }] });
  assert.deepEqual(conflicting.contributions, [], 'conflicting labels for one actual event are omitted together');
});

test('progress counts and character budgets keep recent whole tasks without changing event evidence', () => {
  const options = setup(), user = options.events[0];
  options.events = [...Array.from({ length: 40 }, (_, i) => ({ id: key('a' + i), author: { role: 'assistant', id: 'dragon', name: '乙' }, messages: ['公开原话' + i] })), user];
  options.states = [{ ...options.states[0], pendingEventIds: [user.id], normalPendingEventIds: [user.id] }];
  options.contributions = options.events.slice(0, -1).map(event => ({ eventId: event.id, contribution: task('react', '接一句。') }));
  const short = view(options);
  assert.equal(short.contributions.length, 32);
  assert.ok(short.contributions.every(value => short.events.some(event => event.id === value.eventId && event.author.role === 'assistant')));
  options.contributions = options.contributions.map(value => ({ ...value, contribution: task('develop', '甲'.repeat(180)) }));
  const long = view(options);
  assert.ok(long.contributions.length > 0 && long.contributions.length < 32);
  assert.ok(JSON.stringify(long.contributions).length <= 3200);
  assert.deepEqual(short.events, long.events, 'progress budgeting never cuts or rewrites public evidence');
  assert.ok(long.contributions.every(value => value.contribution.point.length === 180));
});

test('production prompt assigns a concrete contribution without treating labels as fulfillment or quotas as tasks', () => {
  const options = setup(), prompt = buildDirectorRequest(options);
  assert.match(prompt.system, /先判断共同请求现在还欠/);
  assert.match(prompt.system, /不证明她真正完成/);
  assert.match(prompt.system, /熟人应声、玩笑/);
  assert.match(prompt.system, /choiceId work sceneKey move \| point/);
  assert.doesNotMatch(prompt.system, /只需选回应选项，不生成 goal|choiceId=null|waitForUser/);
  const native = buildDirectorPrompt(options);
  assert.match(native.system, /"contribution"/);
});
