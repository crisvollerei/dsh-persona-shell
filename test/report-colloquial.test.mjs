// Prompt/data-boundary regressions. These checks do not establish model semantic fidelity.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRewritePrompt, validateRewrite } from '../lib/prompt.js';
import { mask, markers, unmask } from '../lib/mask.js';
import { Config, DEFAULTS, resolveConfig } from '../lib/config.js';

const pack = {
  identity: '语气克制的角色甲', report: ['完整转述工程事实。'], voice: ['直接、自然，不卖萌。'],
  samples: ['保持当前角色的语气。'], avoid: ['不虚构经历。'], address: { user: '你', subagent: '助手' },
  narration: { mode: 'voice', assistant: '工作助手' },
};
const source = '# 本轮核对\n\n已按原始日志核对 3 项检查；其中 1 项未验证。仅限本地测试环境，不代表已部署。\n\n- 只有你确认后，才会执行 `npm run verify`。\n- 配置仍在 `./config/settings.json`，下一步由你核对，暂不推送。';
const shielded = mask(source);
const input = { pack, masked: shielded.masked, literalCount: shielded.literals.length, history: [] };
const expressionSection = system => system.split(/## (?:用自然口语讲清同一份汇报|贴近原文书面句式转述)\n/u)[1]?.split(/\n## /u)[0];

test('report phrasing defaults to colloquial while explicit false survives configuration resolution', () => {
  assert.equal(DEFAULTS.colloquialReports, true);
  const baseline = resolveConfig({});
  assert.deepEqual(resolveConfig({ colloquialReports: false }), { ...baseline, colloquialReports: false });
  assert.equal(Config['~standard'].validate({ colloquialReports: false }).value.colloquialReports, false);
  for (const value of ['false', 0, 1, null, {}, [], undefined])
    assert.deepEqual(resolveConfig({ colloquialReports: value }), baseline, 'mistyped preferences cannot silently disable natural phrasing');
  assert.deepEqual(buildRewritePrompt(input), buildRewritePrompt({ ...input, colloquialReports: true }));
});

test('turning colloquial phrasing off preserves the persona, full source and common factual boundaries', () => {
  const off = buildRewritePrompt({ ...input, colloquialReports: false }), on = buildRewritePrompt({ ...input, colloquialReports: true });
  assert.equal(off.user, on.user); assert.equal(off.user, '待改写：\n' + shielded.masked);
  assert.ok(off.system.includes(pack.identity)); assert.ok(off.system.includes(pack.voice[0])); assert.ok(off.system.includes(pack.samples[0]));
  assert.match(off.system, /尽量贴近原文的书面句式和表达节奏/);
  assert.match(off.system, /仍保留人格措辞，不是停用改写或直接显示原文/);
  assert.doesNotMatch(off.system, /本次开启口语化|书面：|口语：|只是虚构的同义表达练习/);
  for (const result of [on, off]) {
    const section = expressionSection(result.system);
    assert.match(section, /优先于角色卡或历史语气样例中一般性的句式建议/);
    assert.match(result.system, /技术术语保留原名/);
    assert.match(result.system, /保留数量、否定、范围、适用条件、风险、证据来源和不确定程度/);
    assert.match(result.system, /谁做的、做到哪一步、接下来由谁确认或执行/);
    assert.match(result.system, /原样各保留一次，仍与对应事实、步骤和条件相连/);
    assert.match(result.system, /保留操作步骤的顺序、列表符号和标题层级/);
    assert.match(result.system, /普通说明段落可适当拆分、合并或前后调整/);
    assert.match(result.system, /结论与其适用条件、风险和证据相邻对应/);
    assert.match(result.system, /信息量必须持平/);
  }
});

test('ordinary report phrasing changes only the instructions, never the supplied source or card', () => {
  const originalInput = structuredClone(input), result = buildRewritePrompt(input);
  assert.deepEqual(input, originalInput);
  assert.equal(result.user, '待改写：\n' + shielded.masked);
  assert.equal(unmask(result.user.slice('待改写：\n'.length), shielded.literals), source);
  assert.deepEqual(markers(result.user), markers(shielded.masked));
  assert.ok(result.system.includes(pack.identity)); assert.ok(result.system.includes(pack.report[0])); assert.ok(result.system.includes(pack.voice[0]));
  const section = expressionSection(result.system);
  assert.match(section, /在当前人格的语气内/); assert.match(section, /拆开长句、名词堆叠和被动句/);
  assert.match(result.system, /技术术语保留原名/); assert.match(result.system, /谁做的、做到哪一步、接下来由谁确认或执行/);
  assert.match(section, /不额外编造调侃情节、庆祝成功或催休息/);
  assert.doesNotMatch(section, /鲸鲸|Claude|GPT|姐姐说/u, 'the general expression policy does not replace the chosen persona or worker');
  assert.match(result.system, /保留操作步骤的顺序、列表符号和标题层级/);
});

test('the three expression demonstrations retain their qualifiers and remain outside the report data', () => {
  const result = buildRewritePrompt(input), section = expressionSection(result.system);
  assert.match(section, /示例中的操作、数量、验证状态和用户确认都不是本轮事实/);
  const pairs = [...section.matchAll(/^书面：([^\n]+)\n口语：([^\n]+)$/gmu)].map(match => ({ before: match[1], after: match[2] }));
  assert.equal(pairs.length, 3);
  assert.match(pairs[0].before, /尚未.*真实环境.*验证/); assert.match(pairs[0].after, /真实环境.*还没验证/);
  assert.match(pairs[1].before, /仅在用户确认后才会执行/); assert.match(pairs[1].after, /只有你确认了才会做/);
  for (const form of [pairs[2].before, pairs[2].after]) {
    assert.match(form, /只|仅/); assert.match(form, /本地/); assert.match(form, /2处配置/); assert.match(form, /尚未推送|还没推送/);
  }
  for (const pair of pairs) for (const sentence of [pair.before, pair.after]) assert.equal(result.user.includes(sentence), false);
  assert.match(result.user, /3 项检查；其中 1 项未验证/); assert.match(result.user, /仅限本地测试环境，不代表已部署/);
});

test('natural word order keeps the same literal contract and cannot bypass its validation', () => {
  const original = '仅在你确认后，才会运行 `npm run verify`。配置位置是 `./config/settings.json`，已修改 2 处，但还未推送。';
  const { masked, literals } = mask(original);
  assert.equal(literals.length, 2);
  const spoken = '只有你确认后，才会运行 [[0]]。[[1]] 是配置的位置，已改 2 处，还没推送。';
  const prompt = buildRewritePrompt({ pack, masked, literalCount: literals.length, history: [] });
  assert.equal(prompt.user, '待改写：\n' + masked);
  assert.match(prompt.system, /原样各保留一次，仍与对应事实、步骤和条件相连/);
  const check = candidate => validateRewrite({ candidate, original: masked, literalCount: literals.length, maxRatio: 1.3 });
  assert.equal(check(spoken).ok, true, 'moving an intact marker within its factual sentence is already compatible with the validator');
  assert.equal(unmask(spoken, literals), '只有你确认后，才会运行 `npm run verify`。`./config/settings.json` 是配置的位置，已改 2 处，还没推送。');
  assert.equal(check(spoken.replace('[[1]]', '')).reason, 'dropped-marker');
  assert.equal(check(spoken + ' [[0]]').reason, 'duplicate-marker');
  assert.equal(check(spoken + '\n```sh\nnew-command\n```').reason, 'invented-fence');
  assert.equal(check(spoken + '补充'.repeat(300)).reason, 'too-long');
});

test('one-off feedback and process observations keep their distinct structural and output contracts', () => {
  for (const colloquialReports of [false, true]) for (const processTools of [false, true]) for (const once of [false, true]) {
    const feedback = (colloquialReports ? '这次正式一些' : '这次像聊天一样自然一点') + '，但保留限制、未验证项和下一步。';
    const result = buildRewritePrompt({ ...input, colloquialReports, processTools, ...(once ? { feedback } : {}) });
    assert.equal(result.user, '待改写：\n' + shielded.masked);
    assert.match(result.system, /不得删除原文中的风险提示、适用条件或不确定性说明/);
    assert.match(result.system, /长度不超过原文的 1\.3 倍/);
    if (once) {
      assert.ok(result.system.includes(JSON.stringify(feedback)));
      assert.ok(result.system.indexOf('## 用户对这一次表达的调整') > result.system.indexOf(colloquialReports ? '## 用自然口语讲清同一份汇报' : '## 贴近原文书面句式转述'));
      assert.match(result.system, /本次明确的措辞调整优先于全局口语化或书面句式偏好/);
      assert.match(result.system, /不删事实、验证结果、风险、条件或下一步/);
      assert.match(result.system, /可按本次表达要求调整段落先后/);
    } else assert.doesNotMatch(result.system, /可按本次表达要求调整段落先后|用户对这一次表达的调整/);
    if (processTools) {
      assert.match(result.system, /先写字符串字段 rewrite.*再写字符串字段 process_note/);
      assert.match(result.system, /process_note 最多 40 个字符/);
      assert.match(result.system, /返回不等于任务成功/);
      assert.match(result.system, /不要把这些运行信息或过程补充写进 rewrite/);
    } else {
      assert.match(result.system, /只输出改写后的正文/);
      assert.doesNotMatch(result.system, /get_tool_usage\(\)|process_note/);
    }
  }
});

test('relay attribution and old tone samples remain separate from both new examples and the current facts', () => {
  const sourceLabel = '实际工程代理「甲」', card = { ...pack, narration: { mode: 'relay', assistant: '旧工作者昵称' } };
  const result = buildRewritePrompt({ ...input, pack: card, sourceLabel, history: ['历史完成了 [[0]]，只参考语气。'] });
  assert.ok(result.system.includes('实际工作者称为 ' + JSON.stringify(sourceLabel)));
  assert.match(result.system, /覆盖示例里的默认昵称/); assert.match(result.system, /保留原文动作的时态、条件、引语归属/);
  assert.match(result.system, /不得把他人的工作认领为自己的成果/); assert.match(result.system, /不要虚构询问、对话或角色之间的新事件/);
  assert.doesNotMatch(expressionSection(result.system), /旧工作者昵称|实际工程代理|鲸鲸/u);
  assert.ok(result.user.includes('历史完成了 {{0}}，只参考语气。'));
  assert.ok(result.user.endsWith('待改写：\n' + shielded.masked));
  assert.deepEqual(markers(result.user), markers(shielded.masked), 'historical markers cannot become literals of this report');
});
