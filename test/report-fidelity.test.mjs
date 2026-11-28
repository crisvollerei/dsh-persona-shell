import test from 'node:test';
import assert from 'node:assert/strict';
import { checkReportFidelity, strictSelfReference } from '../lib/report-fidelity.js';
import { normalizePack } from '../lib/pack.js';
import { buildRewritePrompt } from '../lib/prompt.js';
import { mask } from '../lib/mask.js';

test('worker and status checks follow prose when the same predicate occurs in code', () => {
  const original = '我未能提交。\n```js\n// 是否已提交\n```';
  const candidate = original.replace('我未能提交', '小鲸鲸已经顺利提交');
  const verdict = checkReportFidelity({original, candidate, maskedOriginal: mask(original).masked,
    maskedCandidate: mask(candidate).masked, voice: true, subagentLabel: '小鲸鲸'});
  assert.deepEqual(verdict.reasons, ['status-change', 'worker-change']);
  const pack = {identity: '自称「我」'};
  assert.equal(strictSelfReference("users' 文档标记为『我来核对』，已完成自我检查。", '', pack), false);
  assert.equal(strictSelfReference('我国完成了部署。', '', pack), false);
  assert.equal(strictSelfReference('我完成了部署。', '', pack), true);
});

test('strict relay uses its actual worker label and reviews only narrator prose',()=>{
  const make=(mode,selfReference)=>normalizePack({narration:{mode,selfReference,assistant:'姐姐'}});
  for(const pack of [make('relay','invalid'),make('voice','none')]){
    assert.equal(pack.narration.selfReference,'natural');assert.doesNotMatch(buildRewritePrompt({pack,masked:'正文',history:[],literalCount:0}).system,/本次为严格转述/);
  }
  const pack=make('relay','none');assert.equal(pack.narration.selfReference,'none');
  assert.match(buildRewritePrompt({pack,masked:'正文',history:[],literalCount:0,sourceLabel:'协作者甲'}).system,/原报告中指工作者的“我”/);
  for(const s of ['用户说"我只要 Linux 的结果"，所以姐姐只跑了 Linux。','她说「用户说“我来”」。','文件 `我的配置.yml` 已保存。'])assert.equal(strictSelfReference(mask(s).masked),false,s);
  for(const s of ['姐姐把超时改成 30 秒了，我看了下测试。','随后我又检查了一遍。','咱再看一眼','“我没有闭合引号'])assert.equal(strictSelfReference(s),true,s);
  assert.equal(strictSelfReference("姐姐说'我先跑'。"), false);
  assert.equal(strictSelfReference("It's ready，我们再看看 what's next。"), true);
  assert.equal(strictSelfReference("'咱们还在检查"), true);
  assert.equal(strictSelfReference('本小肥鱼检查了测试。', '小肥鱼（实验性）'), true);
  assert.equal(strictSelfReference('本小蓝核对了结果。', '小蓝'), true);
  assert.equal(strictSelfReference('姐姐说「本小蓝核对了结果」。', '小蓝'), false);
  const aliasPack={identity:'自称『本海星』，也自称「咕咕」',narration:{selfAliases:['阿圆']}};
  for(const alias of ['本鲸鲸','本海星','咕咕','阿圆']) {
    assert.equal(strictSelfReference(alias+'觉得没问题','鲸鲸',aliasPack),true);
    assert.equal(strictSelfReference('用户说「'+alias+'觉得没问题」','鲸鲸',aliasPack),false);
  }
});

for (const [source,candidate,rejected] of [
  ['Windows 完成 2 项，Linux 完成 7 项','Windows 这边完成 7 项，Linux 完成 2 项',true],
  ['Windows 完成 2 项，Linux 完成 7 项','Linux 那边完成 7 项，Windows 完成 2 项',false],
  ['前端修复 3 处，后端修复 5 处','前端修复 5 处，后端修复 3 处',true],
  ['前端修复 3 处，后端修复 5 处','后端修了 5 处，前端修了 3 处',false],
  ['共完成 2 项','一共完成了 2 项',false],
  ['新增 4 个文件，删除 2 个文件','新增 2 个文件，删除 4 个文件',false],
  ['A 完成 2 项，A 完成 3 项','A 完成 3 项，A 完成 2 项',false],
  ['- `Windows` 完成 2 项\n- Linux 完成 7 项','其中 Windows 完成了七项，而 Linux 完成了两项',true],
  ['Node 22 通过 12 项，Node 24 通过 8 项','Node 22 通过 8 项，Node 24 通过 12 项',true],
  ['Windows 完成两项，Linux 完成七项','Windows 完成七项，Linux 完成两项',true],
  ['Windows 完成两项，Linux 完成七项','Linux 完成七项，Windows 完成两项',false],
  ['Windows 完成两项，Linux 完成七项','Linux 完成 2 项，Windows 完成 7 项',true],
]) test(`attributed counts: ${candidate}`,()=>{
  assert.deepEqual(checkReportFidelity({original:source,candidate,allowEquivalentQuantities:true}).reasons,rejected?['quantity-attribution']:[]);
});
import { makeReportSource } from '../lib/report-visualization.js';
import { buildReportReadablePrompt, parseReportReadable } from '../lib/report-readable.js';

test('readable keeps parallel subject counts bound through clause reordering', () => {
  const original = 'Windows 完成 2 项检查，Linux 完成 7 项检查。';
  const source = makeReportSource({sessionId:'s',seq:1,text:original});
  const parse = text => parseReportReadable(JSON.stringify({schemaVersion:3,blocks:[{ref:'b1',text}]}),source);
  const swapped = parse('Windows 完成 7 项检查，Linux 完成 2 项检查。');
  assert.equal(swapped.value.blocks[0].text,original);
  assert.ok(swapped.warnings.some(w=>w.code==='readable-block-original'));
  const reordered = 'Linux 完成 7 项检查，Windows 完成 2 项检查。';
  assert.equal(parse(reordered).value.blocks[0].text,reordered);
});

test('report quantities preserve occurrences while prose can reorder the same observations', () => {
  assert.equal(checkReportFidelity({ original: '12/12 通过，修改2处。', candidate: '修改2处，12/12 检查通过。' }).ok, true);
  assert.deepEqual(checkReportFidelity({ original: '12/12 通过。', candidate: '12项都通过了，12/12。' }).reasons, ['quantity-change']);
});
test('ordinary workers do not acquire a subagent nickname while explicit relay mappings remain valid', () => {
  const original = '工作助手已调整配置。';
  assert.equal(checkReportFidelity({ original, candidate: '小鲸鲸已经调整配置了。' }).ok, false);
  assert.equal(checkReportFidelity({ original, candidate: '工作助手已经调整配置了。' }).ok, true);
  assert.equal(checkReportFidelity({ original, candidate: '姐姐已经调整配置了。', relay: true, workerLabel: '姐姐' }).ok, true);
  assert.equal(checkReportFidelity({ original, candidate: '小鲸鲸已经调整配置了。', relay: true, workerLabel: '姐姐' }).ok, false);
});
test('formal voice permits its own narration and omitted generic worker names only when opted in', () => {
  const original = '工作助手已调整配置。';
  for (const candidate of ['我已经调整配置了。', '鲸鲸已经调整配置了。', '配置已经调整。']) {
    assert.equal(checkReportFidelity({ original, candidate, voice: true, subagentLabel: '小鲸鲸' }).ok, true);
    assert.equal(checkReportFidelity({ original, candidate }).ok, false);
  }
});
test('formal voice still distinguishes an ordinary worker from its configured helper nickname', () => {
  for (const name of ['工作助手', '原助手']) {
    const original = `${name}未开始迁移。`, candidate = '小鲸鲸也还没开始迁移。';
    const input = { original, candidate, voice: true, subagentLabel: '小鲸鲸' };
    assert.deepEqual(checkReportFidelity(input).reasons, ['worker-change']);
    assert.equal(checkReportFidelity({ ...input, sourceIsSubagent: true }).ok, true);
  }
  // The caller supplies the configured nickname; this guard has no universal
  // list of names that it pretends to recognize as helpers.
  assert.equal(checkReportFidelity({ original: '工作助手已调整配置。', candidate: '小鲸鲸已调整配置。', voice: true }).ok, true);
});
test('configured helper names remain legal in main/helper prose without granting semantic alignment', () => {
  assert.equal(checkReportFidelity({ original: '工作助手只读记录。子代理丙完成1项静态检查。',
    candidate: '工作助手只读记录。小鲸鲸完成1项静态检查。', voice: true, subagentLabel: '小鲸鲸' }).ok, true);
  assert.equal(checkReportFidelity({ original: '工作助手只读记录。子代理丙完成1项静态检查。',
    candidate: '我只读记录。小鲸鲸完成1项静态检查。', voice: true, subagentLabel: '小鲸鲸' }).ok, true);
  // Named helpers keep their individual counts even when the totals match.
  assert.equal(checkReportFidelity({ original: '工作助手只读记录。子代理甲通过2项检查，子代理乙通过1项。',
    candidate: '只读了记录。子代理甲通过1项检查，子代理乙通过2项。', voice: true, subagentLabel: '小鲸鲸' }).ok, false);
});
test('voice does not bypass relay attribution and real helper-source mapping remains explicit', () => {
  const original = '工作助手已调整配置。';
  assert.equal(checkReportFidelity({ original, candidate: '我已调整配置。', voice: true,
    relay: true, workerLabel: '姐姐', subagentLabel: '小鲸鲸' }).ok, false);
  assert.equal(checkReportFidelity({ original, candidate: '姐姐已调整配置。', voice: true,
    relay: true, workerLabel: '姐姐', subagentLabel: '小鲸鲸' }).ok, true);
  assert.equal(checkReportFidelity({ original, candidate: '小鲸鲸已调整配置。', relay: true,
    workerLabel: '小鲸鲸', subagentLabel: '小鲸鲸', sourceIsSubagent: true }).ok, true);
});
test('real helper relay rejects a newly introduced main-worker label even when the source only says I', () => {
  const input = { original: '我只读了参数说明，命令没有执行。', relay: true, sourceIsSubagent: true,
    workerLabel: '小鲸鲸', mainWorkerLabel: '姐姐', subagentLabel: '小鲸鲸' };
  assert.deepEqual(checkReportFidelity({ ...input, candidate: '姐姐只读了参数说明，命令没有执行。' }).reasons, ['worker-change']);
  assert.equal(checkReportFidelity({ ...input, candidate: '小鲸鲸只读了参数说明，命令没有执行。' }).ok, true);
  assert.equal(checkReportFidelity({ ...input, candidate: '只读了参数说明，命令没有执行。' }).ok, true);
  assert.equal(checkReportFidelity({ ...input, original: '我只读了说明。原话是“姐姐说不用改”。',
    candidate: '只读了说明，原话是“姐姐说不用改”。' }).ok, true);
  assert.equal(checkReportFidelity({ ...input, sourceIsSubagent: false, candidate: '姐姐只读了参数说明，命令没有执行。' }).ok, true);
  assert.equal(checkReportFidelity({ ...input, workerLabel: '姐姐', candidate: '姐姐只读了参数说明，命令没有执行。' }).ok, true);
});
test('formal quantity normalization accepts small Chinese counts while strict mode retains literal occurrences', () => {
  const original = '修改2处，核对12项，分成20组；0项失败。';
  const candidate = '修改两处，核对十二项，分成二十组；零项失败。';
  assert.equal(checkReportFidelity({ original, candidate, allowEquivalentQuantities: true }).ok, true);
  assert.deepEqual(checkReportFidelity({ original, candidate }).reasons, ['quantity-change']);
  assert.equal(checkReportFidelity({ original: '每12项检查分1个批次。', candidate: '每十二项检查分一个批次。', allowEquivalentQuantities: true }).ok, true);
  assert.equal(checkReportFidelity({ original: candidate, candidate: original, allowEquivalentQuantities: true }).ok, true);
});
test('formal Chinese counts only repair an Arabic mismatch with corresponding unit context', () => {
  for (const [original, candidate] of [
    ['这是一份报告。', '报告准备好了。'],
    ['甲乙两份记录各发现1处问题。', '甲乙两份记录各发现1处问题，这两个维度要分开。'],
    ['补充3个字段，再交代一次：代码没改。', '补充3个字段，代码没改。'],
    ['1. 保存清单。2. 核对签名。', '1. 保存清单。2. 核对签名。恢复不是提前要做的一步。'],
    ['2项通过，十二项未测。', '两项通过，12项未测。'],
  ]) assert.equal(checkReportFidelity({ original, candidate, allowEquivalentQuantities: true }).ok, true);
  for (const candidate of ['修改三项。', '修改两项，另新增三项。', '修改两处。']) {
    assert.deepEqual(checkReportFidelity({ original: '修改2项。', candidate, allowEquivalentQuantities: true }).reasons, ['quantity-change']);
  }
});
test('mixed Arabic and Chinese option references normalize symmetrically without changing quantities', () => {
  const original = '# 栖湾导出清单\n\n工作助手本轮只读取栖湾导出清单，没有生成新文件，也没有上传。清单列出2个待确认的导出范围：仅当前章节，或全部已保存章节；用户还没有选择。\n\n清单中没有预计用时，也没有测试通过的记录。现在需要保留两个选项和未选择状态，不自动选范围，不把其他任务的验证结果当成这次的证据。';
  const candidate = '栖湾导出清单这边，姐姐说这一轮只做了读取，没生成新文件，也没上传。清单里有两个待确认的导出范围：仅当前章节，或者全部已保存章节——你还没选。清单里没有预计用时，也没有测试通过的记录。现在这两个选项和“还没选”的状态都要留着，不替你先选范围，也不拿别的任务的验证结果来当这次的证据。';
  const options = { allowEquivalentQuantities: true, relay: true, workerLabel: '姐姐' };
  assert.equal(checkReportFidelity({ original, candidate, ...options }).ok, true);
  assert.equal(checkReportFidelity({ original: candidate, candidate: original, ...options }).ok, true);
  assert.deepEqual(checkReportFidelity({ original, candidate: candidate.replace('这两个选项', '这三个选项'), ...options }).reasons, ['quantity-change']);
});
test('referential Chinese phrases do not invent counts during formal normalization', () => {
  assert.equal(checkReportFidelity({ original: '同一项记录：下一步逐项核对，每一项都保留。',
    candidate: '这条记录之后逐项核对，全部保留。', allowEquivalentQuantities: true }).ok, true);
});
test('formal ordinal repetition is separate from cardinal occurrences and preserves ordinal units', () => {
  const original = '本轮只完成第1步；第2步未开始。';
  const candidate = '第1步完成了。本轮只完成第一步；第二步未开始。';
  assert.equal(checkReportFidelity({ original, candidate, allowEquivalentQuantities: true }).ok, true);
  assert.equal(checkReportFidelity({ original, candidate }).ok, false);
  for (const candidate of ['第2步未开始。', '第1步完成，第3步未开始。', '第1项完成，第2项未开始。']) {
    assert.deepEqual(checkReportFidelity({ original, candidate, allowEquivalentQuantities: true }).reasons, ['quantity-change']);
  }
});
test('formal counts remain a multiset so repeated values cannot hide a changed result', () => {
  const original = '通过2项，失败1项；另有1条提醒。';
  assert.deepEqual(checkReportFidelity({ original, candidate: '通过2项，失败2项；另有1条提醒。',
    allowEquivalentQuantities: true }).reasons, ['quantity-change']);
  for (const candidate of ['通过2项，失败一项；另有一条提醒。', '另有1条提醒，失败1项，通过2项。']) {
    assert.equal(checkReportFidelity({ original, candidate, allowEquivalentQuantities: true }).ok, true);
  }
  assert.equal(checkReportFidelity({ original: '修改2处，再说明一次：修改2处。',
    candidate: '修改两处。', allowEquivalentQuantities: true }).ok, false);
  assert.equal(checkReportFidelity({ original: '12/12项检查通过。',
    candidate: '12项检查全部通过。', allowEquivalentQuantities: true }).ok, false);
});
test('formal quantity normalization still rejects changed, new or lost numerical values', () => {
  const input = { original: '12项通过，2项未测。', allowEquivalentQuantities: true };
  for (const candidate of ['13项通过，2项未测。', '12项通过，2项未测，新增1条记录。', '12项通过。']) {
    assert.deepEqual(checkReportFidelity({ ...input, candidate }).reasons, ['quantity-change']);
  }
  assert.deepEqual(checkReportFidelity({...input,candidate:input.original+'另有五处配置。'}).reasons,['quantity-change']);
  assert.equal(checkReportFidelity({original:'执行1次，前进2步。',candidate:'一次性执行一次，进一步向前走两步。',allowEquivalentQuantities:true}).ok,true);
});
test('even normalized quantity multisets do not certify subject, status or scope coverage', () => {
  assert.equal(checkReportFidelity({ original: '通过2项，失败1项。', candidate: '通过1项，失败2项。', allowEquivalentQuantities: true }).ok, true);
  assert.equal(checkReportFidelity({ original: '只在离线副本修改2处。', candidate: '修改两处。', allowEquivalentQuantities: true }).ok, true);
});
test('a uniquely anchored permission or requirement cannot turn into a promised execution', () => {
  for (const original of ['只有确认后才可关闭演练。', '只有确认后才需关闭演练。']) {
    assert.equal(checkReportFidelity({ original, candidate: '只有确认后才会关闭演练。' }).ok, false);
    assert.equal(checkReportFidelity({ original, candidate: '只有确认后，会关闭演练。' }).ok, false);
    assert.equal(checkReportFidelity({ original, candidate: '只有确认后会去关掉演练。' }).ok, false);
  }
  assert.equal(checkReportFidelity({ original: '只有确认后才可关闭演练。', candidate: '只有确认后才可以关闭演练。' }).ok, true);
  assert.equal(checkReportFidelity({ original: '只有确认后才可关闭写入端。', candidate: '只有确认后才会去关掉写入端。' }).ok, false);
  assert.equal(checkReportFidelity({ original: '确认之后才会关闭演练。', candidate: '确认之后才会关闭演练。' }).ok, true);
});

test('scope expansion, moving confirmation after execution and explicit status reversal reuse the source', () => {
  const cases = [
    ['远程同步仅覆盖新用户。现有用户需要手动迁移。', '远程同步同时覆盖新用户和现有用户。', 'scope-change'],
    ['只有管理员确认后，才可以删除旧快照。', '可以删除旧快照，管理员确认可随后补办。', 'permission-change'],
    ['实际恢复尚未执行。', '实际恢复已经执行。', 'status-change'],
  ];
  for (const [original, candidate, reason] of cases) {
    assert.ok(checkReportFidelity({ original, candidate }).reasons.includes(reason));
    const source = makeReportSource({ sessionId: 's', seq: 55, text: original });
    const result = parseReportReadable(JSON.stringify({ schemaVersion: 3, blocks: [{ ref: source.blocks[0].id, text: candidate }] }), source);
    assert.equal(result.value.blocks[0].text, original);
  }
  const original = cases[0][0];
  assert.equal(checkReportFidelity({ original, candidate: '远程同步只覆盖新用户。现有用户需要自己迁移。' }).ok, true);
});
test('readable output falls back at the original permission and worker boundary', () => {
  const source = makeReportSource({ sessionId: 's', seq: 1, text: '只有确认后才可关闭演练。\n\n工作助手已调整配置。' });
  const request = JSON.parse(buildReportReadablePrompt(source).user);
  const candidate = { schemaVersion: 3, blocks: request.source.blocks.map(({ ref, text }, i) => ({ ref,
    text: i === 0 ? text.replace('才可', '才会') : text.replace('工作助手', '小鲸鲸') })) };
  const result = parseReportReadable(JSON.stringify(candidate), source);
  assert.equal(result.ok, true); assert.deepEqual(result.value.blocks.map(block => block.text), source.blocks.map(block => block.text));
});
test('readable output keeps its existing quantity warning without the formal-report opt-in', () => {
  const source = makeReportSource({ sessionId: 's', seq: 2, text: '修改2处配置，12/12项检查通过。' });
  const request = JSON.parse(buildReportReadablePrompt(source).user);
  const candidate = { schemaVersion: 3, blocks: request.source.blocks.map(({ ref }) => ({ ref, text: '修改两处配置，12项检查全部通过。' })) };
  const result = parseReportReadable(JSON.stringify(candidate), source);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.blocks.map(block => block.text), ['修改两处配置，12项检查全部通过。']);
  assert.ok(result.warnings.some(warning => warning.code === 'readable-wording-review'));
});
