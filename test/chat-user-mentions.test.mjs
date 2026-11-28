import test from 'node:test';
import assert from 'node:assert/strict';
import { directedOpinionHandback, userMentions } from '../lib/chat-director.js';
import { buildDirectorRequest } from '../lib/chat-director-wire.js';

const big = '大肥鱼（默认）', little = '鲸鲸（实验性）', dragon = '大肥龙';
const members = [big, little, 'Gemini', dragon, 'Claude小姐'].map(id => ({
  id, name: id === little ? '小肥鱼（实验性）' : id, builtin: true
}));
const recipients = [members[0]];
const original = '（交换）衣服好像有点大呢...可能我的体型和小肥鱼更接近';
const user = (...messages) => ({ id: 'user-turn', author: { role:'user' }, messages });
const reply = (id, index = 0) => ({ id: 'reply-' + id, author: { role:'assistant', id, name:id },
  messages: ['说完了。'], replyTo: { to:'user', eventId:'user-turn', index } });
const options = (events) => ({ members, recipients, events, message:events[0].messages.join('\n'),
  states:members.map(({id}) => ({id, level:2, normalReady:true, normalRemaining:1, peerReady:false, peerRemaining:1,
    pendingEventIds:events.map(e=>e.id), normalPendingEventIds:['user-turn']})) });
const read = opts => JSON.parse(buildDirectorRequest(opts).user);

for (const [line, targets, expected] of [
  [original,recipients,[[little,'小肥鱼']]],
  ['我想穿穿大肥鱼的衣服',recipients,[]],
  ['我想穿穿小肥鱼的衣服',[],[[little,'小肥鱼']]],
  ['大肥龙和小肥鱼你们觉得呢',recipients,[[dragon,'大肥龙'],[little,'小肥鱼']]],
  ['🐳（交换时看向小肥鱼）(大肥龙也在)',recipients,[[little,'小肥鱼'],[dragon,'大肥龙']]],
  ['姐姐的衣服在这里',[],[[big,'姐姐']]],
  ['她说“小肥鱼也想来”，又说「『大肥龙』和‘猫猫’也来」和"小克"',[],[]],
  ['> 小肥鱼：我先走了\n她刚才这么说',[],[]],
  ['  > “小肥鱼\n那大肥龙呢？',[],[[dragon,'大肥龙']]]
]) test('locates members in the original user part: '+line, () => {
  const result = userMentions(user(line), members, targets);
  assert.deepEqual(result,expected.map(([id,word]) => ({id,index:0,span:{start:line.indexOf(word),end:line.indexOf(word)+word.length}})));
});

test('longest names claim overlapping positions, including targeted or ambiguous names', () => {
  const [long, short, other, single] = ['小肥鱼','肥鱼','小肥鱼','鱼'].map((name,id)=>({id:String(id),name}));
  const parts = user('小肥鱼，小肥鱼。','肥鱼和鱼。');
  assert.deepEqual(userMentions(parts,[long,short,other,single]),[{id:short.id,index:1,span:{start:0,end:2}}]);
  assert.deepEqual(userMentions(parts,[long,short,single],[long]),[{id:short.id,index:1,span:{start:0,end:2}}]);
  assert.deepEqual(userMentions(user('甲乙丙丁'),[{id:'a',name:'甲乙'},{id:'b',name:'乙丙丁'}]),[{id:'b',index:0,span:{start:1,end:4}}]);
  assert.deepEqual(userMentions(user('🐳'),[{id:'w',name:'🐳'}]),[]);
  assert.deepEqual(userMentions(user('小肥鱼'),members.filter(p=>p.id!==little)),[]);
  assert.deepEqual(userMentions({...user('小肥鱼'),author:{role:'assistant',id:big}},members),[]);
});

test('first public occurrence wins across aliases and across parts', () => {
  const line = '“鲸鲸”说：姐姐和大肥鱼都指她。';
  const start = line.indexOf('姐姐');
  assert.deepEqual(userMentions(user(line,'我也问问鲸鲸'),members),[{id:big,index:0,span:{start,end:start+2}}]);
});

test('the photographed exchange marks the listener and retains only ordinary, scheduler-authorized choices', () => {
  const opts=options([user(original),reply(big)]), body=read(opts);
  assert.deepEqual(body.mentionedMembers,[{id:little,eventId:'e1',index:0,words:'小肥鱼'}]);
  assert.deepEqual(body.turnFloor.repliedParts,[{index:0,lastDirectReply:'e2',selectedWithoutDirectReply:[],mentionedWithoutReply:[little]}]);
  const choices=body.choices.filter(c=>c.id===little);
  assert.equal(choices.length,1);
  assert.deepEqual([choices[0].kind,choices[0].to,choices[0].eventId,choices[0].index],['normal','user','e1',0]);
  assert.equal(body.peerInvitations,undefined);
  for (const override of [{normalReady:false},{normalRemaining:0,level:3}]) {
    const blocked=read({...opts,states:opts.states.map(s=>s.id===little?{...s,...override}:s)});
    assert.deepEqual(blocked.mentionedMembers,body.mentionedMembers);
    assert.ok(!blocked.choices.some(c=>c.id===little));
  }
  assert.equal(buildDirectorRequest(opts).parse('WAIT').waitForUser,true);
});

test('only the named part is marked, and a later reply to anyone consumes the reminder', () => {
  const turn=user('大肥龙的呢？',original), first=reply(big,1), opts=options([turn,first,reply('Gemini')]);
  assert.deepEqual(read(opts).turnFloor.repliedParts.map(part=>[part.index,part.mentionedWithoutReply]),[[1,[little]],[0,[dragon]]]);
  const earlier = {...reply(little),id:'earlier'};
  const peer = {...reply(little),replyTo:{to:big,eventId:first.id,index:0}};
  const part = events=>read({...opts,events}).turnFloor.repliedParts.find(p=>p.index===1);
  assert.deepEqual(part([earlier,...opts.events]).mentionedWithoutReply,[little]);
  assert.ok(!Object.hasOwn(part([...opts.events,peer]),'mentionedWithoutReply'));
});

test('an ordinary opinion is allowed for the named member; bystander handback still applies', () => {
  const action={id:little,kind:'normal',to:'user',evidence:{eventId:'user-turn',index:0},contribution:{move:'opine'}};
  const opts=options([user(original),reply(big),reply(dragon)]);
  assert.equal(directedOpinionHandback(opts,action),false);
  // A relationship-only address still belongs to the listener when another member is the primary.
  const opinion={...opts,recipients:[members[3]],events:[user('你觉得姐姐怎么样？'),reply(dragon),reply('Gemini')]};
  assert.equal(directedOpinionHandback(opinion,{...action,id:big}),false);
  const clear={...opts,events:[user('你觉得小克怎么样？'),reply(big),reply(dragon)]};
  assert.equal(directedOpinionHandback(clear,{...action,id:'Claude小姐'}),false);
  assert.equal(directedOpinionHandback(clear,action),true);
});
