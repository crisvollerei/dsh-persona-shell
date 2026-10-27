// Offline checks for persona presets: the extraction contract and the parser
// that has to survive whatever a model actually returns.
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildExtractPrompt, parseExtractedPreset, PRESET_FIELDS } from '../lib/preset.js';
import { normalizePack } from '../lib/pack.js';

test('the extraction prompt asks for translation, not a summary', () => {
  // A summary of a chat persona prompt is appearance and lore, which a rewrite
  // cannot use. The prompt has to say what to throw away.
  const { system, user } = buildExtractPrompt('你是某个角色，有蓝色头发，说话很活泼。');
  assert.ok(system.includes('丢掉'), 'it names the fields to drop');
  assert.ok(system.includes('外貌'), 'appearance is explicitly dropped');
  assert.ok(system.includes('第一人称'), 'self-reference is called out as the key signal');
  assert.ok(system.includes('汇报'), 'it distinguishes the report context');
  for (const field of PRESET_FIELDS) {
    assert.ok(system.includes(field.key), `${field.key} is requested`);
  }
  assert.ok(user.includes('蓝色头发'), 'the persona prompt travels verbatim');
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

test('wrong-typed fields are dropped instead of breaking the pack', () => {
  const raw = JSON.stringify({
    identity: '一个角色。',
    report: 'not an array',
    samples: [1, 2, '好的。'],
    address: 'not an object',
  });
  const result = parseExtractedPreset(raw);
  assert.equal(result.ok, true);
  assert.deepEqual(result.preset.report, []);
  assert.deepEqual(result.preset.samples, ['好的。'], 'valid entries survive');
  assert.equal(result.preset.address.user, undefined);
  assert.equal(result.preset.address.subagent, undefined);
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
  // "你" cannot name the reader and their subagents at once; the helper falls
  // back to the default rather than making every sentence ambiguous.
  const result = parseExtractedPreset(JSON.stringify({
    identity: '白色龙娘。',
    address: { user: '你（默认）', subagent: '你（分派）' },
  }));
  assert.equal(result.preset.address.user, '你');
  assert.equal(result.preset.address.subagent, undefined);
});

test('a parsed preset normalizes into a complete pack', () => {
  // The generator returns a partial card; the defaults fill the gaps so no
  // prompt section is ever empty.
  const result = parseExtractedPreset(JSON.stringify({ identity: '一个角色，自称「吾」。' }));
  assert.equal(result.ok, true);
  const pack = normalizePack(result.preset);
  assert.equal(pack.identity, '一个角色，自称「吾」。');
  assert.ok(pack.report.length > 0, 'report rules fall back');
  assert.ok(pack.voice.length > 0, 'voice rules fall back');
  assert.ok(pack.samples.length > 0, 'samples fall back');
  assert.equal(pack.address.user.length > 0, true);
});
