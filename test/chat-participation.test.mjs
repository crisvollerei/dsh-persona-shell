import test from 'node:test';
import assert from 'node:assert/strict';
import { buildParticipationPrompt,parseParticipation } from '../lib/chat-participation.js';
import { buildChatPrompt,publicChatExchange } from '../lib/chat-prompt.js';
import { BUILTIN_PRESETS } from '../lib/pack.js';
import { readChatInput } from './helpers/chat-input.mjs';

test('a participation decision accepts only a unique bounded subset and treats malformed decisions as silence',()=>{
  assert.deepEqual(parseParticipation('{"participants":["b"]}',['b','c'],2),['b']);
  for(const wire of ['{"participants":["b","b"]}','{"participants":["a"]}','{"participants":["b","c"]}',
    '{"participants":["b"],"reason":"secret"}','```json\n{"participants":["b"]}\n```','broken']){
    assert.deepEqual(parseParticipation(wire,['b','c'],1),[]);
  }
});

test('listener decisions receive bounded role summaries and public speech only',()=>{
  const result=buildParticipationPrompt({message:'一起聊',exchange:[{speaker:{id:'a',name:'甲'},messages:['公开回应']}],
    candidates:[{id:'b',name:'乙',pack:{identity:'x'.repeat(500),voice:['y'.repeat(100),'第二条','DO_NOT_INCLUDE_THIRD'],samples:['PRIVATE_SAMPLE']},memory:['PRIVATE_MEMORY']}],limit:1});
  const value=JSON.parse(result.user);assert.equal(value.candidates[0].identity.length,240);assert.equal(value.candidates[0].voice.length,2);
  assert.equal(value.candidates[0].voice[0].length,80);assert.doesNotMatch(result.user,/PRIVATE|DO_NOT_INCLUDE/);
  assert.deepEqual(Object.keys(value).sort(),['candidates','exchange','history','limit','message','recipients']);
});

test('collaborative prompts distinguish completed public speech from persona memories and do not invent other speakers',()=>{
  const canonical = { messageId:'current',user:'讨论',roomId:'room',scopeKey:null };
  const turns=[{...canonical,id:'turn-a',attemptId:'attempt-a',status:'ready',recipientId:'a',speakerName:'甲',assistant:['甲的公开观点'],privateMemory:'NEVER_SHARE'},
    {...canonical,id:'turn-b',attemptId:'attempt-b',status:'failed',recipientId:'b',speakerName:'乙',assistant:['UNFINISHED_SECRET']}];
  assert.deepEqual(publicChatExchange(turns),[{speaker:{id:'a',name:'甲'},messages:['甲的公开观点']}]);
  const result=buildChatPrompt({pack:BUILTIN_PRESETS[0].pack,history:[],message:'讨论',roomId:'room',speaker:{id:'b',name:'乙'},
    currentTurn:turns[1],exchange:turns,phase:'reaction'});
  assert.doesNotMatch(JSON.stringify(result.messages),/NEVER_SHARE|UNFINISHED_SECRET/);assert.match(result.system,/旁听后选择接话/);
  const input=readChatInput(result);assert.deepEqual(input.exchange.map(event=>event.messages),[['甲的公开观点']]);
  assert.match(result.system,/不替同伴编台词、心理、沉默原因或承诺/);assert.equal(input.phase,'reaction');
});

test('public speech budgets keep whole messages and never turn an unfinished preview into context',()=>{
  const first={status:'ready',recipientId:'a',speakerName:'甲',assistant:['较早的完整回应']},last={status:'ready',recipientId:'b',speakerName:'乙',assistant:['最近回应']};
  assert.deepEqual(publicChatExchange([first,last],4),[{speaker:{id:'b',name:'乙'},messages:['最近回应']}]);
  assert.deepEqual(publicChatExchange([{...first,assistant:['x'.repeat(6001)]}]),[]);
  const long={...last,assistant:['首'.repeat(2000),'续'.repeat(2000),'末'.repeat(100)]};
  const visible=publicChatExchange([first,long],4000);
  assert.deepEqual(visible.map(v=>v.speaker.id),['a','b']);
  assert.deepEqual(visible[1].messages,[long.assistant[2]]);
  assert.equal(visible[1].earlierBubblesOmitted,true);
});
