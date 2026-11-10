import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatScheduler, chatSchedulerEventKey } from '../lib/chat-scheduler.js';

const scope={generation:1,sourceScope:'scope:one'};
const ref=(turnId,extra={})=>chatSchedulerEventKey({roomId:'r',...scope,turnId,attemptId:'public-attempt',...extra});
function make(intervalMs=5000){let at=0;const s=createChatScheduler({now:()=>at,intervalMs});s.register('r',['a','b','c'],scope);return{s,set:value=>{at=value;}};}
const publish=(s,turnId,authorId,extra={})=>{const event={id:ref(turnId),authorId,...extra};assert.equal(s.publish('r',event),true);return event.id;};
const complete=(s,pid,attempt,kind='normal',metadata)=>{const slot=s.claim('r',pid,attempt,kind);assert.ok(slot);assert.equal(s.finish('r',pid,slot.token,metadata),true);return slot;};

test('a user reset initializes ordered mentions and no-mention opportunities at exact grade delays',()=>{
  const {s,set}=make();assert.equal(s.readyAt('r','a'),null);assert.equal(s.read('r','a').peerRemaining,0);
  set(100);assert.equal(s.reset('r','u1',[]),true);
  for(const pid of ['a','b','c'])assert.deepEqual([s.read('r',pid).level,s.read('r',pid).normalRemaining,s.readyAt('r',pid)],[0,3,100]);
  set(200);assert.equal(s.reset('r','u2',['b','a']),true);
  assert.deepEqual(['b','a','c'].map(pid=>[s.read('r',pid).level,s.read('r',pid).normalRemaining,s.readyAt('r',pid)]),[[0,3,200],[1,2,5200],[2,1,10200]]);
  assert.equal(s.reset('r','u2',[]),false);assert.equal(s.read('r','c').level,2);
  assert.equal(s.reset('r','u1',[]),false,'a delayed earlier user anchor cannot refresh the current cycle');
  set(5199);assert.equal(s.claim('r','a','early'),null);set(5200);assert.ok(s.claim('r','a','second-selected'));
});

test('three complete normal packages consume three grades and elapsed time never unlocks grade three',()=>{
  const {s,set}=make();s.reset('r','u1',[]);
  const first=s.claim('r','a','a1');assert.equal(first.remainingAfterThis,2);set(1000);s.finish('r','a',first.token);
  assert.deepEqual([s.read('r','a').level,s.readyAt('r','a')],[1,6000]);set(5999);assert.equal(s.claim('r','a','a2'),null);
  set(6000);const second=s.claim('r','a','a2');assert.equal(second.remainingAfterThis,1);set(7000);s.finish('r','a',second.token);
  assert.deepEqual([s.read('r','a').level,s.readyAt('r','a')],[2,17000]);set(17000);const last=s.claim('r','a','a3');assert.equal(last.remainingAfterThis,0);
  set(18000);s.finish('r','a',last.token);assert.equal(s.read('r','a').level,3);assert.equal(s.read('r','a').normalRemaining,0);assert.equal(s.readyAt('r','a'),null);
  assert.equal(s.read('r','a').nextEligibleAt,23000,'grade three adds no fifteen-second timer; an extra peer reply still observes the minimum interval');
  set(1000000);assert.equal(s.claim('r','a','a4'),null);assert.equal(s.read('r','a').level,3);
  s.reset('r','u2',[]);assert.equal(s.read('r','a').level,0);assert.equal(s.readyAt('r','a'),1000000);
});

test('a director-reviewed peer grant is independent, single-use and still waits at grade three',()=>{
  const {s,set}=make();s.reset('r','u1',['a']);set(10000);complete(s,'c','c-normal');
  assert.equal(s.read('r','c').level,3);assert.equal(s.readyAt('r','c','peer'),null);
  const event=publish(s,'a-peer','a');assert.equal(s.grantPeer('r','c',{sourceEventId:event,fromId:'a',evidence:'VERIFIED_WORDS_NOT_STORED'}),true);
  assert.equal(s.grantPeer('r','c',{sourceEventId:event,fromId:'a'}),false);assert.equal(s.readyAt('r','c','peer'),15000);
  set(14999);assert.equal(s.claim('r','c','c-peer','peer'),null);set(15000);const slot=s.claim('r','c','c-peer','peer');
  assert.equal(slot.remainingAfterThis,0);assert.equal(slot.normalRemainingAfterThis,0);assert.equal(s.claim('r','c','parallel'),null);
  set(16000);s.finish('r','c',slot.token);assert.deepEqual([s.read('r','c').level,s.read('r','c').normalRemaining,s.read('r','c').peerRemaining],[3,0,0]);
  const other=publish(s,'b-peer','b');assert.equal(s.grantPeer('r','c',{sourceEventId:other,fromId:'b'}),false);set(100000);assert.equal(s.claim('r','c','again','peer'),null);
  assert.doesNotMatch(JSON.stringify(s.read('r','c')),/VERIFIED_WORDS_NOT_STORED/,'the grant persists only its public reference, never quoted text');
});

test('an early extra does not consume normal grades but prevents an immediate normal package',()=>{
  const {s,set}=make();s.reset('r','u1',[]);const event=publish(s,'b-peer','b');s.grantPeer('r','a',{sourceEventId:event,fromId:'b'});
  const slot=s.claim('r','a','peer-first','peer');assert.equal(slot.normalRemainingAfterThis,3);set(100);s.finish('r','a',slot.token);
  assert.deepEqual([s.read('r','a').level,s.read('r','a').normalRemaining,s.read('r','a').peerRemaining],[0,3,0]);
  assert.equal(s.readyAt('r','a'),5100);set(5099);assert.equal(s.claim('r','a','normal'),null);set(5100);complete(s,'a','normal');assert.equal(s.read('r','a').level,1);
});

test('a grade-two extra retains the ten-second grade cooldown without consuming its last normal reply',()=>{
  const {s,set}=make();s.reset('r','u1',['a']);set(10000);
  const source=publish(s,'a-to-c','a');assert.equal(s.grantPeer('r','c',{sourceEventId:source,fromId:'a'}),true);
  const slot=s.claim('r','c','c-extra','peer');assert.ok(slot);set(11000);assert.equal(s.finish('r','c',slot.token),true);
  assert.deepEqual([s.read('r','c').level,s.read('r','c').normalRemaining,s.read('r','c').peerRemaining,s.readyAt('r','c')],[2,1,0,21000]);
  set(20999);assert.equal(s.claim('r','c','c-last-normal'),null);set(21000);complete(s,'c','c-last-normal');
  assert.equal(s.read('r','c').level,3);assert.equal(s.readyAt('r','c'),null);assert.equal(s.read('r','c').nextEligibleAt,26000);
});

test('peer grants require a real same-cycle peer ref and never arise from names, user messages or stale events',()=>{
  const {s}=make(0);s.reset('r','u1',[]);const peer=publish(s,'peer','b'),user=publish(s,'user','user');
  for(const grant of [{sourceEventId:'invented',fromId:'b'},{sourceEventId:user,fromId:'user'},{sourceEventId:peer,fromId:'c'},
    {sourceEventId:peer,fromId:'a'},{sourceEventId:peer,fromId:'b',evidence:{}},{sourceEventId:peer,fromId:'b',evidence:'x'.repeat(2001)},
    {sourceEventId:peer,fromId:'b',names:['a']}])assert.equal(s.grantPeer('r','a',grant),false);
  assert.equal(s.read('r','a').peerGrant,null);s.reset('r','u2',[]);assert.equal(s.grantPeer('r','a',{sourceEventId:peer,fromId:'b'}),false);
  const historical=publish(s,'old-history','b',{userTurnId:'u1'});assert.equal(s.grantPeer('r','a',{sourceEventId:historical,fromId:'b'}),false);
  const current=publish(s,'current-peer','b',{userTurnId:'u2'});assert.equal(s.grantPeer('r','a',{sourceEventId:current,fromId:'b'}),true);
});

test('new user cycles isolate stale tokens while keeping an old in-flight package mutually exclusive',()=>{
  const {s,set}=make();s.reset('r','u1',[]);const old=s.claim('r','a','old');set(100);s.reset('r','u2',[]);
  assert.equal(s.read('r','a').userTurnId,'u2');assert.equal(s.readyAt('r','a'),null);assert.equal(s.claim('r','a','new'),null);
  assert.equal(s.finish('r','a',old.token),false,'the old completion releases its hold but cannot charge a new cycle');
  assert.deepEqual([s.read('r','a').level,s.read('r','a').normalRemaining],[0,3]);const current=s.claim('r','a','new');assert.ok(current);
  assert.equal(s.finish('r','a',old.token),false);assert.equal(s.read('r','a').inFlight.token,current.token);s.finish('r','a',current.token);
  assert.equal(s.read('r','a').level,1);
});

test('failed or cancelled attempts leave both opportunities intact and have bounded retry backoff',()=>{
  const {s,set}=make();s.reset('r','u1',[]);const event=publish(s,'new-input','user');const first=s.claim('r','a','first');
  set(100);assert.equal(s.finish('r','a',first.token,{success:false}),true);assert.deepEqual([s.read('r','a').level,s.read('r','a').normalRemaining,s.read('r','a').peerRemaining],[0,3,1]);
  assert.equal(s.read('r','a').failureCount,1);assert.equal(s.readyAt('r','a'),5100);assert.equal(s.pending('r','a')[0].id,event);
  set(5100);const second=s.claim('r','a','retry');set(5200);s.fail('r','a',second.token);assert.equal(s.readyAt('r','a'),15200);
  set(15200);const third=s.claim('r','a','manual-retry');set(15300);s.cancel('r','a',third.token);assert.equal(s.readyAt('r','a'),25300);assert.equal(s.read('r','a').failureCount,2);
  publish(s,'peer-no-reset','b');assert.equal(s.read('r','a').failureCount,2);set(16000);s.reset('r','u2',[]);assert.equal(s.read('r','a').failureCount,0);assert.equal(s.readyAt('r','a'),16000);
});

test('duplicates and multiple bubbles do not replenish a peer grant or count one complete reply twice',()=>{
  const {s}=make(0);s.reset('r','u1',[]);const source=publish(s,'bubble-0','b');s.grantPeer('r','a',{sourceEventId:source,fromId:'b'});
  const slot=complete(s,'a','one-package','peer');assert.equal(s.finish('r','a',slot.token),false);assert.equal(s.claim('r','a','one-package','peer'),null);
  for(const name of ['bubble-1','bubble-2']){const next=publish(s,name,'b');assert.equal(s.grantPeer('r','a',{sourceEventId:next,fromId:'b'}),false);}
  assert.equal(s.read('r','a').peerRemaining,0);assert.equal(s.read('r','a').level,0);
  const normal=complete(s,'a','one-normal');assert.equal(s.finish('r','a',normal.token),false);assert.equal(s.read('r','a').level,1);assert.equal(s.claim('r','a','one-normal'),null);
});

test('scope changes keep grades, used extras and cooldowns, while new members wait for a new user anchor',()=>{
  const {s}=make(0);s.reset('r','u1',[]);complete(s,'a','n1');complete(s,'a','n2');const event=publish(s,'b-peer','b');s.grantPeer('r','a',{sourceEventId:event,fromId:'b'});complete(s,'a','extra','peer');
  const old=s.claim('r','a','n3');s.register('r',['a','b','c','d'],{generation:2,sourceScope:'scope:two'});
  assert.equal(s.finish('r','a',old.token),false);assert.deepEqual([s.read('r','a').level,s.read('r','a').peerRemaining],[2,0]);
  assert.equal(s.read('r','d').userTurnId,null);assert.equal(s.readyAt('r','d'),null);assert.equal(s.readyAt('r','d','peer'),null);
  assert.equal(s.reset('r','u1',[]),false);assert.equal(s.claim('r','d','old-cycle'),null);assert.equal(s.read('r','a').level,2);
  s.reset('r','u2',['d']);assert.equal(s.read('r','d').level,0);assert.equal(s.read('r','d').normalRemaining,3);assert.equal(s.read('r','a').level,2);assert.equal(s.read('r','a').peerRemaining,1);
});

test('restart reconstruction counts only unique committed replies and cannot refresh old opportunities',()=>{
  const {s,set}=make();set(20000);
  const responses=[{id:'a1',personaId:'a',kind:'normal',completedAt:200},{id:'peer1',personaId:'a',kind:'peer',completedAt:5300},
    {id:'b1',personaId:'b',kind:'normal',completedAt:6100},{id:'a1',personaId:'a',kind:'normal',completedAt:200}];
  assert.equal(s.restoreCycle('r',{userTurnId:'u1',recipients:['a','b'],at:100,responses}),true);
  assert.deepEqual([s.read('r','a').level,s.read('r','a').peerRemaining,s.readyAt('r','a')],[1,0,10300]);
  assert.deepEqual([s.read('r','b').level,s.readyAt('r','b')],[2,16100]);assert.equal(s.read('r','c').level,2);
  assert.equal(s.claim('r','a','a1'),null,'an already committed attempt is not invoked again');
  assert.equal(s.restoreCycle('r',{userTurnId:'u1',recipients:[],at:0,responses:[responses[0]]}),true);assert.equal(s.read('r','b').level,2);assert.equal(s.read('r','a').peerRemaining,0);
  assert.equal(s.reset('r','u1',[]),false);
  assert.equal(s.restoreCycle('r',{userTurnId:'old-user',recipients:[],at:0,responses:[]}),false);
  assert.equal(s.restoreCycle('r',{userTurnId:'u1',recipients:['a','b'],at:100,responses:[...responses,{id:'a2',personaId:'a',kind:'normal',completedAt:11000}]}),true);
  assert.deepEqual([s.read('r','a').level,s.readyAt('r','a')],[2,21000]);
  s.register('r',['a','b','c','late'],scope);s.restoreCycle('r',{userTurnId:'u1',recipients:['a','b'],at:100,responses:[{id:'late1',personaId:'late',kind:'normal',completedAt:12000}]});
  assert.equal(s.read('r','late').userTurnId,null,'replaying a current anchor cannot activate a member added after that anchor');
});

test('invalid restart envelopes are atomic and a live completion is not charged again by reconstruction',()=>{
  const {s}=make(0);
  for(const response of [{id:'x',personaId:'a',kind:'invalid',completedAt:100},{id:'x',personaId:'a',kind:'normal',completedAt:-1},
    {id:'x',personaId:'a',kind:'normal',completedAt:100,text:'PRIVATE_BODY'}]){
    assert.equal(s.restoreCycle('r',{userTurnId:'u1',recipients:[],at:0,responses:[response]}),false);assert.equal(s.read('r','a').userTurnId,null);
  }
  s.reset('r','u1',[]);complete(s,'a','a1');s.restoreCycle('r',{userTurnId:'u1',recipients:[],at:0,responses:[{id:'a1',personaId:'a',kind:'normal',completedAt:0}]});
  assert.equal(s.read('r','a').level,1);assert.doesNotMatch(JSON.stringify(s.read('r','a')),/PRIVATE_BODY/);
});
