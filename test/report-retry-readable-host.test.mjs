// Real Host integration with controlled model streams; these are boundary and
// lifecycle checks, not a semantic quality evaluation of model-generated prose.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../lib/config.js';
import { mask } from '../lib/mask.js';
import { fixture, flush } from './helpers/persona-chat-host.mjs';

const output = (text, finish = 'stop') => (async function* () {
  const split = Math.floor(text.length / 2);
  yield { type: 'text-delta', text: text.slice(0, split) };
  yield { type: 'text-delta', text: text.slice(split) };
  if (finish !== null) yield { type: 'finish', reason: { kind: finish } };
})();
const event = (f, sessionId, seq, type, data, header = {}) => f.bus.emit('session/event', {
  id: sessionId, header, append() { assert.fail('the expression layer cannot write working history'); },
}, { seq, type, data });
const report = (f, text, { sessionId = 'report-readable', seq = 10, header } = {}) => {
  event(f, sessionId, seq, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text }] } }, header);
};
const state = async (f, sessionId = 'report-readable') => (await f.request('state?session=' + encodeURIComponent(sessionId))).value;
const retry = async (f, row, content = '把省略的句子讲清楚，保留未验证项和发布条件。', sessionId = 'report-readable') =>
  f.request('feedback', { sessionId, seq: row.seq, version: row.version, personaId: row.speaker.id, scope: 'once', content });
const choose = async (f, personaId, sessionId = 'report-readable') => {
  const before = (await f.request('conversation?session=' + encodeURIComponent(sessionId))).value;
  const result = await f.request('conversation', { action: 'select', sessionId, revision: before.revision, personaId, trigger: 'inherit' });
  assert.equal(result.status, 200);
};
const callText = call => call.messages[0].content[0].text;

const compact = Array.from({ length: 16 }, (_, index) =>
  `检查项${index + 1}：本地调整完成；离线验证通过；客户端验证未进行。仅适用于测试环境，正式环境仍需确认。`).join('\n\n')
  + '\n\n发布前仅在你确认后工作助手才可运行 `npm run verify`，失败时必须停止，暂不推送。';
const expanded = Array.from({ length: 16 }, (_, index) =>
  `检查项${index + 1}的本地调整已经完成，离线验证也已经通过。不过，这项检查还没有在客户端里做过验证。目前这份结果只适用于测试环境，正式环境的情况仍然需要确认。`).join('\n\n')
  + '\n\n发布之前，只有你确认了，工作助手才可以运行 [[0]]。如果运行失败，就必须停止。这次暂时不推送。';

test('Host uses its configured automatic ceiling and allows bounded sentence expansion only for explicit restatement', async t => {
  const f = fixture(t, { config: { maxRatio: 1.3 }, script: () => output(expanded) });
  await f.ready();
  const shielded = mask(compact);
  assert.equal(shielded.literals.length, 1);
  const ratio = expanded.length / shielded.masked.length;
  assert.ok(ratio > 1.4 && ratio < 1.6, 'the long controlled response exercises a real ceiling difference');
  assert.ok(expanded.length > shielded.masked.length + 200, 'the short-source tolerance cannot explain acceptance');
  report(f, compact);
  event(f, 'report-readable', 11, 'turn/end', { reason: { kind: 'completed' } });
  await flush();
  const initial = (await state(f)).rows[0];
  assert.equal(initial.status, 'skipped');
  assert.equal(initial.reason, 'too-long');
  assert.equal(initial.canRetry, true);
  assert.match(f.calls[0].system, /长度不超过原文的 1\.3 倍/);
  const result = await retry(f, initial);
  assert.equal(result.status, 200);
  const after = (await state(f)).rows[0];
  assert.equal(after.status, 'ready');
  assert.equal(after.version, initial.version + 1);
  assert.equal(after.text, expanded.replace('[[0]]', '`npm run verify`'));
  assert.equal(after.final, true);
  assert.match(f.calls[1].system, /长度不超过原文的 1\.7 倍/);
  assert.match(f.calls[1].system, /省略主语的谓宾片段/);
  assert.equal(callText(f.calls[0]), callText(f.calls[1]), 'both calls receive the same masked original');
  assert.equal((await f.request('memory')).value.entries.length, 0);
  await f.dispose();
  const saved = f.storage.tables.get('sessions').get('report-readable')[0];
  assert.equal(saved.original, compact);
  assert.equal(saved.text, after.text);
});

test('the default Host prompt advertises the actual configured ceiling rather than a stale hard-coded limit', async t => {
  const f = fixture(t, { script: () => output('本地已经改好，客户端还没验证。') });
  await f.ready();
  report(f, '本地修改完成，客户端验证未进行。');
  await flush();
  assert.ok(f.calls[0].system.includes(`长度不超过原文的 ${DEFAULTS.maxRatio} 倍`));
  assert.equal((await state(f)).rows[0].status, 'ready');
});

test('successive one-off readability requests keep using the original, leave memory untouched and do not become later preferences', async t => {
  const text = '配置检查完成，客户端验证未进行。只有你确认后才可运行 `npm run verify`，暂不推送。';
  const f = fixture(t, { script: (_, n) => output(n === 1
    ? '已有可用稿的专属字样：配置已检查，客户端未验证。确认后才可运行 [[0]]，暂不推送。'
    : n === 2 ? '第二稿特有字样：配置已经检查过，客户端还没有验证。只有你确认后，才可以运行 [[0]]；暂不推送。'
      : '配置已经检查，客户端还没验证。只有你确认后才可运行 [[0]]，暂不推送。') });
  await f.ready(); report(f, text); await flush();
  const first = (await state(f)).rows[0];
  assert.equal((await retry(f, first, '这次用完整句子，表达更正式一点。')).status, 200);
  const second = (await state(f)).rows[0];
  assert.equal((await retry(f, second, '这次把验证状态分开讲清楚。')).status, 200);
  const third = (await state(f)).rows[0];
  assert.equal(third.version, first.version + 2);
  const originalWire = '待改写：\n' + mask(text).masked;
  for (const call of f.calls.slice(1)) {
    assert.equal(callText(call), originalWire);
    assert.doesNotMatch(callText(call), /已有可用稿的专属字样|第二稿特有字样/);
  }
  assert.match(f.calls[1].system, /这次用完整句子，表达更正式一点/);
  assert.match(f.calls[2].system, /这次把验证状态分开讲清楚/);
  assert.doesNotMatch(f.calls[2].system, /这次用完整句子，表达更正式一点/);
  assert.equal((await f.request('memory')).value.entries.length, 0);
  report(f, text, { seq: 12 }); await flush();
  assert.doesNotMatch(f.calls[3].system, /这次用完整句子，表达更正式一点|这次把验证状态分开讲清楚|重新转述还要处理/);
  await f.dispose();
  const saved = f.storage.tables.get('sessions').get('report-readable').find(row => row.seq === 10);
  assert.equal(saved.original, text);
  assert.equal(saved.text, third.text);
});

for (const failure of ['dropped-marker', 'max-tokens', 'missing-finish', 'provider-error']) {
  test(`a ${failure} readability retry retains the usable report, original, signature and version`, async t => {
    const text = '配置仅在本地改好，客户端尚未验证。只有你确认后才运行 `npm run verify`，暂不推送。';
    const old = '本地配置已改好，客户端还没验证。只有你确认后，才运行 [[0]]；暂不推送。';
    const f = fixture(t, { script: (_, n) => {
      if (n === 1) return output(old);
      if (failure === 'provider-error') return (async function* () { yield { type: 'text-delta', text: '不能采用的半截新稿' }; throw Error('provider-unavailable'); })();
      if (failure === 'dropped-marker') return output('这份失败的新稿没有保留命令占位符。');
      return output('不能采用的半截新稿 [[0]]', failure === 'missing-finish' ? null : 'max-tokens');
    } });
    await f.ready(); report(f, text); await flush();
    const before = (await state(f)).rows[0];
    assert.equal(before.status, 'ready');
    assert.equal((await retry(f, before)).status, 422);
    const after = (await state(f)).rows[0];
    for (const key of ['text', 'version', 'status', 'reason']) assert.equal(after[key], before[key]);
    assert.deepEqual(after.speaker, before.speaker);
    assert.equal(after.partial, '');
    assert.equal(after.retrying, false);
    assert.equal(after.canRetry, true);
    assert.match(after.feedbackError, /保留原来的汇报/);
    assert.equal((await f.request('memory')).value.entries.length, 0);
    await f.dispose();
    const saved = f.storage.tables.get('sessions').get('report-readable')[0];
    assert.equal(saved.original, text);
    assert.equal(saved.text, before.text);
    assert.equal(saved.version, before.version);
  });
}

test('readability retries of historical relay reports preserve main-worker versus subagent attribution and persona isolation', async t => {
  const f = fixture(t, { config: { subagentReports: true }, script: options => {
    const worker = options.system.includes('实际工作者称为 "小鲸鲸"') ? '小鲸鲸' : '姐姐';
    return output(`${worker}的检查已完成，只有确认后才运行 [[0]]，暂不推送。`);
  } });
  await f.ready();
  await choose(f, '鲸鲸（实验性）');
  const main = '工作助手的检查已完成，只有确认后才运行 `npm run main-check`，暂不推送。';
  const subagent = '子代理的检查已完成，只有确认后才运行 `npm run child-check`，暂不推送。';
  report(f, main); await flush();
  report(f, subagent, { seq: 12, header: { delegationDepth: 1, origin: 'subagent' } }); await flush();
  const before = (await state(f)).rows;
  assert.equal(before.length, 2);
  assert.equal(before.every(row => row.speaker.mode === 'relay'), true);
  await choose(f, 'Claude小姐');
  assert.equal((await f.request('memory', { action: 'add', entry: {
    kind: 'preference', scope: 'persona', personaId: 'Claude小姐', content: '小克专属只给当前人格的措辞要求',
  } })).status, 200);
  for (const row of before) assert.equal((await retry(f, row)).status, 200);
  assert.match(f.calls[2].system, /实际工作者称为 "姐姐"/);
  assert.match(f.calls[3].system, /实际工作者称为 "小鲸鲸"/);
  for (const call of f.calls.slice(2)) {
    assert.match(call.system, /不得把他人的工作认领为自己的成果/);
    assert.doesNotMatch(call.system, /小克专属只给当前人格的措辞要求/);
  }
  assert.equal(callText(f.calls[2]), '待改写：\n' + mask(main).masked);
  assert.equal(callText(f.calls[3]), '待改写：\n' + mask(subagent).masked);
  const after = (await state(f)).rows;
  for (let i = 0; i < after.length; i++) {
    assert.deepEqual(after[i].speaker, before[i].speaker);
    assert.equal(after[i].version, before[i].version + 1);
  }
  assert.equal((await f.request('conversation?session=report-readable')).value.effectivePersonaId, 'Claude小姐');
  assert.equal((await f.request('memory')).value.entries.length, 1, 'only the explicit persona preference was saved');
  await f.dispose();
  const saved = f.storage.tables.get('sessions').get('report-readable');
  assert.equal(saved[0].original, main);
  assert.equal(saved[1].original, subagent);
});
