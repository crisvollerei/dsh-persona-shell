import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatScheduler,chatSchedulerEventKey,chatReplyTarget } from '../lib/chat-scheduler.js';
import { buildDirectorPrompt,parseDirector,directorEvents } from '../lib/chat-director.js';

const scope={generation:1,sourceScope:'room:sources:1'};
const key=(turnId,extra={})=>chatSchedulerEventKey({roomId:'room',...scope,turnId,attemptId:'attempt-'+turnId,...extra});
const user=(turnId='u1')=>({id:key(turnId),author:{role:'user',name:'我'},messages:['大家聊聊这个想法。']});
const peer=(turnId,authorId,messages=['公开回应。'],source)=>({id:key(turnId),author:{role:'assistant',id:authorId,name:authorId},messages,
  ...(source?{replyTo:{to:source.author.role==='user'?'user':source.author.id,eventId:source.id,index:0}}:{})});
const ref=event=>({id:event.id,authorId:event.author.role==='user'?'user':event.author.id,messageCount:event.messages.length,
  ...(event.replyTo?{replyTo:event.replyTo}:{})});
const members=['a','b','c'].map(id=>({id,name:id==='a'?'甲甲':id==='b'?'乙乙':'丙丙'}));
const state=(id,events,normal=events.map(event=>event.id),patch={})=>({id,level:1,normalRemaining:2,peerRemaining:1,
  normalReady:true,peerReady:false,pendingEventIds:events.map(event=>event.id),normalPendingEventIds:normal,...patch});
const view=options=>JSON.parse(buildDirectorPrompt(options).user);
function fixture(intervalMs=5000){let at=0;const s=createChatScheduler({now:()=>at,intervalMs});s.register('room',members.map(p=>p.id),scope);s.reset('room','u1',[]);
  return{s,set:value=>{at=value;},publish:event=>assert.equal(s.publish('room',{...ref(event),userTurnId:'u1'}),true)};}

test('a reply link requires a real earlier bubble with matching author and canonical room/reference scope',()=>{
  const u=user(),a=peer('a','a',['A完整原话。'],u),b=peer('b','b',['B接A。'],a);
  assert.equal(chatReplyTarget(a,[u]),'user');assert.equal(chatReplyTarget(b,[u,a]),'a');
  for(const replyTo of [{...b.replyTo,to:'c'},{...b.replyTo,eventId:key('missing')},{...b.replyTo,index:1},
    {...b.replyTo,index:-1},{...b.replyTo,index:0.5},{...b.replyTo,extra:'untrusted'}])
    assert.equal(chatReplyTarget({...b,replyTo},[u,a]),null);
  assert.equal(chatReplyTarget(b,[u,b,a]),null,'a later event cannot retroactively justify this reply');
  assert.equal(chatReplyTarget({...b,id:key('b',{roomId:'other'})},[u,a]),null);
  assert.equal(chatReplyTarget({...b,id:key('b',{sourceScope:'other-source'})},[u,a]),null);
  assert.equal(chatReplyTarget({...b,id:key('b',{generation:2})},[u,a]),null);
  assert.equal(chatReplyTarget({...b,id:'opaque'},[u,a]),null);
});

test('all public refs remain audible while only the actual reply target receives a normal continuation trigger',()=>{
  const{s,publish}=fixture(),u=user();publish(u);const first=s.claim('room','a','first');s.finish('room','a',first.token);
  const a=peer('a','a',['我先回应用户。'],u),b=peer('b','b',['我也回应用户。'],u);publish(a);publish(b);
  assert.deepEqual(s.pending('room','a').map(event=>event.id),[b.id]);
  assert.deepEqual(s.read('room','a').normalPendingEventIds,[],'a new peer answer to the user is not another invitation to A');
  assert.deepEqual(s.read('room','c').normalPendingEventIds,[u.id],'untouched members retain the original user entry');
  const linked=peer('b-to-a','b',['我想追问A的观点。'],a);publish(linked);
  assert.deepEqual(s.read('room','a').normalPendingEventIds,[linked.id]);
  assert.deepEqual(s.read('room','c').normalPendingEventIds,[u.id],'C can hear the exchange without being its target');
  assert.deepEqual(s.pending('room','c').map(event=>event.id),[u.id,a.id,b.id,linked.id]);
});

test('a directed public chain may continue autonomously under the unchanged five/ten-second grades',()=>{
  const{s,set,publish}=fixture(),u=user();publish(u);let slot=s.claim('room','a','a1');s.finish('room','a',slot.token);
  const a1=peer('a1','a',['A第一轮。'],u);publish(a1);const b1=peer('b1','b',['B接A第一轮。'],a1);publish(b1);
  assert.equal(s.readyAt('room','a'),5000);set(4999);assert.equal(s.claim('room','a','a2'),null);
  set(5000);slot=s.claim('room','a','a2');assert.ok(slot);s.finish('room','a',slot.token);
  const a2=peer('a2','a',['A第二轮。'],b1);publish(a2);const b2=peer('b2','b',['B接A第二轮。'],a2);publish(b2);
  assert.deepEqual(s.read('room','a').normalPendingEventIds,[b2.id]);assert.equal(s.readyAt('room','a'),15000);
  set(15000);slot=s.claim('room','a','a3');assert.ok(slot);s.finish('room','a',slot.token);
  assert.equal(s.read('room','a').level,3);assert.equal(s.readyAt('room','a'),null);
  const a3=peer('a3','a',['A第三轮。'],b2);publish(a3);publish(peer('b3','b',['B仍可接A。'],a3));
  assert.equal(s.readyAt('room','a'),null,'peer traffic never refills the normal maximum');
});

test('an unrelated peer does not reopen a considered scene, while a new directed reply can use the unspent quota',()=>{
  const{s,publish}=fixture(0),u=user();publish(u);const a=peer('prior-a','a',['A此前说过的话。'],u);publish(a);
  const slot=s.claim('room','a','considered');assert.equal(s.abstain('room','a',slot.token),true);
  publish(peer('unrelated','b',['B只回答用户。'],u));assert.equal(s.readyAt('room','a'),null);
  assert.equal(s.claim('room','a','same-scene'),null);assert.equal(s.read('room','a').level,0);
  const directed=peer('directed','b',['B接着问A。'],a);publish(directed);assert.equal(s.readyAt('room','a'),0);
  const next=s.claim('room','a','fresh-link');assert.ok(next);assert.equal(next.normalRemainingAfterThis,2);
  assert.equal(s.abstain('room','a',next.token),true);assert.equal(s.readyAt('room','a'),null);
  assert.equal(s.publish('room',ref(directed)),false,'a duplicate public event cannot refresh the same scene');
});

test('a real peer call retains its independent reviewed opportunity without giving normal reply rights to everybody',()=>{
  const{s,publish}=fixture(0),u=user();publish(u);const own=s.claim('room','a','a-first');s.finish('room','a',own.token);
  const named=peer('named','b',['甲甲，你愿意补充吗？'],u);publish(named);
  assert.deepEqual(s.read('room','a').normalPendingEventIds,[]);
  assert.equal(s.grantPeer('room','a',{sourceEventId:named.id,fromId:'b'}),true);
  const extra=s.claim('room','a','a-extra','peer');assert.ok(extra);s.finish('room','a',extra.token);
  assert.deepEqual([s.read('room','a').level,s.read('room','a').peerRemaining],[1,0]);
  const later=peer('named-again','b',['甲甲，再说一轮？'],u);publish(later);
  assert.equal(s.grantPeer('room','a',{sourceEventId:later.id,fromId:'b'}),false);
});

test('future user refs published before reset bind only to their own new user cycle',()=>{
  const{s}=fixture(0),old=user('old'),next=user('next');
  assert.equal(s.publish('room',{...ref(old),userTurnId:'u1'}),true);
  assert.equal(s.publish('room',{...ref(next),userTurnId:'u2'}),true);
  assert.deepEqual(s.read('room','a').normalPendingEventIds,[old.id]);
  assert.equal(s.reset('room','u2',[]),true);assert.deepEqual(s.read('room','a').normalPendingEventIds,[next.id]);
  assert.equal(s.publish('room',{...ref(next),userTurnId:'u2'}),false);
});

test('the new anchor is re-admitted if an older claim drained its prepublished refs without granting old-cycle rights',()=>{
  const{s}=fixture(0),old=user('old'),next=user('next');
  s.publish('room',{...ref(old),userTurnId:'u1'});s.publish('room',{...ref(next),userTurnId:'u2'});
  assert.deepEqual(s.read('room','a').normalPendingEventIds,[old.id]);
  const older=s.claim('room','a','older');assert.deepEqual(s.pending('room','a'),[]);
  s.reset('room','u2',[]);assert.deepEqual(s.read('room','a').normalPendingEventIds,[next.id]);
  assert.equal(s.finish('room','a',older.token),false,'the old completion cannot consume this new cycle');
  const current=s.claim('room','a','current');assert.deepEqual(current.events.map(event=>event.id),[next.id]);
});

test('coalescing a user anchor enriches its real part count without replaying, reauthoring or changing the frozen inbox',()=>{
  const{s}=fixture(0),u=user(),first={...ref(u),userTurnId:'u1'};
  s.publish('room',first);const call=s.claim('room','a','already-captured');
  assert.equal(s.publish('room',{...first,messageCount:2}),false);
  assert.equal(s.publish('room',{...first,messageCount:1}),false);
  assert.equal(s.publish('room',{...first,userTurnId:'other-turn',messageCount:8}),false);
  assert.equal(s.publish('room',{...first,authorId:'b',messageCount:8}),false);
  assert.equal(s.read('room','a').seen.find(event=>event.id===u.id).messageCount,2);
  assert.equal(call.events[0].messageCount,1);assert.deepEqual(s.pending('room','a'),[]);
  const b={...ref(peer('second-part-answer','b')),userTurnId:'u1',replyTo:{to:'user',eventId:u.id,index:1}};
  assert.equal(s.publish('room',b),true);assert.deepEqual(s.read('room','c').seen.find(event=>event.id===b.id).replyTo,b.replyTo);
});

test('retention, scope edits and restart replay cannot turn an old relation or user entry into a fresh normal invitation',()=>{
  const{s,publish}=fixture(0),u=user(),a=peer('a','a',['A原话。'],u),b=peer('b','b',['B接A。'],a);
  publish(u);publish(a);publish(b);const slot=s.claim('room','a','done');s.finish('room','a',slot.token);
  const later=peer('later','b',['新接A。'],a);publish(later);assert.deepEqual(s.read('room','a').normalPendingEventIds,[later.id]);
  s.retain('room',[later.id]);assert.deepEqual(s.read('room','a').normalPendingEventIds,[],'missing original pointer revokes the relation');
  s.register('room',members.map(p=>p.id),{generation:2,sourceScope:'new'});assert.equal(s.read('room','a').level,1);
  const restored=createChatScheduler({now:()=>10000,intervalMs:0});restored.register('room',['a','b'],scope);
  assert.equal(restored.restoreCycle('room',{userTurnId:'u1',recipients:[],at:0,responses:[{id:'completed',personaId:'a',kind:'normal',completedAt:1}]}),true);
  for(const event of [u,a,b])restored.publish('room',{...ref(event),userTurnId:'u1'});
  assert.deepEqual(restored.read('room','a').normalPendingEventIds,[b.id]);
  assert.equal(restored.read('room','a').level,1,'replaying the timeline cannot refill its original user entry');
});

test('director options keep public context but bind normal peer actions to the same verified target chain',()=>{
  const u=user(),a=peer('a','a',['A已经回答。'],u),b=peer('b','b',['B接A。'],a),c=peer('c','c',['C独自回答用户。'],u),events=[u,a,b,c];
  const options={message:u.messages[0],members,events,states:[state('a',[b,c]),state('b',[c]),state('c',[u,a,b])]},body=view(options);
  assert.equal(body.events.length,4,'all public context remains visible');
  assert.deepEqual(body.choices.filter(choice=>choice.id==='a').map(choice=>[choice.kind,choice.to,choice.eventId]),[['normal','b','e3']]);
  assert.deepEqual(body.choices.filter(choice=>choice.id==='b'),[]);
  assert.deepEqual(body.choices.filter(choice=>choice.id==='c'),[],'an actor that already spoke cannot reopen the old user entry');
  assert.deepEqual(body.events[2].replyTo,{to:'a',eventId:'e2',index:0});
  assert.doesNotMatch(JSON.stringify(body),/attempt-|room:sources/,'canonical relation refs stay local too');
  const picked=body.choices[0],parsed=parseDirector(JSON.stringify({choiceId:picked.choiceId}),options);
  assert.equal(parsed.next.evidence.eventId,b.id);assert.equal(parsed.next.to,'b');
  const legacy={context:{work:'not-needed',sourceIds:[],request:'answer',evidence:options.message},
    next:{id:'a',kind:'normal',to:'c',evidence:{eventId:c.id,index:0,text:c.messages[0]},goal:'接C。'}};
  assert.equal(parseDirector(JSON.stringify(legacy),options).reason,'normal-ineligible');
});

test('director fails closed without normal trigger authority and a forged or future relation cannot create it',()=>{
  const u=user(),a=peer('a','a',['A原话。'],u),b=peer('b','b',['B原话。'],a),events=[u,a,b],base={message:u.messages[0],members,events,states:[state('a',[b])]};
  assert.equal(view(base).choices.length,1);
  for(const normalPendingEventIds of [undefined,[],[key('foreign')]])
    assert.equal(view({...base,states:[{...base.states[0],normalPendingEventIds}]}).choices.length,0);
  for(const replyTo of [{...b.replyTo,to:'c'},{...b.replyTo,eventId:b.id},{...b.replyTo,index:1}]){
    const changed={...base,events:[u,a,{...b,replyTo}]};assert.equal(view(changed).choices.length,0);
    assert.equal(directorEvents(changed.events).at(-1).replyTo,undefined);
  }
});
