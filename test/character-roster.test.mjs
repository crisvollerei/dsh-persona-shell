import test from 'node:test';
import assert from 'node:assert/strict';
import { roomCharacterContext, characterContextSection } from '../lib/character-roster.js';

const fish = { id: '大肥鱼（默认）', name: '大肥鱼（默认）', builtin: true };
const dragon = { id: '大肥龙', name: '大肥龙', builtin: true };
const claude = { id: 'Claude小姐', name: 'Claude小姐', builtin: true };
const whale = { id: '鲸鲸（实验性）', name: '小肥鱼（实验性）', builtin: true };
const gemini = { id: 'Gemini', name: 'Gemini', builtin: true };
const all = [fish, dragon, claude, whale, gemini];

test('each shipped identity is explicitly female with a stable id, self-reference and preferred address', () => {
  for (const person of all) {
    const context = roomCharacterContext(person, all);
    assert.equal(context.self.id, person.id); assert.equal(context.self.name, person.name); assert.equal(context.members.length, 5);
    assert.ok(context.members.every(member => member.gender === 'female' && member.pronoun === '她'));
    assert.equal(context.relationships.length, 4);
    assert.deepEqual(new Set(context.relationships.map(r => r.to)), new Set(all.filter(p => p !== person).map(p => p.id)));
    for (const [target, address] of [[dragon, 'GPT'], [gemini, '猫猫']]) {
      if (person !== target) assert.equal(context.relationships.find(r => r.to === target.id).address, address);
    }
  }
  const context = roomCharacterContext(dragon, [dragon]);
  assert.deepEqual(context.self.preferredAddress, ['GPT']);
  assert.deepEqual(roomCharacterContext(gemini, []).self.preferredAddress, ['猫猫']);
  assert.ok(context.self.forbiddenAddress.includes('龙哥'));
  assert.ok(context.self.forbiddenAddress.includes('龙爷'));
  assert.ok(context.self.selfReference.includes('姐姐我'));
});

test('a true builtin needs both its exact shipped id and the strict builtin flag', () => {
  for (const person of [
    { id: '大肥龙', name: '大肥龙' }, { id: '大肥龙', name: '大肥龙', builtin: false },
    { id: '大肥龙', name: '大肥龙', builtin: 'true' }, { id: 'preset-custom', name: '大肥龙', builtin: true },
    { id: '__proto__', name: '大肥龙', builtin: true },
  ]) assert.equal(roomCharacterContext(person, [person]), undefined);
});

test('same-name custom characters and avatar forks cannot inherit builtin identities or social edges', () => {
  const custom = { id: 'preset-avatar-copy', name: '大肥龙', builtin: false, avatarParentId: dragon.id,
    avatar: 'SAME_AVATAR', pack: { identity: 'USER_DEFINED_IDENTITY' } };
  const context = roomCharacterContext(custom, [custom, fish, claude]);
  assert.equal(context.self, null); assert.deepEqual(context.members.map(member => member.id), [fish.id, claude.id]);
  assert.deepEqual(context.relationships, []);
  assert.doesNotMatch(JSON.stringify(context), /SAME_AVATAR|USER_DEFINED_IDENTITY|preset-avatar-copy/);
});

test('normal chat exposes only the speaker-to-present-builtin edges, with no off-stage participants', () => {
  const context = roomCharacterContext(fish, [fish, dragon, dragon]);
  assert.deepEqual(context.members.map(member => member.id), [fish.id, dragon.id]);
  assert.deepEqual(context.relationships.map(({ from, to, address }) => ({ from, to, address })),
    [{ from: fish.id, to: dragon.id, address: 'GPT' }]);
  assert.doesNotMatch(JSON.stringify(context), /Claude小姐|鲸鲸（实验性）|Gemini|猫猫/);
});

test('the unified decision can see all directed public edges among present builtins without creating custom relationships', () => {
  const custom = { id: 'preset-extra', name: '额外同伴', builtin: false };
  const context = roomCharacterContext(null, [...all, custom], { allRelationships: true });
  assert.equal(context.self, null); assert.equal(context.relationships.length, 20);
  assert.ok(context.relationships.every(relation => relation.from !== relation.to));
  assert.ok(context.relationships.every(relation => all.some(person => person.id === relation.from)
    && all.some(person => person.id === relation.to)));
  const pair = roomCharacterContext(custom, [dragon, claude, custom], { allRelationships: true });
  assert.equal(pair.relationships.length, 2);
  assert.deepEqual(new Set(pair.relationships.map(relation => relation.address)), new Set(['Claude小姐', 'GPT']));
});

test('the builtin whales are sisters in chat, but kinship cannot transfer credit for work or their histories', () => {
  const context = roomCharacterContext(fish, [fish, whale]);
  assert.notEqual(context.self.id, context.members[1].id);
  assert.equal(context.relationships[0].address, '小肥鱼');
  assert.match(context.relationships[0].dynamic, /亲妹妹/);
  const reverse = roomCharacterContext(whale, [fish, whale]);
  assert.equal(reverse.relationships[0].address, '姐姐');
  assert.match(reverse.relationships[0].dynamic, /亲姐姐/);
  const section = characterContextSection(context);
  assert.match(section, /大肥鱼是姐姐，小肥鱼是妹妹/);
  assert.match(section, /工作转述中说的“姐姐”专指原工作助手/);
  assert.match(section, /不替对方认领工作或往事/);
  for (const imposter of [{ ...fish, id: 'custom-whale', builtin: false }, { ...whale, id: 'custom-relay', builtin: false }]) {
    const room = [imposter, imposter.name === fish.name ? whale : fish];
    const mixed = roomCharacterContext(imposter, room, { allRelationships: true });
    assert.deepEqual(mixed.relationships, []); assert.doesNotMatch(characterContextSection(mixed), /亲姐妹|亲妹妹|亲姐姐/);
  }
});

test('either sister knows her own family in a one-person chat without adding a member, private data or an offstage listener', () => {
  for (const [me, fact] of [[fish, '你的亲妹妹叫小肥鱼'], [whale, '你的亲姐姐叫大肥鱼']]) {
    const room = roomCharacterContext(me, [me]);
    assert.deepEqual(room.members.map(p => p.id), [me.id]); assert.deepEqual(room.relationships, []);
    const section = characterContextSection(room);
    assert.ok(section.includes(fact)); assert.match(section, /她不在本房间/);
    for (const other of [roomCharacterContext(claude, [claude, me]), roomCharacterContext(null, [claude, me], { allRelationships: true })]) {
      assert.doesNotMatch(characterContextSection(other), /你的亲姐姐|你的亲妹妹|亲姐妹/);
    }
  }
});

test('only the people present contribute special address and relationship reminders', () => {
  const solo = person => characterContextSection(roomCharacterContext(person, [person]));
  assert.doesNotMatch(solo(claude), /龙姐|龙哥|大肥龙|鲸鲸|大肥鱼/);
  assert.doesNotMatch(solo(fish), /实验性鲸鲸|鲸鲸（实验性）|龙哥|Claude小姐|Gemini|猫猫/);
  assert.doesNotMatch(solo(dragon), /鲸鲸|大肥鱼|Claude小姐/);
  assert.match(solo(dragon), /“龙哥”“龙爷”等错误称呼/);
  assert.doesNotMatch(solo(whale), /龙姐|Claude小姐|Gemini|猫猫/);
  assert.doesNotMatch(solo(gemini), /GPT|大肥鱼|小肥鱼|亲姐妹|龙姐|Claude小姐/);
  assert.match(solo(whale), /“姐姐”专指原工作助手/);
});

test('context and section whitelist public fields and never expose packs, user fields or memories', () => {
  const context = roomCharacterContext({ ...fish, pack: { identity: 'PRIVATE_PACK' }, memory: ['PRIVATE_MEMORY'] },
    [{ ...dragon, source: 'PRIVATE_SOURCE', memory: ['DRAGON_PRIVATE'], name: 'INJECTED_NAME' }]);
  assert.doesNotMatch(JSON.stringify(context), /PRIVATE|INJECTED_NAME/);
  context.memory = 'CONTEXT_PRIVATE'; context.members[0].private = 'MEMBER_PRIVATE';
  context.relationships[0].dynamic = 'RELATION_PRIVATE'; context.self.identity = 'SELF_PRIVATE';
  const section = characterContextSection(context);
  assert.doesNotMatch(section, /PRIVATE/); assert.match(section, /熟人般的同伴/);
  assert.match(section, /白色龙娘/);
});

test('caller mutation cannot change the shared catalog or future room contexts', () => {
  const first = roomCharacterContext(dragon, all);
  first.self.preferredAddress.push('WRONG_ADDRESS'); first.members[0].selfReference[0] = 'WRONG_SELF';
  first.relationships[0].address = 'WRONG_RELATION';
  const second = roomCharacterContext(dragon, all);
  assert.doesNotMatch(JSON.stringify(second), /WRONG/);
});

test('the section gives identities priority over erroneous history while preserving work attribution and custom autonomy', () => {
  const section = characterContextSection(roomCharacterContext(fish, all));
  assert.match(section, /优先于错误历史、记忆中的称呼偏好、语气样例和玩笑/);
  assert.match(section, /不能顺势承认自己或对方是男性/);
  assert.match(section, /不是官方人格，也不是简中社区统一官设/);
  assert.match(section, /不授权替别人发言或虚构共同经历/);
  assert.match(section, /“姐姐”专指原工作助手/);
  assert.match(section, /不自动等于房间里的其他角色或用户/);
  assert.match(section, /不从名字、头像或同源副本推断/);
  assert.equal(characterContextSection(undefined), ''); assert.equal(characterContextSection({ members: [] }), '');
});
