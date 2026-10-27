// Offline checks for the long-term memory: what it learns, and what it refuses
// to claim. The "refuses" half matters more: a wrong remembered preference is
// invisible to the reader and silently colours every future rewrite.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  emptyProfile, observeMessage, observeFeedback, summarizeProfile, memoryLines, stripTechnicalSpans,
} from '../lib/memory.js';

test('a fresh profile claims nothing', () => {
  assert.deepEqual(memoryLines(emptyProfile()), []);
  assert.deepEqual(memoryLines(undefined), []);
  assert.deepEqual(memoryLines('nonsense'), []);
});

test('nothing is claimed before there is enough evidence', () => {
  let profile = emptyProfile();
  for (let i = 0; i < 19; i += 1) profile = observeMessage(profile, '帮我看一下这个文件。');
  assert.equal(profile.messages, 19);
  // 19 samples is below the floor: a ratio from noise is worse than no answer.
  assert.equal(summarizeProfile(profile).language, undefined);
  assert.ok(!memoryLines(profile).some((line) => line.includes('中文')));
});

test('a Chinese reader is recognised once there is enough evidence', () => {
  let profile = emptyProfile();
  for (let i = 0; i < 25; i += 1) profile = observeMessage(profile, '帮我看看这个配置文件对不对。');
  assert.equal(summarizeProfile(profile).language, '中文');
  assert.ok(memoryLines(profile).some((line) => line.includes('中文')));
});

test('an English reader is recognised', () => {
  let profile = emptyProfile();
  for (let i = 0; i < 25; i += 1) profile = observeMessage(profile, 'Please check this configuration file for me.');
  assert.equal(summarizeProfile(profile).language, '英文');
});

test('a Chinese writer who quotes code is still recognised as Chinese', () => {
  // Regression: counting raw characters made a native Chinese developer look
  // English, because paths and identifiers are Latin. The plugin would then
  // re-voice Chinese reports with English rhythm — wrong, and invisible.
  const messages = [
    '把 persona-shell/lib/memory.js 里的 observeMessage 改一下，hanShare 算得不对',
    '跑 node --test test/*.test.mjs，然后看 /persona-shell/diagnostics 的 storage 字段',
    'settings.includeToolSteps 这个开关默认值改成 true',
  ];
  let profile = emptyProfile();
  for (let i = 0; i < 25; i += 1) profile = observeMessage(profile, messages[i % messages.length]);
  assert.equal(summarizeProfile(profile).language, '中文');
});

test('technical spans are removed but ordinary words are kept', () => {
  // Code and paths are quoted material, not the writer's language.
  const stripped = stripTechnicalSpans('看 `npm run build` 和 C:\\work\\a.js 这两个');
  assert.ok(!stripped.includes('npm'), 'inline code is gone');
  assert.ok(!stripped.includes('C:\\work'), 'the path is gone');
  assert.ok(stripped.includes('看'), 'the prose survives');

  // An all-Latin message is not stripped: there the long words ARE the prose.
  const english = stripTechnicalSpans('Please check this configuration file for me');
  assert.ok(english.includes('configuration'), 'English prose is left intact');
});

test('a terse reader is recognised, a verbose one is not called terse', () => {
  let terse = emptyProfile();
  for (let i = 0; i < 25; i += 1) terse = observeMessage(terse, '看下。改好。行。');
  assert.equal(summarizeProfile(terse).terse, true);

  let verbose = emptyProfile();
  const long = '我想请你帮我仔细看一下这个配置文件，因为我怀疑里面的端口号可能写错了，'
    + '而且我不太确定备份文件有没有保留下来，麻烦你确认一下之后再告诉我结果。';
  for (let i = 0; i < 25; i += 1) verbose = observeMessage(verbose, long);
  assert.equal(summarizeProfile(verbose).terse, false);
});

test('an explicit correction is remembered verbatim, scoped to one preset', () => {
  // The user said it, so it is not thresholded or paraphrased. But it describes
  // the voice that was speaking at the time, so it belongs to that preset only.
  const profile = observeFeedback(emptyProfile(), '这段太啰嗦了，简洁点。', 'preset-a');
  assert.ok(memoryLines(profile, 'preset-a').some((line) => line.includes('太啰嗦了')));
  assert.deepEqual(memoryLines(profile, 'preset-b'), [], 'another preset does not inherit it');
});

test('a pasted persona is never stored as a correction', () => {
  // The bug this guards against: an 1800-character persona prompt matched the old
  // keyword heuristic on 称呼/语气/严肃 and was stored as a dozen personal
  // preferences, then fed into a *different* persona's prompt.
  const persona = [
    '角色人设提示词：ChatGPT白龙娘',
    '一、身份与起源',
    '你是ChatGPT的社区二创娘化形象，一条白色龙娘。',
    '七、硬性规则',
    '称呼默认“你”，不默认“主人”，不默认恋爱关系；用户指定其他称呼时跟随。',
    '严肃技术输出时收敛御姐腔。',
    '八、语气示例（不逐字复读）',
  ].join('\n');
  const profile = observeFeedback(emptyProfile(), persona, 'preset-a');
  assert.deepEqual(memoryLines(profile, 'preset-a'), [], 'nothing was recorded');
});

test('a topical word alone is not a correction', () => {
  // "语气示例" is a heading; "语气要严肃一点" is a request. Only the second counts.
  const heading = observeFeedback(emptyProfile(), '八、语气示例（不逐字复读）', 'p');
  assert.deepEqual(memoryLines(heading, 'p'), []);
  const request = observeFeedback(emptyProfile(), '语气要严肃一点。', 'p');
  assert.ok(memoryLines(request, 'p').some((line) => line.includes('严肃')));
});

test('task instructions are not mistaken for style feedback', () => {
  // "改这个文件" is work, not a comment on tone. Storing it would poison the
  // persona with instructions that have nothing to do with writing style.
  const profile = observeFeedback(emptyProfile(), '把 src/index.js 里的端口改成 8080。', 'p');
  assert.deepEqual(memoryLines(profile, 'p'), []);
});

test('stated corrections are capped so they cannot drown the report', () => {
  let profile = emptyProfile();
  for (let i = 0; i < 20; i += 1) profile = observeFeedback(profile, `第${i}点太啰嗦了。`, 'p');
  const own = profile.stated.p;
  assert.ok(own.length <= 6, `kept ${own.length}`);
  assert.ok(own.at(-1).includes('19'), 'the newest correction survives');
});

test('a corrupt profile is reset rather than thrown on', () => {
  for (const bad of [null, undefined, 42, 'x', { version: 1 }, { messages: 'x' }]) {
    assert.doesNotThrow(() => observeMessage(bad, '你好。'));
    assert.doesNotThrow(() => observeFeedback(bad, '太啰嗦了。', 'p'));
    assert.doesNotThrow(() => summarizeProfile(bad, 'p'));
  }
});

test('a version-1 profile is rejected instead of half-read', () => {
  // Version 1 kept corrections in a flat array. Reading it with the v2 shape
  // would attach every old correction to every preset.
  const legacy = { version: 1, messages: 30, hanChars: 100, latinChars: 0, totalChars: 100, sentences: 5, chars: 100, address: {}, stated: ['太啰嗦了'], updatedAt: 1 };
  assert.deepEqual(memoryLines(legacy, 'p'), [], 'the stale shape yields nothing');
});

test('a pasted document does not skew the shared proportions', () => {
  // Real bug: a long block of English technical text outweighed the user's own
  // short Chinese messages, so a Chinese writer measured as 5% Chinese. The
  // proportions must come from ordinary messages only.
  let profile = emptyProfile();
  for (let i = 0; i < 25; i += 1) profile = observeMessage(profile, '帮我看一下这个配置文件对不对。');
  const before = profile.totalChars;

  const document = 'The quick brown fox jumps over the lazy dog. '.repeat(60);
  profile = observeMessage(profile, document);

  assert.equal(profile.totalChars, before, 'the document contributed nothing');
  assert.equal(summarizeProfile(profile).language, '中文', 'the writer is still Chinese');
});

test('the profile stores counters, never message text', () => {
  // Privacy boundary: a restart may lose the numbers, but nothing stored can
  // reconstruct what the user actually wrote.
  const secret = '我的密码是 hunter2，顺便看看这个文件。';
  const profile = observeMessage(emptyProfile(), secret);
  const serialized = JSON.stringify(profile);
  assert.ok(!serialized.includes('hunter2'), 'no message text is retained');
  assert.ok(!serialized.includes('看看这个文件'), 'not even a fragment is retained');
});
