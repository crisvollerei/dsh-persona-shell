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

test('a third-person topic marker keeps the user mention without granting an independent invitation',()=>{
  for(const line of ['小肥鱼啊，她平时挺安静的。','小肥鱼嘛, 他刚走。','小肥鱼呢，这人最会起名。',
    '小肥鱼呀，那家伙跑得快。','小肥鱼啊，她说：“你能帮我吗？”','小肥鱼，她平时挺安静的。',
    '小肥鱼啊，她平时挺安静的，你觉得呢？','小肥鱼啊，她平时挺安静的，你怎么看？']){
    const value=options([line]);
    value.members=[{id:'reader',name:'小肥鱼'},...members.slice(1)];
    value.recipients=[value.members[2]];
    value.message='你觉得小肥鱼怎么样？';
    value.events[0].messages=[value.message];
    const body=JSON.parse(buildDirectorPrompt(value).user);
    assert.deepEqual(body.mentionedMembers.map(m=>m.id),['reader'],line);
    assert.equal(body.peerInvitations,undefined,line);
    assert.deepEqual(body.choices,[],line); // Ordinary opportunities are exhausted in this fixture.
  }
});

test('unpaired punctuation and inch marks leave later direct addresses visible',()=>{
  for(const line of ['这个是 12" 的屏幕。小克，你觉得怎样？','12" 比 8" 大。小克，来看看。',
    '（括号缺一边。小克，你觉得呢？','她刚说了“。小克，你觉得呢？'])
    assert.deepEqual(choices(options([line])).map(c=>c.id),['reader'],line);
  for(const line of ['她说“内层（小克，来看看）。”','她说「他喊『小克，来。』」','她说“内层（未闭合。小克，来看看。”'])
    assert.deepEqual(choices(options([line])),[],line);
});

test('a real request after a third-person clause must be covered by the peer evidence',()=>{
  const line='小克啊，她刚走，你能帮我叫她吗？';
  const value=options([line]);
  assert.deepEqual(choices(value).map(c=>c.id),['reader']);
  assert.equal(possiblePeerCall(members[0],value.events[1],members,{index:0,evidence:'小克啊，她刚走'}),false);
  assert.equal(possiblePeerCall(members[0],value.events[1],members,{index:0,evidence:line}),true);
  for(const [text,ids] of [['小克啊，你觉得呢？',['reader']],['@小克啊，她已经到了。',['reader']],
    ['小克啊，她刚走，猫猫，你能帮我叫她吗？',['cat']]])
    assert.deepEqual(choices(options([text])).map(c=>c.id),ids,text);
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

test('natural transitions, direct questions and an explicit gaze can grant one named listener a peer choice',()=>{
  for(const line of ['话说小克觉得呢？','对了，小克怎么看？','不过小克也来评评理。','要不让小克说说？',
    '顺便问问小克。','那小克要不要来？','（转头看小克）你也觉得吧？','(看向小克)你怎么看？']){
    const value=options([line]);
    assert.deepEqual(choices(value).map(c=>c.id),['reader'],line);
    assert.equal(possiblePeerCall(members[0],value.events[1],members,{index:0,evidence:line}),true);
  }
  for(const line of ['我觉得小克肯定懂。','“（看向小克）你怎么看？”','> （看向小克）你怎么看？',
    '（看向小克）天快黑了。','（提到小克）你怎么看？','她说「话说小克怎么看？」','你呢？'])
    assert.deepEqual(choices(options([line])),[],line);
  const gaze=options(['（看向小克）你怎么看？']);
  assert.equal(possiblePeerCall(members[0],gaze.events[1],members,{index:0,evidence:'你怎么看？'}),false);
});

test('broadcast and multiple addressees expose the same real peer invitation without a directed exchange',()=>{
  for(const recipients of [[],members.slice(0,2)]){
    const value={...options(['话说小克怎么看？']),recipients};
    const body=JSON.parse(buildDirectorPrompt(value).user);
    assert.equal(body.addressedExchange,undefined);
    assert.deepEqual(body.peerInvitations,[{choiceId:body.choices[0].choiceId,listener:'reader',from:'dragon',
      eventId:'e2',index:0,words:'话说小克怎么看？'}]);
  }
  const value=options(['话说小克怎么看？']);value.members=[...members,{id:'other-reader',name:'小克'}];
  assert.deepEqual(choices(value),[],'shared nicknames do not grant an independent opportunity');
});
