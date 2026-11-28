import test from 'node:test';
import assert from 'node:assert/strict';
import {createChatSupport} from '../lib/chat-support.js';
import {runChatSupport} from '../lib/chat-support-runner.js';
import {actorSupport,publicSupportUrl,supportReasonContext} from '../lib/chat-support-templates.js';
const scope={roomId:'room',generation:0,scopeKey:'source',referenceRevision:0,messageId:'message',actorId:'fish',actorName:'鲸鲸',template:'research',goal:'核对公开价格',question:'现在怎么收费？',context:''};
const tick=()=>new Promise(setImmediate);
test('peers receive attributed read pages or source passages only within the same round',()=>{
 const peer={...scope,actorId:'dragon'}, source={id:'p1',read:true,url:'https://example.com/a',title:'文档',excerpt:'公开引句'};
 const job={...scope,status:'completed',text:'private draft',sources:[source]};
 const result=actorSupport(job,peer); assert.equal(result.actorId,'fish');assert.equal(result.sources[0].excerpt,'公开引句');assert.equal(result.text,undefined);
 assert.equal(actorSupport({...job,template:'reason'},peer),undefined);
 assert.equal(actorSupport(job,{...peer,scopeKey:'new'}),undefined);assert.equal(actorSupport(job,{...peer,messageId:'next'}),undefined);
 const summary=actorSupport({...job,template:'summarize',text:JSON.stringify({notes:[{source:'工作',turn:1,quote:'选中的原话'}],questionsToVerify:'private question'})},peer);
 assert.equal(summary.notes[0].quote,'选中的原话');assert.doesNotMatch(JSON.stringify(summary),/private/);
});
test('research retains only canonical read links for the owner, peers and restored receipts', async () => {
 const source={id:'w1',read:true,url:'https://example.com/page#private-fragment',title:'公开资料',excerpt:'原话'};
 const sources=[null,{...source,read:false,id:'unread'},source];
 const result={status:'completed',text:'核对完成',sources};
 let saved;
 const manager=createChatSupport({execute:async()=>result,save:async value=>{saved=structuredClone(value);}});
 const job=await manager.start(scope);
 const restored=createChatSupport({execute:()=>assert.fail('completed receipt should not run again')});
 restored.restore({...saved,jobs:[{...saved.jobs[0],sources}]});
 const canonical='https://example.com/page';
 for(const record of [job,saved.jobs[0],await restored.start(scope)]) {
   assert.deepEqual(record.sources.map(s=>s.url),[canonical]);
 }
 for(const actorId of [scope.actorId,'peer']) {
   assert.deepEqual(actorSupport({...scope,...result},{...scope,actorId}).sources,
     [{id:'w1',url:canonical,title:'公开资料',excerpt:'原话'}]);
 }
});
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
test('logical step and individual tool limits cannot be replenished by retry or model output',async()=>{
 for(const [template,field,max]of [['reason','calls',1],['research','calls',4],['research','searches',3],['research','reads',4]]){
  const manager=createChatSupport({execute:async({admit})=>{for(let i=0;i<=max;i++)admit(field);return{};}});
  const result=await manager.start({...scope,template});assert.equal(result.counts[field],max);assert.equal(result.error,'budget');
 }
});
test('research can finish in three model calls and retains evidence if one parallel read fails',async()=>{
 const actions=[{action:'search',query:'来源'},{action:'read',sourceIds:['w1','w2']},{action:'finish',answer:'只有第一份有正文。',sources:['w1']}];
 const manager=createChatSupport({execute:options=>runChatSupport({...options,
  call:async(_request,dispatch)=>{dispatch();return JSON.stringify(actions.shift());},
  search:async()=>({sources:[{url:'https://example.com/one'},{url:'https://example.com/two'}]}),
  readPage:async url=>{if(url.endsWith('/two'))throw Error('offline');return{url,text:'原始资料。'};}})});
 const result=await manager.start({...scope,template:'research'});
 assert.equal(result.status,'completed');
 assert.deepEqual(result.counts,{calls:3,searches:1,reads:2});
 assert.deepEqual(result.sources.map(source=>source.id),['w1']);
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
test('reasoning uses transient inputs and output while each durable receipt keeps only task metadata',async()=>{
 const receipts=[];
 const manager=createChatSupport({save:async record=>receipts.push(structuredClone(record)),execute:async({job})=>{
   assert.equal(job.context,'PRIVATE_REPORT');
   return {status:'completed',text:'PRIVATE_CONCLUSION',sources:[]};
 }});
 const result=await manager.start({...scope,template:'reason',goal:'PRIVATE_GOAL',question:'PRIVATE_QUESTION',context:'PRIVATE_REPORT'});
 assert.equal(result.text,'PRIVATE_CONCLUSION');
 assert.deepEqual(receipts.map(r=>r.jobs[0].status),['running','completed']);
 for(const receipt of receipts) assert.doesNotMatch(JSON.stringify(receipt),/PRIVATE_/);
});

test('summary passages preserve English sentences, decimal numbers and the tail of a long unbroken source',async()=>{
  const long='条'.repeat(599)+'🙂'+'件'.repeat(200),text='Version 1.2 passed. Still pending.\n'+long;
  const result=await runChatSupport({job:{template:'summarize',context:JSON.stringify([{ref:'r1',name:'工作来源',text}])},
    signal:new AbortController().signal,admit(){},update(){},call:async(request,admit)=>{
      admit();const passages=JSON.parse(request.messages[0].content[0].text).references[0].passages;
      assert.deepEqual(passages.slice(0,2).map(p=>p.text),['Version 1.2 passed.','Still pending.']);
      assert.ok(passages.slice(2).every(p=>p.partial && p.text.length<=600 && p.text.isWellFormed()));
      assert.equal(passages.slice(2).map(p=>p.text).join(''),long);
      return JSON.stringify({points:[{ref:'r1',passage:passages.at(-1).id},{ref:'r1',passage:passages[0].id}],unknowns:''});
    }});
  const [note,complete]=JSON.parse(result.text).notes; assert.equal(note.partial,true); assert.ok(long.endsWith(note.quote));
  assert.equal(complete.partial,false);
});

test('only public HTTPS names are admitted, and reasoning omits whole oversized evidence instead of clipping conditions',()=>{
 for(const url of ['http://example.com','file:///D:/key','https://127.0.0.1','https://10.0.0.1','https://example.local','https://localhost./','https://service.local./','https://user:pass@example.com','https://example.com:444'])assert.equal(publicSupportUrl(url),null);
 const anchor=(id,parts)=>({id,messageId:id,attemptId:id,user:parts.map(p=>p.text).join('\n'),userParts:parts,
   phase:'anchor',scopeKey:'s',status:'ready',assistant:[],recipients:[]});
 const old=anchor('old',[{id:'old',text:'原话'},{id:'suffix',text:'PRIVATE_SUFFIX'}]), current=anchor('now',[{id:'now',text:'新问题'}]);
 const said={...old,id:'reply',attemptId:'a',phase:'reaction',recipientId:'p',speakerName:'甲',assistant:['PRIVATE_BUBBLE','完整回复']};
 const room={id:'r',generation:1,turns:[old,said,{...said,id:'failed',status:'failed',assistant:['PRIVATE_FAILED']},current],excludedReferences:[
   {roomId:'r',generation:1,kind:'user',messageId:'suffix'}, {roomId:'r',generation:1,kind:'assistant',turnId:'reply',attemptId:'a',index:0}]};
 const context=JSON.parse(supportReasonContext(room,current,[{name:'大报告',report:'x'.repeat(7000)}]));
 assert.equal(context.references.length,0);assert.equal(context.omitted[0].name,'大报告');
 assert.deepEqual(context.conversation,[{user:'原话'},{speaker:'甲',assistant:['完整回复']}]);
});
