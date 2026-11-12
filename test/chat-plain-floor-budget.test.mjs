import test from 'node:test';
import assert from 'node:assert/strict';
import {parseChatDecision} from '../lib/persona-chat.js';
import {partialChatReply} from '../lib/chat-live.js';
import {resolveChatQuote} from '../lib/chat-quote.js';
import {fixture,whale,dragon,reply,newRoom,roomSend,settledRoom,readChatInput} from './helpers/persona-chat-host.mjs';

const budget={bubbles:2,chars:600},lead='（尾巴起了个弧）',sound='「唔——」',after='三瓣慢慢收回来。🐾';
const wire=lead+'\n\n'+sound+'\r\n \t\r\n'+after,expected=[lead,sound+'\r\n \t\r\n'+after];

test('short peer text keeps the exact remaining paragraphs in its last open bubble through every streamed prefix',()=>{
  assert.deepEqual(parseChatDecision(wire,budget).messages,expected);
  assert.deepEqual(parseChatDecision(wire).messages,[lead,sound,after],'ordinary unbounded-by-role layout has not changed');
  let last=[];
  for(let cut=0;cut<=wire.length;cut++){
    const parts=partialChatReply(wire.slice(0,cut),budget);
    assert.ok(parts.length<=2);
    for(const [i,p] of parts.entries()){
      assert.ok(expected[i].startsWith(p.text));assert.ok(p.text.startsWith(last[i]?.text??''));
      assert.equal(p.complete,i<parts.length-1);assert.ok(p.text.isWellFormed());
    }
    last=parts;
  }
  assert.deepEqual(last.map(p=>p.text),expected);
  const structured=JSON.stringify({messages:[lead,sound,after]});
  assert.deepEqual(parseChatDecision(structured,budget).messages,[lead,sound,after],'explicit bubble boundaries go through unchanged for Host validation');
  assert.equal(parseChatDecision('{"messages":["broken"',budget),undefined);
});

const raw=(value,finish='stop')=>(async function*(){yield{type:'text-delta',index:0,text:value};yield{type:'finish',reason:{kind:finish}};})();
async function roomPair(t,peerWire,finish='stop'){
  const f=fixture(t,{directorScript:options=>{
    const value=readChatInput(options),said=value.events.filter(e=>e.author.role==='assistant');
    const choice=!said.length?value.choices.find(c=>c.id===dragon&&c.to==='user')
      :said.length===1?value.choices.find(c=>c.id===whale&&c.kind==='peer'&&c.to===dragon):null;
    return raw(choice?choice.choiceId:'WAIT');
  },script:options=>readChatInput(options).speaker.id===dragon?reply(['鲸鲸，给这个图案配个声音吧。']):raw(peerWire,finish)});
  await f.ready();const binding=await newRoom(f,[dragon,whale],'图案和声音','peer-sound-room');
  await roomSend(f,binding,dragon,'请叫鲸鲸给一个花纹配声音。','peer-sound');
  const {room}=await settledRoom(f,binding),turns=room.turns.filter(t=>t.phase!=='anchor');
  assert.equal(f.calls.length,2);assert.deepEqual(turns.map(t=>t.recipientId),[dragon,whale]);return {room,turns};
}
test('after stop the exact rendered peer bubbles become the only citable public positions',async t=>{
  const {room,turns}=await roomPair(t,wire),turn=turns[1];
  assert.equal(turn.status,'ready');assert.deepEqual(turn.assistant,expected);
  const quote=index=>resolveChatQuote(room,{roomId:room.id,kind:'assistant',turnId:turn.id,attemptId:turn.attemptId,index},turn.scopeKey??turn.contextKey??null);
  assert.equal(quote(0).text,lead);assert.equal(quote(1).text,expected[1]);assert.equal(quote(2),null);
});
for(const [label,value,finish,reason] of [
  ['preserved paragraph separators count toward the role character budget','甲'.repeat(300)+'\n\n'+'乙'.repeat(299)+'\n\n丙','stop','too-long'],
  ['an explicit third JSON bubble is not reinterpreted as a paragraph',JSON.stringify({messages:[lead,sound,after]}),'stop','too-long'],
  ['a truncated plain stream does not publish the otherwise usable paragraphs',wire,'max-tokens','length'],
])test(label,async t=>{
  const {turns}=await roomPair(t,value,finish),turn=turns[1];
  assert.equal(turn.status,'failed');assert.equal(turn.failure,reason);assert.deepEqual(turn.assistant,[]);
});
