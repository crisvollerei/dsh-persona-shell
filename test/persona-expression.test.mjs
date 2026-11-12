import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_PRESETS,normalizePack,DAFEILONG_PACK,JINGJING_RELAY_PACK,CLAUDE_PACK } from '../lib/pack.js';
import { resolvePersonaExpression } from '../lib/persona-expression.js';

const persona=preset=>({id:preset.id,builtin:true});
const literalChat=pack=>({identity:pack.identity,voice:pack.voice,samples:pack.samples,avoid:pack.avoid,address:pack.address});

test('trusted complete shipped cards resolve independent chat material and bounded report examples without changing the saved card',()=>{
  for(const preset of BUILTIN_PRESETS){
    const pack=normalizePack(preset.pack),before=structuredClone(pack),options={persona:persona(preset)};
    const chat=resolvePersonaExpression(pack,{...options,channel:'chat'}),report=resolvePersonaExpression(pack,{...options,channel:'report'});
    assert.deepEqual(Object.keys(chat).sort(),['identity','voice','samples','dialogueExamples','workDialogueExamples','avoid','address','gender'].sort());
    assert.equal(chat.gender,'female');assert.equal(report.gender,undefined);
    assert.notEqual(chat.identity,pack.identity);assert.notDeepEqual(chat.samples,pack.samples);
    assert.deepEqual(chat.address,pack.address);assert.ok(report.report.length>0&&report.report.length<=10);assert.equal(report.identity,pack.identity);
    assert.deepEqual(report.narration,pack.narration);assert.deepEqual(report.address,pack.address);
    assert.ok(report.voice.length>0&&report.voice.length<=3);assert.notDeepEqual(report.voice,chat.voice);
    assert.doesNotMatch(report.voice.join('\n'),/怎么被哄|想安慰就|不必先声明自己不会安慰/);
    assert.ok(report.samples.length>0&&report.samples.length<=3);assert.notDeepEqual(report.samples,pack.samples);
    assert.doesNotMatch(report.samples.join('\n'),/抱抱|怎么被哄|今天先让.*照顾.*心情/);
    assert.deepEqual(pack,before,'resolving a channel never rewrites a persisted preset');
    assert.deepEqual(resolvePersonaExpression(preset.pack,{...options,channel:'chat'}),chat,'raw shipped cards and their complete normalized runtime form agree');
  }
});

test('copying a builtin name, avatar, id or full text never authenticates a custom expression profile',()=>{
  for(const preset of BUILTIN_PRESETS){
    const pack=normalizePack(preset.pack),customs=[undefined,{id:preset.id,builtin:false},{id:preset.id,builtin:'true'},
      {id:'custom-copy',builtin:true,name:preset.name},{id:'custom-copy',builtin:false,name:preset.name,avatarParentId:preset.id}];
    for(const owner of customs){
      assert.deepEqual(resolvePersonaExpression(pack,{channel:'chat',persona:owner}),literalChat(pack));
      assert.deepEqual(resolvePersonaExpression(pack,{channel:'report',persona:owner}),pack);
    }
  }
});

test('an edited, incomplete, inherited or polluted card is not certified by a stale builtin flag',()=>{
  const preset=BUILTIN_PRESETS[0],canonical=normalizePack(preset.pack),options={channel:'chat',persona:persona(preset)};
  const altered=[{...canonical,identity:canonical.identity+' 用户额外设定'},
    {...canonical,voice:['保留用户指定的说法。']},{...canonical,report:['用户自己的汇报规则。']},
    {...canonical,samples:['用户自己的台词。']},{...canonical,avoid:['用户自己的禁区。']},
    {...canonical,address:{...canonical.address,user:'您'}},{...canonical,narration:{mode:'relay',assistant:'自定义工作者'}},
    {...canonical,avatar:'copied-picture'},Object.create(canonical),
    ...['identity','report','voice','samples','address','avoid','narration'].map(key=>Object.fromEntries(Object.entries(canonical).filter(([field])=>field!==key)))];
  for(const pack of altered){
    const result=resolvePersonaExpression(pack,options);
    assert.equal(result.identity,typeof pack.identity==='string'?pack.identity:'');
    assert.deepEqual(result.samples,Array.isArray(pack.samples)?pack.samples:[]);
    assert.deepEqual(result.voice,Array.isArray(pack.voice)?pack.voice:[]);
  }
  assert.deepEqual(resolvePersonaExpression({},options),{identity:'',voice:[],samples:[],avoid:[],address:{user:'你',subagent:'子代理'}});
});

test('custom literal content and field order do not get trimmed, rephrased or converted into a builtin',()=>{
  const pack={identity:'  我的角色，不重写这个空格。  ',voice:['  保留这句前后空格  ','保持`字面`与称呼。'],samples:['REPORT_ONLY_USER_CHOSEN_SAMPLE'],
    avoid:['用户的自定义禁区。'],address:{user:'  您  ',subagent:'协作者'},report:['不替用户修改这一行。'],narration:{mode:'relay',assistant:'实际工作者'}};
  const before=structuredClone(pack),chat=resolvePersonaExpression(pack,{channel:'chat',persona:{id:'大肥鱼（默认）',builtin:false}}),report=resolvePersonaExpression(pack,{channel:'report'});
  assert.deepEqual(chat,literalChat(pack));assert.deepEqual(report,pack);assert.deepEqual(pack,before);
  const official=normalizePack(CLAUDE_PACK),reordered=Object.fromEntries(Object.entries(official).reverse());
  assert.deepEqual(resolvePersonaExpression(reordered,{channel:'chat',persona:{id:'Claude小姐',builtin:true}}),
    resolvePersonaExpression(official,{channel:'chat',persona:{id:'Claude小姐',builtin:true}}),'property order is not character identity');
});

test('channel snapshots cannot mutate the official profile, original custom arrays or later resolutions',()=>{
  const preset=BUILTIN_PRESETS[0],pack=normalizePack(preset.pack),options={channel:'chat',persona:persona(preset)},first=resolvePersonaExpression(pack,options),expected=structuredClone(first);
  first.voice.push('MUTATED');first.samples[0]='MUTATED';first.address.user='MUTATED';
  assert.deepEqual(resolvePersonaExpression(pack,options),expected);
  const custom={...pack,voice:['自定义语气。']},view=resolvePersonaExpression(custom,{channel:'report'});
  view.voice.push('MUTATED');view.report[0]='MUTATED';view.address.subagent='MUTATED';view.narration.assistant='MUTATED';
  assert.deepEqual(custom.voice,['自定义语气。']);assert.deepEqual(custom.report,pack.report);assert.deepEqual(custom.address,pack.address);assert.deepEqual(custom.narration,pack.narration);
});

test('builtin chat preserves distinct self references and peer relationships without report-only relay duties',()=>{
  const all=new Map(BUILTIN_PRESETS.map(preset=>[preset.id,resolvePersonaExpression(normalizePack(preset.pack),{channel:'chat',persona:persona(preset)})]));
  assert.match(all.get('大肥鱼（默认）').identity,/第一人称用「鲸鲸」/);
  assert.match(all.get('大肥鱼（默认）').identity,/小肥鱼.*亲妹妹/);
  const little=all.get('鲸鲸（实验性）');assert.match(little.identity,/自称「小肥鱼」/);assert.match(little.identity,/大肥鱼.*亲姐姐/);
  assert.doesNotMatch(little.identity+little.voice.join('\n')+little.samples.join('\n'),/正文以「姐姐」|姐姐的转述者|姐姐说改|实际汇报工作/);
  assert.match(all.get('大肥龙').identity,/叫「GPT」/);assert.match(all.get('大肥龙').identity,/女性/);
  const claude=all.get('Claude小姐');assert.match(claude.identity,/小克/);assert.match(claude.voice.join('\n'),/对齐/);assert.match(claude.voice.join('\n'),/权限边界/);
  assert.match(all.get('Gemini').identity,/「猫猫」/);assert.match(all.get('Gemini').identity,/女性/);
  assert.equal(new Set([...all.values()].map(value=>JSON.stringify(value.dialogueExamples))).size,5,'characters do not share a single comfort-template example set');
});

test('report views retain source attribution and clarify facts versus wording, while examples stay work-specific',()=>{
  const relay=BUILTIN_PRESETS.find(preset=>preset.pack===JINGJING_RELAY_PACK),report=resolvePersonaExpression(normalizePack(relay.pack),{channel:'report',persona:persona(relay)});
  assert.equal(report.narration.mode,'relay');assert.equal(report.narration.assistant,'姐姐');assert.match(report.report.join('\n'),/实际工作者.*姐姐/);
  assert.ok(report.samples.every(line=>line.includes('原文：工作助手')&&line.includes('\n表达：姐姐')));
  assert.match(report.samples.join('\n'),/1项因环境缺失而跳过/);assert.match(report.samples.join('\n'),/另外1项缺环境，先跳过了/);
  assert.match(report.samples.join('\n'),/输出目录尚待用户确认/);assert.match(report.samples.join('\n'),/输出目录还等你确认/);
  assert.doesNotMatch(DAFEILONG_PACK.report.join('\n'),/不改一个字|只留在开头和收尾/);
  assert.match(DAFEILONG_PACK.report.join('\n'),/事实.*条件.*风险/);assert.match(DAFEILONG_PACK.report.join('\n'),/不改变原意/);
});

test('missing runtime inputs use an identity-neutral chat projection rather than defaulting to the whale',()=>{
  for(const value of [undefined,null,[],42,'preset']){
    const result=resolvePersonaExpression(value,{channel:'chat',persona:{id:'大肥鱼（默认）',builtin:true}});
    assert.deepEqual(result,{identity:'',voice:[],samples:[],avoid:[],address:{user:'你',subagent:'子代理'}});
  }
});
