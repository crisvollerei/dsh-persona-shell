// Prompt contracts protect the input boundary; they do not prove semantic fidelity.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRewritePrompt, validateRewrite } from '../lib/prompt.js';
import { mask, unmask } from '../lib/mask.js';
import { BUILTIN_PRESETS, normalizePack } from '../lib/pack.js';

const pack = {
  identity: '角色甲', report: ['清楚转述原报告。'], voice: ['平实。'], samples: [], avoid: [],
  address: { user: '你', subagent: '工作助手' }, narration: { mode: 'voice' },
};
const original = '# 发布条件\n\n仅完成本地配置调整；离线检查通过。客户端验证未进行，不代表可直接发布。\n\n1. 先由你确认目标环境。\n2. 只有确认后，工作助手才可运行 `npm run verify`；失败时必须停止，不得推送。';
const shielded = mask(original);
const input = { pack, masked: shielded.masked, literalCount: shielded.literals.length, history: [] };

test('automatic rewriting can improve paragraph rhythm without changing the source or procedure contract', () => {
  const snapshot = structuredClone(input);
  const prompt = buildRewritePrompt(input);
  assert.deepEqual(input, snapshot);
  assert.equal(unmask(prompt.user.slice('待改写：\n'.length), shielded.literals), original);
  assert.match(prompt.system, /长短句自然交替，不把每条信息都切成一句结论/);
  assert.match(prompt.system, /默认转述以顺畅为主，不必逐个扩写技术短语/);
  assert.match(prompt.system, /普通说明段落可适当拆分、合并或前后调整/);
  assert.match(prompt.system, /保留操作步骤的顺序、列表符号和标题层级/);
  assert.match(prompt.system, /只合并重复表述，不删独立事实/);
  assert.match(prompt.system, /结论与其适用条件、风险和证据相邻对应/);
  assert.match(prompt.system, /不为自己的语气、判断或亲切程度另外找由头/);
  assert.match(prompt.system, /原报告已有的必要解释仍须保留/);
  assert.doesNotMatch(prompt.system, /重新转述还要处理原报告本身难读/);
});

test('one-off readable rewriting supplements only source-known sentence subjects, including formal requests', () => {
  for (const colloquialReports of [false, true]) {
    const feedback = '更正式一点，分开说明结果、未验证项与发布条件。';
    const prompt = buildRewritePrompt({ ...input, colloquialReports, feedback });
    assert.equal(prompt.user, '待改写：\n' + shielded.masked);
    assert.ok(prompt.system.includes(JSON.stringify(feedback)));
    assert.match(prompt.system, /本次明确的措辞调整优先于全局口语化或书面句式偏好/);
    assert.match(prompt.system, /省略主语的谓宾片段、名词堆叠/);
    assert.match(prompt.system, /更正式或贴近书面句式时，也要讲清谁或什么处于什么状态/);
    assert.match(prompt.system, /主语只能来自原文能确定的执行者、对象或证据/);
    assert.match(prompt.system, /执行者不明时，可用原文已明确的配置、检查结果或报告作主语/);
    assert.match(prompt.system, /不猜成“我”“工作助手”或“你”/);
    assert.match(prompt.system, /不补原文没有的动作、原因、完成状态或结论/);
    assert.match(prompt.system, /降低每句话同时承载的信息密度/);
    assert.match(prompt.system, /不删事实、验证结果、风险、条件或下一步/);
    assert.match(prompt.system, /原文信息密集时优先保留完整信息，不强求缩到某个比例/);
  }
});

test('readability remains a transformation of one original report, not new evidence or authorization', () => {
  for (const feedback of ['', '像正常说话一样，别堆在一句里。']) {
    const prompt = buildRewritePrompt({ ...input, feedback });
    assert.match(prompt.system, /交付汇报不表示用户已经验收、采纳建议或授权下一步/);
    assert.match(prompt.system, /并列事实不擅自连成因果，条件句不改成确定承诺/);
    assert.match(prompt.system, /原样各保留一次，仍与对应事实、步骤和条件相连/);
    assert.match(prompt.system, /未验证不能说成已通过，建议或计划不能说成已经执行/);
    assert.match(prompt.system, /信息量必须持平/);
    assert.match(prompt.user, /客户端验证未进行，不代表可直接发布/);
    assert.match(prompt.user, /只有确认后，工作助手才可运行/);
    assert.match(prompt.user, /失败时必须停止，不得推送/);
  }
  const candidate = '本地配置已调整，离线检查也已通过。客户端还没验证，不能据此直接发布。\n\n1. 先由你确认目标环境。\n2. 只有确认后，工作助手才可运行 [[0]]；如果失败，就必须停止，不得推送。';
  const check = text => validateRewrite({ candidate: text, original: shielded.masked, literalCount: shielded.literals.length, maxRatio: 1.3 });
  assert.equal(check(candidate).ok, true);
  assert.equal(check(candidate.replace('[[0]]', '')).reason, 'dropped-marker');
  assert.equal(check(candidate + ' [[0]]').reason, 'duplicate-marker');
});

test('automatic and manual ceilings agree with the caller while expansion remains optional', () => {
  const automatic = buildRewritePrompt(input);
  const manual = buildRewritePrompt({ ...input, feedback: '把压缩的说明讲清楚。', maxRatio: 1.7 });
  assert.equal(automatic.user, manual.user);
  assert.match(automatic.system, /长度不超过原文的 1\.3 倍/);
  assert.match(manual.system, /长度不超过原文的 1\.7 倍/);
  for (const prompt of [automatic, manual]) {
    assert.match(prompt.system, /这是上限，不是目标/);
    assert.match(prompt.system, /只在讲清原文需要时补足句子，不为凑长度加入新内容/);
  }
  // Verify the larger manual allowance on a long source, beyond the short-report floor.
  const compact = '配置尚未验证。'.repeat(150), expanded = '配置目前仍未验证。'.repeat(170);
  assert.equal(validateRewrite({ candidate: expanded, original: compact, literalCount: 0, maxRatio: 1.3 }).reason, 'too-long');
  assert.equal(validateRewrite({ candidate: expanded, original: compact, literalCount: 0, maxRatio: 1.7 }).ok, true);
});

test('configured aliases retain actor roles and explicit relay attribution', () => {
  for (const feedback of ['', '讲得更容易读一点。']) {
    const plain = buildRewritePrompt({ ...input, feedback });
    assert.match(plain.system, /具名子代理也可以使用约定的别称/);
    assert.match(plain.system, /谁做了什么、结果与条件保持对应/);
    assert.match(plain.system, /有多位执行者时，让各自工作可以区分/);
    assert.match(plain.system, /普通“工作助手”不能按子代理称呼设定换成昵称，也不能据此改认成子代理/);
    assert.match(plain.system, /本次原报告由主工作助手提交/);
    assert.ok(plain.user.includes('工作助手才可运行'));
    const relay = buildRewritePrompt({ ...input, feedback,
      pack: { ...pack, narration: { mode: 'relay', assistant: '设置中的工作者' } }, sourceLabel: '明确配置的工作者甲' });
    assert.ok(relay.system.includes('实际工作者称为 "明确配置的工作者甲"'));
    assert.match(relay.system, /按本次人设和发言关系使用自称、工作者称呼及子代理别称/);
    assert.equal(relay.user, plain.user);
  }
});

test('report author metadata distinguishes a child report from a main report mentioning a child', () => {
  const main = buildRewritePrompt({ ...input, masked: '工作助手读过子代理的报告，没有重跑。' });
  const child = buildRewritePrompt({ ...input, sourceIsSubagent: true, sourceLabel: '小鲸鲸' });
  assert.match(main.system, /本次原报告由主工作助手提交/);
  assert.doesNotMatch(main.system, /本次原报告由子代理提交/);
  assert.match(child.system, /本次原报告由子代理提交/);
  assert.match(child.system, /引语里的“我”仍按原引语归属/);
  assert.equal(child.user, '待改写：\n' + shielded.masked);
});

test('builtin relay work examples follow the actual worker without changing identity or saved cards', () => {
  const preset = BUILTIN_PRESETS.find(item => item.id === '鲸鲸（实验性）');
  const card = normalizePack(preset.pack), saved = structuredClone(card), persona = {id:preset.id,builtin:true};
  const ordinary = buildRewritePrompt({...input,pack:card,persona});
  const child = buildRewritePrompt({...input,pack:card,persona,sourceIsSubagent:true,sourceLabel:'小鲸鲸'});
  const section = (text,title) => text.split('## '+title+'\n')[1].split('\n## ')[0];
  assert.match(section(ordinary.system,'这份汇报里怎么说话'),/工作动作与检查结果归姐姐/);
  assert.match(section(child.system,'这份汇报里怎么说话'),/工作动作与检查结果归小鲸鲸/);
  assert.match(section(child.system,'汇报表达样例（只参考语感，不是本轮事实）'),/表达：小鲸鲸/);
  assert.deepEqual(section(child.system,'你是谁'),section(ordinary.system,'你是谁'));
  assert.deepEqual(section(child.system,'语气禁区'),section(ordinary.system,'语气禁区'));
  assert.deepEqual(card,saved);assert.equal(child.user,ordinary.user);
  const custom = buildRewritePrompt({...input,pack:card,persona:{...persona,builtin:false},sourceIsSubagent:true,sourceLabel:'小鲸鲸'});
  assert.match(section(custom.system,'这份汇报里怎么说话'),/正文以「姐姐」为主语/);
  assert.ok(child.system.indexOf('## 本次发言关系')>child.system.indexOf('## 语气禁区'));
});

test('easier wording preserves permission versus commitment, requirements, plans and completion', () => {
  for (const feedback of ['', '改成完整而自然的句子。']) {
    const prompt = buildRewritePrompt({ ...input, feedback });
    assert.match(prompt.system, /许可、要求、计划与完成状态分别表达/);
    assert.match(prompt.system, /“只有确认后才可执行”只说明执行的许可条件/);
    assert.match(prompt.system, /不能改成“确认后才会执行”的确定行动/);
    assert.match(prompt.system, /不能把“应执行”或“计划执行”说成“已执行”/);
    assert.ok(prompt.user.includes('只有确认后，工作助手才可运行'));
    assert.ok(prompt.user.includes('失败时必须停止，不得推送'));
  }
});
