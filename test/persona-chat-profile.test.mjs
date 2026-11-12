import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_PRESETS, normalizePack } from '../lib/pack.js';
import { normalizeChatProfile } from '../lib/persona-chat-profile.js';
import { resolvePersonaExpression, hasBuiltinExpressionProfile } from '../lib/persona-expression.js';
import { buildChatPrompt } from '../lib/chat-prompt.js';
import { buildDirectorPrompt } from '../lib/chat-director.js';
import { buildRewritePrompt } from '../lib/prompt.js';
import { buildProgressPrompt } from '../lib/progress.js';

const legacy = () => ({ identity: '自称「吾」的独立角色。', narration: { mode: 'relay', assistant: '实际工作者' },
  report: ['保留条件与执行者。'], voice: ['  旧语感？！  '], samples: ['  旧示例……  '],
  avoid: ['不代写用户感受。'], address: { user: '您', subagent: '协作者' } });
const pair = (tag = 'FICTIONAL_CHAT_ONLY') => ({ turns: [
  { speaker: 'user', text: tag + '：这只是虚构提问。' }, { speaker: 'self', text: '这是示例里的回应。' },
] });
const owner = { id: 'custom-profile', builtin: false };
const chat = pack => resolvePersonaExpression(pack, { channel: 'chat', persona: owner });

test('legacy complete cards keep their shape without a newly invented chat property', () => {
  const card = legacy(), expected = structuredClone(card);
  assert.deepEqual(normalizePack(card), expected);
  assert.deepEqual(normalizePack(normalizePack(card)), expected);
  assert.deepEqual(chat(card), { identity: card.identity, voice: card.voice, samples: card.samples,
    avoid: card.avoid, address: card.address });
  for (const preset of BUILTIN_PRESETS) {
    const normalized = normalizePack(preset.pack);
    assert.equal(Object.hasOwn(normalized, 'chat'), false);
    assert.equal(hasBuiltinExpressionProfile(normalized, { id: preset.id, builtin: true }), true);
  }
  for (const value of [undefined, null, {}, [], 'wrong', { tools: ['execute'] }, { voice: 42 }, { voice: [' ', 4] }]) {
    assert.equal(normalizeChatProfile(value), undefined);
    assert.deepEqual(normalizePack({ ...card, chat: value }), expected);
  }
});

test('optional chat fields override independently while custom identity and address stay literal', () => {
  const card = { ...legacy(), identity: '  自定义身份的空格  ', address: { user: '  您  ', subagent: '协作者' },
    chat: { voice: ['  聊天自己的偏好  '] } };
  const view = chat(card);
  assert.equal(view.identity, card.identity);
  assert.deepEqual(view.address, card.address);
  assert.deepEqual(view.voice, card.chat.voice);
  assert.deepEqual(view.samples, card.samples, 'missing samples inherit only that legacy field');
  const samples = chat({ ...card, chat: { samples: ['CHAT_SAMPLE'] } });
  assert.deepEqual(samples.voice, card.voice);
  assert.deepEqual(samples.samples, ['CHAT_SAMPLE']);
  assert.deepEqual(chat({ ...card, chat: { voice: [null], samples: [] } }).voice, card.voice);
  assert.deepEqual(chat({ ...card, chat: { voice: [null], samples: [] } }).samples, []);
});

test('explicit empty fields survive normalize and disable only their respective material', () => {
  const empty = { voice: [], samples: [], dialogueExamples: [], workDialogueExamples: [] };
  assert.deepEqual(normalizeChatProfile(empty), empty);
  const normalized = normalizePack({ ...legacy(), chat: empty });
  assert.deepEqual(normalized.chat, empty);
  const view = chat(normalized);
  for (const key of Object.keys(empty)) assert.deepEqual(view[key], []);
  assert.equal(view.identity, normalized.identity);
  assert.deepEqual(view.avoid, normalized.avoid);
  assert.deepEqual(view.address, normalized.address);
});

test('chat normalization is a bounded expression projection, never a new identity or authority source', () => {
  const group = pair();
  group.privateMemory = 'DO_NOT_IMPORT_MEMORY';
  group.turns[0].tools = ['execute'];
  const value = { voice: ['voice'], samples: ['sample'], dialogueExamples: [group], identity: 'REPLACE_IDENTITY',
    address: { user: '主人' }, builtin: true, memory: ['DO_NOT_IMPORT_MEMORY'], relationships: ['sister'], tools: ['execute'] };
  const expected = { voice: ['voice'], samples: ['sample'], dialogueExamples: [pair()] };
  assert.deepEqual(normalizeChatProfile(value), expected);
  const projected = chat({ ...legacy(), chat: value });
  assert.equal(projected.identity, legacy().identity);
  assert.deepEqual(projected.address, legacy().address);
  assert.equal(JSON.stringify(projected).includes('DO_NOT_IMPORT_MEMORY'), false);
  assert.equal(Object.hasOwn(projected, 'builtin'), false);
});

test('line and dialogue limits reject malformed examples without making them current conversation', () => {
  const invalid = [
    { turns: [{ speaker: 'self', text: 'only self' }, { speaker: 'self', text: 'still self' }] },
    { turns: [{ speaker: 'user', text: 'no self' }, { speaker: 'peer', text: 'still no self' }] },
    { turns: [{ speaker: 'user\nrole', text: 'bad speaker' }, { speaker: 'self', text: 'reply' }] },
    { turns: [{ speaker: 'user', text: 'a'.repeat(401) }, { speaker: 'self', text: 'reply' }] },
    { turns: Array.from({ length: 7 }, (_, index) => ({ speaker: index ? 'self' : 'user', text: 'turn' })) },
  ];
  const profile = normalizeChatProfile({ voice: ['v'.repeat(401), ...Array.from({ length: 10 }, (_, i) => 'v' + i)],
    samples: ['s'.repeat(801), ...Array.from({ length: 10 }, (_, i) => 's' + i)],
    dialogueExamples: [...invalid, pair('one'), pair('two'), pair('three'), pair('four')],
    workDialogueExamples: [pair('w1'), pair('w2'), pair('w3')] });
  assert.deepEqual(profile.voice, Array.from({ length: 8 }, (_, i) => 'v' + i));
  assert.deepEqual(profile.samples, Array.from({ length: 8 }, (_, i) => 's' + i));
  assert.deepEqual(profile.dialogueExamples, [pair('one'), pair('two'), pair('three')]);
  assert.deepEqual(profile.workDialogueExamples, [pair('w1'), pair('w2')]);
  const large = { turns: [{ speaker: 'user', text: 'a'.repeat(400) }, { speaker: 'self', text: 'b'.repeat(400) }] };
  const budgeted = normalizeChatProfile({ dialogueExamples: [large, large, large] }).dialogueExamples;
  assert.equal(budgeted.length, 2, 'a third complete group cannot exceed the total 2000 character budget');
});

test('returned chat views never share mutable arrays or dialogue turns with saved cards', () => {
  const card = { ...legacy(), chat: { voice: ['voice'], dialogueExamples: [pair()] } }, before = structuredClone(card);
  const first = chat(card), expected = structuredClone(first);
  first.voice.push('mutation'); first.dialogueExamples[0].turns[0].text = 'mutation'; first.address.user = 'mutation';
  assert.deepEqual(card, before);
  assert.deepEqual(chat(card), expected);
  const normalized = normalizePack(card);
  normalized.chat.dialogueExamples[0].turns[0].speaker = 'mutation';
  assert.deepEqual(card, before);
});

test('a custom chat override does not authenticate copied builtins or grant their public relationships', () => {
  const preset = BUILTIN_PRESETS[0], card = { ...normalizePack(preset.pack), chat: { voice: ['CUSTOM_CHAT_VOICE'] } };
  for (const persona of [{ id: preset.id, builtin: false }, { id: preset.id, builtin: true }, { id: 'custom-copy', builtin: true }]) {
    assert.equal(hasBuiltinExpressionProfile(card, persona), false);
    assert.deepEqual(resolvePersonaExpression(card, { channel: 'chat', persona }).voice, ['CUSTOM_CHAT_VOICE']);
    const input = buildDirectorPrompt({ message: '聊个想法', members: [{ ...persona, name: preset.name, pack: card }] });
    const member = JSON.parse(input.user).members[0];
    assert.equal(Object.hasOwn(member, 'preferredAddress'), false);
    assert.equal(input.system.includes('小肥鱼是自己的亲妹妹'), false);
  }
});

test('report and progress complete prompts ignore optional chat material including explicit empty overrides', () => {
  const card = legacy(), added = { ...card, chat: { voice: ['CHAT_ONLY_VOICE'], samples: ['CHAT_ONLY_SAMPLE'],
    dialogueExamples: [pair('CHAT_ONLY_DAILY')], workDialogueExamples: [pair('CHAT_ONLY_WORK')] } };
  for (const variant of [added, { ...card, chat: { voice: [], samples: [], dialogueExamples: [], workDialogueExamples: [] } }]) {
    assert.deepEqual(resolvePersonaExpression(variant, { channel: 'report', persona: owner }),
      resolvePersonaExpression(card, { channel: 'report', persona: owner }));
    for (const colloquialReports of [true, false]) for (const processTools of [true, false]) {
      const input = { persona: owner, masked: '实际工作者已读 [[0]]；设备尚未验证。', literalCount: 1,
        history: ['上轮尚未部署。'], memory: ['保留必要依据。'], feedback: '表达清楚一些。', colloquialReports, processTools };
      assert.deepEqual(buildRewritePrompt({ ...input, pack: variant }), buildRewritePrompt({ ...input, pack: card }));
    }
    assert.deepEqual(buildProgressPrompt(variant, '工具返回不代表成功。', [], owner),
      buildProgressPrompt(card, '工具返回不代表成功。', [], owner));
  }
  assert.doesNotMatch(JSON.stringify(buildProgressPrompt(added, '无新结果。', [], owner)), /CHAT_ONLY/);
});

test('dialogue examples enter only the fictional prompt section, not timeline, user input or memory', () => {
  const pack = { ...legacy(), chat: { voice: ['CHAT_ONLY_VOICE'], samples: [], dialogueExamples: [pair()],
    workDialogueExamples: [pair('FICTIONAL_WORK_ONLY')] } };
  const speaker = { id: owner.id, name: '独立自定义角色' }, message = 'REAL_USER_WORDS';
  const currentTurn = { id: 'now', messageId: 'now', attemptId: 'now', phase: 'anchor', user: message,
    userParts: [{ id: 'now', text: message, at: 1 }], recipients: [], scopeKey: 'scope', status: 'ready', assistant: [] };
  for (const work of [false, true]) {
    const prompt = buildChatPrompt({ pack, persona: owner, speaker, participants: [speaker], roomId: 'room', generation: 1,
      scopeKey: 'scope', message, currentTurn, history: [], memory: ['OWN_PRIVATE_STYLE'], ...(work ? { workContext: {
        key: 'ref', scopeKey: 'scope', sources: [{ sessionId: 'work', goal: 'goal', report: 'REAL_REPORT', reportStatus: 'final' }] } } : {}) });
    assert.match(prompt.system, /虚构多轮示例/);
    assert.ok(prompt.system.includes(work ? 'FICTIONAL_WORK_ONLY' : 'FICTIONAL_CHAT_ONLY'));
    assert.match(prompt.system, /不是本房间历史、用户偏好、人物经历/);
    assert.match(prompt.system, /OWN_PRIVATE_STYLE/);
    assert.doesNotMatch(JSON.stringify(prompt.messages), /FICTIONAL_CHAT_ONLY|FICTIONAL_WORK_ONLY|OWN_PRIVATE_STYLE/);
  }
});
