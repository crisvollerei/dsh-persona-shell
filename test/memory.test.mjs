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

test('an explicit correction is remembered verbatim', () => {
  // The user said it, so it is not thresholded, not paraphrased, and not
  // inferred: it travels into the prompt exactly as written.
  const profile = observeFeedback(emptyProfile(), '这段太啰嗦了，简洁点。');
  const lines = memoryLines(profile);
  assert.ok(lines.some((line) => line.includes('太啰嗦了')), 'the words are kept as given');
});

test('task instructions are not mistaken for style feedback', () => {
  // "改这个文件" is work, not a comment on tone. Storing it would poison the
  // persona with instructions that have nothing to do with writing style.
  const profile = observeFeedback(emptyProfile(), '把 src/index.js 里的端口改成 8080。');
  assert.deepEqual(memoryLines(profile), []);
});

test('stated corrections are capped so they cannot drown the report', () => {
  let profile = emptyProfile();
  for (let i = 0; i < 20; i += 1) profile = observeFeedback(profile, `第${i}点太啰嗦了。`);
  assert.ok(profile.stated.length <= 8, `kept ${profile.stated.length}`);
  assert.ok(profile.stated.at(-1).includes('19'), 'the newest correction survives');
});

test('a corrupt profile is reset rather than thrown on', () => {
  for (const bad of [null, undefined, 42, 'x', { version: 1 }, { messages: 'x' }]) {
    assert.doesNotThrow(() => observeMessage(bad, '你好。'));
    assert.doesNotThrow(() => observeFeedback(bad, '太啰嗦了。'));
    assert.doesNotThrow(() => summarizeProfile(bad));
  }
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
