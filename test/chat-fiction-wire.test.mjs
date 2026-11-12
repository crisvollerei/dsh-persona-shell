import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDirectorRequest,parseDirectorResponse} from '../lib/chat-director-wire.js';
import {projectSceneDirection} from '../lib/chat-fiction.js';
import {chatSchedulerEventKey} from '../lib/chat-scheduler.js';

function setup({roomId='room',scope=null,message='一起想象雨夜的旧车站，先看看站台的灯。',peerText='甲甲，站台那边的灯你怎么看？'}={}){
  const event=turnId=>chatSchedulerEventKey({roomId,generation:2,sourceScope:scope,turnId,attemptId:turnId});
  const user=event('user'),peer=event('peer');
  return {message,members:[{id:'fish',name:'甲甲'},{id:'dragon',name:'乙乙'}],
    events:[{id:user,author:{role:'user',name:'我'},messages:[message]},
      {id:peer,author:{role:'assistant',id:'dragon',name:'乙乙'},messages:[peerText]}],
    states:[{id:'fish',level:0,normalRemaining:3,peerRemaining:1,normalReady:true,peerReady:true,
      pendingEventIds:[user,peer],normalPendingEventIds:[user]}],
    sources:[{id:'source-a',name:'可选工作来源'}],sourceIds:['source-a']};
}
const view=options=>JSON.parse(buildDirectorRequest(options).user);
const line=(options,{kind='normal',work='N',scene='-',move='develop',point='先由本人接住站台的灯这个话头。'}={})=>{
  const choice=view(options).choices.find(value=>value.kind===kind);assert.ok(choice,kind);
  return `${choice.choiceId} ${work} ${scene} ${move} | ${point}`;
};
const proposal='先围绕站台的灯展开一点，不预定谁走过去或最后发生什么。';
const attach=(first,direction=proposal)=>first+'\nSCENE | '+direction;
const withoutDirection=result=>({...result,next:result.next?Object.fromEntries(Object.entries(result.next).filter(([key])=>key!=='sceneDirection')):null});

test('SCENE is an optional next-actor proposal after the existing normal or peer selection has fully validated',()=>{
  const options=setup(),before=structuredClone(options);
  for(const kind of ['normal','peer']){
    const first=line(options,{kind}),original=parseDirectorResponse(first,options),result=parseDirectorResponse(attach(first),options);
    assert.equal(original.basis,'model');assert.equal(result.basis,'model');assert.equal(result.next.kind,kind);
    assert.equal(result.next.sceneDirection,proposal);assert.deepEqual(withoutDirection(result),original);
    assert.equal(result.context.work,'not-needed');assert.deepEqual(result.context.sourceIds,[]);
    assert.equal(result.next.evidence.eventId,options.events[kind==='normal'?0:1].id);
  }
  const peerOnly={...options,states:options.states.map(state=>({...state,normalReady:false,normalRemaining:0,level:3}))};
  assert.equal(parseDirectorResponse(attach(line(peerOnly,{kind:'peer'})),peerOnly).next.kind,'peer','a real independent peer invitation does not become an ordinary quota');
  assert.deepEqual(options,before);
});

test('legacy complete first-line routes and finite scene keys keep their own semantics when the optional proposal is present',()=>{
  const options={...setup(),sceneCatalog:{options:[{key:'F',relation:'fresh'}],topics:[],current:null,omittedTopics:0}},body=view(options),choice=body.choices[0].choiceId;
  for(const first of [line(options,{scene:'F'}),`${choice} N F`,`${choice} N`,`D1 ${body.protocol.ticket} ${choice} N open -`]){
    const original=parseDirectorResponse(first,options),result=parseDirectorResponse(attach(first),options);
    assert.equal(result.basis,'model',first);assert.deepEqual(withoutDirection(result),original);
  }
  const scene=parseDirectorResponse(attach(line(options,{scene:'F'})),options);assert.equal(scene.sceneKey,'F');
  assert.equal(parseDirectorResponse(attach(line(options,{scene:'invented'})),options).basis,'invalid');
  const json=JSON.stringify({choiceId:choice,context:{work:'not-needed',sourceIds:[],request:'open',evidence:''}});
  assert.equal(parseDirectorResponse(json,options).basis,'model');
  assert.equal(parseDirectorResponse(attach(json),options).basis,'invalid','a trailing line does not repair or reinterpret complete JSON');
});

test('scene directions retain a strict whole-line boundary and validate raw controls and the 240-character cap before trim',()=>{
  const options=setup(),first=line(options);
  assert.equal(parseDirectorResponse(attach(first,'甲'),options).next.sceneDirection,'甲');
  assert.equal(parseDirectorResponse(attach(first,'甲'.repeat(240)),options).next.sceneDirection.length,240);
  assert.equal(parseDirectorResponse(attach(first,'  先看灯。  '),options).next.sceneDirection,'先看灯。');
  for(const raw of ['', ' ', '甲'.repeat(241),...['\t','\r','\n','\u0000','\u007f','\u0085','\u2028','\u2029'].flatMap(control=>
    [control+'提议','提'+control+'议',...(control==='\n'?[]:['提议'+control])])]){
    const result=parseDirectorResponse(attach(first,raw),options);assert.equal(result.basis,'invalid',JSON.stringify(raw));assert.equal(result.next,null);
  }
  for(const wire of [first+'\nSCENE| '+proposal,first+'\nscene | '+proposal,first+'\n SCENE | '+proposal,
    attach(first)+'\nWAIT',attach(first)+'\nSCENE | 再补一段。',first+'\n\nSCENE | '+proposal,'前言\n'+attach(first)]){
    assert.equal(parseDirectorResponse(wire,options).basis,'invalid',wire);
  }
  for(const wire of ['  \n'+attach(first)+'\n  ','```d1\n'+attach(first)+'\n```',attach(first).replace('\n','\r\n')]){
    assert.equal(parseDirectorResponse(wire,options).next.sceneDirection,proposal,'only outer presentation whitespace or a single existing fence is tolerated');
  }
});

test('WAIT, IDLE, omitted or unclear work and actual work selection cannot acquire a scene proposal',()=>{
  const options=setup(),body=view(options),choice=body.choices[0].choiceId;
  for(const first of ['WAIT','IDLE',`D1 ${body.protocol.ticket} WAIT`,`D1 ${body.protocol.ticket} IDLE`,choice,
    line(options,{work:'U'}),line(options,{work:'s1'}),line(options,{work:'s9'}),'forged N - develop | 一句话。']){
    const result=parseDirectorResponse(attach(first),options);assert.equal(result.basis,'invalid',first);assert.equal(result.next,null);
    assert.equal(result.waitForUser,false);assert.deepEqual(result.context.sourceIds,[]);
  }
  assert.equal(parseDirectorResponse('WAIT',options).waitForUser,true);
  assert.equal(parseDirectorResponse('IDLE',options).waitForUser,false);
  assert.equal(parseDirectorResponse(line(options,{work:'s1'}),options).context.work,'required','a normal non-fiction work response is unchanged');
});

test('a scene proposal cannot bypass cooldown, spent budgets, peer invitations, source scope or the current room and input',()=>{
  const options=setup(),normal=attach(line(options)),peer=attach(line(options,{kind:'peer'}));
  for(const changed of [setup({roomId:'elsewhere'}),setup({scope:'different-source-scope'}),setup({message:'改题，直接聊午饭。'}),
    {...options,events:[]},
    {...options,states:options.states.map(state=>({...state,normalReady:false,peerReady:false}))},
    {...options,states:options.states.map(state=>({...state,level:3,normalRemaining:0,peerRemaining:0,peerReady:false}))}]){
    assert.equal(parseDirectorResponse(normal,changed).basis,'invalid');assert.equal(parseDirectorResponse(peer,changed).basis,'invalid');
  }
  assert.equal(parseDirectorResponse(peer,setup({peerText:'站台那边灯亮着。'})).basis,'invalid');
  const changed={...options,sources:[{id:'new-source',name:'更换来源'}],sourceIds:['new-source']},body=view(options),choice=body.choices[0].choiceId;
  assert.equal(parseDirectorResponse(attach(`D1 ${body.protocol.ticket} ${choice} N open -`),changed).basis,'invalid','the full D1 ticket still binds its source catalogue');
  assert.deepEqual(withoutDirection(parseDirectorResponse(normal,changed)),parseDirectorResponse(line(options),changed),
    'a compact N response keeps its existing no-work-source contract rather than silently gaining a new ticket');
});

test('directions do not mutate choice tickets, carry across later responses or reinterpret literal control-looking prose',()=>{
  const options=setup(),original=view(options),wire=line(options),result=parseDirectorResponse(attach(wire,'先误听成 WAIT | SCENE，再顺着现场重想。'),options);
  assert.equal(result.basis,'model');assert.equal(result.next.id,'fish');
  assert.equal(result.next.sceneDirection,'先误听成 WAIT | SCENE，再顺着现场重想。');
  assert.deepEqual(view(options),original,'ephemeral next data never enters a projection or ticket');
  result.next.sceneDirection='调用者手动改值。';
  assert.equal(parseDirectorResponse(wire,options).next.sceneDirection,undefined);
  assert.equal(parseDirectorResponse(attach(wire,'这次只换一个方向。'),options).next.sceneDirection,'这次只换一个方向。');
  assert.equal(parseDirectorResponse(attach(wire),setup({message:'后来用户已经换题。'})).basis,'invalid');
});

test('the public director brief makes the second line optional fiction guidance rather than a required task or established state',()=>{
  const result=buildDirectorRequest(setup());
  assert.match(result.system,/公开原话明确在共同想象或角色扮演/);assert.match(result.system,/work=N且选出有效下一位/);
  assert.match(result.system,/普通闲聊、问候或工作不必给/);assert.match(result.system,/WAIT\/IDLE或取工作资料时不附/);
  assert.match(result.system,/不是场景已成立的事实/);assert.match(result.system,/不预写角色台词、用户动作或结局/);
  assert.match(result.system,/用户改题时按新现场重想，不维护永久世界状态/);
  assert.doesNotMatch(result.system,/不加标签、解释、代码围栏或第二行/);
  assert.doesNotMatch(result.user,/sceneDirection|永久世界|短程参考方向/,'no example proposal or extra authority enters public evidence');
});

test('the actor-facing proposal envelope remains bounded to the exact current actor, user cycle, room, scope and original target',()=>{
  const sourceRef={roomId:'room',generation:2,kind:'user',messageId:'now'},timeline={replyTarget:{eventId:'event-now',index:0},
    timeline:[{eventId:'event-now',messageId:'now',author:{role:'user',name:'我'},bubbles:[{index:0,ref:sourceRef}]}]},
    context={roomId:'room',generation:2,scopeKey:'scope',messageId:'now',actorId:'fish',timeline},
    value={text:proposal,roomId:'room',generation:2,scopeKey:'scope',messageId:'now',actorId:'fish',sourceRef};
  assert.deepEqual(projectSceneDirection(value,context),{text:proposal,source:{eventId:'event-now',index:0}});
  for(const patch of [{roomId:'elsewhere'},{generation:1},{scopeKey:'other'},{messageId:'later'},{actorId:'dragon'},
    {sourceRef:{...sourceRef,messageId:'old'}},{text:'甲'.repeat(241)},{text:'第一行\n第二行'}])assert.equal(projectSceneDirection({...value,...patch},context),undefined);
  for(const replacement of [{...timeline,replyTarget:null},{...timeline,replyTarget:{eventId:'missing',index:0}},
    {...timeline,replyTarget:{eventId:'event-now',index:1}}, {...timeline,timeline:[]}])assert.equal(projectSceneDirection(value,{...context,timeline:replacement}),undefined);
  assert.equal(projectSceneDirection(undefined,context),undefined,'a later call without an envelope never inherits a prior proposal');
});
