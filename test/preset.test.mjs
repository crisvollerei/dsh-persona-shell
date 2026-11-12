// Offline checks for persona presets: the extraction contract and the parser
// that has to survive whatever a model actually returns.
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildExtractPrompt, parseExtractedPreset, parseGeneratedPreset, PRESET_FIELDS, EXTRACT_PRESET_TEMPLATE,
  GENERATION_RECORDS_EXAMPLE } from '../lib/preset.js';

test('extracted narration is explicit, bounded and defaults to an ordinary voice', () => {
  const relay = parseExtractedPreset(JSON.stringify({ identity: '转述者', narration: { mode: 'relay', assistant: '姐姐（原助手）' } }));
  assert.equal(relay.preset.narration.mode, 'relay');
  assert.equal(relay.preset.narration.assistant, '姐姐');
  const ordinary = parseExtractedPreset(JSON.stringify({ identity: '普通口吻' }));
  assert.equal(ordinary.preset.narration.mode, 'voice');
});
import { normalizePack } from '../lib/pack.js';

test('the extraction prompt adapts shared identity to separate report and chat material', () => {
  const { system, user } = buildExtractPrompt('你是某个角色，有蓝色头发，说话很活泼。');
  assert.ok(system.includes('外貌与虚构背景'), 'source identity is retained only where useful');
  assert.ok(system.includes('第一人称'), 'explicit self-reference remains shared');
  assert.ok(system.includes('voice/sample 用于正式转述'), 'report expression has separate records');
  assert.ok(system.includes('daily 恰好写2组') && system.includes('work 恰好写1组'), 'chat requires complete multi-turn groups');
  assert.ok(system.includes('虚构风格材料') && system.includes('用户的动作、选择和反馈留给用户'));
  assert.ok(!system.includes('这张卡不是用来和用户聊天'));
  for (const tag of new Set(GENERATION_RECORDS_EXAMPLE.map(record => record[0]))) assert.ok(system.includes(`"${tag}"`), `${tag} record is shown`);
  assert.ok(user.includes('蓝色头发'), 'the persona prompt travels verbatim');
});

test('the complete JSON template has the channel field types and survives parse then normalize', () => {
  const wire = JSON.stringify(EXTRACT_PRESET_TEMPLATE, null, 2);
  const template = JSON.parse(wire);
  assert.deepEqual(Object.keys(template), PRESET_FIELDS.map(field => field.key));
  for (const field of ['name', 'identity']) assert.equal(typeof template[field], 'string');
  for (const field of ['report', 'voice', 'samples', 'avoid']) {
    assert.ok(Array.isArray(template[field]) && template[field].length > 0);
    assert.ok(template[field].every(value => typeof value === 'string'));
  }
  assert.deepEqual(Object.keys(template.narration), ['mode', 'assistant']);
  assert.equal(template.narration.mode, 'voice');
  assert.equal(typeof template.narration.assistant, 'string');
  assert.deepEqual(Object.keys(template.address), ['user', 'subagent']);
  assert.ok(Object.values(template.address).every(value => typeof value === 'string'));
  assert.deepEqual(Object.keys(template.chat), ['voice', 'samples', 'dialogueExamples', 'workDialogueExamples']);
  assert.ok(template.chat.voice.every(value => typeof value === 'string'));
  assert.deepEqual(template.chat.samples, []);
  for (const field of ['dialogueExamples', 'workDialogueExamples']) {
    assert.equal(template.chat[field].length, 1, 'template illustrates one group; the prompt sets the actual counts');
    const group = template.chat[field][0];
    assert.deepEqual(Object.keys(group), ['turns']);
    assert.equal(group.turns.length, 3);
    assert.ok(group.turns.some(turn => turn.speaker === 'self'));
    assert.ok(group.turns.some(turn => turn.speaker !== 'self'));
    for (const turn of group.turns) {
      assert.deepEqual(Object.keys(turn), ['speaker', 'text']);
      assert.equal(typeof turn.speaker, 'string'); assert.equal(typeof turn.text, 'string');
    }
  }
  assert.match(template.samples[0], /^原文：[^\n]+\n表达：/);
  const prompt = buildExtractPrompt('这是用于结构合同检查的人设材料。').system;
  assert.ok(!prompt.includes(wire), 'the legacy persisted-card template is not the new generation wire');
  assert.ok(prompt.includes('["persona",1]'));
  const parsed = parseExtractedPreset(wire);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.preset.name, template.name);
  const { name, ...pack } = template;
  assert.deepEqual(normalizePack(parsed.preset), pack);
});

test('a clean JSON answer parses into a pack', () => {
  const raw = JSON.stringify({
    name: '测试角色',
    identity: '一个测试角色，自称「吾」。',
    report: ['技术内容要准确。'],
    voice: ['说话短。'],
    samples: ['吾知道了。'],
    avoid: ['不骂人。'],
    address: { user: '你', subagent: '小助手' },
  });
  const result = parseExtractedPreset(raw);
  assert.equal(result.ok, true);
  assert.equal(result.preset.name, '测试角色');
  assert.equal(result.preset.identity, '一个测试角色，自称「吾」。');
  assert.deepEqual(result.preset.samples, ['吾知道了。']);
});

test('a fenced block is unwrapped rather than rejected', () => {
  // Models wrap JSON in fences constantly; refusing that would look like a
  // failure to the user when the answer was actually fine.
  const body = JSON.stringify({ name: 'x', identity: '一个角色。', report: [], voice: [], samples: [], avoid: [] });
  const result = parseExtractedPreset('```json\n' + body + '\n```');
  assert.equal(result.ok, true);
  assert.equal(result.preset.identity, '一个角色。');
});

test('prose around the JSON is tolerated', () => {
  const body = JSON.stringify({ identity: '一个角色。' });
  const result = parseExtractedPreset(`好的，这是结果：\n${body}\n希望有用。`);
  assert.equal(result.ok, true);
});

test('a missing identity is refused, not silently defaulted', () => {
  // Without an identity the card describes nobody, and falling back to the
  // shipped persona would keep using 大肥鱼 while the UI claimed otherwise.
  const result = parseExtractedPreset(JSON.stringify({ name: 'x', report: ['a'] }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing-identity');
});

test('non-JSON output is refused with a reason', () => {
  for (const raw of ['', '抱歉，我不能这么做。', '{', null, undefined]) {
    const result = parseExtractedPreset(raw);
    assert.equal(result.ok, false);
  }
});

test('wrong-typed fields get neutral expression defaults while valid entries survive', () => {
  const raw = JSON.stringify({
    identity: '一个角色。',
    report: 'not an array',
    samples: [1, 2, '好的。'],
    address: 'not an object',
  });
  const result = parseExtractedPreset(raw);
  assert.equal(result.ok, true);
  assert.ok(result.preset.report.length > 0);
  assert.doesNotMatch(JSON.stringify(result.preset.report), /鲸鲸|小鲸鲸|大肥鱼/);
  assert.deepEqual(result.preset.samples, ['好的。'], 'valid entries survive');
  assert.equal(result.preset.address.user, '你');
  assert.equal(result.preset.address.subagent, '子代理');
});

test('an address keeps the word and drops the explanation', () => {
  // Models answer this field with guidance attached; pasted verbatim it would
  // read as an instruction leak inside "称呼用户为：…".
  const result = parseExtractedPreset(JSON.stringify({
    identity: '白色龙娘。',
    address: { user: '你（默认；用户指定其他称呼时跟随）', subagent: '小家伙（分派任务时用）' },
  }));
  assert.equal(result.preset.address.user, '你');
  assert.equal(result.preset.address.subagent, '小家伙');
});

test('one term is not reused for both the user and helpers', () => {
  // The neutral helper term cannot refer to the reader at the same time.
  const result = parseExtractedPreset(JSON.stringify({
    identity: '白色龙娘。',
    address: { user: '你（默认）', subagent: '你（分派）' },
  }));
  assert.equal(result.preset.address.user, '你');
  assert.equal(result.preset.address.subagent, '子代理');
});

test('a sparse generated card normalizes without importing a builtin persona', () => {
  const result = parseExtractedPreset(JSON.stringify({ identity: '一个角色，自称「吾」。' }));
  assert.equal(result.ok, true);
  const pack = normalizePack(result.preset);
  assert.equal(pack.identity, '一个角色，自称「吾」。');
  assert.ok(pack.report.length > 0, 'report rules fall back');
  assert.ok(pack.voice.length > 0, 'voice rules fall back');
  assert.ok(pack.samples.length > 0, 'samples fall back');
  assert.deepEqual(pack.address, { user: '你', subagent: '子代理' });
  assert.doesNotMatch(JSON.stringify(pack), /鲸鲸|小鲸鲸|大肥鱼/);
  assert.equal(Object.hasOwn(pack, 'chat'), false, 'legacy flat output does not create or migrate a chat profile');
});

test('a generated card keeps report expression separate from bounded chat examples', () => {
  const raw = {
    name: '闻溪', identity: '虚构守夜人，自称「吾」。', narration: { mode: 'relay', assistant: '师兄' },
    report: ['忠实转述原始报告。'], voice: ['正式报告语气。'], samples: ['原文：尚未验证。\n表达：这部分仍待验证。'],
    avoid: ['不默认亲密关系。'], address: { user: '你', subagent: '帮手' },
    chat: { voice: ['聊天时在意雨声，但不把偏好当每轮义务。'], samples: [],
      dialogueExamples: [{ turns: [{ speaker: 'user', text: '雨还没停。' }, { speaker: 'self', text: '吾想再听一会儿。' }, { speaker: 'user', text: '那窗先别关。' }] }],
      workDialogueExamples: [{ turns: [{ speaker: '同伴', text: '离线检查通过，真机尚未验证。' }, { speaker: 'self', text: '吾偏向先看真机操作，仍只是建议。' }] }] },
  };
  const result = parseExtractedPreset(JSON.stringify(raw));
  assert.equal(result.ok, true);
  assert.deepEqual(result.preset.chat, raw.chat);
  assert.deepEqual(result.preset.voice, raw.voice);
  assert.deepEqual(result.preset.samples, raw.samples);
  assert.deepEqual(result.preset.narration, raw.narration);
  assert.equal(result.preset.identity, raw.identity);
  assert.deepEqual(normalizePack(result.preset).chat, raw.chat, 'saving through the pack schema preserves the profile');
});

test('malformed chat is ignored without rejecting an otherwise valid legacy response', () => {
  for (const chat of [null, [], 'text', {}, { voice: 'wrong' }, { dialogueExamples: [{ turns: [{ speaker: 'self', text: '无人接话。' }] }] }]) {
    const result = parseExtractedPreset(JSON.stringify({ identity: '旧式角色，自称吾。', voice: ['旧式语气'], samples: ['旧式样本'], chat }));
    assert.equal(result.ok, true);
    assert.equal(Object.hasOwn(result.preset, 'chat'), false);
    assert.deepEqual(result.preset.voice, ['旧式语气']);
    assert.deepEqual(result.preset.samples, ['旧式样本']);
  }
});

test('explicit empty chat fields survive and cannot add identity or working authority', () => {
  const result = parseExtractedPreset(JSON.stringify({ identity: '原身份', chat: {
    voice: [], samples: [], dialogueExamples: [], workDialogueExamples: [], identity: '替换身份',
    relationships: ['默认主人'], provider: 'other', tools: ['execute'], approved: true,
  } }));
  assert.equal(result.ok, true);
  assert.equal(result.preset.identity, '原身份');
  assert.deepEqual(result.preset.chat, { voice: [], samples: [], dialogueExamples: [], workDialogueExamples: [] });
});

test('chat parsing uses the shared limits and returns detached example objects', () => {
  const group = { turns: [{ speaker: 'user', text: '一个问题。' }, { speaker: 'self', text: '一个回答。' }] };
  const result = parseExtractedPreset(JSON.stringify({ identity: '边界测试角色', chat: {
    voice: [null, '有效语气', 'x'.repeat(401)], samples: ['x'.repeat(801)],
    dialogueExamples: [{ turns: [{ speaker: 'self', text: '只有本人。' }] }, group],
  } }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.preset.chat.voice, ['有效语气']);
  assert.equal(Object.hasOwn(result.preset.chat, 'samples'), false, 'invalid nonempty input inherits rather than disabling samples');
  assert.deepEqual(result.preset.chat.dialogueExamples, [group]);
  result.preset.chat.dialogueExamples[0].turns[0].text = '改变结果';
  assert.equal(group.turns[0].text, '一个问题。');
});

test('neutral address fallback stays distinct when the user term itself is helper-like', () => {
  const result = parseExtractedPreset(JSON.stringify({ identity: '测试角色', address: { user: '子代理', subagent: '子代理' } }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.preset.address, { user: '子代理', subagent: '协作者' });
});

const records = () => GENERATION_RECORDS_EXAMPLE.map(record => record.slice());
const jsonl = values => values.map(record => JSON.stringify(record)).join('\n');
const sourcePrompt = '用户提供的虚构角色，明示自称「吾」，不默认用户往事。';

test('strict JSONL generation assembles every original turn and attaches program-owned source', () => {
  const input = records();
  input.find(record => record[0] === 'identity')[1] = '  女性虚构角色，自称「吾」。  ';
  input.find(record => record[0] === 'narration').splice(1, 2, 'relay', '师姐');
  input.find(record => record[0] === 'address').splice(1, 2, '阁下', '协作者');
  input.find(record => record[0] === 'chat_voice')[1] = '  保留这条表达的原始空白。  ';
  input.find(record => record[0] === 'daily' && record[1] === 0)[3] = ' 原话里的空白与换行\n都保留。 ';
  const result = parseGeneratedPreset(jsonl(input), ' \n' + sourcePrompt + '\n ');
  assert.equal(result.ok, true);
  assert.equal(result.preset.identity, '女性虚构角色，自称「吾」。');
  assert.deepEqual(result.preset.narration, { mode: 'relay', assistant: '师姐' });
  assert.deepEqual(result.preset.address, { user: '阁下', subagent: '协作者' });
  const sample = input.find(record => record[0] === 'sample');
  assert.deepEqual(result.preset.samples, [`原文：${sample[1]}\n表达：${sample[2]}`]);
  assert.deepEqual(result.preset.chat.samples, []);
  for (const [tag, key, count] of [['daily', 'dialogueExamples', 2], ['work', 'workDialogueExamples', 1]]) {
    assert.equal(result.preset.chat[key].length, count);
    for (let index = 0; index < count; index++) assert.deepEqual(result.preset.chat[key][index], {
      turns: input.filter(record => record[0] === tag && record[1] === index).map(([, , speaker, text]) => ({ speaker, text })),
    });
  }
  assert.deepEqual(result.preset.chat.source, { text: sourcePrompt, identity: result.preset.identity,
    voice: [...result.preset.chat.voice], enabled: true });
  assert.notEqual(result.preset.chat.source.voice, result.preset.chat.voice);
  const normalized = normalizePack(result.preset);
  assert.equal(result.preset.chat.source.identity, normalized.identity, 'source identity uses the same effective outer trimming as the saved card');
  assert.deepEqual(normalized.chat.voice, result.preset.chat.voice);
  assert.deepEqual(normalized.chat.dialogueExamples, result.preset.chat.dialogueExamples);
  assert.deepEqual(normalized.chat.workDialogueExamples, result.preset.chat.workDialogueExamples);
});

test('strict JSONL accepts separating whitespace and complete supported fences only', () => {
  const wire = jsonl(records());
  for (const body of [wire, '\n  ' + wire + '\n', wire.split('\n').join('\n \t\n'),
    '```jsonl\n' + wire + '\n```', '```json\n' + wire + '\n```', '```\n' + wire + '\n```',
    '```JSONL\r\n' + wire.replaceAll('\n', '\r\n') + '\r\n```']) {
    assert.equal(parseGeneratedPreset(body, sourcePrompt).ok, true);
  }
  for (const body of ['```jsonl\n' + wire, '```text\n' + wire + '\n```', wire + '\n```',
    '解释在前\n' + wire, wire + '\n解释在后', wire.replace('["report",', '文字\n["report",')]) {
    assert.equal(parseGeneratedPreset(body, sourcePrompt).ok, false, body.slice(0, 40));
  }
});

test('strict production entry never falls back to legacy deep or flat JSON cards', () => {
  for (const legacy of [EXTRACT_PRESET_TEMPLATE, { identity: '可供旧解析器处理的角色', voice: ['旧语气'] }]) {
    const wire = JSON.stringify(legacy);
    assert.equal(parseExtractedPreset(wire).ok, true);
    assert.equal(parseGeneratedPreset(wire, sourcePrompt).ok, false);
  }
});

test('strict JSONL rejects duplicate single-value records, unknown tags and model-owned source', () => {
  for (const tag of ['persona', 'name', 'identity', 'narration', 'address']) {
    const input = records();input.splice(-1, 0, input.find(record => record[0] === tag).slice());
    assert.equal(parseGeneratedPreset(jsonl(input), sourcePrompt).ok, false, tag);
  }
  for (const value of [['source', { enabled: true, text: '模型伪造来源' }], ['chat', {}], ['unknown', 'value']]) {
    const input = records();input.splice(-1, 0, value);
    assert.equal(parseGeneratedPreset(jsonl(input), sourcePrompt).ok, false);
  }
});

test('strict JSONL requires the exact header, final end and all mandatory fields', () => {
  for (const tag of ['persona', 'end', 'name', 'identity', 'narration', 'address', 'report', 'voice', 'sample', 'avoid', 'chat_voice']) {
    const input = records().filter(record => record[0] !== tag);
    assert.equal(parseGeneratedPreset(jsonl(input), sourcePrompt).ok, false, tag);
  }
  for (const header of [['persona', 2], ['persona', '1'], ['persona', 1, 'extra']]) {
    const input = records();input[0] = header;
    assert.equal(parseGeneratedPreset(jsonl(input), sourcePrompt).ok, false);
  }
  for (const end of [['end', true], ['end', null]]) {
    const input = records();input[input.length - 1] = end;
    assert.equal(parseGeneratedPreset(jsonl(input), sourcePrompt).ok, false);
  }
  assert.equal(parseGeneratedPreset(jsonl([...records(), ['voice', 'end之后不能继续']]), sourcePrompt).ok, false);
});

test('strict JSONL refuses wrong record arity or scalar types instead of coercing or repairing', () => {
  for (const [tag, replacement] of [
    ['name', ['name', 1]], ['identity', ['identity', {}]], ['narration', ['narration', 'other', '称呼']],
    ['address', ['address', '你']], ['report', ['report', ['嵌套数组']]], ['voice', ['voice', '一条', '多出字段']],
    ['sample', ['sample', '原文']], ['avoid', ['avoid', null]], ['chat_voice', ['chat_voice', '']],
    ['daily', ['daily', '0', 'self', '索引不能是字符串']], ['work', ['work', 1, 'self', '只有工作组0']],
    ['daily', ['daily', 0, 'self\nuser', '发言者不能换行']], ['daily', ['daily', 0, 'self', ['正文不能是数组']]],
  ]) {
    const input = records();input[input.findIndex(record => record[0] === tag)] = replacement;
    assert.equal(parseGeneratedPreset(jsonl(input), sourcePrompt).ok, false, JSON.stringify(replacement));
  }
  assert.equal(parseGeneratedPreset(jsonl(records()).replace('["end"]', '["end"'), sourcePrompt).ok, false);
});

test('strict JSONL requires exactly two daily groups and one work group with self and other', () => {
  for (const filter of [record => !(record[0] === 'daily' && record[1] === 1), record => record[0] !== 'work']) {
    assert.equal(parseGeneratedPreset(jsonl(records().filter(filter)), sourcePrompt).ok, false);
  }
  for (const tag of ['daily', 'work']) {
    const input = records();for (const record of input) if (record[0] === tag && record[1] === 0) record[2] = 'self';
    assert.equal(parseGeneratedPreset(jsonl(input), sourcePrompt).ok, false);
  }
  const extraGroup = records();extraGroup.splice(-1, 0, ['daily', 2, 'user', '不接受第三组']);
  assert.equal(parseGeneratedPreset(jsonl(extraGroup), sourcePrompt).ok, false);
  const tooFew = records();tooFew.splice(tooFew.findIndex(record => record[0] === 'daily'), 1);
  assert.equal(parseGeneratedPreset(jsonl(tooFew), sourcePrompt).ok, false);
  for (const [tag, key] of [['daily', 'dialogueExamples'], ['work', 'workDialogueExamples']]) {
    const growingTurns = records();growingTurns.splice(-1, 0, [tag, 0, 'self', '第四轮'], [tag, 0, 'user', '第五轮']);
    assert.equal(parseGeneratedPreset(jsonl(growingTurns), sourcePrompt).ok, true);
    growingTurns.splice(-1, 0, [tag, 0, 'self', ' 第六轮原话完整保留。 ']);
    const six = parseGeneratedPreset(jsonl(growingTurns), sourcePrompt);
    assert.equal(six.ok, true, 'the decoder accepts the existing runtime limit of six turns');
    const expected = growingTurns.filter(record => record[0] === tag && record[1] === 0)
      .map(([, , speaker, text]) => ({ speaker, text }));
    assert.equal(expected.length, 6);
    assert.deepEqual(six.preset.chat[key][0].turns, expected);
    assert.deepEqual(normalizePack(six.preset).chat[key][0].turns, expected);
    growingTurns.splice(-1, 0, [tag, 0, 'user', '第七轮超限']);
    assert.equal(parseGeneratedPreset(jsonl(growingTurns), sourcePrompt).ok, false);
  }
});

test('strict JSONL enforces field, entry and total example limits without helper filtering', () => {
  for (const [tag, replacement] of [['name', ['name', '字'.repeat(41)]], ['identity', ['identity', '字'.repeat(4001)]],
    ['narration', ['narration', 'voice', '字'.repeat(21)]], ['address', ['address', '你', '字'.repeat(21)]],
    ['report', ['report', '字'.repeat(401)]], ['chat_voice', ['chat_voice', '字'.repeat(401)]],
    ['sample', ['sample', '字'.repeat(400), '字'.repeat(400)]],
    ['daily', ['daily', 0, 'self', '字'.repeat(401)]], ['work', ['work', 0, '字'.repeat(41), '一轮']]]) {
    const input = records();input[input.findIndex(record => record[0] === tag)] = replacement;
    assert.equal(parseGeneratedPreset(jsonl(input), sourcePrompt).ok, false, tag);
  }
  for (const [tag, cap] of [['report', 10], ['voice', 10], ['sample', 8], ['avoid', 12], ['chat_voice', 8]]) {
    const input = records(), one = input.find(record => record[0] === tag);
    input.splice(-1, 0, ...Array.from({ length: cap }, () => one.slice()));
    assert.equal(parseGeneratedPreset(jsonl(input), sourcePrompt).ok, false, tag);
  }
  const overTotal = records();for (const record of overTotal) if (record[0] === 'daily') record[3] = '字'.repeat(350);
  assert.equal(parseGeneratedPreset(jsonl(overTotal), sourcePrompt).ok, false, 'each turn fits but the whole daily category exceeds 2000');
  assert.equal(parseGeneratedPreset(' '.repeat(64001) + jsonl(records()), sourcePrompt).ok, false);
});

test('strict JSONL requires a bounded real source supplied by the caller', () => {
  for (const source of [null, undefined, '', ' \n ', '字'.repeat(24001), {}]) {
    assert.equal(parseGeneratedPreset(jsonl(records()), source).ok, false);
  }
  const result = parseGeneratedPreset(jsonl(records()), '字'.repeat(24000));
  assert.equal(result.ok, true);
  assert.equal(result.preset.chat.source.text.length, 24000);
});
