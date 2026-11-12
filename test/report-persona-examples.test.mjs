// These checks protect the shipped demonstrations and their data boundary;
// they do not certify the meaning of arbitrary model-generated rewrites.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_PRESETS, normalizePack } from '../lib/pack.js';
import { resolvePersonaExpression } from '../lib/persona-expression.js';
import { mask, unmask } from '../lib/mask.js';
import { validateRewrite } from '../lib/prompt.js';

const reports = new Map(BUILTIN_PRESETS.map(preset => [preset.id,
  resolvePersonaExpression(normalizePack(preset.pack), { channel: 'report', persona: { id: preset.id, builtin: true } })]));
const split = sample => {
  const match = /^原文：([^\n]+)\n表达：([^\n]+)$/u.exec(sample);
  assert.ok(match, 'each demonstration keeps its original and expression explicitly separate');
  return { original: match[1], expression: match[2] };
};
const pairs = [...reports.values()].flatMap(profile => profile.samples.map(split));
const sorted = values => [...values].sort();

test('all builtin report demonstrations remain bounded examples rather than new chat dialogue', () => {
  assert.equal(reports.size, 5);
  assert.equal(pairs.length, 15);
  assert.equal(new Set(pairs.map(pair => pair.original)).size, 15);
  assert.equal(new Set(pairs.map(pair => pair.expression)).size, 15);
  for (const { original, expression } of pairs) {
    assert.ok(expression.length <= original.length * 1.3, 'ordinary report examples fit the ordinary expansion budget');
    assert.doesNotMatch(expression, /[（(].*[）)]|抱抱|摸摸|尾巴|喵[。！!]|先报到这里|放心交给|你觉得呢/u);
    assert.doesNotMatch(expression, /我(?:已经)?(?:检查|读取|修改|测试)|我更倾向|猫猫偏向/u,
      'examples do not add a new investigation or personal recommendation absent from the report');
  }
});

test('readable examples conserve every numeric value and protected technical literal', () => {
  for (const { original, expression } of pairs) {
    assert.deepEqual(sorted(expression.match(/\d+(?:\.\d+)?/gu) ?? []), sorted(original.match(/\d+(?:\.\d+)?/gu) ?? []));
    const shield = mask(original), candidate = mask(expression);
    assert.deepEqual(sorted(candidate.literals), sorted(shield.literals));
    const checked = validateRewrite({ candidate: candidate.masked, original: shield.masked, literalCount: shield.literals.length, maxRatio: 1.3 });
    assert.equal(checked.ok, true);
    assert.equal(unmask(candidate.masked, candidate.literals), expression);
  }
});

test('examples preserve unverified, failed and conditional results alongside completed work', () => {
  const whale = reports.get('大肥鱼（默认）').samples.map(split);
  assert.match(whale[0].expression, /本地.*2处配置.*改好.*离线检查.*过了.*客户端.*还没.*代码.*还没推送/u);
  assert.match(whale[1].expression, /缓存.*刷新.*重新运行还是(?:失败|没成功).*原因.*没查清.*原文件.*没有改动/u);
  assert.match(whale[2].expression, /鲸鲸.*只核对.*版本号.*图片还没打开/u);
  assert.match(whale[2].expression, /小鲸鲸.*3张缩略图.*第3张被裁切.*其余2张完整.*原因还没复核.*还没修复/u);

  const dragon = reports.get('大肥龙').samples.map(split);
  assert.match(dragon[0].expression, /原来的操作方式.*照常保留.*6项离线检查.*移动端.*没验证.*发布前/u);
  assert.match(dragon[1].expression, /建议优先做根本修复.*还没有执行/u);
  assert.match(dragon[1].expression, /临时绕过.*不用动存储结构.*根本修复.*迁移.*耗时.*更长/u);
  assert.match(dragon[2].expression, /恢复命令运行失败.*生效.*旧配置.*原因还定位不了.*日志不够.*只有补齐日志.*并且得到你的确认.*才可以重试/u);

  const claude = reports.get('Claude小姐').samples.map(split);
  assert.match(claude[0].expression, /状态被覆盖.*修复.*3项回归测试全部通过.*客户端.*没有验证/u);
  assert.match(claude[1].expression, /日志能确认.*请求.*送到.*接收端.*成功.*不能确定.*没有读取.*代码/u);
  assert.match(claude[2].expression, /只讨论.*2种.*没有读代码.*没有执行修改.*性能.*没有数据.*不推荐.*任何一种/u);
});

test('relay samples retain the actual worker, check outcomes and user confirmation boundary', () => {
  const relay = reports.get('鲸鲸（实验性）');
  assert.equal(relay.narration.mode, 'relay');
  for (const pair of relay.samples.map(split)) {
    assert.match(pair.original, /^工作助手/u);
    assert.match(pair.expression, /^姐姐/u);
    assert.doesNotMatch(pair.expression, /小肥鱼(?:已经)?(?:修|改|测)|姐姐说|姐姐问/u);
  }
  const samples = relay.samples.map(split);
  assert.match(samples[0].expression, /先恢复旧设置.*再应用.*操作.*重启.*还没验证/u);
  assert.match(samples[1].expression, /3项检查.*2项通过.*1项缺环境.*跳过.*还没有.*检查结果/u);
  assert.match(samples[2].expression, /建议.*保留原文件.*副本.*目录.*等你确认.*确认之前.*不会生成/u);
});

test('Gemini examples make comparison and supported scope explicit without extending the recommendation', () => {
  const samples = reports.get('Gemini').samples.map(split);
  assert.match(samples[0].expression, /显示.*一样.*方案一不需要额外依赖.*方案二.*`render-kit`.*建议用方案一.*性能.*没有比较/u);
  assert.match(samples[1].expression, /长段落.*按需展开.*原文.*顺序保持不变.*文本报告.*图片报告.*不支持/u);
  assert.match(samples[2].expression, /预览.*正常.*导出后的字体.*没有验证.*超时.*没能完成.*原因.*不清楚.*原文件.*没有修改/u);
});

test('report examples stay out of builtin chat material and cannot rewrite a custom card', () => {
  for (const preset of BUILTIN_PRESETS) {
    const pack = normalizePack(preset.pack), before = structuredClone(pack), persona = { id: preset.id, builtin: true };
    const chat = resolvePersonaExpression(pack, { channel: 'chat', persona });
    const chatText = JSON.stringify(chat);
    for (const sample of reports.get(preset.id).samples) assert.equal(chatText.includes(sample), false);
    const custom = resolvePersonaExpression(pack, { channel: 'report', persona: { id: preset.id, builtin: false } });
    assert.deepEqual(custom.samples, pack.samples);
    assert.deepEqual(custom.voice, pack.voice);
    assert.deepEqual(pack, before);
  }
});
