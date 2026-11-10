import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatScheduler, chatSchedulerEventKey } from '../lib/chat-scheduler.js';

const scope={generation:0,sourceScope:'abstain:sources:0'};
const ref=(turnId,roomId='room',extra={})=>chatSchedulerEventKey({roomId,...scope,turnId,attemptId:'public-'+turnId,...extra});
function fixture(intervalMs=5000){
  let at=0;const s=createChatScheduler({now:()=>at,intervalMs});s.register('room',['a','b','c'],scope);s.reset('room','u1',[]);
  return{s,set:value=>{at=value;}};
}
function publish(s,turnId,authorId='user',metadata={}){
  const event={id:ref(turnId),authorId,...metadata};assert.equal(s.publish('room',event),true);return event;
}
const quota=state=>({level:state.level,normal:state.normalRemaining,peer:state.peerRemaining,failure:state.failureCount,due:state.nextEligibleAt});

test('abstaining consumes one considered scene without charging speech, cooldown or failure and prevents same-scene reentry',()=>{
  const{s,set}=fixture();const event=publish(s,'original'),before=quota(s.read('room','a')),slot=s.claim('room','a','considered');
  set(200);assert.equal(s.abstain('room','a',slot.token),true);const state=s.read('room','a');
  assert.deepEqual(quota(state),before);assert.equal(state.inFlight,null);assert.equal(state.cursor,event.id);
  assert.deepEqual(state.pending,[]);assert.deepEqual(state.seen,[event]);assert.equal(state.requiresExternal,true);
  assert.equal(s.abstain('room','a',slot.token),false);assert.equal(s.finish('room','a',slot.token),false);
  assert.equal(s.claim('room','a','considered'),null);assert.equal(s.claim('room','a','different-attempt'),null);
  set(100000);assert.equal(s.readyAt('room','a'),null);assert.equal(s.claim('room','a','time-does-not-create-input'),null);
  assert.equal(s.publish('room',event),false);assert.deepEqual(s.pending('room','a'),[]);
});

test('new directed refs received during a considered reply survive abstention and allow another response at the unspent quota',()=>{
  const{s}=fixture(0);const original=publish(s,'original');const spoken=s.claim('room','a','spoken');s.finish('room','a',spoken.token);
  const prior=publish(s,'a-spoken','a',{messageCount:1}),slot=s.claim('room','a','first');
  const later=[publish(s,'later-user'),publish(s,'later-peer','b',{messageCount:1,replyTo:{to:'a',eventId:prior.id,index:0}})];
  assert.equal(s.abstain('room','a',slot.token),true);assert.deepEqual(s.pending('room','a'),later);
  assert.equal(s.claim('room','a','first'),null,'the considered attempt remains retired even when a newer external scene is available');
  const next=s.claim('room','a','new-scene');assert.ok(next);assert.deepEqual(next.events,later);
  assert.equal(next.normalRemainingAfterThis,1);assert.deepEqual(spoken.events,[original]);assert.deepEqual(slot.events,[]);
  assert.equal(s.finish('room','a',next.token),true);assert.equal(s.read('room','a').level,2);
});

test('a grade-two abstention retains its last normal opportunity and adds no ten-second speech cooldown',()=>{
  const{s,set}=fixture();s.reset('room','u2',['a']);set(10000);publish(s,'current-user');
  const call=publish(s,'initial-c-call','b');s.grantPeer('room','c',{sourceEventId:call.id,fromId:'b'});
  const extra=s.claim('room','c','c-earlier','peer');assert.ok(extra);s.finish('room','c',extra.token);
  const prior=publish(s,'c-earlier','c',{messageCount:1});set(20000);
  const slot=s.claim('room','c','consider-grade-two');assert.ok(slot);set(21000);assert.equal(s.abstain('room','c',slot.token),true);
  assert.deepEqual(quota(s.read('room','c')),{level:2,normal:1,peer:0,failure:0,due:20000});
  set(22000);publish(s,'fresh-peer','b',{messageCount:1,replyTo:{to:'c',eventId:prior.id,index:0}});const next=s.claim('room','c','still-last-normal');assert.ok(next);assert.equal(next.normalRemainingAfterThis,0);
  assert.equal(s.finish('room','c',next.token),true);assert.equal(s.read('room','c').level,3);
});

test('declining a peer response clears its considered grant but preserves the one independent opportunity for a new real event',()=>{
  const{s}=fixture(0);s.reset('room','u2',['a']);const normal=s.claim('room','c','last-normal');s.finish('room','c',normal.token);
  const old=publish(s,'old-call','b');assert.equal(s.grantPeer('room','c',{sourceEventId:old.id,fromId:'b'}),true);
  const slot=s.claim('room','c','decline-peer','peer');assert.ok(slot);assert.equal(s.abstain('room','c',slot.token),true);
  let state=s.read('room','c');assert.deepEqual([state.level,state.normalRemaining,state.peerRemaining,state.peerGrant,state.failureCount],[3,0,1,null,0]);
  assert.equal(s.readyAt('room','c','peer'),null);assert.equal(s.grantPeer('room','c',{sourceEventId:old.id,fromId:'b'}),false);
  const fresh=publish(s,'new-call','b');assert.equal(s.grantPeer('room','c',{sourceEventId:fresh.id,fromId:'b'}),true);
  const next=s.claim('room','c','accept-new-peer','peer');assert.ok(next);s.finish('room','c',next.token);
  state=s.read('room','c');assert.deepEqual([state.level,state.peerRemaining],[3,0]);
});

test('an independent new peer grant received after a retired source is not cleared by abstaining from an older claim',()=>{
  const{s}=fixture(0),old=publish(s,'old-call','b');s.grantPeer('room','a',{sourceEventId:old.id,fromId:'b'});
  const slot=s.claim('room','a','old-scene','peer');s.retain('room',[]);
  const fresh=publish(s,'new-call','c');assert.equal(s.grantPeer('room','a',{sourceEventId:fresh.id,fromId:'c'}),true);
  assert.equal(s.abstain('room','a',slot.token),true);const state=s.read('room','a');
  assert.deepEqual(state.pending,[fresh]);assert.deepEqual(state.peerGrant,{sourceEventId:fresh.id,fromId:'c'});assert.equal(state.peerRemaining,1);
  const next=s.claim('room','a','new-scene','peer');assert.ok(next);s.finish('room','a',next.token);
  assert.equal(s.read('room','a').peerRemaining,0);
});

test('a failed retry after abstention retains new input and existing backoff while another abstention is not counted as a failure',()=>{
  const{s,set}=fixture();publish(s,'old');const initial=s.claim('room','a','initial');s.finish('room','a',initial.token);
  const prior=publish(s,'a-prior','a',{messageCount:1});set(5000);const old=s.claim('room','a','old');s.abstain('room','a',old.token);
  const fresh=publish(s,'new','b',{messageCount:1,replyTo:{to:'a',eventId:prior.id,index:0}});const failed=s.claim('room','a','first-new-attempt');set(5100);s.fail('room','a',failed.token);
  assert.equal(s.read('room','a').failureCount,1);assert.deepEqual(s.pending('room','a'),[fresh]);set(10100);
  const retry=s.claim('room','a','manual-retry');assert.ok(retry);set(10200);s.abstain('room','a',retry.token);
  assert.deepEqual(quota(s.read('room','a')),{level:1,normal:2,peer:1,failure:1,due:10100});
  assert.equal(s.claim('room','a','manual-retry'),null);assert.equal(s.readyAt('room','a'),null);
});

test('late abstentions across user cycles, reference scopes or cleared rooms cannot charge or unlock a replacement claim',()=>{
  for(const change of ['cycle','scope','member','clear']){
    const{s}=fixture(0);publish(s,'old');const old=s.claim('room','a','old');
    if(change==='cycle')s.reset('room','u2',[]);
    else if(change==='scope')s.register('room',['a','b','c'],{generation:1,sourceScope:'new-scope'});
    else if(change==='member'){s.removeMember('room','a');s.register('room',['a','b','c'],scope);s.reset('room','u2',[]);}
    else{s.clearRoom('room');s.register('room',['a','b','c'],scope);s.reset('room','u2',[]);}
    const before=quota(s.read('room','a')),current=change==='clear'?s.claim('room','a','current'):null;
    assert.equal(s.abstain('room','a',old.token),false);assert.deepEqual(quota(s.read('room','a')),before);
    const next=current??s.claim('room','a','current');assert.ok(next);
    assert.equal(s.abstain('room','a',old.token),false);assert.equal(s.read('room','a').inFlight.token,next.token);
    assert.equal(s.finish('room','a',next.token),true);assert.equal(s.read('room','a').level,1);
  }
});

test('reference changes alone preserve the abstained-scene gate without refilling or charging either opportunity',()=>{
  const{s}=fixture(0);publish(s,'seen');const slot=s.claim('room','a','considered');s.abstain('room','a',slot.token);
  const before=quota(s.read('room','a'));s.register('room',['a','b','c'],{generation:1,sourceScope:'new-scope'});
  assert.deepEqual(quota(s.read('room','a')),before);assert.equal(s.read('room','a').requiresExternal,true);
  assert.equal(s.claim('room','a','scope-only'),null);assert.equal(s.readyAt('room','a'),null);
});

test('abstention is room-local and only a new user cycle clears its scene gate and considered-attempt marker',()=>{
  const{s}=fixture(0);s.register('other',['a'],scope);s.reset('other','other-user',[]);
  publish(s,'old');const a=s.claim('room','a','same-id'),b=s.claim('other','a','same-id');
  assert.equal(s.abstain('other','a',a.token),false);assert.equal(s.read('other','a').inFlight.token,b.token);
  assert.equal(s.abstain('room','a',a.token),true);s.reset('room','u2',[]);
  assert.equal(s.read('room','a').requiresExternal,false);assert.ok(s.claim('room','a','same-id'));
  assert.equal(s.read('other','a').inFlight.token,b.token);
});
