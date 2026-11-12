import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {BUILTIN_PRESETS,normalizePack} from '../lib/pack.js';
import {resolvePersonaExpression,hasBuiltinExpressionProfile} from '../lib/persona-expression.js';

const owner=preset=>({id:preset.id,builtin:true});
const view=(preset,channel='chat')=>resolvePersonaExpression(normalizePack(preset.pack),{channel,persona:owner(preset)});
// Pin report identity, constraints and the explicitly updated report voice
// separately from the evolving chat examples; report samples are checked below.
const reportSignatures={
  '大肥鱼（默认）':'db48091b4aa76e87d9df85b331a0e07a776629eae1e6a812e435175f6e778a3e',
  '大肥龙':'e4190f18b5bf6716fb02754f389569d78a13c00edc5dda67ca0001687f1d56f7',
  'Claude小姐':'fb7206420b9dc28527d125ec6c6936178ddf96b6ee2fb8e4449c456cf589e6b1',
  '鲸鲸（实验性）':'d4c45b4b9a84e902ea120c84f3ce2fffd62ec1e689c0f021effc2cbf20445c2c',
  Gemini:'698e5578e789c5b6fbe12ea519dbfccf6e5752aac958d05783d6b7754f4642c1',
};
// Pin identity and relations after removing third-person pronoun metadata from the actor's own view.
const chatIdentitySignatures={
  '大肥鱼（默认）':'7ed78299f4796ac7f2994086812cb7d68f3d946f26e92927d09bdfa9c6080cfb',
  '大肥龙':'bfde9d146c8c300b22152f6e54bdf378f8f5ecca597ec06fc1aebaca8d7983fc',
  'Claude小姐':'81ae64263c64748880e6f9d6bcbcce9868ee6736695977fc64b32fa3bb2cfd92',
  '鲸鲸（实验性）':'93c2e8cc0a0ac1d00481f819f598843991411a49de7cb8686b7f12c1041289dd',
  Gemini:'a93f0e2759e1159b9286ade2bce56f23f82ee701c75f89e6cc72b90096b885c1',
};

test('report identity and constraints remain stable while only chat gets multi-turn examples',()=>{
  for(const preset of BUILTIN_PRESETS){
    const original=structuredClone(preset.pack),report=view(preset,'report');
    const {samples,...stableReport}=report;
    assert.equal(createHash('sha256').update(JSON.stringify(stableReport)).digest('hex'),reportSignatures[preset.id]);
    assert.equal(samples.length,3);assert.ok(samples.every(sample=>sample.startsWith('原文：')&&sample.includes('\n表达：')));
    assert.equal(report.dialogueExamples,undefined);
    const rawReport=resolvePersonaExpression(preset.pack,{channel:'report',persona:owner(preset)});
    // Raw cards may omit the normalized default narration; keep that distinction.
    const {narration:normalizedDefault,...withoutNarration}=report;
    assert.deepEqual(rawReport,preset.pack.narration===undefined?withoutNarration:report);
    assert.deepEqual(preset.pack,original,'runtime expression material cannot rewrite the saved/source card');
    assert.equal(preset.pack.dialogueExamples,undefined,'no new persisted card schema or generator field is introduced');
  }
});

test('chat identity and public relations stay fixed as bounded speaking guidance evolves',()=>{
  for(const preset of BUILTIN_PRESETS){
    const {identity,voice,avoid}=view(preset);
    assert.equal(createHash('sha256').update(identity).digest('hex'),chatIdentitySignatures[preset.id]);
    assert.ok(voice.length<=4&&avoid.length<=4);
  }
});

test('builtin dialogue examples are bounded, independent fictional exchanges rather than one shared catchphrase set',()=>{
  const publicNames=new Set(['user','self','鲸鲸','小肥鱼','GPT','Claude小姐','小克','猫猫']);
  const groups=new Set();
  for(const preset of BUILTIN_PRESETS){
    const chat=view(preset);assert.deepEqual(chat.samples,[]);
    assert.ok(chat.dialogueExamples.length>=2&&chat.dialogueExamples.length<=3);
    let chars=0;
    for(const example of chat.dialogueExamples){
      assert.deepEqual(Object.keys(example),['turns']);
      assert.ok(example.turns.length>=3&&example.turns.length<=6);
      assert.ok(example.turns.some(turn=>turn.speaker==='self'),'every fictional exchange includes this speaker');
      for(const turn of example.turns){
        assert.deepEqual(Object.keys(turn).sort(),['speaker','text']);assert.ok(publicNames.has(turn.speaker));
        assert.equal(typeof turn.text,'string');assert.ok(turn.text.trim()&&turn.text.length<=400);chars+=turn.text.length;
      }
      const encoded=JSON.stringify(example);assert.ok(!groups.has(encoded),'different personas do not share an entire scripted exchange');groups.add(encoded);
    }
    assert.ok(chat.dialogueExamples.some(example=>example.turns.filter(turn=>turn.speaker==='self').length>=2),
      'each persona has a genuine continued exchange rather than only isolated answers');
    assert.ok(new Set(chat.dialogueExamples.map(example=>example.turns.length)).size>1,
      'examples do not make every exchange follow an identical number of turns');
    assert.ok(chars<=2000);
    assert.ok(chat.voice.length<=4&&chat.avoid.length<=4,'existing trait lists remain bounded instead of growing with each example');
  }
});

test('copied builtin names, full card text or a custom examples field do not grant builtin chat material',()=>{
  for(const preset of BUILTIN_PRESETS){
    const pack=normalizePack(preset.pack);
    for(const persona of [undefined,{id:preset.id,builtin:false},{id:'custom-copy',builtin:true,name:preset.name}]){
      const chat=resolvePersonaExpression(pack,{channel:'chat',persona});
      assert.equal(chat.dialogueExamples,undefined);assert.deepEqual(chat.samples,pack.samples);
      assert.equal(chat.identity,pack.identity);
    }
    const polluted={...pack,dialogueExamples:[{turns:[{speaker:'self',text:'UNTRUSTED_RUNTIME_EXAMPLE'}]}]};
    assert.equal(hasBuiltinExpressionProfile(polluted,owner(preset)),false);
    const custom=resolvePersonaExpression(polluted,{channel:'chat',persona:owner(preset)});
    assert.equal(custom.dialogueExamples,undefined);assert.deepEqual(custom.voice,pack.voice);
    assert.doesNotMatch(JSON.stringify(custom),/UNTRUSTED_RUNTIME_EXAMPLE/);
  }
});

test('nested runtime examples are independent snapshots and preserve public identities without report relay duties',()=>{
  const views=new Map();
  for(const preset of BUILTIN_PRESETS){
    const first=view(preset),expected=structuredClone(first);views.set(preset.id,expected);
    first.dialogueExamples[0].turns[0].text='MUTATED_EXAMPLE';first.dialogueExamples[0].turns.push({speaker:'self',text:'MUTATED_EXAMPLE'});
    first.dialogueExamples.push({turns:[]});first.voice.push('MUTATED_VOICE');
    assert.deepEqual(view(preset),expected,'one request cannot contaminate another persona request or future resolution');
    assert.match(expected.identity,/女性/);
  }
  assert.match(views.get('大肥鱼（默认）').identity,/第一人称用「鲸鲸」/);
  assert.match(views.get('大肥鱼（默认）').identity,/小肥鱼.*亲妹妹/);
  const small=views.get('鲸鲸（实验性）');assert.match(small.identity,/自称「小肥鱼」/);assert.match(small.identity,/大肥鱼.*亲姐姐/);
  assert.doesNotMatch(small.identity+small.voice.join('\n'),/原工作助手|姐姐的转述者|姐姐说改/);
  assert.match(views.get('大肥龙').identity,/叫「GPT」/);assert.match(views.get('Gemini').identity,/「猫猫」/);
  assert.match(views.get('Claude小姐').voice.join('\n'),/对齐.*权限边界/);
});
