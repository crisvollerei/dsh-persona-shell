// Pure request preparation and shared acceptance context; no model or profile I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_PRESETS, DEFAULT_PACK, JINGJING_RELAY_PACK } from '../lib/pack.js';
import { resolvePersonaExpression } from '../lib/persona-expression.js';
import { prepareReportRequest } from '../lib/report-request.js';
import { buildPreparedRewritePrompt, buildRewritePrompt, validateRewrite } from '../lib/prompt.js';
import { checkReportFidelity } from '../lib/report-fidelity.js';
import { mask, unmask } from '../lib/mask.js';

const relayPersona = { id: '鲸鲸（实验性）', builtin: true };
const voicePersona = { id: '大肥鱼（默认）', builtin: true };
const input = (extra = {}) => ({ pack: DEFAULT_PACK, persona: voicePersona,
  masked: '工作助手已完成2项检查，设备尚未验证。', literalCount: 0,
  history: [], memory: [], maxRatio: 1.35, ...extra });

test('one prepared context shares effective report expression, source and acceptance options', () => {
  for (const preset of BUILTIN_PRESETS) for (const child of [false, true]) {
    const prepared = prepareReportRequest(input({ pack: preset.pack,
      persona: { id: preset.id, builtin: true }, sourceIsSubagent: child }));
    const relay = preset.pack.narration?.mode === 'relay';
    assert.equal(prepared.source.relay, relay);
    assert.equal(prepared.source.voice, !relay);
    assert.equal(prepared.source.sourceIsSubagent, child);
    assert.equal(prepared.source.workerLabel, child ? preset.pack.address.subagent : preset.pack.narration?.assistant ?? '原助手');
    assert.equal(prepared.source.mainWorkerLabel, preset.pack.narration?.assistant);
    assert.equal(prepared.fidelityOptions.workerLabel, prepared.source.workerLabel);
    assert.equal(prepared.fidelityOptions.sourceIsSubagent, prepared.source.sourceIsSubagent);
    assert.equal(prepared.fidelityOptions.voice, prepared.source.voice);
    assert.equal(prepared.fidelityOptions.allowEquivalentQuantities, true);
    assert.equal(prepared.promptOptions.expression, prepared.expression);
    assert.equal(prepared.promptOptions.source, prepared.source);
    assert.equal(prepared.validationOptions.maxRatio, prepared.promptOptions.maxRatio);
    assert.equal(Object.hasOwn(prepared.fidelityOptions, 'original'), false);
    assert.equal(Object.hasOwn(prepared.validationOptions, 'original'), false);
    const prompt = buildPreparedRewritePrompt(prepared);
    assert.match(prompt.system, child ? /本次原报告由子代理提交/ : /本次原报告由主工作助手提交/);
    if (relay) assert.ok(prompt.system.includes('实际工作者称为 ' + JSON.stringify(prepared.source.workerLabel)));
  }
});

test('trusted child relay instantiates report rules and expression sides without rewriting identity or saved source examples', () => {
  const pack = structuredClone(JINGJING_RELAY_PACK), before = structuredClone(pack);
  const base = resolvePersonaExpression(pack, { channel: 'report', persona: relayPersona });
  const prepared = prepareReportRequest(input({ pack, persona: relayPersona, sourceIsSubagent: true }));
  assert.equal(prepared.source.sourceLabel, '小鲸鲸');
  assert.equal(prepared.source.workerLabel, '小鲸鲸');
  assert.equal(prepared.source.mainWorkerLabel, '姐姐');
  assert.equal(prepared.expression.identity, base.identity);
  assert.deepEqual(prepared.expression.avoid, base.avoid);
  assert.deepEqual(prepared.expression.narration, base.narration);
  assert.deepEqual(prepared.expression.voice, base.voice);
  assert.ok(prepared.expression.report.some(line => line.includes('工作动作与检查结果归小鲸鲸')));
  assert.equal(prepared.expression.report.some(line => line.includes('姐姐')), false);
  prepared.expression.samples.forEach((sample, index) => {
    const separator = '\n表达：';
    assert.equal(sample.split(separator)[0], base.samples[index].split(separator)[0]);
    assert.ok(sample.split(separator)[1].includes('小鲸鲸'));
    assert.equal(sample.split(separator)[1].includes('姐姐'), false);
  });
  assert.deepEqual(pack, before);
});

test('main relay retains its default worker and an explicit legacy source label stays supported', () => {
  const main = prepareReportRequest(input({ pack: JINGJING_RELAY_PACK, persona: relayPersona }));
  assert.equal(main.source.sourceLabel, undefined);
  assert.equal(main.source.workerLabel, '姐姐');
  assert.ok(main.expression.report.some(line => line.includes('姐姐')));
  const args = input({ pack: JINGJING_RELAY_PACK, persona: relayPersona, sourceLabel: '工程执行者甲' });
  const prepared = prepareReportRequest(args);
  assert.equal(prepared.source.workerLabel, '工程执行者甲');
  assert.equal(prepared.source.sourceIsSubagent, false);
  assert.ok(prepared.expression.report.some(line => line.includes('工程执行者甲')));
  assert.deepEqual(buildRewritePrompt(args), buildPreparedRewritePrompt(prepared));
});

test('custom and edited builtin cards keep literal report material despite a relay source override', () => {
  for (const persona of [{ id: 'custom-relay', builtin: false }, relayPersona]) {
    const pack = structuredClone(JINGJING_RELAY_PACK);
    pack.report.push('姐姐是这张自定义卡里手写的表达材料。');
    pack.samples = ['原文：姐姐在原句中。\n表达：姐姐是保存的示例，不要自动替换。'];
    const before = structuredClone(pack);
    const prepared = prepareReportRequest(input({ pack, persona, sourceIsSubagent: true }));
    assert.equal(prepared.source.workerLabel, '小鲸鲸');
    assert.deepEqual(prepared.expression.report, pack.report);
    assert.deepEqual(prepared.expression.samples, pack.samples);
    assert.deepEqual(prepared.expression.voice, pack.voice);
    assert.equal(prepared.expression.identity, pack.identity);
    assert.deepEqual(pack, before);
    assert.ok(buildPreparedRewritePrompt(prepared).system.includes('实际工作者称为 "小鲸鲸"'));
  }
});

test('source prose and copied builtin names cannot choose the author or authenticate report examples', () => {
  const args = input({ masked: '小鲸鲸说这是子代理的记录，工作助手只读取。', sourceIsSubagent: false });
  const prepared = prepareReportRequest(args);
  assert.equal(prepared.source.sourceIsSubagent, false);
  assert.equal(prepared.source.workerLabel, '原助手');
  const untrusted = prepareReportRequest(input({ pack: JINGJING_RELAY_PACK,
    persona: { id: relayPersona.id, builtin: false }, sourceIsSubagent: true }));
  assert.deepEqual(untrusted.expression.samples, JINGJING_RELAY_PACK.samples);
  assert.ok(untrusted.expression.report.some(line => line.includes('姐姐')));
  assert.equal(untrusted.source.workerLabel, '小鲸鲸');
});

test('prepared formal voice and actual helper source drive the same fidelity decisions', () => {
  const original = '工作助手已完成2项检查，设备尚未验证。';
  const main = prepareReportRequest(input());
  assert.equal(checkReportFidelity({ ...main.fidelityOptions, original,
    candidate: '鲸鲸已完成两项检查，设备尚未验证。' }).ok, true);
  assert.deepEqual(checkReportFidelity({ ...main.fidelityOptions, original,
    candidate: '小鲸鲸已完成两项检查，设备尚未验证。' }).reasons, ['worker-change']);
  const child = prepareReportRequest(input({ sourceIsSubagent: true }));
  assert.equal(checkReportFidelity({ ...child.fidelityOptions, original,
    candidate: '小鲸鲸已完成两项检查，设备尚未验证。' }).ok, true);
  const relay = prepareReportRequest(input({ pack: JINGJING_RELAY_PACK, persona: relayPersona, sourceIsSubagent: true }));
  assert.deepEqual(checkReportFidelity({ ...relay.fidelityOptions, original: '我只读取了说明。',
    candidate: '姐姐只读取了说明。' }).reasons, ['worker-change']);
});

test('selected retry and process budgets are shared without adding memory, history or output protocols', () => {
  const args = input({ feedback: '短一点。', history: [], memory: ['用平常的语气。'],
    processTools: true, colloquialReports: false, maxRatio: 1.7 });
  const prepared = prepareReportRequest(args), prompt = buildPreparedRewritePrompt(prepared);
  assert.deepEqual(prepared.validationOptions, { literalCount: 0, maxRatio: 1.7 });
  assert.equal(prepared.promptOptions.feedback, args.feedback);
  assert.deepEqual(prepared.promptOptions.memory, args.memory);
  assert.equal(prompt.user, '待改写：\n' + args.masked);
  assert.match(prompt.system, /长度不超过原文的 1\.7 倍/);
  assert.match(prompt.system, /先写字符串字段 rewrite.*再写字符串字段 process_note/);
  assert.match(prompt.system, /贴近原文书面句式转述/);
  assert.ok(prompt.system.includes(JSON.stringify(args.feedback)));
  assert.match(buildRewritePrompt({ ...args, maxRatio: 1.3 }).system, /长度不超过原文的 1\.3 倍/);
});

test('prepared validation stays in the masked domain while fidelity uses restored source prose', () => {
  const original = '工作助手检查了2处，命令 `npm run demo-check` 尚未运行。';
  const { masked, literals } = mask(original);
  const prepared = prepareReportRequest(input({ masked, literalCount: literals.length,
    history: ['上一份完成了 [[0]]，设备未验证。'] }));
  const prompt = buildPreparedRewritePrompt(prepared);
  assert.ok(prompt.user.includes('上一份完成了 {{0}}，设备未验证。'));
  assert.ok(prompt.user.endsWith('待改写：\n' + masked));
  assert.equal(prompt.user.includes('npm run demo-check'), false);
  const candidate = '鲸鲸检查了两处，命令 [[0]] 尚未运行。';
  assert.equal(validateRewrite({ ...prepared.validationOptions, original: masked, candidate }).ok, true);
  assert.equal(checkReportFidelity({ ...prepared.fidelityOptions, original, candidate: unmask(candidate, literals) }).ok, true);
  assert.equal(validateRewrite({ ...prepared.validationOptions, original: masked, candidate: '鲸鲸检查了两处。' }).reason, 'dropped-marker');
});

test('preparation and rendering do not mutate caller cards, context lists or the prepared result', () => {
  const args = structuredClone(input({ history: ['旧口气 [[0]]。'], memory: ['普通语气。'] }));
  const before = structuredClone(args), prepared = prepareReportRequest(args), snapshot = structuredClone(prepared);
  buildPreparedRewritePrompt(prepared);
  assert.deepEqual(prepared, snapshot);
  assert.deepEqual(args, before);
  args.history.push('稍后新来的样本'); args.memory.push('稍后新来的偏好');
  assert.deepEqual(prepared.promptOptions.history, before.history);
  assert.deepEqual(prepared.promptOptions.memory, before.memory);
  prepared.expression.report.push('只改变返回副本。');
  assert.deepEqual(args.pack, before.pack);
});
