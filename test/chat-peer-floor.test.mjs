import assert from 'node:assert/strict';
import test from 'node:test';
import {buildDirectorPrompt,parseDirector,possiblePeerCall} from '../lib/chat-director.js';

const members=[{id:'reader',name:'小克'},{id:'cat',name:'猫猫'},{id:'dragon',name:'GPT'}];
function options(messages){
  const events=[{id:'user',author:{role:'user',name:'我'},messages:['我能试试这件吗？']},
    {id:'reply',author:{role:'assistant',id:'dragon',name:'GPT'},messages}];
  return {message:events[0].messages[0],members,events,states:members.slice(0,2).map(p=>({id:p.id,level:3,
    normalRemaining:0,normalReady:false,peerReady:true,peerRemaining:1,pendingEventIds:['reply'],normalPendingEventIds:[]}))};
}
const choices=value=>JSON.parse(buildDirectorPrompt(value).user).choices;
test('a public remark to the user cannot reopen someone else just by naming them',()=>{
  for(const messages of [
    ['小克那种长到脚边的，我怕踩到。','你更在意长度还是颜色？'],
    ['小克肯递，你就换。腰带可以先松一点。'],
    ['你可以去问小克，她知道怎么收。'],
    ['我记得她问过：“小克，借我看看。”','（站在小克身边）你自己挑。'],
    ['> 小克，你上次穿哪件？\n我想知道你自己怎么选。'],
    ['小克、猫猫平时都爱挑颜色。'],
  ])assert.deepEqual(choices(options(messages)),[],messages.join('\n'));
});
test('actual invitations and casual asides admit the addressed members without requiring a question',()=>{
  for(const [line,who] of [
    ['小克，扶我一下。',['reader']],['（腾出半步）小克借我一盏灯。',['reader']],
    ['这儿给你留着呢，小克。',['reader']],['猫猫和小克，你们先挑。',['cat','reader']],
    ['小克、猫猫，你们俩一个比一个认真。',['cat','reader']],['@小克 这边有夹子。',['reader']],
    ['猫猫先前也试过。小克你来挑。',['reader']],
  ])assert.deepEqual(choices(options([line])).map(c=>c.id).sort(),who,line);
});
test('a valid address in another bubble or far from a mention cannot authorize that old remark',()=>{
  const mention='小克那边也有一盏灯',call='小克，借我灯夹。';
  const value=options([mention+'，要问哪盏？',mention+'。'+'甲'.repeat(1700)+'。'+call]);
  const [choice]=choices(value);
  assert.equal(choice.index,1);
  const result=parseDirector(JSON.stringify({choiceId:choice.choiceId}),value);
  assert.equal(result.basis,'model');assert.ok(result.next.evidence.text.includes(call));
  for(const [index,evidence] of [[0,mention],[1,mention]]){
    assert.equal(possiblePeerCall(members[0],value.events[1],members,{index,evidence}),false);
    const next={...result.next,evidence:{eventId:'reply',index,text:evidence}};
    assert.equal(parseDirector(JSON.stringify({context:null,next}),value).reason,'peer-call');
  }
  assert.equal(possiblePeerCall(members[0],value.events[1],members,{index:1,evidence:call}),true);
});
