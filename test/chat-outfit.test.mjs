// Public prompt/data boundaries only; these checks do not establish model story quality.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_PRESETS } from '../lib/pack.js';
import { roomCharacterContext, characterContextSection } from '../lib/character-roster.js';
import { buildChatPrompt } from '../lib/chat-prompt.js';
import { buildDirectorPrompt } from '../lib/chat-director.js';
import { buildDirectorRequest } from '../lib/chat-director-wire.js';
import { buildRewritePrompt } from '../lib/prompt.js';
import { buildProgressPrompt } from '../lib/progress.js';

const people = BUILTIN_PRESETS.map(preset => ({ ...preset, builtin: true }));
const person = id => people.find(preset => preset.id === id);
const fish = person('大肥鱼（默认）'), little = person('鲸鲸（实验性）'), claude = person('Claude小姐');
const publicBody = section => JSON.parse(section.split('\n').find(line => line.startsWith('{"self":')));
const outfitOf = id => roomCharacterContext(person(id), [person(id)]).self.defaultOutfit;

test('five public default outfits retain visible distinguishing details without inferring age or material', () => {
  const requirements = [
    [fish.id, [/深蓝.*白色/, /长款女仆裙/, /白围裙上有鲸鱼图案/, /白色荷叶边头饰配蓝色蝴蝶结/]],
    [little.id, [/姐姐同款/, /短裙/, /白短袜/, /白围裙上有鲸鱼图案/, /白色荷叶边头饰配蓝色蝴蝶结/]],
    ['Gemini', [/紫蓝/, /星形/, /露腹短上衣/, /非对称短裙/, /分离袖/, /白色袜套/, /蓝鞋/]],
    ['大肥龙', [/白色无袖高领开衩长裙/, /拖摆/, /披袖/, /流苏/, /银色纹样/, /白鞋/]],
    [claude.id, [/奶白色长裙/, /黑色束腰/, /橙黑色披挂/, /花饰/, /蝴蝶结/, /浅色系带短靴/]],
  ];
  for (const [id, details] of requirements) {
    const outfit = outfitOf(id);
    assert.ok(outfit.trim() && outfit.length <= 180, 'public outfit is a bounded description');
    for (const detail of details) assert.match(outfit, detail, id);
    assert.doesNotMatch(outfit, /岁|未成年|幼女|丝绸|棉质|皮革|身体曲线/);
  }
  assert.match(roomCharacterContext(little, [little]).self.identity, /Q版是造型，不代表年龄/);
});

test('full and compact projections preserve all present public relationships and canonical outfits', () => {
  const context = roomCharacterContext(fish, people), original = structuredClone(context);
  context.self.defaultOutfit = 'PRIVATE_MUTATED_OUTFIT';
  context.members[0].defaultOutfit = 'PRIVATE_MEMBER_OUTFIT';
  context.privateOutfit = 'PRIVATE_EXTRA';
  const full = characterContextSection(context), compact = characterContextSection(context, { compact: true });
  assert.deepEqual(publicBody(full), original);
  assert.deepEqual(publicBody(compact), original);
  assert.doesNotMatch(full + compact, /PRIVATE_/);
  for (const section of [full, compact]) {
    assert.match(section, /默认衣着，不是永恒身份或当前动作/);
    assert.match(section, /用户对本幕衣着的描述或换装要求优先/);
    assert.match(section, /不要求先证明换过/);
    assert.match(section, /不必每轮描写衣服或动作/);
  }
});

test('outfits belong only to present authenticated builtins and do not authenticate same-name custom cards', () => {
  const custom = { id: 'custom-claude', name: claude.name, builtin: false, pack: claude.pack,
    avatarParentId: claude.id, defaultOutfit: 'CUSTOM_PRIVATE_OUTFIT' };
  assert.equal(roomCharacterContext(custom, [custom]), undefined);
  assert.equal(roomCharacterContext({ ...claude, builtin: false }, [{ ...claude, builtin: false }]), undefined);
  const context = roomCharacterContext(custom, [custom, fish, little]);
  assert.equal(context.self, null);
  assert.deepEqual(context.members.map(member => member.id), [fish.id, little.id]);
  assert.ok(context.members.every(member => typeof member.defaultOutfit === 'string'));
  const section = characterContextSection(context);
  assert.doesNotMatch(section, /CUSTOM_PRIVATE_OUTFIT|奶白色长裙|橙黑色披挂|custom-claude/);
  assert.deepEqual(context.relationships, [], 'custom speaker does not gain builtin social edges');
});

test('mutating an outfit projection never changes another room, future calls or the persisted persona pack', () => {
  const packsBefore = structuredClone(BUILTIN_PRESETS);
  const firstRoom = roomCharacterContext(claude, [claude, fish]);
  const defaultOutfit = firstRoom.self.defaultOutfit;
  firstRoom.self.defaultOutfit = '第一间房的临时换装';
  firstRoom.members[0].defaultOutfit = '另一份修改';
  const secondRoom = roomCharacterContext(claude, [claude]);
  assert.equal(secondRoom.self.defaultOutfit, defaultOutfit);
  assert.equal(secondRoom.members[0].defaultOutfit, defaultOutfit);
  assert.deepEqual(BUILTIN_PRESETS, packsBefore);
  assert.ok(BUILTIN_PRESETS.every(preset => !Object.hasOwn(preset.pack, 'defaultOutfit')));
});

test('actor and director receive the same defaults while current-scene wardrobe words stay intact', () => {
  const members = [fish, claude], message = '小克穿长裙，我们从窗边走到花园；鲸鲸这幕换成便装。';
  const actor = buildChatPrompt({ pack: claude.pack, persona: claude, history: [], message, speaker: claude,
    participants: members, recipients: [claude], cast: roomCharacterContext(claude, members), roomId: 'outfit-room', generation: 0 });
  assert.equal(publicBody(actor.system).self.defaultOutfit, outfitOf(claude.id));
  assert.ok(JSON.stringify(actor.messages).includes(message), 'the exact scene change is kept as user speech');
  for (const director of [buildDirectorPrompt({ message, members }), buildDirectorRequest({ message, members })]) {
    for (const member of members) assert.ok(director.system.includes(outfitOf(member.id)), 'director sees each present builtin default');
    assert.ok(director.user.includes(message));
    assert.match(director.system, /用户对本幕衣着的描述或换装要求优先/);
  }
  assert.equal(roomCharacterContext(claude, members).self.defaultOutfit, outfitOf(claude.id),
    'scene speech does not persistently rewrite the default catalog');
});

test('formal report and progress prompts do not import public wardrobe defaults', () => {
  for (const preset of people) {
    const report = buildRewritePrompt({ pack: preset.pack, persona: preset, masked: '本地检查完成，真实设备尚未验证。', literalCount: 0, history: [] });
    const progress = buildProgressPrompt(preset.pack, '当前轮次仍在运行。', [], preset);
    assert.ok(report.user.includes('真实设备尚未验证'), 'the formal source remains present');
    for (const prompt of [report, progress]) {
      assert.doesNotMatch(JSON.stringify(prompt), /defaultOutfit|用户对本幕衣着/);
      for (const member of people) assert.ok(!JSON.stringify(prompt).includes(outfitOf(member.id)), 'chat wardrobe stays out of work expression');
    }
  }
});
