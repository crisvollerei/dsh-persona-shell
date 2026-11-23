import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDirectorRequest,parseDirectorResponse} from '../lib/chat-director-wire.js';
import {directedOpinionHandback} from '../lib/chat-director.js';
import {chatSchedulerEventKey} from '../lib/chat-scheduler.js';

const key=(turnId,roomId='r')=>chatSchedulerEventKey({roomId,generation:2,sourceScope:'this-source',turnId,attemptId:turnId});
const members=['owner','friend','guest'].map(id=>({id,name:id}));
const user=(turnId,messages)=>({id:key(turnId),author:{role:'user'},messages});
const original=user('u',['能借你的画册吗？','对了，第二本叫什么？']);
const reply=(id,who,ref,index=0)=>({id:key(id),author:{role:'assistant',id:who,name:who},messages:['给，翻着看。'],
  replyTo:{to:'user',eventId:ref,index}});
const options=(events,recipients=members.slice(0,2))=>({message:events.findLast(event=>event.author.role==='user').messages.join('\n'),events,recipients,members,
  states:members.map(({id})=>({id,level:1,normalReady:true,normalRemaining:2,peerReady:false,peerRemaining:1,
    pendingEventIds:events.map(e=>e.id),normalPendingEventIds:events.map(e=>e.id)}))});
const read=opts=>JSON.parse(buildDirectorRequest(opts).user);

test('a published answer gives the judge a hand-back cue for its exact user part, without removing a second invitation or a bystander choice',()=>{
  const data=options([original,reply('answer','owner',original.id)]);
  const body=read(data);
  assert.deepEqual(body.turnFloor,{userEventId:'e1',repliedParts:[{index:0,lastDirectReply:'e2',selectedWithoutDirectReply:['friend']}]});
  for(const [id,index] of [['friend',0],['guest',0],['friend',1]]){
    const choice=body.choices.find(c=>c.id===id&&c.index===index&&c.kind==='normal');
    assert.equal(parseDirectorResponse(choice.choiceId+' N',data).next.id,id);
  }
  assert.equal(parseDirectorResponse('WAIT',data).waitForUser,true);
  const room=read({...data,recipients:[]});
  assert.deepEqual(room.turnFloor.repliedParts,[{index:0,lastDirectReply:'e2'}]);
});

test('no hand-back is inferred from an unbound mention, wrong bubble, other room, missing originals or a new user turn',()=>{
  const answer=reply('answer','owner',original.id);
  const otherRoom={...answer,id:key('answer','another-room')};
  const unbound={...answer,replyTo:undefined};
  const newUser=user('u2',['我看到了，再给我讲讲第二页。']);
  for(const events of [[original],[original,unbound],[original,otherRoom],[original,reply('bad','owner',original.id,5)],
    [newUser,answer],[original,answer,newUser]]){
    assert.equal(read(options(events)).turnFloor,undefined);
  }
});

test('a single addressee and an actual aside stay distinct per user part, while room discussion keeps its existing choices',()=>{
  const primary=reply('answer','owner',original.id);
  const aside=reply('aside','friend',original.id);
  const anotherPart=reply('other-part','guest',original.id,1);
  const opts=options([original,primary,aside,anotherPart],members.slice(0,1));
  assert.deepEqual(read(opts).addressedExchange,{addressee:'owner',userEventId:'e1',parts:[{
    index:0,addressedReplies:['e2'],otherReplies:['e3'],
  }]});
  assert.equal(read({...opts,recipients:[]}).addressedExchange,undefined);
  assert.equal(read({...opts,recipients:members.slice(0,2)}).addressedExchange,undefined);
  assert.equal(read(options([original,aside],members.slice(0,1))).addressedExchange,undefined);
  assert.doesNotThrow(()=>parseDirectorResponse('WAIT',opts));
});

test('only a further ordinary opinion on the same clear one-person question hands the turn back',()=>{
  const question=user('opinion',['那你觉得小克怎么样？']);
  const primary=reply('answer','owner',question.id);
  const aside=reply('aside','friend',question.id);
  const opts={...options([question,primary,aside],members.slice(0,1)),
    members:members.map(person=>person.id==='friend'?{...person,name:'小克'}:person)};
  const action={id:'guest',kind:'normal',to:'user',evidence:{eventId:question.id,index:0},contribution:{move:'opine'}};
  assert.equal(directedOpinionHandback(opts,action),true);
  for(const change of [{id:'friend'},{kind:'peer',to:'friend'},{contribution:{move:'branch'}},
    {evidence:{eventId:original.id,index:0}},{support:{template:'reason'}},{contribution:{move:'react'}}]){
    assert.equal(directedOpinionHandback(opts,{...action,...change}),false);
  }
  for(const change of [{recipients:[]},{recipients:members.slice(0,2)},{events:[question,aside]},
    {events:[question,primary,{...aside,id:key('aside','another-room')}]},
    {events:[{...question,messages:['那你觉得小克怎么样？','其他人也说说。']},primary,aside]},
    {events:[{...question,messages:['你觉得小克怎么样，大家也说说？']},primary,aside]}]){
    assert.equal(directedOpinionHandback({...opts,...change},action),false);
  }
});

test('stopping on the only already-selected scene neither selects a source nor edits a scene; other abbreviated actions fail closed',()=>{
  const ref={roomId:'r',generation:2,kind:'user',messageId:'u'};
  const current={version:1,trigger:ref,focus:ref,relation:'continue',parked:null,transition:null};
  const catalog={current,topics:[],options:[{key:'K',relation:'continue'}]};
  const opts={...options([original]),sources:[{id:'work',name:'工作参考'}],sourceIds:['work'],sceneCatalog:catalog};
  for(const stop of ['WAIT','IDLE']){
    assert.deepEqual(parseDirectorResponse(stop+' K',opts),parseDirectorResponse(stop,opts));
    for(const sceneCatalog of [undefined,{...catalog,current:null},{...catalog,options:[{key:'K',relation:'fresh'}]},
      {...catalog,options:[...catalog.options,{key:'F',relation:'fresh'}]}]){
      assert.equal(parseDirectorResponse(stop+' K',{...opts,sceneCatalog}).basis,'invalid');
    }
  }
  for(const bad of ['WAIT F','WAIT s1','WAIT K | 接着聊','WAIT K\nSCENE | 继续','WAIT K K','WAIT\nK']){
    assert.equal(parseDirectorResponse(bad,opts).basis,'invalid');
  }
});
