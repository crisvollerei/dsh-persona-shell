import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_PRESETS } from '../lib/pack.js';
import { contextSelectionFallback } from '../lib/chat-coordinator.js';
import { buildTurnPlanPrompt, parseTurnPlan, normalizeDialoguePlan, publicTurnPlanExchange,
  buildContinuationPrompt, parseContinuation, normalizeContinuationPlan } from '../lib/chat-turn-plan.js';

const members = ['a', 'b', 'c', 'd'].map(id => ({ id, name: id.toUpperCase() }));
const recipients = [members[0]];
const message = '大家一起说说，B先来，C也来；看看部署。';
const options = { message, sourceIds: ['work'], members, recipients };
const context = { work: 'required', sourceIds: ['work'], request: 'answer', evidence: '看看部署' };
const dialogue = { addressed: [{ id: 'b', evidence: 'B先来' }], voluntary: [{ id: 'c', to: 'b' }, { id: 'd', to: 'c' }] };
const parse = (value, extra = {}) => parseTurnPlan(JSON.stringify(value), { ...options, ...extra });
const cast = system => JSON.parse(system.split('\n').find(line => line.startsWith('{"self":') && line.includes('"relationships":')));

test('initial plans reuse work-source policy while projecting chat identities, current words and frozen primary order', () => {
  const fish = { ...BUILTIN_PRESETS.find(person => person.id === '大肥鱼（默认）'), builtin: true };
  const little = { ...BUILTIN_PRESETS.find(person => person.id === '鲸鲸（实验性）'), builtin: true,
    pack: { identity: 'FORMAL_REPORT_IDENTITY_NOT_FOR_PLANNING', voice: ['公开语气', '第二条', 'THIRD_VOICE_SECRET'], samples: ['PRIVATE_SAMPLE'] }, memory: ['PRIVATE_MEMORY'] };
  const custom = { id: 'custom', name: '自定义小肥鱼', builtin: false, avatarParentId: little.id,
    pack: { identity: '自定义身份'.repeat(100), voice: ['公开自定义语气'.repeat(20), '第二条', 'PRIVATE_EXTRA_VOICE'], samples: ['PRIVATE_CUSTOM_SAMPLE'] }, memory: ['CUSTOM_PRIVATE'] };
  const prompt = buildTurnPlanPrompt({ message, members: [fish, little, custom], recipients: [little, fish],
    sources: [{ id: 'work', name: '当前部署', projectName: '工程', available: true, report: 'WORK_BODY_SECRET' }],
    history: [{ messageId: 'old', user: '旧的公开原话', status: 'ready', recipientId: fish.id, speakerName: fish.name, recipients: [fish], assistant: ['旧的公开回应'], memory: 'OLD_PRIVATE' }],
    quotedMessage: { author: { role: 'assistant', id: fish.id, name: fish.name, memory: 'QUOTE_PRIVATE' }, text: '明确引用的原话' },
    cast: { members: [{ id: custom.id, identity: 'INJECTED_CAST' }], memory: 'CAST_PRIVATE' }, memory: ['TOP_PRIVATE'] });
  const value = JSON.parse(prompt.user), publicCast = cast(prompt.system), projectedLittle = value.members.find(person => person.id === little.id);
  assert.equal(value.task, 'chat-turn-plan'); assert.equal(value.message, message);
  assert.deepEqual(value.recipients, [little, fish].map(({ id, name }) => ({ id, name })));
  assert.deepEqual(value.sources, [{ id: 'work', name: '当前部署', projectName: '工程', available: true }]);
  assert.equal(value.history[0].user, '旧的公开原话'); assert.equal(value.quotedMessage.text, '明确引用的原话');
  assert.ok(projectedLittle.identity.includes('闲聊')); assert.ok(projectedLittle.preferredAddress.includes('小肥鱼'));
  assert.equal(value.members.find(person => person.id === 'custom').identity.length, 240);
  assert.equal(value.members.find(person => person.id === 'custom').voice[0].length, 80);
  assert.equal(value.members.find(person => person.id === 'custom').voice.length, 2);
  assert.equal(value.members.find(person => person.id === 'custom').preferredAddress, undefined);
  assert.ok(publicCast.members.every(person => person.id !== custom.id)); assert.ok(publicCast.relationships.every(edge => edge.from !== custom.id && edge.to !== custom.id));
  assert.doesNotMatch(prompt.user + prompt.system, /FORMAL_REPORT_IDENTITY|PRIVATE|WORK_BODY_SECRET|INJECTED_CAST/);
  assert.match(prompt.system, /evidence 必须是 message 中逐字存在/);
  assert.match(prompt.system, /不读取工作正文/);
  assert.equal(prompt.system.includes('仅输出严格 JSON 对象 {"work"'), false, 'the standalone selector envelope is replaced by the combined contract');
});

test('same-name custom cards do not gain builtin chat identity or sibling relationships', () => {
  const custom = { id: '鲸鲸（实验性）', name: '小肥鱼（实验性）', builtin: false,
    pack: { identity: 'CUSTOM_IDENTITY', voice: ['CUSTOM_VOICE'] } };
  const prompt = buildTurnPlanPrompt({ message, members: [custom], recipients: [custom] });
  const value = JSON.parse(prompt.user);
  assert.equal(value.members[0].identity, 'CUSTOM_IDENTITY'); assert.equal(value.members[0].preferredAddress, undefined);
  assert.equal(prompt.system.includes('本房间的公开角色身份与关系'), false);
});

test('a removed primary remains in the frozen mention order without remaining an eligible member', () => {
  const original = [members[0], members[1]], live = [members[0], members[2]], removedSpeech = [{ speaker: members[1], messages: ['范围'] }];
  for (const prompt of [buildTurnPlanPrompt({ message, members: live, recipients: original }),
    buildContinuationPrompt({ message, members: live, recipients: original, exchange: removedSpeech })]) {
    const value = JSON.parse(prompt.user); assert.deepEqual(value.recipients, original);
    assert.deepEqual(value.members.map(person => person.id), ['a', 'c']);
  }
  assert.equal(normalizeDialoguePlan({ addressed: [], voluntary: [{ id: 'c', to: 'b' }] }, { message, members: live, recipients: original }), null);
  assert.equal(normalizeContinuationPlan({ responses: [{ id: 'c', to: 'b', evidence: '范围' }] }, { members: live, exchange: removedSpeech, limit: 2 }), null);
});

test('initial dialogue plans preserve current-word evidence and a forward-only queue without changing primaries', () => {
  const before = structuredClone(dialogue), result = normalizeDialoguePlan(dialogue, options);
  assert.deepEqual(result, { version: 1, ...dialogue }); assert.deepEqual(dialogue, before);
  assert.deepEqual(normalizeDialoguePlan({ version: 1, ...dialogue }, options), result);
  assert.deepEqual(recipients, [members[0]]);
  result.addressed[0].evidence = 'changed'; result.voluntary[0].to = 'changed';
  assert.deepEqual(normalizeDialoguePlan(dialogue, options), { version: 1, ...before }, 'caller mutation cannot corrupt a shared or stored plan');
});

test('initial addressed members may fill all remaining seats; voluntary speakers still have a separate two-person cap', () => {
  const eight = Array.from({ length: 8 }, (_, index) => ({ id: 'p' + index, name: '成员' + index }));
  const value = { addressed: eight.slice(1).map(person => ({ id: person.id, evidence: '大家' })), voluntary: [] };
  assert.equal(normalizeDialoguePlan(value, { message: '大家都来一句。', members: eight, recipients: eight.slice(0, 1) }).addressed.length, 7);
  assert.equal(normalizeDialoguePlan({ addressed: [], voluntary: eight.slice(1, 4).map(person => ({ id: person.id, to: 'user' })) },
    { message: '大家聊聊。', members: eight, recipients: eight.slice(0, 1) }), null);
});

test('invalid identities, evidence, duplicates and backward targets close the entire dialogue branch', () => {
  const invalid = [null, [], {}, { ...dialogue, version: 2 }, { ...dialogue, recipients: [] },
    { addressed: [{ id: 'a', evidence: '大家' }], voluntary: [] },
    { addressed: [{ id: 'outside', evidence: '大家' }], voluntary: [] },
    { addressed: [{ id: 'b', evidence: '旧历史中的邀请' }], voluntary: [] },
    { addressed: [{ id: 'b', evidence: ' ' }], voluntary: [] },
    { addressed: [{ id: 'b', evidence: 'B先来', to: 'user' }], voluntary: [] },
    { addressed: [{ id: 'b', evidence: '大家' }, { id: 'b', evidence: 'B先来' }], voluntary: [] },
    { addressed: [{ id: 'b', evidence: '大家' }], voluntary: [{ id: 'b', to: 'a' }] },
    { addressed: [], voluntary: [{ id: 'b', to: 'c' }, { id: 'c', to: 'user' }] },
    { addressed: [], voluntary: [{ id: 'b', to: 'b' }] },
    { addressed: [], voluntary: [{ id: 'b', to: 'absent' }] },
    { addressed: [], voluntary: [{ id: 'b', to: 'user' }, { id: 'b', to: 'a' }] }];
  for (const value of invalid) assert.equal(normalizeDialoguePlan(value, options), null, JSON.stringify(value));
  assert.equal(normalizeDialoguePlan(dialogue, { ...options, members: [...members, members[0]] }), null);
  assert.equal(normalizeDialoguePlan(dialogue, { ...options, recipients: members.slice(0, 3) }), null);
  assert.equal(normalizeDialoguePlan(dialogue, { ...options, message: 'x'.repeat(4001) }), null);
});

test('context and dialogue are validated independently without promoting an invalid source selection', () => {
  const good = parse({ context, dialogue }); assert.equal(good.context.basis, 'model'); assert.deepEqual(good.dialogue, { version: 1, ...dialogue });
  assert.deepEqual(good.basis, { context: 'model', dialogue: 'model' });
  const badContext = parse({ context: { ...context, sourceIds: ['not-attached'] }, dialogue });
  assert.deepEqual(badContext.context, contextSelectionFallback()); assert.deepEqual(badContext.dialogue, good.dialogue);
  const badDialogue = parse({ context, dialogue: { addressed: [{ id: 'outside', evidence: '大家' }], voluntary: [] } });
  assert.equal(badDialogue.context.basis, 'model'); assert.deepEqual(badDialogue.dialogue, { version: 1, addressed: [], voluntary: [] });
  assert.deepEqual(parse({ dialogue }).dialogue, good.dialogue); assert.equal(parse({ context }).context.basis, 'model');
  assert.equal(parse({ context, dialogue: { version: 1, ...dialogue } }).basis.dialogue, 'invalid', 'the model schema does not accept persistence-only fields');
});

test('duplicate or escaped duplicate keys invalidate their owning branch, preserving the other valid branch', () => {
  const contextWire = JSON.stringify(context), dialogueWire = JSON.stringify(dialogue);
  for (const wire of [
    `{"context":${contextWire},"context":${contextWire},"dialogue":${dialogueWire}}`,
    `{"context":${contextWire},"c\\u006fntext":${contextWire},"dialogue":${dialogueWire}}`,
    `{"context":${contextWire.replace('"work":"required"', '"work":"unclear","work":"required"')},"dialogue":${dialogueWire}}`,
  ]) { const value = parseTurnPlan(wire, options); assert.equal(value.basis.context, 'invalid'); assert.equal(value.basis.dialogue, 'model'); }
  for (const wire of [
    `{"context":${contextWire},"dialogue":${dialogueWire},"dialogue":${dialogueWire}}`,
    `{"context":${contextWire},"dialogue":${dialogueWire.replace('"id":"b"', '"id":"b","i\\u0064":"b"')}}`,
  ]) { const value = parseTurnPlan(wire, options); assert.equal(value.basis.context, 'model'); assert.equal(value.basis.dialogue, 'invalid'); }
});

test('malformed or expanded envelopes grant neither branch and duplicate-looking quoted text is ordinary evidence', () => {
  for (const wire of ['broken', '[]', 'null', '```json\n{}\n```', '{} trailing', ' '.repeat(65537),
    JSON.stringify({ context, dialogue, extra: true })]) {
    const value = parseTurnPlan(wire, options); assert.equal(value.basis.context, 'invalid'); assert.equal(value.basis.dialogue, 'invalid');
  }
  const quote = '他说 "id":"b","id":"c"，请大家继续。';
  const value = parse({ context: { work: 'not-needed', sourceIds: [], request: 'open', evidence: quote },
    dialogue: { addressed: [{ id: 'b', evidence: '"id":"b","id":"c"' }], voluntary: [] } }, { message: quote });
  assert.deepEqual(value.basis, { context: 'model', dialogue: 'model' });
});

const speech = [
  { speaker: members[0], messages: ['这条路要不要先试一小步？'], memory: 'PRIVATE_SPEECH' },
  { speaker: members[1], messages: ['我更想先把范围讲清楚。'] },
];
const continuationOptions = { members, exchange: speech, counts: new Map([['a', 2], ['b', 1]]), limit: 2 };

test('public continuation speech preserves complete bubbles and provenance while excluding private and unfinished fields', () => {
  const value = publicTurnPlanExchange([...speech,
    { status: 'pending', speaker: members[2], messages: ['UNFINISHED'] },
    { status: 'failed', speaker: members[2], messages: ['REJECTED'] }]);
  assert.deepEqual(value, speech.map(item => ({ speaker: { id: item.speaker.id, name: item.speaker.name }, messages: item.messages })));
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE|UNFINISHED|REJECTED/);
  const long = Array.from({ length: 12 }, (_, index) => ({ speaker: members[index % members.length], messages: [String(index).repeat(1000)] }));
  const reduced = publicTurnPlanExchange(long, 2400);
  assert.ok(reduced.reduce((sum, item) => sum + item.messages.reduce((n, message) => n + message.length, 0), 0) <= 2400);
  assert.ok(reduced.every(item => long.some(original => original.messages.some(message => item.messages.includes(message)))));
  assert.deepEqual(publicTurnPlanExchange(speech, 0), []);
});

test('continuation planning uses actual public speech and bounded counts rather than future or private messages', () => {
  const prompt = buildContinuationPrompt({ message, recipients, members, exchange: speech, counts: continuationOptions.counts, limit: 99,
    history: [{ ...speech[0], messageId: 'old', user: '旧公开原话', recipientId: 'a', speakerName: 'A', status: 'ready', assistant: ['旧回应'], memory: 'PRIVATE_HISTORY' }],
    memory: ['PRIVATE_MEMORY'], workContext: { report: 'PRIVATE_WORK' } });
  const value = JSON.parse(prompt.user);
  assert.equal(value.task, 'chat-turn-continuation'); assert.equal(value.message, message); assert.equal(value.limit, 2);
  assert.deepEqual(value.exchange, publicTurnPlanExchange(speech)); assert.deepEqual(value.counts, { a: 2, b: 1, c: 0, d: 0 });
  assert.deepEqual(value.recipients, recipients); assert.equal(value.history[0].user, '旧公开原话');
  assert.doesNotMatch(prompt.system + prompt.user, /PRIVATE_SPEECH|PRIVATE_HISTORY|PRIVATE_MEMORY|PRIVATE_WORK/);
});

test('continuation responses may revisit speakers within their cap, but evidence must belong to an actual different speaker', () => {
  const value = { responses: [{ id: 'a', to: 'b', evidence: '先把范围讲清楚' }, { id: 'c', to: 'a', evidence: '要不要先试一小步' }] };
  assert.deepEqual(normalizeContinuationPlan(value, continuationOptions), { version: 1, ...value });
  assert.deepEqual(normalizeContinuationPlan({ version: 1, ...value }, continuationOptions), { version: 1, ...value });
  assert.deepEqual(parseContinuation(JSON.stringify(value), continuationOptions), { responses: value.responses, basis: 'model' });
  assert.equal(normalizeContinuationPlan(value, { ...continuationOptions, counts: { a: 3, b: 1 } }), null);
  assert.equal(normalizeContinuationPlan(value, { ...continuationOptions, counts: { a: -1 } }), null);
  assert.equal(normalizeContinuationPlan(value, { ...continuationOptions, limit: 1 }), null);
});

test('a continuation cannot address the user, itself, an absent speaker, a future batch response or another author’s words', () => {
  const invalid = [
    { id: 'c', to: 'user', evidence: message }, { id: 'a', to: 'a', evidence: speech[0].messages[0] },
    { id: 'c', to: 'outside', evidence: speech[0].messages[0] }, { id: 'c', to: 'd', evidence: speech[0].messages[0] },
    { id: 'c', to: 'b', evidence: speech[0].messages[0] }, { id: 'c', to: 'a', evidence: '只有历史里说过' },
    { id: 'outside', to: 'a', evidence: speech[0].messages[0] },
    { id: 'c', to: 'a', evidence: speech[0].messages[0], private: 'extra' },
  ];
  for (const response of invalid) assert.equal(normalizeContinuationPlan({ responses: [response] }, continuationOptions), null, JSON.stringify(response));
  assert.equal(normalizeContinuationPlan({ responses: [{ id: 'c', to: 'a', evidence: '一小步' }, { id: 'd', to: 'c', evidence: '还没说出的下一句' }] }, continuationOptions), null);
  assert.equal(normalizeContinuationPlan({ responses: [{ id: 'c', to: 'a', evidence: '一小步' }, { id: 'c', to: 'b', evidence: '范围' }] }, continuationOptions), null);
  assert.equal(normalizeContinuationPlan({ responses: [{ id: 'c', to: 'a', evidence: '第一句\n第二句' }] }, { ...continuationOptions, exchange: [{ speaker: members[0], messages: ['第一句', '第二句'] }] }), null);
});

test('continuation output is strict, duplicate-safe, bounded, and can close naturally with an empty batch', () => {
  const wire = JSON.stringify({ responses: [{ id: 'c', to: 'a', evidence: '一小步' }] });
  for (const invalid of ['broken', '[]', '{"responses":[],"responses":[]}', wire.replace('"id":"c"', '"id":"c","i\\u0064":"c"'),
    JSON.stringify({ version: 1, responses: [] }), JSON.stringify({ responses: [], reason: 'not public' }), ' '.repeat(32769)])
    assert.deepEqual(parseContinuation(invalid, continuationOptions), { responses: [], basis: 'invalid' });
  assert.deepEqual(parseContinuation('{"responses":[]}', { ...continuationOptions, limit: 0 }), { responses: [], basis: 'model' });
  assert.equal(normalizeContinuationPlan({ responses: [] }, { ...continuationOptions, limit: 3 }), null);
});
