import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDirectorRequest,parseDirectorResponse } from '../lib/chat-director-wire.js';
import { chatSchedulerEventKey } from '../lib/chat-scheduler.js';

function setup(roomId='room') {
  const id=chatSchedulerEventKey({roomId,generation:0,sourceScope:null,turnId:'user',attemptId:'user'});
  return {message:'帮我看看项目甲。先别执行。',recipients:[],members:[{id:'fish',name:'鲸鲸'}],
    events:[{id,author:{role:'user',name:'我'},messages:['帮我看看项目甲。先别执行。']}],
    states:[{id:'fish',level:0,normalRemaining:3,peerRemaining:1,normalReady:true,peerReady:false,pendingEventIds:[id],normalPendingEventIds:[id]}],
    sources:[{id:'source-a',name:'项目甲'},{id:'source-b',name:'项目乙'}],sourceIds:['source-a','source-b']};
}
const body=options=>JSON.parse(buildDirectorRequest(options).user);
const response=(options,{action,work='N',request='open',evidence='-'}={})=>{
  const view=body(options);return `D1 ${view.protocol.ticket} ${action??view.choices[0].choiceId} ${work} ${request} ${evidence}`;
};

test('finite control chooses locally-bound actor/evidence and reads only selected attached work sources',()=>{
  const options=setup(),view=body(options),result=parseDirectorResponse(response(options,{work:'s2+s1',request:'answer',evidence:'q1'}),options);
  assert.equal(result.basis,'model');assert.equal(result.next.id,'fish');
  assert.equal(result.next.to,'user');assert.equal(result.next.evidence.eventId,options.events[0].id);
  assert.deepEqual(result.context.sourceIds,['source-b','source-a']);assert.equal(result.context.evidence,'帮我看看项目甲。');
  assert.deepEqual(view.sourceKeys,[{key:'s1',id:'source-a'},{key:'s2',id:'source-b'}]);
  assert.ok(view.userEvidence.every(item=>Object.keys(item).length===3),'evidence menu stores offsets rather than repeated quotations');
});

test('WAIT and IDLE are distinct complete decisions with no invented next speaker',()=>{
  const options=setup();for(const action of ['WAIT','IDLE']) {
    const value=parseDirectorResponse(response(options,{action}),options);
    assert.equal(value.basis,'model');assert.equal(value.next,null);assert.equal(value.waitForUser,action==='WAIT');
    assert.equal(value.context.work,'not-needed');assert.deepEqual(value.context.sourceIds,[]);
  }
});

test('explicit compact stops and a bound single action do not need auxiliary context or grant work access',()=>{
  const options=setup(),view=body(options);
  for(const wire of ['WAIT','wait','```text\nWAIT\n```',`D1 ${view.protocol.ticket} WAIT`]){
    const value=parseDirectorResponse(wire,options);assert.equal(value.basis,'model');assert.equal(value.next,null);assert.equal(value.waitForUser,true);assert.deepEqual(value.context.sourceIds,[]);
  }
  const idle=parseDirectorResponse('IDLE',options);assert.equal(idle.basis,'model');assert.equal(idle.waitForUser,false);
  const action=parseDirectorResponse(view.choices[0].choiceId,options);assert.equal(action.basis,'model');assert.equal(action.next.id,'fish');assert.deepEqual(action.context.sourceIds,[]);
  assert.equal(action.context.request,'unclear');assert.equal(action.context.work,'unclear');
  assert.equal(parseDirectorResponse(view.choices[0].choiceId,setup('other-room')).basis,'invalid');
  for(const broken of ['WAIT extra','这次就 WAIT',`D1 ${view.protocol.ticket} WAIT s7`,'IDLE advice'])assert.equal(parseDirectorResponse(broken,options).basis,'invalid');
  assert.doesNotMatch(buildDirectorRequest(options).system,/choiceId=null|waitForUser/,'output instructions use one coherent compact/extended contract');
});

test('presentation-only whitespace and a single enclosing fence do not invalidate a complete finite selection',()=>{
  const options=setup(),wire=response(options);
  for(const value of ['  '+wire+'\n',wire.split(' ').join('\n'),'```text\n'+wire+'\n```','```\n'+wire+'\n```'])
    assert.equal(parseDirectorResponse(value,options).basis,'model');
});

test('finite control cannot be replayed across room, source revision, current input or actor readiness',()=>{
  const options=setup(),wire=response(options);
  for(const changed of [setup('other-room'),{...options,message:'当前用户原话变了。'},
    {...options,sources:[{id:'another',name:'项目甲'}]},
    {...options,states:options.states.map(state=>({...state,normalReady:false}))}]) {
    const value=parseDirectorResponse(wire,changed);assert.equal(value.basis,'invalid');assert.equal(value.next,null);
  }
});

test('malformed, fabricated or partial control never causes guessed routing, work access or a successful silent result',()=>{
  const options=setup(),wire=response(options);
  for(const broken of [wire+' extra',wire+'\nWAIT',wire.replace('D1','D2'),wire.replace(' N ',' s7 '),
    wire.replace(' N ',' s1+s1 '),wire.replace(' open ',' advice '),wire.replace(' -',' q999'),
    'private-response-text',wire.replace(body(options).choices[0].choiceId,'c99-forged')]) {
    const value=parseDirectorResponse(broken,options);assert.equal(value.basis,'invalid',broken);
    assert.equal(value.next,null);assert.equal(value.waitForUser,false);assert.deepEqual(value.context.sourceIds,[]);
  }
});

test('source-required and explicit request classifications always resolve actual current-user evidence',()=>{
  const options=setup();for(const request of ['answer','advice','listen'])
    assert.equal(parseDirectorResponse(response(options,{request}),options).reason,'evidence');
  assert.equal(parseDirectorResponse(response(options,{work:'s1'}),options).reason,'evidence');
  assert.equal(parseDirectorResponse(response(options,{work:'s1',evidence:'q0'}),options).context.evidence,options.message);
  assert.equal(parseDirectorResponse(response(options,{evidence:'q2'}),options).context.evidence,'先别执行。');
});

test('legacy strict JSON stays validated without substring extraction or duplicate-field repair',()=>{
  const options=setup(),choice=body(options).choices[0].choiceId;
  assert.equal(parseDirectorResponse(JSON.stringify({choiceId:choice}),options).basis,'model');
  for(const value of ['{"choiceId":','{"choiceId":null,"choiceId":"'+choice+'"}','prefix {"choiceId":null}'])
    assert.equal(parseDirectorResponse(value,options).basis,'invalid');
});

test('short choices identify the speaker, target and exact bubble, and only resolve within their request',()=>{
  const options={...setup(),requestLocal:true,supportTemplates:['research']};
  const request=buildDirectorRequest(options),view=JSON.parse(request.user);
  assert.deepEqual(view.choices[0],{choiceId:'c1',id:'fish',kind:'normal',to:'user',eventId:'e1',index:0,
    speaker:'鲸鲸',target:'用户',snippet:options.message});
  assert.doesNotMatch(request.system+request.user,/c1-[a-f0-9]{10}|h[a-f0-9]{16}|"ticket":/);
  assert.equal(view.supportChoices[0].choiceId,'h1');
  assert.equal(request.parse('h1 N - | 核对这项资料').next.support.template,'research');
  assert.equal(request.parse('c1\tN\t-\treact | 接她说的这点。').next.contribution.move,'react');
  for(const wire of ['c1','c1。','```text\nc1.\n```','{"choiceId":"c1"}'])
    assert.deepEqual(request.parse(wire).next.evidence,{eventId:options.events[0].id,index:0,text:options.message});
  assert.equal(request.parse('wait.').waitForUser,true);
  assert.deepEqual(request.parse('c1 N -'),request.parse('c1 N'));
  assert.equal(request.parse('WAIT N -').waitForUser,true);
  assert.equal(request.parse('c1 s9 -').basis,'invalid');
  assert.equal(request.parse('IDLE。').waitForUser,false);
  for(const wire of ['c1 和 c2','先用 c1','c2','h2 N - | 假的','c1 s9','{"choiceId":null,"choiceId":"c1"}'])
    assert.equal(request.parse(wire).basis,'invalid',wire);
  assert.equal(parseDirectorResponse('c1',options).basis,'invalid');
  options.states[0].normalReady=false;
  assert.equal(request.parse('c1').basis,'invalid','the stale request cannot dispatch a now-ineligible actor');
});

test('local selector prefixes ignore ASCII case without changing the argument, spelling or authority',()=>{
  const options={...setup(),requestLocal:true,supportTemplates:['research']};
  const req=buildDirectorRequest(options);
  for(const [upper,lower] of [
    ['C1','c1'],['C1.','c1'],['```text\nC1。\n```','c1'],
    ['C1 s2','c1 s2'],['C1\tN - react | 说说 H1。','c1 N - react | 说说 H1。'],
    ['{"choiceId":"C1"}','{"choiceId":"c1"}'],
    ['H1 N - | 核对 C1 和 H2。','h1 N - | 核对 C1 和 H2。']
  ]) {
    const action=req.parse(upper);
    assert.equal(action.basis,'model',upper);
    assert.deepEqual(action,req.parse(lower),upper);
    assert.equal(parseDirectorResponse(upper,options).basis,'invalid',upper);
  }
  for(const bad of ['H1','H1。','{"choiceId":"H1"}','C1..','C1 N.','{"choiceId":"C1。"}',
    'C01','C2','Ｃ1','C1 S2','H2 N - | 问题','请选 C1','{"choiceId":"C1","choiceId":"C1"}'])
    assert.equal(req.parse(bad).basis,'invalid',bad);
  assert.equal(buildDirectorRequest({...options,supportTemplates:[]}).parse('H1 N - | 问题').basis,'invalid');
});

test('a compact directed opinion distinguishes a reply to the latest joke from repeating the opinion to the user',()=>{
  const [whale,fish,guest]=[{id:'whale',name:'大肥鱼'},{id:'fish',name:'小肥鱼'},{id:'guest',name:'小克'}];
  const message='你觉得小肥鱼怎么样？';
  const key=turnId=>chatSchedulerEventKey({roomId:'room',generation:0,sourceScope:null,turnId,attemptId:turnId});
  const events=[{id:key('user'),author:{role:'user'},messages:[message]},
    {id:key('primary'),author:{role:'assistant',...whale},messages:['有点慢热。'],replyTo:{to:'user',eventId:key('user'),index:0}},
    {id:key('aside'),author:{role:'assistant',...fish},messages:['这句我倒是抢先接了。'],replyTo:{to:'user',eventId:key('user'),index:0}}];
  const pending=events.map(e=>e.id);
  const req=buildDirectorRequest({message,requestLocal:true,phase:'followup',members:[whale,fish,guest],recipients:[whale],events,
    states:[{id:guest.id,level:1,normalRemaining:2,peerRemaining:1,normalReady:true,pendingEventIds:pending,normalPendingEventIds:pending}]});
  const body=JSON.parse(req.user);
  assert.equal(body.sourceKeys,undefined);
  assert.match(req.system,/addressedExchange.*换人复述同一评价.*WAIT.*接梗.*同伴/);
  assert.equal(body.addressedExchange.addressee,whale.id);
  const quip=body.choices.find(c=>c.id===guest.id&&c.to===fish.id&&c.kind==='normal');
  assert.equal(req.parse(quip.choiceId).next.evidence.eventId,key('aside'));
  assert.equal(req.parse('WAIT').waitForUser,true);
});

test('a casual follow-up asks only who may speak and keeps routing for outstanding requests',()=>{
  const options=setup(),user=options.events[0];
  const alice={id:'alice',name:'阿甲'};
  const memberReply={id:chatSchedulerEventKey({roomId:'room',generation:0,sourceScope:null,turnId:'reply',attemptId:'reply'}),
    author:{role:'assistant',...alice},messages:['说到那本画册，我还留着。'],replyTo:{to:'user',eventId:user.id,index:0}};
  const followup={...options,requestLocal:true,phase:'followup',sources:[],sourceIds:[],
    members:[...options.members,alice],events:[user,memberReply],
    states:options.states.map(s=>({...s,availability:'ready',pendingEventIds:[user.id,memberReply.id],normalPendingEventIds:[user.id,memberReply.id]}))};
  const req=buildDirectorRequest(followup),view=JSON.parse(req.user);
  assert.equal(view.phase,'followup');
  assert.equal(view.events.at(-1).messages[0],memberReply.messages[0]);
  assert.equal(view.states[0].availability,'ready');
  for(const key of ['sources','sourceKeys','history','userEvidence','supportTemplates','protocol','candidates']) assert.ok(!Object.hasOwn(view,key),key);
  const peer=view.choices.find(c=>c.to===alice.id);
  assert.equal(peer.target,alice.name);assert.equal(peer.snippet,memberReply.messages[0]);
  const action=req.parse(peer.choiceId).next;
  assert.equal(action.to,alice.id);assert.equal(action.evidence.eventId,memberReply.id);assert.equal(action.contribution,undefined);
  for(const wire of ['h1 N - | 不在菜单的辅助','c1 s1','c1 N RESUME react | 另选话题','c1 N - react | 接话\nSCENE | 加一段导演提议'])
    assert.equal(req.parse(wire).basis,'invalid');
  const sceneCatalog={options:[{key:'F',relation:'fresh'},{key:'C1',relation:'continue'}]};
  const enabled={sceneCatalog,supportTemplates:['reason']};
  const closed=buildDirectorRequest({...followup,...enabled}),closedView=JSON.parse(closed.user);
  assert.equal(closedView.sourceKeys,undefined);
  assert.equal(closedView.sceneCatalog,undefined);
  assert.equal(closedView.supportChoices,undefined);
  assert.equal(closed.parse('c1').basis,'model');
  for(const wire of ['h1 N C1 | 再推演','c1 N C1','WAIT N F','WAIT C1','IDLE F','c1 N C1 react | 回应\nSCENE | 插入旧话题'])
    assert.equal(closed.parse(wire).basis,'invalid',wire);
  const unansweredPart={...user,messages:[...user.messages,'还有第二个问题。']};
  for(const change of [{sources:options.sources,sourceIds:options.sourceIds},{summaryRequested:true},
    {...enabled,recipients:followup.members},{...enabled,events:[unansweredPart,memberReply]}]) {
    const full=buildDirectorRequest({...followup,...change});
    assert.ok(full.system.includes('work sceneKey move'));assert.ok(req.system.length+req.user.length < (full.system.length+full.user.length)/2);
    if(change.supportTemplates) assert.ok(JSON.parse(full.user).supportChoices.length);
  }
});
