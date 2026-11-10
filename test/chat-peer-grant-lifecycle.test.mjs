import test from 'node:test';
import assert from 'node:assert/strict';
import {createChatScheduler,chatSchedulerEventKey} from '../lib/chat-scheduler.js';

const scope={generation:0,sourceScope:'peer-lifecycle'};
function fixture(intervalMs=0){let clock=0;const s=createChatScheduler({now:()=>clock,intervalMs});s.register('room',['a','b','c'],scope);s.reset('room','user-one',['b']);
 const key=id=>chatSchedulerEventKey({roomId:'room',...scope,turnId:id,attemptId:'attempt-'+id});
 const publish=(id,authorId='b')=>{const event={id:key(id),authorId,userTurnId:'user-one',messageCount:1};assert.equal(s.publish('room',event),true);return event;};
 return{s,key,publish,set:at=>{clock=at;}};}
const grant=(s,event)=>s.grantPeer('room','a',{sourceEventId:event.id,fromId:event.authorId});

test('a failed or cancelled independent reply retires its attempted grant but preserves exact retry evidence and unspent opportunity',()=>{
 for(const finish of ['fail','cancel','unsuccessful']){
  const{s,publish}=fixture(),old=publish('old-call');assert.equal(grant(s,old),true);const slot=s.claim('room','a','failed-peer','peer');assert.ok(slot);
  assert.equal(finish==='unsuccessful'?s.finish('room','a',slot.token,{success:false}):s[finish]('room','a',slot.token),true);
  let state=s.read('room','a');assert.equal(state.peerGrant,null);assert.equal(state.peerRemaining,1);assert.equal(state.level,2);assert.equal(state.failureCount,1);
  assert.ok(state.pending.some(event=>event.id===old.id),'the exact old public source remains available for an explicit retry');
  assert.equal(grant(s,old),true);const retry=s.claim('room','a','precise-retry','peer');assert.ok(retry);assert.equal(s.finish('room','a',retry.token),true);
  state=s.read('room','a');assert.equal(state.peerRemaining,0);assert.equal(s.finish('room','a',slot.token),false);assert.equal(state.level,2);
 }
});

test('a new reviewed invitation can replace a failed grant without adding a second independent opportunity',()=>{
 const{s,publish}=fixture(),old=publish('old-call');grant(s,old);const failed=s.claim('room','a','failed','peer');s.fail('room','a',failed.token);
 const newer=publish('new-call','c');assert.equal(grant(s,newer),true);
 assert.deepEqual(s.read('room','a').peerGrant,{sourceEventId:newer.id,fromId:'c'});assert.equal(s.read('room','a').peerRemaining,1);
 const next=s.claim('room','a','new-invitation','peer');assert.ok(next);assert.equal(s.finish('room','a',failed.token),false);
 assert.equal(s.read('room','a').inFlight.token,next.token);assert.equal(s.finish('room','a',next.token),true);
 assert.equal(s.read('room','a').peerRemaining,0);assert.equal(grant(s,publish('third-call')),false);
});

test('a new grant installed after an old source was retired survives that older in-flight failure',()=>{
 const{s,publish}=fixture(),old=publish('old-call');grant(s,old);const slot=s.claim('room','a','old-in-flight','peer');
 s.retain('room',[]);const fresh=publish('fresh-call','c');assert.equal(grant(s,fresh),true);
 assert.equal(s.fail('room','a',slot.token),true);assert.deepEqual(s.read('room','a').peerGrant,{sourceEventId:fresh.id,fromId:'c'});
 assert.equal(s.read('room','a').peerRemaining,1);assert.ok(!s.pending('room','a').some(event=>event.id===old.id));
 const next=s.claim('room','a','fresh-in-flight','peer');assert.ok(next);assert.equal(s.fail('room','a',slot.token),false);
 assert.equal(s.read('room','a').inFlight.token,next.token);assert.equal(s.finish('room','a',next.token),true);
});

test('grant retirement preserves the existing five and ten second failure backoff',()=>{
 const{s,publish,set}=fixture(5000),old=publish('old');grant(s,old);set(10000);const first=s.claim('room','a','first','peer');assert.ok(first);
 set(10100);s.fail('room','a',first.token);const fresh=publish('fresh','c');assert.equal(grant(s,fresh),true);
 assert.equal(s.readyAt('room','a','peer'),15100);set(15099);assert.equal(s.claim('room','a','second','peer'),null);
 set(15100);const second=s.claim('room','a','second','peer');assert.ok(second);set(15200);s.cancel('room','a',second.token);
 assert.equal(grant(s,old),true);assert.equal(s.readyAt('room','a','peer'),25200);set(25199);assert.equal(s.claim('room','a','third','peer'),null);
 set(25200);assert.ok(s.claim('room','a','third','peer'));
});

test('failing a normal reply does not revoke an independent grant which that claim did not spend',()=>{
 const{s,publish}=fixture(),event=publish('peer-call');assert.equal(grant(s,event),true);
 const normal=s.claim('room','a','normal-attempt');assert.ok(normal);s.fail('room','a',normal.token);
 assert.deepEqual(s.read('room','a').peerGrant,{sourceEventId:event.id,fromId:event.authorId});assert.equal(s.read('room','a').peerRemaining,1);
});

test('an exact unclaimed grant may be revoked without consuming speech, quota, cooldown or public input',()=>{
 const{s,publish}=fixture(),event=publish('prepared-call');assert.equal(grant(s,event),true);
 const before=s.read('room','a');assert.equal(s.revokePeer('room','a',{sourceEventId:event.id,fromId:event.authorId}),true);
 assert.deepEqual(s.read('room','a'),{...before,peerGrant:null,eligibleKinds:before.eligibleKinds.filter(kind=>kind!=='peer')});assert.equal(s.revokePeer('room','a',{sourceEventId:event.id,fromId:event.authorId}),false);
 assert.equal(grant(s,event),true,'an explicit exact preparation retry can authorize the same public source again');
});

test('grant revocation rejects any in-flight owner, including a normal claim that has not spent the peer grant',()=>{
 for(const kind of ['normal','peer']){
  const{s,publish}=fixture(),event=publish('prepared-'+kind);grant(s,event);const slot=s.claim('room','a','in-flight-'+kind,kind);assert.ok(slot);
  const before=s.read('room','a');assert.equal(s.revokePeer('room','a',{sourceEventId:event.id,fromId:event.authorId}),false);
  assert.deepEqual(s.read('room','a'),before);assert.equal(s.finish('room','a',slot.token),true);
 }
});

test('a stale preparation cleanup cannot revoke a newer invitation or alter a used opportunity',()=>{
 const{s,publish}=fixture(),old=publish('old-preparation');grant(s,old);const original={sourceEventId:old.id,fromId:old.authorId};
 assert.equal(s.revokePeer('room','a',original),true);const newer=publish('new-preparation','c');grant(s,newer);
 const before=s.read('room','a');
 for(const value of [original,{sourceEventId:newer.id,fromId:'b'},{sourceEventId:newer.id,fromId:'c',evidence:'unexpected'},
  {sourceEventId:'malformed-reference',fromId:'c'}])assert.equal(s.revokePeer('room','a',value),false);
 assert.deepEqual(s.read('room','a'),before);
 const slot=s.claim('room','a','completed-new','peer');s.finish('room','a',slot.token);
 assert.equal(s.revokePeer('room','a',{sourceEventId:newer.id,fromId:'c'}),true);assert.equal(s.read('room','a').peerRemaining,0);
 assert.equal(grant(s,publish('after-used')),false,'cleanup cannot refill an independent opportunity');
});

test('old-cycle and old-scope cleanup cannot clear a current-cycle authorization',()=>{
 const{s,publish,key}=fixture(),old=publish('old-cycle-call');grant(s,old);
 s.reset('room','user-two',[]);const current={id:key('current-cycle-call'),authorId:'c',userTurnId:'user-two',messageCount:1};
 s.publish('room',current);assert.equal(grant(s,current),true);
 const before=s.read('room','a');assert.equal(s.revokePeer('room','a',{sourceEventId:old.id,fromId:'b'}),false);assert.deepEqual(s.read('room','a'),before);
 const nextScope={generation:1,sourceScope:'new-peer-scope'};s.register('room',['a','b','c'],nextScope);
 const next={id:chatSchedulerEventKey({roomId:'room',...nextScope,turnId:'next-scope-call',attemptId:'next-scope'}),authorId:'b',userTurnId:'user-two',messageCount:1};
 s.publish('room',next);assert.equal(grant(s,next),true);const latest=s.read('room','a');
 assert.equal(s.revokePeer('room','a',{sourceEventId:current.id,fromId:'c'}),false);assert.deepEqual(s.read('room','a'),latest);
});
