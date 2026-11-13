import test from 'node:test';
import assert from 'node:assert/strict';
import {createChatSupport} from '../lib/chat-support.js';
import {runChatSupport} from '../lib/chat-support-runner.js';
import {actorSupport,publicSupportUrl,supportReasonContext} from '../lib/chat-support-templates.js';
const scope={roomId:'room',generation:0,scopeKey:'source',referenceRevision:0,messageId:'message',actorId:'fish',actorName:'鲸鲸',template:'research',goal:'核对公开价格',question:'现在怎么收费？',context:''};
const tick=()=>new Promise(setImmediate);
test('one source-bound admission is persisted before execution and shared by concurrent callers',async()=>{
 let saved,resolve,calls=0;const manager=createChatSupport({save:async v=>{saved=structuredClone(v);},execute:async({admit})=>{calls++;assert.equal(saved.jobs[0].status,'running');admit('calls');await new Promise(r=>resolve=r);return{status:'completed',text:'有依据的结果',sources:[]};}});
 const a=manager.start(scope),b=manager.start(scope);await tick();assert.equal(calls,1);resolve();assert.equal((await a).id,(await b).id);
 assert.equal((await manager.start(scope)).counts.calls,1);assert.equal(calls,1);
 assert.equal(actorSupport(await a,{...scope,actorId:'other'}),undefined);assert.equal(actorSupport(await a,scope).text,'有依据的结果');
 assert.equal(actorSupport(await a,{...scope,generation:1}),undefined);
 const restored=createChatSupport({execute:()=>assert.fail('never replay')});restored.restore(saved);assert.equal((await restored.start(scope)).status,'completed');
});
test('deadline and explicit cancellation settle uncooperative work and prohibit late updates',async()=>{
 let update;const manager=createChatSupport({timeoutMs:15,execute:async input=>{update=input.update;await new Promise(()=>{});}});
 const task=manager.start(scope);await tick();const id=manager.view(scope)[0].id;assert.equal(manager.cancel('another',id),false);
 assert.equal(manager.cancel(scope.roomId,id),true);assert.equal((await task).status,'cancelled');assert.throws(()=>update({stage:'late'}));
 const timed=createChatSupport({timeoutMs:10,execute:async()=>new Promise(()=>{})});const result=await timed.start({...scope,messageId:'timeout'});assert.equal(result.error,'timeout');assert.equal(result.status,'failed');
});
test('global/room concurrency is reserved before asynchronous persistence yields',async()=>{
 let release;const gate=new Promise(r=>release=r),manager=createChatSupport({save:()=>gate,execute:async()=>new Promise(()=>{})});
 const a=manager.start(scope),b=manager.start({...scope,messageId:'second'}),c=manager.start({...scope,roomId:'other'}),d=manager.start({...scope,roomId:'third'});
 manager.cancelRoom('room');manager.cancelRoom('other');release();
 assert.equal((await b).error,'capacity');assert.equal((await d).error,'capacity');assert.equal((await a).status,'cancelled');assert.equal((await c).status,'cancelled');await manager.dispose();
});
test('physical dispatch and individual tool limits cannot be replenished by retry or model output',async()=>{
 for(const [template,field,max]of [['reason','calls',1],['research','calls',4],['research','searches',3],['research','reads',5]]){
  const manager=createChatSupport({execute:async({admit})=>{for(let i=0;i<=max;i++)admit(field);return{};}});
  const result=await manager.start({...scope,template});assert.equal(result.counts[field],max);assert.equal(result.error,'budget');
 }
});
test('restart marks pending receipts interrupted, and failed persistence never dispatches',async()=>{
 const manager=createChatSupport({execute:()=>assert.fail('not admitted'),save:async()=>{throw Error('disk');}});assert.equal((await manager.start(scope)).error,'save-failed');
 const resumed=createChatSupport({execute:()=>assert.fail('must not resume')});resumed.restore({version:1,jobs:[{...scope,id:'saved',status:'running',startedAt:1}]});
 assert.equal((await resumed.start(scope)).status,'interrupted');
 const record={...scope,id:'saved',status:'completed',model:{provider:'p',model:'m',thinking:'high'},unexpected:'private',text:'参考',sources:[]};
 const clean=createChatSupport({execute:()=>assert.fail()});clean.restore({version:1,jobs:[record]});const view=clean.view(scope)[0];assert.equal(view.unexpected,undefined);assert.deepEqual(view.model,record.model);
});
test('research searches then reads finite provider source ids, with actual evidence and strict final citations',async()=>{
 const actions=[{action:'search',query:'official price'},{action:'read',sourceId:'w1'},{action:'finish',answer:'目前为这个价格；条件仍需核对。',sources:['w1']}];let calls=0,searches=0,reads=0;
 const manager=createChatSupport({execute:options=>runChatSupport({...options,call:async(_request,dispatch)=>{dispatch();calls++;return JSON.stringify(actions.shift());},
  search:async()=>{searches++;return{sources:[{url:'https://example.com/pricing',title:'官方定价'},{url:'http://localhost/private'}]};},
  readPage:async url=>{reads++;return{url,text:'真实页面正文'};}})});
 const result=await manager.start(scope);assert.equal(result.status,'completed');assert.deepEqual(result.counts,{calls:3,searches:1,reads:1});assert.equal(result.sources[0].excerpt,'真实页面正文');
 assert.deepEqual([calls,searches,reads],[3,1,1]);
});
test('unsupported actions and invented/unread citations cannot execute or masquerade as completed research',async()=>{
 for(const action of [{action:'execute',command:'shell'},{action:'read',sourceId:'https://example.com'},{action:'finish',answer:'查完了',sources:['w99']},'not json']){
  const manager=createChatSupport({execute:options=>runChatSupport({...options,call:async(_r,dispatch)=>{dispatch();return typeof action==='string'?action:JSON.stringify(action);},search:()=>assert.fail('no search'),readPage:()=>assert.fail('no arbitrary read')})});
  assert.equal((await manager.start(scope)).error,'format');
 }
});
test('reasoning has one call and no tool path; missing pages produce partial rather than verified results',async()=>{
 const manager=createChatSupport({execute:options=>runChatSupport({...options,call:async(request,dispatch)=>{dispatch();assert.equal(request.tools,undefined);return'按已有条件，A 更合适；仍取决于预算。';},search:()=>assert.fail(),readPage:()=>assert.fail()})});
 const result=await manager.start({...scope,template:'reason'});assert.equal(result.status,'completed');assert.equal(result.counts.calls,1);assert.deepEqual(result.sources,[]);
 assert.match(actorSupport(result,scope).notice,/未联网/);
});
test('only public HTTPS names are admitted, and reasoning omits whole oversized evidence instead of clipping conditions',()=>{
 for(const url of ['http://example.com','file:///D:/key','https://127.0.0.1','https://10.0.0.1','https://example.local','https://user:pass@example.com','https://example.com:444'])assert.equal(publicSupportUrl(url),null);
 const context=JSON.parse(supportReasonContext([{user:'原话',assistant:['完整回复']}],[{name:'大报告',report:'x'.repeat(7000)}]));
 assert.equal(context.references.length,0);assert.equal(context.omitted[0].name,'大报告');assert.equal(context.conversation[0].user,'原话');
});
