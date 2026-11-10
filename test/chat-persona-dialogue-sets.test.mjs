import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {BUILTIN_PRESETS,normalizePack} from '../lib/pack.js';
import {resolvePersonaExpression,hasBuiltinExpressionProfile} from '../lib/persona-expression.js';

const owner=preset=>({id:preset.id,builtin:true});
const chat=preset=>resolvePersonaExpression(normalizePack(preset.pack),{channel:'chat',persona:owner(preset)});
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const names=new Set(['user','self','鲸鲸','小肥鱼','GPT','Claude小姐','小克','猫猫']);
const exampleFields=['dialogueExamples','workDialogueExamples'];

// Full raw + normalized report views after the explicit report readability update.
// Later chat example edits must not change the report wording, samples or source card.
const reportSignatures={
  '大肥鱼（默认）':'2fea2e2bd2367d8b90d010646a8c3c1fb67aa038f3d4f06d723afd71a472c1e7',
  '大肥龙':'2942ff77e5bc3dd59f429e9290e28b6a0c63942226b36d78e2496fbdef39271d',
  'Claude小姐':'87fe5b40d7083adc0bb449f2158a1e541ca31d27e51bf78c365897bf80da1fbf',
  '鲸鲸（实验性）':'c713794ba4d7ed719581503b00627b1fb9df1dc9808677c73be7f34aa58d312e',
  Gemini:'8c778261710c5c1f07d301460693366a7935cf8314582bd2783d027c1c86914e',
};

test('each builtin has separate bounded daily and work dialogue sets with varied conversational rhythm',()=>{
  const uniqueGroups=new Set();
  assert.equal(BUILTIN_PRESETS.length,5);
  for(const preset of BUILTIN_PRESETS){
    const view=chat(preset);
    assert.equal(view.dialogueExamples.length,3,preset.id+' daily set');
    assert.equal(view.workDialogueExamples.length,2,preset.id+' work set');
    assert.deepEqual(view.samples,[],'standalone canned lines do not accompany the fictional exchanges');
    for(const key of exampleFields){
      let chars=0;
      for(const group of view[key]){
        assert.deepEqual(Object.keys(group),['turns']);
        assert.ok(group.turns.length>=2&&group.turns.length<=6);
        assert.ok(group.turns.some(turn=>turn.speaker==='self'));
        assert.ok(group.turns.some(turn=>turn.speaker!=='self'));
        for(const turn of group.turns){
          assert.deepEqual(Object.keys(turn).sort(),['speaker','text']);
          assert.ok(names.has(turn.speaker),'only public fictional participants are used');
          assert.equal(typeof turn.text,'string');
          assert.ok(turn.text.trim().length>0&&turn.text.length<=400);
          chars+=turn.text.length;
        }
        const encoded=JSON.stringify(group);
        assert.ok(!uniqueGroups.has(encoded),'personas and scenes do not share a whole scripted exchange');
        uniqueGroups.add(encoded);
      }
      assert.ok(chars<=2000,preset.id+' '+key+' prompt budget');
    }
    assert.ok(new Set(view.dialogueExamples.map(group=>group.turns.length)).size>1,
      'daily conversations do not all use the same turn count');
    assert.ok(view.dialogueExamples.some(group=>group.turns.filter(turn=>turn.speaker==='self').length>=2),
      'each daily set includes a continuing exchange rather than only isolated answers');
    assert.ok(view.workDialogueExamples.some(group=>{
      const firstSelf=group.turns.findIndex(turn=>turn.speaker==='self');
      return group.turns.slice(0,firstSelf).some(turn=>turn.speaker!=='user');
    }),'each work set includes replying after a companion has already spoken');
  }
});

test('full report projections and saved builtin cards stay independent of both chat example sets',()=>{
  for(const preset of BUILTIN_PRESETS){
    const original=structuredClone(preset.pack),persona=owner(preset);
    const reports={
      raw:resolvePersonaExpression(preset.pack,{channel:'report',persona}),
      normalized:resolvePersonaExpression(normalizePack(preset.pack),{channel:'report',persona}),
    };
    assert.equal(digest(reports),reportSignatures[preset.id],preset.id+' report baseline');
    for(const value of [preset.pack,normalizePack(preset.pack),reports.raw,reports.normalized]){
      for(const key of exampleFields)assert.equal(Object.hasOwn(value,key),false,
        'fictional chat exchanges are not persisted or projected into formal reports');
    }
    chat(preset);
    assert.deepEqual(preset.pack,original);
  }
});

test('nested work examples are fresh snapshots across requests, personas and channels',()=>{
  const expected=new Map(BUILTIN_PRESETS.map(preset=>[preset.id,chat(preset)]));
  for(const preset of BUILTIN_PRESETS){
    const snapshot=chat(preset);
    for(const key of exampleFields){
      snapshot[key][0].turns[0].speaker='self';
      snapshot[key][0].turns[0].text='MUTATED_EXAMPLE';
      snapshot[key][0].turns.push({speaker:'self',text:'MUTATED_EXAMPLE'});
      snapshot[key].push({turns:[]});
    }
    snapshot.voice[0]='MUTATED_VOICE';
    for(const other of BUILTIN_PRESETS)assert.deepEqual(chat(other),expected.get(other.id));
    const report=resolvePersonaExpression(normalizePack(preset.pack),{channel:'report',persona:owner(preset)});
    assert.doesNotMatch(JSON.stringify(report),/MUTATED_/);
  }
});

test('a custom owner, copied name or edited card cannot acquire either builtin example set',()=>{
  for(const preset of BUILTIN_PRESETS){
    const canonical=normalizePack(preset.pack);
    for(const persona of [undefined,{id:preset.id,builtin:false},{id:preset.id,builtin:'true'},
      {id:'custom-copy',name:preset.name,builtin:true}]){
      const view=resolvePersonaExpression(canonical,{channel:'chat',persona});
      for(const key of exampleFields)assert.equal(Object.hasOwn(view,key),false);
      assert.deepEqual(view.samples,canonical.samples);
    }
    for(const field of exampleFields){
      const polluted={...canonical,[field]:[{turns:[{speaker:'self',text:'PRIVATE_IMPORTED_EXAMPLE'}]}]};
      assert.equal(hasBuiltinExpressionProfile(polluted,owner(preset)),false);
      const view=resolvePersonaExpression(polluted,{channel:'chat',persona:owner(preset)});
      for(const key of exampleFields)assert.equal(Object.hasOwn(view,key),false);
      assert.doesNotMatch(JSON.stringify(view),/PRIVATE_IMPORTED_EXAMPLE/);
      assert.deepEqual(view.voice,canonical.voice);
    }
    const edited={...canonical,identity:canonical.identity+' 用户自己的改动'};
    const view=resolvePersonaExpression(edited,{channel:'chat',persona:owner(preset)});
    for(const key of exampleFields)assert.equal(Object.hasOwn(view,key),false);
  }
});

test('work examples introduce report evidence before the persona discussion rather than a synthetic memory record',()=>{
  for(const preset of BUILTIN_PRESETS){
    for(const group of chat(preset).workDialogueExamples){
      assert.equal(group.turns[0].speaker,'user');
      assert.match(group.turns[0].text,/报告/,'the source report is part of this fictional exchange');
      for(const turn of group.turns){
        assert.equal(Object.hasOwn(turn,'memory'),false);
        assert.equal(Object.hasOwn(turn,'evidence'),false);
        assert.equal(Object.hasOwn(turn,'sessionId'),false);
      }
    }
  }
});
